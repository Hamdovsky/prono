"""
Production Health Monitor
Run: python scripts/monitor_production.py
"""
import json
import urllib.request
import sys
import time

SERVICES = [
    {"name": "prono-k6gc (Node)", "url": "https://prono-k6gc.onrender.com/api/health", "expect": "ONLINE"},
    {"name": "prono-fastapi (Python)", "url": "https://prono-fastapi.onrender.com/health", "expect": "healthy"},
    {"name": "prono-scraper", "url": "https://prono-scraper.onrender.com/api/health", "expect": "ONLINE"},
    {"name": "Swagger UI", "url": "https://prono-k6gc.onrender.com/api-docs", "expect": None},
]

def check(url, timeout=20):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": "Monitor/1.0"})
        resp = urllib.request.urlopen(req, timeout=timeout)
        return resp.status, resp.read().decode()[:2000]
    except urllib.error.HTTPError as e:
        return e.code, ""
    except Exception as e:
        return None, str(e)

def main():
    print(f"=== Production Monitor [{time.strftime('%Y-%m-%d %H:%M:%S')}] ===\n")
    all_ok = True
    
    for svc in SERVICES:
        status, body = check(svc["url"])
        ok = False
        
        if status == 200:
            if svc["expect"] is None:
                ok = True
                print(f"  {svc['name']}: OK (HTTP {status})")
            else:
                try:
                    data = json.loads(body)
                    status_field = data.get("status", "")
                    ok = status_field == svc["expect"]
                    if ok:
                        mem = data.get("memory", {})
                        rss = mem.get("rss", "?")
                        print(f"  {svc['name']}: OK (status={status_field}, rss={rss}MB)")

                    else:
                        print(f"  {svc['name']}: FAIL (status={status_field}, expected={svc['expect']})")
                except:
                    ok = status == 200
                    print(f"  {svc['name']}: OK (HTTP {status})")
        else:
            print(f"  {svc['name']}: FAIL (HTTP {status or 'timeout'})")
        
        if not ok:
            all_ok = False
    
    print()
    if all_ok:
        print("ALL SERVICES OK")
    else:
        print("SOME SERVICES DOWN - CHECK ALERTS")
        sys.exit(1)

if __name__ == "__main__":
    main()
