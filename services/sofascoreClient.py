"""
SofascoreClient — source LIVE primaire 100% gratuite, sans clé API.

Utilise curl_cffi (TLS fingerprint impersonation) pour contourner la
protection Cloudflare de www.sofascore.com. Stratégie anti-ban locale :
  - Session curl_cffi persistante (cookies entre requêtes)
  - Rotation automatique du profil TLS (chrome124 -> safari17_0 -> chrome120)
    si un 403/429 est détecté
  - Délai 1.5s + jitter entre chaque requête

Données exposées (best-effort) :
  - fixtures (scheduled-events) : TOUTES les ligues d'une date
  - cotes 1X2 / Over-Under 2.5 / BTTS / Corners
  - xG + shots (statistics)
  - lineups / absents

Usage:
    from services.sofascoreClient import SofascoreClient
    sc = SofascoreClient()
    events = sc.get_scheduled_events("2026-08-21")
    odds = sc.fetch_match_full(event_id)
"""

import os
import sys
import re
import json
import time
import random
import logging
import unicodedata
from urllib.parse import quote

try:
    from curl_cffi import requests as cffi_requests
except ImportError:
    cffi_requests = None

BASE_DIR = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
DATA_DIR = os.path.join(BASE_DIR, 'data')

logging.basicConfig(level=logging.INFO, format='[SOFASCORE] %(message)s')
log = logging.getLogger('SofascoreClient')

TLS_PROFILES = ["chrome124", "safari17_0", "chrome120"]

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"


class SofascoreClient:
    def __init__(self, enabled=True):
        self.enabled = enabled
        self.session = None
        self._profile_idx = 0
        self._cooldown_until = 0
        self._cooldown_ms = 8 * 60 * 1000
        self._team_id_cache = {}
        self._event_id_cache = {}
        if cffi_requests is None:
            self.enabled = False
            log.warning("curl_cffi non installé -> SofaScore désactivé")
        else:
            self._init_session()

    def _init_session(self):
        self.session = cffi_requests.Session(impersonate=TLS_PROFILES[self._profile_idx])
        self.session.headers.update({
            "accept": "application/json, text/plain, */*",
            "accept-language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
            "cache-control": "max-age=0",
            "referer": "https://www.sofascore.com/",
            "origin": "https://www.sofascore.com",
            "sec-ch-ua": '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"Windows"',
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-origin",
            "user-agent": UA,
        })

    def _rotate_profile(self):
        if cffi_requests is None:
            return
        self._profile_idx = (self._profile_idx + 1) % len(TLS_PROFILES)
        try:
            self.session.impersonate = TLS_PROFILES[self._profile_idx]
            log.info(f"Rotation TLS -> {TLS_PROFILES[self._profile_idx]}")
        except Exception:
            self._init_session()

    def _sleep(self):
        time.sleep(1.5 + random.random() * 1.0)

    def _get(self, url, retries=3):
        if not self.enabled or self.session is None:
            return None
        for attempt in range(retries):
            if time.time() * 1000 < self._cooldown_until:
                wait = (self._cooldown_until - time.time() * 1000) / 1000.0
                log.warning(f"Cooldown actif, attente {wait:.0f}s")
                time.sleep(max(wait, 1))
            try:
                self._sleep()
                r = self.session.get(url, timeout=15)
                if r.status_code == 403 or r.status_code == 429:
                    log.warning(f"Blocage {r.status_code} sur {url} (tentative {attempt+1})")
                    self._cooldown_until = time.time() * 1000 + self._cooldown_ms
                    self._rotate_profile()
                    continue
                if r.status_code != 200:
                    log.warning(f"HTTP {r.status_code} sur {url}")
                    if r.status_code == 404:
                        return None
                    continue
                return r.json()
            except Exception as e:
                log.warning(f"Erreur requête {url}: {e}")
                if attempt == retries - 1:
                    return None
                self._rotate_profile()
        return None

    # ── Fixtures : toutes les ligues d'une date ────────────────

    def get_scheduled_events(self, date_str):
        """Retourne la liste normalisée des matchs de la date (YYYY-MM-DD)."""
        # Sofascore attend un timestamp en millisecondes (début de journée UTC),
        # pas une chaîne de date -> sinon 404.
        try:
            y, m, d = [int(x) for x in date_str.split("-")]
            import datetime
            ts_ms = int(datetime.datetime(y, m, d, 0, 0, 0, tzinfo=datetime.timezone.utc).timestamp() * 1000)
        except Exception:
            ts_ms = date_str
        url = f"https://www.sofascore.com/api/v1/sport/football/scheduled-events/{ts_ms}"
        data = self._get(url)
        if not data:
            return []
        events = data.get("events", []) or []
        out = []
        for ev in events:
            try:
                home = ev.get("homeTeam", {}) or {}
                away = ev.get("awayTeam", {}) or {}
                tour = ev.get("tournament", {}) or {}
                out.append({
                    "id": str(ev.get("id")),
                    "sofascore_id": str(ev.get("id")),
                    "home": home.get("name"),
                    "away": away.get("name"),
                    "home_team": home.get("name"),
                    "away_team": away.get("name"),
                    "league": tour.get("name"),
                    "tournament_name": tour.get("name"),
                    "country": (tour.get("category", {}) or {}).get("name"),
                    "date": ev.get("startDate") or ev.get("startTimestamp"),
                    "start_timestamp": ev.get("startTimestamp"),
                    "status": ev.get("status", {}).get("type"),
                })
            except Exception:
                continue
        return out

    # ── Résolution nom d'équipe -> eventId Sofascore ──────────
    # Le listing par date (/sport/football/scheduled-events/{ts}) est 404 côté
    # SofaScore ; on contourne en résolvant l'ID via search/all -> team -> events,
    # ce qui permet d'enrichir chaque match découvert ailleurs par son eventId.

    def _normalize_team(self, name):
        if not name:
            return ""
        n = unicodedata.normalize("NFD", str(name).lower().strip())
        n = "".join(c for c in n if unicodedata.category(c) != "Mn")
        n = re.sub(r"^(fc|sc|ac|as|us|cd|ca|ec|ifk|bk|ff|ss|nk|fk|sk|rc|ud|ad|cf)\.?\s+", "", n)
        n = re.sub(r"\s+(fc|sc|ac|as|us|cf|cd|ca|ec)\.?\s*$", "", n)
        return n.strip()

    def _team_matches(self, a, b):
        if not a or not b:
            return False
        a, b = self._normalize_team(a), self._normalize_team(b)
        if not a or not b:
            return False
        if a == b or a in b or b in a:
            return True
        wa = {w for w in re.split(r"[\s\-]+", a) if len(w) >= 3}
        wb = {w for w in re.split(r"[\s\-]+", b) if len(w) >= 3}
        return bool(wa and wb and (wa & wb))

    def _search_team_id(self, team_name):
        url = f"https://www.sofascore.com/api/v1/search/all?q={quote(str(team_name))}"
        data = self._get(url)
        if not data:
            return None
        results = data.get("results", []) if isinstance(data, dict) else data
        for e in results:
            if e.get("type") == "team":
                ent = e.get("entity") or {}
                tid = e.get("id") or ent.get("id")
                if tid:
                    return tid
        return None

    def _get_team_events(self, team_id, limit=30):
        out = []
        for seg in ("events/next/0", "events/last/0"):
            url = f"https://www.sofascore.com/api/v1/team/{team_id}/{seg}?limit={limit}"
            data = self._get(url)
            if data and isinstance(data, dict):
                for ev in data.get("events", []) or []:
                    if ev.get("id") not in {e.get("id") for e in out}:
                        out.append(ev)
        return out

    def resolve_event_id(self, home, away=None, date_str=None, max_days=2):
        """Retourne l'eventId Sofascore d'un match à partir des noms d'équipes.

        home seul suffit ; away + date affinent la sélection. Renvoie None si
        introuvable.
        """
        if not home:
            return None
        cache_key = f"{home}|{away}|{date_str}"
        if cache_key in self._event_id_cache:
            return self._event_id_cache[cache_key]

        team_id = self._team_id_cache.get(home)
        if team_id is None:
            team_id = self._search_team_id(home)
            if team_id:
                self._team_id_cache[home] = team_id
        if not team_id:
            self._event_id_cache[cache_key] = None
            return None

        events = self._get_team_events(team_id)
        if not events:
            self._event_id_cache[cache_key] = None
            return None

        date_tuple = None
        if date_str and "-" in date_str:
            try:
                y, m, d = [int(x) for x in date_str.split("-")]
                date_tuple = (m, d)
            except Exception:
                date_tuple = None

        best = None
        for ev in events:
            ht = (ev.get("homeTeam") or {}).get("name")
            at = (ev.get("awayTeam") or {}).get("name")
            if not (ht and at):
                continue
            if away and not (self._team_matches(at, away) or self._team_matches(ht, away)):
                continue
            ts = ev.get("startTimestamp")
            if date_tuple and ts:
                ev_t = time.gmtime(ts)
                em, ed = int(time.strftime("%m", ev_t)), int(time.strftime("%d", ev_t))
                if abs((em * 31 + ed) - (date_tuple[0] * 31 + date_tuple[1])) > max_days:
                    continue
            best = str(ev.get("id"))
            break

        self._event_id_cache[cache_key] = best
        return best

    # ── Cotes 1X2 / OU / BTTS / Corners ───────────────────────

    @staticmethod
    def _frac_to_decimal(fr):
        if fr is None:
            return None
        try:
            return float(fr)
        except (TypeError, ValueError):
            pass
        fr = str(fr)
        if "/" in fr:
            try:
                n, d = fr.split("/")
                return float(n) / float(d) + 1
            except (ValueError, ZeroDivisionError):
                return None
        return None

    @staticmethod
    def _choices_from_markets(payload):
        """Depuis /odds/{id}/all : payload = { markets:[ {marketId, marketName, choices:[{name, fractionalValue/decimalValue}]} ] }."""
        if not payload or not isinstance(payload, dict):
            return {"by_id": {}, "by_name": {}}
        markets = payload.get("markets") or []
        by_id = {}
        by_name = {}
        for mk in markets:
            mid = mk.get("marketId")
            name = str(mk.get("marketName", "") or mk.get("marketGroup", "")).lower()
            choices = []
            for c in mk.get("choices", []) or []:
                cname = str(c.get("name", ""))
                val = SofascoreClient._frac_to_decimal(
                    c.get("decimalValue") if c.get("decimalValue") is not None else c.get("fractionalValue")
                )
                if val and val > 1:
                    choices.append((cname, val))
            if choices:
                if mid is not None:
                    by_id[mid] = choices
                by_name[name] = choices
        return {"by_id": by_id, "by_name": by_name}

    def _fetch_market(self, event_id, market_id):
        url = f"https://www.sofascore.com/api/v1/event/{event_id}/odds/{market_id}/all"
        return self._get(url)

    @staticmethod
    def _pick(choices_map, market_id, *name_seeds):
        if market_id is not None and market_id in choices_map["by_id"]:
            return choices_map["by_id"][market_id]
        for nm, ch in choices_map["by_name"].items():
            for seed in name_seeds:
                if seed in nm:
                    return ch
        return None

    def _fetch_all_odds(self, event_id):
        """Tous les marchés en 1 seul appel (endpoint /odds/1/all renvoie tout)."""
        url = f"https://www.sofascore.com/api/v1/event/{event_id}/odds/1/all"
        return self._get(url)

    def get_odds(self, event_id):
        """Récupère 1X2, Over/Under 2.5, BTTS et Corners (best-effort).

        Un seul appel /odds/1/all renvoie tous les marchés ; on lit 1X2 (marketId 1),
        Match goals (ligne 2.5 pour O/U), Both teams to score (BTTS) et Corners 2-Way
        (best-effort, ligne 9.5 par défaut).
        """
        if not event_id:
            return {}
        res = {
            "home": None, "draw": None, "away": None,
            "over25": None, "under25": None,
            "btts_yes": None, "btts_no": None,
            "corners_over": None, "corners_line": None, "corners_under": None,
        }
        payload = self._fetch_all_odds(event_id)
        if not payload or not isinstance(payload, dict):
            return res
        for m in payload.get("markets", []) or []:
            name = str(m.get("marketName", "") or m.get("marketGroup", "")).lower()
            cg = m.get("choiceGroup")
            try:
                cg = float(cg)
            except (TypeError, ValueError):
                cg = None
            choices = []
            for ch in m.get("choices", []) or []:
                cname = str(ch.get("name", ""))
                val = self._frac_to_decimal(
                    ch.get("decimalValue") if ch.get("decimalValue") is not None else ch.get("fractionalValue")
                )
                if val and val > 1:
                    choices.append((cname, val))
            if not choices:
                continue

            # 1X2
            if m.get("marketId") == 1 or "1x2" in name or name == "full time":
                for cname, val in choices:
                    n = cname.lower()
                    if n in ("1", "home"):
                        res["home"] = val
                    elif n in ("x", "draw"):
                        res["draw"] = val
                    elif n in ("2", "away"):
                        res["away"] = val

            # Over/Under (Match goals) — cible la ligne 2.5
            elif "match goals" in name or "over/under" in name or "total" in name:
                if cg == 2.5:
                    for cname, val in choices:
                        n = cname.lower()
                        if "over" in n:
                            res["over25"] = val
                        elif "under" in n:
                            res["under25"] = val

            # BTTS
            elif "both teams" in name or "btts" in name:
                for cname, val in choices:
                    n = cname.lower()
                    if n == "yes":
                        res["btts_yes"] = val
                    elif n == "no":
                        res["btts_no"] = val

            # Corners (best-effort, ligne 9.5 par défaut)
            elif "corner" in name:
                if cg == 9.5 or (res["corners_over"] is None and cg is not None):
                    for cname, val in choices:
                        n = cname.lower()
                        if "over" in n:
                            res["corners_over"] = val
                            res["corners_line"] = cg
                        elif "under" in n:
                            res["corners_under"] = val
                            res["corners_line"] = cg
        return res

    # ── Statistiques live : xG + shots ────────────────────────

    def get_statistics(self, event_id):
        if not event_id:
            return {}
        url = f"https://www.sofascore.com/api/v1/event/{event_id}/statistics"
        data = self._get(url)
        if not data or not data.get("statistics"):
            return {}
        xg_h = xg_a = shots_h = shots_a = None
        for period in data.get("statistics", []):
            for group in period.get("groups", []) or []:
                for item in group.get("statisticsItems", []) or []:
                    name = str(item.get("name", "")).lower()
                    if ("expected goals" in name or name == "xg") and xg_h is None:
                        try:
                            xg_h = float(item.get("home"))
                            xg_a = float(item.get("away"))
                        except (TypeError, ValueError):
                            pass
                    if "shots" in name and shots_h is None and "on" not in name:
                        try:
                            shots_h = float(item.get("home"))
                            shots_a = float(item.get("away"))
                        except (TypeError, ValueError):
                            pass
            if xg_h is not None and shots_h is not None:
                break
        out = {}
        if xg_h is not None or xg_a is not None:
            out["home_xg"] = xg_h
            out["away_xg"] = xg_a
        if shots_h is not None or shots_a is not None:
            out["shots_h"] = shots_h
            out["shots_a"] = shots_a
        return out

    # ── Lineups / absents ─────────────────────────────────────

    def get_lineups(self, event_id):
        if not event_id:
            return None
        url = f"https://www.sofascore.com/api/v1/event/{event_id}/lineups"
        data = self._get(url)
        if not data:
            return None
        return data

    # ── Combinaison complète pour un match ────────────────────

    def fetch_match_full(self, event_id):
        odds = self.get_odds(event_id)
        stats = self.get_statistics(event_id)
        combined = dict(odds)
        combined.update(stats)
        combined["source"] = "sofascore"
        combined["scraped_at"] = int(time.time() * 1000)
        return combined

    # ── Fetch stateless (pour parallélisation) ────────────────
    # Chaque thread instancie SA propre Session curl_cffi (le Session
    # n'est pas thread-safe) avec un profil TLS dédié -> rotation TLS
    # préservée par thread, sans partage d'état avec le client principal.

    @staticmethod
    def _raw_get(url, profile):
        """Requête curl_cffi stateless avec un profil TLS donné."""
        if cffi_requests is None:
            return None
        s = cffi_requests.Session(impersonate=profile)
        s.headers.update({
            "accept": "application/json, text/plain, */*",
            "accept-language": "fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7",
            "cache-control": "max-age=0",
            "referer": "https://www.sofascore.com/",
            "origin": "https://www.sofascore.com",
            "sec-ch-ua": '"Not/A)Brand";v="8", "Chromium";v="126", "Google Chrome";v="126"',
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": '"Windows"',
            "sec-fetch-dest": "empty",
            "sec-fetch-mode": "cors",
            "sec-fetch-site": "same-origin",
            "user-agent": UA,
        })
        try:
            r = s.get(url, timeout=15)
            if r.status_code == 200:
                return r.json()
        except Exception:
            pass
        return None

    def fetch_match_full_parallel(self, event_id, profile_idx=0):
        """Version thread-safe de fetch_match_full : session dédiée au thread."""
        if not event_id or not self.enabled:
            return None
        profile = TLS_PROFILES[profile_idx % len(TLS_PROFILES)]
        odds_json = self._raw_get(
            f"https://www.sofascore.com/api/v1/event/{event_id}/odds/1/all", profile
        )
        stats_json = self._raw_get(
            f"https://www.sofascore.com/api/v1/event/{event_id}/statistics", profile
        )
        odds = self._odds_from_payload(odds_json)
        stats = self._stats_from_payload(stats_json)
        combined = dict(odds)
        combined.update(stats)
        combined["source"] = "sofascore"
        combined["scraped_at"] = int(time.time() * 1000)
        return combined

    @staticmethod
    def _odds_from_payload(payload):
        res = {
            "home": None, "draw": None, "away": None,
            "over25": None, "under25": None,
            "btts_yes": None, "btts_no": None,
            "corners_over": None, "corners_line": None, "corners_under": None,
        }
        if not payload or not isinstance(payload, dict):
            return res
        for m in payload.get("markets", []) or []:
            name = str(m.get("marketName", "") or m.get("marketGroup", "")).lower()
            cg = m.get("choiceGroup")
            try:
                cg = float(cg)
            except (TypeError, ValueError):
                cg = None
            choices = []
            for ch in m.get("choices", []) or []:
                cname = str(ch.get("name", ""))
                val = SofascoreClient._frac_to_decimal(
                    ch.get("decimalValue") if ch.get("decimalValue") is not None else ch.get("fractionalValue")
                )
                if val and val > 1:
                    choices.append((cname, val))
            if not choices:
                continue
            if m.get("marketId") == 1 or "1x2" in name or name == "full time":
                for cname, val in choices:
                    n = cname.lower()
                    if n in ("1", "home"):
                        res["home"] = val
                    elif n in ("x", "draw"):
                        res["draw"] = val
                    elif n in ("2", "away"):
                        res["away"] = val
            elif "match goals" in name or "over/under" in name or "total" in name:
                if cg == 2.5:
                    for cname, val in choices:
                        n = cname.lower()
                        if "over" in n:
                            res["over25"] = val
                        elif "under" in n:
                            res["under25"] = val
            elif "both teams" in name or "btts" in name:
                for cname, val in choices:
                    n = cname.lower()
                    if n == "yes":
                        res["btts_yes"] = val
                    elif n == "no":
                        res["btts_no"] = val
            elif "corner" in name:
                if cg == 9.5 or (res["corners_over"] is None and cg is not None):
                    for cname, val in choices:
                        n = cname.lower()
                        if "over" in n:
                            res["corners_over"] = val
                            res["corners_line"] = cg
                        elif "under" in n:
                            res["corners_under"] = val
                            res["corners_line"] = cg
        return res

    @staticmethod
    def _stats_from_payload(payload):
        out = {}
        if not payload or not isinstance(payload, dict) or not payload.get("statistics"):
            return out
        xg_h = xg_a = shots_h = shots_a = None
        for period in payload.get("statistics", []):
            for group in period.get("groups", []) or []:
                for item in group.get("statisticsItems", []) or []:
                    name = str(item.get("name", "")).lower()
                    if ("expected goals" in name or name == "xg") and xg_h is None:
                        try:
                            xg_h = float(item.get("home"))
                            xg_a = float(item.get("away"))
                        except (TypeError, ValueError):
                            pass
                    if "shots" in name and shots_h is None and "on" not in name:
                        try:
                            shots_h = float(item.get("home"))
                            shots_a = float(item.get("away"))
                        except (TypeError, ValueError):
                            pass
            if xg_h is not None and shots_h is not None:
                break
        if xg_h is not None or xg_a is not None:
            out["home_xg"] = xg_h
            out["away_xg"] = xg_a
        if shots_h is not None or shots_a is not None:
            out["shots_h"] = shots_h
            out["shots_a"] = shots_a
        return out


if __name__ == "__main__":
    import datetime
    d = sys.argv[1] if len(sys.argv) > 1 else datetime.date.today().isoformat()
    client = SofascoreClient()
    if not client.enabled:
        print("SofaScore désactivé (curl_cffi manquant)")
        sys.exit(1)
    events = client.get_scheduled_events(d)
    print(f"=== {len(events)} matchs pour {d} ===")
    for e in events[:10]:
        print(f"  {e['home']} vs {e['away']}  [{e['league']}]  id={e['sofascore_id']}")
    if events:
        print("\n=== Test cotes/stats sur le 1er match ===")
        full = client.fetch_match_full(events[0]["sofascore_id"])
        print(json.dumps(full, indent=2, default=str))
