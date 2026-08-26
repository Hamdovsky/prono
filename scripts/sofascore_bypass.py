#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Sofascore via curl_cffi (contournement du ban TLS/IP, fingerprints navigateur).

Usage:
  python sofascore_bypass.py resolve --home "Schalke 04" --away "Hallescher FC" [--ts 1787597100]
  python sofascore_bypass.py odds --event 16287064

Sortie : UN objet JSON unique sur stdout. Les logs vont sur stderr.
"""
import argparse
import json
import os
import re
import sys
import time

try:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
except Exception:  # noqa: BLE001
    pass
import unicodedata

from curl_cffi import requests

BASE = "https://api.sofascore.com/api/v1"
IMPERSONATES = ["chrome124", "safari17_0", "firefox133"]
TIMEOUT = 20


def log(msg):
    sys.stderr.write("[sofascore_bypass] %s\n" % msg)


def norm(s):
    if not s:
        return ""
    s = unicodedata.normalize("NFKD", str(s))
    s = "".join(c for c in s if not unicodedata.combining(c))
    s = s.lower()
    s = re.sub(r"[^a-z0-9]+", "", s)
    return s


def api_get(path, params=None):
    last_err = None
    for imp in IMPERSONATES:
        try:
            r = requests.get(
                BASE + path,
                params=params or {},
                impersonate=imp,
                timeout=TIMEOUT,
            )
            if r.status_code == 200:
                return r.json()
            last_err = "HTTP %s (%s)" % (r.status_code, imp)
        except Exception as e:  # noqa: BLE001
            last_err = "%s (%s)" % (e, imp)
    raise RuntimeError("api_get %s a echoue: %s" % (path, last_err))


def frac_to_dec(val):
    """'9/1' -> 10.0 ; 'EVS' -> 2.0 ; decimal direct sinon None."""
    if val is None:
        return None
    if isinstance(val, (int, float)):
        return float(val) if float(val) > 1 else None
    v = str(val).strip().lower()
    if v in ("evs", "evens", "even"):
        return 2.0
    m = re.match(r"^(\d+)\s*/\s*(\d+)$", v)
    if m:
        num, den = int(m.group(1)), int(m.group(2))
        if den > 0:
            d = 1.0 + float(num) / den
            return round(d, 3) if d > 1 else None
    try:
        d = float(v)
        return d if d > 1 else None
    except ValueError:
        return None


def search_team(name):
    data = api_get("/search/all", {"q": name, "page": "0"})
    results = data.get("results") or []
    fallback_id, fallback_name = None, None
    for res in results:
        ent = res.get("entity") or {}
        sport = ent.get("sport")
        sport_slug = sport.get("slug") if isinstance(sport, dict) else sport
        if sport_slug and sport_slug != "football":
            continue
        tid, tname = ent.get("id"), ent.get("name") or ent.get("shortName")
        if tid is None or not tname:
            continue
        if norm(tname) == norm(name):
            return tid, tname
        if fallback_id is None:
            fallback_id, fallback_name = tid, tname
    return fallback_id, fallback_name


def cmd_resolve(args):
    home_id, home_name = search_team(args.home)
    if home_id is None:
        print(json.dumps({"found": False, "reason": "home_not_found"}))
        return
    events = []
    for path in ("/team/%d/events/next/0" % home_id, "/team/%d/events/last/0" % home_id):
        try:
            data = api_get(path)
            events.extend(data.get("events") or [])
        except Exception as e:  # noqa: BLE001
            log("events %s: %s" % (path, e))
    want = norm(args.away)

    def hit(cands):
        for c in cands:
            n = norm(c)
            if not n or len(want) < 4 or len(n) < 4:
                continue
            if want == n or want in n or n in want:
                return True
        return False

    for ev in events:
        h = ev.get("homeTeam") or {}
        a = ev.get("awayTeam") or {}
        if hit([h.get("name"), h.get("shortName"), a.get("name"), a.get("shortName")]):
            ts = ev.get("startTimestamp")
            if args.ts and abs(int(ts) - int(args.ts)) > 7 * 86400:
                continue
            print(json.dumps({
                "found": True,
                "event_id": ev.get("id"),
                "start_timestamp": ts,
                "home": h.get("name"),
                "away": a.get("name"),
                "tournament": ((ev.get("tournament") or {}).get("name") or ""),
            }, ensure_ascii=False))
            return
    print(json.dumps({"found": False, "reason": "event_not_found", "checked": len(events)}))


def cmd_odds(args):
    data = api_get("/event/%d/odds/1/all" % int(args.event))
    out = {}
    for market in data.get("markets") or []:
        code = str(market.get("marketCode") or "")
        choices = market.get("choices") or []
        by_name = {}
        for ch in choices:
            dec = frac_to_dec(ch.get("decimalValue") if ch.get("decimalValue") is not None else ch.get("fractionalValue"))
            nm = str(ch.get("name") or "").strip()
            if dec:
                by_name[nm.lower()] = dec
        # 1X2
        if ("1" in by_name and "x" in by_name and "2" in by_name) or code == "1":
            for k, key in (("1", "home"), ("x", "draw"), ("2", "away")):
                out.setdefault(key, by_name.get(k))
        # Over/Under 2.5 : marchés « Match goals », ligne dans choiceGroup
        if str(market.get("marketName") or "").strip().lower() == "match goals":
            line = str(market.get("choiceGroup") or "").replace(",", ".")
            if line == "2.5":
                over25 = by_name.get("over")
                under25 = by_name.get("under")
                if over25 or under25:
                    out.setdefault("over25", over25)
                    out.setdefault("under25", under25)
        # BTTS (Both teams to score)
        joined = " ".join(by_name.keys())
        if re.search(r"yes|no", joined) and len(by_name) <= 4:
            mkt_name = str(market.get("marketName") or "")
            blob = (mkt_name + " " + code).lower()
            if "both" in blob or "btts" in blob:
                out.setdefault("btts_yes", by_name.get("yes"))
                out.setdefault("btts_no", by_name.get("no"))
        # Corners : marketId=21 « Corners 2-Way », ligne dans choiceGroup.
        # On garde la ligne la plus BASSE (ligne principale type 9.5).
        mid = market.get("marketId")
        mname_l = str(market.get("marketName") or "").lower()
        if mid == 21 or ("corner" in mname_l):
            try:
                line_v = float(str(market.get("choiceGroup") or "").replace(",", "."))
            except (TypeError, ValueError):
                line_v = None
            over_c = by_name.get("over")
            under_c = by_name.get("under")
            if over_c or under_c:
                cur_line = out.get("corner_line")
                if cur_line is None or (line_v is not None and line_v < cur_line):
                    out["corner_line"] = line_v
                    out["corner_over"] = over_c
                    out["corner_under"] = under_c
    found = any(out.get(k) for k in ("home", "draw", "away"))
    print(json.dumps({"found": bool(found), "odds": out}, ensure_ascii=False))


def _pos(p):
    pos = p.get("position")
    return (pos or {}).get("position") if isinstance(pos, dict) else pos


def parse_lineups(data: dict) -> dict:
    """Parse tolérant de /event/{id}/lineups -> {found, confirmed, teams[]}."""
    if not isinstance(data, dict):
        return {"found": False, "confirmed": False, "teams": []}
    out = {"found": bool(data), "confirmed": bool(data.get("confirmed", False)), "teams": []}
    for side in ("home", "away"):
        block = data.get(side) or {}
        players = []
        for p in (block.get("players") or [])[:30]:
            pl = p.get("player") or {}
            players.append({
                "name": pl.get("name"),
                "position": _pos(pl),
                "shirt": p.get("shirtNumber"),
                "substitute": bool(p.get("substitute")),
            })
        out["teams"].append({
            "side": side,
            "team": (block.get("team") or {}).get("name"),
            "formation": block.get("formation"),
            "n_players": len(players),
            "players": players,
        })
    return out


def cmd_lineups(args):
    """Compositions officielles d'un événement (Phase 9 groundwork)."""
    try:
        data = api_get("/event/%d/lineups" % int(args.event))
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"found": False, "error": str(e)}))
        return
    print(json.dumps(parse_lineups(data), ensure_ascii=False))


def parse_injuries(data) -> dict:
    """Parse tolérant de /event/{id}/injuries -> {found, n, injuries[]}."""
    if not isinstance(data, dict):
        return {"found": False, "n": 0, "injuries": []}
    rows = data.get("injuries") if isinstance(data, dict) else None
    rows = rows or (data if isinstance(data, list) else [])
    items = []
    for r in rows[:40]:
        pl = r.get("player") or {}
        tm = r.get("team") or {}
        items.append({
            "team": tm.get("name"),
            "player": pl.get("name"),
            "position": _pos(pl),
            "status": r.get("statusType") or r.get("type"),
            "detail": r.get("details"),
        })
    return {"found": bool(items), "n": len(items), "injuries": items}


def cmd_injuries(args):
    """Absences/blessures/suspensions annoncées pour un événement."""
    try:
        data = api_get("/event/%d/injuries" % int(args.event))
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"found": False, "error": str(e)}))
        return
    print(json.dumps(parse_injuries(data), ensure_ascii=False))


def _ht_score_from_incidents(incs):
    """Score à la mi-temps : incident period avec text == 'HT'."""
    for it in incs or []:
        if (it.get("incidentType") == "period"
                and str(it.get("text") or "").strip().upper() == "HT"):
            h, a = it.get("homeScore"), it.get("awayScore")
            if h is not None and a is not None:
                try:
                    return int(h), int(a)
                except (TypeError, ValueError):
                    pass
    return None, None


def _corners_from_statistics(stats, period):
    """'Corner kicks' du groupe 'Match overview' pour une période donnée."""
    if not isinstance(stats, dict):
        return None, None
    for block in stats.get("statistics") or []:
        if block.get("period") != period:
            continue
        for grp in block.get("groups") or []:
            for it in grp.get("statisticsItems") or []:
                if str(it.get("name") or "").strip().lower() == "corner kicks":
                    h, a = it.get("home"), it.get("away")
                    if h is not None and a is not None:
                        try:
                            return int(h), int(a)
                        except (TypeError, ValueError):
                            pass
    return None, None


def cmd_stats(args):
    """HT score + corners FT/HT d'un événement TERMINÉ (incidents + statistics)."""
    out = {"found": False}
    try:
        inc = api_get("/event/%d/incidents" % int(args.event))
        ht_h, ht_a = _ht_score_from_incidents(inc.get("incidents"))
        if ht_h is not None:
            out["ht_h"], out["ht_a"] = ht_h, ht_a
    except Exception as e:  # noqa: BLE001
        out["incidents_error"] = str(e)
    try:
        stats = api_get("/event/%d/statistics" % int(args.event))
        c_h, c_a = _corners_from_statistics(stats, "ALL")
        if c_h is not None:
            out["c_ft_h"], out["c_ft_a"] = c_h, c_a
        ch_h, ch_a = _corners_from_statistics(stats, "1ST")
        if ch_h is not None:
            out["c_ht_h"], out["c_ht_a"] = ch_h, ch_a
    except Exception as e:  # noqa: BLE001
        out["statistics_error"] = str(e)
    out["found"] = any(k in out for k in ("ht_h", "c_ft_h", "c_ht_h"))
    print(json.dumps(out, ensure_ascii=False))


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    pr = sub.add_parser("resolve")
    pr.add_argument("--home", required=True)
    pr.add_argument("--away", required=True)
    pr.add_argument("--ts", default=None)
    po = sub.add_parser("odds")
    po.add_argument("--event", required=True)
    pl = sub.add_parser("lineups")
    pl.add_argument("--event", required=True)
    pi = sub.add_parser("injuries")
    pi.add_argument("--event", required=True)
    ps = sub.add_parser("stats")
    ps.add_argument("--event", required=True)
    args = p.parse_args()
    t0 = time.time()
    try:
        if args.cmd == "resolve":
            cmd_resolve(args)
        elif args.cmd == "lineups":
            cmd_lineups(args)
        elif args.cmd == "injuries":
            cmd_injuries(args)
        elif args.cmd == "stats":
            cmd_stats(args)
        else:
            cmd_odds(args)
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"found": False, "error": str(e)}))
    log("done in %.1fs" % (time.time() - t0))


if __name__ == "__main__":
    main()
