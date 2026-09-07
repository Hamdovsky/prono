import sqlite3, difflib
db = sqlite3.connect(r"C:\Users\HAMDI\Desktop\HamdiProno\stitch\data\tactical.db")
cur = db.cursor()
cur.execute("SELECT DISTINCT homeTeam FROM matches UNION SELECT DISTINCT awayTeam FROM matches ORDER BY homeTeam")
teams = [r[0] for r in cur.fetchall()]
queries = ["persa", "manila", "digger"]
for q in queries:
    # exact-ish substring
    exact = [t for t in teams if q.lower() in t.lower()]
    # fuzzy
    fuzzy = difflib.get_close_matches(q, teams, n=10, cutoff=0.5)
    print(f"=== Query: {q} ===")
    print("  substring:", exact)
    print("  fuzzy:", fuzzy)
db.close()
