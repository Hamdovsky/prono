"""
fotmobClient.py — FotMob API (via curl_cffi + en-tetes app /api/data).

Endpoints reels (2025+, verifies en session) :
  GET /api/data/matches?date=YYYYMMDD        -> toutes les rencontres du jour
  GET /api/data/matchDetails?matchId={id}    -> stats D'EQUIPE (content.stats.Periods)
  GET /api/data/match-score?matchId={id}     -> score leger
NOTE : les anciens /api/matches et /api/matchDetails -> 404 (routes retirees par
FotMob). Sans les en-tetes x-mocks/x-platform sur /api/data/*, FotMob renvoie 404.
Le SCORE de 1re mi-temps vient de livescore (Trh1/Trh2), pas de FotMob.

Anti-ban :
  - curl_cffi TLS chrome impersonation + en-tetes app
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
    "Origin": "https://www.fotmob.com",
    # FotMob (2025+) exige ces en-tetes APP sur /api/data/* ; sans eux -> 404.
    "x-mocks": "true",
    "x-platform": "web",
    "x-timezone": "0",
    "x-device": "desktop",
    "sec-fetch-site": "same-origin",
    "sec-fetch-mode": "cors",
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
    Endpoint (2025+): /api/data/matches?date= (les anciens /api/matches -> 404).
    """
    url = f"{FEED_BASE}/api/data/matches?date={date_str}"
    data = _http_get(url)
    if not data:
        return []

    matches = []
    for league in (data.get("leagues") or []):
        league_name = league.get("name") or league.get("leagueName") or ""
        for match in (league.get("matches") or []):
            home_obj = match.get("home") or {}
            away_obj = match.get("away") or {}
            status_obj = match.get("status") or {}
            matches.append({
                "id": str(match.get("id", "")),
                "home": home_obj.get("name", "") if isinstance(home_obj, dict) else "",
                "away": away_obj.get("name", "") if isinstance(away_obj, dict) else "",
                "league": league_name,
                "status": (status_obj.get("finished") and "FT") or status_obj.get("reason", {}).get("short", "") or status_obj.get("statusType", "") if isinstance(status_obj, dict) else str(status_obj),
                "home_score": home_obj.get("score") if isinstance(home_obj, dict) else None,
                "away_score": away_obj.get("score") if isinstance(away_obj, dict) else None,
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


def _period_items(periods, which="All"):
    """content.stats.Periods[which].stats -> items plats [{key,title,stats:[h,a]}]."""
    blk = (periods or {}).get(which) or {}
    items = []
    for section in blk.get("stats", []) or []:
        for it in section.get("stats", []) or []:
            if isinstance(it, dict) and isinstance(it.get("stats"), (list, tuple)) and len(it["stats"]) >= 2:
                items.append(it)
    return items


def _pick_item(items, *needles):
    """1er item dont key OU title contient une des needles (minuscule)."""
    for it in items:
        k = str(it.get("key", "")).lower()
        t = str(it.get("title", "")).lower()
        for nd in needles:
            n = nd.lower()
            if n in k or n in t:
                return it
    return None


def _ha(it):
    """(home, away) floats depuis item['stats'] = [home, away]."""
    if not it:
        return None, None
    v = it.get("stats")
    try:
        h = float(str(v[0]).replace(",", ".")) if v[0] not in (None, "") else None
        a = float(str(v[1]).replace(",", ".")) if v[1] not in (None, "") else None
    except (ValueError, TypeError, IndexError):
        return None, None
    return h, a


def get_match_details(match_id):
    """
    Stats D'EQUIPE par match via /api/data/matchDetails (les stats joueur sont
    ailleurs; ici on lit content.stats.Periods.{All,FirstHalf}).
    Retourne xg/corners/shots/possession (All) + xg/corners de 1re MT (FirstHalf)
    pour alimenter les modeles O/U, corners et HT. Le SCORE de MT vient de
    livescore (Trh1/Trh2), pas de FotMob -> ht_score_* laisses a None.
    """
    url = f"{FEED_BASE}/api/data/matchDetails?matchId={match_id}"
    data = _http_get(url, match_id=match_id)
    if not data:
        return None
    try:
        periods = ((data.get("content") or {}).get("stats") or {}).get("Periods") or {}
    except AttributeError:
        return None
    if not periods:
        return None

    all_items = _period_items(periods, "All")
    fh_items = _period_items(periods, "FirstHalf")

    xg_h, xg_a = _ha(_pick_item(all_items, "expected_goals", "expected goals", "xg"))
    cor_h, cor_a = _ha(_pick_item(all_items, "corner"))
    shots_h, shots_a = _ha(_pick_item(all_items, "total_shots", "total shots"))
    poss_h, poss_a = _ha(_pick_item(all_items, "possession"))
    sot_h, sot_a = _ha(_pick_item(all_items, "shots_on_target", "shots on target"))
    fh_xg_h, fh_xg_a = _ha(_pick_item(fh_items, "expected_goals", "expected goals", "xg"))
    fh_cor_h, fh_cor_a = _ha(_pick_item(fh_items, "corner"))

    return {
        "xg_home": xg_h, "xg_away": xg_a,
        "corners_home": None if cor_h is None else int(cor_h),
        "corners_away": None if cor_a is None else int(cor_a),
        "shots_home": None if shots_h is None else int(shots_h),
        "shots_away": None if shots_a is None else int(shots_a),
        "shots_on_target_home": None if sot_h is None else int(sot_h),
        "shots_on_target_away": None if sot_a is None else int(sot_a),
        "possession_home": poss_h, "possession_away": poss_a,
        "xg_ht_home": fh_xg_h, "xg_ht_away": fh_xg_a,
        "corners_ht_home": None if fh_cor_h is None else int(fh_cor_h),
        "corners_ht_away": None if fh_cor_a is None else int(fh_cor_a),
        "ht_score_home": None, "ht_score_away": None,  # via livescore, pas FotMob
        "lineup_home": None, "lineup_away": None,
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
        sys.stdout.buffer.write(json.dumps({"error": "Usage: fotmobClient.py <fn> <json-args>"}).encode("utf-8") + b"\n")
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
    # Windows console cp1252 casse sur les noms non-ASCII (Beşiktas, Atletico...) ;
    # ecrire les octets UTF-8 directement evite UnicodeEncodeError (le node parse
    # un JSON valide). Cf. E37.
    sys.stdout.buffer.write(json.dumps(result, ensure_ascii=False).encode("utf-8") + b"\n")
