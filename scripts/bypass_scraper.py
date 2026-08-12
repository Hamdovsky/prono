"""
bypass_scraper.py — BetExplorer scraping via curl_cffi (TLS fingerprint spoofing).

Remplace l'ancien module qui dépendait de Firecrawl (API payante).
Nouvelle stratégie, 100 % gratuite :
  - Recherche de match via l'URL de ligue (slug) — la recherche /?q= est morte (404)
  - Cotes 1X2 parsées depuis data-odd du HTML statique des pages ligue/fixtures
  - OU/BTTS via HTTP direct sur /over-under/ et /both-teams-to-score/
    (si data-odd absent → retour None, le tier4 ML prend le relais)
  - Retries bornés + délais jitter : aucun risque de boucle infinie

Commands (CLI, JSON sur stdin):
  cmd=scrape            fetch any URL with curl_cffi
  cmd=odds              fetch URL + parse odds from HTML
  cmd=betexplorer       full pipeline: 1X2 + OU/BTTS + match_url (sortie JS-compatible)
  cmd=betexplorer_search  1X2 + match_url uniquement
  cmd=estimate_ou_btts  estimation ML Poisson depuis xG (fallback)

Importable API:
  scrape_url(url, opts) -> dict
  parse_odds_from_html(html, url) -> dict
  betexplorer_search(home, away, league) -> dict
  betexplorer_match_ou(match_url, use_firecrawl=True) -> dict
  betexplorer_match_btts(match_url, use_firecrawl=True) -> dict
  estimate_ou_btts_ml(home, away, league) -> dict
"""

import sys, json, re, os, math, time, logging, random, unicodedata
from urllib.parse import urlparse, urljoin

BASE_URL = 'https://www.betexplorer.com'
MAX_ATTEMPTS = 3

logging.basicConfig(level=logging.INFO, format='[BYBYPASS] %(message)s')
log = logging.getLogger('BypassScraper')

try:
    from curl_cffi import requests as curl_requests
    from curl_cffi.requests import BrowserType
    HAS_CURL_CFFI = True
except Exception:
    curl_requests = None
    HAS_CURL_CFFI = False
    class BrowserType:
        chrome124 = chrome120 = chrome116 = chrome110 = 'chrome'

BROWSER_FINGERPRINTS = {
    "chrome124": BrowserType.chrome124,
    "chrome120": BrowserType.chrome120,
    "chrome116": BrowserType.chrome116,
    "chrome110": BrowserType.chrome110,
    "safari17_0": BrowserType.safari17_0,
    "firefox133": BrowserType.firefox133,
}

DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9,fr;q=0.8",
}


def _requests_fetch(url, headers, timeout, proxy, method, body):
    import requests
    proxies = {"http": proxy, "https": proxy} if proxy else None
    if method.upper() == "GET":
        return requests.get(url, headers=headers, timeout=timeout, proxies=proxies)
    if method.upper() == "POST":
        return requests.post(url, headers=headers, data=body, timeout=timeout, proxies=proxies)
    return requests.request(method, url, headers=headers, timeout=timeout, proxies=proxies)


def scrape_url(url, options=None):
    """Fetch a URL with TLS fingerprint spoofing. Retries bornés + jitter (jamais infini)."""
    opts = options or {}
    fingerprint = opts.get("fingerprint", "chrome124")
    timeout = opts.get("timeout", 30)
    proxy = opts.get("proxy")
    headers = dict(DEFAULT_HEADERS)
    headers.update(opts.get("headers", {}) or {})
    method = opts.get("method", "GET")
    body = opts.get("body")
    max_attempts = max(1, min(int(opts.get("max_retries", MAX_ATTEMPTS)), 5))

    order = [fingerprint] if fingerprint in BROWSER_FINGERPRINTS else ["chrome124"]
    order += [k for k in BROWSER_FINGERPRINTS if k not in order]

    last_error = "all fingerprints failed"
    for attempt in range(max_attempts):
        fp_name = order[attempt % len(order)]
        browser = BROWSER_FINGERPRINTS.get(fp_name, BrowserType.chrome124)
        try:
            if not HAS_CURL_CFFI:
                resp = _requests_fetch(url, headers, timeout, proxy, method, body)
            else:
                session = curl_requests.Session(impersonate=browser)
                if proxy:
                    session.proxies = {"http": proxy, "https": proxy}
                if method.upper() == "GET":
                    resp = session.get(url, headers=headers, timeout=timeout)
                elif method.upper() == "POST":
                    resp = session.post(url, headers=headers, data=body, timeout=timeout)
                else:
                    resp = session.request(method, url, headers=headers, timeout=timeout)
                try:
                    session.close()
                except Exception:
                    pass
            status = getattr(resp, "status_code", 0)
            if status and status >= 400:
                last_error = f"http_{status}"
                time.sleep(random.uniform(1.2, 2.5))
                continue
            elapsed = 0.0
            if hasattr(resp, "elapsed"):
                try:
                    elapsed = resp.elapsed.total_seconds()
                except Exception:
                    elapsed = 0.0
            return {
                "status": status,
                "headers": dict(getattr(resp, "headers", {}) or {}),
                "body": getattr(resp, "text", "") or "",
                "url": str(getattr(resp, "url", url)),
                "elapsed": elapsed,
                "fingerprint": fp_name,
            }
        except Exception as ex:
            last_error = str(ex)[:200]
            if attempt < max_attempts - 1:
                time.sleep(random.uniform(0.8, 2.0))
    return {"error": last_error, "status": 0, "body": "", "url": url}


def parse_odds_from_html(html_text, url):
    """Parse odds (data-odd) from arbitrary HTML. Site-agnostic."""
    result = {}
    if not html_text:
        return result
    nums = [float(x) for x in re.findall(r'data-odd=["\']([\d.]+)', html_text)]
    if len(nums) >= 3:
        result["home_win"], result["draw"], result["away_win"] = nums[0], nums[1], nums[2]
        return result
    nums = re.findall(r'([\d.]{3,5})\s*[-–]\s*([\d.]{3,5})\s*[-–]\s*([\d.]{3,5})', html_text)
    if nums:
        try:
            result["home_win"], result["draw"], result["away_win"] = (
                float(nums[0][0]), float(nums[0][1]), float(nums[0][2])
            )
        except ValueError:
            pass
    return result


def _to_float(v):
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


ALIAS_CONFIG_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'betexplorer_aliases.json')
_ALIAS_CFG = {"canonical": {}, "digraphs": {}}


def _load_alias_config():
    global _ALIAS_CFG
    try:
        with open(ALIAS_CONFIG_FILE, encoding='utf-8') as f:
            cfg = json.load(f)
        if isinstance(cfg, dict):
            _ALIAS_CFG = {
                "canonical": cfg.get("canonical") if isinstance(cfg.get("canonical"), dict) else {},
                "digraphs": cfg.get("digraphs") if isinstance(cfg.get("digraphs"), dict) else {},
            }
    except Exception:
        _ALIAS_CFG = {"canonical": {}, "digraphs": {}}


_load_alias_config()


def _normalize_team(name):
    n = (name or '').lower().strip()
    n = ''.join(c for c in unicodedata.normalize('NFD', n) if unicodedata.category(c) != 'Mn')
    n = re.sub(r'^(fc|sc|ac|as|us|ec|cd|ca|cr|gr|aek|paok|osa|ifk|bk|ff|ss|nk|fk|sk|rc|ra|ud|ad|cdt)\.?\s+', '', n)
    n = re.sub(r'\s+(fc|sc|ac|as|us|cf|cd|ca|ec)\.?\s*$', '', n)
    return n.strip()


def _canonical(name):
    n = _normalize_team(name)
    for alias, full in _ALIAS_CFG.get("canonical", {}).items():
        if not alias or not full:
            continue
        n = re.sub(r'\b' + re.escape(alias) + r'\b\.?', full, n)
    return n.strip()


def _translit_digraphs(name):
    n = name
    for dg, ch in _ALIAS_CFG.get("digraphs", {}).items():
        if not dg:
            continue
        n = n.replace(dg, ch)
    return n


def _significant_words(s):
    return [w for w in re.split(r'[\s\-\.]+', s) if len(w) >= 3]


def _core_match(a, b):
    if not a or not b:
        return False
    if a == b:
        return True
    if a in b or b in a:
        return True
    w1 = _significant_words(a)
    w2 = _significant_words(b)
    if not w1 or not w2:
        return False
    s1 = set(w1)
    s2 = set(w2)
    common = s1 & s2
    if common:
        ratio = len(common) / min(len(w1), len(w2))
        if ratio >= 0.6:
            return True
        if ratio >= 0.5 and len(common) >= 2:
            return True
    for w in w1:
        for v in w2:
            if w != v and len(w) >= 4 and len(v) >= 4 and (w.startswith(v) or v.startswith(w)):
                return True
    return False


def _short_prefix_match(a, b):
    w1 = _significant_words(a)
    w2 = _significant_words(b)
    for w in w1:
        if len(w) != 3:
            continue
        for v in w2:
            if len(v) >= 4 and v != w and v.startswith(w):
                return True
    return False


_QUALIFIERS = {'united', 'city', 'utd'}
_QUALIFIER_CANON = {'utd': 'united'}


def _canon_qual(q):
    return _QUALIFIER_CANON.get(q, q)


def _split_qualifier(name):
    words = re.split(r'[\s\-\.]+', name.strip())
    words = [w for w in words if w]
    if len(words) >= 2 and words[-1] in _QUALIFIERS:
        return ' '.join(words[:-1]), _canon_qual(words[-1])
    return name, None


def _qualifier_match(a, b):
    ab, aq = _split_qualifier(a)
    bb, bq = _split_qualifier(b)
    if not aq or not bq:
        return False
    if aq != bq:
        return False
    if not ab or not bb:
        return False
    w1 = _significant_words(ab)
    w2 = _significant_words(bb)
    for w in w1:
        for v in w2:
            if w != v and len(w) >= 3 and (v.startswith(w) or w.startswith(v)):
                return True
    return False


def _match_date_tuple(date):
    if isinstance(date, (int, float)):
        try:
            t = time.gmtime(int(date))
            return (int(time.strftime('%m', t)), int(time.strftime('%d', t)))
        except Exception:
            return None
    s = str(date)[:10]
    parts = s.split('-')
    if len(parts) == 3:
        try:
            return (int(parts[1]), int(parts[2]))
        except ValueError:
            return None
    return None


def _date_close(row_date, match_date, tolerance_days=1):
    if not row_date or not match_date:
        return False
    return abs((row_date[0] * 31 + row_date[1]) - (match_date[0] * 31 + match_date[1])) <= tolerance_days


def _teams_match(a, b, ctx=None):
    a_std = _canonical(a)
    b_std = _canonical(b)
    if _core_match(a_std, b_std):
        return True
    a_tr = _translit_digraphs(a_std)
    b_tr = _translit_digraphs(b_std)
    if a_tr != a_std or b_tr != b_std:
        if _core_match(a_tr, b_tr) or _core_match(a_tr, b_std) or _core_match(a_std, b_tr):
            return True
    if _qualifier_match(a_std, b_std) or _qualifier_match(b_std, a_std):
        return True
    if ctx and ctx.get('date') and ctx.get('row_date'):
        md = _match_date_tuple(ctx['date'])
        if md and _date_close(ctx['row_date'], md):
            if _short_prefix_match(a_std, b_std) or _short_prefix_match(b_std, a_std):
                return True
    return False


LEAGUE_SLUG_MAPPING = {
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
    'Brasileirao': '/football/brazil/serie-a/',
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
    'J2 League': '/football/japan/j2-league/',
    'K League 1': '/football/south-korea/k-league-1/',
    'Eliteserien': '/football/norway/eliteserien/',
    'Allsvenskan': '/football/sweden/allsvenskan/',
    'Ekstraklasa': '/football/poland/ekstraklasa/',
    'Liga MX': '/football/mexico/liga-mx/',
    'Primera División': '/football/argentina/primera-division/',
    'Primera Division': '/football/argentina/primera-division/',
    'Liga Profesional': '/football/argentina/primera-division/',
    'World Cup 2026': '/football/international/world-cup/',
    'International Friendly': '/football/international/friendly/',
}


# Ambiguïtés pays-aware : (league_lower, country_lower) -> slug.
# Challenge Cup = Écosse (slate réel), Premiership = Afrique du Sud (DStv),
# Championship par défaut = Angleterre (EFL), désambiguïsé par pays.
LEAGUE_SLUG_COUNTRY_MAPPING = {
    ('challenge cup', 'scotland'): '/football/scotland/challenge-cup/',
    ('challenge cup', 'northern ireland'): '/football/northern-ireland/challenge-cup/',
    ('premiership', 'south africa'): '/football/south-africa/premiership/',
    ('premiership', 'scotland'): '/football/scotland/premier-league/',
    ('championship', 'northern ireland'): '/football/northern-ireland/championship/',
    ('championship', 'england'): '/football/england/championship/',
    ('premier league', 'bahrain'): '/football/bahrain/premier-league/',
    ('premier league', 'kazakhstan'): '/football/kazakhstan/premier-league/',
    ('ligue 1', 'tunisia'): '/football/tunisia/ligue-professionnelle-1/',
}


def _league_to_betexplorer_slug(league, country=None):
    if not league:
        return None
    league_lower = league.lower()
    # Résolution par pays : désambiguïse les ligues homonymes (Challenge Cup, Premiership, Championship).
    if country:
        country_lower = country.lower().strip()
        for (lk, ck), slug in LEAGUE_SLUG_COUNTRY_MAPPING.items():
            if lk in league_lower and ck in country_lower:
                return slug
    for key, slug in LEAGUE_SLUG_MAPPING.items():
        if key.lower() in league_lower:
            return slug
    return None


def _match_anchor_parts(a):
    spans = a.find_all('span')
    texts = [s.get_text(' ', strip=True) for s in spans if s.get_text(' ', strip=True)]
    if len(texts) >= 2:
        return texts[0], texts[-1]
    text = a.get_text(' ', strip=True)
    parts = [p.strip() for p in re.split(r'\s[-–—]\s', text) if p.strip()]
    if len(parts) >= 2:
        return parts[0], parts[-1]
    return None, None


def _teams_from_slug(href):
    seg = href.rstrip('/').split('/')[-1]
    tokens = [t for t in seg.split('-') if t]
    if len(tokens) < 3:
        return None, None
    if re.fullmatch(r'[A-Za-z0-9]{6,10}', tokens[-1]):
        tokens = tokens[:-1]
    if len(tokens) == 2:
        return tokens[0], tokens[1]
    return None, None


def _odds_from_scope(node):
    cells = node.find_all(attrs={'data-odd': True})
    vals = [_to_float(c.get('data-odd')) for c in cells]
    vals = [v for v in vals if v is not None and v > 1.0]
    if len(vals) >= 3:
        return {'home_win': vals[0], 'draw': vals[1], 'away_win': vals[2]}
    return None


def _container_odds(node):
    cur = node
    for _ in range(4):
        cur = cur.parent
        if cur is None:
            break
        odds = _odds_from_scope(cur)
        if odds:
            return odds
    return None


def _match_hash_from_url(match_url):
    m = re.search(r'[-]([A-Za-z0-9]{6,10})/?$', match_url.rstrip('/'))
    return m.group(1) if m else None


def _parse_row_datetime(tr):
    try:
        td = tr.find('td', class_='table-main__datetime')
        if td is None:
            return None
        m = re.match(r'(\d{1,2})\.(\d{1,2})\.', td.get_text(' ', strip=True))
        if not m:
            return None
        return (int(m.group(2)), int(m.group(1)))
    except Exception:
        return None


def _find_match_in_html(html, home, away, date=None):
    try:
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(html, 'html.parser')
        candidates = []
        seen_urls = set()
        for a in soup.find_all('a', href=True):
            href = a['href']
            if '/football/' not in href:
                continue
            hp, ap = _match_anchor_parts(a)
            if not hp or not ap:
                hp, ap = _teams_from_slug(href)
            if not hp or not ap:
                continue
            tr = a.find_parent('tr')
            row_date = _parse_row_datetime(tr) if tr is not None else None
            ctx = {'date': date, 'row_date': row_date}
            if not (_teams_match(hp, home, ctx) and _teams_match(ap, away, ctx)):
                continue
            row_odds = _odds_from_scope(tr) if tr is not None else None
            if not row_odds:
                row_odds = _container_odds(a)
            if not row_odds:
                continue
            match_url = urljoin(BASE_URL + '/', href)
            if match_url in seen_urls:
                continue
            seen_urls.add(match_url)
            candidates.append({
                'odds': row_odds,
                'match_url': match_url,
                'match_hash': _match_hash_from_url(match_url),
                'row_date': row_date,
            })
        if not candidates:
            return None
        if len(candidates) > 1 and date:
            md = _match_date_tuple(date)
            if md:
                close = [c for c in candidates if _date_close(c['row_date'], md)]
                if close:
                    candidates = close
                else:
                    return None
        if len(candidates) > 1:
            log.warning('ambiguous match for %s vs %s: %d candidates', home, away, len(candidates))
            return None
        return candidates[0]
    except Exception as ex:
        log.debug('find_match error: %s', ex)
    return None


def betexplorer_search(home, away, league=None, date=None, country=None):
    """Recherche BetExplorer via la page de ligue (slug). Retourne 1X2 + match_url."""
    slug = _league_to_betexplorer_slug(league, country)
    if not slug:
        return {"odds": None, "match_url": None, "match_hash": None, "error": "no_league_slug"}

    candidate_urls = [
        f'{BASE_URL}{slug}fixtures/',
        f'{BASE_URL}{slug}results/',
        f'{BASE_URL}{slug}',
    ]
    for url in candidate_urls:
        result = scrape_url(url, {"fingerprint": "chrome124", "timeout": 20})
        if result.get('error') or result.get('status', 0) != 200:
            continue
        match = _find_match_in_html(result.get("body", ""), home, away, date=date)
        if match:
            match["url_probe"] = url
            return match
    return {"odds": None, "match_url": None, "match_hash": None}


def _parse_ou_page(html):
    try:
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(html, 'html.parser')
        for tr in soup.find_all('tr'):
            first = tr.find('td') or tr.find('th')
            if first is None:
                continue
            if '2.5' in first.get_text(' ', strip=True):
                vals = [_to_float(c.get('data-odd')) for c in tr.find_all(attrs={'data-odd': True})]
                vals = [v for v in vals if v is not None and v > 1.0]
                if len(vals) >= 2:
                    return vals[0], vals[1]
        vals = [_to_float(c.get('data-odd')) for c in soup.find_all(attrs={'data-odd': True})]
        vals = [v for v in vals if v is not None and v > 1.0]
        if len(vals) >= 2:
            return vals[0], vals[1]
    except Exception as ex:
        log.debug('ou parse error: %s', ex)
    return None, None


def _parse_btts_page(html):
    try:
        from bs4 import BeautifulSoup
        soup = BeautifulSoup(html, 'html.parser')
        vals = [_to_float(c.get('data-odd')) for c in soup.find_all(attrs={'data-odd': True})]
        vals = [v for v in vals if v is not None and v > 1.0]
        if len(vals) >= 2:
            return vals[0], vals[1]
    except Exception as ex:
        log.debug('btts parse error: %s', ex)
    return None, None


def betexplorer_match_ou(match_url, use_firecrawl=True):
    """OU 2.5 depuis /over-under/ (HTTP direct). data-odd absent -> {ou25: None}."""
    if not use_firecrawl or not match_url:
        return {"ou25": None, "source": "skipped"}
    ou_url = match_url.rstrip("/") + "/over-under/"
    result = scrape_url(ou_url, {"fingerprint": "chrome124", "timeout": 20})
    if result.get('error') or result.get('status', 0) != 200:
        return {"ou25": None, "source": "failed"}
    over, under = _parse_ou_page(result.get("body", ""))
    ou = {"over_25": over, "under_25": under} if (over and under) else None
    return {"ou25": ou, "source": "betexplorer" if ou else "static_empty"}


def betexplorer_match_btts(match_url, use_firecrawl=True):
    """BTTS depuis /both-teams-to-score/ (HTTP direct). data-odd absent -> {btts: None}."""
    if not use_firecrawl or not match_url:
        return {"btts": None, "source": "skipped"}
    btts_url = match_url.rstrip("/") + "/both-teams-to-score/"
    result = scrape_url(btts_url, {"fingerprint": "chrome124", "timeout": 20})
    if result.get('error') or result.get('status', 0) != 200:
        return {"btts": None, "source": "failed"}
    yes, no = _parse_btts_page(result.get("body", ""))
    btts = {"yes": yes, "no": no} if (yes and no) else None
    return {"btts": btts, "source": "betexplorer" if btts else "static_empty"}


def betexplorer_full(home, away, league=None, use_firecrawl=True, date=None, country=None):
    """Pipeline complet: recherche -> 1X2 (+ OU/BTTS si data-odd statique dispo)."""
    search = betexplorer_search(home, away, league, date=date, country=country)
    result = {
        "odds": None,
        "over_25": None,
        "under_25": None,
        "btts_yes": None,
        "btts_no": None,
        "source": None,
        "match_url": search.get("match_url"),
        "match_hash": search.get("match_hash"),
    }
    if search.get("odds"):
        result["odds"] = search["odds"]
        result["source"] = "betexplorer"
        match_url = search.get("match_url")
        if match_url and use_firecrawl:
            ou_result = betexplorer_match_ou(match_url, use_firecrawl=True)
            if ou_result.get("ou25"):
                result["over_25"] = ou_result["ou25"].get("over_25")
                result["under_25"] = ou_result["ou25"].get("under_25")
            btts_result = betexplorer_match_btts(match_url, use_firecrawl=True)
            if btts_result.get("btts"):
                result["btts_yes"] = btts_result["btts"].get("yes")
                result["btts_no"] = btts_result["btts"].get("no")
            if result["over_25"] or result["btts_yes"]:
                result["source"] = "betexplorer+static"
    return result


def compute_ou_btts_from_xg(xg_h, xg_a):
    """Estimation OU 2.5 + BTTS via Poisson (probas en %)."""
    ou25 = 0.0
    for k in range(0, 8):
        pk = math.exp(-xg_h) * xg_h ** k / math.factorial(k)
        for l in range(0, 8):
            pl = math.exp(-xg_a) * xg_a ** l / math.factorial(l)
            if k + l > 2.5:
                ou25 += pk * pl
    btts = (1 - math.exp(-xg_h)) * (1 - math.exp(-xg_a))
    return round(ou25 * 100, 1), round(btts * 100, 1)


def _team_xg(hist, is_home, default):
    vals = []
    for m in hist:
        if not isinstance(m, dict):
            continue
        v = None
        for k in ('expected_goals', 'xg', 'expectedGoals'):
            if m.get(k) is not None:
                v = m.get(k)
                break
        if v is None:
            v = m.get('Expected goals_home' if is_home else 'Expected goals_away')
        if v is None:
            v = m.get('Expected goals_home' if not is_home else 'Expected goals_away')
        if v is None:
            v = m.get('score_for')
        f = _to_float(v)
        if f is not None and 0 < f <= 4.5:
            vals.append(f)
    if not vals:
        return default
    return sum(vals) / len(vals)


def _get_history(team, limit=10):
    """Chargement paresseux de l'historique équipe via core/ml_features."""
    try:
        core_dir = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'core')
        sys.path.insert(0, core_dir)
        from ml_features import get_team_history
        return get_team_history(team, limit=limit)
    except Exception as ex:
        log.debug('ml_features unavailable: %s', ex)
        return []


def estimate_ou_btts_ml(home, away, league=None):
    """Fallback ML: estimation OU/BTTS depuis les xG historiques (Poisson)."""
    h_hist = _get_history(home, limit=10)
    a_hist = _get_history(away, limit=10)

    xg_h = _team_xg(h_hist, True, 1.2)
    xg_a = _team_xg(a_hist, False, 1.0)

    ou25_pct, btts_pct = compute_ou_btts_from_xg(xg_h, xg_a)
    return {
        "over_25_prob": ou25_pct,
        "under_25_prob": round(100 - ou25_pct, 1),
        "btts_yes_prob": btts_pct,
        "btts_no_prob": round(100 - btts_pct, 1),
        "source": "ml_estimate",
    }


def main():
    input_data = json.loads(sys.stdin.read())
    cmd = input_data.get("cmd", "scrape")

    if cmd == "scrape":
        url = input_data.get("url", "")
        options = input_data.get("options", {})
        result = scrape_url(url, options)
        print(json.dumps(result, ensure_ascii=False))
    elif cmd == "odds":
        url = input_data.get("url", "")
        options = input_data.get("options", {})
        scrape_result = scrape_url(url, options)
        if scrape_result.get('error') or scrape_result.get('status', 0) >= 400:
            print(json.dumps({"error": scrape_result.get('error') or f'http_{scrape_result.get("status")}', "odds": None}))
        else:
            odds = parse_odds_from_html(scrape_result.get("body", ""), url)
            print(json.dumps({
                "odds": odds if odds else None,
                "status": scrape_result.get("status"),
                "fingerprint": scrape_result.get("fingerprint"),
                "url": scrape_result.get("url"),
                "elapsed": scrape_result.get("elapsed"),
            }, ensure_ascii=False))
    elif cmd == "betexplorer":
        home = input_data.get("home", "")
        away = input_data.get("away", "")
        league = input_data.get("league", "")
        use_fc = input_data.get("use_firecrawl", True)
        date = input_data.get("date")
        country = input_data.get("country")
        result = betexplorer_full(home, away, league, use_firecrawl=use_fc, date=date, country=country)
        print(json.dumps(result, ensure_ascii=False))
    elif cmd == "betexplorer_search":
        home = input_data.get("home", "")
        away = input_data.get("away", "")
        league = input_data.get("league", "")
        date = input_data.get("date")
        country = input_data.get("country")
        result = betexplorer_search(home, away, league, date=date, country=country)
        print(json.dumps(result, ensure_ascii=False))
    elif cmd == "estimate_ou_btts":
        home = input_data.get("home", "")
        away = input_data.get("away", "")
        league = input_data.get("league", "")
        result = estimate_ou_btts_ml(home, away, league)
        print(json.dumps(result, ensure_ascii=False))
    else:
        print(json.dumps({"error": f"Unknown command: {cmd}"}))


if __name__ == "__main__":
    main()
