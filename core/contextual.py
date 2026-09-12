"""
contextual.py — Contextual Adjustment Coefficient (CAC)

Agrège les facteurs QUALITATIFS déjà produits par le pipeline (absences/blessures,
échéance européenne imminente, repos, enjeu) en UN coefficient multiplicateur borné
[0.85, 1.15] appliqué par ÉQUIPE sur les probabilités 1X2 finales (renormalisation
absorbant l'effet — même pattern que le boost PWR dans prediction_engine.py).

Source de vérité des données : le bloc JSON `match.context` (schéma ctx_v1) assemblé
côté Node (enrichMatch). En son absence, repli sur les champs legacy de match_obj
(news_data.injuries, days_since_last_match_*, absence_impact PixelRAG/Sofascore).

Python calcule, JS affiche : aucune autre implémentation du CAC ne doit exister.
Poids externalisés : config/contextual_weights.json (lus aussi par le JS pour
l'affichage des seuils, jamais pour re-clip).

Activation : CONTEXTUAL_CAC_ENABLED=on (défaut off). En off, mode SHADOW :
le bloc contre-factuel (cac_home/cac_away/facteurs/alertes) est quand même
calculé et sérialisé — LivePredictionJournal l'enregistre pour l'analyse A/B
(on/off) sur data/live_prediction_journal.jsonl avant toute activation.
"""
import json
import os
from functools import lru_cache

# Contract de borne — ne pas changer sans re-calibrer les tests du frontend.
CAC_MIN = 0.85
CAC_MAX = 1.15

DEFAULT_WEIGHTS = {
    "version": 1,
    "bounds": {"min": CAC_MIN, "max": CAC_MAX},
    "injury_per_point": 0.02,
    "europe_next": {"knockout": 0.05, "group": 0.03, "min_gap_days": 0.5, "max_gap_days": 4.5},
    "rest_hours": {"lt48": 0.06, "lt72": 0.03},
    "stake": {
        "TITLE": 0.04,
        "RELEGATION": 0.03,
        "EUROPE_RACE": 0.02,
        "STANDARD": 0.0,
        "DEAD_RUBBER": -0.05,
        "FRIENDLY": -0.03,
    },
}

_WEIGHTS_PATH = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), 'config', 'contextual_weights.json')


@lru_cache(maxsize=1)
def load_weights():
    """Poids config par-dessus défauts (fusion profonde à 2 niveaux)."""
    merged = json.loads(json.dumps(DEFAULT_WEIGHTS))
    try:
        with open(_WEIGHTS_PATH, 'r', encoding='utf-8') as f:
            user = json.load(f)
        for k, v in (user or {}).items():
            if isinstance(v, dict) and isinstance(merged.get(k), dict):
                merged[k].update(v)
            else:
                merged[k] = v
    except Exception:
        pass
    return merged


def contextual_enabled():
    return os.environ.get('CONTEXTUAL_CAC_ENABLED', 'off').lower() in ('on', '1', 'true')


def _num(v):
    try:
        f = float(v)
        return f if f == f else None
    except (TypeError, ValueError):
        return None


def compute_cac(team_ctx, weights=None):
    """
    team_ctx : {injury_impact: float(points rôles), european_next: {comp,stage,gap_days},
                rest_hours: float, motivation: 'TITLE'|'RELEGATION'|...|None}
    -> {'cac', 'factors': [{type, delta, detail}], 'alerts': [...], 'clamped': bool}
    """
    w = weights or load_weights()
    team_ctx = team_ctx or {}
    factors = []
    alerts = []

    # 1) Absences / blessures (somme de poids par rôle, cf. calculate_injury_impact)
    imp = _num(team_ctx.get('injury_impact')) or 0.0
    if imp > 0:
        d = -w['injury_per_point'] * imp
        factors.append({'type': 'injuries', 'delta': round(d, 4), 'detail': f'impact {imp:.1f} pts'})
        if imp >= 3:
            alerts.append(f"🟠 {imp:.0f} pts d'absences (joueurs clés)")

    # 2) Coupe d'Europe à J+0.5..4.5 (risque de rotation)
    eu = team_ctx.get('european_next') or None
    if isinstance(eu, dict):
        gap = _num(eu.get('gap_days'))
        if gap is not None and w['europe_next']['min_gap_days'] <= gap <= w['europe_next']['max_gap_days']:
            stage = str(eu.get('stage') or 'group').lower()
            d = -w['europe_next']['knockout'] if stage == 'knockout' else -w['europe_next']['group']
            comp = str(eu.get('comp') or 'Europe')
            factors.append({'type': 'europe_next', 'delta': d, 'detail': f'{comp} J+{gap:.0f} ({stage})'})
            alerts.append(f"🔴 Rotation probable : {comp} dans {gap:.0f} j")

    # 3) Repos < 72h / < 48h
    rest = _num(team_ctx.get('rest_hours'))
    if rest is not None:
        if rest < 48:
            d = -w['rest_hours']['lt48']
            factors.append({'type': 'rest', 'delta': d, 'detail': f'{rest:.0f}h < 48h'})
            alerts.append(f"🟡 Repos {rest:.0f}h < 48h")
        elif rest < 72:
            d = -w['rest_hours']['lt72']
            factors.append({'type': 'rest', 'delta': d, 'detail': f'{rest:.0f}h < 72h'})
            alerts.append(f"🟡 Repos {rest:.0f}h < 72h")

    # 4) Enjeu / motivation
    label = str(team_ctx.get('motivation') or 'STANDARD').upper()
    s_d = _num(w['stake'].get(label))
    if s_d:
        factors.append({'type': 'motivation', 'delta': s_d, 'detail': label})
        if label == 'DEAD_RUBBER':
            alerts.append('⚪ Match sans enjeu (dead rubber)')

    raw_cac = 1.0 + sum(f['delta'] for f in factors)
    lo, hi = w['bounds']['min'], w['bounds']['max']
    cac = max(lo, min(hi, raw_cac))
    return {
        'cac': round(cac, 3),
        'factors': factors,
        'alerts': alerts,
        'clamped': cac != raw_cac,
    }


def build_team_ctx(match_obj, side, team_name=None):
    """
    Extrait le contexte d'un côté ('home'|'away') — ctx_v1 prioritaire,
    repli sur les champs legacy du payload Node/PixelRAG.
    """
    match_obj = match_obj or {}
    ctx_root = match_obj.get('context') if isinstance(match_obj.get('context'), dict) else {}
    side_data = {}
    if isinstance(ctx_root.get('teams'), dict) and isinstance(ctx_root['teams'].get(side), dict):
        side_data = ctx_root['teams'][side]

    name = team_name or match_obj.get(f'{side}Team', '')

    # injury_impact : ctx_v1 > calculate_injury_impact(news_data) > absence_impact*10
    impact = _num(side_data.get('injury_impact'))
    if impact is None:
        impact = 0.0
        try:
            from ml_history import calculate_injury_impact
            impact = float(calculate_injury_impact(match_obj.get('news_data'), name) or 0.0)
        except Exception:
            pass
        if impact == 0.0:
            ai = _num(match_obj.get(f'{side}_absence_impact'))
            if ai is not None:
                impact = ai * 10.0  # compute_absence_impact sature à 1.0 → échelle points

    eu = side_data.get('european_next')
    if eu is None:
        legacy = match_obj.get(f'{side}_european_next')
        eu = legacy if isinstance(legacy, dict) else None

    rest = _num(side_data.get('rest_hours'))
    if rest is None:
        days = _num(match_obj.get(f'days_since_last_match_{side}'))
        if days is not None and days > 0 and days < 90:
            rest = days * 24.0

    motivation = side_data.get('motivation') or match_obj.get(f'{side}_motivation_label')

    return {
        'injury_impact': impact,
        'european_next': eu,
        'rest_hours': rest,
        'motivation': motivation or 'STANDARD',
    }


def apply_contextual_cac(match_obj, p_h, p_d, p_a, weights=None):
    """
    Applique le CAC par équipe sur le triplet (0-1) et renormalise.
    Retourne (p_h, p_d, p_a, block). block n'est JAMAIS None — traçabilité A/B.

    Mode SHADOW (flag OFF par défaut) : le bloc est quand même calculé
    (contre-factuel cac_home/cac_away, facteurs, alertes) sans toucher aux
    probabilités. block['enabled'] = VRAI seulement quand la multiplication a
    réellement eu lieu ; block['shadow'] = True en mode observation.
    LivePredictionJournal enregistre ce bloc → analyse A/B on/off possible
    dès le premier jour, avant toute activation.
    """
    applied = contextual_enabled()
    w = weights or load_weights()
    home_name = match_obj.get('homeTeam', 'Home')
    away_name = match_obj.get('awayTeam', 'Away')
    rh = compute_cac(build_team_ctx(match_obj, 'home', home_name), w)
    ra = compute_cac(build_team_ctx(match_obj, 'away', away_name), w)

    pre = (p_h, p_d, p_a)
    nh, nd, na = p_h, p_d, p_a
    if applied:
        nh = p_h * rh['cac']
        na = p_a * ra['cac']
        s = nh + p_d + na
        if s > 0:
            nh, nd, na = nh / s, p_d / s, na / s

    block = {
        'enabled': bool(applied),
        'shadow': not applied,
        'schema': 'ctx_v1',
        'cac_home': rh['cac'],
        'cac_away': ra['cac'],
        'clamped': {'home': rh['clamped'], 'away': ra['clamped']},
        'factors': [dict(f, side='home') for f in rh['factors']] + [dict(f, side='away') for f in ra['factors']],
        'alerts': {'home': rh['alerts'], 'away': ra['alerts']},
        'prob_shift_pp': {
            'home': round((nh - pre[0]) * 100, 2),
            'draw': round((nd - pre[1]) * 100, 2),
            'away': round((na - pre[2]) * 100, 2),
        },
        'weights_version': w.get('version', 1),
    }
    return nh, nd, na, block
