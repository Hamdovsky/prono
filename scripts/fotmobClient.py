"""
fotmobClient.py — FotMob API via curl_cffi + __NEXT_DATA__ fallback.

Sources :
  https://github.com/pseudo-r/Public-FotMob-API  (community audit 2026-03)
  https://github.com/0xjuanma/golazo                   (golazo Go — page __NEXT_DATA__ approach)

Endpoints verifies :
  GET /api/matches?date=YYYYMMDD           → all matches (fixtures + scores)
  GET /api/data/match-score?matchId={id}    → lightweight live score (verified 2026-03)
  GET /match/{matchId}                      → page HTML with __NEXT_DATA__ (fallback)

Anti-ban :
  - curl_cffi TLS chrome impersonation
  - Rate limiting : 1 req / 2s minimum
  - Negative cache on unknown/404 matchIds (1h)
"""

import os
import re
import time
import json
import logging
from pathlib import Path

logger = logging.getLogger("FotMobClient")

BASE_DIR = Path(__file__).resolve().parent.parent
CACHE_DIR = BASE_DIR / "data"
CACHE_DIR.mkdir(exist_ok=True)

NOT_FOUND_CACHE_FILE = CACHE_DIR / "fotmob_not_found.json"
NOT_FOUND_TTL_MS = int(os.environ.get("FOTMOB_NOT_FOUND_TTL_MS", "3600000"))  # 1h

try:
    from curl_cffi import requests as curl_requests
    from curl_cffi.requests import BrowserType
    HAS_CURL_CFFI = True
except Exception:
    curl_requests = None
    HAS_CURL_CFFI = False
    BrowserType = None

DEFAULT_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.fotmob.com/",
}

FEED_BASE = "https://www.fotmob.com"
REQUEST_DELAY = 2.0  # seconds

_not_found_cache = {}
_last_request_time = 0.0


def _load_not_found():
    global _not_found_cache
    try:
        if NOT_FOUND_CACHE_FILE.exists():
            raw = NOT_FOUND_CACHE_FILE.read_text("utf8")
            data = {}
            now = time.time() * 1000
            for k, v in json.loads(raw).items():
                if now - v < NOT_FOUND_TTL_MS:
                    data[k] = v
            _not_found_cache = data
    except Exception:
        pass


def _save_not_found():
    try:
        NOT_FOUND_CACHE_FILE.write_text(json.dumps(_not_found_cache), "utf8")
    except Exception:
        pass


_load_not_found()


def _rate_limited_request():
    global _last_request_time
    elapsed = time.time() - _last_request_time
    if elapsed < REQUEST_DELAY:
        time.sleep(REQUEST_DELAY - elapsed)
    _last_request_time = time.time()


def _is_not_found(match_id):
    return str(match_id) in _not_found_cache


def _mark_not_found(match_id):
    _not_found_cache[str(match_id)] = int(time.time() * 1000)
    _save_not_found()


def _http_get(url, match_id=None, timeout=15):
    if match_id and _is_not_found(match_id):
        logger.debug(f"[FOTMOB] Skipping known-not-found {match_id}")
        return None

    _rate_limited_request()

    if not HAS_CURL_CFFI:
        import requests as std_requests
        try:
            resp = std_requests.get(url, headers=DEFAULT_HEADERS, timeout=timeout)
            if resp.status_code == 404:
                if match_id:
                    _mark_not_found(match_id)
                return None
            return resp.json() if resp.status_code == 200 else None
        except Exception as e:
            logger.error(f"[FOTMOB] std_requests failed: {e}")
            return None

    errors = []
    for fp in [BrowserType.chrome124, BrowserType.chrome120, BrowserType.chrome116]:
        try:
            resp = curl_requests.get(url, headers=DEFAULT_HEADERS, impersonate=fp, timeout=timeout)
            if resp.status_code == 404:
                if match_id:
                    _mark_not_found(match_id)
                return None
            if resp.status_code != 200:
                errors.append(f"HTTP {resp.status_code}")
                continue
            return resp.json()
        except Exception as e:
            errors.append(f"{fp}: {e}")

    logger.error(f"[FOTMOB] All fingerprints failed for {url}: {errors}")
    return None


def get_matches_by_date(date_str):
    """
    Fetch all matches for a date.
    date_str: YYYYMMDD
    Returns list of match objects with id, homeTeam, awayTeam, league, status, score.
    """
    url = f"{FEED_BASE}/api/matches?date={date_str}"
    data = _http_get(url)
    if not data:
        return []

    matches = []
    for league in (data.get("leagues") or []):
        league_name = league.get("leagueName", "") or ""
        for match in (league.get("matches") or []):
            home_obj = match.get("home") or {}
            away_obj = match.get("away") or {}
            matches.append({
                "id": str(match.get("id", "")),
                "home": home_obj.get("name", ""),
                "away": away_obj.get("name", ""),
                "league": league_name,
                "status": match.get("status", ""),
                "home_score": (match.get("homeScore") or {}).get("full"),
                "away_score": (match.get("awayScore") or {}).get("full"),
            })
    logger.info(f"[FOTMOB] get_matches_by_date({date_str}): {len(matches)} matches")
    return matches


def get_match_score(match_id):
    """
    Fetch lightweight live score for a match (verified endpoint).
    Returns dict with status, home/away name, score, period.
    """
    url = f"{FEED_BASE}/api/data/match-score?matchId={match_id}"
    data = _http_get(url, match_id=match_id)
    if not data:
        return None

    m = data.get("match") if data else None
    if not m:
        return None
    return {
        "id": str(m.get("id", "")),
        "status": m.get("status", ""),
        "home_team": m.get("home", {}).get("name", ""),
        "away_team": m.get("away", {}).get("name", ""),
        "home_score": m.get("home", {}).get("score", None),
        "away_score": m.get("away", {}).get("score", None),
    }


def _parse_next_data_page(match_id):
    """
    Fallback: fetch the HTML page and extract __NEXT_DATA__ JSON.
    Provides full match details including xG, stats, lineups when API is down.
    """
    url = f"{FEED_BASE}/match/{match_id}"
    _rate_limited_request()

    if not HAS_CURL_CFFI:
        import requests
        try:
            resp = requests.get(url, headers=DEFAULT_HEADERS, timeout=20)
            if resp.status_code != 200:
                return None
            text = resp.text
        except Exception as e:
            logger.error(f"[FOTMOB] page fetch failed: {e}")
            return None
    else:
        errors = []
        for fp in [BrowserType.chrome124, BrowserType.chrome120]:
            try:
                resp = curl_requests.get(url, headers=DEFAULT_HEADERS, impersonate=fp, timeout=20)
                if resp.status_code != 200:
                    errors.append(f"HTTP {resp.status_code}")
                    continue
                text = resp.text
                break
            except Exception as e:
                errors.append(f"{fp}: {e}")
        else:
            logger.error(f"[FOTMOB] page fetch failed for {match_id}: {errors}")
            return None

    # Extract __NEXT_DATA__ JSON from HTML
    m = re.search(r'<script id="__NEXT_DATA__"[^>]*>(.*?)</script>', text, re.DOTALL)
    if not m:
        logger.debug(f"[FOTMOB] No __NEXT_DATA__ in page for {match_id}")
        return None
    try:
        nd = json.loads(m.group(1))
        return nd
    except Exception as e:
        logger.error(f"[FOTMOB] Failed to parse __NEXT_DATA__: {e}")
        return None


def get_match_details(match_id):
    """
    Full match details: xG, HT score, corners, shots, lineups.
    Strategy:
      1. Try /api/matchDetails?matchId= (may 404)
      2. Fallback: parse __NEXT_DATA__ from HTML page
    Returns dict with xg_home, xg_away, ht_score_home, ht_score_away,
    corners_home, corners_away, shots_home, shots_away, etc.
    """
    # Strategy 1: try API
    url = f"{FEED_BASE}/api/matchDetails?matchId={match_id}"
    data = _http_get(url, match_id=match_id)

    # Strategy 2: parse page __NEXT_DATA__ if API failed
    if not data:
        nd = _parse_next_data_page(match_id)
        if nd:
            data = _extract_from_next_data(nd)

    if not data:
        return None

    return {
        "xg_home": data.get("xg_home"),
        "xg_away": data.get("xg_away"),
        "ht_score_home": data.get("ht_score_home"),
        "ht_score_away": data.get("ht_score_away"),
        "corners_home": data.get("corners_home"),
        "corners_away": data.get("corners_away"),
        "shots_home": data.get("shots_home"),
        "shots_away": data.get("shots_away"),
        "possession_home": data.get("possession_home"),
        "possession_away": data.get("possession_away"),
        "yellow_cards_home": data.get("yellow_cards_home"),
        "yellow_cards_away": data.get("yellow_cards_away"),
        "lineup_home": data.get("lineup_home"),
        "lineup_away": data.get("lineup_away"),
    }


def _extract_from_next_data(nd):
    """Parse FotMob __NEXT_DATA__ structure into normalized stats dict."""
    try:
        props = (nd.get("props") or {}).get("pageProps") or {}
        match_stats = props.get("matchStats") or {}
        content = match_stats.get("content") or {}

        # xG from stats
        xg_home = xg_away = None
        for stat_section in content.get("stats", []):
            for item in stat_section.get("stats", []):
                if item.get("title", "").lower() in ("expected goals", "xg"):
                    xg_home = _safe_float(item.get("home"))
                    xg_away = _safe_float(item.get("away"))

        # HT score from matchInfo
        match_info = props.get("matchInfo", {})
        ht_h = match_info.get("halfTimeScore", {}).get("home")
        ht_a = match_info.get("halfTimeScore", {}).get("away")

        # Corners/shots/possession from stats sections
        corners_h = corners_a = None
        shots_h = shots_a = None
        poss_h = poss_a = None
        for stat_section in content.get("stats", []):
            ttl = stat_section.get("title", "").lower()
            if "corner" in ttl:
                for item in stat_section.get("stats", []):
                    if "corners" in item.get("title", "").lower():
                        corners_h = _safe_int(item.get("home"))
                        corners_a = _safe_int(item.get("away"))
            elif "shot" in ttl and "on target" not in ttl:
                for item in stat_section.get("stats", []):
                    if "total" in item.get("title", "").lower() or "shots" in item.get("title", "").lower():
                        shots_h = _safe_int(item.get("home"))
                        shots_a = _safe_int(item.get("away"))
            elif "possession" in ttl:
                for item in stat_section.get("stats", []):
                    if "possession" in item.get("title", "").lower():
                        poss_h = _safe_int(item.get("home"))
                        poss_a = _safe_int(item.get("away"))

        # Lineups
        lu = props.get("lineup", {})
        lineup_home = [p.get("name") for p in lu.get("home", {}).get("players", [])]
        lineup_away = [p.get("name") for p in lu.get("away", {}).get("players", [])]

        return {
            "xg_home": xg_home,
            "xg_away": xg_away,
            "ht_score_home": _safe_int(ht_h),
            "ht_score_away": _safe_int(ht_a),
            "corners_home": corners_h,
            "corners_away": corners_a,
            "shots_home": shots_h,
            "shots_away": shots_a,
            "possession_home": poss_h,
            "possession_away": poss_a,
            "lineup_home": lineup_home,
            "lineup_away": lineup_away,
        }
    except Exception as e:
        logger.error(f"[FOTMOB] _extract_from_next_data error: {e}")
        return None


def _safe_float(v):
    try:
        return float(str(v).replace(",", ".")) if v not in (None, "") else None
    except Exception:
        return None


def _safe_int(v):
    try:
        return int(float(v)) if v not in (None, "") else None
    except Exception:
        return None


if __name__ == '__main__':
    import sys
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: fotmobClient.py <fn> <json-args>"}))
        sys.exit(1)
    fn = sys.argv[1]
    args = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    result = None
    try:
        if fn == 'get_matches_by_date':
            result = get_matches_by_date(args.get('date', ''))
        elif fn == 'get_match_score':
            result = get_match_score(args.get('match_id', ''))
        elif fn == 'get_match_details':
            result = get_match_details(args.get('match_id', ''))
        else:
            result = {"error": f"Unknown function: {fn}"}
    except Exception as e:
        result = {"error": str(e)}
    print(json.dumps(result, ensure_ascii=False))
