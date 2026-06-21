import sqlite3

DB_PATH = r"c:\Users\HAMDI\Desktop\stitch\data\tactical.db"

def list_ids():
    conn = sqlite3.connect(DB_PATH)
    cur = conn.cursor()
    cur.execute("SELECT id, homeTeam, awayTeam FROM matches WHERE homeTeam LIKE '%Leverkusen%' OR homeTeam LIKE '%Arsenal%'")
    for r in cur.fetchall():
        print(f"ID: {r[0]} | {r[1]} vs {r[2]}")
    conn.close()

if __name__ == "__main__":
    list_ids()
