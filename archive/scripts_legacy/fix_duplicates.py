import sqlite3

DB_PATH = 'data/historical_archive.sqlite'
conn = sqlite3.connect(DB_PATH)
cur = conn.cursor()

print('=== Fixing duplicates and encoding ===')

# 1. Remove duplicate season entries (2023-2024 vs 2023-24)
# SA1 has "2023-2024" (first run) and "2023-24" (second run)
cur.execute("DELETE FROM archive_football_data WHERE league_code='SA1' AND season_code='2023-2024'")
print(f'Removed SA1 2023-2024 duplicates: {cur.rowcount}')

# ZA1 has "2019-2020" (first run) and "2019-20" (second run) 
cur.execute("DELETE FROM archive_football_data WHERE league_code='ZA1' AND season_code='2019-2020'")
print(f'Removed ZA1 2019-2020 duplicates: {cur.rowcount}')

# 2. Fix Moroccan team name encoding - map garbled characters
fixes = [
    ('Difa� El Jadidi', 'Difaa El Jadidi'),
    ('KAC K�nitra', 'KAC Kenitra'),
    ('Moghreb T�touan', 'Moghreb Tetouan'),
    ('CA Kh�nifra', 'CA Khénifra'),
    ('JS Kasbah Tadla', 'JS Kasbah Tadla'),
    # Fix actual Arabic/French names
    ('Wydad', 'Wydad Casablanca'),
    ('Raja', 'Raja Casablanca'),
    ('FAR Rabat', 'FAR Rabat'),
    ('FUS Rabat', 'FUS Rabat'),
    ('AS FAR', 'AS FAR'),
    ('RSB Berkane', 'RS Berkane'),
    ('RS Berkane', 'RS Berkane'),
    ('OC Khouribga', 'OCK Khouribga'),
    ('OC Safi', 'OC Safi'),
    ('MC Oujda', 'MC Oujda'),
    ('Hassania Agadir', 'Hassania Agadir'),
    ('IR Tanger', 'Ittihad Tanger'),
    ('Maghreb of Fez', 'Maghreb Fez'),
    ('Kawkab Marrakech', 'Kawkab Marrakech'),
    ('CR Hoceima', 'CR Al Hoceima'),
]

for old, new in fixes:
    if '?' in old:
        pattern = old.replace('?', '_')
        cur.execute("UPDATE archive_football_data SET home_team=? WHERE home_team LIKE ? AND league_code='MA1'", (new, pattern))
        c1 = cur.rowcount
        cur.execute("UPDATE archive_football_data SET away_team=? WHERE away_team LIKE ? AND league_code='MA1'", (new, pattern))
        c2 = cur.rowcount
        if c1 + c2 > 0:
            print('Fixed: ' + str(c1 + c2) + ' updates')
    else:
        cur.execute("UPDATE archive_football_data SET home_team=? WHERE home_team=? AND league_code='MA1'", (new, old))
        c1 = cur.rowcount
        cur.execute("UPDATE archive_football_data SET away_team=? WHERE away_team=? AND league_code='MA1'", (new, old))
        c2 = cur.rowcount
        if c1 + c2 > 0:
            print('Fixed: ' + str(c1 + c2) + ' updates')

# Also fix SA1 for Al Wehda
cur.execute("UPDATE archive_football_data SET home_team='Al Wehda' WHERE home_team='Al-Wehda' AND league_code='SA1'")
cur.execute("UPDATE archive_football_data SET away_team='Al Wehda' WHERE away_team='Al-Wehda' AND league_code='SA1'")

# Normalize Al-Ahli -> Al Ahli for SA1
cur.execute("UPDATE archive_football_data SET home_team='Al Ahli' WHERE home_team='Al-Ahli' AND league_code='SA1'")
cur.execute("UPDATE archive_football_data SET away_team='Al Ahli' WHERE away_team='Al-Ahli' AND league_code='SA1'")

# Normalize Al-Ittihad -> Al Ittihad for SA1 
cur.execute("UPDATE archive_football_data SET home_team='Al Ittihad' WHERE home_team='Al-Ittihad' AND league_code='SA1'")
cur.execute("UPDATE archive_football_data SET away_team='Al Ittihad' WHERE away_team='Al-Ittihad' AND league_code='SA1'")

# Normalize Al-Shabab -> Al Shabab
cur.execute("UPDATE archive_football_data SET home_team='Al Shabab' WHERE home_team='Al-Shabab' AND league_code='SA1'")
cur.execute("UPDATE archive_football_data SET away_team='Al Shabab' WHERE away_team='Al-Shabab' AND league_code='SA1'")

# Normalize Al-Fateh -> Al Fateh
cur.execute("UPDATE archive_football_data SET home_team='Al Fateh' WHERE home_team='Al-Fateh' AND league_code='SA1'")
cur.execute("UPDATE archive_football_data SET away_team='Al Fateh' WHERE away_team='Al-Fateh' AND league_code='SA1'")

# Normalize Al-Ettifaq -> Al Ettifaq
cur.execute("UPDATE archive_football_data SET home_team='Al Ettifaq' WHERE home_team='Al-Ettifaq' AND league_code='SA1'")
cur.execute("UPDATE archive_football_data SET away_team='Al Ettifaq' WHERE away_team='Al-Ettifaq' AND league_code='SA1'")

# Al-Faisaly -> Al Faisaly
cur.execute("UPDATE archive_football_data SET home_team='Al Faisaly' WHERE home_team='Al-Faisaly' AND league_code='SA1'")
cur.execute("UPDATE archive_football_data SET away_team='Al Faisaly' WHERE away_team='Al-Faisaly' AND league_code='SA1'")

# Al-Raed -> Al Raed
cur.execute("UPDATE archive_football_data SET home_team='Al Raed' WHERE home_team='Al-Raed' AND league_code='SA1'")
cur.execute("UPDATE archive_football_data SET away_team='Al Raed' WHERE away_team='Al-Raed' AND league_code='SA1'")

# Al-Fayha -> Al Fayha
cur.execute("UPDATE archive_football_data SET home_team='Al Fayha' WHERE home_team='Al-Fayha' AND league_code='SA1'")
cur.execute("UPDATE archive_football_data SET away_team='Al Fayha' WHERE away_team='Al-Fayha' AND league_code='SA1'")

conn.commit()

# Verify counts
cur.execute("SELECT COUNT(*) FROM archive_football_data")
print(f'\nTotal after cleanup: {cur.fetchone()[0]}')

cur.execute("SELECT league_code, COUNT(*) FROM archive_football_data GROUP BY league_code ORDER BY COUNT(*) DESC")
print('\nFinal counts by league:')
for r in cur.fetchall():
    print(f'  {r[0]}: {r[1]}')

conn.close()
