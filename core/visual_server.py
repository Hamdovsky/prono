"""
Visual RAG server (PixelRAG-lite) — local, CPU-friendly.

Sert le contrat d'API de PixelRAG (https://github.com/StarTrail-org/PixelRAG)
sur les endpoints /search, /ingest, /embed, /visual/enrich utilisé par
services/pixelragService.js.

Embedder : CLIP (transformers) si disponible, sinon embeddings PIL
heuristiques (moments de couleur + histogrammes + densité de contours).
Aucun GPU requis : conçu pour tourner sur i5 8th gen / 8 Go RAM.

Port : 30002 (env VISION_PORT). Index persisté dans data/visual/visual_index.jsonl
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
                }
    except Exception as e:
        print(f'[visual_server] index load error: {e}')


def _save_index():
    os.makedirs(os.path.dirname(INDEX_FILE), exist_ok=True)
    tmp = INDEX_FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        for aid, rec in _INDEX.items():
            f.write(json.dumps({'article_id': aid, 'embedding': rec['embedding'], 'path': rec['path'], 'ts': rec['ts']}) + '\n')
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