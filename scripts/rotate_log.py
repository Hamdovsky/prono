"""rotate_log.py — archive le log si > 1 Mo (cron helper, sans dependance externe)."""
import os
import sys

path = sys.argv[1] if len(sys.argv) > 1 else None
if not path:
    sys.exit(0)
try:
    if os.path.exists(path) and os.path.getsize(path) > 1048576:
        old = path + '.1'
        if os.path.exists(old):
            os.remove(old)
        os.rename(path, old)
except Exception:
    pass
