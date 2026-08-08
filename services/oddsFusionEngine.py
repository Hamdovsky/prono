"""
OddsFusionEngine — couche de fusion multi-sources pour les cotes.

Architecture unifiée (toutes les sources travaillent en équipe):

  Tier 1: BSD API (Bzzoiro) — cotes réelles 1X2 + OU/BTTS, limité aux matchs WC
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
        self.bsd_key = self._get_key('BSD_API_KEY')
        self.bsd_base = 'https://sports.bzzoiro.com/api'
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

    # ── Tier 1: BSD API ──────────────────────────────────────

    def _tier1_bsd(self, home, away, league):
        """BSD API — cotes réelles. Retourne dict ou None."""
        if not self.bsd_key:
            return None
        headers = {'Authorization': f'Token {self.bsd_key}'}
        today = datetime.date.today().isoformat()
        url = f'{self.bsd_base}/v2/events/?date_from={today}&date_to={today}&limit=100'
        try:
            r = requests.get(url, headers=headers, timeout=10)
            data = r.json()
            for e in data.get('results', []):
                ht = e.get('home_team') or ''
                at = e.get('away_team') or ''
                # Utiliser le fuzzy matching comme Tier 2 (supporte accents, variantes)
                if self._teams_match(ht, home) and self._teams_match(at, away):
                    mid = e.get('id')
                    odds_url = f'{self.bsd_base}/v2/events/{mid}/odds/'
                    r2 = requests.get(odds_url, headers=headers, timeout=10)
                    o = r2.json().get('odds', {})
                    if o.get('home_win') is not None:
                        return {
                            'home_win': o['home_win'],
                            'draw': o['draw'],
                            'away_win': o['away_win'],
                            'over_25': o.get('over_25_goals'),
                            'under_25': o.get('under_25_goals'),
                            'btts_yes': o.get('btts_yes'),
                            'btts_no': o.get('btts_no'),
                            'source': 'bsd'
                        }
        except Exception as ex:
            self._log(1, f'Error: {ex}')
        return None

    # ── Tier 2: BetExplorer Bypass Scraper (curl_cffi TLS fingerprint) ──

    def _tier2_betexplorer_bypass(self, home, away, league):
        """BetExplorer via bypass scraper (curl_cffi, recherche directe).
        Retourne 1X2 + match_url si trouvé."""
        try:
            sys.path.insert(0, os.path.join(BASE_DIR, 'scripts'))
            from bypass_scraper import betexplorer_search
            result = betexplorer_search(home, away, league)
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
        return self._tier2_betexplorer_legacy(home, away, league)

    def _tier2_betexplorer_legacy(self, home, away, league):
        """Legacy BetExplorer scraper via cloudscraper + BS4 (league pages)."""
        try:
            import cloudscraper
            from bs4 import BeautifulSoup
        except ImportError:
            return None

        league_slug = self._league_to_betexplorer_slug(league)
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

    def _league_to_betexplorer_slug(self, league):
        mapping = {
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

    def get_odds(self, home, away, league, prefer_real=True, use_soccerapi=False):
        """
        Obtenir les cotes pour un match via la fusion multi-tiers.
        Toutes les sources travaillent en équipe — 1X2, OU/BTTS, ML.
        
        Pipeline:
          1. Tier 1: BSD API → 1X2 + OU/BTTS (si dispo)
          2. Tier 2: BetExplorer bypass (curl_cffi) → 1X2 + match_url
          3. Tier 2b: BetExplorer HTTP direct → OU/BTTS depuis match_url (si data-odd statique)
          4. Tier 4 ML: Monte Carlo → OU/BTTS estimé depuis xG (fallback)
          5. Tier 5: Historical + Elo → 1X2 estimé
          6. Tier 6: Defaults 2.5/3.2/2.8
        
        Returns:
            dict avec home_win, draw, away_win, over_25, under_25, btts_yes, btts_no, source
        """
        result = {
            'home_win': None, 'draw': None, 'away_win': None,
            'over_25': None, 'under_25': None,
            'btts_yes': None, 'btts_no': None,
            'source': None, '_tiers': [],
        }
        
        match_url = None

        # ── PHASE 0: Football-Data fixtures (source fiable, cotes réelles) ──
        try:
            odds = self._tier0_football_data(home, away, league)
            if odds and odds.get('home_win') is not None:
                result.update(odds)
                result['_tiers'].append('tier0_football_data')
                self._log(0, f'1X2: {home} vs {away}: {odds["home_win"]}/{odds["draw"]}/{odds["away_win"]}')
        except Exception as ex:
            self._log(0, f'Error: {ex}')

        # ── PHASE 1: 1X2 odds ────────────────────────────────
        
        # Tier 1: BSD API (1X2 + OU/BTTS)
        try:
            odds = self._tier1_bsd(home, away, league)
            if odds and odds.get('home_win') is not None:
                result['home_win'] = odds['home_win']
                result['draw'] = odds['draw']
                result['away_win'] = odds['away_win']
                result['over_25'] = odds.get('over_25')
                result['under_25'] = odds.get('under_25')
                result['btts_yes'] = odds.get('btts_yes')
                result['btts_no'] = odds.get('btts_no')
                result['source'] = odds.get('source', 'bsd')
                result['_tiers'].append('tier1_bsd')
                self._log(1, f'1X2: {home} vs {away}: {odds["home_win"]}/{odds["draw"]}/{odds["away_win"]}')
                if result['over_25'] and result['btts_yes']:
                    # BSD a TOUT (1X2 + OU/BTTS), on retourne direct
                    return result
        except Exception as ex:
            self._log(1, f'Error: {ex}')

        # Tier 2: BetExplorer bypass (1X2)
        try:
            odds = self._tier2_betexplorer_bypass(home, away, league)
            if odds and odds.get('home_win') is not None:
                result['home_win'] = odds['home_win']
                result['draw'] = odds['draw']
                result['away_win'] = odds['away_win']
                result['source'] = odds.get('source', 'betexplorer')
                result['_tiers'].append('tier2_bypass')
                match_url = odds.get('match_url')
                self._log(2, f'1X2: {home} vs {away}: {odds["home_win"]}/{odds["draw"]}/{odds["away_win"]}')
        except Exception as ex:
            self._log(2, f'Error: {ex}')

        # Tier 2b: Firecrawl OU/BTTS (si match_url trouvé)
        if match_url and not (result['over_25'] and result['btts_yes']):
            try:
                ou_btts = self._tier2b_firecrawl_ou_btts(home, away, league, match_url)
                if ou_btts:
                    if ou_btts.get('over_25'): result['over_25'] = ou_btts['over_25']
                    if ou_btts.get('under_25'): result['under_25'] = ou_btts['under_25']
                    if ou_btts.get('btts_yes'): result['btts_yes'] = ou_btts['btts_yes']
                    if ou_btts.get('btts_no'): result['btts_no'] = ou_btts['btts_no']
                    result['_tiers'].append('tier2b_firecrawl')
            except Exception as ex:
                self._log(2, f'[firecrawl] Error: {ex}')

        # Tier 4 ML: OU/BTTS Monte Carlo (fallback)
        if not (result['over_25'] and result['btts_yes']):
            try:
                ml = self._tier4_ml_ou_btts(home, away, league)
                if ml:
                    if not result['over_25']: result['over_25'] = ml.get('over_25')
                    if not result['under_25']: result['under_25'] = ml.get('under_25')
                    if not result['btts_yes']: result['btts_yes'] = ml.get('btts_yes')
                    if not result['btts_no']: result['btts_no'] = ml.get('btts_no')
                    result['_tiers'].append('tier4_ml')
                    self._log(4, f'ML OU/BTTS: {home} vs {away}: OU={ml.get("over_25")}')
            except Exception as ex:
                self._log(4, f'[ml] Error: {ex}')

        # Tier 3: soccerapi (optionnel, geo-bloqué France)
        if use_soccerapi and not result['home_win']:
            try:
                odds = self._tier3_soccerapi(home, away, league)
                if odds and odds.get('home_win') is not None:
                    result['home_win'] = odds['home_win']
                    result['draw'] = odds['draw']
                    result['away_win'] = odds['away_win']
                    result['source'] = odds.get('source', '888sport')
                    result['_tiers'].append('tier3_soccerapi')
            except Exception as ex:
                self._log(3, f'Error: {ex}')

        # ── PHASE 2: Fallbacks si pas de 1X2 ─────────────────

        if not result['home_win']:
            if not prefer_real:
                try:
                    odds = self._tier5_historical_elo(home, away, league)
                    if odds and odds.get('home_win') is not None:
                        result['home_win'] = odds['home_win']
                        result['draw'] = odds['draw']
                        result['away_win'] = odds['away_win']
                        result['source'] = odds.get('source', 'historical+elo')
                        result['_tiers'].append('tier5_historical')
                        self._log(5, f'Historical: {odds["home_win"]}/{odds["draw"]}/{odds["away_win"]}')
                except Exception as ex:
                    self._log(5, f'Error: {ex}')

            if not result['home_win']:
                defaults = self._tier6_defaults(home, away, league)
                result['home_win'] = defaults['home_win']
                result['draw'] = defaults['draw']
                result['away_win'] = defaults['away_win']
                result['source'] = 'default'
                result['_tiers'].append('tier6_default')

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
            m['odds_source'] = odds.get('source', 'default')
            m['odds_tiers'] = odds.get('_tiers', [])
            real_sources = ('bsd', 'betexplorer', 'betexplorer+firecrawl', '888sport', 'unibet', 'firecrawl')
            m['has_real_odds'] = odds.get('source') in real_sources
            m['has_real_ou_btts'] = (
                m.get('odds_over_25') is not None or m.get('odds_btts_yes') is not None
            ) and odds.get('source') in ('bsd', 'betexplorer+firecrawl', 'firecrawl')
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
