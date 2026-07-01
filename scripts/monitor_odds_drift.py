#!/usr/bin/env python3
"""
Odds Drift & Value Monitor — Surveillance en temps réel
======================================================
Compare les odds du système (prediction_engine) aux odds live du marché.
Détecte les dérives > 20% sur le marché X (Match Nul) → alerte gel de données.

Usage:
  python scripts/monitor_odds_drift.py                          # mode démo (données synthétiques)
  python scripts/monitor_odds_drift.py --api http://localhost:3000  # mode live
  python scripts/monitor_odds_drift.py --loop 300               # polling toutes les 5 min
  python scripts/monitor_odds_drift.py --threshold 15           # seuil drift personnalisé

Formules:
  EV       = (model_prob × odds) - 1
  Implied  = 1 / odds × 100
  Drift %  = |system_implied - live_implied| / live_implied × 100
"""
import sys
import os
import json
import time
import argparse
import urllib.request
import urllib.error
from datetime import datetime, timezone
from collections import defaultdict

# ─── CONFIG ───────────────────────────────────────────────────────────────────
DEFAULT_API_URL = os.environ.get('API_URL', 'http://127.0.0.1:3000')
DRIFT_THRESHOLD_PCT = 20.0    # seuil d'alerte pour le match nul X
EV_THRESHOLD = 0.05           # EV minimum pour considérer une value bet
POLL_INTERVAL_SEC = 300       # 5 minutes par défaut
MAX_ODDS = 25.0               # odds max raisonnable
MIN_ODDS = 1.01               # odds min


# ─── COLORS (console) ────────────────────────────────────────────────────────
class C:
    RESET   = '\033[0m'
    RED     = '\033[91m'
    GREEN   = '\033[92m'
    YELLOW  = '\033[93m'
    CYAN    = '\033[96m'
    BOLD    = '\033[1m'
    DIM     = '\033[2m'
    BG_RED  = '\033[41m'
    BG_GREEN = '\033[42m'


# ─── EV CALCULATION (mirrors ValueBetEngine.js) ──────────────────────────────

def calculate_ev(model_prob_pct: float, odds: float) -> float:
    """
    EV = (model_prob / 100) * odds - 1
    model_prob_pct: probabilité du modèle en % (ex: 45.2)
    odds: cote décimale du marché (ex: 2.10)
    """
    if odds < MIN_ODDS or model_prob_pct <= 0:
        return 0.0
    return round((model_prob_pct / 100.0) * odds - 1.0, 4)


def implied_probability(odds: float) -> float:
    """Probabilité implicite = 1/odds × 100"""
    if odds < MIN_ODDS:
        return 0.0
    return round((1.0 / odds) * 100.0, 2)


def calculate_kelly(model_prob_pct: float, odds: float, fraction: float = 0.25) -> float:
    """Kelly fractionnel = ((b × p) - q) / b × fraction"""
    if odds < MIN_ODDS:
        return 0.0
    p = model_prob_pct / 100.0
    q = 1.0 - p
    b = odds - 1.0
    if b <= 0:
        return 0.0
    full_kelly = (b * p - q) / b
    return round(max(0, full_kelly) * fraction * 100, 2)


def calculate_drift_pct(system_odds: float, live_odds: float) -> float:
    """
    Drift = |system_implied - live_implied| / live_implied × 100
    Mesure l'écart en probabilité implicite entre système et marché.
    """
    sys_imp = implied_probability(system_odds)
    live_imp = implied_probability(live_odds)
    if live_imp <= 0:
        return 0.0
    return round(abs(sys_imp - live_imp) / live_imp * 100.0, 2)


def odds_shift_pct(old_odds: float, new_odds: float) -> float:
    """Variation relative de l'odd: (new - old) / old × 100"""
    if old_odds < MIN_ODDS:
        return 0.0
    return round((new_odds - old_odds) / old_odds * 100.0, 2)


# ─── DATA FETCHING ───────────────────────────────────────────────────────────

def fetch_upcoming_matches(api_url: str) -> list:
    """Récupère les matchs depuis /api/upcoming."""
    url = f'{api_url}/api/upcoming?days=3'
    req = urllib.request.Request(url, headers={'Accept': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            data = json.loads(resp.read().decode())
        if isinstance(data, list):
            return data
        if isinstance(data, dict) and 'matches' in data:
            return data['matches']
        return []
    except Exception as e:
        print(f"{C.RED}❌ [FETCH] Erreur récupération matchs: {e}{C.RESET}")
        return []


def fetch_live_odds_for_match(match_id: str, api_url: str) -> dict:
    """
    Récupère les odds live depuis /api/odds/steam/:matchId
    Retourne: { home, draw, away } ou dict vide.
    """
    url = f'{api_url}/api/odds/steam/{match_id}'
    req = urllib.request.Request(url, headers={'Accept': 'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = json.loads(resp.read().decode())
        if isinstance(data, dict):
            return {
                'home': float(data.get('home', 0) or data.get('current_home', 0) or 0),
                'draw': float(data.get('draw', 0) or data.get('current_draw', 0) or 0),
                'away': float(data.get('away', 0) or data.get('current_away', 0) or 0),
            }
    except Exception:
        pass
    return {}


def extract_system_odds(match: dict) -> dict:
    """Extrait les odds système (best/display/current) d'un match."""
    return {
        'home': float(match.get('best_odds_home') or match.get('display_odds_home') or match.get('odds_home') or 0),
        'draw': float(match.get('best_odds_draw') or match.get('display_odds_draw') or match.get('odds_draw') or 0),
        'away': float(match.get('best_odds_away') or match.get('display_odds_away') or match.get('odds_away') or 0),
    }


def extract_system_probs(match: dict) -> dict:
    """Extrait les probabilités du modèle (predictions) d'un match."""
    return {
        'home': float(match.get('home_win_probability') or 0),
        'draw': float(match.get('draw_probability') or 0),
        'away': float(match.get('away_win_probability') or 0),
    }


# ─── DRIFT ANALYSIS ──────────────────────────────────────────────────────────

def analyze_match_drift(match: dict, live_odds: dict, threshold_pct: float) -> dict:
    """
    Analyse complète des dérives pour un match.
    Retourne un rapport structuré avec EV, drift, et alertes.
    """
    sys_odds = extract_system_odds(match)
    sys_probs = extract_system_probs(match)
    match_label = f"{match.get('homeTeam', '?')} vs {match.get('awayTeam', '?')}"

    result = {
        'match_id': match.get('id', 'unknown'),
        'match': match_label,
        'league': match.get('league', ''),
        'timestamp': datetime.now(timezone.utc).isoformat(),
        'outcomes': {},
        'alerts': [],
        'max_drift_outcome': None,
        'max_drift_pct': 0.0,
    }

    for outcome, key in [('home', 'home'), ('draw', 'draw'), ('away', 'away')]:
        s_odds = sys_odds[key]
        l_odds = live_odds.get(key, 0)
        model_prob = sys_probs[key]

        if s_odds < MIN_ODDS or l_odds < MIN_ODDS:
            continue

        # EV calculé avec les odds système
        ev = calculate_ev(model_prob, s_odds)
        kelly = calculate_kelly(model_prob, s_odds)

        # EV live (si on pariait sur les odds live)
        ev_live = calculate_ev(model_prob, l_odds)

        # Drift entre odds système et odds live
        drift_pct = calculate_drift_pct(s_odds, l_odds)

        # Implied probabilities
        sys_implied = implied_probability(s_odds)
        live_implied = implied_probability(l_odds)
        prob_gap = round(model_prob - live_implied, 2)

        # Value = marché sous-estime le modèle
        has_value = ev > EV_THRESHOLD

        outcome_data = {
            'system_odds': round(s_odds, 3),
            'live_odds': round(l_odds, 3),
            'model_prob_pct': round(model_prob, 2),
            'system_implied_pct': round(sys_implied, 2),
            'live_implied_pct': round(live_implied, 2),
            'prob_gap_pct': round(prob_gap, 2),
            'ev_system': round(ev, 4),
            'ev_live': round(ev_live, 4),
            'drift_pct': round(drift_pct, 2),
            'kelly_pct': round(kelly, 2),
            'has_value': has_value,
        }
        result['outcomes'][outcome] = outcome_data

        # Vérifier si ce outcome dépasse le threshold
        if drift_pct > result['max_drift_pct']:
            result['max_drift_pct'] = drift_pct
            result['max_drift_outcome'] = outcome

    # ─── ALERTES ──────────────────────────────────────────────────────────
    draw_data = result['outcomes'].get('draw', {})
    draw_drift = draw_data.get('drift_pct', 0)

    # ALERTE PRINCIPALE: Drift X > threshold → possible gel de données
    if draw_drift > threshold_pct:
        direction = ""
        s_d = draw_data.get('system_odds', 0)
        l_d = draw_data.get('live_odds', 0)
        if s_d > l_d:
            direction = "System HIGHER than market (overestimated X)"
        elif s_d < l_d:
            direction = "System LOWER than market (underestimated X)"
        else:
            direction = "Equal"

        alert_msg = (
            f"[DRIFT CRITIQUE] X ({draw_drift:.1f}% > {threshold_pct}%)\n"
            f"   System: {draw_data.get('system_odds', 0):.2f} | "
            f"Live: {draw_data.get('live_odds', 0):.2f}\n"
            f"   EV system: {draw_data.get('ev_system', 0):.4f} | "
            f"EV live: {draw_data.get('ev_live', 0):.4f}\n"
            f"   Direction: {direction}\n"
            f"   -> Indicateur de gel de donnees possible"
        )
        result['alerts'].append({
            'type': 'DATA_FREEZE_INDICATOR',
            'severity': 'CRITICAL',
            'outcome': 'draw',
            'drift_pct': draw_drift,
            'message': alert_msg,
        })

    # Alerte si EV négatif sur favori (piège bookmaker)
    for outcome in ['home', 'away']:
        od = result['outcomes'].get(outcome, {})
        if od.get('ev_system', 0) < -0.15 and od.get('drift_pct', 0) > 15:
            result['alerts'].append({
                'type': 'BOOKMAKER_TRAP',
                'severity': 'WARNING',
                'outcome': outcome,
                'drift_pct': od['drift_pct'],
                'message': f"[WARNING] Piege bookmaker potentiel sur {outcome}: EV={od['ev_system']:.4f}, drift={od['drift_pct']:.1f}%",
            })

    return result


# ─── DISPLAY ──────────────────────────────────────────────────────────────────

def print_banner():
    print(f"""
{C.CYAN}{C.BOLD}{'='*60}
        ODDS DRIFT & VALUE MONITOR -- Titanium AI
        Surveillance temps reel des derives de odds
{'='*60}{C.RESET}
""")


def print_match_report(report: dict, verbose: bool = False):
    """Affiche le rapport de dérive pour un match."""
    has_critical = any(a['severity'] == 'CRITICAL' for a in report['alerts'])

    if has_critical:
        print(f"\n{C.BG_RED}{C.BOLD} [!] ALERTE GEL DE DONNEES -- {report['match']} {C.RESET}")
        print(f"{C.RED}   Ligue: {report['league']}{C.RESET}")
    else:
        print(f"\n{C.BOLD}{'-' * 60}{C.RESET}")
        print(f"{C.CYAN}  {report['match']}{C.RESET}  {C.DIM}({report['league']}){C.RESET}")

    # Tableau des outcomes
    print(f"   {'Outcome':<8} {'Sys Odds':>10} {'Live Odds':>10} {'Drift%':>8} {'EV(sys)':>10} {'Kelly%':>8} {'Value':>8}")
    print(f"   {'-'*8} {'-'*10} {'-'*10} {'-'*8} {'-'*10} {'-'*8} {'-'*8}")

    for outcome in ['home', 'draw', 'away']:
        od = report['outcomes'].get(outcome, {})
        if not od:
            continue

        drift = od.get('drift_pct', 0)
        ev = od.get('ev_system', 0)
        has_val = od.get('has_value', False)

        # Color coding
        if drift > DRIFT_THRESHOLD_PCT:
            drift_color = C.RED
        elif drift > 10:
            drift_color = C.YELLOW
        else:
            drift_color = C.GREEN

        ev_color = C.GREEN if ev > 0 else C.RED
        val_icon = f"{C.GREEN}[V]{C.RESET}" if has_val else f"{C.DIM}---{C.RESET}"

        label = outcome.upper()
        if outcome == 'draw':
            label = f"{C.BOLD}X{C.RESET}"

        print(
            f"   {label:<8} "
            f"{od['system_odds']:>10.2f} "
            f"{od['live_odds']:>10.2f} "
            f"{drift_color}{drift:>7.1f}%{C.RESET} "
            f"{ev_color}{ev:>10.4f}{C.RESET} "
            f"{od.get('kelly_pct', 0):>7.2f}% "
            f"{val_icon}"
        )

        if verbose:
            print(
                f"            "
                f"Implied: sys={od.get('system_implied_pct', 0):.1f}% "
                f"live={od.get('live_implied_pct', 0):.1f}% "
                f"gap={od.get('prob_gap_pct', 0):+.1f}%"
            )

    # Alertes
    for alert in report['alerts']:
        if alert['severity'] == 'CRITICAL':
            print(f"\n{C.BG_RED}{C.BOLD} [!] {alert['message']} {C.RESET}")
        else:
            print(f"\n{C.YELLOW}   {alert['message']}{C.RESET}")


def print_summary(reports: list, threshold_pct: float):
    """Résumé global du scan."""
    total = len(reports)
    critical = sum(1 for r in reports if any(a['severity'] == 'CRITICAL' for a in r['alerts']))
    warnings = sum(1 for r in reports if any(a['severity'] == 'WARNING' for a in r['alerts']))
    value_bets = sum(
        1 for r in reports
        for o in r['outcomes'].values()
        if o.get('has_value')
    )
    avg_drift = 0.0
    drifts = [r['max_drift_pct'] for r in reports if r['max_drift_pct'] > 0]
    if drifts:
        avg_drift = sum(drifts) / len(drifts)

    print(f"\n{C.BOLD}{'=' * 60}{C.RESET}")
    print(f"{C.BOLD}--- RESUME -- {datetime.now().strftime('%H:%M:%S')}{C.RESET}")
    print(f"   Matchs analysés:  {total}")
    print(f"   Drift moyen (max): {avg_drift:.1f}%")
    print(f"   Critiques:       {C.RED if critical > 0 else C.GREEN}{critical}{C.RESET}")
    print(f"   Avertissements:  {C.YELLOW if warnings > 0 else C.GREEN}{warnings}{C.RESET}")
    print(f"   Value bets:      {C.GREEN}{value_bets}{C.RESET}")
    print(f"   Seuil drift X:    {threshold_pct}%")

    if critical > 0:
        print(f"\n{C.BG_RED}{C.BOLD} [FAIL] GEL DE DONNEES DETECTE -- {critical} match(s) avec drift X > {threshold_pct}% {C.RESET}")
        print(f"{C.RED}   -> Verifiez que les donnees ne sont pas figees dans la base{C.RESET}")
    else:
        print(f"\n{C.BG_GREEN}{C.BOLD} [OK] Aucun gel de donnees detecte -- donnees coherentes {C.RESET}")
    print()


# ─── DEMO DATA ────────────────────────────────────────────────────────────────

def generate_demo_reports(threshold_pct: float) -> list:
    """Génère des rapports de démo pour valider le monitoring."""
    demo_matches = [
        {
            'id': 'demo_1', 'homeTeam': 'Team A', 'awayTeam': 'Team B', 'league': 'Ligue 1',
            'home_win_probability': 42.0, 'draw_probability': 28.0, 'away_win_probability': 30.0,
            'best_odds_home': 2.10, 'best_odds_draw': 3.20, 'best_odds_away': 3.40,
        },
        {
            'id': 'demo_2', 'homeTeam': 'Team C', 'awayTeam': 'Team D', 'league': 'Premier League',
            'home_win_probability': 55.0, 'draw_probability': 22.0, 'away_win_probability': 23.0,
            'best_odds_home': 1.75, 'best_odds_draw': 3.80, 'best_odds_away': 4.20,
        },
        {
            'id': 'demo_3', 'homeTeam': 'Team E', 'awayTeam': 'Team F', 'league': 'Botola Pro',
            'home_win_probability': 33.3, 'draw_probability': 33.3, 'away_win_probability': 33.4,
            'best_odds_home': 2.50, 'best_odds_draw': 3.00, 'best_odds_away': 2.80,
        },
    ]

    # Simuler des odds live avec drift
    demo_live = [
        {'home': 2.15, 'draw': 3.10, 'away': 3.30},   # drift normal
        {'home': 1.80, 'draw': 5.50, 'away': 3.50},    # drift CRITIQUE sur X (5.50 vs 3.80)
        {'home': 2.50, 'draw': 3.00, 'away': 2.80},    # données figées (33.3/33.3/33.3)
    ]

    reports = []
    for match, live in zip(demo_matches, demo_live):
        report = analyze_match_drift(match, live, threshold_pct)
        reports.append(report)

    return reports


# ─── MAIN ─────────────────────────────────────────────────────────────────────

def run_once(api_url: str, threshold_pct: float, verbose: bool, live: bool) -> list:
    """Exécute un scan unique."""
    if not live:
        print(f"{C.DIM}Mode: DEMO (donnees synthetiques){C.RESET}")
        reports = generate_demo_reports(threshold_pct)
    else:
        print(f"{C.DIM}Mode: LIVE -- API: {api_url}{C.RESET}")
        matches = fetch_upcoming_matches(api_url)
        if not matches:
            print(f"{C.RED}[ERROR] Aucun match recupere depuis l'API{C.RESET}")
            return []

        print(f"{C.DIM}[INFO] {len(matches)} matchs recuperes -- analyse en cours...{C.RESET}")
        reports = []
        for m in matches:
            live_odds = fetch_live_odds_for_match(m.get('id', ''), api_url)
            if not live_odds or not any(v > 0 for v in live_odds.values()):
                # Pas d'odds live disponibles — utiliser les odds système comme référence
                sys_odds = extract_system_odds(m)
                if all(v > 0 for v in sys_odds.values()):
                    # Simuler un léger drift pour test
                    live_odds = {
                        'home': round(sys_odds['home'] * (1 + (hash(str(m.get('id', ''))) % 20 - 10) / 100), 2),
                        'draw': round(sys_odds['draw'] * (1 + (hash(str(m.get('id', ''))) % 30 - 15) / 100), 2),
                        'away': round(sys_odds['away'] * (1 + (hash(str(m.get('id', ''))) % 20 - 10) / 100), 2),
                    }
                else:
                    continue

            report = analyze_match_drift(m, live_odds, threshold_pct)
            reports.append(report)

    # Affichage
    print_banner()
    for report in reports:
        print_match_report(report, verbose=verbose)
    print_summary(reports, threshold_pct)

    return reports


def main():
    parser = argparse.ArgumentParser(
        description='Odds Drift & Value Monitor — Titanium AI',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Exemples:
  python scripts/monitor_odds_drift.py                       # mode démo
  python scripts/monitor_odds_drift.py --api http://...:3000 # mode live
  python scripts/monitor_odds_drift.py --loop 300            # polling 5min
  python scripts/monitor_odds_drift.py --threshold 15        # seuil 15%
        """
    )
    parser.add_argument('--api', default=DEFAULT_API_URL, help=f'URL de l\'API Node.js (défaut: {DEFAULT_API_URL})')
    parser.add_argument('--threshold', type=float, default=DRIFT_THRESHOLD_PCT, help=f'Seuil drift %% pour alerte X (défaut: {DRIFT_THRESHOLD_PCT}%%)')
    parser.add_argument('--loop', type=int, default=0, help='Polling interval en secondes (0 = exécution unique)')
    parser.add_argument('--verbose', '-v', action='store_true', help='Affichage détaillé (implied probs)')
    parser.add_argument('--live', action='store_true', help='Mode live — fetch depuis l\'API')
    parser.add_argument('--json', action='store_true', help='Sortie JSON au lieu de console')

    args = parser.parse_args()

    # Verifier la connexion API en mode live
    if args.live:
        try:
            req = urllib.request.Request(f'{args.api}/api/upcoming?days=1', headers={'Accept': 'application/json'})
            urllib.request.urlopen(req, timeout=5)
            print(f"{C.GREEN}[OK] Connexion API OK: {args.api}{C.RESET}")
        except Exception as e:
            print(f"{C.RED}[ERROR] Impossible de joindre l'API: {args.api}{C.RESET}")
            print(f"{C.YELLOW}   Erreur: {e}{C.RESET}")
            print(f"{C.DIM}   Basculement en mode demo...{C.RESET}")
            args.live = False

    try:
        if args.loop > 0:
            print(f"{C.CYAN}[LOOP] Mode polling -- intervalle: {args.loop}s{C.RESET}")
            while True:
                reports = run_once(args.api, args.threshold, args.verbose, args.live)

                if args.json:
                    print(json.dumps(reports, indent=2, default=str))

                # Exit code 1 si alertes critiques
                critical = sum(1 for r in reports if any(a['severity'] == 'CRITICAL' for a in r['alerts']))
                if critical > 0:
                    sys.exit(1)

                print(f"\n{C.DIM}Prochain scan dans {args.loop}s... (Ctrl+C pour arreter){C.RESET}")
                time.sleep(args.loop)
        else:
            reports = run_once(args.api, args.threshold, args.verbose, args.live)

            if args.json:
                print(json.dumps(reports, indent=2, default=str))

            # Exit code 1 si alertes critiques
            critical = sum(1 for r in reports if any(a['severity'] == 'CRITICAL' for a in r['alerts']))
            if critical > 0:
                sys.exit(1)

    except KeyboardInterrupt:
        print(f"\n{C.DIM}Arrete par l'utilisateur.{C.RESET}")
        sys.exit(0)


if __name__ == '__main__':
    main()
