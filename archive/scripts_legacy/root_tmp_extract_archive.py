import gzip, shutil, os
f_in = gzip.open('data/historical_archive.sqlite.gz', 'rb')
f_out = open('data/historical_archive.sqlite', 'wb')
shutil.copyfileobj(f_in, f_out)
f_in.close()
f_out.close()
sz = os.path.getsize('data/historical_archive.sqlite')
print(f'Extracted: {sz/1024/1024:.1f} MB')

# Verify it's valid SQLite
import sqlite3
conn = sqlite3.connect('data/historical_archive.sqlite')
cnt = conn.execute("SELECT COUNT(*) FROM archive_football_data").fetchone()[0]
conn.close()
print(f'Archive has {cnt} matches')
