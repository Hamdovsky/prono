"""Pronostics multi-marchés: Over/Under, BTTS, 1X2, HT, Corners"""
import sqlite3
import datetime

db = sqlite3.connect(r"C:\Users\HAMDI\Desktop\HamdiProno\stitch\data\tactical.db")
db.row_factory = sqlite3.Row
cur = db.cursor()

cur.execute("""
SELECT id, homeTeam, awayTeam, league, prediction, confidence,
       home_win_probability, draw_probability, away_win_probability,
       ou_25_prob, btts_prob,
       odds_home, odds_draw, odds_away,
       odds_over25, odds_under25,
       odds_btts_yes, odds_btts_no,
       expected_score,
       CASE WHEN startTimestamp > 10000000000 THEN startTimestamp/1000 ELSE startTimestamp END AS ts_s,
       status, minute, scoreHome, scoreAway,
       fullData
  FROM matches
 WHERE status IN ('scheduled','upcoming','notstarted','NS')
 ORDER BY confidence DESC
 LIMIT 200
""")
rows = [dict(r) for r in cur.fetchall()]
db.close()

today = datetime.datetime.utcnow().strftime("%Y-%m-%d")
tomorrow = (datetime.datetime.utcnow() + datetime.timedelta(days=1)).strftime("%Y-%m-%d")
rows = [r for r in rows if r["ts_s"] and datetime.datetime.utcfromtimestamp(r["ts_s"]).strftime("%Y-%m-%d") in (today, tomorrow)]

# Only matches with real model predictions (not fallback 3000%)
real_rows = [r for r in rows if (r["confidence"] or 0) < 500]
real_rows.sort(key=lambda x: -(x["confidence"] or 0))

# Filter to matches with at least one real market odds
with_odds = [r for r in real_rows if r["odds_home"] or r["odds_over25"] or r["odds_btts_yes"]]
with_odds.sort(key=lambda x: -(x["confidence"] or 0))

print(f"=== PRONOSTICS TITANIUM AI ({len(with_odds)} matchs avec COTES REELLES) ===\n")

for r in with_odds:
    conf = r["confidence"] or 0
    probs = f"{r['home_win_probability'] or 0:.0f}/{r['draw_probability'] or 0:.0f}/{r['away_win_probability'] or 0:.0f}"
    ou25 = r["ou_25_prob"] or 0
    btts = r["btts_prob"] or 0
    ht_prob = r.get("ht_goal_prob") or 0

    pick_ou = "OVER" if ou25 > 55 else "UNDER" if ou25 > 0 else "--"
    pick_btts = "BTTS OUI" if btts > 55 else "BTTS NON" if btts > 0 else "--"
    pick_ht = "HT OUI" if ht_prob > 55 else "HT NON" if ht_prob > 0 else "--"

    ov = r["odds_over25"] or 0
    un = r["odds_under25"] or 0
    byes = r["odds_btts_yes"] or 0
    bno = r["odds_btts_no"] or 0
    oh = r["odds_home"] or 0
    od = r["odds_draw"] or 0
    oa = r["odds_away"] or 0

    # EV edge
    edge_ou = (ou25/100 * ov - 1) * 100 if ov > 0 else 0
    edge_btts = (btts/100 * byes - 1) * 100 if byes > 0 else 0

    # Parse fullData for corners/other markets
    corners_pick = "--"
    corners_prob = 0
    try:
        fd = r.get("fullData")
        if fd and isinstance(fd, str):
            fd = eval(fd) if fd.startswith("{") else None
        if fd and isinstance(fd, dict):
            quant = fd.get("quant", {}) or {}
            markets = quant.get("markets", {})
            c = markets.get("corners", {})
            if c:
                ep = c.get("expected") or c.get("expected_corners") or 0
                corners_prob = round((1 - (1 - ep/9.5)**1) * 100) if ep else 0
                corners_pick = "OVER" if corners_prob > 55 else "UNDER" if corners_prob > 0 else "--"
    except Exception:
        pass

    start = datetime.datetime.utcfromtimestamp(r["ts_s"]).strftime("%d/%m %H:%M")
    print(f"[{start}] {r['homeTeam']} vs {r['awayTeam']} [{r['league']}]")
    print(f"   Conf: {conf:.0f}%")

    if oh > 0:
        print(f"   1X2: {probs}%  | Cotes: {oh:.2f}/{od:.2f}/{oa:.2f}")
        pick1x2 = "1" if (r["home_win_probability"] or 0) > (r["away_win_probability"] or 0) else "2"
        ev_1 = ((r["home_win_probability"] or 0)/100 * oh - 1) * 100 if oh > 0 else 0
        ev_2 = ((r["away_win_probability"] or 0)/100 * oa - 1) * 100 if oa > 0 else 0
        print(f"   Pick: {r['prediction'] or pick1x2} | EV: {ev_1:+.1f}% / {ev_2:+.1f}%")

    if ou25 > 0:
        print(f"   O/U 2.5: {ou25:.0f}% -> {pick_ou} | Cotes: O{ov:.2f}/U{un:.2f} | EV: {edge_ou:+.1f}%")

    if btts > 0:
        print(f"   BTTS: {btts:.0f}% -> {pick_btts} | Cotes: OUI{byes:.2f}/NON{bno:.2f} | EV: {edge_btts:+.1f}%")

    if ht_prob > 0:
        print(f"   But 1MT: {ht_prob:.0f}% -> {pick_ht}")

    if corners_prob > 0:
        print(f"   Corners: {corners_prob:.0f}% -> {corners_pick}")

    print()
