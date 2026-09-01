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


def _mid_odds(market):
    """Extrait {name-> (dec, change)} à partir d'un marché Safascore."""
    out = {}
    for ch in market.get("choices") or []:
        dec = frac_to_dec(ch.get("decimalValue") if ch.get("decimalValue") is not None else ch.get("fractionalValue"))
        nm = str(ch.get("name") or "").strip().lower()
        if dec and nm:
            out[nm] = (dec, ch.get("change"))
    return out


def _apply_market(odds, market):
    """Importe 1X2 / Double chance / 1st half / BTTS depuis un marché."""
    by = _mid_odds(market)
    code = str(market.get("marketCode") or "")
    mkt = str(market.get("marketName") or "").strip().lower()
    # 1X2 (avec mouvement ▲▼)
    if ("1" in by and "x" in by and "2" in by) or code == "1":
        for k, key, ckey in (("1", "home", "home_change"), ("x", "draw", "draw_change"), ("2", "away", "away_change")):
            if k in by:
                odds.setdefault(key, by[k][0])
                odds.setdefault(ckey, by[k][1])
    # Double chance / 1st half : on garde mais sans écraser 1X2
    if "1x" in by and "x2" in by and "12" in by:
        odds.setdefault("dc_1x", by["1x"][0])
        odds.setdefault("dc_x2", by["x2"][0])
        odds.setdefault("dc_12", by["12"][0])
    # 1st half 1X2
    if mkt == "1st half" and "1" in by:
        odds.setdefault("h1_home", by["1"][0])
        odds.setdefault("h1_draw", by["x"][0] if "x" in by else None)
        odds.setdefault("h1_away", by["2"][0] if "2" in by else None)
    # BTTS
    if ("yes" in by or "no" in by) and len(by) <= 4:
        blob = (mkt + " " + code).lower()
        if "both" in blob or "btts" in blob:
            odds.setdefault("btts_yes", by.get("yes") and by["yes"][0])
            odds.setdefault("btts_no", by.get("no") and by["no"][0])
    # Match goals (Over/Under) ligne 2.5
    if mkt == "match goals":
        line = str(market.get("choiceGroup") or "").replace(",", ".")
        if line == "2.5":
            odds.setdefault("over25", by.get("over") and by["over"][0])
            odds.setdefault("under25", by.get("under") and by["under"][0])


def _fetch_event_odds(eid):
    """Cotes d'un event. Le groupe 5 (1 call) contient déjà 1X2 + Double chance +
    1st half + BTTS. Retourne dict odds (vide si l'event n'a pas de marché 5)."""
    odds = {}
    try:
        data5 = api_get("/event/%d/odds/5/all" % int(eid))
        for market in data5.get("markets") or []:
            _apply_market(odds, market)
    except Exception:  # noqa: BLE001
        pass
    return odds


def _live_minute(ev):
    """Minute estimée (0-90) à partir des timestamps de période (Sofascore n'expose
    pas de minute brute sur /events/live). Sert au modèle O/U + buts d'équipe."""
    t = ev.get("time") or {}
    start = t.get("currentPeriodStartTimestamp")
    end = t.get("lastPeriodEndTimestamp")
    code = ((ev.get("status") or {}).get("code") or 0)
    try:
        if code in (1, 2, 4):  # 1st half / HT
            base_sec = 0
        elif code == 3:  # halftime
            return 45
        else:  # 2nd half / extra
            base_sec = t.get("initial", 2700)
        sec = 0
        if start and end:
            sec = int(start) - int(end)
        minutes = (base_sec + max(0, sec)) / 60.0
        return max(0.0, min(90.0, minutes))
    except Exception:  # noqa: BLE001
        return 45.0


def _calibrated_lambda(score_key, minute):
    """xG complémentaire « scientifique » dérivé de la matrice calibrée de
    LiveGoalPredictor (services/LiveGoalPredictor.js) — proba historique qu'au moins
    1 but soit marqué selon le score + la minute. Convertie en lambda via
    lambda = -ln(1 - P). Corrige le biais 0-0 (mon modèle sous-estimait les 2e MT)."""
    # scorePatterns de LiveGoalPredictor : firstHalf/secondHalf/after60
    matrix = {
        "0-0": {"fh": 72, "sh": 88, "a60": 94},
        "1-0": {"fh": 65, "sh": 78, "a60": 85},
        "0-1": {"fh": 63, "sh": 76, "a60": 83},
        "1-1": {"fh": 78, "sh": 89, "a60": 96},
        "2-0": {"fh": 52, "sh": 68, "a60": 75},
        "0-2": {"fh": 50, "sh": 66, "a60": 73},
        "2-1": {"fh": 82, "sh": 91, "a60": 97},
        "1-2": {"fh": 80, "sh": 90, "a60": 96},
        "2-2": {"fh": 88, "sh": 95, "a60": 98},
        "3-0": {"fh": 42, "sh": 58, "a60": 65},
        "3-1": {"fh": 74, "sh": 85, "a60": 92},
        "3-2": {"fh": 92, "sh": 97, "a60": 99},
    }
    row = matrix.get(score_key, matrix["0-0"])
    if minute < 45:
        p = row["fh"]
    elif minute < 60:
        p = row["sh"]
    else:
        p = row["a60"]
    import math
    lam = -math.log(max(0.01, 1.0 - p / 100.0))
    # quartile de temps restant : on garde une part proportionnelle (reste ≤ 90')
    remain_frac = max(0.05, min(1.0, (90.0 - minute) / 90.0))
    return lam * remain_frac


def _scorer_description(winner, confidence, prob_h, prob_a, minute):
    team_label = "MENEUR" if winner == "HOME" else "VISITEUR"
    if confidence >= 75:
        strength = "TRÈS FORTE"
    elif confidence >= 55:
        strength = "FORTE"
    elif confidence >= 40:
        strength = "MODÉRÉE"
    else:
        strength = "FAIBLE"
    gap = abs(prob_h - prob_a)
    if gap >= 0.30:
        balance = "écart important"
    elif gap >= 0.15:
        balance = "légèrement favori"
    else:
        balance = "équilibré"
    return (
        f"{team_label} avec probabilité {strength} ({confidence}%) — "
        f"contexte {balance} · {minute}' joués"
    )


def _live_predictions(odds, hs, asc, minute, stats=None):
    """Prédiction live O/U + buts d'équipe dérivée des cotes live (puisque Sofascore
    ne diffuse PAS O/U 2.5 et total équipe en direct). Modèle Poisson simplifié :
    rythme actuel (score/minute) + force relative issue des cotes 1X2/BTTS.

    Si `stats` (dict xG home/away réel issus de /event/{id}/statistics) est fourni,
    la proba OVER se base sur le **xG réel** plutôt que sur le seul score/minute.

    Point 4 : `_calibrated_lambda()` (matrice LiveGoalPredictor) sert de plancher
    « scientifique » quand le score-pace sous-estime (ex. 0-0 tardif)."""
    hs, asc = int(hs or 0), int(asc or 0)
    p = {}
    home = odds.get("home")
    away = odds.get("away")
    btts_yes = odds.get("btts_yes")
    if not (home and away) or minute is None:
        return p
    T = max(0.05, min(0.95, minute / 90.0))
    remain = 1.0 - T
    curTotal = hs + asc
    calib_lam = _calibrated_lambda("%d-%d" % (hs, asc), minute)

    # xG réel si dispo : pacing = xG actuel / fraction écoutée
    if stats:
        xgH = float(stats.get("expectedGoalsHome") or 0)
        xgA = float(stats.get("expectedGoalsAway") or 0)
        xgTotalSoFar = xgH + xgA
        if T > 0.05 and xgTotalSoFar > 0:
            rate90 = (xgTotalSoFar / T) * 1.12  # ~12% de plus attendu (création)
            lambdaAdd = max(0.0, rate90 * remain)
        else:
            lambdaAdd = 1.4 * remain
        share_h = xgH / xgTotalSoFar if xgTotalSoFar > 0 else 0.5
    else:
        # Fallback score/minute (sans xG live)
        MIN_RATE = 1.4
        if curTotal >= 3:
            raw = (curTotal / T) if T > 0.05 else MIN_RATE
            paceObs = max(MIN_RATE, min(raw, 8.0))
        elif curTotal == 0 and T >= 0.45:
            paceObs = MIN_RATE
        elif curTotal == 0:
            paceObs = MIN_RATE
        else:
            raw = (curTotal / T) if T > 0.05 else MIN_RATE
            paceObs = max(MIN_RATE, min(raw, 8.0))
        base90 = 2.6
        open_boost = 1.3 if (btts_yes and btts_yes <= 1.8) else 1.0
        rate90 = (0.4 * paceObs + 0.6 * base90) * open_boost
        lambdaAdd = max(0.0, rate90 * remain)
        imp_h, imp_a = 1.0 / home, 1.0 / away
        if imp_h + imp_a > 0:
            share_h = imp_h / (imp_h + imp_a)
        else:
            share_h = 0.5

    # Point 4 : plancher « scientifique » (matrice calibrée LiveGoalPredictor).
    # On garde le MAX du lambda modélisé et du lambda calibré par score/minute
    # pour ne jamais sous-estimer les buts restants (ex. 0-0 tardif = 94% ≥1 but).
    if calib_lam > lambdaAdd:
        lambdaAdd = calib_lam
        p["calib_floor"] = True
    lambdaH = lambdaAdd * share_h
    lambdaA = lambdaAdd * (1 - share_h)

    # Proba Over 2.5 : P(curTotal + Pois(lambdaAdd) > 2.5)
    def pois_pmf(L, k):
        import math
        return math.exp(-L) * (L ** k) / math.factorial(k) if L > 0 else (1.0 if k == 0 else 0.0)
    p_under = 0.0
    for k in range(0, 12):
        tot = curTotal + k
        if tot <= 2.5:
            p_under += pois_pmf(lambdaAdd, k)
    p_over = max(0.0, 1.0 - p_under)
    p["over25"] = round(p_over, 3)
    p["under25"] = round(1 - p_over, 3)
    p["ou_pick"] = "OVER 2.5" if p_over >= 0.55 else ("UNDER 2.5" if p_over <= 0.45 else "PUSH/ÉQUILIBRE")
    p["ou_fair_odds_over"] = round(1.0 / p_over, 2) if p_over > 0 else None
    p["ou_fair_odds_under"] = round(1.0 / (1 - p_over), 2) if p_over < 1 else None

    # Buts attendus par équipe + prono final
    p["home_xg_live"] = round(hs + lambdaH, 1)
    p["away_xg_live"] = round(asc + lambdaA, 1)
    p["total_xg_live"] = round(curTotal + lambdaAdd, 1)

    # ── PROCHAIN BUTEUR : système multi-facteurs ─────────────────────────────────
    # Facteurs : xG_share(40%) + momentum_stats(30%) + tempo_temps(20%) + forme(10%)
    # On ne prédit PAS de joueur précis (données non dispo en live) mais l'ÉQUIPE
    # la plus susceptible de marquer le prochain but + confiance 0-100.
    xg_share = share_h  # derived from 1X2 odds or real xG

    mom_h, mom_a = 0.5, 0.5
    if stats:
        s_h = int(stats.get("shotsOnTargetHome") or 0)
        s_a = int(stats.get("shotsOnTargetAway") or 0)
        c_h = int(stats.get("cornersHome") or 0)
        c_a = int(stats.get("cornersAway") or 0)
        a_h = int(stats.get("attacksHome") or stats.get("dangerousAttacksHome") or 0)
        a_a = int(stats.get("attacksAway") or stats.get("dangerousAttacksAway") or 0)
        tot_s = s_h + s_a + 1
        tot_c = c_h + c_a + 1
        tot_a = a_h + a_a + 1
        mom_h = 0.5 + 0.25 * (s_h / tot_s - 0.5) + 0.25 * (c_h / tot_c - 0.5) + 0.50 * (a_h / tot_a - 0.5)
        mom_a = 1.0 - mom_h
    mom_h = max(0.05, min(0.95, mom_h))
    mom_a = max(0.05, min(0.95, mom_a))

    # Pression temps : plus on approche de la fin, plus les équipes desesperées attack
    tempo_h = tempo_a = 0.5
    if minute >= 80:
        if hs < asc:  # HOME mené → urgent
            tempo_h = min(0.95, 0.5 + 0.08 * (minute - 80) / 10)
            tempo_a = max(0.05, 0.5 - 0.03 * (minute - 80) / 10)
        elif asc < hs:  # AWAY mené → urgent
            tempo_a = min(0.95, 0.5 + 0.08 * (minute - 80) / 10)
            tempo_h = max(0.05, 0.5 - 0.03 * (minute - 80) / 10)
        else:  # draw
            tempo_h = tempo_a = 0.5 + 0.05 * (minute - 80) / 10
    elif minute >= 65:
        if hs < asc:
            tempo_h = min(0.90, 0.5 + 0.04 * (minute - 65) / 15)
            tempo_a = max(0.10, 0.5 - 0.02 * (minute - 65) / 15)
        elif asc < hs:
            tempo_a = min(0.90, 0.5 + 0.04 * (minute - 65) / 15)
            tempo_h = max(0.10, 0.5 - 0.02 * (minute - 65) / 15)

    # Forme : taux de conversion historique par équipe (si stats dispo)
    form_h = form_a = 0.5
    if stats:
        xgH_real = float(stats.get("expectedGoalsHome") or 0)
        xgA_real = float(stats.get("expectedGoalsAway") or 0)
        if xgH_real > 0:
            form_h = min(0.95, hs / xgH_real) if xgH_real >= 0.3 else 0.5
        if xgA_real > 0:
            form_a = min(0.95, asc / xgA_real) if xgA_real >= 0.3 else 0.5
        if xgH_real <= 0 and xgA_real <= 0:
            form_h = form_a = 0.5

    # Score composite par équipe (0.0 – 1.0)
    score_h = xg_share * 0.40 + mom_h * 0.30 + tempo_h * 0.20 + form_h * 0.10
    score_a = (1 - xg_share) * 0.40 + mom_a * 0.30 + tempo_a * 0.20 + form_a * 0.10
    total_score = score_h + score_a
    prob_h = round(score_h / total_score, 3) if total_score > 0 else 0.5
    prob_a = round(score_a / total_score, 3) if total_score > 0 else 0.5

    winner_team = "HOME" if score_h >= score_a else "AWAY"
    confidence = int(abs(score_h - score_a) * 200)  # 0-100 scale
    confidence = max(20, min(98, confidence + 30))  # floor 30 (no zero-confidence picks)

    p["score_team"] = (hs, asc, winner_team)
    p["next_scorer"] = {
        "team": winner_team,
        "confidence": confidence,
        "prob_home": prob_h,
        "prob_away": prob_a,
        "factors": {
            "xg_share_pct": round(xg_share * 100, 1),
            "momentum_pct": round(mom_h * 100, 1),
            "tempo_pct": round(tempo_h * 100, 1),
            "form_pct": round(form_h * 100, 1),
        },
        "description": _scorer_description(winner_team, confidence, prob_h, prob_a, minute),
    }

    # prono score final (arrondi Poisson)
    import math
    fin_h = hs + round(lambdaH)
    fin_a = asc + round(lambdaA)
    p["pred_score"] = "%d-%d" % (fin_h, fin_a)
    # Stats live réelles (xG Sofascore) si dispo
    if stats:
        p["xg_home_actual"] = round(float(stats.get("expectedGoalsHome") or 0), 2)
        p["xg_away_actual"] = round(float(stats.get("expectedGoalsAway") or 0), 2)
        p["possession_home"] = stats.get("possessionHome")
        p["shots_home"] = stats.get("shotsHome")
        p["shots_away"] = stats.get("shotsAway")
        p["shots_ontarget_home"] = stats.get("shotsOnTargetHome")
        p["shots_ontarget_away"] = stats.get("shotsOnTargetAway")
        p["corners_home"] = stats.get("cornersHome")
        p["corners_away"] = stats.get("cornersAway")
        p["xgsrc"] = "live"
    else:
        p["xgsrc"] = "score_pace"

    # ── VALEUR : comparer le xG modélisé à l'espoir de buts implicite du MARCHÉ ──
    # Le marché (BTTS + 1X2 en direct) trahit combien de buts il attend réellement.
    # mapping BTTS Yes impliqué (%) → total de buts attendu par le marché.
    # NOTE : on ne signale une valeur qu'à partir de ~30' jouées (T>=0.30) car
    # avant, `mkt_total_live = mkt_total*T` s'effondre (T≈0) → faux OVER-value.
    p_value = None
    if btts_yes and T >= 0.30:
        btts_yes_imp = 1.0 / btts_yes
        # Heuristique calibrée sur marchés foot classiques (conservateur)
        mkt_total_from_btts = 0.9 + 3.8 * btts_yes_imp
        # Le draw court (1X2) => équipes équilibrées => + de buts attendus
        mkt_total = mkt_total_from_btts
        if odds.get("draw") and 3.0 <= odds["draw"] <= 3.8:
            mkt_total += 0.3
        # xG marché total (normalisé au temps restant) vs notre xG modélisé
        mkt_total_live = max(0.0, mkt_total * T)
        model_total = curTotal + lambdaAdd
        diff = model_total - mkt_total_live
        # Seuil de signal (en buts) — évite le bruit
        if diff >= 0.45:
            p_value = {"type": "OVER_VALUE", "side": "OVER 2.5",
                       "edge": round(diff, 2), "strength": min(100, int(40 + diff * 35)),
                       "market_total_live": round(mkt_total_live, 2),
                       "model_total": round(model_total, 2)}
        elif diff <= -0.45:
            p_value = {"type": "UNDER_VALUE", "side": "UNDER 2.5",
                       "edge": round(-diff, 2), "strength": min(100, int(40 + (-diff) * 35)),
                       "market_total_live": round(mkt_total_live, 2),
                       "model_total": round(model_total, 2)}
        if p_value:
            p["value"] = p_value
    return p


def _parse_live_stats(raw):
    """Extrait xG + stats utiles depuis la réponse /event/{id}/statistics."""
    if not isinstance(raw, dict):
        return None
    stats_list = raw.get("statistics")
    if not isinstance(stats_list, list) or not stats_list:
        return None
    s = stats_list[0]
    groups = s.get("groups") or []
    out = {}
    for g in groups:
        for item in g.get("statisticsItems") or []:
            key = item.get("key")
            try:
                h = float(item.get("homeValue"))
                a = float(item.get("awayValue"))
            except (TypeError, ValueError):
                continue
            if key == "expectedGoals":
                out["expectedGoalsHome"] = h
                out["expectedGoalsAway"] = a
            elif key == "ballPossession":
                out["possessionHome"] = h
            elif key == "totalShotsOnGoal":
                out["shotsHome"] = h
                out["shotsAway"] = a
            elif key == "shotsOnGoal":
                out["shotsOnTargetHome"] = h
                out["shotsOnTargetAway"] = a
            elif key == "cornerKicks":
                out["cornersHome"] = h
                out["cornersAway"] = a
    if "expectedGoalsHome" not in out:
        return None
    return out


def _fetch_event_stats(eid):
    """Statistiques live (dont xG) d'un event via /statistics. Retourne dict ou None."""
    try:
        raw = api_get("/event/%d/statistics" % int(eid))
        return _parse_live_stats(raw)
    except Exception:  # noqa: BLE001
        return None


def cmd_live(args):
    """Matchs en direct via /sport/football/events/live (1X2 + BTTS + DC + 1st half)."""
    try:
        data = api_get("/sport/football/events/live")
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"found": False, "error": str(e)}))
        return
    events = data.get("events") or []
    ids = [int(ev.get("id")) for ev in events if ev.get("id") is not None]
    # Plafond : on ne récupère les cotes que des N premiers matchs en direct pour
    # rester sous le timeout Node (30s) et ne pas asphyxier l'API Sofascore.
    MAX_ODDS_FETCH = 50
    if len(ids) > MAX_ODDS_FETCH:
        ids = ids[:MAX_ODDS_FETCH]
    # IDs des events exposant du xG live (Sofascore fournit /statistics)
    xg_ids = [int(ev.get("id")) for ev in events if ev.get("hasXg") and ev.get("id") is not None]
    odds_map = {}
    stats_map = {}
    if ids:
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=4) as ex:
            for eid, odds in zip(ids, ex.map(_fetch_event_odds, ids)):
                odds_map[eid] = odds
            for eid, stats in zip(xg_ids, ex.map(_fetch_event_stats, xg_ids)):
                if stats:
                    stats_map[eid] = stats
    out = []
    for ev in events:
        eid = ev.get("id")
        iid = int(eid) if eid is not None else None
        odds = odds_map.get(iid, {}) if iid is not None else {}
        stats = stats_map.get(iid) if iid is not None else None
        ht = ev.get("homeTeam") or {}
        at = ev.get("awayTeam") or {}
        hs = ev.get("homeScore") or {}
        asc = ev.get("awayScore") or {}
        status = ev.get("status") or {}
        minute = _live_minute(ev)
        homeScore = hs.get("display") if hs.get("display") is not None else hs.get("current")
        awayScore = asc.get("display") if asc.get("display") is not None else asc.get("current")
        predictions = _live_predictions(odds, homeScore, awayScore, minute, stats)
        out.append({
            "id": eid,
            "homeTeam": ht.get("name"),
            "awayTeam": at.get("name"),
            "tournament": ((ev.get("tournament") or {}).get("name") or ""),
            "category": ((ev.get("category") or {}).get("name") or ""),
            "homeScore": homeScore,
            "awayScore": awayScore,
            "minute": status.get("description"),
            "liveMinute": round(minute, 1),
            "statusType": status.get("type"),
            "odds": odds,
            "pred": predictions,
        })
    print(json.dumps({"found": bool(out), "events": out}, ensure_ascii=False))


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


def cmd_event(args):
    """Statut + score courant/final d'un événement (pour auto-résolution FT).
    /event/{id} -> {event:{status, homeTeam, awayTeam, homeScore, awayScore}}."""
    out = {"found": False}
    try:
        data = api_get("/event/%d" % int(args.event))
        ev = (data or {}).get("event") or {}
        st = ev.get("status") or {}
        status = (st.get("type") or "").lower()
        hs = (ev.get("homeScore") or {}).get("current")
        as_ = (ev.get("awayScore") or {}).get("current")
        hname = ((ev.get("homeTeam") or {}).get("name") or "")
        aname = ((ev.get("awayTeam") or {}).get("name") or "")
        out.update({
            "found": True,
            "eventId": args.event,
            "status": status,
            "finished": status in ("finished", "awarded", "cancelled", "postponed", "interrupted", "abandoned", "walkover"),
            "home": hs,
            "away": as_,
            "homeTeam": hname,
            "awayTeam": aname,
            "minute": st.get("displayed"),
        })
    except RuntimeError as e:
        out["error"] = "api:" + str(e)
    except Exception as e:  # noqa: BLE001
        out["error"] = str(e)
    print(json.dumps(out, ensure_ascii=False))


def main():
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    pev = sub.add_parser("event")
    pev.add_argument("--event", required=True)
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
    plv = sub.add_parser("live")
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
        elif args.cmd == "event":
            cmd_event(args)
        elif args.cmd == "live":
            cmd_live(args)
        else:
            cmd_odds(args)
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"found": False, "error": str(e)}))
    log("done in %.1fs" % (time.time() - t0))


if __name__ == "__main__":
    main()
