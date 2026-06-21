import sqlite3
import pandas as pd
import os
from collections import Counter

DB_TACTICAL = os.path.join('data', 'tactical.db')
DB_ARCHIVE = os.path.join('data', 'historical_archive.sqlite')

all_teams = []

if os.path.exists(DB_TACTICAL):
    conn = sqlite3.connect(DB_TACTICAL)
    df = pd.read_sql_query("SELECT homeTeam, awayTeam FROM matches", conn)
    all_teams.extend(df['homeTeam'].tolist())
    all_teams.extend(df['awayTeam'].tolist())
    conn.close()

if os.path.exists(DB_ARCHIVE):
    conn = sqlite3.connect(DB_ARCHIVE)
    df = pd.read_sql_query("SELECT homeTeam, awayTeam FROM archive_matches", conn)
    all_teams.extend(df['homeTeam'].tolist())
    all_teams.extend(df['awayTeam'].tolist())
    conn.close()

counts = Counter(all_teams)
print("Top 20 teams by match count:")
for team, count in counts.most_common(20):
    print(f"  {team}: {count}")

print(f"\nTotal matches: {len(all_teams)//2}")
print(f"Total unique teams: {len(counts)}")
