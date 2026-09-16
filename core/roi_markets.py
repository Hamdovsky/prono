"""
roi_markets.py — Critere ROI de la boucle entraînement -> ROI (E38).

Pur et testable (aucun acces DB) :
  - devig_two          : proba "true" depuis une cote 2 voies (cloture multiplicative).
  - brier_score        : Brier d'une probabilite sur un resultat binaire.
  - choose_over_under  : cote que le modele prefere vs marche devigue (+ marge).
  - simulate_roi       : simulation a mise constante 1u (peut perdre jusqu'a 1u,
                         gain (odds-1)u) -> net/ROI/hit/EV.
  - walkforward_ou_roi : boucle complete chronologique (fit sur passe, eval sur
                         futur, identique a eval_markets_walkforward) pour le
                         marche "total de buts > ligne". Compare modele xG-logistique
                         au marche devigue et rapporte ROI AVANT/POUR servir la
                         decision de gate (OU_MODEL_ENABLED) et le chantier rentabilite.

Usage (interne) : from core.roi_markets import walkforward_ou_roi
"""
import math

from core.eval_markets_walkforward import fit_logistic, predict_logistic

MIN_LEAGUE_ROI_SAMPLE = 30

# Seuil echantillon minimal du walk-forward ROI O/U. 300 (et non 400) : le
# plafond REEL de donnees propres (vraies cotes O/U 2.5 + xG) est ~310-380
# (E38 : 307 apres backfill FotMob ; 64 restantes sans donnee FotMob, FD ne
# couvre que +35). A n~300 (=> ~225 predictions), l'erreur-type du ROI ~ 6 pts
# absolus : seul un edge >~12% ROI serait discriminable. Consistent avec
# E30/E31 qui decidaient deja a n~359-737. Un ROI < 0 ou |ROI| < SE reste
# non concluant, JAMAIS un signal d'activation de gate.
MIN_ROWS = 300


def devig_two(over, under):
    """Probas (p_over, p_under) d'une cote 2 voies, sans marge (multiplicatif).

    Invalide (cote <= 1.0, manquante, somme non positive) -> None.
    """
    if over is None or under is None:
        return None
    try:
        o, u = float(over), float(under)
    except (TypeError, ValueError):
        return None
    if o <= 1.0 or u <= 1.0:
        return None
    inv = 1.0 / o + 1.0 / u
    if inv <= 0.0:
        return None
    p_over = (1.0 / o) / inv
    return p_over, 1.0 - p_over


def brier_score(p, y):
    """Brier quadratique d'une prediction binaire (borne contre div 0)."""
    p = max(1e-6, min(1.0 - 1e-6, p))
    return (p - y) ** 2


def choose_over_under(p_over_model, p_over_market, min_edge=0.0):
    """Cote 'over' | 'under' | None selon l'edge STRICT du modele vs marche
    devigue (edge <= min_edge -> aucun pari)."""
    if p_over_model - p_over_market > min_edge:
        return "over"
    if (1.0 - p_over_model) - (1.0 - p_over_market) > min_edge:
        return "under"
    return None


def simulate_roi(picks):
    """Picks: [{side, odds, won}]. Mise constante 1u. ROI = (net / staked)."""
    n = len(picks)
    if n == 0:
        return {"n": 0, "staked": 0, "net": 0.0, "roi": None, "hit": None}
    net = sum((p["odds"] - 1.0) if p["won"] else -1.0 for p in picks)
    hit = sum(1 for p in picks if p["won"]) / n
    return {
        "n": n,
        "staked": n,
        "net": round(net, 4),
        "roi": round(net / n, 4),
        "hit": round(hit, 4),
    }


def walkforward_ou_roi(rows, folds=4, min_edge=0.0):
    """Boucle ROI O/U temporelle (n>=MIN_ROWS). rows = [{date, total_xg, line, goals,
    odds_over, odds_under, league}]. Retourne stats + brier + decoupe par ligue
    (ligues de moins de MIN_LEAGUE_ROI_SAMPLE paris non rapportees)."""
    rows = sorted(rows, key=lambda r: r.get("date") or "")
    n = len(rows)
    if n < MIN_ROWS:
        return None
    step = n // folds
    probs = [None] * n
    brier_model = []
    brier_market = []
    for f in range(1, folds):
        cut = step * f
        train, test = rows[:cut], rows[cut:]
        if not test:
            continue
        Xtr = [[r["total_xg"], r["line"]] for r in train]
        ytr = [1 if r["goals"] > r["line"] else 0 for r in train]
        model = fit_logistic(Xtr, ytr)
        Xte = [[r["total_xg"], r["line"]] for r in test]
        preds = predict_logistic(model, Xte)
        for (i, r), p in zip(enumerate(test, start=cut), preds):
            probs[i] = p
            if p is None:
                continue
            dev = devig_two(r["odds_over"], r["odds_under"])
            if dev is None:
                continue
            over_won = r["goals"] > r["line"]
            brier_model.append(brier_score(p, 1 if over_won else 0))
            brier_market.append(brier_score(dev[0], 1 if over_won else 0))
    picks = []
    leagues = {}
    for r, p in zip(rows, probs):
        if p is None:
            continue
        dev = devig_two(r["odds_over"], r["odds_under"])
        if dev is None:
            continue
        p_market_over = dev[0]
        side = choose_over_under(p, p_market_over, min_edge)
        if side is None:
            continue
        over_won = r["goals"] > r["line"]
        won = over_won if side == "over" else (not over_won)
        odds = r["odds_over"] if side == "over" else r["odds_under"]
        pick = {"side": side, "odds": odds, "won": won}
        picks.append(pick)
        leagues.setdefault(r.get("league") or "?", []).append(pick)
    out = {
        "n_eligible": n,
        "min_edge": min_edge,
        "stats": simulate_roi(picks),
        "brier_model": (round(sum(brier_model) / len(brier_model), 4) if brier_model else None),
        "brier_market": (round(sum(brier_market) / len(brier_market), 4) if brier_market else None),
    }
    out["per_league"] = {
        lg: simulate_roi(ps)
        for lg, ps in sorted(leagues.items())
        if len(ps) >= MIN_LEAGUE_ROI_SAMPLE
    }
    return out