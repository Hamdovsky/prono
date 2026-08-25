"""
cacheSofascoreOdds.py — alimente data/odds_cache.json depuis SofaScore (live, gratuit).

Pipeline local (sans clé API) :
  1. Lit data/today_matches.json (fixtures générées par soccerdataService)
  2. Pour chaque match, résout l'eventId SofaScore (depuis today_matches si présent,
     sinon recherche par équipes) et récupère 1X2 / O-U 2.5 / BTTS / Corners + xG/shots
  3. Écrit data/odds_cache.json (clé = "<home>-<away>-<date>") consommé par
     OddsFusionEngine._tier1a_sofascore

Usage:
    python scripts/cacheSofascoreOdds.py [--date YYYY-MM-DD] [--limit N]
"""

import os
import sys
import json
import time
import argparse
import logging
from concurrent.futures import ThreadPoolExecutor, as_completed

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE_DIR, 'services'))
DATA_DIR = os.path.join(BASE_DIR, 'data')

logging.basicConfig(level=logging.INFO, format='[CACHE-SOFA] %(message)s')
log = logging.getLogger('cacheSofascoreOdds')

DEFAULT_TTL_MS = 6 * 60 * 60 * 1000  # 6h par défaut


def normalize_key(home, away, date):
    def slug(s):
        return ''.join(c for c in str(s).lower() if c.isalnum())
    return f"{slug(home)}-{slug(away)}-{date}"


def run(date=None, limit=None, workers=5, ttl_ms=DEFAULT_TTL_MS):
    import importlib.util
    spec = importlib.util.spec_from_file_location(
        "sofascoreClient", os.path.join(BASE_DIR, "services", "sofascoreClient.py")
    )
    sofa_mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(sofa_mod)
    SofascoreClient = sofa_mod.SofascoreClient

    client = SofascoreClient()
    if not client.enabled:
        log.error("SofaScore désactivé (curl_cffi manquant)")
        return

    matches_path = os.path.join(DATA_DIR, 'today_matches.json')
    if not os.path.exists(matches_path):
        log.error(f"Manquant: {matches_path}")
        return

    with open(matches_path, 'r', encoding='utf-8') as f:
        matches = json.load(f)

    if date:
        matches = [m for m in matches if (m.get('date') or '').startswith(date)]
    if limit:
        matches = matches[:limit]

    # Résolution SofaScore par nom (contourne le 404 du listing par date)
    def resolve_event_id(match, home, away, date_m):
        # 1. Depuis le match si déjà fourni (id numérique SofaScore)
        for fld in ('sofascore_id', 'sofascoreId'):
            eid = match.get(fld)
            if eid and str(eid).isdigit():
                return str(eid)
        # 2. Recherche par équipes : search/all -> team -> events
        d = (date_m or '')[:10]
        return client.resolve_event_id(home, away, d)

    cache_path = os.path.join(DATA_DIR, 'odds_cache.json')
    prev = {}
    if os.path.exists(cache_path):
        try:
            with open(cache_path, 'r', encoding='utf-8') as f:
                prev = json.load(f)
            if isinstance(prev, list):
                prev = {}
        except Exception:
            prev = {}

    # 1) Résolution des eventId (séquentiel, peu coûteux)
    todo = []
    for m in matches:
        home = m.get('home') or m.get('home_team')
        away = m.get('away') or m.get('away_team')
        if not home or not away:
            continue
        date_m = m.get('date', '')
        event_id = resolve_event_id(m, home, away, date_m)
        if not event_id:
            log.warning(f"Pas d'eventId SofaScore pour {home} vs {away} -> skip")
            continue
        todo.append((m, home, away, date_m, event_id))

    # 2) Fetch parallèle (chaque thread a sa propre session TLS)
    merged = dict(prev)  # copie ; sera purgé du TTL à la fin
    resolved = 0

    def fetch_one(item, idx):
        m, home, away, date_m, event_id = item
        full = client.fetch_match_full_parallel(event_id, profile_idx=idx)
        if not full or not full.get('home'):
            log.info(f"Pas de cotes pour {home} vs {away} (event {event_id})")
            return None
        return (
            normalize_key(home, away, date_m),
            {
                "homeTeam": home,
                "awayTeam": away,
                "league": m.get('league', ''),
                "sofascore_id": event_id,
                "source": "sofascore",
                "scrapedAt": full.get("scraped_at"),
                "home": full.get("home"),
                "draw": full.get("draw"),
                "away": full.get("away"),
                "over25": full.get("over25"),
                "under25": full.get("under25"),
                "btts_yes": full.get("btts_yes"),
                "btts_no": full.get("btts_no"),
                "corners_over": full.get("corners_over"),
                "corners_line": full.get("corners_line"),
                "corners_under": full.get("corners_under"),
                "home_xg": full.get("home_xg"),
                "away_xg": full.get("away_xg"),
                "shots_h": full.get("shots_h"),
                "shots_a": full.get("shots_a"),
                "url": f"https://www.sofascore.com/event/{event_id}",
            },
        )

    log.info(f"🚀 Démarrage parallèle: {len(todo)} matchs, {workers} workers")
    start = time.time()
    with ThreadPoolExecutor(max_workers=workers) as ex:
        futures = {ex.submit(fetch_one, item, i % len(SofascoreClient.TLS_PROFILES)
                             if hasattr(SofascoreClient, 'TLS_PROFILES') else i % 3): item
                   for i, item in enumerate(todo)}
        for fut in as_completed(futures):
            res = fut.result()
            if res:
                key, entry = res
                merged[key] = entry
                resolved += 1
                e = entry
                log.info(f"OK {e['homeTeam']} vs {e['awayTeam']}: 1X2={e['home']}/{e['draw']}/{e['away']} OU={e['over25']}/{e['under25']} BTTS={e['btts_yes']}/{e['btts_no']} CORN={e['corners_over']}/{e['corners_under']}")

    # 3) Purge TTL : on ne garde les anciennes entrées que si non expirées
    now = int(time.time() * 1000)
    kept_old = 0
    final_cache = {}
    for k, v in merged.items():
        sa = v.get("scrapedAt") if isinstance(v, dict) else None
        if sa and (now - sa) > ttl_ms:
            continue  # expirée
        final_cache[k] = v
        if k not in {x[0] for x in (res for res in [] if False)}:  # no-op guard
            pass
    # Compter les entrées héritées (non renouvelées ce run mais encore valides)
    refreshed_keys = {item and normalize_key(item[1], item[2], item[3]) for item in todo}
    for k, v in final_cache.items():
        if k not in refreshed_keys:
            kept_old += 1

    tmp_path = cache_path + ".tmp"
    with open(tmp_path, 'w', encoding='utf-8') as f:
        json.dump(final_cache, f, indent=2, ensure_ascii=False)
    os.replace(tmp_path, cache_path)

    log.info(f"Cache écrit: {resolved} nouveaux, {kept_old} conservés (TTL), "
             f"{len(final_cache)} total -> {cache_path} en {round(time.time()-start,1)}s")


if __name__ == '__main__':
    ap = argparse.ArgumentParser()
    ap.add_argument('--date', help='Filtrer les matchs par date (YYYY-MM-DD)')
    ap.add_argument('--limit', type=int, help='Limite de matchs à traiter')
    ap.add_argument('--workers', type=int, default=5, help='Requêtes simultanées (défaut 5)')
    ap.add_argument('--ttl', type=int, default=6, help='TTL cache en heures (défaut 6)')
    args = ap.parse_args()
    run(date=args.date, limit=args.limit, workers=args.workers,
        ttl_ms=args.ttl * 60 * 60 * 1000)
