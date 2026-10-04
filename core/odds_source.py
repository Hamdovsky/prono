"""Prédicat : une source de cote est-elle un vrai bookmaker ?

Équivalent Python de `core/oddsSource.js` (E33), qui fait foi côté Node. Ce
fichier existe parce que le chemin Python n'avait aucun moyen de distinguer
une vraie cote d'une cote synthetique : `core.oddsSource` est du JS, donc
`apply_baseline_1x2_wire` ne pouvait pas l'importer.

Pourquoi c'est indispensable ici : `matches` contient des cotes marquees
`fair_odds_model` / `non_bookmaker:default`, qui sont le modele renormalise en
"cotes". Les federe au fallback 1X2, elles produisent une confiance absurde
(mesure E82 : [0.0001, 0.0001, 0.9998]) et un EV circulaire — le modele contre
lui-meme. La logique est reprise a l'identique, prefixes compris, pour que les
deux langages ne puissent pas diverger.
"""
from __future__ import annotations

SYNTHETIC_SOURCES = frozenset({
    "fair_odds_model",
    "default",
    "synthetic",
    "model_league",
    "historical",
    "historical+elo",
    "none",
    "non_bookmaker",
    "non_bookmaker:default",
})

_SYNTHETIC_PREFIXES = ("non_bookmaker", "fair_", "model_")


def is_real_bookmaker_source(src) -> bool:
    """Vrai si `src` designe un bookmaker reel (et non une estimation)."""
    if src is None:
        return False
    s = str(src).strip().lower()
    if s == "":
        return False
    if s in SYNTHETIC_SOURCES:
        return False
    if s.startswith(_SYNTHETIC_PREFIXES):
        return False
    return True


def odds_source_of(match_obj: dict, parsed_full_data: dict | None = None) -> str | None:
    """Source des cotes d'un match, meme priorite que la persistance Node.

    Colonne d'abord, puis fullData.odds_source, puis fullData.odds.source.
    """
    if not match_obj:
        return None
    fd = parsed_full_data
    if fd is None:
        raw = match_obj.get("fullData")
        if isinstance(raw, str):
            import json

            try:
                fd = json.loads(raw or "{}")
            except (ValueError, TypeError):
                fd = {}
        elif isinstance(raw, dict):
            fd = raw
        else:
            fd = {}
    return (match_obj.get("odds_source")
            or fd.get("odds_source")
            or (fd.get("odds") or {}).get("source")
            or None)