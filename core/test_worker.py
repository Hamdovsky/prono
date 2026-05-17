import sys
import time
print("READY", flush=True)
while True:
    line = sys.stdin.readline()
    if not line: break
    print('{"test": true}')
    sys.stdout.flush()
