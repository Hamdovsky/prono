"""Check deploy status and today's matches.

Requires env vars:
  RENDER_API_KEY  (Render API key, prefix "rnd_")
  DATABASE_URL    (PostgreSQL URL, optional — skips DB section if absent)
"""
import urllib.request, json, os

# Check deploy status
token = os.environ.get("RENDER_API_KEY", "")
if token:
    services = [("pronostico", "srv-d9kbefpt0dsc739c5ieg")]
    for name, sid in services:
        req = urllib.request.Request(
            f"https://api.render.com/v1/services/{sid}/deploys?limit=1",
            headers={"Accept": "application/json", "Authorization": f"Bearer {token}"}
        )
        data = json.loads(urllib.request.urlopen(req).read())[0]
        print(f"{name}: {data['deploy']['status']} (finished: {data['deploy'].get('finishedAt','?')})")
else:
    print("RENDER_API_KEY non défini — skip statut déploiement")

print()

# Check PostgreSQL for today's matches
db_url = os.environ.get("DATABASE_URL", "")
if db_url:
    import psycopg2
    conn = psycopg2.connect(db_url)
    conn.autocommit = True
    cur = conn.cursor()

    cur.execute("""
        SELECT COUNT(*) FROM soccer_fixtures 
        WHERE date = CURRENT_DATE::text
    """)
    today_count = cur.fetchone()[0]
    print(f"Matchs aujourd'hui dans la DB: {today_count}")

    cur.execute("""
        SELECT f.date, ht.name AS home, at.name AS away, f.status
        FROM soccer_fixtures f
        LEFT JOIN soccer_teams ht ON ht.id = f.home_team_id
        LEFT JOIN soccer_teams at ON at.id = f.away_team_id
        WHERE f.date = CURRENT_DATE::text
        LIMIT 10
    """)
    rows = cur.fetchall()
    if rows:
        for r in rows:
            print(f"  {r[0]} | {r[1]} vs {r[2]} | {r[3]}")
    else:
        print("  Aucun match trouvé pour aujourd'hui")

        # Check what dates are in the DB
        cur.execute("""
            SELECT date, COUNT(*) FROM soccer_fixtures 
            WHERE date >= date('now', '-3 days')::text
            GROUP BY date ORDER BY date
            LIMIT 10
        """)
        dates = cur.fetchall()
        print(f"\nDates disponibles récemment:")
        for d in dates:
            print(f"  {d[0]}: {d[1]} matchs")

    conn.close()
else:
    print("DATABASE_URL non défini — skip DB")
