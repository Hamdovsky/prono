"""
flashscoreClient.py — Flashscore internal feed API via curl_cffi.

Protocole documente :
  https://github.com/simbirsky/flashscore-football-parser
  https://gist.github.com/StephanShopov/d7a8e07eeea667d45d8484ee20c6449f

Feed endpoints (CDN, pas de Cloudflare) :
  d.flashscore.com/x/feed/df_st_1_{matchId}   → statistiques (xG, corners, shots, HT)
  d.flashscore.com/x/feed/df_sui_1_{matchId}  → incidents (buts, cartes)
  d.flashscore.com/x/feed/f_1_{country}_{div}_{league}  → fixtures

Format : pipe-delimited rows separated by ¬, fields by ÷, groups of rows by ~.
  SF÷libelle_section  (section header)
  SG÷key÷value       (data row)
  SE÷periode         (sub-header, e.g. "1st Half")
  ~                   (row separator)

Anti-ban :
  - curl_cffi TLS chrome impersonation (deja en place dans le venv)
  - X-Fsign header (hard-code SW9D1eZo, rotation lente)
  - Rate limiting : 1 requete / 2s minimum
  - Negative cache sur matchId inconnu
"""

import os
import re
import time
import logging
from pathlib import Path

logger = logging.getLogger("FlashscoreClient")

BASE_DIR = Path(__file__).resolve().parent.parent
CACHE_DIR = BASE_DIR / "data"
CACHE_DIR.mkdir(exist_ok=True)

NOT_FOUND_CACHE_FILE = CACHE_DIR / "flashscore_not_found.json"
NOT_FOUND_TTL_MS = int(os.environ.get("FLASHSCORE_NOT_FOUND_TTL_MS", "3600000"))  # 1h default

FSIGN = os.environ.get("FLASHSCORE_FSIGN", "SW9D1eZo")

FEED_DOMAINS = [
    "d.flashscore.com",
    "d.flashscore.ru.com",
    "local-ruua.flashscore.ninja",
    "local-rtrw.flashscore.ninja",
]
FEED_BASE = f"https://{FEED_DOMAINS[0]}"

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
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.flashscore.com/",
    "X-Fsign": FSIGN,
}

REQUEST_DELAY = 2.0  # seconds between requests


def _load_not_found():
    try:
        if NOT_FOUND_CACHE_FILE.exists():
            raw = NOT_FOUND_CACHE_FILE.read_text("utf8")
            data = {}
            now = time.time() * 1000
            for k, v in __import__("json").loads(raw).items():
                if now - v < NOT_FOUND_TTL_MS:
                    data[k] = v
            return data
    except Exception:
        pass
    return {}


def _save_not_found(cache):
    try:
        NOT_FOUND_CACHE_FILE.write_text(__import__("json").dumps(cache), "utf8")
    except Exception:
        pass


_not_found_cache = _load_not_found()
_last_request_time = 0.0


def _rate_limited_request():
    global _last_request_time
    elapsed = time.time() - _last_request_time
    if elapsed < REQUEST_DELAY:
        time.sleep(REQUEST_DELAY - elapsed)
    _last_request_time = time.time()


def _parse_feed(raw_text):
    """Parse Flashscore pipe-delimited feed into a dict-of-lists structure."""
    if not raw_text or not raw_text.strip():
        return {}
    result = {}
    current_section = None
    current_row = {}
    rows = []

    for line in raw_text.splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split("¬")
        for part in parts:
            if "~" in part:
                if current_row:
                    rows.append(current_row)
                    current_row = {}
                tokens = part.split("~")
                for token in tokens:
                    token = token.strip()
                    if not token:
                        continue
                    segs = token.split("÷")
                    if len(segs) >= 2:
                        key, val = segs[0].strip(), segs[1].strip()
                        current_row[key] = val
                    elif len(segs) == 1 and segs[0]:
                        current_row[segs[0]] = ""
            else:
                segs = part.split("÷")
                if len(segs) >= 2:
                    key, val = segs[0].strip(), segs[1].strip()
                    current_row[key] = val
                elif len(segs) == 1 and segs[0]:
                    current_row[segs[0]] = ""

    if current_row:
        rows.append(current_row)

    for row in rows:
        sec = row.get("SF", "")
        if sec:
            current_section = sec
        if current_section not in result:
            result[current_section] = []
        result[current_section].append(row)

    return result


def _fetch_feed(path, match_id=None, timeout=15):
    """Generic feed fetch with curl_cffi + X-Fsign."""
    key = f"feed:{path}"
    if match_id and match_id in _not_found_cache:
        logger.debug(f"[FLASHSCORE] Skipping known-not-found {match_id}")
        return None

    _rate_limited_request()

    url = f"{FEED_BASE}{path}"
    headers = dict(DEFAULT_HEADERS)

    if not HAS_CURL_CFFI:
        logger.warning("[FLASHSCORE] curl_cffi not available, falling back to requests")
        import requests
        try:
            resp = requests.get(url, headers=headers, timeout=timeout)
            if resp.status_code == 401:
                raise Exception("401 Unauthorized — X-Fsign may have rotated")
            return resp.text
        except Exception as e:
            logger.error(f"[FLASHSCORE] fetch failed: {e}")
            return None

    errors = []
    for fp in [BrowserType.chrome124, BrowserType.chrome120, BrowserType.chrome116]:
        try:
            resp = curl_requests.get(
                url,
                headers=headers,
                impersonate=fp,
                timeout=timeout,
            )
            if resp.status_code == 401:
                errors.append(f"401 with {fp}")
                continue
            if resp.status_code != 200:
                errors.append(f"HTTP {resp.status_code}")
                continue
            return resp.text
        except Exception as e:
            errors.append(f"{fp}: {e}")

    logger.error(f"[FLASHSCORE] All fingerprints failed for {url}: {errors}")
    if match_id:
        _not_found_cache[match_id] = int(time.time() * 1000)
        _save_not_found(_not_found_cache)
    return None


def _safe_float(val, default=None):
    try:
        f = float(val.replace(",", "."))
        return f if f > 0 else default
    except Exception:
        return default


def get_match_stats(match_id):
    """
    Fetch full match statistics from Flashscore feed.
    Returns dict with keys:
      xg_home, xg_away (float)
      corners_home, corners_away (int)
      shots_home, shots_away (int)
      shots_on_target_home, shots_on_target_away (int)
      yellow_cards_home, yellow_cards_away (int)
      red_cards_home, red_cards_away (int)
      halftime_score_home, halftime_score_away (int)
      possession_home, possession_away (int, percent)
      period_scores: [{period, home, away}]
    """
    raw = _fetch_feed(f"/x/feed/df_st_1_{match_id}", match_id=match_id)
    if not raw:
        return None

    data = _parse_feed(raw)
    out = {
        "xg_home": None, "xg_away": None,
        "corners_home": None, "corners_away": None,
        "shots_home": None, "shots_away": None,
        "shots_on_target_home": None, "shots_on_target_away": None,
        "yellow_cards_home": None, "yellow_cards_away": None,
        "red_cards_home": None, "red_cards_away": None,
        "halftime_score_home": None, "halftime_score_away": None,
        "possession_home": None, "possession_away": None,
        "period_scores": [],
    }

    def _assign(key, val):
        if key not in out:
            out[key] = val

    def _pct(val):
        try:
            return int(val.replace("%", ""))
        except Exception:
            return None

    # Map des clés Flashscore vers nos clés
    KEY_MAP = {
        "xG": "xg_home", "xGAlt": "xg_away",
        "Corners": "corners_home", "CornersAlt": "corners_away",
        "Shots": "shots_home", "ShotsAlt": "shots_away",
        "Shots on target": "shots_on_target_home", "Shots on targetAlt": "shots_on_target_away",
        "Yellow cards": "yellow_cards_home", "Yellow cardsAlt": "yellow_cards_away",
        "Red cards": "red_cards_home", "Red cardsAlt": "red_cards_away",
        "Ball possession": "possession_home", "Ball possessionAlt": "possession_away",
    }

    # Collect all rows (SG÷key÷value) by section
    all_rows = []
    for section, rows in data.items():
        for row in rows:
            all_rows.append(row)

    for row in all_rows:
        sg_key = row.get("SG", "")
        sh_val = row.get("SH")
        si_val = row.get("SI")

        if sg_key in KEY_MAP:
            home_key = KEY_MAP[sg_key]
            away_key = home_key.replace("_home", "_away") if "_home" in home_key else None
            if home_key == "possession_home":
                out["possession_home"] = _pct(sh_val)
                out["possession_away"] = _pct(si_val)
            elif home_key == "xg_home":
                out["xg_home"] = _safe_float(sh_val)
                out["xg_away"] = _safe_float(si_val)
            elif "Alt" not in sg_key:
                out[home_key] = _safe_float(sh_val)
                if away_key:
                    out[away_key] = _safe_float(si_val)
        elif sg_key == "Goal" and sh_val and si_val:
            # Detect halftime from SE field
            period = row.get("SE", "FullTime")
            try:
                out["period_scores"].append({
                    "period": period,
                    "home": int(sh_val),
                    "away": int(si_val),
                })
            except Exception:
                pass

    # Identify halftime score (SE = 1st Half or 1.Half)
    for entry in out["period_scores"]:
        p = entry.get("period", "").lower()
        if "half" in p and "second" not in p and "2nd" not in p:
            out["halftime_score_home"] = entry["home"]
            out["halftime_score_away"] = entry["away"]
            break

    logger.info(f"[FLASHSCORE] Stats for {match_id}: xG={out['xg_home']}/{out['xg_away']}, "
                f"Corners={out['corners_home']}/{out['corners_away']}")
    return out


def get_match_incidents(match_id):
    """Fetch match incidents (goals, cards, referee) from Flashscore feed."""
    raw = _fetch_feed(f"/x/feed/df_sui_1_{match_id}", match_id=match_id)
    if not raw:
        return None

    data = _parse_feed(raw)
    incidents = []

    for section, rows in data.items():
        for row in rows:
            sg = row.get("SG", "")
            if sg in ("Goal", "Yellow cards", "Red cards", "Substitution"):
                incidents.append({
                    "type": sg,
                    "time": row.get("IT", row.get("TIME", "")),
                    "player": row.get("NA", ""),
                    "home_score": _safe_float(row.get("SH")),
                    "away_score": _safe_float(row.get("SI")),
                    "period": row.get("SE", ""),
                })

    return incidents


if __name__ == '__main__':
    import sys, json
    if len(sys.argv) < 3:
        print(json.dumps({"error": "Usage: flashscoreClient.py <fn> <json-args>"}))
        sys.exit(1)
    fn = sys.argv[1]
    args = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    result = None
    try:
        if fn == 'get_match_stats':
            result = get_match_stats(args.get('match_id', ''))
        elif fn == 'get_match_incidents':
            result = get_match_incidents(args.get('match_id', ''))
        else:
            result = {"error": f"Unknown function: {fn}"}
    except Exception as e:
        result = {"error": str(e)}
    print(json.dumps(result, ensure_ascii=False))
