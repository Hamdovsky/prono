import sqlite3
import os
import json

def scan_dbs():
    for root, dirs, files in os.walk('.'):
        for file in files:
            if file.endswith('.sqlite') or file.endswith('.db'):
                db_path = os.path.join(root, file)
                if 'brain' in db_path or '.gemini' in db_path: continue
                try:
                    conn = sqlite3.connect(db_path)
                    cursor = conn.cursor()
                    cursor.execute("SELECT name FROM sqlite_master WHERE type='table'")
                    tables = [t[0] for t in cursor.fetchall()]
                    for table in tables:
                        cursor.execute(f"PRAGMA table_info({table})")
                        cols = [c[1] for c in cursor.fetchall()]
                        stats_cols = [c for c in cols if any(kw in c.lower() for kw in ['stats', 'full', 'blob', 'json'])]
                        if stats_cols:
                            cursor.execute(f"SELECT COUNT(*) FROM {table}")
                            count = cursor.fetchone()[0]
                            # Check a few rows for actual content
                            cursor.execute(f"SELECT {stats_cols[0]} FROM {table} WHERE {stats_cols[0]} IS NOT NULL LIMIT 5")
                            sample_rows = cursor.fetchall()
                            valid_count = 0
                            for row in sample_rows:
                                if row[0] and len(str(row[0])) > 50: # Likely actual stats
                                    valid_count += 1
                            
                            if valid_count > 0:
                                print(f"💎 FOUND: {db_path} -> Table: {table} ({count} rows, stats in {stats_cols})")
                                # Print a sample
                                print(f"   Sample: {str(sample_rows[0][0])[:100]}...")
                    conn.close()
                except Exception as e:
                    pass

if __name__ == "__main__":
    scan_dbs()
