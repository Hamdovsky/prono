"""Liste des pronos du jour depuis la DB locale (lecture seule)."""
import sqlite3
import datetime
import json

db = sqlite3.connect(r"C:\Users\HAMDI\Desktop\HamdiProno\stitch\data\tactical.db")
db.row_factory = sqlite3.Row
cur = db.cursor()

today = datetime.datetime.utcnow().strftime("%Y-%m-%d")
tomorrow = (datetime.datetime.utcnow() + datetime.timedelta(days=1)).strftime("%Y-%m-%d")

cur.execute(
    """
    SELECT id, homeTeam, awayTeam, league, prediction, confidence,
           home_win_probability, draw_probability, away_win_probability,
           odds_home, odds_draw, odds_away, ou_25_prob, btts_prob,
           CASE WHEN startTimestamp > 10000000000 THEN startTimestamp/1000 ELSE startTimestamp END AS ts_s,
           status
      FROM matches
     WHERE status IN ('scheduled','upcoming','notstarted')
     ORDER BY confidence DESC
     LIMIT 400
    """
)
rows = [dict(r) for r in cur.fetchall()]
today = datetime.datetime.utcnow().strftime("%Y-%m-%d")
tomorrow = (datetime.datetime.utcnow() + datetime.timedelta(days=1)).strftime("%Y-%m-%d")
rows = [r for r in rows if r["ts_s"] and datetime.datetime.utcfromtimestamp(r["ts_s"]).strftime("%Y-%m-%d") in (today, tomorrow)]
rows.sort(key=lambda r: -(r["confidence"] or 0))
print(f"Matchs a venir aujourd'hui/demain: {len(rows)}")
print(f"{'conf':>5} {'pick':<6} {'1X2 H/D/A':<18} {'cotes':<16} {'OU25':<5} {'BTTS':<5}  match")
print("-" * 110)
for r in rows:
    conf = r["confidence"] or 0
    pick = r["prediction"] or "-"
    probs = f"{(r['home_win_probability'] or 0):.2f}/{(r['draw_probability'] or 0):.2f}/{(r['away_win_probability'] or 0):.2f}"
    cotes = f"{r['odds_home'] or '-':>5} {r['odds_draw'] or '-':>5} {r['odds_away'] or '-':>5}"
    ou = f"{r['ou_25_prob']:.2f}" if r["ou_25_prob"] else "-"
    bt = f"{r['btts_prob']:.2f}" if r["btts_prob"] else "-"
    print(f"{conf:>5.1f} {pick:<6} {probs:<18} {cotes:<16} {ou:<5} {bt:<5}  {r['homeTeam']} vs {r['awayTeam']} [{r['league']}]")

# combien ont de vraies cotes ?
with_odds = sum(1 for r in rows if r["odds_home"])
print(f"\nMatchs avec vraies cotes 1X2 : {with_odds}/{len(rows)}")
db.close()
