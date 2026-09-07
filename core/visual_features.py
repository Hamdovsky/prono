"""
Features visuelles (PixelRAG-lite) injectées dans le payload avant prédiction.

Consomme match_data['visual_context'] (construit par services/visualEnrichmentService.js)
et expose des colonnes numériques exploitables par l'entraînement XGBoost :

    visual_confidence   : robustesse de l'enrichissement (0 si absent)
    visual_tiles_n      : nombre de vues/tiles retrouvées
    visual_max_score    : similarité max (top-1)
    visual_mean_score   : similarité moyenne
    visual_covers       : binaire — des vues visuelles existent dans l'index
    visual_has_lineup   : une tile référence une composition
    visual_has_form     : une tile référence le forme matchs
    visual_wiki_confidence : meilleur score des tuiles Wikipédia (vrai PixelRAG)
    visual_wiki_hits       : nombre de tuiles Wikipédia
    visual_wiki_has_squad  : une tuile wiki parle effectif/joueurs
    visual_wiki_has_history: une tuile wiki parle historique/saison
"""


def _num(v, default=0.0):
    try:
        f = float(v)
        if f != f:  # NaN
            return default
        return f
    except (TypeError, ValueError):
        return default


def extract_visual_features(match_data: dict) -> dict:
    """Mutate match_data in place (ajoute les colonnes visual_*)."""
    vc = match_data.get('visual_context') or {}
    if not isinstance(vc, dict):
        vc = {}

    scores = vc.get('scores') or []
    tiles = vc.get('tiles') or []
    if not isinstance(scores, list):
        scores = []
    if not isinstance(tiles, list):
        tiles = []

    tile_titles = []
    for t in tiles:
        if isinstance(t, dict):
            tt = str(t.get('title', t.get('article_id', ''))).lower()
        else:
            tt = str(t).lower()
        tile_titles.append(tt)
    joined_titles = ' '.join(tile_titles)

    # Tuiles du VRAI PixelRAG hébergé (source='wikipedia', ajouté par
    # visualEnrichmentService) — contexte historique/effectif.
    wiki_tiles = [t for t in tiles if isinstance(t, dict) and t.get('source') == 'wikipedia']
    wiki_scores = [_num(t.get('score'), 0.0) for t in wiki_tiles]
    wiki_titles = ' '.join(
        str(t.get('title', t.get('article_id', ''))).lower() for t in wiki_tiles
    )

    features = {
        'visual_confidence': _num(vc.get('visual_confidence', 1.0 if scores or tiles else 0.0)),
        'visual_tiles_n': float(len(tiles)),
        'visual_max_score': _num(max(scores, default=0.0)),
        'visual_mean_score': _num(float(sum(scores)) / len(scores)) if scores else 0.0,
        'visual_covers': 1.0 if (tiles or (vc.get('screenshot_paths')) or vc.get('article_ids')) else 0.0,
        'visual_has_lineup': 1.0 if ('lineup' in joined_titles or 'composition' in joined_titles) else 0.0,
        'visual_has_form': 1.0 if ('form' in joined_titles or 'latest' in joined_titles) else 0.0,
        'visual_has_xg': 1.0 if ('xg' in joined_titles or 'expected' in joined_titles or 'xgoals' in joined_titles) else 0.0,
        'visual_wiki_confidence': max(wiki_scores) if wiki_scores else 0.0,
        'visual_wiki_hits': float(len(wiki_tiles)),
        'visual_wiki_has_squad': 1.0 if ('squad' in wiki_titles or 'players' in wiki_titles or 'roster' in wiki_titles) else 0.0,
        'visual_wiki_has_history': 1.0 if ('history' in wiki_titles or 'season' in wiki_titles) else 0.0,
    }
    match_data.update(features)
    return features