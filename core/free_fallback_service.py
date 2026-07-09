"""
free_fallback_service.py — Free Fallback Scraper & Local Predictor
Activates when a match has insufficient_data. Scrapes free data sources
(FBref, OpenLigaDB, SofaScore) and computes 1X2 + O/U 2.5 probabilities
using local Poisson/Dixon-Coles engine. Writes directly to tactical.db.

Usage:
    from free_fallback_service import FreeFallbackService
    service = FreeFallbackService()
    results = service.enrich_match_batch(matches)
"""

import json
import os
import math
import sqlite3
import sys
import logging
import time
from datetime import datetime

logger = logging.getLogger('free_fallback_service')

CORE_DIR = os.path.dirname(os.path.abspath(__file__))
PROJECT_DIR = os.path.dirname(CORE_DIR)
TACTICAL_DB_PATH = os.path.join(PROJECT_DIR, 'data', 'tactical.db')

# ─── Lazy imports ───
_score_matrix = None
_top_analyst = None
_fbref_service = None

def _lazy_import_score_matrix():
    global _score_matrix
    if _score_matrix is None:
        sys.path.insert(0, CORE_DIR)
        from score_matrix_analyzer import build_score_matrix, calculate_markets
        _score_matrix = (build_score_matrix, calculate_markets)
    return _score_matrix

def _lazy_import_top_analyst():
    global _top_analyst
    if _top_analyst is None:
        sys.path.insert(0, CORE_DIR)
        from top_analyst_engine import analyze_over_under_and_cs
        _top_analyst = analyze_over_under_and_cs
    return _top_analyst

def _lazy_import_fbref():
    global _fbref_service
    if _fbref_service is None:
        sys.path.insert(0, CORE_DIR)
        from fbref_service import get_team_season_stats, get_match_xg, search_match_xg
        _fbref_service = (get_team_season_stats, get_match_xg, search_match_xg)
    return _fbref_service


class FreeFallbackService:
    def __init__(self, db_path=None):
        self.db_path = db_path or TACTICAL_DB_PATH
        self._fbref_team_stats = {}
        self._fbref_xg_cache = {}
        self._openligadb_cache = {}
        self._sofascore_cache = {}

    # ── PUBLIC API ────────────────────────────────────────────────

    def enrich_match_batch(self, matches):
        """Point d'entrée principal — reçoit une liste de dicts match, retourne les enrichis."""
        results = []
        enriched_count = 0
        for m in matches:
            try:
                result = self._enrich_one(m)
                if result.get('success'):
                    enriched_count += 1
                results.append(result)
            except Exception as e:
                logger.error(f"[FALLBACK] Error on {m.get('id','?')}: {e}")
                results.append({"id": m.get('id'), "success": False, "error": str(e)})
        return {"enriched": enriched_count, "total": len(matches), "results": results}

    # ── INTERNAL PIPELINE ─────────────────────────────────────────

    def _enrich_one(self, match):
        match_id = match.get('id') or match.get('match_id') or ''
        home = match.get('homeTeam', '')
        away = match.get('awayTeam', '')
        league = match.get('league', match.get('tournament_name', ''))

        if not home or not away:
            return {"id": match_id, "success": False, "error": "Missing homeTeam/awayTeam"}

        # Step 1: Scrape free data (cascade: FBref → OpenLigaDB → SofaScore → Heuristic)
        scraped = self._scrape_free(home, away, league)

        # Step 2: Compute xG
        xg_h, xg_a = self._compute_xg(scraped, home, away)

        if xg_h <= 0 or xg_a <= 0:
            xg_h, xg_a = 1.35, 1.15  # default football averages

        # Step 3: Poisson → 1X2 probabilities
        build_score_matrix_fn, calculate_markets_fn = _lazy_import_score_matrix()
        matrix = build_score_matrix_fn(xg_h, xg_a, max_goals=8)
        markets = calculate_markets_fn(matrix)

        p_home = round(markets.get('home', 0.33) * 100, 1)
        p_draw = round(markets.get('draw', 0.33) * 100, 1)
        p_away = round(markets.get('away', 0.33) * 100, 1)

        # Step 4: O/U 2.5
        analyze_ou = _lazy_import_top_analyst()
        ou = analyze_ou(xg_h, xg_a)
        ou_25_prob = round(ou.get('over_25_prob', 0.5) * 100, 1)

        # Step 5: Determine pick
        pick, prob, ev = self._determine_pick(p_home, p_draw, p_away)

        # Step 6: Write to DB
        expected_score = f"{ou.get('predicted_score_h', 1)} - {ou.get('predicted_score_a', 1)}"

        predictions = {
            'home_win_probability': p_home,
            'draw_probability': p_draw,
            'away_win_probability': p_away,
            'ou_25_prob': ou_25_prob,
            'btts_prob': round(markets.get('btts_yes', 0.5) * 100, 1),
            'expected_score': expected_score,
            'prediction': pick,
            'prediction_probability': prob,
            'ev_score': ev,
            'insufficient_data': 0,
            'source': 'free_fallback',
            'home_xg': round(xg_h, 2),
            'away_xg': round(xg_a, 2),
        }

        self._update_db(match_id, predictions)

        return {"id": match_id, "success": True, **predictions, "xg_h": round(xg_h, 2), "xg_a": round(xg_a, 2)}

    # ── FREE DATA SCRAPING (CASCADE) ──────────────────────────────

    def _scrape_free(self, home, away, league):
        """Try FBref → OpenLigaDB → SofaScore → Heuristic fallback."""
        result = {}

        # Source 1: FBref via soccerdata
        try:
            result = self._scrape_fbref(home, away, league)
            if result.get('xg_home') and result.get('xg_away'):
                logger.info(f"[FALLBACK] FBref success for {home} vs {away}")
                return result
        except Exception as e:
            logger.debug(f"[FALLBACK] FBref failed: {e}")

        # Source 2: OpenLigaDB (free API, no key)
        try:
            result = self._scrape_openligadb(home, away, league)
            if result.get('xg_home') and result.get('xg_away'):
                logger.info(f"[FALLBACK] OpenLigaDB success for {home} vs {away}")
                return result
        except Exception as e:
            logger.debug(f"[FALLBACK] OpenLigaDB failed: {e}")

        # Source 3: SofaScore scraping
        try:
            result = self._scrape_sofascore(home, away, league)
            if result.get('xg_home') and result.get('xg_away'):
                logger.info(f"[FALLBACK] SofaScore success for {home} vs {away}")
                return result
        except Exception as e:
            logger.debug(f"[FALLBACK] SofaScore failed: {e}")

        # Source 4: Local DB history heuristic
        try:
            result = self._scrape_local_history(home, away)
            if result.get('xg_home') and result.get('xg_away'):
                logger.info(f"[FALLBACK] Local history success for {home} vs {away}")
                return result
        except Exception as e:
            logger.debug(f"[FALLBACK] Local history failed: {e}")

        return result

    def _scrape_fbref(self, home, away, league):
        get_stats, get_xg, search_xg = _lazy_import_fbref()

        # Try direct match xG first
        if league:
            xg = get_xg(home, away, league)
            if xg:
                return {'xg_home': xg['home_xg'], 'xg_away': xg['away_xg']}

        # Search across all leagues
        xg = search_xg(home, away)
        if xg:
            return {'xg_home': xg['home_xg'], 'xg_away': xg['away_xg']}

        # Fall back to team season stats
        avg_xg_h, avg_xg_a = 0, 0
        try:
            stats_h = get_stats(home, league) if league else None
            if not stats_h:
                for league_name in list(self._get_fbref_leagues().keys())[:10]:
                    stats_h = get_stats(home, league_name)
                    if stats_h:
                        break
            if stats_h:
                mp = max(stats_h.get('MP', 1), 1)
                gf = stats_h.get('GF', 0) or stats_h.get('Gls', 0) or 0
                xg_col = stats_h.get('xG', 0)
                avg_xg_h = (gf / mp * 0.4 + xg_col / mp * 0.6) if mp > 0 else 1.2

            stats_a = get_stats(away, league) if league else None
            if not stats_a:
                for league_name in list(self._get_fbref_leagues().keys())[:10]:
                    stats_a = get_stats(away, league_name)
                    if stats_a:
                        break
            if stats_a:
                mp = max(stats_a.get('MP', 1), 1)
                ga = stats_a.get('GA', 0) or 0
                xga = stats_a.get('xGA', 0) or 0
                avg_xg_a = (ga / mp * 0.4 + xga / mp * 0.6) if mp > 0 else 1.0
        except Exception:
            pass

        if avg_xg_h > 0.3 and avg_xg_a > 0.3:
            return {'xg_home': avg_xg_h, 'xg_away': avg_xg_a}

        return {}

    def _get_fbref_leagues(self):
        try:
            from fbref_service import LEAGUE_MAP
            return LEAGUE_MAP
        except Exception:
            return {}

    def _scrape_openligadb(self, home, away, league):
        import requests as r
        # Try to find the league key for OpenLigaDB
        league_key = self._map_to_openligadb(league)
        if not league_key:
            return {}

        # Get current season (2025-2026 → 2026 for OpenLigaDB)
        now = datetime.now()
        season = now.year if now.month > 7 else now.year - 1

        url = f"https://api.openligadb.de/v1/getmatchdata/{league_key}/{season}"
        resp = r.get(url, timeout=15)
        if resp.status_code != 200:
            return {}

        data = resp.json()
        home_goals_scored, home_goals_conceded = [], []
        away_goals_scored, away_goals_conceded = [], []

        for match in data:
            h = match.get('team1', {}).get('teamName', '')
            a = match.get('team2', {}).get('teamName', '')
            results = match.get('matchResults', [])
            final_score = None
            for rs in results:
                if rs.get('resultName') == 'Endergebnis':
                    final_score = rs
                    break
            if not final_score:
                continue
            pts_h = int(final_score.get('pointsTeam1', 0))
            pts_a = int(final_score.get('pointsTeam2', 0))

            if h.lower() == home.lower():
                home_goals_scored.append(pts_h)
                home_goals_conceded.append(pts_a)
            if a.lower() == away.lower():
                away_goals_scored.append(pts_a)
                away_goals_conceded.append(pts_h)

        if home_goals_scored and away_goals_scored:
            xg_h = sum(home_goals_scored) / len(home_goals_scored) * 0.5 + \
                   sum(away_goals_conceded) / len(away_goals_conceded) * 0.5
            xg_a = sum(away_goals_scored) / len(away_goals_scored) * 0.5 + \
                   sum(home_goals_conceded) / len(home_goals_conceded) * 0.5
            return {'xg_home': max(0.4, xg_h), 'xg_away': max(0.4, xg_a)}

        return {}

    def _map_to_openligadb(self, league):
        if not league:
            return None
        league_lower = league.lower()
        mapping = {
            'bundesliga': 'bl1',
            '2. bundesliga': 'bl2',
            '3. liga': 'bl3',
            'premier league': 'premier-league',
            'la liga': 'primera-division',
            'serie a': 'serie-a',
            'ligue 1': 'ligue-1',
            'eredivisie': 'eredivisie',
            'primeira liga': 'primeira-liga',
        }
        for key, val in mapping.items():
            if key in league_lower:
                return val
        return None

    def _scrape_sofascore(self, home, away, league):
        import requests as r
        headers = {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
            'Accept': 'application/json, text/plain, */*',
            'Referer': 'https://www.sofascore.com/',
        }

        # Search for teams
        try:
            search_h = r.get(
                f"https://www.sofascore.com/api/v1/search/teams/{home}",
                headers=headers, timeout=10
            ).json()
            search_a = r.get(
                f"https://www.sofascore.com/api/v1/search/teams/{away}",
                headers=headers, timeout=10
            ).json()
        except Exception:
            return {}

        h_teams = search_h.get('teams', [])
        a_teams = search_a.get('teams', [])
        if not h_teams or not a_teams:
            return {}

        h_id = h_teams[0].get('id')
        a_id = a_teams[0].get('id')
        if not h_id or not a_id:
            return {}

        # Get team form
        try:
            form_h = r.get(
                f"https://www.sofascore.com/api/v1/team/{h_id}/events/last/10",
                headers=headers, timeout=10
            ).json()
            form_a = r.get(
                f"https://www.sofascore.com/api/v1/team/{a_id}/events/last/10",
                headers=headers, timeout=10
            ).json()
        except Exception:
            return {}

        def compute_xg_from_form(form_data, is_home_team):
            events = form_data.get('events', [])
            goals_for, goals_against = [], []
            for e in events[:5]:
                if e.get('status', {}).get('type') == 'finished':
                    home_score = e.get('homeScore', {}).get('current', 0)
                    away_score = e.get('awayScore', {}).get('current', 0)
                    if is_home_team:
                        goals_for.append(home_score)
                        goals_against.append(away_score)
                    else:
                        goals_for.append(away_score)
                        goals_against.append(home_score)
            if goals_for:
                return sum(goals_for) / len(goals_for), sum(goals_against) / len(goals_against)
            return 1.5, 1.2

        gf_h, ga_h = compute_xg_from_form(form_h, True)
        gf_a, ga_a = compute_xg_from_form(form_a, False)

        xg_h = gf_h * 0.5 + ga_a * 0.5
        xg_a = gf_a * 0.5 + ga_h * 0.5

        return {'xg_home': max(0.4, xg_h), 'xg_away': max(0.4, xg_a)}

    def _scrape_local_history(self, home, away):
        """Try to find historical average goals from tactical.db or archive."""
        try:
            conn = sqlite3.connect(self.db_path)
            conn.row_factory = sqlite3.Row

            # Get recent home matches for home team
            h_home = conn.execute(
                """SELECT scoreHome, scoreAway FROM matches
                   WHERE (homeTeam = ? OR awayTeam = ?)
                   AND scoreHome IS NOT NULL AND scoreAway IS NOT NULL
                   AND scoreHome > 0 AND scoreAway > 0
                   ORDER BY timestamp DESC LIMIT 10""",
                (home, home)
            ).fetchall()

            a_away = conn.execute(
                """SELECT scoreHome, scoreAway FROM matches
                   WHERE (homeTeam = ? OR awayTeam = ?)
                   AND scoreHome IS NOT NULL AND scoreAway IS NOT NULL
                   AND scoreHome > 0 AND scoreAway > 0
                   ORDER BY timestamp DESC LIMIT 10""",
                (away, away)
            ).fetchall()

            conn.close()

            h_gf, h_ga = [], []
            for r in h_home:
                if r['homeTeam'] == home or str(r[0]) == home:
                    h_gf.append(r['scoreHome'])
                    h_ga.append(r['scoreAway'])
                else:
                    h_gf.append(r['scoreAway'])
                    h_ga.append(r['scoreHome'])

            a_gf, a_ga = [], []
            for r in a_away:
                if r['homeTeam'] == away or str(r[0]) == away:
                    a_gf.append(r['scoreHome'])
                    a_ga.append(r['scoreAway'])
                else:
                    a_gf.append(r['scoreAway'])
                    a_ga.append(r['scoreHome'])

            if h_gf and a_gf:
                xg_h = (sum(h_gf) / len(h_gf)) * 0.5 + (sum(a_ga) / len(a_ga)) * 0.5
                xg_a = (sum(a_gf) / len(a_gf)) * 0.5 + (sum(h_ga) / len(h_ga)) * 0.5
                return {'xg_home': max(0.4, xg_h), 'xg_away': max(0.4, xg_a)}

        except Exception:
            pass

        return {}

    # ── xG COMPUTATION ────────────────────────────────────────────

    def _compute_xg(self, scraped, home, away):
        xg_h = scraped.get('xg_home', 0)
        xg_a = scraped.get('xg_away', 0)

        if xg_h <= 0 and xg_a <= 0:
            return 1.35, 1.15

        # Apply home advantage boost
        xg_h = xg_h * 1.08

        # Floor to avoid absurdly low values
        xg_h = max(0.4, xg_h)
        xg_a = max(0.4, xg_a)

        return xg_h, xg_a

    # ── PICK DETERMINATION ────────────────────────────────────────

    def _determine_pick(self, p_home, p_draw, p_away):
        picks = [('1', p_home), ('X', p_draw), ('2', p_away)]
        best = max(picks, key=lambda p: p[1])
        pick = best[0]
        prob = best[1]

        # Compute simple EV (assumes ~2.0 odds for pick)
        ev = round((prob / 100 * 2.0) - 1.0, 2)

        return pick, prob, ev

    # ── DATABASE WRITE ────────────────────────────────────────────

    def _update_db(self, match_id, data):
        try:
            from data_loader import update_match_predictions
            ok = update_match_predictions(match_id, data)
            if ok:
                logger.info(f"[FALLBACK] Updated {match_id}: {data['prediction']} ({data['prediction_probability']}%)")
            else:
                logger.warn(f"[FALLBACK] update_match_predictions returned False for {match_id}")
        except Exception as e:
            logger.error(f"[FALLBACK] DB update failed for {match_id}: {e}")


# ── STANDALONE RUNNER ─────────────────────────────────────────────

def run_fallback_batch(matches):
    """Convenience function for cron/script usage."""
    service = FreeFallbackService()
    return service.enrich_match_batch(matches)


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    test_matches = [
        {"id": "test-001", "homeTeam": "Manchester City", "awayTeam": "Arsenal", "league": "Premier League"},
    ]
    result = run_fallback_batch(test_matches)
    print(json.dumps(result, indent=2, default=str))
