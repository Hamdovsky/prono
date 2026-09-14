"""
ou_model.py — Moteur Over/Under par buts totaux (Poisson) — E30, Chantier Rentabilite B1.

Probleme mesure : le ou_25_prob ACTUEL du systeme n'a presque aucun pouvoir
discriminant (quel que soit le % annonce, le reel retombe a ~58%) et est pire
qu'une constante (Brier 0.251 > base 0.244). Il faut un SIGNAL.

Approche (stdlib uniquement, explicable, peu gourmande) : on apprend par equipe
une force d'ATTAQUE et de DEFENSE (multiplicateurs autour de la moyenne des buts
d'une competition) + un avantage terrain (HFA), via un laminar-flooding / IPF sur
TOUS les matchs termines (buts connus => label Over2.5). Puis
  lambda_home = mu * atkH * defA * hfa ; lambda_away = mu * atkA * defH
  P(Over line) = 1 - somme_{i+j <= line} Pois(i|lh)*Pois(j|la)

Usage :
  python core/ou_model.py            # eval walk-forward honeste (train / test separes)
  python core/ou_model.py --train     # reanalyse tout + ecrit data/ou_model.json
Options : --line=2.5 --test-frac=0.25 --iters=8
"""
import json
import math
import os
import sys
import sqlite3
import argparse
from collections import defaultdict

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB = os.path.join(REPO, 'data', 'tactical.db')
OUT = os.path.join(REPO, 'data', 'ou_model.json')
EPS = 0.06  # plancher de force (equipes a 0 but evitent un effondrement multiplicatif)


def load_matches():
    con = sqlite3.connect(DB)
    con.row_factory = sqlite3.Row
    rows = con.execute(
        "SELECT id, league, homeTeam, awayTeam, scoreHome, scoreAway, "
        "COALESCE(timestamp, archived_at, '') ts, fullData FROM historical_matches "
        "WHERE scoreHome IS NOT NULL AND scoreAway IS NOT NULL"
    ).fetchall()
    con.close()
    out = []
    for r in rows:
        try:
            sh, sa = int(r['scoreHome']), int(r['scoreAway'])
        except (TypeError, ValueError):
            continue
        cur_prob = None
        ts = 0
        try:
            f = json.loads(r['fullData'] or '{}')
            p = f.get('ou_25_prob')
            if p is None and isinstance(f.get('quant', {}).get('markets', {}).get('over_under_25'), dict):
                p = f['quant']['markets']['over_under_25'].get('over')
            if p is not None:
                p = float(p)
                cur_prob = p * 100 if p <= 1 else p
            st = f.get('startTimestamp')
            if st:
                ts = int(st) * 1000 if int(st) < 1e12 else int(st)
        except Exception:
            cur_prob = None
        if not ts:
            try:
                # ISO 'YYYY-...' -> ms epoch (best effort)
                from datetime import datetime
                ts = int(datetime.fromisoformat(str(r['ts']).replace('Z', '+00:00')).timestamp() * 1000)
            except Exception:
                ts = 0
        out.append({'id': r['id'], 'league': (r['league'] or 'UNK'), 'home': r['homeTeam'],
                    'away': r['awayTeam'], 'sh': sh, 'sa': sa, 'ts': ts,
                    'cur': cur_prob})
    return out


def poisson_pmf(lam, maxk):
    if lam <= 0:
        return [1.0] + [0.0] * maxk
    lp = [0.0] * (maxk + 1)
    lp[0] = -lam  # log Pois(0) = -lam
    logfact = 0.0
    for k in range(1, maxk + 1):
        logfact += math.log(k)
        lp[k] = k * math.log(lam) - lam - logfact
    return [math.exp(x) for x in lp]


def fit_strengths(ms, line, shrink=12.0):
    """IPF avec SHRINKAGE bayesien vers 1.0 (pseudo-compte `shrink`) -> evite que
    les milliers d'equipes a 1-2 matchs explosent les lambdas (le PiBruit qui
    rendait le modele pire que la constante). Retourne (mu, hfa, atk{team}, deff{team}).
    """
    atk = defaultdict(list)
    dfd = defaultdict(list)
    for m in ms:
        atk[m['home']].append(m['sh'])
        atk[m['away']].append(m['sa'])
        dfd[m['home']].append(m['sa'])
        dfd[m['away']].append(m['sh'])
    mu = sum(m['sh'] + m['sa'] for m in ms) / max(1, 2 * len(ms))
    A = {t: (sum(v) / len(v)) / mu if v else 1.0 for t, v in atk.items()}
    D = {t: (sum(v) / len(v)) / mu if v else 1.0 for t, v in dfd.items()}
    hfa = 1.0
    for _ in range(8):
        numH = defaultdict(float); denH = defaultdict(float)
        numA = defaultdict(float); denA = defaultdict(float)
        sh_num = 0.0; sh_den = 0.0
        for m in ms:
            lh = max(0.05, mu * A.get(m['home'], 1.0) * D.get(m['away'], 1.0) * hfa)
            la = max(0.05, mu * A.get(m['away'], 1.0) * D.get(m['home'], 1.0))
            numH[m['home']] += m['sh']; denH[m['home']] += lh
            numA[m['away']] += m['sa']; denA[m['away']] += la
            sh_num += m['sh']; sh_den += lh
        for t in list(A.keys()):
            if denH[t] > 0:
                raw = numH[t] / denH[t]
                A[t] = (numH[t] + shrink * mu) / (denH[t] + shrink * mu)  # shrink vers 1.0
        for t in list(D.keys()):
            if denA[t] > 0:
                D[t] = (numA[t] + shrink * mu) / (denA[t] + shrink * mu)
        # renormalise pour que la moyenne des forces ~ 1 (evite la derive de mu)
        meanA = sum(A.values()) / max(1, len(A)); meanD = sum(D.values()) / max(1, len(D))
        for t in A: A[t] /= meanA
        for t in D: D[t] /= meanD
        hfa = (sh_num / sh_den) if sh_den > 0 else hfa
    for t in A: A[t] = min(2.6, max(0.35, A[t]))
    for t in D: D[t] = min(2.6, max(0.35, D[t]))
    return mu, hfa, dict(A), dict(D)


def p_over(lh, la, line):
    # seuils 2.5 => somme<=2 ; 1.5 => <=1 ; 3.5 => <=3
    cap = int(math.floor(line))
    ph = poisson_pmf(lh, cap); pa = poisson_pmf(la, cap)
    under = 0.0
    for i in range(cap + 1):
        for j in range(cap + 1 - i):
            under += ph[i] * pa[j]
    return 1.0 - under


def predict(p, m, mu, hfa, A, D, line):
    lh = max(0.05, mu * A.get(m['home'], 1.0) * D.get(m['away'], 1.0) * hfa)
    la = max(0.05, mu * A.get(m['away'], 1.0) * D.get(m['home'], 1.0))
    return p_over(lh, la, line)


def metrics(pairs):
    n = len(pairs)
    brier = sum((p - y) ** 2 for p, y in pairs) / n
    eps = 1e-6
    ll = -sum(y * math.log(max(eps, p)) + (1 - y) * math.log(max(eps, 1 - p)) for p, y in pairs) / n
    base = sum(y for _, y in pairs) / n
    base_brier = base * (1 - base) ** 2 + (1 - base) * base ** 2
    base_ll = -(base * math.log(base) + (1 - base) * math.log(1 - base))
    return n, base, brier, ll, base_brier, base_ll


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--train', action='store_true')
    ap.add_argument('--line', type=float, default=2.5)
    ap.add_argument('--test-frac', type=float, default=0.25)
    ap.add_argument('--shrink', type=float, default=12.0)
    args, _ = ap.parse_known_args()
    line = args.line

    ms = load_matches()
    ms = [m for m in ms if m['ts'] > 0]
    ms.sort(key=lambda m: m['ts'])
    split = int(len(ms) * (1 - args.test_frac))
    train, test = ms[:split], ms[split:]
    print(f"[OU] {len(ms)} matchs termines | train={len(train)} test={len(test)} (split temporel) | line={line} shrink={args.shrink}")

    mu, hfa, A, D = fit_strengths(train, line, shrink=args.shrink)
    print(f"[OU] mu={mu:.3f} buts/match  HFA={hfa:.3f}  equipes={len(A)}")

    # compte d'apparition des equipes dans le TRAIN (pour isoler la partie ou le signal equipe existe)
    seen = defaultdict(int)
    lg_goals = defaultdict(list)
    for m in train:
        seen[m['home']] += 1; seen[m['away']] += 1
        lg_goals[m['league']].append(m['sh'] + m['sa'])

    t_pairs = [(predict(1, m, mu, hfa, A, D, line), 1 if (m['sh'] + m['sa']) > line else 0) for m in train]
    te_pairs = [(predict(1, m, mu, hfa, A, D, line), 1 if (m['sh'] + m['sa']) > line else 0) for m in test]
    for name, pairs in (('TRAIN', t_pairs), ('TEST (out-of-sample)', te_pairs)):
        n, base, brier, ll, bb, bl = metrics(pairs)
        print(f"[OU] {name}: n={n} baseP={base:.3f} | Brier={brier:.4f} (plancher={bb:.4f}, {(brier-bb)/bb*100:+.1f}%) logloss={ll:.4f} (plancher={bl:.4f})")

    # sous-ensemble TEST ou les DEUX equipes ont >=8 matchs dans le train (le signal equipe devrait exister)
    sub = [(m, predict(1, m, mu, hfa, A, D, line)) for m in test if seen.get(m['home'], 0) >= 4 and seen.get(m['away'], 0) >= 4]
    if len(sub) >= 25:
        sp = [(p, 1 if (m['sh'] + m['sa']) > line else 0) for m, p in sub]
        n, base, brier, ll, bb, bl = metrics(sp)
        print(f"[OU] TEST '2 equipes vues>=8x' : n={n} | Brier={brier:.4f} (plancher={bb:.4f}, {(brier-bb)/bb*100:+.1f}%)")

    # plancher par-ligue (mu ligue) : Poisson avec lambda total = moyenne de la ligue
    lm = {lg: (sum(v) / len(v) if v else mu * 2) for lg, v in lg_goals.items()}
    lp_pairs = []
    for m in test:
        tot = lm.get(m['league'], mu * 2)
        lh = la = tot / 2.0
        lp_pairs.append((p_over(lh, la, line), 1 if (m['sh'] + m['sa']) > line else 0))
    n, base, brier, ll, bb, bl = metrics(lp_pairs)
    print(f"[OU] PLANCHER ligue (Poisson mu-ligue, sans equipe) : Brier={brier:.4f} (vs plancher global {bb:.4f})")

    # courbe de fiabilite TEST
    print("[OU] calibration TEST (predicte -> reel):")
    bins = defaultdict(list)
    for p, y in te_pairs:
        bins[min(9, int(p * 10))].append(y)
    for b in sorted(bins):
        v = bins[b]
        print(f"     {b*10}-{b*10+10}% -> reel {sum(v)/len(v)*100:.1f}% (n={len(v)})")

    # comparaison avec le ou_25_prob ACTUEL du systeme sur le MEME test (plus fort, optimiste car in-sample)
    cur_pairs = [(m['cur'] / 100.0, 1 if (m['sh'] + m['sa']) > line else 0) for m in test if m['cur']]
    if cur_pairs:
        n, base, brier, ll, bb, bl = metrics(cur_pairs)
        print(f"[OU] ou_25_prob ACTUEL sur test (in-sample, favorise): n={n} Brier={brier:.4f} logloss={ll:.4f}")

    if args.train:
        mu2, hfa2, A2, D2 = fit_strengths(ms, line, shrink=args.shrink)  # reanalyse sur TOUS
        json.dump({'line': line, 'mu': round(mu2, 4), 'hfa': round(hfa2, 4),
                   'teams': {t: {'a': round(A2[t], 4), 'd': round(D2.get(t, 1.0), 4)} for t in A2}},
                  open(OUT, 'w'), ensure_ascii=False)
        print(f"[OU] ecrit {OUT} ({len(A2)} equipes)")


if __name__ == '__main__':
    main()
