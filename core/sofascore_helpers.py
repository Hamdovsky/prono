"""
sofascore_helpers.py — utilitaires partagés Python/JS pour les payloads Sofascore.

But : éviter la duplication des helpers entre :
  - services/scrapers/SofascoreBypass.js (computeAbsenceImpact)
  - core/fastapi_server.py (consommateur d'enrich PixelRAG-Sofascore)

2026-09-09 : créé lors du branchement de getEventEnrich dans le pipeline
de prédiction live. compute_absence_impact = port Python de
SofascoreBypass.computeAbsenceImpact. Le payload d'entrée vient de
l'enrich PixelRAG {side, player, position, status, detail} ; on retrouve
le côté (home/away) via normKey sur homeTeam/awayTeam.
"""

from __future__ import annotations
import re
import unicodedata
from typing import Iterable, Mapping

# Poids par poste (G=1.0, D=0.5, M=0.6, F=0.7). Identique au JS.
POS_WEIGHT = {'G': 1.0, 'D': 0.5, 'M': 0.6, 'F': 0.7}
# Sévérité par statut d'absence.
STATUS_WEIGHT = {'injured': 1.0, 'suspended': 1.0, 'doubtful': 0.4}

_UNICODE_RE = re.compile(r'[\u0300-\u036f]')
_NON_ALNUM_RE = re.compile(r'[^a-z0-9]+')


def _norm_key(s: str) -> str:
    """Normalise une chaîne pour comparaison insensible aux accents/casse/ponctuation.
    Équivalent Python de SofascoreBypass.normKey (JS)."""
    if not s:
        return ''
    s = str(s).lower()
    s = unicodedata.normalize('NFD', s)
    s = _UNICODE_RE.sub('', s)
    s = _NON_ALNUM_RE.sub('', s)
    return s


def compute_absence_impact(
    items: Iterable[Mapping] | None,
    home_team: str,
    away_team: str,
) -> dict:
    """Calcule l'impact pondéré des absences par côté (0..1).

    Équivalent Python exact de SofascoreBypass.computeAbsenceImpact (JS).
    ~3 absences clés saturent l'impact à 1.0.

    @param items: liste d'absences (format PixelRAG : {side, player, position, status, detail})
    @param home_team: nom équipe domicile
    @param away_team: nom équipe extérieur
    @returns: {home: float, away: float} dans [0, 1]
    """
    hk = _norm_key(home_team)
    ak = _norm_key(away_team)
    acc = {'home': 0.0, 'away': 0.0}
    for r in items or []:
        if not isinstance(r, dict):
            continue
        # Le payload PixelRAG porte déjà 'side' (home/away) MAIS on revalide
        # avec le team name au cas où la side est incorrecte.
        r_team = r.get('team') or ''
        if not r_team and r.get('side'):
            r_team = home_team if r.get('side') == 'home' else (away_team if r.get('side') == 'away' else '')
        rk = _norm_key(r_team)
        if rk == hk:
            side = 'home'
        elif rk == ak:
            side = 'away'
        else:
            # Si 'side' est déjà 'home'/'away' et qu'on n'a pas pu normaliser
            # via team (legacy data), on garde la side directe.
            s_raw = str(r.get('side') or '').lower()
            if s_raw in ('home', 'away'):
                side = s_raw
            else:
                continue
        pos = str(r.get('position') or '').upper()[:1]
        w_status = STATUS_WEIGHT.get(str(r.get('status') or '').lower(), 0.6)
        w_pos = POS_WEIGHT.get(pos, 0.5)
        acc[side] += w_status * w_pos
    return {
        'home': round(min(1.0, acc['home'] / 3.0), 3),
        'away': round(min(1.0, acc['away'] / 3.0), 3),
    }
