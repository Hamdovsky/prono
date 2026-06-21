"""
bypass_scraper.py — TLS fingerprint spoofing scraper via curl_cffi
+ Firecrawl integration for JS-rendered pages

Commands (CLI):
  cmd=scrape       — fetch any URL with curl_cffi
  cmd=odds         — fetch URL + parse odds from HTML
  cmd=betexplorer  — search BetExplorer + return 1X2 + match URL
  
Importable API:
  scrape_url(url, opts) -> dict
  parse_odds_from_html(html, url) -> dict
  betexplorer_search(home, away, league) -> dict
  betexplorer_match_ou(match_url) -> dict
  betexplorer_match_btts(match_url) -> dict
"""

import sys, json, re, os, math, time, logging
from urllib.parse import urlparse, urljoin
from curl_cffi import requests as curl_requests
from curl_cffi.requests import BrowserType

BROWSER_FINGERPRINTS = {
    "chrome124": BrowserType.chrome124,
    "chrome120": BrowserType.chrome120,
    "chrome116": BrowserType.chrome116,
    "chrome110": BrowserType.chrome110,
    "chrome107": BrowserType.chrome107,
    "chrome101": BrowserType.chrome101,
    "chrome99":  BrowserType.chrome99,
    "safari15_5": BrowserType.safari15_5,
    "safari17_0": BrowserType.safari17_0,
    "firefox133": BrowserType.firefox133,
    "firefox144": BrowserType.firefox144,
    "edge101": BrowserType.edge101,
}

FIRECRAWL_API_URL = "https://api.firecrawl.dev/v1/scrape"

# ── Site-specific parsers ──────────────────────────────────

def parse_betexplorer(html_text, url):
    result = {}
    odds_list = [float(x) for x in re.findall(r'data-odd="([\d.]+)', html_text)]
    if len(odds_list) >= 3:
        result["home_win"] = odds_list[0]
        result["draw"] = odds_list[1]
        result["away_win"] = odds_list[2]
        return result
    m = re.search(r'data-odd=["\']([\d.]+)', html_text)
    if m:
        odds_list = [float(x) for x in re.findall(r'data-odd=["\']([\d.]+)', html_text)]
        if len(odds_list) >= 3:
            result["home_win"] = odds_list[0]
            result["draw"] = odds_list[1]
            result["away_win"] = odds_list[2]
    table_match = re.search(r'<table[^>]*class=["\'].*?odds.*?["\']', html_text, re.DOTALL)
    if table_match and not result:
        nums = re.findall(r'<td[^>]*>([\d.]+)</td>', table_match.group())
        if len(nums) >= 3:
            result["home_win"] = float(nums[0])
            result["draw"] = float(nums[1])
            result["away_win"] = float(nums[2])
    if not result:
        nums = re.findall(r'([\d.]{3,5})\s*[-–]\s*([\d.]{3,5})\s*[-–]\s*([\d.]{3,5})', html_text)
        if nums:
            result["home_win"] = float(nums[0][0])
            result["draw"] = float(nums[0][1])
            result["away_win"] = float(nums[0][2])
    return result

def parse_flashscore(html_text, url):
    result = {}
    patterns = [
        re.findall(r'odds.*?sp.*?([\d.]+)', html_text, re.DOTALL),
        re.findall(r'data-odd=["\']([\d.]+)', html_text),
        re.findall(r'class=["\'].*?odds.*?["\'][^>]*>([\d.]+)', html_text),
    ]
    for p in patterns:
        nums = [float(x) for x in p if re.match(r'^\d+\.\d+$', x)]
        if len(nums) >= 3:
            result["home_win"] = nums[0]
            result["draw"] = nums[1]
            result["away_win"] = nums[2]
            break
    return result

def parse_oddsportal(html_text, url):
    result = {}
    nums = re.findall(r'class=["\'].*?odds.*?["\'][^>]*>([\d.]+)', html_text)
    if len(nums) < 3:
        nums = re.findall(r'<td[^>]*class=["\'].*?odds.*?["\'].*?>([\d.]+)', html_text)
    if len(nums) < 3:
        nums = re.findall(r'(?:1|X|2)\s*([\d.]+)', html_text)
    floats = [float(x) for x in nums if re.match(r'^\d+\.\d+$', x)]
    if len(floats) >= 3:
        result["home_win"] = floats[0]
        result["draw"] = floats[1]
        result["away_win"] = floats[2]
    return result

def parse_soccerway(html_text, url):
    result = {}
    nums = re.findall(r'<span[^>]*class=["\'].*?odds.*?["\'][^>]*>([\d.]+)', html_text)
    if len(nums) >= 3:
        floats = [float(x) for x in nums[:3] if re.match(r'^\d+\.\d+$', x)]
        if len(floats) >= 3:
            result["home_win"] = floats[0]
            result["draw"] = floats[1]
            result["away_win"] = floats[2]
    return result

def parse_generic(html_text, url):
    result = {}
    nums = re.findall(r'([\d.]{3,5})\s*[-–]\s*([\d.]{3,5})\s*[-–]\s*([\d.]{3,5})', html_text)
    if nums:
        floats = [float(x) for x in nums[0] if re.match(r'^\d+\.\d+$', x)]
        if len(floats) >= 3:
            result["home_win"] = floats[0]
            result["draw"] = floats[1]
            result["away_win"] = floats[2]
    return result

def parse_odds_from_html(html_text, url):
    odds = {}
    parts = urlparse(url)
    hostname = parts.hostname or ""
    if "betexplorer" in hostname:
        odds = parse_betexplorer(html_text, url)
    elif "flashscore" in hostname or "flashresultats" in hostname:
        odds = parse_flashscore(html_text, url)
    elif "oddsportal" in hostname:
        odds = parse_oddsportal(html_text, url)
    elif "soccerway" in hostname:
        odds = parse_soccerway(html_text, url)
    else:
        odds = parse_generic(html_text, url)
    return odds

# ── Scraping core ──────────────────────────────────────────

def scrape_url(url, options=None):
    opts = options or {}
    fingerprint = opts.get("fingerprint", "chrome124")
    timeout = opts.get("timeout", 30)
    proxy = opts.get("proxy")
    headers = opts.get("headers", {})
    method = opts.get("method", "GET")
    body = opts.get("body")

    browser = BROWSER_FINGERPRINTS.get(fingerprint, BrowserType.chrome124)
    session = curl_requests.Session(impersonate=browser)

    if proxy:
        session.proxies = {"http": proxy, "https": proxy}

    default_headers = {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9,fr;q=0.8",
    }
    default_headers.update(headers)

    for fp_name in [fingerprint] + [k for k in BROWSER_FINGERPRINTS if k != fingerprint]:
        try:
            browser = BROWSER_FINGERPRINTS.get(fp_name, BrowserType.chrome124)
            session = curl_requests.Session(impersonate=browser)
            if proxy:
                session.proxies = {"http": proxy, "https": proxy}

            if method.upper() == "GET":
                resp = session.get(url, headers=default_headers, timeout=timeout)
            elif method.upper() == "POST":
                resp = session.post(url, headers=default_headers, data=body, timeout=timeout)
            else:
                resp = session.request(method, url, headers=default_headers, timeout=timeout)

            return {
                "status": resp.status_code,
                "headers": dict(resp.headers),
                "body": resp.text,
                "url": str(resp.url),
                "elapsed": resp.elapsed.total_seconds() if hasattr(resp, "elapsed") else 0,
                "fingerprint": fp_name,
            }
        except Exception as e:
            continue
    return {"error": "All fingerprints failed", "status": 0, "body": "", "url": url}

def _load_env_key(name):
    """Load a key from .env file if not already in environment."""
    val = os.environ.get(name)
    if val:
        return val
    env_path = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), '.env')
    try:
        with open(env_path, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if line.startswith(f'{name}='):
                    return line.split('=', 1)[1].strip().strip('"').strip("'")
    except Exception:
        pass
    return None

def scrape_with_firecrawl(url, options=None):
    """Scrape a URL using Firecrawl API (JS execution). Requires FIRECRAWL_API_KEY."""
    opts = options or {}
    api_key = opts.get("api_key") or _load_env_key("FIRECRAWL_API_KEY")
    if not api_key:
        return {"error": "No FIRECRAWL_API_KEY", "status": 0, "body": ""}

    import urllib.request
    payload = json.dumps({
        "url": url,
        "formats": ["markdown", "html"],
        "onlyMainContent": False,
        "timeout": opts.get("timeout", 30000),
    }).encode("utf-8")

    req = urllib.request.Request(
        FIRECRAWL_API_URL,
        data=payload,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": "application/json",
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=opts.get("timeout", 30000) // 1000 + 5) as resp:
            data = json.loads(resp.read().decode("utf-8"))
            if data.get("success") and data.get("data"):
                return {
                    "status": 200,
                    "body": data["data"].get("markdown", "") or data["data"].get("html", ""),
                    "url": url,
                    "source": "firecrawl",
                }
            return {"error": data.get("error", "Unknown Firecrawl error"), "status": 0, "body": ""}
    except Exception as e:
        return {"error": str(e), "status": 0, "body": ""}

# ── BetExplorer-specific functions ─────────────────────────

def _normalize_team(name):
    n = name.lower().strip()
    n = re.sub(r'^(fc|sc|ac|as|us|ec|cd|ca|cr|gr)\.?\s+', '', n)
    n = re.sub(r'\s+(fc|sc|ac|as|us|cf|cd|ca|ec|united|utd|city)$', '', n)
    return n.strip()

def _teams_match(a, b):
    a_norm = _normalize_team(a)
    b_norm = _normalize_team(b)
    if a_norm == b_norm:
        return True
    if a_norm in b_norm or b_norm in a_norm:
        return True
    a_words = set(w for w in re.split(r'[\s\-]+', a_norm) if len(w) >= 3)
    b_words = set(w for w in re.split(r'[\s\-]+', b_norm) if len(w) >= 3)
    common = a_words & b_words
    if common:
        min_w = min(len(a_words), len(b_words))
        if min_w <= 1:
            return len(common) >= 1
        return len(common) / min_w >= 0.5
    return False

def betexplorer_search(home, away, league=None):
    """Search BetExplorer for a match. Returns 1X2 odds + match URL if found."""
    query = f"{home} {away}"
    if league:
        query += f" {league}"
    search_url = f"https://www.betexplorer.com/?q={query.replace(' ', '+')}"
    
    result = scrape_url(search_url, {"fingerprint": "chrome124", "timeout": 25})
    if "error" in result:
        return {"odds": None, "match_url": None, "match_hash": None, "error": result["error"]}

    body = result.get("body", "")
    odds = parse_betexplorer(body, search_url)

    # Find the correct match URL from data-live-cell="matchlink" anchors
    match_url = None
    match_hash = None

    # Find all match links (hrefs with data-live-cell="matchlink")
    matches_in_html = re.findall(
        r'<a[^>]*href="(/football/[^"]+)"[^>]*data-live-cell="matchlink"[^>]*>.*?</a>',
        body, re.DOTALL | re.IGNORECASE
    )
    
    if not matches_in_html:
        # Fallback: find any match link containing both team name parts
        home_word = home.lower().split()[-1] if home.split() else ""
        away_word = away.lower().split()[-1] if away.split() else ""
        all_links = re.findall(r'href="(/football/[^"]+)"', body)
        for link in all_links:
            if home_word and home_word in link.lower() and away_word and away_word in link.lower():
                match_url = f"https://www.betexplorer.com{link}"
                break

    # Try to find match hash from explicit <a> elements
    if not match_url:
        anchor_block = re.findall(
            r'<a[^>]*href="(/football/[^"]+)"[^>]*>',
            body
        )
        home_parts = home.lower().split()
        away_parts = away.lower().split()
        for href in anchor_block:
            href_lower = href.lower()
            score = 0
            for p in home_parts:
                if len(p) >= 3 and p in href_lower:
                    score += 1
            for p in away_parts:
                if len(p) >= 3 and p in href_lower:
                    score += 1
            if score >= 2 and len(href.split('/')) >= 5:
                match_url = f"https://www.betexplorer.com{href}"
                break

    if match_url:
        m = re.search(r'/([a-zA-Z0-9]+)/?$', match_url.rstrip('/'))
        if m:
            match_hash = m.group(1)

    return {
        "odds": odds if odds else None,
        "match_url": match_url,
        "match_hash": match_hash,
    }

def betexplorer_match_ou(match_url, use_firecrawl=True):
    """Get Over/Under 2.5 odds from a BetExplorer match page.
    ONLY works with Firecrawl (JS execution). curl_cffi returns no static data-odd."""
    ou_url = match_url.rstrip("/") + "/over-under/"
    
    if not use_firecrawl:
        return {"ou25": None, "source": "skipped"}
    
    result = scrape_with_firecrawl(ou_url, {"timeout": 30000})
    if "error" in result or not result.get("body"):
        return {"ou25": None, "source": "failed"}

    body = result.get("body", "")
    ou = {}
    data_odds = re.findall(r'data-odd="([\d.]+)"', body)
    
    if len(data_odds) >= 2:
        ou["over_25"] = float(data_odds[0])
        ou["under_25"] = float(data_odds[1])

    return {"ou25": ou if ou else None, "source": "firecrawl"}

def betexplorer_match_btts(match_url, use_firecrawl=True):
    """Get BTTS odds from a BetExplorer match page.
    ONLY works with Firecrawl (JS execution)."""
    btts_url = match_url.rstrip("/") + "/both-teams-to-score/"
    
    if not use_firecrawl:
        return {"btts": None, "source": "skipped"}
    
    result = scrape_with_firecrawl(btts_url, {"timeout": 30000})
    if "error" in result or not result.get("body"):
        return {"btts": None, "source": "failed"}

    body = result.get("body", "")
    btts = {}
    data_odds = re.findall(r'data-odd="([\d.]+)"', body)
    
    if len(data_odds) >= 2:
        btts["yes"] = float(data_odds[0])
        btts["no"] = float(data_odds[1])

    return {"btts": btts if btts else None, "source": "firecrawl"}

def betexplorer_full(home, away, league=None, use_firecrawl=True):
    """Full BetExplorer pipeline: search → 1X2.
    OU/BTTS ONLY via Firecrawl (JS execution required).
    Returns all available odds."""
    search = betexplorer_search(home, away, league)
    result = {
        "home_win": None,
        "draw": None,
        "away_win": None,
        "over_25": None,
        "under_25": None,
        "btts_yes": None,
        "btts_no": None,
        "source": None,
        "match_url": search.get("match_url"),
        "match_hash": search.get("match_hash"),
    }

    if search.get("odds"):
        result["home_win"] = search["odds"].get("home_win")
        result["draw"] = search["odds"].get("draw")
        result["away_win"] = search["odds"].get("away_win")
        result["source"] = "betexplorer"

    # OU/BTTS ONLY via Firecrawl (JS execution)
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
            result["source"] = "betexplorer+firecrawl"

    return result

# ── ML Monte Carlo OU/BTTS estimation ──────────────────────

def compute_ou_btts_from_xg(xg_h, xg_a):
    """Estimate OU 2.5 and BTTS probabilities from expected goals using Poisson."""
    ou25 = 0.0
    for k in range(0, 6):
        for l in range(0, 6):
            p = (math.exp(-xg_h) * xg_h**k / math.factorial(k)) * (math.exp(-xg_a) * xg_a**l / math.factorial(l))
            if k + l > 2.5:
                ou25 += p
    btts = (1 - math.exp(-xg_h)) * (1 - math.exp(-xg_a))
    return round(ou25 * 100, 1), round(btts * 100, 1)

def estimate_ou_btts_ml(home, away, league=None):
    """Fallback ML estimation for OU/BTTS when no real odds available."""
    try:
        sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'core'))
        from ml_features import get_team_history
        h_hist = get_team_history(home, limit=10)
        a_hist = get_team_history(away, limit=10)
    except Exception:
        h_hist, a_hist = [], []

    xg_h, xg_a = 1.2, 1.0
    if h_hist and a_hist:
        try:
            h_xg = sum(float(m.get('expected_goals', m.get('xg', 1.2))) for m in h_hist) / len(h_hist)
            a_xg = sum(float(m.get('expected_goals', m.get('xg', 1.0))) for m in a_hist) / len(a_hist)
            xg_h = max(0.3, h_xg)
            xg_a = max(0.3, a_xg)
        except Exception:
            pass

    ou25_pct, btts_pct = compute_ou_btts_from_xg(xg_h, xg_a)
    return {
        "over_25_prob": ou25_pct,
        "under_25_prob": round(100 - ou25_pct, 1),
        "btts_yes_prob": btts_pct,
        "btts_no_prob": round(100 - btts_pct, 1),
        "source": "ml_estimate",
    }

# ── CLI entry point ────────────────────────────────────────

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
        if "error" in scrape_result:
            print(json.dumps({"error": scrape_result["error"], "odds": None}))
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
        result = betexplorer_full(home, away, league, use_firecrawl=use_fc)
        print(json.dumps(result, ensure_ascii=False))
    elif cmd == "betexplorer_search":
        home = input_data.get("home", "")
        away = input_data.get("away", "")
        league = input_data.get("league", "")
        result = betexplorer_search(home, away, league)
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
