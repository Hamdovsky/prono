"""monitor_cache.py — health check du pipeline SofaScore/cache.

Verifie :
  - fraicheur de data/odds_cache.json (entrees expiring bientot / expirees)
  - nombre total de matchs et part de source=sofascore
  - si le cache est vide ou plus frais que le TTL

Usage:
    python scripts/monitor_cache.py [--ttl 6]
Retour: 0 = sain, 1 = alerte (stale/vide)
"""
import os
import sys
import json
import time
import argparse

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, 'data')
CACHE = os.path.join(DATA_DIR, 'odds_cache.json')
MATCHES = os.path.join(DATA_DIR, 'today_matches.json')


def monitor(ttl_hours=6):
    now = int(time.time() * 1000)
    ttl_ms = ttl_hours * 60 * 60 * 1000
    problems = []

    # 1) today_matches.json
    n_matches = 0
    if os.path.exists(MATCHES):
        try:
            with open(MATCHES, 'r', encoding='utf-8') as f:
                n_matches = len(json.load(f))
        except Exception as ex:
            problems.append(f'today_matches.json illisible: {ex}')
    else:
        problems.append('today_matches.json absent')

    # 2) odds_cache.json
    cache = {}
    if os.path.exists(CACHE):
        try:
            with open(CACHE, 'r', encoding='utf-8') as f:
                cache = json.load(f)
        except Exception as ex:
            problems.append(f'odds_cache.json illisible: {ex}')
            cache = {}
    else:
        problems.append('odds_cache.json absent')

    total = len(cache)
    sofascore = sum(1 for v in cache.values() if isinstance(v, dict) and v.get('source') == 'sofascore')
    stale = sum(1 for v in cache.values()
                if isinstance(v, dict) and v.get('scrapedAt') and (now - v.get('scrapedAt')) > ttl_ms)
    freshest = max((v.get('scrapedAt', 0) for v in cache.values()
                   if isinstance(v, dict) and v.get('scrapedAt')), default=0)
    age_min = round((now - freshest) / 60000) if freshest else None

    if total == 0:
        problems.append('CACHE VIDE')
    if n_matches and sofascore == 0:
        problems.append('AUCUNE entree source=sofascore')
    if stale:
        problems.append(f'{stale} entrees expirees (TTL {ttl_hours}h depassee)')
    if age_min is not None and age_min > ttl_hours * 60:
        problems.append(f'cache trop vieux: {age_min} min')

    status = 'ALERT' if problems else 'OK'
    line = (f'[HEALTH] {status} | matches_fixtures={n_matches} '
            f'cache_total={total} sofascore={sofascore} expirees={stale} '
            f'age_min={age_min}')
    print(line)
    for p in problems:
        print(f'[HEALTH]   - {p}')
    return 1 if problems else 0


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--ttl', type=int, default=6, help='TTL cache en heures')
    args = ap.parse_args()
    sys.exit(monitor(args.ttl))
