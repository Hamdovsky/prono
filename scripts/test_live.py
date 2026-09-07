import subprocess, json
import os, sys

script = r"C:\Users\HAMDI\Desktop\HamdiProno\stitch\scripts\sofascore_bypass.py"
py = "python"
try:
    res = subprocess.run([py, script, "live"], capture_output=True, text=True, timeout=60, encoding="utf-8", errors="replace")
except FileNotFoundError:
    print("python not found")
    sys.exit(1)

lines = [l for l in res.stdout.splitlines() if l.strip().startswith("{")]
if not lines:
    print("NO JSON in stdout. stderr tail:")
    print(res.stderr[-2000:])
    sys.exit(1)
data = json.loads(lines[-1])
events = data.get("events") or []
print(f"found={data.get('found')} events={len(events)}")
for e in events[:8]:
    o = e.get("odds") or {}
    print(f"  {e.get('homeTeam')} vs {e.get('awayTeam')} | {e.get('homeScore')}-{e.get('awayScore')} | {e.get('minute')} | 1X2: {o.get('home')}/{o.get('draw')}/{o.get('away')}")
