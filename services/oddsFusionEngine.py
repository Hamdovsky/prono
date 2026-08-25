"""
OddsFusionEngine — couche de fusion multi-sources pour les cotes.

Architecture unifiée (toutes les sources travaillent en équipe):

  Tier 1: SofaScore Live (curl_cffi TLS spoofing) — cotes réelles 1X2 + OU/BTTS + xG
  Tier 1b: BetExplorer cache local — 1X2/OU/BTTS
  Tier 2: BetExplorer Bypass (curl_cffi TLS spoofing) — 1X2 via data-odd statique
  Tier 2b: BetExplorer HTTP direct — OU/BTTS sur les pages match (data-odd si dispo)
  Tier 3: soccerapi (888sport / Unibet) — scraping bookmakers (optionnel, geo-bloqué)
  Tier 4: ML Monte Carlo — estimation OU/BTTS depuis xG (Poisson)
  Tier 5: Historical averages (soccer_odds table) + Elo estimation
  Tier 6: Defaults 2.5/3.2/2.8

Usage:
    engine = OddsFusionEngine()
    odds = engine.get_odds(home_team, away_team, league)
"""

import requests, sqlite3, os, math, json, logging, re, datetime, sys, time

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, 'data')

logging.basicConfig(level=logging.INFO, format='[ODDS] %(message)s')
log = logging.getLogger('OddsFusion')


class OddsFusionEngine:
    def __init__(self):
        self._league_odds_cache = {}
        self._history_db = os.path.join(DATA_DIR, 'historical_archive.sqlite')

    # ── Helpers ──────────────────────────────────────────────

    def _get_key(self, name):
        path = os.path.join(BASE_DIR, '.env')
        try:
            with open(path, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if line.startswith(f'{name}='):
                        return line.split('=', 1)[1].strip().strip('"').strip("'")
        except: pass
        return None

    def _log(self, tier, msg):
        log.info(f'[Tier {tier}] {msg}')

    # ── Tier 0: Football-Data fixtures ───────────────────────

    def _tier0_football_data(self, home, away, league):
        """Cotes réelles 1X2 + >2.5 + AH des matchs à venir (Football-Data).

        Source fiable : CSV officiel football-data.co.uk, généré par
        data_pipeline (sources/football_data.py -> football_data_fixtures.csv).
        Retourne dict compatible avec get_odds() ou None.
        """
        try:
            fixtures_path = os.path.join(BASE_DIR, 'data_pipeline', 'data', 'raw',
                                         'football_data_fixtures.csv')
            if not os.path.exists(fixtures_path):
                return None
            if getattr(self, '_fd_fixtures_cache', None) is None:
                import pandas as pd
                raw = pd.read_csv(fixtures_path)
                if raw.empty:
                    return None
                norm = raw.copy()
                for col in ['home_team', 'away_team']:
                    norm[col] = norm[col].fillna('').astype(str).str.lower().str.strip()
                self._fd_fixtures_cache = norm
            for _, row in self._fd_fixtures_cache.iterrows():
                if self._teams_match(row['home_team'], home) and self._teams_match(row['away_team'], away):
                    h = self._safe_odds(row.get('odds_h_avg') or row.get('odds_h_b365'))
                    d = self._safe_odds(row.get('odds_d_avg') or row.get('odds_d_b365'))
                    a = self._safe_odds(row.get('odds_a_avg') or row.get('odds_a_b365'))
                    if not (h and d and a):
                        return None
                    odds = {
                        'home_win': h, 'draw': d, 'away_win': a,
                        'over_25': self._safe_odds(row.get('odds_o25_avg') or row.get('odds_o25_b365')),
                        'under_25': None,
                        'btts_yes': None, 'btts_no': None,
                        'source': 'football_data',
                        '_tiers': ['tier0_football_data'],
                    }
                    if odds['over_25']:
                        odds['under_25'] = self._implied_under25(odds['over_25'])
                    return odds
        except Exception as ex:
            self._log(0, f'football_data fixtures error: {ex}')
        return None

    def _safe_odds(self, v):
        try:
            fv = float(v)
            return fv if fv > 1.0 else None
        except (TypeError, ValueError):
            return None

    def _implied_under25(self, over25):
        """Under 2.5 dérivé de la cote Over 2.5 (probas complémentaires, marge retirée)."""
        try:
            po = 1.0 / float(over25)
            pu = 1.0 - po
            return round(1.0 / pu, 2) if pu > 0 else None
        except (TypeError, ZeroDivisionError, ValueError):
            return None

    # ── Fusion consensus multi-sources ────────────────────────

    # Priorité : plus bas = source la plus fiable. Les sources "réelles"
    # (cotes de bookmakers/scraping) priment sur les estimations (ML/historique).
    SOURCE_PRIORITY = {
        'football_data': 1,
        'sofascore': 2,
        'betexplorer-live': 3,
        'betexplorer': 3,
        'betexplorer+firecrawl': 3,
        'jina': 5,
        'ml_monte_carlo': 6,
        'historical+elo': 7,
        'historical': 7,
        'default': 9,
    }

    REAL_SOURCES = ('football_data', 'sofascore', 'betexplorer-live',
                    'betexplorer', 'betexplorer+firecrawl', 'jina')

    # Bornes de validité d'une cote (élimine les valeurs aberrantes Sofascore).
    FIELD_BOUNDS = {
        'home_win': (1.01, 30.0), 'draw': (1.01, 30.0), 'away_win': (1.01, 30.0),
        'over_25': (1.01, 12.0), 'under_25': (1.01, 12.0),
        'btts_yes': (1.01, 6.0), 'btts_no': (1.01, 6.0),
        'corners_over': (1.01, 12.0), 'corners_under': (1.01, 12.0),
    }

    @staticmethod
    def _fuse_field(values_with_source, field=None, consensus_spread=0.25):
        """Choisit la meilleure cote d'un marché parmi plusieurs sources.

        - Filtre les valeurs hors bornes (cotes aberrantes).
        - Privilégie les sources 'réelles' (REAL_SOURCES).
        - Consensus : si >=2 sources réelles proches (écart <= spread), moyenne.
        - En cas de désaccord, retire les outliers (>2x le min) puis moyenne
          les valeurs saines (robuste aux lignes pourries d'une source).
        """
        if not values_with_source:
            return None
        lo, hi = OddsFusionEngine.FIELD_BOUNDS.get(field, (1.01, 1000.0))
        valid = [(v, s) for v, s in values_with_source
                 if v is not None and lo <= float(v) <= hi]
        if not valid:
            return None
        reals = [x for x in valid if x[1] in OddsFusionEngine.REAL_SOURCES]
        pool = reals if reals else valid
        pool = sorted(pool, key=lambda x: OddsFusionEngine.SOURCE_PRIORITY.get(x[1], 9))
        if len(reals) >= 2:
            vals = sorted(v for v, s in reals)
            kept = [v for v in vals if v <= 2.0 * vals[0]]
            if len(kept) >= 2:
                return round(sum(kept) / len(kept), 3)
            return round(kept[0], 3)
        return pool[0][0]

    # ── Tier 1a: SofaScore Live cache (curl_cffi TLS-spoofing, source primaire) ──

    def _tier1a_sofascore(self, home, away, league):
        """Cotes 1X2 + OU/BTTS + Corners + xG depuis le cache SofaScore
        (scripts/cacheSofascoreOdds.py -> data/odds_cache.json).

        Source gratuite, sans clé API, prioritaire (considérée 'real').
        Corners/xG best-effort : non settés si absents (fallback ML/tier4).
        """
        try:
            cache_path = os.path.join(BASE_DIR, 'data', 'odds_cache.json')
            if not os.path.exists(cache_path):
                return None
            if getattr(self, '_sofa_cache', None) is None:
                with open(cache_path, 'r', encoding='utf-8') as f:
                    self._sofa_cache = json.load(f)
            for key, odds in self._sofa_cache.items():
                if odds.get('source') != 'sofascore':
                    continue
                cached_home = (odds.get('homeTeam') or '').lower().strip()
                cached_away = (odds.get('awayTeam') or '').lower().strip()
                if not cached_home or not cached_away:
                    continue
                if (self._teams_match(cached_home, home) and self._teams_match(cached_away, away)) or \
                   (self._teams_match(cached_home, away) and self._teams_match(cached_away, home)):
                    result = {
                        'home_win': self._safe_odds(odds.get('home')),
                        'draw': self._safe_odds(odds.get('draw')),
                        'away_win': self._safe_odds(odds.get('away')),
                        'over_25': self._safe_odds(odds.get('over25')),
                        'under_25': self._safe_odds(odds.get('under25')),
                        'btts_yes': self._safe_odds(odds.get('btts_yes')),
                        'btts_no': self._safe_odds(odds.get('btts_no')),
                        'corners_over': self._safe_odds(odds.get('corners_over')),
                        'corners_under': self._safe_odds(odds.get('corners_under')),
                        'home_xg': odds.get('home_xg'),
                        'away_xg': odds.get('away_xg'),
                        'shots_h': odds.get('shots_h'),
                        'shots_a': odds.get('shots_a'),
                        'source': 'sofascore',
                        '_tiers': ['tier1a_sofascore'],
                    }
                    return result
        except Exception as ex:
            self._log(1, f'[sofascore-cache] Error: {ex}')
        return None

    # ── Tier 1b: BetExplorer Live cache (scraping local, anti-détection) ──

    def _tier1b_betexplorer_cache(self, home, away, league):
        """Cotes 1X2 live réelles issues du scraping BetExplorer (scripts/betexplorerLive.js).

        Source locale, sans clé API, prioritaire (considérée 'real'). Le cache
        data/odds_cache.json est produit par le scraper et contient home/draw/away.
        """
        try:
            cache_path = os.path.join(BASE_DIR, 'data', 'odds_cache.json')
            if not os.path.exists(cache_path):
                return None
            if getattr(self, '_be_cache', None) is None:
                with open(cache_path, 'r', encoding='utf-8') as f:
                    self._be_cache = json.load(f)
            for key, odds in self._be_cache.items():
                cached_home = (odds.get('homeTeam') or '').lower().strip()
                cached_away = (odds.get('awayTeam') or '').lower().strip()
                if not cached_home or not cached_away:
                    continue
                if (self._teams_match(cached_home, home) and self._teams_match(cached_away, away)) or \
                   (self._teams_match(cached_home, away) and self._teams_match(cached_away, home)):
                    if odds.get('home') and odds.get('draw') and odds.get('away'):
                        return {
                            'home_win': float(odds['home']),
                            'draw': float(odds['draw']),
                            'away_win': float(odds['away']),
                            'source': 'betexplorer-live',
                            '_tiers': ['tier1b_betexplorer_cache'],
                        }
        except Exception as ex:
            self._log(1, f'[betexplorer-cache] Error: {ex}')
        return None

    # ── Tier 2: BetExplorer Bypass Scraper (curl_cffi TLS fingerprint) ──

    def _tier2_betexplorer_bypass(self, home, away, league, country=None):
        """BetExplorer via bypass scraper (curl_cffi, recherche directe).
        Retourne 1X2 + match_url si trouvé."""
        try:
            sys.path.insert(0, os.path.join(BASE_DIR, 'scripts'))
            from bypass_scraper import betexplorer_search
            result = betexplorer_search(home, away, league, country=country)
            if result and result.get('odds') and result['odds'].get('home_win'):
                odds = result['odds']
                odds['source'] = 'betexplorer'
                odds['match_url'] = result.get('match_url')
                odds['match_hash'] = result.get('match_hash')
                self._log(2, f'[bypass] {home} vs {away}: {odds["home_win"]}/{odds["draw"]}/{odds["away_win"]}')
                return odds
        except Exception as ex:
            self._log(2, f'[bypass] Error: {ex}')

        # Fallback: try the legacy cloudscraper method (league pages)
        return self._tier2_betexplorer_legacy(home, away, league, country)

    def _tier2_betexplorer_legacy(self, home, away, league, country=None):
        """Legacy BetExplorer scraper via cloudscraper + BS4 (league pages)."""
        try:
            import cloudscraper
            from bs4 import BeautifulSoup
        except ImportError:
            return None

        league_slug = self._league_to_betexplorer_slug(league, country)
        if not league_slug:
            return None

        base = 'https://www.betexplorer.com'
        fixture_urls = [
            f'{base}{league_slug}fixtures/',
            f'{base}{league_slug}',
        ]

        scraper = cloudscraper.create_scraper(browser={
            'browser': 'chrome', 'platform': 'windows', 'mobile': False
        })
        scraper.headers.update({
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.9',
        })

        for url in fixture_urls:
            try:
                r = scraper.get(url, timeout=15)
                if r.status_code != 200:
                    continue
                soup = BeautifulSoup(r.text, 'html.parser')
                table = soup.select_one('table.table-main')
                match_uls = soup.select('ul.table-main__matchInfo')

                if table and len(table.find_all('tr')) > 3:
                    odds = self._parse_table_format(table, home, away)
                    if odds:
                        return odds
                if match_uls and len(match_uls) > 1:
                    odds = self._parse_div_format(match_uls, home, away)
                    if odds:
                        return odds
            except Exception as ex:
                self._log(2, f'[legacy] Error on {url}: {ex}')
        return None

    # ── Tier 2b: Firecrawl OU/BTTS ──────────────────────────

    def _tier2b_firecrawl_ou_btts(self, home, away, league, match_url=None):
        """OU/BTTS depuis BetExplorer via HTTP direct (data-odd statique).
        Nécessite match_url (récupéré par Tier 2). data-odd absent -> None (tier4 prend le relais)."""
        if not match_url:
            return None

        self._log(2, '[bypass] Fetching OU/BTTS...')
        try:
            sys.path.insert(0, os.path.join(BASE_DIR, 'scripts'))
            from bypass_scraper import betexplorer_match_ou, betexplorer_match_btts

            ou = betexplorer_match_ou(match_url, use_firecrawl=True)
            btts = betexplorer_match_btts(match_url, use_firecrawl=True)

            result = {}
            if ou.get('ou25'):
                result['over_25'] = ou['ou25'].get('over_25')
                result['under_25'] = ou['ou25'].get('under_25')
            if btts.get('btts'):
                result['btts_yes'] = btts['btts'].get('yes')
                result['btts_no'] = btts['btts'].get('no')

            if result:
                result['source'] = 'betexplorer'
                self._log(2, f'[bypass] OU={result.get("over_25")}/{result.get("under_25")} BTTS={result.get("btts_yes")}/{result.get("btts_no")}')
                return result
        except Exception as ex:
            self._log(2, f'[bypass] Error: {ex}')
        return None

    # ── Tier 4: ML Monte Carlo OU/BTTS ──────────────────────

    def _tier4_ml_ou_btts(self, home, away, league):
        """Estimation OU/BTTS via Monte Carlo Poisson depuis xG historiques."""
        try:
            sys.path.insert(0, os.path.join(BASE_DIR, 'scripts'))
            from bypass_scraper import estimate_ou_btts_ml
            result = estimate_ou_btts_ml(home, away, league)
            if result and result.get('over_25_prob') is not None:
                # Convertir probabilités en cotes décimales
                over_25_odds = round(100.0 / max(result['over_25_prob'], 1), 2) if result['over_25_prob'] > 0 else None
                under_25_odds = round(100.0 / max(result['under_25_prob'], 1), 2) if result['under_25_prob'] > 0 else None
                btts_yes_odds = round(100.0 / max(result['btts_yes_prob'], 1), 2) if result['btts_yes_prob'] > 0 else None
                btts_no_odds = round(100.0 / max(result['btts_no_prob'], 1), 2) if result['btts_no_prob'] > 0 else None

                return {
                    'over_25': over_25_odds,
                    'under_25': under_25_odds,
                    'btts_yes': btts_yes_odds,
                    'btts_no': btts_no_odds,
                    'source': 'ml_monte_carlo',
                    '_probabilities': {
                        'over_25': round(result['over_25_prob'], 1),
                        'under_25': round(result['under_25_prob'], 1),
                        'btts_yes': round(result['btts_yes_prob'], 1),
                        'btts_no': round(result['btts_no_prob'], 1),
                    }
                }
        except Exception as ex:
            self._log(4, f'[ml_ou_btts] Error: {ex}')
        return None

    # ── Team name utilities (shared by legacy + bypass) ──────

    @staticmethod
    def _normalize_team(name):
        import unicodedata
        n = name.lower().strip()
        n = ''.join(c for c in unicodedata.normalize('NFD', n) if unicodedata.category(c) != 'Mn')
        n = re.sub(r'^(fc|sc|ac|as|us|ec|cd|ca|cr|gr|aek|paok|osa|ifk|bk|ff|ss|nk|fk|sk|rc|ra|ud|ad|cdt)\.?\s+', '', n)
        n = re.sub(r'\s+(fc|sc|ac|as|us|cf|cd|ca|ec)\.?\s*$', '', n)
        n = re.sub(r'\s+(united|city|utd)$', '', n)
        return n.strip()

    TEAM_ALIASES = {
        'sc jacksonville': 'sporting jax',
        'jacksonville': 'sporting jax',
        'sacramento republic': 'sacramento republic',
        'sacramento republic fc': 'sacramento republic',
        'oakland roots': 'oakland roots',
        'oakland roots sc': 'oakland roots',
        'phoenix rising': 'phoenix rising',
        'phoenix rising fc': 'phoenix rising',
        'el paso': 'el paso',
        'el paso locomotive': 'el paso',
        'fc inter': 'inter turku',
        'inter turku': 'inter turku',
        'hjk helsinki': 'hjk',
        'wydad casablanca': 'wydad',
        'wac': 'wydad',
        'raja casablanca': 'raja',
        'far rabat': 'fath union',
        'athletic club': 'athletic club',
    }

    @staticmethod
    def _resolve_alias(name):
        n = OddsFusionEngine._normalize_team(name)
        aliases = OddsFusionEngine.TEAM_ALIASES
        if n in aliases:
            return aliases[n]
        for key, val in aliases.items():
            if key in n or n in key:
                return val
        return name

    @staticmethod
    def _teams_match(be_name, bsd_name):
        be_resolved = OddsFusionEngine._resolve_alias(be_name)
        bsd_resolved = OddsFusionEngine._resolve_alias(bsd_name)
        b1 = OddsFusionEngine._normalize_team(be_resolved)
        b2 = OddsFusionEngine._normalize_team(bsd_resolved)
        if b1 == b2: return True
        if b1 in b2 or b2 in b1: return True
        def significant_words(s):
            return set(w for w in re.split(r'[\s\-\.]+', s) if len(w) >= 3)
        w1 = significant_words(b1)
        w2 = significant_words(b2)
        if w1 & w2:
            common = w1 & w2
            min_words = min(len(w1), len(w2))
            if min_words <= 1: return len(common) >= 1
            return len(common) / min_words >= 0.5
        for w in w1:
            for v in w2:
                if len(w) >= 4 and len(v) >= 4:
                    if w.startswith(v) or v.startswith(w):
                        return True
        return False

    def _parse_table_format(self, table, home, away):
        """Parser le format table (legacy, pour cloudscraper)."""
        from bs4 import BeautifulSoup
        for row in table.find_all('tr'):
            cells = row.find_all(['td', 'th'])
            if len(cells) < 4: continue
            if row.find('th'): continue
            team_cell = cells[1] if len(cells) > 1 else None
            if not team_cell: continue
            link = team_cell.find('a', class_='in-match') or team_cell.find('a')
            if not link: continue
            spans = link.find_all('span')
            if len(spans) < 2: continue
            row_ht = spans[0].get_text(strip=True)
            row_at = spans[1].get_text(strip=True)
            if self._teams_match(row_ht, home) and self._teams_match(row_at, away):
                odd_cells = [c for c in cells if c.find(attrs={'data-odd': True})]
                if len(odd_cells) >= 3:
                    try:
                        hw = float(odd_cells[0].find(attrs={'data-odd': True})['data-odd'])
                        dr = float(odd_cells[1].find(attrs={'data-odd': True})['data-odd'])
                        aw = float(odd_cells[2].find(attrs={'data-odd': True})['data-odd'])
                        return {'home_win': hw, 'draw': dr, 'away_win': aw, 'source': 'betexplorer'}
                    except: pass
        return None

    def _parse_div_format(self, match_uls, home, away):
        """Parser le format div/list (legacy)."""
        from bs4 import BeautifulSoup
        for ul in match_uls:
            lis = ul.find_all('li', recursive=False)
            if len(lis) < 3: continue
            participants_li = odds_li = None
            for li in lis:
                if li.find('a', href=True) and li.find('div', class_=lambda x: x and 'participant' in x.lower() if x else False):
                    participants_li = li
                if li.find('div', class_=lambda x: x and 'odds' in x.lower() if x else False):
                    odds_li = li
            if not participants_li or not odds_li:
                if len(lis) >= 2:
                    participants_li = lis[0] if lis[0].find('a') else lis[1] if lis[1].find('a') else None
                    odds_li = lis[1] if lis[1].find(attrs={'data-odd': True}) else None
            if not participants_li or not odds_li: continue
            link = participants_li.find('a', href=True)
            if not link: continue
            full_text = link.get_text(strip=True)
            parts = [p.strip() for p in full_text.replace(' - ', '-').split('-')]
            if len(parts) < 2: continue
            row_ht = parts[0].strip()
            row_at = parts[-1].strip()
            if self._teams_match(row_ht, home) and self._teams_match(row_at, away):
                odds_divs = odds_li.find_all(attrs={'data-odd': True})
                if len(odds_divs) >= 3:
                    try:
                        return {'home_win': float(odds_divs[0]['data-odd']), 'draw': float(odds_divs[1]['data-odd']), 'away_win': float(odds_divs[2]['data-odd']), 'source': 'betexplorer'}
                    except: pass
                elif len(odds_divs) == 1:
                    container = odds_divs[0].find_parent('div', class_=lambda x: x and 'oddsColumn' in x.lower() if x else False)
                    if container:
                        sub_divs = container.find_all(attrs={'data-odd': True})
                        if len(sub_divs) >= 3:
                            try:
                                return {'home_win': float(sub_divs[0]['data-odd']), 'draw': float(sub_divs[1]['data-odd']), 'away_win': float(sub_divs[2]['data-odd']), 'source': 'betexplorer'}
                            except: pass
        return None

    def _league_to_betexplorer_slug(self, league, country=None):
        mapping = {
            'Northern Premier League': '/football/england/northern-premier-league/',
            'Southern League Premier: South': '/football/england/southern-league-premier-south/',
            'Southern League Premier: Central': '/football/england/southern-league-premier-central/',
            'Isthmian League Premier': '/football/england/isthmian-league-premier/',
            'Southern League: Central': '/football/england/southern-league-central/',
            'National League Cup': '/football/england/national-league-cup/',
            'Regionalliga Nordost': '/football/germany/regionalliga-nordost/',
            'Regionalliga Nord': '/football/germany/regionalliga-nord/',
            'Oberliga: Rheinland': '/football/germany/oberliga-rheinland-pfalz-saar/',
            'Oberliga: Baden': '/football/germany/oberliga-baden-wuerttemberg/',
            'Oberliga: Hessen': '/football/germany/oberliga-hessen/',
            'Oberliga: Bremen': '/football/germany/oberliga-bremen/',
            'Champions League: Qualification': '/football/europe/champions-league-qualification/',
            'UEFA Super Cup': '/football/europe/uefa-super-cup/',
            'Challenge Cup': '/football/scotland/challenge-cup/',
            'Premiership': '/football/south-africa/premiership/',
            'Ykkonen': '/football/finland/ykkonen/',
            'Australia Cup': '/football/australia/australia-cup/',
            'DBU Pokalen': '/football/denmark/dbu-pokalen/',
            'Vtora Liga': '/football/bulgaria/second-league/',
            'MLS Next Pro': '/football/usa/mls-next-pro/',
            'Superettan': '/football/sweden/superettan/',
            'Primera B': '/football/chile/primera-b/',
            'USL Cup': '/football/usa/usl-cup/',
            'Leagues Cup': '/football/usa/leagues-cup/',
            'Copa Argentina': '/football/argentina/copa-argentina/',
            'Canadian Championship': '/football/canada/canadian-championship/',
            'Copa Ecuador': '/football/ecuador/copa-ecuador/',
            'Club Friendlies': '/football/international/friendly/',
            'Featured Club Friendlies': '/football/international/friendly/',
            'Brasileirão Serie B': '/football/brazil/serie-b/',
            'Brasileirão Serie A': '/football/brazil/serie-a/',
            'Segunda División': '/football/spain/segunda-division/',
            'Segunda Division': '/football/spain/segunda-division/',
            'USL Championship': '/football/usa/usl-championship/',
            'Veikkausliiga': '/football/finland/veikkausliiga/',
            'Botola Pro': '/football/morocco/botola/',
            'Botola': '/football/morocco/botola/',
            'Serie A': '/football/italy/serie-a/',
            'Serie B': '/football/italy/serie-b/',
            'Premier League': '/football/england/premier-league/',
            'La Liga': '/football/spain/laliga/',
            'Ligue 1': '/football/france/ligue-1/',
            'Ligue 2': '/football/france/ligue-2/',
            'Bundesliga': '/football/germany/bundesliga/',
            '2. Bundesliga': '/football/germany/2-bundesliga/',
            'Championship': '/football/england/championship/',
            'League One': '/football/england/league-one/',
            'League Two': '/football/england/league-two/',
            'MLS': '/football/usa/mls/',
            'Eredivisie': '/football/netherlands/eredivisie/',
            'Primeira Liga': '/football/portugal/primeira-liga/',
            'Liga Portugal': '/football/portugal/primeira-liga/',
            'Scottish Premiership': '/football/scotland/premier-league/',
            'Süper Lig': '/football/turkey/super-lig/',
            'Super Lig': '/football/turkey/super-lig/',
            'J1 League': '/football/japan/j1-league/',
            'K League 1': '/football/south-korea/k-league-1/',
            'Eliteserien': '/football/norway/eliteserien/',
            'Allsvenskan': '/football/sweden/allsvenskan/',
            'Ekstraklasa': '/football/poland/ekstraklasa/',
            'Liga MX': '/football/mexico/liga-mx/',
            'Primera División': '/football/argentina/primera-division/',
            'World Cup 2026': '/football/international/world-cup/',
            'International Friendly': '/football/international/friendly/',
        }
        if country:
            try:
                if 'bypass_scraper' not in sys.modules:
                    sys.path.insert(0, os.path.join(BASE_DIR, 'scripts'))
                import bypass_scraper
                for (lk, ck), slug in bypass_scraper.LEAGUE_SLUG_COUNTRY_MAPPING.items():
                    if lk in league.lower() and ck in country.lower():
                        return slug
            except Exception:
                pass
        for key, slug in mapping.items():
            if key.lower() in league.lower():
                return slug
        return None

    # ── Tier 3: soccerapi (888sport) ─────────────────────────

    def _tier3_soccerapi(self, home, away, league):
        """Scrape 888sport via soccerapi. Skip si geo-bloqué (France) ou si timeout."""
        try:
            from soccerapi.api import Api888Sport
            import requests
            from requests.adapters import HTTPAdapter
            api = Api888Sport()
            api.session = requests.Session()
            adapter = HTTPAdapter(max_retries=0)
            api.session.mount('https://', adapter)
            api.session.mount('http://', adapter)
            orig_req = api.session.request
            api.session.request = lambda method, url, **kw: orig_req(method, url, timeout=5, **kw)
            comps = api.competitions()
            # Chercher la ligue dans les competitions
            target = None
            for country, leagues in comps.items():
                for lname, curl in leagues.items():
                    if any(kw.lower() in lname.lower() for kw in league.lower().split()):
                        target = curl
                        break
            if not target:
                return None
            odds = api.odds(target)
            for o in odds:
                if home.lower() in o['home_team'].lower() and away.lower() in o['away_team'].lower():
                    fr = o.get('full_time_resut', {})
                    return {
                        'home_win': fr.get('1') / 1000 if fr.get('1') else None,
                        'draw': fr.get('X') / 1000 if fr.get('X') else None,
                        'away_win': fr.get('2') / 1000 if fr.get('2') else None,
                        'source': '888sport'
                    }
        except Exception as ex:
            self._log(3, f'soccerapi error: {ex}')
        return None

    # ── Tier 5: Historical + Elo Estimation ──────────────────

    def _tier5_historical_elo(self, home, away, league):
        """Estimer les cotes depuis les moyennes historiques (soccer_odds) + Elo."""
        # 1. Charger les moyennes historiques par ligue
        avg = self._get_league_odds_averages(league)
        if avg:
            self._log(4, f'Using historical avg for {league}: {avg["home_win"]:.2f}/{avg["draw"]:.2f}/{avg["away_win"]:.2f}')
            # 2. Ajuster selon l'Elo relatif (optionnel, ne pas bloquer)
            try:
                elo_adj = self._get_elo_adjustment(home, away)
                if elo_adj:
                    hw = max(1.01, avg['home_win'] - elo_adj['home_bias'])
                    aw = max(1.01, avg['away_win'] + elo_adj['away_bias'])
                    dr = max(1.01, avg['draw'])
                    return {
                        'home_win': round(hw, 2),
                        'draw': round(dr, 2),
                        'away_win': round(aw, 2),
                        'source': 'historical+elo',
                        'elo_home_prob': elo_adj.get('home_prob'),
                        'elo_away_prob': elo_adj.get('away_prob')
                    }
            except Exception:
                pass
            return avg | {'source': 'historical'}
        return None

    def _get_league_odds_averages(self, league):
        """Moyenne des cotes historiques pour une ligue depuis soccer_odds."""
        if league in self._league_odds_cache:
            return self._league_odds_cache[league]

        if not os.path.exists(self._history_db):
            return None

        # Normaliser le nom de la ligue (enlever accents, casse)
        import unicodedata
        def strip_accents(s):
            return ''.join(c for c in unicodedata.normalize('NFD', s) if unicodedata.category(c) != 'Mn')

        normalized_league = strip_accents(league)
        cache_key = normalized_league

        if cache_key in self._league_odds_cache:
            return self._league_odds_cache[cache_key]

        try:
            db = sqlite3.connect(self._history_db)
            # Chercher la ligue dans soccer_leagues (sans accents, insensible à la casse)
            like = f'%{normalized_league}%'
            cur = db.execute('''
                SELECT AVG(o.home_win), AVG(o.draw), AVG(o.away_win), COUNT(*)
                FROM soccer_odds o
                JOIN soccer_fixtures f ON o.fixture_id = f.id
                JOIN soccer_leagues l ON f.league_id = l.id
                WHERE l.name LIKE ? COLLATE NOCASE
            ''', (like,))
            row = cur.fetchone()
            db.close()

            if row and row[3] >= 10:
                avg = {
                    'home_win': round(row[0], 2),
                    'draw': round(row[1], 2),
                    'away_win': round(row[2], 2)
                }
                self._league_odds_cache[cache_key] = avg
                return avg
            elif row and row[3] < 10:
                self._log(4, f'Only {row[3]} odds rows for {league}, need >= 10')
        except Exception as ex:
            self._log(4, f'DB error: {ex}')
        return None

    def _get_elo_adjustment(self, home, away):
        """Calculer un ajustement Elo pour affiner les cotes."""
        db_path = os.path.join(DATA_DIR, 'tactical.db')
        if not os.path.exists(db_path):
            return None
        try:
            db = sqlite3.connect(db_path)
            # Vérifier que la table existe
            tbl = db.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='config_engine'"
            ).fetchone()
            if not tbl:
                db.close()
                return None
            cur = db.execute(
                "SELECT key FROM config_engine WHERE key LIKE ? LIMIT 1",
                ('elo_%',)
            )
            if not cur.fetchone():
                db.close()
                return None
            cur = db.execute(
                "SELECT rating FROM config_engine WHERE key = ?",
                (f'elo_{home}',)
            )
            home_elo = cur.fetchone()
            cur = db.execute(
                "SELECT rating FROM config_engine WHERE key = ?",
                (f'elo_{away}',)
            )
            away_elo = cur.fetchone()
            db.close()

            if home_elo and away_elo:
                h_elo = float(home_elo[0])
                a_elo = float(away_elo[0])
                diff = h_elo - a_elo
                # Elo -> probabilité
                expected = 1.0 / (1 + 10 ** (-diff / 400.0))
                # Convertir en biais de cotes (plus l'équipe est forte, plus la cote baisse)
                home_bias = (expected - 0.5) * 0.5  # max ±0.25
                away_bias = -home_bias
                return {
                    'home_bias': home_bias,
                    'away_bias': away_bias,
                    'home_prob': expected,
                    'away_prob': 1 - expected
                }
        except Exception as ex:
            self._log(4, f'Elo error: {ex}')
        return None

    # ── Tier 6: Defaults ─────────────────────────────────────
    
    def _tier6_defaults(self, home, away, league):
        """Cotes par défaut en dernier recours."""
        return {
            'home_win': 2.5,
            'draw': 3.2,
            'away_win': 2.8,
            'source': 'default'
        }

    # ── Public API ───────────────────────────────────────────

    def _tier_jina(self, home, away, league):
        """Cotes depuis le cache Jina (data/jina_odds.json) si présent.
        Produit par services/scrapers/JinaScraper.js. Source 'real' basse
        priorité (parsing markdown fragile)."""
        try:
            path = os.path.join(BASE_DIR, 'data', 'jina_odds.json')
            if not os.path.exists(path):
                return None
            if getattr(self, '_jina_cache', None) is None:
                with open(path, 'r', encoding='utf-8') as f:
                    self._jina_cache = json.load(f)
            for key, o in self._jina_cache.items():
                ch = (o.get('homeTeam') or o.get('home') or '').lower().strip()
                ca = (o.get('awayTeam') or o.get('away') or '').lower().strip()
                if not ch or not ca:
                    continue
                if (self._teams_match(ch, home) and self._teams_match(ca, away)) or \
                   (self._teams_match(ch, away) and self._teams_match(ca, home)):
                    return {
                        'home_win': self._safe_odds(o.get('home') or o.get('home_win')),
                        'draw': self._safe_odds(o.get('draw')),
                        'away_win': self._safe_odds(o.get('away') or o.get('away_win')),
                        'over_25': self._safe_odds(o.get('over25') or o.get('over_25')),
                        'under_25': self._safe_odds(o.get('under25') or o.get('under_25')),
                        'btts_yes': self._safe_odds(o.get('btts_yes')),
                        'btts_no': self._safe_odds(o.get('btts_no')),
                        'source': 'jina',
                    }
        except Exception:
            pass
        return None

    def get_odds(self, home, away, league, prefer_real=True, use_soccerapi=False, country=None):
        """Obtenir les cotes fusionnées (consensus multi-sources) pour un match.

        Toutes les sources gratuites travaillent en équipe : football-data,
        Sofascore (cache live), BetExplorer (live + bypass), Jina, puis les
        estimations ML Monte Carlo / historique+Elo, enfin les défauts.
        La fusion privilégie la source la plus fiable et moyenne les cotes
        réelles concordantes (consensus) pour réduire le bruit.
        """
        candidates = []
        match_url = None

        o = self._tier0_football_data(home, away, league)
        if o: candidates.append(o)
        o = self._tier1a_sofascore(home, away, league)
        if o: candidates.append(o)
        o = self._tier1b_betexplorer_cache(home, away, league)
        if o: candidates.append(o)
        o = self._tier2_betexplorer_bypass(home, away, league, country)
        if o:
            candidates.append(o)
            match_url = match_url or o.get('match_url')
        if match_url:
            o = self._tier2b_firecrawl_ou_btts(home, away, league, match_url)
            if o:
                o = dict(o)
                o['source'] = 'betexplorer+firecrawl'
                candidates.append(o)
        o = self._tier4_ml_ou_btts(home, away, league)
        if o: candidates.append(o)
        if use_soccerapi:
            o = self._tier3_soccerapi(home, away, league)
            if o: candidates.append(o)
        o = self._tier_jina(home, away, league)
        if o: candidates.append(o)

        has_real = any(c.get('source') in self.REAL_SOURCES for c in candidates)
        if not prefer_real or not has_real:
            o = self._tier5_historical_elo(home, away, league)
            if o: candidates.append(o)

        # Defaults toujours présents (dernier recours)
        candidates.append(self._tier6_defaults(home, away, league))

        # ── Fusion par marché (priorité + consensus) ──
        fields = ['home_win', 'draw', 'away_win', 'over_25', 'under_25',
                  'btts_yes', 'btts_no']
        result = {f: None for f in fields}
        for f in fields:
            vals = [(c.get(f), c.get('source')) for c in candidates if c.get(f) is not None]
            result[f] = self._fuse_field(vals, field=f)

        # Dériver under_25 / btts_no manquants
        if result['over_25'] and not result['under_25']:
            result['under_25'] = self._implied_under25(result['over_25'])
        if result['btts_yes'] and not result['btts_no']:
            try:
                py = 1.0 / result['btts_yes']
                pu = 1 - py
                result['btts_no'] = round(1.0 / pu, 3) if pu > 0 else None
            except Exception:
                pass

        # Champs uniques (xG / tirs / corners / probas) : meilleure source
        for f in ('corners_over', 'corners_under', 'home_xg', 'away_xg',
                  'shots_h', 'shots_a'):
            vals = [(c.get(f), c.get('source')) for c in candidates if c.get(f) is not None]
            result[f] = self._fuse_field(vals, field=f) if vals else None

        for c in candidates:
            if c.get('_probabilities'):
                result['_probabilities'] = c['_probabilities']
                break

        real_used = [c['source'] for c in candidates
                     if c.get('source') in self.REAL_SOURCES
                     and any(c.get(f) is not None for f in fields)]
        result['source'] = real_used[0] if real_used else 'default'
        result['_tiers'] = [c.get('source') for c in candidates if c.get('source') != 'default']
        result['match_url'] = match_url
        result['_consensus'] = len([c for c in candidates
                                    if c.get('source') in self.REAL_SOURCES]) >= 2
        return result

    def enrich_batch(self, matches):
        """Enrichir une liste de matchs avec les cotes fusionnées (multi-sources)."""
        for m in matches:
            league = m.get('league', m.get('tournament_name', 'Unknown'))
            home = m.get('home_team', m.get('homeTeam', '?'))
            away = m.get('away_team', m.get('awayTeam', '?'))
            odds = self.get_odds(home, away, league)
            m['odds_home'] = odds.get('home_win')
            m['odds_draw'] = odds.get('draw')
            m['odds_away'] = odds.get('away_win')
            m['odds_over_25'] = odds.get('over_25')
            m['odds_under_25'] = odds.get('under_25')
            m['odds_btts_yes'] = odds.get('btts_yes')
            m['odds_btts_no'] = odds.get('btts_no')
            m['odds_corners_over'] = odds.get('corners_over')
            m['odds_corners_under'] = odds.get('corners_under')
            m['odds_home_xg'] = odds.get('home_xg')
            m['odds_away_xg'] = odds.get('away_xg')
            m['odds_shots_h'] = odds.get('shots_h')
            m['odds_shots_a'] = odds.get('shots_a')
            m['odds_source'] = odds.get('source', 'default')
            m['odds_tiers'] = odds.get('_tiers', [])
            m['odds_consensus'] = odds.get('_consensus', False)
            m['has_real_odds'] = (
                odds.get('source') in self.REAL_SOURCES
                or any(t in self.REAL_SOURCES for t in (odds.get('_tiers') or []))
            )
            m['has_real_ou_btts'] = (
                m.get('odds_over_25') is not None or m.get('odds_btts_yes') is not None
            ) and m['has_real_odds']
        return matches


if __name__ == '__main__':
    import time
    engine = OddsFusionEngine()

    test_matches = [
        ('Almería', 'Málaga CF', 'Segunda División'),
        ('Londrina', 'Athletic Club', 'Brasileirão Serie B'),
        ('Germany', "Côte d'Ivoire", 'World Cup 2026'),
        ('SC Jacksonville', 'Charleston Battery', 'USL Championship'),
    ]

    print('\n=== prefer_real=True (sources réelles uniquement) ===\n')
    t0 = time.time()
    for home, away, league in test_matches:
        odds = engine.get_odds(home, away, league, prefer_real=True)
        print(f'{home:22} vs {away:22} [{league:20}]')
        print(f'  {odds["source"]:15}  H={odds.get("home_win","-"):>6}  D={odds.get("draw","-"):>6}  A={odds.get("away_win","-"):>6}')
        print()
    print(f'Temps: {time.time()-t0:.1f}s\n')

    print('=== prefer_real=False (inclut estimation historique) ===\n')
    t0 = time.time()
    for home, away, league in test_matches:
        odds = engine.get_odds(home, away, league, prefer_real=False)
        print(f'{home:22} vs {away:22} [{league:20}]')
        print(f'  {odds["source"]:15}  H={odds.get("home_win","-"):>6}  D={odds.get("draw","-"):>6}  A={odds.get("away_win","-"):>6}')
        print()
    print(f'Temps: {time.time()-t0:.1f}s')
