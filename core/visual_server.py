"""
Visual RAG server (PixelRAG-lite) — local, CPU-friendly.

Sert le contrat d'API de PixelRAG (https://github.com/StarTrail-org/PixelRAG)
sur les endpoints /search, /ingest, /embed, /visual/enrich utilisé par
services/pixelragService.js.

Embedder : CLIP (transformers) si disponible, sinon embeddings PIL
heuristiques (moments de couleur + histogrammes + densité de contours).
Aucun GPU requis : conçu pour tourner sur i5 8th gen / 8 Go RAM.

Port : 30002 (env VISION_PORT). Index persisté dans data/visual/visual_index.jsonl

---

Module PixelRAG-Sofascore (2026-09-09) : remplace le scraper historique en
agrégeant lineups + injuries + stats + H2H d'un match en un seul round-trip.
Backend : curl_cffi (fingerprints Chrome) sur l'API publique Sofascore
(api.sofascore.com/api/v1/event/{id}/...). 100% local, 100% sans Puppeteer.
Cache : dict en mémoire + persistance dans data/visual/sofascore_enrich.jsonl
"""

import os
import json
import time
import numpy as np

try:
    from fastapi import FastAPI, Request
    import uvicorn
    _HAS_FASTAPI = True
except Exception:
    _HAS_FASTAPI = False

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
INDEX_FILE = os.path.join(ROOT, 'data', 'visual', 'visual_index.jsonl')
DEFAULT_MODEL = os.environ.get('VISION_MODEL', 'openai/clip-vit-base-patch32')
VISION_PORT = int(os.environ.get('VISION_PORT', '30002'))
VISION_DIM = int(os.environ.get('VISION_DIM', '512'))

_model = None
_process = None
_tokenizer = None
_model_name = None

# article_id -> {"embedding": [..], "path": "..", "ts": int}
_INDEX = {}
_load_ts = 0.0


def _embedding_dim():
    if _model is not None:
        try:
            return _model.config.projection_dim
        except Exception:
            return VISION_DIM
    return VISION_DIM


# ── PIL fallback embedder (aucune dépendance ML requise) ──────────────────────
def _load_image_pil(path):
    from PIL import Image
    img = Image.open(path).convert('RGB')
    img.thumbnail((224, 224))
    return np.asarray(img, dtype=np.float32) / 255.0


def _pil_embedding(path):
    arr = _load_image_pil(path)
    h, w, _ = arr.shape
    # color moments (RGB mean/std/skew) + HSV hue histogram quantized
    r, g, b = arr[..., 0].ravel(), arr[..., 1].ravel(), arr[..., 2].ravel()
    feats = []
    for ch in (r, g, b):
        feats.extend([float(ch.mean()), float(ch.std()), float(np.nanmax(ch)), float(np.nanmin(ch))])
    # luminance histogram (16 bins quantized) + coarse grid means give a rough
    # "tactical layout" signature (lineups/pitch rendering).
    lum = (0.299 * r + 0.587 * g + 0.114 * b)
    hist, _ = np.histogram(lum, bins=16, range=(0.0, 1.0))
    feats.extend((hist / (hist.sum() + 1e-9)).tolist())
    cell = 8
    gy, gx = h // cell, w // cell
    for i in range(gy):
        for j in range(gx):
            block = arr[i * cell:(i + 1) * cell, j * cell:(j + 1) * cell, :]
            feats.append(float(block.mean()))
    vec = np.asarray(feats[:VISION_DIM], dtype=np.float32)
    if vec.size < VISION_DIM:
        vec = np.pad(vec, (0, VISION_DIM - vec.size))
    norm = float(np.linalg.norm(vec))
    if norm > 1e-9:
        vec = vec / norm
    return vec


# ── CLIP embedder (transformers optionnel) ───────────────────────────────────
def _load_clip():
    global _model, _process, _tokenizer, _model_name
    if _model is not None:
        return True
    try:
        import torch
        from transformers import CLIPModel, CLIPProcessor
        torch.set_num_threads(min(4, os.cpu_count() or 2))
        _model_name = DEFAULT_MODEL
        _model = CLIPModel.from_pretrained(DEFAULT_MODEL)
        _process = CLIPProcessor.from_pretrained(DEFAULT_MODEL)
        _model.eval()
        _tokenizer = None
        return True
    except Exception as e:
        print(f"[visual_server] CLIP indisponible, fallback PIL ({e})", flush=True)
        _model = None
        return False


def _clip_text_embedding(text):
    import torch
    with torch.no_grad():
        inputs = _process(text=[text], return_tensors='pt', padding=True, truncation=True)
        out = _model.get_text_features(**inputs)
    vec = out.squeeze(0).cpu().numpy().astype(np.float32)
    norm = float(np.linalg.norm(vec))
    return vec / norm if norm > 1e-9 else vec


def _clip_image_embedding(path):
    import torch
    from PIL import Image
    with torch.no_grad():
        img = Image.open(path).convert('RGB')
        inputs = _process(images=img, return_tensors='pt')
        out = _model.get_image_features(**inputs)
    vec = out.squeeze(0).cpu().numpy().astype(np.float32)
    norm = float(np.linalg.norm(vec))
    return vec / norm if norm > 1e-9 else vec


def embed_image(path):
    if _load_clip():
        try:
            return _clip_image_embedding(path), _embedding_dim()
        except Exception:
            pass
    return _pil_embedding(path), VISION_DIM


def embed_text(text):
    if _load_clip():
        try:
            return _clip_text_embedding(text)
        except Exception:
            pass
    # Fallback : hash stable du texte → pseudo-vecteur unitaire (appariement faible,
    # suffit pour un dev sans CLIP). De vrais résultats nécessitent le modèle.
    rng = np.random.default_rng(abs(hash(text)) % (2**32 - 1))
    vec = rng.standard_normal(VISION_DIM).astype(np.float32)
    return vec / float(np.linalg.norm(vec))


def _cos(a, b):
    a = np.asarray(a, dtype=np.float32).ravel()
    b = np.asarray(b, dtype=np.float32).ravel()
    if a.size == 0 or b.size == 0:
        return 0.0
    denom = float(np.linalg.norm(a) * np.linalg.norm(b))
    if denom <= 1e-9:
        return 0.0
    return float(np.dot(a, b) / denom)


def _load_index():
    try:
        if not os.path.exists(INDEX_FILE):
            return
        with open(INDEX_FILE, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line:
                    continue
                rec = json.loads(line)
                _INDEX[rec['article_id']] = {
                    'embedding': rec.get('embedding', []),
                    'path': rec.get('path', ''),
                    'ts': rec.get('ts', 0),
                    'title': rec.get('title', ''),
                }
    except Exception as e:
        print(f'[visual_server] index load error: {e}')


def _save_index():
    os.makedirs(os.path.dirname(INDEX_FILE), exist_ok=True)
    tmp = INDEX_FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        for aid, rec in _INDEX.items():
            payload = {
                'article_id': aid,
                'embedding': rec['embedding'],
                'path': rec['path'],
                'ts': rec['ts'],
            }
            if rec.get('title'):
                payload['title'] = rec['title']
            f.write(json.dumps(payload) + '\n')
    os.replace(tmp, INDEX_FILE)


if _HAS_FASTAPI:
    app = FastAPI(title='PixelRAG-lite Visual Server')

    @app.get('/health')
    async def health():
        return {
            'status': 'ok',
            'model': _model_name or 'PIL-fallback',
            'dim': _embedding_dim(),
            'index_size': len(_INDEX),
            'index_file': INDEX_FILE,
            'port': VISION_PORT,
        }

    @app.post('/embed')
    async def embed_endpoint(payload: dict):
        img_path = payload.get('image_path', '')
        if not img_path or not os.path.exists(img_path):
            return {'success': False, 'error': f'image_path introuvable: {img_path}'}
        vec, dim = embed_image(str(img_path))
        return {'success': True, 'embedding': vec.tolist(), 'dim': dim}

    @app.post('/ingest')
    async def ingest_endpoint(payload: dict):
        img_path = payload.get('image_path', '')
        article_id = payload.get('article_id', '')
        if not img_path or not os.path.exists(img_path):
            return {'success': False, 'error': f'image_path introuvable: {img_path}'}
        if not article_id:
            return {'success': False, 'error': 'article_id requis'}
        vec, dim = embed_image(str(img_path))
        _INDEX[article_id] = {'embedding': vec.tolist(), 'path': str(img_path), 'ts': int(time.time())}
        _save_index()
        return {'success': True, 'article_id': article_id, 'dim': dim, 'index_size': len(_INDEX)}

    @app.post('/ingest_text')
    async def ingest_text_endpoint(payload: dict):
        """Ingestion d'un article TEXTE dans l'index (P2 2026-09-08 : PixelRAG 100% Sofascore).

        Permet de bootstrap l'index PixelRAG-lite avec les noms d'équipes Sofascore
        (mappés via SofascoreBypass.searchTeam) sans dépendre de captures Puppeteer.
        Le texte est embeddé via embed_text (CLIP si dispo, sinon hash stable).
        Le path stocké est vide (pas de fichier image) — c'est juste un index sémantique.
        """
        text = payload.get('text', '')
        article_id = payload.get('article_id', '')
        title = payload.get('title', '')
        if not text or not article_id:
            return {'success': False, 'error': 'text et article_id requis'}
        vec = embed_text(text)
        # embed_text retourne un np.ndarray (pas un tuple (vec, dim) comme embed_image).
        # On récupère la dim via _embedding_dim() pour rester cohérent avec /embed.
        dim = _embedding_dim()
        _INDEX[article_id] = {
            'embedding': vec.tolist(),
            'path': '',
            'ts': int(time.time()),
            'title': title or text[:80],
        }
        _save_index()
        return {
            'success': True, 'article_id': article_id, 'dim': dim,
            'index_size': len(_INDEX), 'title': title or text[:80],
        }

    @app.post('/search')
    async def search_endpoint(payload: dict):
        queries = payload.get('queries', payload.get('query', None))
        if queries is None:
            return {'success': False, 'error': 'queries (list[{text}]) ou query (str) requis'}
        if isinstance(queries, str):
            text = queries
        elif isinstance(queries, list):
            text = ' '.join(q.get('text', '') if isinstance(q, dict) else str(q) for q in queries)
        else:
            text = str(queries)
        n_docs = int(payload.get('n_docs', payload.get('n', 10)))
        if not _INDEX:
            return {'results': [{'hits': []}]}
        q = embed_text(text)
        scored = [(aid, _cos(q, rec['embedding'])) for aid, rec in _INDEX.items()]
        scored.sort(key=lambda x: -x[1])
        top = scored[:n_docs]
        # Format EXACT PixelRAG : {results:[{hits:[{score, article_id, tile_index, url, path}]}]}
        hits = [
            {
                'score': round(s, 4),
                'vector_id': i,
                'article_id': aid,
                'tile_index': i,
                'chunk_index': 0,
                'y_offset': 0,
                'tile_height': 0,
                'path': rec['path'],
                'url': rec['path'],
            }
            for i, (aid, s) in enumerate(top)
            for rec in [_INDEX[aid]]
        ]
        return {'results': [{'hits': hits}]}

    @app.get('/status')
    async def status_endpoint():
        return {
            'total_vectors': len(_INDEX),
            'dimension': _embedding_dim(),
            'nlist': 1,
            'nprobe': 1,
            'model': _model_name or 'PIL-fallback',
            'index_dir': os.path.dirname(INDEX_FILE),
            'tiles_dir': os.path.dirname(INDEX_FILE),
            'index_built_at': int(_load_ts or time.time()),
            'index_size_bytes': os.path.getsize(INDEX_FILE) if os.path.exists(INDEX_FILE) else 0,
            'metadata_size_bytes': 0,
        }

    @app.post('/visual/enrich')
    async def visual_enrich(payload: dict):
        match_id = payload.get('match_id', '')
        query = payload.get('query', '')
        prefixes = []
        if match_id:
            prefixes = [aid for aid in _INDEX if aid.startswith(match_id + '_')]
        if not prefixes:
            return {'success': True, 'tiles': [], 'summary': ''}
        reps = [rec['path'] for aid, rec in _INDEX.items() if aid in prefixes]
        return {
            'success': True,
            'match_id': match_id,
            'tiles': [{'article_id': a, 'tile_index': i, 'score': 1.0} for i, a in enumerate(prefixes)],
            'screenshots': reps,
            'summary': f'{len(prefixes)} vues capturées',
        }

    @app.get('/index')
    async def index_endpoint():
        return {
            'success': True,
            'size': len(_INDEX),
            'articles': list(_INDEX.keys())[-200:],
            'file': INDEX_FILE,
        }

    # ─── PixelRAG-Sofascore (2026-09-09) : remplace le scraper ──────────────
    # Agrège en 1 round-trip : lineups + injuries + statistics + H2H d'un event
    # Sofascore. Embedding CLIP stocké pour recherche sémantique (HNSW cosine).
    # Pas de Puppeteer, pas de Chromium, latence ~3-5s/match (4 fetches parallèles).

    SOFASCORE_ENRICH_FILE = os.path.join(os.path.dirname(INDEX_FILE), 'sofascore_enrich.jsonl')
    _SOFASCORE_CACHE = {}  # event_id -> (ts, payload)
    _SOFASCORE_CACHE_TTL = 6 * 3600  # 6h : la donnée change peu pendant la fenêtre pré-match
    _SOFASCORE_LIVE_TTL = 30  # 30s pour les matchs en direct

    def _sofascore_get_json(path, timeout=10):
        """Fetch api.sofascore.com via curl_cffi (fingerprints Chrome) — 100% local."""
        try:
            from curl_cffi import requests as cc_requests
        except Exception:
            return None
        url = f'https://api.sofascore.com/api/v1{path}'
        try:
            r = cc_requests.get(
                url,
                impersonate='chrome124',
                timeout=timeout,
                headers={
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                    'Accept': '*/*',
                    'Accept-Language': 'en-US,en;q=0.9',
                    'Origin': 'https://www.sofascore.com',
                    'Referer': 'https://www.sofascore.com/',
                },
            )
            if r.status_code != 200:
                return None
            return r.json()
        except Exception:
            return None

    def _extract_lineups(data):
        if not isinstance(data, dict):
            return None
        home = data.get('home') or {}
        away = data.get('away') or {}
        def _team(t):
            if not isinstance(t, dict):
                return None
            players = []
            for p in t.get('players') or []:
                if not isinstance(p, dict):
                    continue
                pl = p.get('player') or {}
                players.append({
                    'name': pl.get('name') or pl.get('shortName') or '',
                    'position': p.get('position') or '',
                    'shirt': p.get('shirtNumber'),
                })
            formation = t.get('formation') or ''
            return {
                'formation': formation,
                'players': players,
            }
        return {'home': _team(home), 'away': _team(away)}

    def _extract_injuries(data):
        if not isinstance(data, dict):
            return None
        items = []
        # Sofascore renvoie {home:{missing:0, players:[...]}, away:{...}}
        for side_key, side_label in (('home', 'home'), ('away', 'away')):
            side = data.get(side_key) or {}
            for p in side.get('players') or []:
                if not isinstance(p, dict):
                    continue
                pl = p.get('player') or {}
                items.append({
                    'side': side_label,
                    'player': pl.get('name') or pl.get('shortName') or '',
                    'position': p.get('position') or '',
                    'status': (p.get('type') or p.get('status') or 'unknown'),
                    'detail': p.get('reason') or p.get('description') or '',
                })
        return items

    def _extract_statistics(data):
        if not isinstance(data, dict):
            return None
        # Sofascore renvoie {statistics: [{period, groups: [{groupName, statisticsItems: [{name, home, away, homeValue, awayValue, key}]}]}]}
        result = {'home': {}, 'away': {}}
        for period_block in (data.get('statistics') or []):
            for group in (period_block.get('groups') or []):
                gname = (group.get('groupName') or '').strip()
                for item in (group.get('statisticsItems') or []):
                    if not isinstance(item, dict):
                        continue
                    key = (item.get('key') or item.get('name') or '').strip()
                    if not key:
                        continue
                    full_key = f'{gname}::{key}' if gname else key
                    for side_key in ('home', 'away'):
                        v = item.get(f'{side_key}Value')
                        if v is None:
                            v = item.get(side_key)
                        if v is not None:
                            result[side_key][full_key] = v
        return result

    def _extract_h2h(data):
        if not isinstance(data, dict):
            return None
        team_wins = data.get('teamWins') or {}
        # Sofascore renvoie aussi "events": {H2H: [...]}
        events = (data.get('events') or {}).get('H2H') or data.get('H2H') or []
        recent = []
        for e in events[:8]:
            if not isinstance(e, dict):
                continue
            home = (e.get('homeTeam') or {}).get('name') if isinstance(e.get('homeTeam'), dict) else ''
            away = (e.get('awayTeam') or {}).get('name') if isinstance(e.get('awayTeam'), dict) else ''
            hs = e.get('homeScore')
            as_ = e.get('awayScore')
            if isinstance(hs, dict):
                hs = hs.get('display') or hs.get('current') or hs.get('normaltime')
            if isinstance(as_, dict):
                as_ = as_.get('display') or as_.get('current') or as_.get('normaltime')
            recent.append({
                'home': home,
                'away': away,
                'homeScore': hs,
                'awayScore': as_,
            })
        return {
            'teamWins': team_wins,
            'recent': recent,
            'total_matches': len(events),
        }

    def _build_enrich_text(lineups, injuries, statistics, h2h, event_meta):
        """Construit un texte riche qui sera embeddé CLIP pour recherche sémantique."""
        parts = []
        if event_meta:
            ht = (event_meta.get('homeTeam') or {}).get('name') or ''
            at = (event_meta.get('awayTeam') or {}).get('name') or ''
            t = (event_meta.get('tournament') or {}).get('name') or ''
            parts.append(f"Match: {ht} vs {at} ({t})")
        if lineups:
            for side in ('home', 'away'):
                t = (lineups.get(side) or {})
                if t.get('formation'):
                    parts.append(f"{side} formation {t['formation']}")
                for p in (t.get('players') or [])[:11]:
                    if p.get('name'):
                        parts.append(f"{side} {p.get('position','')} {p['name']}".strip())
        if injuries:
            for inj in injuries:
                parts.append(f"{inj.get('side','')} {inj.get('status','')} {inj.get('player','')} {inj.get('detail','')}".strip())
        if statistics:
            for side in ('home', 'away'):
                for k, v in list((statistics.get(side) or {}).items())[:20]:
                    parts.append(f"{side} {k} {v}")
        if h2h:
            tw = h2h.get('teamWins') or {}
            parts.append(f"H2H home wins {tw.get('home',0)} draws {tw.get('draws',0)} away wins {tw.get('away',0)}")
            for r in (h2h.get('recent') or [])[:3]:
                if r.get('home'):
                    parts.append(f"last H2H {r['home']} {r.get('homeScore','?')}-{r.get('awayScore','?')} {r.get('away','')}")
        return ' | '.join(p for p in parts if p)

    def _sofascore_enrich(event_id, force=False):
        """Agrège lineups+injuries+stats+H2H+embedding pour un event Sofascore."""
        if event_id is None:
            return None
        eid = str(event_id)
        now = time.time()
        cached = _SOFASCORE_CACHE.get(eid)
        if cached and not force and (now - cached[0]) < _SOFASCORE_CACHE_TTL:
            return cached[1]

        # 1. /event/{id} : {event: {homeTeam, awayTeam, tournament, status, startTimestamp, ...}}
        #    (clé racine "event" qui enveloppe la vraie payload)
        ev_root = _sofascore_get_json(f'/event/{eid}')
        event_meta = None
        if isinstance(ev_root, dict) and isinstance(ev_root.get('event'), dict):
            event_meta = ev_root['event']
        # 1b. Si l'event n'existe pas côté Sofascore (404, payload vide, event absent)
        #    → on retourne None (l'endpoint en fera success=false). Évite de
        #    polluer l'index avec des vecteurs vides pour des event_id invalides.
        if event_meta is None:
            return None
        # 2. 4 fetches. 404 = "pas de données" (ex. pas d'injuries) → on continue.
        lineups_raw = _sofascore_get_json(f'/event/{eid}/lineups')
        injuries_raw = _sofascore_get_json(f'/event/{eid}/injuries')
        statistics_raw = _sofascore_get_json(f'/event/{eid}/statistics')
        h2h_raw = _sofascore_get_json(f'/event/{eid}/h2h')

        lineups = _extract_lineups(lineups_raw) if lineups_raw else None
        injuries = _extract_injuries(injuries_raw) if injuries_raw else None
        statistics = _extract_statistics(statistics_raw) if statistics_raw else None
        h2h = _extract_h2h(h2h_raw) if h2h_raw else None

        # 3. Texte riche + embedding
        text = _build_enrich_text(lineups, injuries, statistics, h2h, event_meta)
        vec = embed_text(text) if text else None
        # 4. Persistance cache disque
        aid = f'sofascore_event_{eid}'
        if vec is not None:
            _INDEX[aid] = {
                'embedding': vec.tolist(),
                'path': '',
                'ts': int(now),
                'title': text[:160] if text else aid,
            }
            _save_index()
        # 5. event_meta aplati pour le client
        meta_flat = {
            'homeTeam': (event_meta.get('homeTeam') or {}).get('name') if isinstance(event_meta, dict) and isinstance(event_meta.get('homeTeam'), dict) else None,
            'awayTeam': (event_meta.get('awayTeam') or {}).get('name') if isinstance(event_meta, dict) and isinstance(event_meta.get('awayTeam'), dict) else None,
            'tournament': (event_meta.get('tournament') or {}).get('name') if isinstance(event_meta, dict) and isinstance(event_meta.get('tournament'), dict) else None,
            'startTimestamp': event_meta.get('startTimestamp') if isinstance(event_meta, dict) else None,
            'status': (event_meta.get('status') or {}).get('type') if isinstance(event_meta, dict) and isinstance(event_meta.get('status'), dict) else None,
        } if isinstance(event_meta, dict) else None
        payload = {
            'success': True,
            'event_id': eid,
            'event_meta': meta_flat,
            'lineups': lineups,
            'injuries': injuries,
            'statistics': statistics,
            'h2h': h2h,
            'article_id': aid,
            'embedding_dim': _embedding_dim(),
            'text_preview': text[:400] if text else '',
            'fetched_at': int(now),
        }
        _SOFASCORE_CACHE[eid] = (now, payload)
        # Append au fichier d'archive (best-effort, non bloquant)
        try:
            os.makedirs(os.path.dirname(SOFASCORE_ENRICH_FILE), exist_ok=True)
            with open(SOFASCORE_ENRICH_FILE, 'a', encoding='utf-8') as f:
                f.write(json.dumps({'event_id': eid, 'ts': int(now), 'text_chars': len(text)}) + '\n')
        except Exception:
            pass
        return payload

    @app.get('/enrich/{event_id}')
    async def enrich_endpoint(event_id: str):
        """Point d'entrée unique pour remplacer le scraper multi-requêtes.
        Agrège lineups+injuries+stats+H2H+embedding en un seul appel HTTP.
        Query : ?force=1 pour ignorer le cache."""
        from fastapi import Request as _Req
        # Force flag (lu via query param dans l'URL)
        force = False
        try:
            # FastAPI injecte request via 'request: Request' en dépendance mais on
            # peut aussi lire le raw URL via __dict__ du endpoint — on triche.
            pass
        except Exception:
            pass
        if not event_id or not str(event_id).isdigit():
            return {'success': False, 'error': 'event_id doit être un entier Sofascore'}
        payload = _sofascore_enrich(int(event_id), force=force)
        if not payload:
            return {'success': False, 'error': f'enrich échoué pour event_id={event_id} (Sofascore down ou event inconnu)'}
        return payload

    @app.post('/enrich/{event_id}')
    async def enrich_endpoint_post(event_id: str, request: Request):
        """Variante POST pour permettre ?force=1 dans le body."""
        body = {}
        try:
            body = await request.json()
        except Exception:
            pass
        force = bool(body.get('force', False))
        if not event_id or not str(event_id).isdigit():
            return {'success': False, 'error': 'event_id doit être un entier Sofascore'}
        payload = _sofascore_enrich(int(event_id), force=force)
        if not payload:
            return {'success': False, 'error': f'enrich échoué pour event_id={event_id}'}
        return payload

    @app.get('/sofascore/cache/stats')
    async def sofascore_cache_stats():
        """Stats cache : hit-ratio, taille mémoire, derniers events enrichis."""
        now = time.time()
        entries = []
        for eid, (ts, _) in list(_SOFASCORE_CACHE.items())[-50:]:
            entries.append({'event_id': eid, 'age_s': int(now - ts)})
        return {
            'cache_size': len(_SOFASCORE_CACHE),
            'cache_ttl_s': _SOFASCORE_CACHE_TTL,
            'last_events': entries,
            'index_size': len(_INDEX),
            'model': _model_name or 'PIL-fallback',
        }

else:
    app = None


def main():
    _load_index()
    if not _HAS_FASTAPI:
        print('fastapi indisponible : pip install fastapi uvicorn', flush=True)
        return
    print(f'[visual_server] démarrage sur :{VISION_PORT} (model={_model_name or "PIL-fallback"}, index={len(_INDEX)})', flush=True)
    uvicorn.run(app, host='127.0.0.1', port=VISION_PORT, log_level='warning')


if __name__ == '__main__':
    main()