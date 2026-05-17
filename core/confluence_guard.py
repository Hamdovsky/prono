"""
confluence_guard.py — [TITANIUM V110] Module de Validation de Confluence
=========================================================================
Vérifie l'accord entre les différents moteurs de prédiction avant de valider
un signal de pari. L'objectif est d'augmenter le taux de réussite en
n'émettant des recommandations que lorsque les modèles convergent.

Règles de confluence:
  🟢 FORT     : Tous les modèles d'accord, écart total < 10pp  → bonus +8% confiance
  🟡 MODÉRÉ   : 2/3 modèles d'accord, écart < 20pp             → neutre
  🟠 FAIBLE   : Désaccord sur le vainqueur, écart 15-25pp       → pénalité -18%
  🔴 CRITIQUE : Désaccord fort sur le vainqueur, écart > 25pp   → pénalité -35% (NO BET)
  ⚫ BLOCAGE  : Désaccord marché vs modèle ET momentum négatif  → blocage total
"""

import math


def _winner_label(ph: float, pd: float, pa: float) -> str:
    """Retourne le vainqueur prédit ('H', 'D', 'A')."""
    m = max(ph, pd, pa)
    if m == ph: return 'H'
    if m == pa: return 'A'
    return 'D'


def _total_variation(p1h, p1d, p1a, p2h, p2d, p2a) -> float:
    """Distance de variation totale entre deux distributions de probabilités."""
    return abs(p1h - p2h) + abs(p1d - p2d) + abs(p1a - p2a)


def evaluate_confluence(
    p_xgb: tuple,           # (p_home, p_draw, p_away) from XGBoost Monte Carlo
    p_poisson: tuple,       # (p_home, p_draw, p_away) from Poisson/Monte Carlo
    p_market: tuple = None, # (p_home, p_draw, p_away) implied from odds (vig-free)
    momentum_h: float = 0.0,
    momentum_a: float = 0.0,
    league_tier: str = 'DEFAULT',
    has_xgb: bool = True
) -> dict:
    """
    Évalue la confluence entre les modèles et retourne un rapport de confiance.

    Returns:
        dict with keys:
            - level: 'STRONG' | 'MODERATE' | 'WEAK' | 'CRITICAL' | 'BLOCKED'
            - penalty: float (0.0 = neutre, > 0 = pénalité, < 0 = bonus)
            - confidence_multiplier: float (appliqué à la confiance finale)
            - reason: str (explication humaine)
            - should_no_bet: bool
            - consensus_winner: str ('H', 'D', 'A', 'CONFLICT')
    """
    if not has_xgb:
        # Sans XGBoost, on ne peut pas évaluer la confluence — neutre
        return {
            'level': 'UNAVAILABLE',
            'penalty': 0.0,
            'confidence_multiplier': 1.0,
            'reason': 'XGBoost non disponible — confluence non calculable.',
            'should_no_bet': False,
            'consensus_winner': _winner_label(*p_poisson)
        }

    xh, xd, xa = p_xgb
    ph, pd, pa = p_poisson

    xgb_winner = _winner_label(xh, xd, xa)
    poi_winner = _winner_label(ph, pd, pa)

    # Divergence XGBoost <-> Poisson
    xgb_poi_div = _total_variation(xh, xd, xa, ph, pd, pa)

    # Divergence XGBoost <-> Market
    market_div = 0.0
    mkt_winner = None
    if p_market and all(v > 0 for v in p_market):
        mh, md, ma = p_market
        market_div = _total_variation(xh, xd, xa, mh, md, ma)
        mkt_winner = _winner_label(mh, md, ma)

    # Vainqueur de consensus
    winners = [xgb_winner, poi_winner]
    if mkt_winner: winners.append(mkt_winner)
    consensus_winner = max(set(winners), key=winners.count)
    all_agree = len(set(winners)) == 1

    # --- Détermination du niveau de confluence ---
    level = 'MODERATE'
    penalty = 0.0
    reason_parts = []

    if all_agree and xgb_poi_div < 0.10:
        # 🟢 CONSENSUS FORT : tous les modèles convergent
        level = 'STRONG'
        penalty = -0.08  # Bonus confiance
        reason_parts.append(f"✅ Consensus fort ({consensus_winner}), écart {xgb_poi_div:.1%}")

    elif xgb_winner == poi_winner and xgb_poi_div < 0.20:
        # 🟡 MODÉRÉ : XGBoost et Poisson d'accord mais avec un écart raisonnable
        level = 'MODERATE'
        penalty = 0.0
        reason_parts.append(f"🟡 Accord XGB+Poisson ({consensus_winner}), écart {xgb_poi_div:.1%}")
        if mkt_winner and mkt_winner != xgb_winner:
            penalty = 0.08  # Le marché diverge légèrement
            reason_parts.append(f"⚠️ Marché prédit {mkt_winner} (divergence modérée)")

    elif xgb_winner != poi_winner and xgb_poi_div > 0.25:
        # 🔴 CRITIQUE : désaccord fort entre XGBoost et Poisson sur le vainqueur
        level = 'CRITICAL'
        penalty = 0.35
        reason_parts.append(
            f"🔴 Désaccord critique: XGB→{xgb_winner} vs Poisson→{poi_winner} "
            f"(écart {xgb_poi_div:.1%})"
        )

    elif xgb_winner != poi_winner and xgb_poi_div > 0.15:
        # 🟠 FAIBLE : désaccord modéré
        level = 'WEAK'
        penalty = 0.18
        reason_parts.append(
            f"🟠 Désaccord modéré: XGB→{xgb_winner} vs Poisson→{poi_winner} "
            f"(écart {xgb_poi_div:.1%})"
        )

    # Blocage supplémentaire : marché totalement opposé + momentum négatif
    should_no_bet = False
    if (level == 'CRITICAL'):
        should_no_bet = True
        reason_parts.append("⛔ Signal conflicté → NO BET recommandé")

    if mkt_winner and mkt_winner != consensus_winner and market_div > 0.30:
        # Le marché est fortement opposé à nos modèles — sharp money contre nous?
        if level not in ('CRITICAL',):
            level = 'WEAK'
            penalty = max(penalty, 0.20)
            reason_parts.append(
                f"⚠️ Sharp money contre la prédiction? Marché prédit {mkt_winner} "
                f"(écart {market_div:.1%})"
            )

    # Ajustement par league tier (les ligues volatiles amplifient l'incertitude)
    tier_amplifier = {'T1': 0.85, 'T2': 1.0, 'T3': 1.25, 'DEFAULT': 1.0}
    tier_mult = tier_amplifier.get(league_tier, 1.0)
    if penalty > 0:
        penalty = min(0.50, penalty * tier_mult)

    confidence_multiplier = max(0.30, 1.0 - penalty)

    return {
        'level': level,
        'penalty': round(penalty, 3),
        'confidence_multiplier': round(confidence_multiplier, 3),
        'reason': ' | '.join(reason_parts) if reason_parts else 'Analyse standard',
        'should_no_bet': should_no_bet,
        'consensus_winner': consensus_winner,
        'xgb_poi_divergence': round(xgb_poi_div, 3),
        'market_divergence': round(market_div, 3) if market_div else None
    }


def get_market_implied_probs(odds_h: float, odds_d: float, odds_a: float) -> tuple:
    """
    Convertit les cotes 1X2 en probabilités implicites sans vig (méthode Shin).
    Retourne (p_home, p_draw, p_away) normalisées.
    """
    if not all(o > 1.0 for o in [odds_h, odds_d, odds_a]):
        return (0.33, 0.33, 0.34)
    raw_h = 1.0 / odds_h
    raw_d = 1.0 / odds_d
    raw_a = 1.0 / odds_a
    total = raw_h + raw_d + raw_a
    return (raw_h / total, raw_d / total, raw_a / total)


def confluence_to_emoji(level: str) -> str:
    """Retourne l'emoji correspondant au niveau de confluence."""
    return {
        'STRONG': '✅',
        'MODERATE': '🟡',
        'WEAK': '🟠',
        'CRITICAL': '🔴',
        'BLOCKED': '⛔',
        'UNAVAILABLE': '⚪'
    }.get(level, '⚪')


if __name__ == '__main__':
    # Test rapide
    result = evaluate_confluence(
        p_xgb=(0.55, 0.25, 0.20),
        p_poisson=(0.48, 0.28, 0.24),
        p_market=(0.50, 0.27, 0.23),
        league_tier='T1'
    )
    import json
    print(json.dumps(result, indent=2, ensure_ascii=False))
