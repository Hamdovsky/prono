"""
suspicious_match_guard.py — E71

Porte d'entree "match suspect" du pipeline de prediction.

POURQUOI CE MODULE EXISTE
-------------------------
Jusqu'a E71, le projet avait 5 detecteurs d'anomalie/integrite, mais AUCUN n'etait
cable a une decision : integrity_service (11 checks), oddsMovementService
(detectBookmakerTrap), FPISEngine (import mort), post_processor (code orphelin) et
integrityScorer (volontairement observationnel). Tous alimentaient l'affichage.
Consequence : une app pouvait monter un prono sur un match a zone morte ou a fort
taux de nuls H2H sans jamais le savoir.

Ce module est le SEUL endroit ou "ce match sent l'anormal" devient un NO BET.
Il est volontairement PRUDENT : un veto dur sur un match sain tue un vrai value
bet, donc on n'integre que des motifs documentes de l'integrite sportive, avec un
seuil de confiance, et `force_predict` reste toujours un bypass.

LES 4 MOTIFS RETENUS
--------------------
1. DEAD_ZONE_BOTH       : les deux equipes n'ont plus rien a jouer (relegation
                          .ensuree, titre acquis). Contexte classique des
                           manipulations : le resultat arrange tout le monde.
2. MOTIVATION_ASYMMETRY : une equipe morte affronte une equipe tres motivee
                           (DMF > 1.15). L'equipe "morte" n'a rien a perdre.
3. H2H_DRAW_PACT       : forte proportion de nuls sur l'historique des
                           confrontations ("pacte de non-agression").
4. RECIDIVIST_TEAM     : equipe deja reperee sur des matchs anormaux
                           (registre d'integrite, cf. scripts/integrity_scan.js).

REGLE DE DECISION
-----------------
- Un motif CRITIQUE seul suffit a bloquer (dead zone double, pacte de nuls).
- Les motifs NON CRITIQUES exigent 2 signaux cumules.
- Aucune exception levee : ce module ne doit jamais faire tomber un prono.

Ce module ne pretend PAS detecter du match-fixing. Il ecarte des situations ou
un resultat importe peu pour une des deux equipes, la ou la bookmaker peut
davantage influencer l'issue. La detection statistique du fixing apres coup reste
dans services/integrityScorer.js.
"""

# SignauxConsideres comme suffisants a eux seuls.
CRITICAL_SIGNALS = frozenset({"DEAD_ZONE_BOTH", "H2H_DRAW_PACT"})

# Nombre de signaux non critiques requis pour bloquer.
NON_CRITICAL_THRESHOLD = 2

# H2H : au moins N confrontations et au moins ce taux de nuls.
H2H_MIN_GAMES = 6
H2H_MIN_DRAW_RATE = 0.60

# Au-dessus de ce DMF, l'equipe est consideree comme "tres motivee".
HIGH_DMF = 1.15


def _as_float(value, default=0.0):
    try:
        if value is None or value == "":
            return default
        return float(value)
    except (TypeError, ValueError):
        return default


def _as_bool(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, str):
        return value.strip().lower() in ("1", "true", "yes", "oui")
    try:
        return bool(value)
    except Exception:
        return False


def _extract_h2h_results(match_obj):
    """Retrouve les scores H2H deja collectes par enriched_predictions.

    Source : match.teamStats.h2h / match.h2h_data, alimente par
    _fetchSofaTeamData (services/enriched_predictions.js).
    On accepte plusieurs formes ; une liste vide = motif non evaluable.
    """
    candidates = []
    for key in ("teamStats", "h2h_data", "h2h"):
        node = match_obj.get(key) if isinstance(match_obj, dict) else None
        if isinstance(node, str):
            try:
                import json
                node = json.loads(node)
            except Exception:
                continue
        if not isinstance(node, dict):
            continue
        # Cherche recursivement une liste de rencontres.
        stack = [node]
        while stack and len(candidates) < 20:
            cur = stack.pop()
            if isinstance(cur, dict):
                if "homeScore" in cur and "awayScore" in cur:
                    candidates.append(cur)
                    continue
                stack.extend(v for v in cur.values() if isinstance(v, (dict, list)))
            elif isinstance(cur, list):
                stack.extend(v for v in cur if isinstance(v, (dict, list)))
    return candidates


def _h2h_draw_pact(match_obj):
    """Pacte de non-agression : beaucoup de nuls sur l'historique H2H."""
    meetings = _extract_h2h_results(match_obj)
    if len(meetings) < H2H_MIN_GAMES:
        return None
    draws = 0
    counted = 0
    for m in meetings:
        hs = m.get("homeScore")
        as_ = m.get("awayScore")
        if isinstance(hs, dict):
            hs = hs.get("current")
        if isinstance(as_, dict):
            as_ = as_.get("current")
        if hs is None or as_ is None:
            continue
        try:
            hs, as_ = int(hs), int(as_)
        except (TypeError, ValueError):
            continue
        counted += 1
        if hs == as_:
            draws += 1
    if counted < H2H_MIN_GAMES:
        return None
    rate = draws / counted
    if rate >= H2H_MIN_DRAW_RATE:
        return {"games": counted, "draws": draws, "rate": round(rate, 2)}
    return None


def _recidivists(match_obj):
    """Equipes marquees au registre d'integrite (phase 2 / P3).

    Le registre est fourni par l'appelant via match_obj['integrity_registry'],
    soit sous la forme canonique {home: {recidivist: bool}}, soit sous la forme
    brute produite par un SELECT sur la table integrity_registry
    (enriched_predictions.js injecte la ligne telle quelle).

    On accepte les deux : le champ `recidivist` s'il est present, sinon on
    deduit la recidive du nombre de matchs flagues. Sans cette deduction, le
    signal ne pourrait jamais se declencher en production (la table n'a pas de
    colonne `recidivist`).
    """
    reg = match_obj.get("integrity_registry") if isinstance(match_obj, dict) else None
    if not isinstance(reg, dict):
        return []
    flagged = []
    for role in ("home", "away"):
        info = reg.get(role)
        if not isinstance(info, dict):
            continue
        if _as_bool(info.get("recidivist")):
            flagged.append(role)
            continue
        # Forme brute : la ligne SQL ne porte que les compteurs agreges.
        # `flagged_count` est deja filtre a >= 2 par build_integrity_registry.js.
        count = _as_float(info.get("flagged_count"), default=0.0)
        if count >= 2:
            flagged.append(role)
    return flagged


def assess_suspicious_match(match_obj, h_is_dz=False, a_is_dz=False,
                            h_dmf=0.0, a_dmf=0.0, registry=None):
    """Point d'entree unique.

    :param match_obj: le match (payload prediction)
    :param h_is_dz, a_is_dz: zones mortes issues de compute_dmf_fatigue
    :param h_dmf, a_dmf: coefficients de motivation (DMF)
    :param registry: optionnel, registre d'integrite {home:{recidivist:bool}, ...}
                     (prioritaire sur match_obj['integrity_registry'])
    :return: dict {is_suspicious, signals, critical, reason, details}
    """
    signals = []
    details = {}
    try:
        m = match_obj if isinstance(match_obj, dict) else {}

        h_dz, a_dz = _as_bool(h_is_dz), _as_bool(a_is_dz)
        h_d = _as_float(h_dmf)
        a_d = _as_float(a_dmf)

        # 1. Zone morte bilaterale
        if h_dz and a_dz:
            signals.append("DEAD_ZONE_BOTH")
            details["DEAD_ZONE_BOTH"] = "les deux equipes n'ont plus rien a jouer"

        # 2. Asymetrie de motivation (une morte, une tres motivee)
        if h_dz and not a_dz and a_d >= HIGH_DMF:
            signals.append("MOTIVATION_ASYMMETRY")
            details["MOTIVATION_ASYMMETRY"] = f"equipe morte contre une equipe a DMF {a_d:.2f}"
        elif a_dz and not h_dz and h_d >= HIGH_DMF:
            signals.append("MOTIVATION_ASYMMETRY")
            details["MOTIVATION_ASYMMETRY"] = f"equipe morte contre une equipe a DMF {h_d:.2f}"

        # 3. Pacte de nuls sur l'H2H
        pact = _h2h_draw_pact(m)
        if pact:
            signals.append("H2H_DRAW_PACT")
            details["H2H_DRAW_PACT"] = (
                f"{pact['draws']}/{pact['games']} nuls sur l'historique ({int(pact['rate'] * 100)}%)"
            )

        # 4. Equipe recidiviste
        reg = registry if isinstance(registry, dict) else m.get("integrity_registry")
        if isinstance(reg, dict):
            flags = _recidivists({**m, "integrity_registry": reg})
            if flags:
                signals.append("RECIDIVIST_TEAM")
                details["RECIDIVIST_TEAM"] = "equipe deja reperee sur des matchs anormaux : " + ", ".join(flags)

    except Exception:
        # Filet de securite : un garde-fou ne doit JAMAIS faire tomber le prono.
        return {
            "is_suspicious": False,
            "signals": [],
            "critical": [],
            "reason": "",
            "details": {},
        }

    critical = [s for s in signals if s in CRITICAL_SIGNALS]
    others = [s for s in signals if s not in CRITICAL_SIGNALS]

    is_suspicious = bool(critical) or len(others) >= NON_CRITICAL_THRESHOLD

    reason = ""
    if is_suspicious and signals:
        reason = "Match suspect (" + ", ".join(signals) + ") : " + " ; ".join(
            details.get(s, "") for s in signals
        )

    return {
        "is_suspicious": is_suspicious,
        "signals": signals,
        "critical": critical,
        "reason": reason,
        "details": details,
    }
