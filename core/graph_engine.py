"""
Graph Engine (GNN-lite): Transitive Strength & Network Analysis
Models football as a directed graph where:
  - Nodes = teams
  - Edges = match results (weighted by score margin + recency)
Computes: PageRank, transitive strength, community clusters, stylistic similarity.
Falls back to Elo when insufficient match data.
"""
import math
import json
import os
import sqlite3
from collections import defaultdict

DB_ARCHIVE_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'historical_archive.sqlite')
ELO_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'elo_ratings.json')

_graph_cache = {}
_cache_ttl = 3600  # 1 hour

def _load_elo():
    try:
        with open(ELO_PATH, 'r') as f:
            return json.load(f)
    except:
        return {}

ELO = _load_elo()


def _build_graph(league_filter=None, min_matches=3):
    """Build directed graph from match history. Edge weight = margin * recency * home_factor."""
    cache_key = f"graph:{league_filter}:{min_matches}"
    now = __import__('time').time()
    if cache_key in _graph_cache and (now - _graph_cache[cache_key]['ts']) < _cache_ttl:
        return _graph_cache[cache_key]['data']

    edges = defaultdict(lambda: {'wins': 0, 'losses': 0, 'total_goals_for': 0, 'total_goals_against': 0, 'count': 0, 'recent_results': []})
    
    try:
        if os.path.exists(DB_ARCHIVE_PATH):
            conn = sqlite3.connect(DB_ARCHIVE_PATH, timeout=5)
            conn.row_factory = sqlite3.Row
            cur = conn.cursor()
            
            query = "SELECT homeTeam, awayTeam, score_home, score_away, match_date FROM matches WHERE score_home IS NOT NULL"
            params = []
            if league_filter:
                query += " AND league LIKE ?"
                params.append(f"%{league_filter}%")
            query += " ORDER BY match_date DESC LIMIT 5000"
            
            cur.execute(query, params)
            rows = cur.fetchall()
            conn.close()
            
            for row in rows:
                h, a = row['homeTeam'], row['awayTeam']
                sh, sa = row['score_home'] or 0, row['score_away'] or 0
                if not h or not a:
                    continue
                
                # Edge: h -> a (home team perspective)
                key = (h, a)
                edges[key]['count'] += 1
                edges[key]['total_goals_for'] += sh
                edges[key]['total_goals_against'] += sa
                if sh > sa:
                    edges[key]['wins'] += 1
                elif sh < sa:
                    edges[key]['losses'] += 1
                edges[key]['recent_results'].append((sh, sa))
                if len(edges[key]['recent_results']) > 5:
                    edges[key]['recent_results'] = edges[key]['recent_results'][:5]
                
                # Reverse edge
                rkey = (a, h)
                edges[rkey]['count'] += 1
                edges[rkey]['total_goals_for'] += sa
                edges[rkey]['total_goals_against'] += sh
                if sa > sh:
                    edges[rkey]['wins'] += 1
                elif sa < sh:
                    edges[rkey]['losses'] += 1
    except Exception:
        pass

    _graph_cache[cache_key] = {'data': dict(edges), 'ts': now}
    return dict(edges)


def _pagerank(edges, damping=0.85, iterations=20):
    """Simplified PageRank on team graph."""
    teams = set()
    for (h, a) in edges:
        teams.add(h)
        teams.add(a)
    teams = list(teams)
    n = len(teams)
    if n == 0:
        return {}
    
    team_idx = {t: i for i, t in enumerate(teams)}
    rank = {t: 1.0 / n for t in teams}
    
    # Build adjacency: who beats whom (weighted by margin)
    adj = defaultdict(float)
    out_weight = defaultdict(float)
    
    for (h, a), data in edges.items():
        w = data['wins'] * 3 + data['count']  # win=3, draw=1
        if w > 0:
            adj[h] += w
            out_weight[h] += w
    
    for _ in range(iterations):
        new_rank = {}
        for t in teams:
            pr = (1 - damping) / n
            # Inflow: teams that lost to t get rank redistributed
            for other in teams:
                key = (other, t)
                if key in edges and edges[key]['losses'] > 0:
                    # other lost to t, so t gets some of other's rank
                    if out_weight[other] > 0:
                        pr += damping * rank[other] * (edges[key]['losses'] / out_weight[other])
            new_rank[t] = pr
        
        # Normalize
        total = sum(new_rank.values())
        if total > 0:
            rank = {t: v / total for t, v in new_rank.items()}
    
    return rank


def _compute_transitive_strength(edges, team, all_teams):
    """Compute transitive strength: how strong is this team through indirect wins (BFS depth 2)."""
    if team not in all_teams:
        return 0.5
    
    direct_wins = 0
    direct_losses = 0
    transitive_wins = 0
    
    for other in all_teams:
        if other == team:
            continue
        key = (team, other)
        if key in edges:
            data = edges[key]
            direct_wins += data['wins']
            direct_losses += data['losses']
            
            # Transitive: if team beat other, and other beat X, then team > X transitively
            if data['wins'] > data['losses']:
                for third in all_teams:
                    if third == team or third == other:
                        continue
                    key2 = (other, third)
                    if key2 in edges and edges[key2]['wins'] > 0:
                        transitive_wins += edges[key2]['wins']
    
    total = direct_wins + direct_losses + 1
    return (direct_wins * 2 + transitive_wins * 0.5) / (total * 2 + transitive_wins + 1)


def _detect_communities(edges, all_teams):
    """Simple community detection: teams that frequently play/beat each other form clusters."""
    if not all_teams:
        return {}
    
    # Build similarity matrix based on shared opponents
    similarity = defaultdict(lambda: defaultdict(float))
    
    for team1 in all_teams:
        opponents1 = set()
        for (h, a) in edges:
            if h == team1:
                opponents1.add(a)
            elif a == team1:
                opponents1.add(h)
        
        for team2 in all_teams:
            if team1 >= team2:
                continue
            opponents2 = set()
            for (h, a) in edges:
                if h == team2:
                    opponents2.add(a)
                elif a == team2:
                    opponents2.add(h)
            
            shared = len(opponents1 & opponents2)
            total = len(opponents1 | opponents2)
            if total > 0:
                similarity[team1][team2] = shared / total
                similarity[team2][team1] = shared / total
    
    # Greedy community assignment: each team joins the community of its most similar neighbor
    communities = {}
    comm_id = 0
    assigned = set()
    
    for team in all_teams:
        if team in assigned:
            continue
        communities[team] = comm_id
        assigned.add(team)
        
        # Find most similar unassigned team
        best_sim = 0
        best_team = None
        for other in all_teams:
            if other in assigned:
                continue
            s = similarity.get(team, {}).get(other, 0)
            if s > best_sim:
                best_sim = s
                best_team = other
        
        if best_team and best_sim > 0.3:
            communities[best_team] = comm_id
            assigned.add(best_team)
        
        comm_id += 1
    
    return communities


def compute_graph_features(home_team, away_team, league=None):
    """
    Main entry: compute graph-based features for a match.
    Returns dict of features to inject into ml_features.
    """
    edges = _build_graph(league_filter=league)
    all_teams = set()
    for (h, a) in edges:
        all_teams.add(h)
        all_teams.add(a)
    
    # Fallback if insufficient data
    if len(all_teams) < 10 or not edges:
        elo_h = ELO.get(home_team, 1500)
        elo_a = ELO.get(away_team, 1500)
        elo_diff = elo_h - elo_a
        return {
            'graph_pagerank_h': elo_h / 3000,
            'graph_pagerank_a': elo_a / 3000,
            'graph_transitive_h': 0.5 + elo_diff / 2000,
            'graph_transitive_a': 0.5 - elo_diff / 2000,
            'graph_community_match': 0,
            'graph_direct_record_h': 0.5,
            'graph_direct_record_a': 0.5,
            'graph_attack_density_h': 1.3,
            'graph_attack_density_a': 1.15,
            'graph_defense_strength_h': 1.0,
            'graph_defense_strength_a': 1.0,
            'graph_strength_diff': elo_diff / 2000,
            'graph_network_size': len(all_teams),
        }
    
    # 1. PageRank
    pagerank = _pagerank(edges)
    
    # 2. Transitive strength
    trans_h = _compute_transitive_strength(edges, home_team, all_teams)
    trans_a = _compute_transitive_strength(edges, away_team, all_teams)
    
    # 3. Community detection
    communities = _detect_communities(edges, all_teams)
    community_match = 1 if communities.get(home_team) == communities.get(away_team) else 0
    
    # 4. Direct H2H record
    key_h2h = (home_team, away_team)
    key_h2h_r = (away_team, home_team)
    h2h = edges.get(key_h2h, {})
    h2h_r = edges.get(key_h2h_r, {})
    total_h2h = h2h.get('count', 0) + h2h_r.get('count', 0)
    if total_h2h > 0:
        h_wins = h2h.get('wins', 0) + h2h_r.get('losses', 0)
        a_wins = h2h.get('losses', 0) + h2h_r.get('wins', 0)
        direct_record_h = h_wins / total_h2h
        direct_record_a = a_wins / total_h2h
    else:
        direct_record_h = 0.5
        direct_record_a = 0.5
    
    # 5. Attack density (avg goals scored per match in graph)
    h_offense = edges.get((home_team, 'any'), {})
    a_offense = edges.get((away_team, 'any'), {})
    
    # Compute from all edges for this team
    h_goals_scored = 0
    h_goals_conceded = 0
    h_matches = 0
    a_goals_scored = 0
    a_goals_conceded = 0
    a_matches = 0
    
    for (h, a), data in edges.items():
        if h == home_team:
            h_goals_scored += data['total_goals_for']
            h_goals_conceded += data['total_goals_against']
            h_matches += data['count']
        if h == away_team:
            a_goals_scored += data['total_goals_for']
            a_goals_conceded += data['total_goals_against']
            a_matches += data['count']
    
    attack_density_h = (h_goals_scored / max(h_matches, 1)) if h_matches > 0 else 1.3
    attack_density_a = (a_goals_scored / max(a_matches, 1)) if a_matches > 0 else 1.15
    defense_h = (h_goals_conceded / max(h_matches, 1)) if h_matches > 0 else 1.1
    defense_a = (a_goals_conceded / max(a_matches, 1)) if a_matches > 0 else 1.0
    
    pr_h = pagerank.get(home_team, 1.0 / max(len(all_teams), 1))
    pr_a = pagerank.get(away_team, 1.0 / max(len(all_teams), 1))
    
    return {
        'graph_pagerank_h': pr_h,
        'graph_pagerank_a': pr_a,
        'graph_transitive_h': trans_h,
        'graph_transitive_a': trans_a,
        'graph_community_match': community_match,
        'graph_direct_record_h': direct_record_h,
        'graph_direct_record_a': direct_record_a,
        'graph_attack_density_h': round(attack_density_h, 3),
        'graph_attack_density_a': round(attack_density_a, 3),
        'graph_defense_strength_h': round(1.0 / max(defense_h, 0.1), 3),
        'graph_defense_strength_a': round(1.0 / max(defense_a, 0.1), 3),
        'graph_strength_diff': round(pr_h - pr_a, 4),
        'graph_network_size': len(all_teams),
    }


# Feature names for XGBoost integration
GRAPH_FEATURE_NAMES = [
    'graph_pagerank_h', 'graph_pagerank_a',
    'graph_transitive_h', 'graph_transitive_a',
    'graph_community_match',
    'graph_direct_record_h', 'graph_direct_record_a',
    'graph_attack_density_h', 'graph_attack_density_a',
    'graph_defense_strength_h', 'graph_defense_strength_a',
    'graph_strength_diff',
    'graph_network_size',
]

if __name__ == '__main__':
    # Test
    features = compute_graph_features('Liverpool', 'Arsenal', 'Premier League')
    print(json.dumps(features, indent=2))
