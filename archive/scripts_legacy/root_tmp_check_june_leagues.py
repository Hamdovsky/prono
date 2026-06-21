import sqlite3
conn = sqlite3.connect('data/historical_archive.sqlite')
# Check what leagues have matches in mid-June historically
rows = conn.execute("""
    SELECT DISTINCT league_code AS league, COUNT(*) as cnt 
    FROM archive_football_data 
    WHERE match_date LIKE '%-06-1%' OR match_date LIKE '%-06-2%'
    GROUP BY league_code 
    ORDER BY cnt DESC 
    LIMIT 20
""").fetchall()
print("Leagues with June matches:")
for r in rows:
    print(f"  {r[0]}: {r[1]} matches")
conn.close()
