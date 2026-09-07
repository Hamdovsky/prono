import sqlite3, datetime

db = sqlite3.connect(r"C:\Users\HAMDI\Desktop\HamdiProno\stitch\data\tactical.db")
db.row_factory = sqlite3.Row
cur = db.cursor()
cur.execute('''
SELECT id, homeTeam, awayTeam, league, prediction, confidence,
       home_win_probability, draw_probability, away_win_probability,
       ou_25_prob, btts_prob,
       odds_home, odds_draw, odds_away,
       odds_over25, odds_under25,
       odds_btts_yes, odds_btts_no,
       expected_score, status, minute, scoreHome, scoreAway,
       CASE WHEN startTimestamp > 10000000000 THEN startTimestamp/1000 ELSE startTimestamp END AS ts_s,
       fullData
  FROM matches
 WHERE homeTeam LIKE '%Persa%' OR awayTeam LIKE '%Persa%'
    OR homeTeam LIKE '%Manila%' OR awayTeam LIKE '%Manila%'
''')
rows = [dict(r) for r in cur.fetchall()]
db.close()

for r in rows:
    start = datetime.datetime.utcfromtimestamp(r['ts_s']).strftime('%d/%m %H:%M') if r['ts_s'] else '?'
    conf = r['confidence'] or 0
    oh = r['odds_home'] or 0
    od = r['odds_draw'] or 0
    oa = r['odds_away'] or 0
    ov = r['odds_over25'] or 0
    un = r['odds_under25'] or 0
    byes = r['odds_btts_yes'] or 0
    bno = r['odds_btts_no'] or 0
    ou25 = r['ou_25_prob'] or 0
    btts = r['btts_prob'] or 0
    probs = f"{r['home_win_probability'] or 0:.0f}/{r['draw_probability'] or 0:.0f}/{r['away_win_probability'] or 0:.0f}"
    pick_ou = 'OVER' if ou25 > 55 else 'UNDER' if ou25 > 0 else '--'
    pick_btts = 'BTTS OUI' if btts > 55 else 'BTTS NON' if btts > 0 else '--'
    edge_ou = (ou25/100 * ov - 1) * 100 if ov > 0 else 0
    edge_btts = (btts/100 * byes - 1) * 100 if byes > 0 else 0

    print(f"MATCH: {r['homeTeam']} vs {r['awayTeam']} [{r['league']}]")
    print(f"   Date: {start} | Status: {r['status']} | Minute: {r['minute']}")
    print(f"   Score: {r['scoreHome']}-{r['scoreAway']}")
    print(f"   Confiance: {conf:.0f}%")

    if oh > 0:
        ev_h = ((r['home_win_probability'] or 0)/100 * oh - 1) * 100
        ev_d = ((r['draw_probability'] or 0)/100 * od - 1) * 100
        ev_a = ((r['away_win_probability'] or 0)/100 * oa - 1) * 100
        print(f"   1X2: {probs}% | Cotes: {oh:.2f}/{od:.2f}/{oa:.2f}")
        print(f"   EV: {ev_h:+.1f}% / {ev_d:+.1f}% / {ev_a:+.1f}%")
    else:
        print(f"   1X2: {probs}% | Pas de cotes")

    if ou25 > 0:
        print(f"   O/U 2.5: {ou25:.0f}% -> {pick_ou} | Cotes: O{ov:.2f}/U{un:.2f} | EV: {edge_ou:+.1f}%")
    else:
        print(f"   O/U 2.5: --")

    if btts > 0:
        print(f"   BTTS: {btts:.0f}% -> {pick_btts} | Cotes: OUI{byes:.2f}/NON{bno:.2f} | EV: {edge_btts:+.1f}%")
    else:
        print(f"   BTTS: --")

    # Parse fullData for extra markets
    try:
        fd = r.get('fullData')
        if fd and isinstance(fd, str):
            fd = eval(fd) if fd.startswith('{') else None
        if fd and isinstance(fd, dict):
            quant = fd.get('quant') or {}
            markets = quant.get('markets', {})
            ht = markets.get('ht', {})
            if ht:
                ht_prob = ht.get('goal_yes', 0) * 100 if ht.get('goal_yes') else 0
                ht_pick = 'HT OUI' if ht_prob > 55 else 'HT NON' if ht_prob > 0 else '--'
                print(f"   But 1MT: {ht_prob:.0f}% -> {ht_pick}")
    except Exception:
        pass

    print()
