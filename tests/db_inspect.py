import sqlite3
conn = sqlite3.connect('data/tactical.db')

# List tables
tables = conn.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()
print("TABLES:", [t[0] for t in tables])

# Check archive_matches team names for national teams
try:
    rows = conn.execute("SELECT DISTINCT homeTeam FROM archive_matches LIMIT 50").fetchall()
    print("\narchive_matches homeTeam samples:")
    for r in rows: print(f"  {r[0]}")
except: print("No archive_matches")

# Check archive_football_data
try:
    rows = conn.execute("SELECT DISTINCT home_team FROM archive_football_data LIMIT 50").fetchall()
    print("\narchive_football_data home_team samples:")
    for r in rows: print(f"  {r[0]}")
except: print("No archive_football_data")

# Check international_results
try:
    rows = conn.execute("SELECT DISTINCT home_team FROM international_results LIMIT 50").fetchall()
    print("\ninternational_results home_team samples:")
    for r in rows: print(f"  {r[0]}")
except: print("No international_results")

# Check matches table columns
try:
    cols = conn.execute("PRAGMA table_info(matches)").fetchall()
    print("\nmatches columns:", [c[1] for c in cols])
except: pass
