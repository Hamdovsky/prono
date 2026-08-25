"""
market_engine.py — Surgical Market Selection, Precision Bets & Pro Insights
Extracted from prediction_engine.py (Lines 962-1086, 1088-1172, 1384-1428, 1541-1595)

Responsibilities:
  1. Precision bets (O/U, BTTS, Clean Sheet, Corners, Cards)
  2. DNB / Double Chance / Asian Handicap market suggestions
  3. Surgical market selection (best single bet from multiple markets)
  4. Pro insights generation
  5. Poisson exact score matrix
  6. Main Four predictions assembly
"""
import math
import os
from data_loader import safe_float as _safe_float, f_feat as _f_feat
from predictor import calculate_ah_dnb_probs
from corners_calib import load_calibration, p_over_corner

_CORNER_LINE = 9.5
# Q3/Q5 : adoption validee sur holdout chronologique (core/validate_markets.py) :
# BTTS 0.622 vs 0.455 (legacy), O/U2.5 0.635 vs 0.559 (Poisson). Defaut = actif.
_BTTS_MODEL_ENABLED = os.environ.get("BTTS_MODEL_ENABLED", "true").lower() == "true"
_OU_MODEL_ENABLED = os.environ.get("OU_MODEL_ENABLED", "true").lower() == "true"


def generate_precision_bets(xg_h, xg_a, p_h, p_d, p_a, mc_ou25, mc_ou35, mc_ou15,
                            expected_corners, expected_cards, home_name, away_name,
                            has_xgb, features, odds_h=0.0, odds_d=0.0, odds_a=0.0):
    """Generate precision betting suggestions across multiple markets.
    
    Args:
        odds_h, odds_d, odds_a: Optional odds for 1X2 to apply odds range filter [1.45, 2.30]
    """
    precision_bets = []

    bc_h = _f_feat('home_big_chances', features, 1.0) if has_xgb else 1.0
    bc_a = _f_feat('away_big_chances', features, 1.0) if has_xgb else 1.0
    sot_h = _f_feat('home_sot', features, 3.0) if has_xgb else 3.0
    sot_a = _f_feat('away_sot', features, 3.0) if has_xgb else 3.0

    # Odds range filter helper
    def odds_in_range(odds):
        return 1.45 <= odds <= 2.30 if odds > 0 else True
    
    # Determine selection odds for range filter
    max_prob = max(p_h, p_d, p_a)
    if max_prob == p_h:
        selection_odds = odds_h
    elif max_prob == p_a:
        selection_odds = odds_a
    else:
        selection_odds = odds_d
    
    # Skip all precision bets if main selection odds out of range
    if not odds_in_range(selection_odds):
        return [{"market": "NO BET (ODDS_RANGE)", "probability": 0, "reason": f"Cote principale {selection_odds:.2f} hors range [1.45, 2.30]"}]

    # Over/Under (Q5) : P(Over ligne) via modele logistique calibre sur archive
    # quand OU_MODEL_ENABLED, sinon Monte Carlo brut (mc_ou25/mc_ou35).
    total_xg = xg_h + xg_a
    p25 = p35 = None
    if _OU_MODEL_ENABLED:
        try:
            from ou_model import ou_prob as _ou_prob
            p25 = _ou_prob(total_xg, 2.5)
            p35 = _ou_prob(total_xg, 3.5)
        except Exception:
            p25 = p35 = None

    # Over/Under 2.5
    if p25 is not None:
        if p25 >= 0.55:
            precision_bets.append({
                "market": "Over 2.5 Buts",
                "probability": int(round(p25 * 100)),
                "reason": f"Modele O/U calibre : P(>2.5)={p25*100:.0f}% (xG {total_xg:.2f})",
            })
        elif p25 <= 0.45:
            precision_bets.append({
                "market": "Under 2.5 Buts",
                "probability": int(round((1 - p25) * 100)),
                "reason": f"Modele O/U calibre : P(<=2.5)={(1-p25)*100:.0f}% (xG {total_xg:.2f})",
            })
    else:
        if mc_ou25 >= 58:
            precision_bets.append({"market": "Over 2.5 Buts", "probability": int(round(mc_ou25)), "reason": f"Monte Carlo ({int(mc_ou25)}%): Forte probabilité de 3+ buts (xG total {total_xg:.2f})"})
        elif mc_ou25 <= 42:
            under_prob = round(100 - mc_ou25)
            precision_bets.append({"market": "Under 2.5 Buts", "probability": int(under_prob), "reason": f"Monte Carlo ({int(under_prob)}%): Faible probabilité de 3+ buts (xG total {total_xg:.2f})"})

    if p35 is not None:
        if p35 >= 0.55:
            precision_bets.append({
                "market": "Over 3.5 Buts",
                "probability": int(round(p35 * 100)),
                "reason": f"Modele O/U calibre : P(>3.5)={p35*100:.0f}% (xG {total_xg:.2f})",
            })
    else:
        if mc_ou35 >= 55:
            precision_bets.append({"market": "Over 3.5 Buts", "probability": int(round(mc_ou35)), "reason": f"Monte Carlo ({int(mc_ou35)}%): Probabilité de 4+ buts (match ouvert)"})

    # BTTS (Q3) : P(BTTS) via modele logistique calibre sur archive quand active,
    # sinon heuristique legacy (xg_h*xg_a*30+40). Gate BTTS_MODEL_ENABLED.
    if xg_h >= 1.2 and xg_a >= 1.1 and bc_h >= 1.5 and bc_a >= 1.5:
        if _BTTS_MODEL_ENABLED:
            try:
                from btts_model import btts_prob as _btts_prob
                _pb = _btts_prob(xg_h, xg_a)
            except Exception:
                _pb = min(0.88, (xg_h * xg_a) * 30 + 40) / 100.0
        else:
            _pb = min(0.88, (xg_h * xg_a) * 30 + 40) / 100.0
        precision_bets.append({
            "market": "BTTS : OUI",
            "probability": int(round(_pb * 100)),
            "reason": "Les deux équipes génèrent des occasions nettes"
            + (" [modele BTTS calibre]" if _BTTS_MODEL_ENABLED else ""),
        })

    # Clean Sheet
    if xg_a < 0.8 and sot_a < 2.5 and p_h > 60:
        precision_bets.append({"market": f"Clean Sheet : {home_name}", "probability": int(min(80, 100 - (xg_a*50))), "reason": f"Attaque de {away_name} très inefficace"})

    # Corners (Q2) : proba O/U 9.5 via Negative Binomial calibree sur l'archive.
    # Remplace l'heuristique (60 + (ec-9)*10) par P(Over ligne | mu=expected_corners).
    if expected_corners is not None:
        try:
            ec = float(expected_corners)
            _calib = load_calibration()
            _pov = p_over_corner(ec, _CORNER_LINE, calib=_calib)
            if _pov is not None and _pov >= 0.55:
                precision_bets.append({
                    "market": f"Over {_CORNER_LINE} Corners",
                    "probability": int(round(_pov * 100)),
                    "reason": f"NegBinom calibre (alpha={_calib['alpha']:.2f}) : P(> {_CORNER_LINE}) = {_pov*100:.0f}% (mu={ec:.1f})",
                })
            elif _pov is not None and _pov <= 0.45:
                precision_bets.append({
                    "market": f"Under {_CORNER_LINE} Corners",
                    "probability": int(round((1 - _pov) * 100)),
                    "reason": f"NegBinom calibre (alpha={_calib['alpha']:.2f}) : P(<= {_CORNER_LINE}) = {(1-_pov)*100:.0f}% (mu={ec:.1f})",
                })
        except Exception:
            pass

    # Cards
    if expected_cards >= 4.8:
        precision_bets.append({"market": "Over 3.5 Cartons", "probability": int(min(85, 65 + (expected_cards - 4.5)*10)), "reason": f"Agressivité élevée : {expected_cards} indice estimé"})

    return precision_bets


def generate_dnb_ah_bets(p_h, p_d, p_a, selection, home_name, away_name,
                         h_dominance, a_dominance):
    """Generate DNB and Asian Handicap suggestions."""
    precision_bets = []
    dnb_h, dnb_a, dc_h, dc_a, dc_12 = calculate_ah_dnb_probs(p_h, p_d, p_a)

    if dnb_h > 0.65 or (selection == "Home" and dnb_h > 0.55):
        precision_bets.append({"market": f"DNB {home_name}", "probability": int(dnb_h*100), "reason": "Protection sur le nul incluse"})
    elif dnb_a > 0.65 or (selection == "Away" and dnb_a > 0.55):
        precision_bets.append({"market": f"DNB {away_name}", "probability": int(dnb_a*100), "reason": "Protection sur le nul incluse"})

    # Asian Handicap
    if selection == "Home":
        if p_h > 0.75 or h_dominance > 2.5:
            precision_bets.append({"market": f"AH -1.5 {home_name}", "probability": int(p_h*85), "reason": "Domination structurelle massive attendue"})
        elif p_h > 0.60 or h_dominance > 1.8:
            precision_bets.append({"market": f"AH -0.5 {home_name}", "probability": int(p_h*100), "reason": "Victoire sèche recommandée (AH -0.5)"})
    elif selection == "Away":
        if p_a > 0.75 or a_dominance > 2.5:
            precision_bets.append({"market": f"AH -1.5 {away_name}", "probability": int(p_a*85), "reason": "Supériorité tactique écrasante à l'extérieur"})
        elif p_a > 0.60 or a_dominance > 1.8:
            precision_bets.append({"market": f"AH -0.5 {away_name}", "probability": int(p_a*100), "reason": "Victoire sèche recommandée (AH -0.5)"})

    return precision_bets, dnb_h, dnb_a, dc_h, dc_a, dc_12


def get_best_surgical_market(match_obj, selection, selection_label, selection_prob,
                             p_h, p_d, p_a, xg_h, xg_a, mc_ou25,
                             league_tier, home_name, away_name,
                             bc_h, bc_a, dnb_h, dnb_a, h_composite_attack, a_composite_attack):
    """
    Select the best single surgical market from multiple candidates.
    Returns: (primary_market, backup_market)
    """
    league_name = str(match_obj.get('league', '')).lower()
    tournament_name = str(match_obj.get('tournament_name', '')).lower()
    is_promosport = 'promosport' in league_name or 'promosport' in tournament_name

    if is_promosport:
        return {"type": selection_label, "confidence": int(selection_prob * 100), "desc": "تحليل كلاسيكي (1-X-2) لمسابقة البروموسبور"}, None

    markets = []
    is_t1 = (league_tier == 'T1')

    # Over 0.5 HT
    if mc_ou25 > 62 or (xg_h > 1.3 and xg_a > 1.2):
        markets.append({"type": "Over 0.5 HT", "confidence": int(mc_ou25 * 0.95), "desc": "نمط الهجوم المبكر والضغط العالي"})

    # BTTS
    if xg_h > 1.1 and xg_a > 1.1 and bc_h >= 1.2 and bc_a >= 1.2:
        markets.append({"type": "BTTS (Oui)", "confidence": int(min(90, (xg_h * xg_a) * 35 + 30)), "desc": "ثغرات دفاعية متبادلة"})

    # Asian Handicap
    if selection == "Home":
        if p_h > 0.65:
            markets.append({"type": f"Handicap -1 {home_name}", "confidence": int(p_h * 100), "desc": "هيمنة مطلقة متوقعة (AH -1)"})
        elif p_h > 0.52:
            conf_boost = 2 if is_t1 else 0
            markets.append({"type": f"Handicap -0.5 {home_name}", "confidence": int(p_h * 100) + conf_boost, "desc": "أفضلية فنية واضحة (AH -0.5)"})
        elif p_h > 0.45 and p_d > 0.25:
            markets.append({"type": f"Handicap -0.25 {home_name}", "confidence": int((p_h + (p_d/2)) * 100), "desc": "تأمين ربع الرهان (AH -0.25)"})
    elif selection == "Away":
        if p_a > 0.65:
            markets.append({"type": f"Handicap -1 {away_name}", "confidence": int(p_a * 100), "desc": "فوارق فنية شاسعة (AH -1)"})
        elif p_a > 0.52:
            conf_boost = 2 if is_t1 else 0
            markets.append({"type": f"Handicap -0.5 {away_name}", "confidence": int(p_a * 100) + conf_boost, "desc": "أفضلية تكتيكية للضيوف (AH -0.5)"})
        elif p_a > 0.45 and p_d > 0.25:
            markets.append({"type": f"Handicap -0.25 {away_name}", "confidence": int((p_a + (p_d/2)) * 100), "desc": "تأمين ربع الرهان (AH -0.25)"})

    # DNB
    if is_t1:
        if selection == "Home" and p_h > 0.40:
            markets.append({"type": f"DNB {home_name}", "confidence": int(dnb_h * 100) + 5, "desc": "تأمين احترافي ضد التعادل (DNB)"})
        elif selection == "Away" and p_a > 0.40:
            markets.append({"type": f"DNB {away_name}", "confidence": int(dnb_a * 100) + 5, "desc": "تأمين احترافي ضد التعادل (DNB)"})
    else:
        if selection == "Home" and p_d > 0.32:
            markets.append({"type": f"DNB {home_name}", "confidence": int(dnb_h * 100), "desc": "تأمين تكتيكي (DNB)"})
        elif selection == "Away" and p_d > 0.32:
            markets.append({"type": f"DNB {away_name}", "confidence": int(dnb_a * 100), "desc": "تأمين تكتيكي (DNB)"})

    # O/U Goals
    if mc_ou25 > 65:
        markets.append({"type": "Over 2.5 Goals", "confidence": int(mc_ou25), "desc": "نمط هجومي غزير الأهداف"})
    elif mc_ou25 < 35:
        markets.append({"type": "Under 2.5 Goals", "confidence": int(100 - mc_ou25), "desc": "نمط دفاعي مغلق"})

    # Under 3.5 (Extreme Security)
    if mc_ou25 < 45 and xg_h + xg_a < 2.2:
        markets.append({"type": "Under 3.5 Goals", "confidence": 88, "desc": "توقع مباراة شحيحة الأهداف جداً"})

    if not markets:
        return {"type": selection_label, "confidence": int(selection_prob * 100), "desc": "توقع كلاسيكي بناءً على التفوق الفني"}, None

    sorted_markets = sorted(markets, key=lambda x: x['confidence'], reverse=True)
    primary = sorted_markets[0]
    backup = sorted_markets[1] if len(sorted_markets) > 1 else None

    return primary, backup


def generate_pro_insights(selection, confidence, league_tier, league_name_str,
                          is_value_bet, value_index, h_dmf, a_dmf,
                          home_name, away_name, tactical_alerts, analysis, mc_ou25):
    """Generate professional betting insights."""
    pro_insights = []

    if is_value_bet:
        pro_insights.append({
            "type": "VALUE",
            "title": "Opportunité de Valeur",
            "content": f"Le marché sous-estime {selection}. Indice de valeur à {value_index:.2f}."
        })

    if confidence > 82 and league_tier == 'T1':
        pro_insights.append({
            "type": "SAFE",
            "title": "Indice de Fiabilité Élite",
            "content": "Match à haute prévisibilité dans une ligue majeure. Risque de volatilité faible."
        })
    elif league_tier == 'T3':
        pro_insights.append({
            "type": "RISK",
            "title": "Alerte de Volatilité",
            "content": f"Ligue de Tier 3 : Attention aux surprises statistiques ({league_name_str})."
        })

    for alert in tactical_alerts:
        pro_insights.append({
            "type": "TACTICAL",
            "title": "Analyse Tactique",
            "content": alert
        })

    if "H2H" in analysis:
        pro_insights.append({
            "type": "HISTORY",
            "title": "Bête Noire / H2H",
            "content": analysis["H2H"]
        })

    if abs(h_dmf - a_dmf) > 0.4:
        fav_mot = home_name if h_dmf > a_dmf else away_name
        pro_insights.append({
            "type": "TACTICAL",
            "title": "Déséquilibre de Motivation",
            "content": f"{fav_mot} a un impératif de points nettement supérieur, favorisant l'engagement physique."
        })

    if mc_ou25 > 65:
        pro_insights.append({
            "type": "GOALS",
            "title": "Potentiel de Score Élevé",
            "content": "Les simulations confirment une approche offensive des deux côtés. Le Over 2.5 est un choix solide."
        })
    elif mc_ou25 < 35:
        pro_insights.append({
            "type": "DEFENSE",
            "title": "Bataille Défensive",
            "content": "Blocs bas et inefficacité offensive attendus. Match probablement fermé."
        })

    return pro_insights


def calculate_poisson_scores(xg_h, xg_a, selection):
    """Calculate Poisson-based exact score predictions (top 3)."""
    cs_results = []
    for h in range(5):
        for a in range(5):
            p_h = (math.pow(xg_h, h) * math.exp(-xg_h)) / math.factorial(h)
            p_a = (math.pow(xg_a, a) * math.exp(-xg_a)) / math.factorial(a)
            total_prob = p_h * p_a * 100

            match_logic = False
            if selection == "Home" and h > a: match_logic = True
            elif selection == "Away" and a > h: match_logic = True
            elif selection == "Draw" and h == a: match_logic = True

            if match_logic:
                cs_results.append({"score": f"{h} - {a}", "prob": round(total_prob, 1)})

    cs_results.sort(key=lambda x: x['prob'], reverse=True)
    return [r for r in cs_results if r['prob'] >= 10.0][:3]


def ensure_expected_score_in_cs(cs_predictions, expected_score, xg_h, xg_a):
    """Force expected_score to be first if it matches selection and isn't already there."""
    if expected_score and not any(r['score'] == expected_score for r in cs_predictions):
        try:
            eh, ea = map(int, expected_score.split(' - '))
            p_eh = (math.pow(xg_h, eh) * math.exp(-xg_h)) / math.factorial(eh)
            p_ea = (math.pow(xg_a, ea) * math.exp(-xg_a)) / math.factorial(ea)
            cs_predictions.insert(0, {"score": expected_score, "prob": round(p_eh * p_ea * 100, 1)})
        except Exception:
            pass

    seen = set()
    unique_cs = []
    for cp in cs_predictions:
        if cp['score'] not in seen:
            unique_cs.append(cp)
            seen.add(cp['score'])
    return unique_cs[:3]


def build_main_four(selection_label, mc_ou25, xg_h, xg_a, surgical_verdict,
                    direct_prediction, home_name, away_name, selection, gh, ga):
    """Build the main_four prediction list."""
    winner_pred = f"{selection_label}"
    goals_pred = "Over 2.5 Goals" if mc_ou25 >= 55 else "Under 2.5 Goals"

    if selection == "Home": dc_pred = f"{home_name} or Draw"
    elif selection == "Away": dc_pred = f"{away_name} or Draw"
    else: dc_pred = f"{home_name} or {away_name}"

    main_four = [
        {"label": "Match Winner", "val": winner_pred},
        {"label": "TOTAL GOALS PREDICTED", "val": f"+2.5 Buts" if (xg_h+xg_a) >= 2.8 else f"-2.5 Buts"},
        {"label": "Double Chance", "val": dc_pred}
    ]

    if surgical_verdict and surgical_verdict['type'].startswith('AH'):
        main_four[0] = {"label": "Elite AH Pick", "val": surgical_verdict['type']}

    # Top Analyst Engine Integration
    try:
        score_winner = None
        if gh > ga: score_winner = "Home"
        elif ga > gh: score_winner = "Away"

        if direct_prediction and score_winner:
            corrected_parts = []
            for part in direct_prediction.split(' | '):
                if 'Draw' in part or 'Nul' in part or 'nul' in part:
                    part = part.replace('Draw', score_winner).replace('Nul', score_winner).replace('nul', score_winner)
                corrected_parts.append(part)
            direct_prediction = ' | '.join(corrected_parts)

        if direct_prediction:
            parts = direct_prediction.split(' | ')
            for i, part in enumerate(parts):
                if ':' in part:
                    k, v = part.split(':', 1)
                    if i < len(main_four):
                        main_four[i] = {"label": k.strip(), "val": v.strip()}
                    else:
                        main_four.append({"label": k.strip(), "val": v.strip()})
                else:
                    main_four.append({"label": "Top Analyst Flag", "val": part.strip()})
    except Exception:
        pass

    return main_four
