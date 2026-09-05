"""
flashscoreClient.py — Flashscore internal feed API via curl_cffi.

Protocole documente :
  https://github.com/simbirsky/flashscore-football-parser
  https://gist.github.com/StephanShopov/d7a8e07eeea667d45d8484ee20c6449f

Endpoints (tous HEADLESS, gratuits, sans cle) :
  www.flashscore.com/46/x/feed/df_st_1_{matchId}   → stats (xG, corners, shots, HT) — EN
  www.flashscore.com/46/x/feed/df_sui_1_{matchId}  → incidents (buts, cartes) — EN
  www.flashscore.com/46/x/feed/f_1_-1_3_{x}        → fixtures du jour (TOUTES ligues, anglais)

  Cotes (1X2 avec valeur d'ouverture + sens d'evolution, par bookmaker) :
  global.ds.lsapp.eu/odds/pq_graphql?_hash=pobtm&eventId={id}&projectId=2   → liste bookmakers
  global.ds.lsapp.eu/odds/pq_graphql?_hash=ope2&eventId={id}&bookmakerId={b}&betType=HOME_DRAW_AWAY&betScope=FULL_TIME
    → { home: {value, opening, change}, draw: {...}, away: {...} }

  NOTE : l'ancien host `d.flashscore.com` (sans le chemin `/46/`) repond `0` ;
  le prefixe `/46/` (projectId) est REQUIS, y compris sur le domaine www.

Format feeds : rows separees par ¬, champs par ÷, groupes de rows par ~.
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

FEED_BASES = [
    "https://www.flashscore.com/46/x/feed",        # anglais, projectId 46
    "https://local-ruua.flashscore.ninja/46/x/feed",  # fallback (RU)
    "https://d.flashscore.ru.com/46/x/feed",       # fallback 2
]
FEED_BASE = FEED_BASES[0]

ODDS_GQL_BASE = "https://global.ds.lsapp.eu/odds/pq_graphql"
GEO_IP_CODE = os.environ.get("FLASHSCORE_GEO_IP", "TN")
GEO_SUBDIV = os.environ.get("FLASHSCORE_GEO_SUBDIV", "TN11")

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
    """Generic feed fetch with curl_cffi + X-Fsign, falling back across FEED_BASES."""
    key = f"feed:{path}"
    if match_id and match_id in _not_found_cache:
        logger.debug(f"[FLASHSCORE] Skipping known-not-found {match_id}")
        return None

    _rate_limited_request()

    headers = dict(DEFAULT_HEADERS)

    if not HAS_CURL_CFFI:
        import requests
        for base in FEED_BASES:
            url = f"{base}{path}"
            try:
                resp = requests.get(url, headers=headers, timeout=timeout)
                if resp.status_code == 401:
                    raise Exception("401 Unauthorized — X-Fsign may have rotated")
                if resp.status_code == 200:
                    return resp.text
            except Exception as e:
                logger.error(f"[FLASHSCORE] fetch failed: {e}")
        return None

    errors = []
    for base in FEED_BASES:
        url = f"{base}{path}"
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

    logger.error(f"[FLASHSCORE] All feeds failed for {path}: {errors}")
    if match_id:
        _not_found_cache[match_id] = int(time.time() * 1000)
        _save_not_found(_not_found_cache)
    return None


def _headless_get_json(url, timeout=15):
    """GET JSON via curl_cffi (persisted-query GraphQL needs no body/cookies)."""
    _rate_limited_request()
    headers = dict(DEFAULT_HEADERS)
    headers["Accept"] = "application/json"

    if not HAS_CURL_CFFI:
        import requests
        try:
            resp = requests.get(url, headers=headers, timeout=timeout)
            if resp.status_code == 200:
                return resp.json()
            logger.warning(f"[FLASHSCORE] gql HTTP {resp.status_code} for {url[:80]}")
        except Exception as e:
            logger.error(f"[FLASHSCORE] gql fetch failed: {e}")
        return None

    for fp in [BrowserType.chrome124, BrowserType.chrome120]:
        try:
            resp = curl_requests.get(url, headers=headers, impersonate=fp, timeout=timeout)
            if resp.status_code == 200:
                return resp.json()
            logger.warning(f"[FLASHSCORE] gql HTTP {resp.status_code} for {url[:80]}")
        except Exception as e:
            logger.debug(f"[FLASHSCORE] gql {fp} error: {e}")
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
    raw = _fetch_feed(f"/df_st_1_{match_id}", match_id=match_id)
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

    # Map des clés Flashscore vers nos clés (peu importe la langue : les 2 libellés sont couverts)
    KEY_MAP = {
        "xG": "xg_home", "xGAlt": "xg_away",
        "Corners": "corners_home", "CornersAlt": "corners_away",
        "Corner kicks": "corners_home", "Corner kicksAlt": "corners_away",
        "Shots": "shots_home", "ShotsAlt": "shots_away",
        "Total shots": "shots_home", "Total shotsAlt": "shots_away",
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
    raw = _fetch_feed(f"/df_sui_1_{match_id}", match_id=match_id)
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


def _parse_fixtures_feed(raw, fallback_league=None):
    """Parse one fixtures feed response into a list of {id, home, away, league, start}."""
    matches = []
    current = {}
    league = fallback_league
    for chunk in raw.split("~"):
        fields = {}
        for part in chunk.strip().split("\u00ac"):
            part = part.strip()
            if not part:
                continue
            if "\u00f7" in part:
                k, v = part.split("\u00f7", 1)
                fields[k.strip()] = v
        if "AA" in fields:
            if current.get("id"):
                matches.append(current)
            current = {
                "id": fields["AA"],
                "home": fields.get("AE", ""),
                "away": fields.get("AF", ""),
                "league": league,
                "start": fields.get("AD"),
            }
        elif "ZA" in fields:
            league = fields["ZA"]
        elif current.get("id"):
            for k, v in fields.items():
                current.setdefault(k, v)
    if current.get("id"):
        matches.append(current)
    return matches


# Le feed journalier est éclaté sur plusieurs suffixes : `3` correspond au
# créneau principal mais omet les matchs programmés tard le soir (ex. Serie B
# brésilienne à ~21h30 UTC présents dans le suffixe `2`). On fusionne plusieurs
# créneaux pour maximiser la couverture (les matchs du jour ET la fenêtre qui
# chevauche le lendemain). Dédupe par id.
DAY_FIXTURES_SUFFIXES = (2, 3, 0, 1, 4)


def get_today_fixtures():
    """Return today's football fixtures (global feed, English names).

    Feed shape (rows separated by ~, fields by ¬/÷) :
      ZA÷Country: League            → league header
      AA÷{matchId}¬AD÷{unix_start}¬AE÷Home¬AF÷Away¬...
    """
    merged = {}
    for day in DAY_FIXTURES_SUFFIXES:
        raw = _fetch_feed(f"/f_1_-1_{day}_en_2")
        if not raw:
            continue
        for m in _parse_fixtures_feed(raw):
            merged[m["id"]] = m

    matches = list(merged.values())
    logger.info(f"[FLASHSCORE] {len(matches)} fixtures (suffixes {list(DAY_FIXTURES_SUFFIXES)})")
    return matches


def get_bookmakers(match_id):
    """Return available bookmakers (id+name) for a match."""
    env_ids = os.environ.get("FLASHSCORE_BOOKMAKER_IDS", "").strip()
    if env_ids:
        return [{"id": int(t), "name": "env"} for t in env_ids.split(",") if t.strip().isdigit()]
    url = (f"{ODDS_GQL_BASE}?_hash=pobtm&eventId={match_id}&projectId=2"
           f"&geoIpCode={GEO_IP_CODE}&geoIpSubdivisionCode={GEO_SUBDIV}")
    data = _headless_get_json(url)
    if not data:
        return []
    menu = (data.get("data") or {}).get("getPrematchOddsBettingTypeMenu") or {}
    out = []
    for bm in ((menu.get("settings") or {}).get("bookmakers") or []):
        b = bm.get("bookmaker") or {}
        if b.get("id"):
            out.append({"id": b["id"], "name": b.get("name", "")})
    return out


def _odds_item(x):
    """Normalise un EventOddsOverviewItem (value/opening/active)."""
    if not x:
        return None
    try:
        opening = x.get("opening")
        return {
            "value": float(x.get("value")),
            "opening": float(opening) if opening else None,
            "active": bool(x.get("active", True)),
            "change": (x.get("change") or {}).get("type"),
        }
    except Exception:
        return None


def _pick(item, key):
    return (item or {}).get(key)


def _parse_market_entry(bet_type, entry):
    """Normalise une entree findPrematchOddsForBookmaker pour un betType.

    Les 6 betType supportes par la persisted query `ope2` (betType = variable) :
      HOME_DRAW_AWAY      → home/draw/away
      DOUBLE_CHANCE       → homeOrDraw/awayOrDraw/noDraw
      BOTH_TEAMS_TO_SCORE → yes/no
      OVER_UNDER          → opportunities[] {handicap.value=line, over, under}
      ASIAN_HANDICAP      → opportunities[] {handicap.value=line, home, away}
      CORRECT_SCORE       → items[] {score, item.value}
    Les autres (corners, HT, HT/FT, DNB, totals équipe...) → HTTP 400 → ignorés.
    """
    if bet_type == "HOME_DRAW_AWAY":
        home, draw, away = (_odds_item(entry.get("home")), _odds_item(entry.get("draw")),
                            _odds_item(entry.get("away")))
        if not (home or draw or away):
            return None
        return {
            "home": _pick(home, "value"), "draw": _pick(draw, "value"), "away": _pick(away, "value"),
            "opening": {"home": _pick(home, "opening"), "draw": _pick(draw, "opening"), "away": _pick(away, "opening")},
            "active": {"home": _pick(home, "active"), "draw": _pick(draw, "active"), "away": _pick(away, "active")},
            "change": {"home": _pick(home, "change"), "draw": _pick(draw, "change"), "away": _pick(away, "change")},
        }
    if bet_type == "DOUBLE_CHANCE":
        hood, aod, nd = (_odds_item(entry.get("homeOrDraw")), _odds_item(entry.get("awayOrDraw")),
                         _odds_item(entry.get("noDraw")))
        if not (hood or aod or nd):
            return None
        return {
            "homeOrDraw": _pick(hood, "value"), "awayOrDraw": _pick(aod, "value"), "noDraw": _pick(nd, "value"),
            "active": {"homeOrDraw": _pick(hood, "active"), "awayOrDraw": _pick(aod, "active"), "noDraw": _pick(nd, "active")},
        }
    if bet_type == "BOTH_TEAMS_TO_SCORE":
        yes, no = _odds_item(entry.get("yes")), _odds_item(entry.get("no"))
        if not (yes or no):
            return None
        return {"yes": _pick(yes, "value"), "no": _pick(no, "value"),
                "active": {"yes": _pick(yes, "active"), "no": _pick(no, "active")}}
    if bet_type in ("OVER_UNDER", "ASIAN_HANDICAP"):
        opp = entry.get("opportunities") or []
        lines = []
        for o in opp:
            line = ((o.get("handicap") or {}).get("value"))
            if line is None:
                continue
            try:
                line = float(str(line).replace(",", "."))
            except Exception:
                continue
            if bet_type == "OVER_UNDER":
                over, under = _odds_item(o.get("over")), _odds_item(o.get("under"))
                lines.append({
                    "line": line,
                    "over": _pick(over, "value"), "under": _pick(under, "value"),
                    "active_over": _pick(over, "active"), "active_under": _pick(under, "active"),
                    "change": {"over": _pick(over, "change"), "under": _pick(under, "change")},
                })
            else:
                home, away = _odds_item(o.get("home")), _odds_item(o.get("away"))
                lines.append({
                    "line": line,
                    "home": _pick(home, "value"), "away": _pick(away, "value"),
                    "active_home": _pick(home, "active"), "active_away": _pick(away, "active"),
                })
        return lines or None
    if bet_type == "CORRECT_SCORE":
        items = entry.get("items") or []
        out = []
        for it in items:
            odds = _pick(_odds_item(it.get("item")), "value")
            if odds:
                out.append({"score": it.get("score"), "odds": odds})
        return out or None
    return None


MARKET_BET_TYPES = [
    "HOME_DRAW_AWAY", "DOUBLE_CHANCE", "BOTH_TEAMS_TO_SCORE", "OVER_UNDER",
    "ASIAN_HANDICAP", "CORRECT_SCORE",
]


def get_match_markets(match_id, bet_types=None, bookmaker_ids=None):
    """Cotes multi-marchés pour un match Flashscore (bet365 puis 1xBet...).

    Agrège les marchés disponibles par betType (voir MARKET_BET_TYPES) sur le
    premier bookmaker qui les fournit : 1X2, Double Chance, BTTS, O/U (toutes
    lignes), Asian Handicap (toutes lignes), Score Exact (optionnel). Les
    marchés absents (corners, HT...) renvoient 400 côté Flashscore → ignorés.

    Hooks env (backfill en masse) :
      FLASHSCORE_BOOKMAKER_IDS='16'      → saute l'appel menu bookmakers
      FLASHSCORE_MARKET_TYPES='OVER_UNDER,BOTH_TEAMS_TO_SCORE' → limite les marchés

    Retourne {bookmakerId, scrapedAt, <betType>: <parsed>} ou None si rien.
    """
    if bet_types is None:
        bet_types = list(MARKET_BET_TYPES)
    env_types = os.environ.get("FLASHSCORE_MARKET_TYPES", "").strip()
    if env_types:
        allowed = [t.strip() for t in env_types.split(",") if t.strip()]
        bet_types = [t for t in bet_types if t in allowed]
    if not bookmaker_ids:
        bookmaker_ids = [b["id"] for b in get_bookmakers(match_id)]
    if not bookmaker_ids:
        return None

    collected = {}
    bookmaker_id = None
    for bt in bet_types:
        for bm_id in bookmaker_ids:
            if bt in collected:
                break
            url = (f"{ODDS_GQL_BASE}?_hash=ope2&eventId={match_id}"
                   f"&bookmakerId={bm_id}&betType={bt}&betScope=FULL_TIME")
            data = _headless_get_json(url)
            if not data:
                continue
            entry = (data.get("data") or {}).get("findPrematchOddsForBookmaker")
            if not entry:
                continue
            parsed = _parse_market_entry(bt, entry)
            if parsed is not None:
                collected[bt] = parsed
                bookmaker_id = entry.get("bookmakerId", bm_id)
        if bt not in collected:
            logger.info(f"[FLASHSCORE] Market {bt} not available for {match_id}")

    if not collected:
        return None
    collected["bookmakerId"] = bookmaker_id
    collected["scrapedAt"] = int(time.time() * 1000)
    logger.info(f"[FLASHSCORE] Markets {match_id}: {list(collected.keys())}")
    return collected


def get_match_odds(match_id, bookmaker_ids=None):
    """Best 1X2 odds (bet365 puis 1xBet...) : home/draw/away + opening + drift.

    Retourne le premier bookmaker disposant de cotes, sinon None.
    """
    if not bookmaker_ids:
        bookmaker_ids = [b["id"] for b in get_bookmakers(match_id)]
    if not bookmaker_ids:
        return None

    for bm_id in bookmaker_ids:
        url = (f"{ODDS_GQL_BASE}?_hash=ope2&eventId={match_id}"
               f"&bookmakerId={bm_id}&betType=HOME_DRAW_AWAY&betScope=FULL_TIME")
        data = _headless_get_json(url)
        if not data:
            continue
        entry = (data.get("data") or {}).get("findPrematchOddsForBookmaker")
        if not entry:
            continue
        home, draw, away = _odds_item(entry.get("home")), _odds_item(entry.get("draw")), _odds_item(entry.get("away"))
        if not home and not draw and not away:
            continue
        logger.info(f"[FLASHSCORE] Odds {match_id} (bookmaker {entry.get('bookmakerId', bm_id)}): "
                    f"H={_pick(home, 'value')} D={_pick(draw, 'value')} A={_pick(away, 'value')}")
        return {
            "bookmakerId": entry.get("bookmakerId", bm_id),
            "type": entry.get("type"),
            "home": _pick(home, "value"),
            "draw": _pick(draw, "value"),
            "away": _pick(away, "value"),
            "opening": {
                "home": _pick(home, "opening"),
                "draw": _pick(draw, "opening"),
                "away": _pick(away, "opening"),
            },
            "active": {
                "home": _pick(home, "active"),
                "draw": _pick(draw, "active"),
                "away": _pick(away, "active"),
            },
            "change": {
                "home": _pick(home, "change"),
                "draw": _pick(draw, "change"),
                "away": _pick(away, "change"),
            },
            "scrapedAt": int(time.time() * 1000),
        }
    return None


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
        elif fn == 'get_today_fixtures':
            result = get_today_fixtures()
        elif fn == 'get_bookmakers':
            result = get_bookmakers(args.get('match_id', ''))
        elif fn == 'get_match_odds':
            result = get_match_odds(args.get('match_id', ''), args.get('bookmaker_ids'))
        elif fn == 'get_match_markets':
            result = get_match_markets(args.get('match_id', ''), args.get('bet_types'), args.get('bookmaker_ids'))
        else:
            result = {"error": f"Unknown function: {fn}"}
    except Exception as e:
        result = {"error": str(e)}
    print(json.dumps(result, ensure_ascii=False))
