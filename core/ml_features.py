import json
import sqlite3
import os
import math
import functools

DB_ARCHIVE_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'historical_archive.sqlite')
DB_TACTICAL_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'tactical.db')
ELO_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'elo_ratings.json')
STYLES_PATH = os.path.join(os.path.dirname(os.path.dirname(__file__)), 'data', 'team_styles.json')

def load_json(path):
    if os.path.exists(path):
        try:
            with open(path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except: return {}
    return {}

ELO_RATINGS = load_json(ELO_PATH)
TEAM_STYLES = load_json(STYLES_PATH)

def _f(v, default=0.0):
    try:
        if v is None or str(v).lower() in ['none', 'null', '', 'nan']: return float(default)
        return float(v)
    except:
        return float(default)

def parse_pct(s):
    return _f(str(s).replace('%', '').strip() if s else 0)

_DB_CONN = None

def get_db_connection():
    global _DB_CONN
    if not os.path.exists(DB_ARCHIVE_PATH):
        return None
    
    # Check if connection is alive, if not create it
    if _DB_CONN is None:
        try:
            _DB_CONN = sqlite3.connect(DB_ARCHIVE_PATH, check_same_thread=False)
            _DB_CONN.row_factory = sqlite3.Row
        except:
            return None
    return _DB_CONN

def close_db_connection():
    global _DB_CONN
    if _DB_CONN:
        try:
            _DB_CONN.close()
        except: pass
        _DB_CONN = None

def extract_features_from_stats(stats_json):
    if not stats_json: return {}
    try:
        stats = json.loads(stats_json)
        features = {}
        if not isinstance(stats, list): return {}
        for item in stats:
            if not isinstance(item, dict): continue
            cat = item.get('category', 'Unknown')
            val_h = item.get('homeValue', 0)
            val_a = item.get('awayValue', 0)
            def _clean(val):
                if isinstance(val, str):
                    try: return float(val.replace('%', '').split('/')[0])
                    except: return 0.0
                return float(val) if val is not None else 0.0
            features[f"{cat}_home"] = _clean(val_h)
            features[f"{cat}_away"] = _clean(val_a)
        return features
    except: return {}

@functools.lru_cache(maxsize=256)
def get_team_history(team_name, limit=10, current_match_ts=None):
    conn = get_db_connection()
    if not conn: return []
    try:
        clean_name = team_name.strip()

        # [DATA LEAKAGE FIX] Only fetch matches that finished BEFORE the current match.
        # If no timestamp is given, we use the current UTC time as a safe cutoff.
        import time
        cutoff_ts = int(current_match_ts) if current_match_ts else int(time.time())

        query = """
        SELECT stats_blob, homeTeam, awayTeam, scoreHome, scoreAway, startTimestamp 
        FROM archive_matches 
        WHERE homeTeam = ? 
        AND stats_blob IS NOT NULL
        AND scoreHome IS NOT NULL
        AND (startTimestamp IS NULL OR startTimestamp < ?)
        UNION ALL
        SELECT stats_blob, homeTeam, awayTeam, scoreHome, scoreAway, startTimestamp 
        FROM archive_matches 
        WHERE awayTeam = ? 
        AND stats_blob IS NOT NULL
        AND scoreHome IS NOT NULL
        AND (startTimestamp IS NULL OR startTimestamp < ?)
        ORDER BY startTimestamp DESC LIMIT ?
        """
        rows = conn.execute(query, (clean_name, cutoff_ts, clean_name, cutoff_ts, limit)).fetchall()
        
        history = []
        for r in rows:
            feats = extract_features_from_stats(r['stats_blob']) or {}
            h_team = r['homeTeam'] or ''
            a_team = r['awayTeam'] or ''
            is_home = (h_team.lower() == clean_name.lower())
            
            norm = {}
            for k, v in feats.items():
                if is_home: norm[k] = v
                else:
                    if '_home' in k: norm[k.replace('_home', '_away')] = v
                    elif '_away' in k: norm[k.replace('_away', '_home')] = v
            
            s_for = r['scoreHome']
            s_ag = r['scoreAway']
            if not is_home: s_for, s_ag = s_ag, s_for
            
            norm['score_for'] = float(s_for) if s_for is not None else 0.0
            norm['score_against'] = float(s_ag) if s_ag is not None else 0.0
            norm['opponent_name'] = a_team if is_home else h_team
            
            if norm['score_for'] > norm['score_against']: norm['points'] = 3.0
            elif norm['score_for'] == norm['score_against']: norm['points'] = 1.0
            else: norm['points'] = 0.0
            
            history.append(norm)
        return history
    except: return []

def calculate_rolling_averages(history_list, window=30):
    """
    V20 Quantum Decay: Uses a 30-match window with exponential weighting.
    Recent matches have significantly higher influence on the average.
    """
    if not history_list: return 0.0, 0.0
    
    # Use up to 30 matches
    history = history_list[:min(len(history_list), window)]
    
    weighted_goals = 0.0
    weighted_points = 0.0
    total_weight = 0.0
    
    # Alpha of 0.15 for exponential decay
    alpha = 0.15
    
    for i, m in enumerate(history):
        # i=0 is most recent
        weight = math.pow(1 - alpha, i)
        weighted_goals += m.get('score_for', 0) * weight
        weighted_points += m.get('points', 0) * weight
        total_weight += weight
        
    if total_weight == 0: return 0.0, 0.0
    return weighted_goals / total_weight, weighted_points / total_weight

def calculate_glicko_momentum(history_list, window=5):
    """
    Momentum V13: Weights points by the strength of the opponent (ELO).
    Gaining 3pts against 1800 ELO > 3pts against 1200 ELO.
    """
    if not history_list: return 0.0
    recent = history_list[:window]
    weighted_scores = []
    
    for m in recent:
        opponent = m.get('opponent_name', 'Unknown')
        opp_elo = _f(ELO_RATINGS.get(opponent), 1500)
        # Strength multiplier: 1500=1.0, 1800=1.2, 1200=0.8
        strength_mult = opp_elo / 1500.0
        weighted_scores.append(_f(m.get('points'), 0) * strength_mult)
        
    return sum(weighted_scores) / len(weighted_scores)

def get_detailed_team_style(stats, league_avg_possession=52.0):
    """
    Tactical DNA 2.0: Infers playstyle relative to the league average.
    Uses league-relative thresholds to avoid misclassifying teams in
    defensive or offensive leagues.
    """
    if not stats: return "Balanced"
    
    pos = stats.get('Ball possession_home') or stats.get('avgPossession') or 50
    if isinstance(pos, str): pos = float(pos.replace('%', ''))
    
    shots = stats.get('Total shots_home') or stats.get('avgShots') or 10
    saves = stats.get('Goalkeeper saves_home') or stats.get('avgSaves') or 2

    # [LEAGUE-RELATIVE FIX] Use offsets from the league average instead of global constants
    high_pos_threshold = league_avg_possession + 4.0  # ~56% in standard leagues
    low_pos_threshold = league_avg_possession - 8.0   # ~44% in standard leagues
    
    if pos > high_pos_threshold: return "Possession"
    if pos < low_pos_threshold and shots > 12: return "Counter-Attack"
    if shots > 16: return "High Press"
    if saves > 4: return "Low Block"
    
    return "Balanced"
    
def get_match_motivation_context(row):
    """
    V25 Contextual Intelligence: 
    Detects if a match is a Final, Relegation Battle, or Friendly.
    """
    tournament = str(row.get('tournament_name', '')).lower()
    is_final = any(x in tournament for x in ['final', 'cup', 'trophy', 'play-off'])
    is_friendly = any(x in tournament for x in ['friendly', 'amical', 'club matches', 'world', 'international'])
    
    # 1. Finals (Max Motivation)
    if is_final: return 1.5, "FINAL_CUP"
    
    # 2. Relegation Battle (High Survival Stress)
    form_ctx = row.get('form_context')
    if isinstance(form_ctx, str):
        try: form_ctx = json.loads(form_ctx)
        except: form_ctx = {}
    elif not isinstance(form_ctx, dict):
        form_ctx = {}
    
    h_standing = (form_ctx.get('home') or {}).get('standing', {})
    a_standing = (form_ctx.get('away') or {}).get('standing', {})
    
    h_pos = int(h_standing.get('position', 10))
    a_pos = int(a_standing.get('position', 10))
    
    # Assuming standard 20-team league for threshold
    if h_pos >= 17 or a_pos >= 17:
        return 1.4, "RELEGATION_BATTLE"
    
    # 3. Friendly (Reduced Motivation but Predicted)
    if is_friendly: return 0.85, "FRIENDLY"
    
    return 1.0, "STANDARD"
    
def is_derby_match(home_name, away_name):
    """[V102] Detects local derbies to neutralize naive Home Advantage."""
    # Shared city/stadium keywords
    local_rivals = [
        ("Manchester", "Manchester"), ("Arsenal", "Tottenham"), ("Liverpool", "Everton"),
        ("Milan", "Inter"), ("Lazio", "Roma"), ("Real Madrid", "Atletico"),
        ("Benfica", "Sporting"), ("Porto", "Boavista"), ("Al Hilal", "Al Nassr"),
        ("Al Ittihad", "Al Ahli"), ("Raja", "Wydad"), ("Esperance", "Club Africain")
    ]
    for team1, team2 in local_rivals:
        if team1 in home_name and team2 in away_name: return True
        if team2 in home_name and team1 in away_name: return True
    return False


def calculate_data_completeness(features):
    """V25 Reliability Score Component: Measures feature density."""
    essential = ['h_xg', 'a_xg', 'h_pos', 'a_pos', 'h_sot', 'a_sot']
    found = sum(1 for f in essential if features.get(f, 0) > 0)
    return (found / len(essential)) * 100

def calculate_momentum_trend(graph_data):
    """
    V26 Elite Intelligence: Analyzes the Sofascore Attack Momentum graph.
    Returns: (home_pressure, away_pressure, trend_slope)
    """
    if not graph_data or 'graphPoints' not in graph_data:
        return 0.0, 0.0, 0.0
    
    points = graph_data['graphPoints']
    if not points: return 0.0, 0.0, 0.0
    
    # Values: > 0 (Home Pressure), < 0 (Away Pressure)
    home_vals = [p['value'] for p in points if p['value'] > 0]
    away_vals = [abs(p['value']) for p in points if p['value'] < 0]
    
    h_avg = sum(home_vals) / len(home_vals) if home_vals else 0.0
    a_avg = sum(away_vals) / len(away_vals) if away_vals else 0.0
    
    # Recent Trend (last 5 points)
    recent = points[-5:] if len(points) >= 5 else points
    trend = 0.0
    if len(recent) >= 2:
        trend = recent[-1]['value'] - recent[0]['value']
        
    return h_avg, a_avg, trend

def calculate_travel_fatigue(home_country, away_country):
    """
    [DISTANCE-AWARE] Estimates away team travel fatigue based on geographic distance.
    Returns a fatigue multiplier (0.0 = no extra fatigue, higher = more fatigued).
    """
    if not home_country or not away_country or home_country == away_country:
        return 0.0

    # Continent groupings for distance estimation
    CONTINENT_MAP = {
        'europe': ['england', 'spain', 'france', 'germany', 'italy', 'portugal', 'netherlands',
                   'belgium', 'scotland', 'turkey', 'greece', 'switzerland', 'austria', 'sweden',
                   'denmark', 'norway', 'poland', 'czech', 'russia', 'ukraine', 'croatia', 'serbia'],
        'south_america': ['brazil', 'argentina', 'colombia', 'chile', 'uruguay', 'peru', 'ecuador', 'venezuela'],
        'north_america': ['usa', 'mexico', 'canada', 'costa rica', 'honduras', 'guatemala'],
        'africa': ['morocco', 'egypt', 'nigeria', 'senegal', 'ghana', 'ivory coast', 'cameroon', 
                   'south africa', 'algeria', 'tunisia', 'kenya', 'ethiopia'],
        'asia': ['japan', 'south korea', 'china', 'saudi arabia', 'uae', 'qatar', 'iran',
                 'india', 'australia', 'thailand', 'indonesia'],
        'middle_east': ['saudi arabia', 'uae', 'qatar', 'iran', 'iraq', 'jordan', 'kuwait']
    }

    def get_continent(country):
        c = (country or '').lower()
        for continent, countries in CONTINENT_MAP.items():
            if any(x in c for x in countries):
                return continent
        return 'unknown'

    home_cont = get_continent(home_country)
    away_cont = get_continent(away_country)

    if home_cont == away_cont and home_cont != 'unknown':
        return 0.8   # Same continent — minimal fatigue (e.g., Madrid → London)
    elif home_cont == 'unknown' or away_cont == 'unknown':
        return 1.2   # Unknown geography — moderate conservative penalty
    else:
        return 2.0   # Intercontinental — heavy fatigue (e.g., Tokyo → London)


def calculate_cumulative_fatigue(history_list, num_matches=3):
    """
    Ultra Factor: Estimates cumulative fatigue based on recent match intensity.
    Uses the last N matches to estimate physiological load.
    Returns a fatigue coefficient (0.85 to 1.0) where lower = more fatigued.
    """
    if not history_list: return 1.0
    
    recent = history_list[:min(len(history_list), num_matches)]
    fatigue_score = 1.0
    
    # Base penalty for having played exactly N matches recently (proxy for tight schedule)
    if len(recent) >= 3:
        fatigue_score -= 0.05
        
    for match in recent:
        # Heavily contested matches (close scores) add to fatigue
        sf = match.get('score_for', 0)
        sa = match.get('score_against', 0)
        
        if abs(sf - sa) <= 1:
            fatigue_score -= 0.02
            
        # Physicality factors: low possession means more running/chasing the ball
        poss = match.get('Ball possession_home', match.get('Ball possession_away', 50.0))
        if poss < 40.0:
            fatigue_score -= 0.015
            
        # High tackle volume implies higher physical intensity
        tackles = match.get('Tackles_home', match.get('Tackles_away', 15.0))
        if tackles > 18.0:
            fatigue_score -= 0.015
            
    # Cap the penalty to avoid catastrophic drops
    return max(0.85, fatigue_score)

def calculate_injury_impact(news_data, team_name):
    """[ROLE-WEIGHTED] Injury impact respects player position criticality."""
    if not news_data: return 0.0
    # Role-based impact weights (GK and playmaker absence hurts most)
    ROLE_IMPACT = {
        'goalkeeper': 4.5, 'keeper': 4.5, 'gk': 4.5,
        'playmaker': 4.0, 'captain': 3.5,
        'striker': 3.0, 'forward': 3.0,
        'defender': 2.5, 'center-back': 2.5,
        'midfielder': 2.0, 'winger': 2.0
    }
    try:
        news = json.loads(news_data) if isinstance(news_data, str) else news_data
        injuries = news.get('injuries', {})
        h_name = news.get('homeTeam', '')
        team_type = 'home' if team_name == h_name else 'away'
        players = injuries.get(team_type, [])
        if not players: return 0.0
        
        style_data = TEAM_STYLES.get(team_name, {})
        key_players = style_data.get('key_players', [])
        
        impact = 0.0
        for p in players:
            p_name = p if isinstance(p, str) else (p.get('name', '') if isinstance(p, dict) else '')
            p_role = p.get('position', '').lower() if isinstance(p, dict) else ''

            # Check role-based weight first
            role_w = 1.0
            for role_key, role_val in ROLE_IMPACT.items():
                if role_key in p_role:
                    role_w = role_val
                    break

            # Key player bonus
            if any(kp.lower() in p_name.lower() for kp in key_players):
                impact += max(role_w, 3.0)
            else:
                impact += role_w
        return impact
    except:
        return 0.0

def calculate_motivation(standing, total_teams=20):
    if not standing: return 1.0
    try:
        pos = int(standing.get('position', 10))
        matches = int(standing.get('matches', 0))
        if matches > (total_teams * 0.7):
            if pos <= 3: return 1.25
            if pos >= total_teams - 3: return 1.35
            if 8 <= pos <= 13: return 0.85
    except: pass
    return 1.0

def get_tactical_synergy(home_name, away_name):
    h_style = TEAM_STYLES.get(home_name, {}).get('style', 'Balanced')
    a_style = TEAM_STYLES.get(away_name, {}).get('style', 'Balanced')
    if a_style == 'Counter-Attack' and h_style == 'Possession':
        return 1.2
    if h_style == 'Counter-Attack' and a_style == 'Possession':
        return 0.8
    return 1.0

def extract_ml_features(row, fetch_history=True, current_match_ts=None):
    features = {}
    
    home_name = row.get('homeTeam', 'Home')
    away_name = row.get('awayTeam', 'Away')

    # 0. Elo Ratings
    features['home_elo'] = _f(ELO_RATINGS.get(home_name), 1500)
    features['away_elo'] = _f(ELO_RATINGS.get(away_name), 1500)
    features['elo_diff'] = features['home_elo'] - features['away_elo']

    # 1. Motivation (ULTRA)
    form_ctx = row.get('form_context')
    if not form_ctx: form_ctx = {}
    if isinstance(form_ctx, str):
        try: form_ctx = json.loads(form_ctx)
        except: form_ctx = {}
    if not isinstance(form_ctx, dict): form_ctx = {}
    
    h_form = form_ctx.get('home') or {}
    a_form = form_ctx.get('away') or {}
    
    features['home_motivation'] = calculate_motivation(h_form.get('standing'))
    features['away_motivation'] = calculate_motivation(a_form.get('standing'))

    # 2. Tactical Synergy (ULTRA)
    features['tactical_synergy'] = get_tactical_synergy(home_name, away_name)

    # 3. Squad Depth (ULTRA)
    news_data = row.get('news_data')
    features['home_injury_impact'] = calculate_injury_impact(news_data, home_name)
    features['away_injury_impact'] = calculate_injury_impact(news_data, away_name)

    # 4. Momentum (Rolling Averages)
    if fetch_history:
        h_hist = get_team_history(home_name, limit=5, current_match_ts=current_match_ts)
        a_hist = get_team_history(away_name, limit=5, current_match_ts=current_match_ts)
    else:
        h_hist = row.get('history_home', [])
        a_hist = row.get('history_away', [])

    h_roll_g3, h_roll_p3 = calculate_rolling_averages(h_hist, window=3)
    a_roll_g3, a_roll_p3 = calculate_rolling_averages(a_hist, window=3)
    features['home_momentum_goals'] = h_roll_g3
    features['home_momentum_points'] = h_roll_p3
    features['away_momentum_goals'] = a_roll_g3
    features['away_momentum_points'] = a_roll_p3
    
    # 5. Cumulative Fatigue (ULTRA)
    if fetch_history:
        features['h_fatigue_cumulative'] = calculate_cumulative_fatigue(h_hist)
        features['a_fatigue_cumulative'] = calculate_cumulative_fatigue(a_hist)
    else:
        features['h_fatigue_cumulative'] = 1.0
        features['a_fatigue_cumulative'] = 1.0
    
    # V13 Advanced Momentum
    features['home_glicko_momentum'] = calculate_glicko_momentum(h_hist)
    features['away_glicko_momentum'] = calculate_glicko_momentum(a_hist)
    # Fallback to teamStats if history is empty (early season)
    team_stats_raw = row.get('teamStats')
    if team_stats_raw is None: team_stats_raw = '{}'
    
    try:
        ts = json.loads(team_stats_raw) if isinstance(team_stats_raw, str) else team_stats_raw
    except:
        ts = {}
        
    if not isinstance(ts, dict): ts = {}
    ts_h = ts.get('home') if isinstance(ts.get('home'), dict) else {}
    ts_a = ts.get('away') if isinstance(ts.get('away'), dict) else {}

    def _get_avg_hist(hist, key, ts_dict, ts_key, default=0.0):
        # Extracts from history arrays, falling back to team season stats if history fails
        if isinstance(hist, list) and len(hist) > 0 and isinstance(hist[0], dict) and key in hist[0]:
            vals = [m.get(key, default) for m in hist if isinstance(m, dict)]
            return sum(vals)/len(vals) if vals else default
        
        # Safe access to ts_dict
        if isinstance(ts_dict, dict):
            try:
                return float(ts_dict.get(ts_key, default))
            except (ValueError, TypeError):
                return float(default)
        return float(default)

    # 🌍 [STITCH V19 TITANIUM] Expanded Micro-Statistics (115+ Variables)
    # This section extracts deep tactical metrics for advanced pattern recognition.
    
    def _get_dual_stat(feat_dict, cat, ts_dict, ts_key, default=0.0):
        h = _get_avg_hist(h_hist, f'{cat}_home', ts_h, ts_key, default)
        a = _get_avg_hist(a_hist, f'{cat}_away', ts_a, ts_key, default)
        diff = h - a
        return h, a, diff

    # 1. Possession & Precision
    features['h_pos'], features['a_pos'], features['pos_diff'] = _get_dual_stat(features, 'Ball possession', ts_h, 'avgPossession', 50.0)
    features['h_pass_acc'], features['a_pass_acc'], features['pass_acc_diff'] = _get_dual_stat(features, 'Accurate passes', ts_h, 'passAccuracyPct', 80.0)
    
    # 2. Attack Dynamics
    features['h_xg'] = _f(row.get('home_xg') or ts_h.get('expectedGoals'), 1.0)
    features['a_xg'] = _f(row.get('away_xg') or ts_a.get('expectedGoals'), 1.0)
    features['xg_diff'] = features['h_xg'] - features['a_xg']
    features['h_bc'], features['a_bc'], features['bc_diff'] = _get_dual_stat(features, 'Big chances', ts_h, 'avgBigChances', 1.5)
    features['h_sot'], features['a_sot'], features['sot_diff'] = _get_dual_stat(features, 'Shots on target', ts_h, 'avgShotsOnTarget', 4.0)
    features['h_shots_off'], features['a_shots_off'], _ = _get_dual_stat(features, 'Shots off target', ts_h, 'avgShotsOffTarget', 5.0)
    features['h_inner_shots'], features['a_inner_shots'], _ = _get_dual_stat(features, 'Shots from inside box', ts_h, 'avgShotsInsideBox', 6.0)

    # 3. Defensive & Disruptive
    features['h_int'], features['a_int'], features['int_diff'] = _get_dual_stat(features, 'Interceptions', ts_h, 'avgInterceptions', 10.0)
    features['h_tackles'], features['a_tackles'], features['tackles_diff'] = _get_dual_stat(features, 'Tackles', ts_h, 'avgTackles', 15.0)
    features['h_clear'], features['a_clear'], features['clear_diff'] = _get_dual_stat(features, 'Clearances', ts_h, 'avgClearances', 18.0)
    features['h_def_err'], features['a_def_err'], _ = _get_dual_stat(features, 'Errors leading to goal', ts_h, 'errorsLeadingToGoal', 0.0)
    features['h_saves'], features['a_saves'], _ = _get_dual_stat(features, 'Goalkeeper saves', ts_h, 'avgSaves', 3.0)

    # 4. Duel & Physicality
    features['h_ground_won'], features['a_ground_won'], _ = _get_dual_stat(features, 'Ground duels won', ts_h, 'avgGroundDuelsWon', 40.0)
    features['h_aerial_won'], features['a_aerial_won'], _ = _get_dual_stat(features, 'Aerial duels won', ts_h, 'avgAerialDuelsWon', 15.0)
    features['h_poss_lost'], features['a_poss_lost'], features['lost_diff'] = _get_dual_stat(features, 'Possession lost', ts_h, 'avgPossessionLost', 130.0)

    # 5. Discipline & Set Pieces
    features['h_corners'], features['a_corners'], features['corner_diff'] = _get_dual_stat(features, 'Corner kicks', ts_h, 'avgCorners', 4.5)
    features['h_fouls'], features['a_fouls'], features['foul_diff'] = _get_dual_stat(features, 'Fouls', ts_h, 'avgFouls', 12.0)
    h_y = _get_avg_hist(h_hist, 'Yellow cards_home', ts_h, 'avgYellowCards', 2.0)
    a_y = _get_avg_hist(a_hist, 'Yellow cards_away', ts_a, 'avgYellowCards', 2.0)
    features['h_cards'], features['a_cards'] = h_y, a_y

    # 6. Stylistic & Momentum (V13/V19 Fusion)
    h_style = get_detailed_team_style(h_hist[0] if h_hist else {})
    a_style = get_detailed_team_style(a_hist[0] if a_hist else {})
    features['h_style_enc'] = hash(h_style) % 10
    features['a_style_enc'] = hash(a_style) % 10
    features['h_mom_gicko'] = calculate_glicko_momentum(h_hist)
    features['a_mom_gicko'] = calculate_glicko_momentum(a_hist)

    # 7. Market & Environmental (TITANIUM)
    features['h_att_imp'] = float(row.get('home_att') or 1.0)
    features['a_att_imp'] = float(row.get('away_att') or 1.0)
    features['news_sent'] = float(row.get('news_sentiment', 0))
    features['odds_h'] = float(row.get('odds_home') or 1.5)
    features['odds_a'] = float(row.get('odds_away') or 1.5)
    features['temp'] = float(row.get('weather_temp') or 20.0)
    
    # 8. Fatigue & Readiness
    features['rest_h'] = float(row.get('days_since_last_match_home') or 7)
    features['rest_a'] = float(row.get('days_since_last_match_away') or 7)
    
    h_team = str(row.get('homeTeam') or '')
    a_team = str(row.get('awayTeam') or '')
    features['travel_f'] = calculate_travel_fatigue(h_team, a_team) if h_team and a_team else 0.0
    features['is_cup'] = 1.0 if any(x in str(row.get('tournament_name','')).lower() for x in ['cup', 'coupe', 'pokal', 'copa', 'trophy']) else 0.0
    
    # [V102] Derby Awareness
    features['is_derby'] = 1.0 if is_derby_match(h_team, a_team) else 0.0

    # 9. V46 News Intelligence (Deep Parsing)
    news = row.get('news_data') or {}
    h_intel = (news.get('home') or {}).get('intelligence', {}).get('features', {})
    a_intel = (news.get('away') or {}).get('intelligence', {}).get('features', {})
    
    features['news_is_missing_gk'] = float(h_intel.get('is_missing_gk', 0) - a_intel.get('is_missing_gk', 0))
    features['news_is_missing_scorer'] = float(h_intel.get('is_missing_scorer', 0) - a_intel.get('is_missing_scorer', 0))
    features['news_is_missing_captain'] = float(h_intel.get('is_missing_captain', 0) - a_intel.get('is_missing_captain', 0))
    features['news_is_missing_star'] = float(h_intel.get('is_missing_star', 0) - a_intel.get('is_missing_star', 0))

    # 10. V47 Strategic Features (Market & Psychology)
    v70 = row.get('v70_analytics') or {}
    features['odds_velocity'] = _f((v70.get('odds_velocity') or {}).get('velocity_h'), 0)
    features['h_mkt_val'] = _f(row.get('home_market_value'), 50.0)
    features['a_mkt_val'] = _f(row.get('away_market_value'), 50.0)
    features['ref_bias'] = _f(row.get('referee_home_win_rate'), 0.45)
    features['is_pressure'] = _f(row.get('is_high_pressure'), 0)

    # 10.1 Titanium AI Pipeline (Environmental + Form Points)
    features['h_pts'] = _f(row.get('home_form_pts'), 0.0)
    features['a_pts'] = _f(row.get('away_form_pts'), 0.0)
    features['pts_diff'] = features['h_pts'] - features['a_pts']
    
    features['humidity'] = _f(row.get('weather_humidity'), 50.0)
    features['temp'] = _f(row.get('weather_temp'), 20.0)
    
    # Odds Implied Probabilities
    oh = float(row.get('odds_home') or row.get('odds_h') or 2.5)
    od = float(row.get('odds_draw') or 3.2)
    oa = float(row.get('odds_away') or row.get('odds_a') or 2.8)
    
    ipH = 1.0 / oh if oh > 0 else 0.33
    ipD = 1.0 / od if od > 0 else 0.33
    ipA = 1.0 / oa if oa > 0 else 0.33
    
    total_ip = ipH + ipD + ipA
    features['ip_h'] = ipH / total_ip
    features['ip_d'] = ipD / total_ip
    features['ip_a'] = ipA / total_ip
    
    temp = float(row.get('weather_temp') or 20.0)
    w_desc = str(row.get('weather_desc','')).lower()
    features['is_extreme_weather'] = 1.0 if (temp > 35 or temp < 5 or "heavy" in w_desc or "rain" in w_desc or "snow" in w_desc) else 0.0

    # --- V26 ELITE INTELLIGENCE ADDITIONS ---
    graph = row.get('match_graph')
    if isinstance(graph, str):
        try: graph = json.loads(graph)
        except: graph = {}
    
    h_mom, a_mom, mom_trend = calculate_momentum_trend(graph)
    features['v26_momentum_h'] = h_mom
    features['v26_momentum_a'] = a_mom
    features['v26_momentum_trend'] = mom_trend
    features['v26_lineups_confirmed'] = 1.0 if row.get('lineups_confirmed') else 0.0

    # [BOOST] V90 EXPLOSIVE MOMENTUM: Detects if a team is accelerating their performance
    h_accel = h_roll_p3 - calculate_rolling_averages(h_hist[3:6] if len(h_hist) >= 6 else [])[1]
    a_accel = a_roll_p3 - calculate_rolling_averages(a_hist[3:6] if len(a_hist) >= 6 else [])[1]
    features['explosive_momentum_h'] = h_accel if h_accel > 0 else 0.0
    features['explosive_momentum_a'] = a_accel if a_accel > 0 else 0.0

    # --- V27 TACTICAL PRECISION (Phase 7) ---
    features['ref_yellow_avg'] = float(row.get('referee_yellow_avg') or 3.8)
    features['ref_red_avg'] = float(row.get('referee_red_avg') or 0.15)
    features['ref_pen_avg'] = float(row.get('referee_penalties_avg') or 0.25)
    
    # [V55] Environmental Impact Scaling
    w_impact = 1.0
    w_desc = str(row.get('weather_desc','')).lower()
    temp = float(row.get('weather_temp') or 20.0)
    
    if 'rain' in w_desc or 'pluie' in w_desc: w_impact += 0.1
    if temp > 32: w_impact += 0.15
    if 'snow' in w_desc or 'neige' in w_desc: w_impact += 0.2
    
    features['weather_impact'] = w_impact
    
    # 11. [V51] REAL H2H INTELLIGENCE (Sofascore Integration)
    h2h = row.get('h2h_data')
    if isinstance(h2h, str):
        try: h2h = json.loads(h2h)
        except: h2h = {}
    elif not isinstance(h2h, dict):
        h2h = {}
    
    duel = h2h.get('teamDuel', {})
    h2_h_w = float(duel.get('homeWins', 0))
    h2_a_w = float(duel.get('awayWins', 0))
    h2_d = float(duel.get('draws', 0))
    h2_total = h2_h_w + h2_a_w + h2_d
    
    features['h2h_home_win_rate'] = h2_h_w / h2_total if h2_total > 0 else 0.33
    features['h2h_away_win_rate'] = h2_a_w / h2_total if h2_total > 0 else 0.33
    features['h2h_draw_rate'] = h2_d / h2_total if h2_total > 0 else 0.34
    features['h2h_total_matches'] = h2_total

    # 12. [V52] LINE MOVEMENT INTELLIGENCE (24h Market Delta)
    move = row.get('odds_movement_24h')
    if isinstance(move, str):
        try: move = json.loads(move)
        except: move = {}
    elif not isinstance(move, dict):
        move = {}
    
    features['h_odds_move_24h'] = float(move.get('h_pct', 0))
    features['a_odds_move_24h'] = float(move.get('a_pct', 0))
    features['d_odds_move_24h'] = float(move.get('d_pct', 0))
    features['market_reliability'] = 1.0 if move.get('is_reliable') else 0.0

    # [V95] ODDS ACCELERATION: Detects rapid changes in the last hour
    move_1h = row.get('odds_movement_1h') or {}
    if isinstance(move_1h, str):
        try: move_1h = json.loads(move_1h)
        except: move_1h = {}
    
    h_accel = float(move_1h.get('h_pct', 0))
    a_accel = float(move_1h.get('a_pct', 0))
    # If 1h movement is faster than 24h movement (normalized), acceleration is high
    features['odds_acceleration_h'] = h_accel if abs(h_accel) > abs(features['h_odds_move_24h'] / 24) else 0.0
    features['odds_acceleration_a'] = a_accel if abs(a_accel) > abs(features['a_odds_move_24h'] / 24) else 0.0


    # Existing V25 indicators (syncing with V26/V27)
    mot_val, _ = get_match_motivation_context(row)
    volume = float(row.get('market_volume') or 50000.0)
    features['motivation_context'] = mot_val
    features['liquidity_index'] = min(1.0, volume / 100000.0)
    features['data_completeness'] = calculate_data_completeness(features)

    # --- V52 STABILITY GUARD: Final NaN/None Cleanup ---
    for k, v in list(features.items()):
        if v is None or (isinstance(v, float) and math.isnan(v)):
            features[k] = 0.0
        else:
            try:
                features[k] = float(v)
            except (ValueError, TypeError):
                features[k] = 0.0

    return features

# V23 Feature Names — Used by the existing trained model (stitch_v23_hybrid.json)
# DO NOT MODIFY: changing this list breaks XGBoost inference.
FEATURE_NAMES = [
    'home_elo', 'away_elo', 'elo_diff', 'home_motivation', 'away_motivation',
    'tactical_synergy', 'home_injury_impact', 'away_injury_impact',
    'h_pos', 'a_pos', 'pos_diff', 'h_pass_acc', 'a_pass_acc', 'pass_acc_diff',
    'h_xg', 'a_xg', 'xg_diff', 'h_bc', 'a_bc', 'bc_diff',
    'h_sot', 'a_sot', 'sot_diff', 'h_shots_off', 'a_shots_off', 'h_inner_shots', 'a_inner_shots',
    'h_int', 'a_int', 'int_diff', 'h_tackles', 'a_tackles', 'tackles_diff',
    'h_clear', 'a_clear', 'clear_diff', 'h_def_err', 'a_def_err', 'h_saves', 'a_saves',
    'h_ground_won', 'a_ground_won', 'h_aerial_won', 'a_aerial_won',
    'h_poss_lost', 'a_poss_lost', 'lost_diff', 'h_corners', 'a_corners', 'corner_diff',
    'h_fouls', 'a_fouls', 'foul_diff', 'h_cards', 'a_cards',
    'h_style_enc', 'a_style_enc', 'h_mom_gicko', 'a_mom_gicko',
    'h_att_imp', 'a_att_imp', 'news_sent', 'odds_h', 'odds_a', 'temp',
    'rest_h', 'rest_a', 'travel_f', 'is_cup'
]

# V24 Extended Feature Names — For future retraining with Top Analyst Market Intelligence.
# Use this list when training stitch_v24 or later models.
FEATURE_NAMES_V24 = FEATURE_NAMES + [
    # Top Analyst Engine Features (Sharp Money + Market Intelligence)
    'ta_true_prob_h', 'ta_true_prob_d', 'ta_true_prob_a',
    'ta_odds_change_speed_h', 'ta_odds_change_speed_a',
    'ta_sharp_money_h', 'ta_sharp_money_a', 'ta_sharp_money_d',
    'ta_sharp_money_indicator',
    'ta_xg_h', 'ta_xg_a',
    'ta_sot_h', 'ta_sot_a',
    'ta_news_impact', 'ta_news_sentiment',
    'ta_over_25_prob', 'ta_under_25_prob', 'ta_expected_total_goals',
    'ta_value_bet_flag', 'ta_highest_value_index',
    'ta_market_confidence_indicator', 'ta_team_strength_indicator',
    'ta_momentum_indicator', 'ta_goal_expectation_indicator',
    'ta_h_rating', 'ta_a_rating', 'ta_rating_diff'
]

# V25 Intelligence Feature Names — Adding Context & Reliability
FEATURE_NAMES_V25 = FEATURE_NAMES_V24 + [
    'motivation_context',
    'liquidity_index',
    'data_completeness'
]

# V26 Elite Intelligence Guard — Real-time Verification
FEATURE_NAMES_V26 = FEATURE_NAMES_V25 + [
    'v26_momentum_h',
    'v26_momentum_a',
    'v26_momentum_trend',
    'v26_lineups_confirmed'
]
# V27 Tactical Precision Feature Names (Phase 7)
FEATURE_NAMES_V27 = FEATURE_NAMES_V26 + [
    'ref_yellow_avg',
    'ref_red_avg',
    'ref_pen_avg',
    'weather_impact'
]

# V51 Real H2H Intelligence (Sofascore Integration)
FEATURE_NAMES_V51 = FEATURE_NAMES_V27 + [
    'h2h_home_win_rate',
    'h2h_away_win_rate',
    'h2h_draw_rate',
    'h2h_total_matches'
]

# V52 Line Movement Intelligence (Market Psychology)
FEATURE_NAMES_V52 = FEATURE_NAMES_V51 + [
    'h_odds_move_24h',
    'a_odds_move_24h',
    'd_odds_move_24h',
    'market_reliability'
]

# [TITANIUM] ELITE AI FEATURES - Full Environmental Intelligence
FEATURE_NAMES_TITANIUM = FEATURE_NAMES_V52 + [
    'h_pts', 'a_pts', 'pts_diff',
    'humidity',
    'ip_h', 'ip_d', 'ip_a',
    'is_extreme_weather',
    'news_is_missing_gk', 'news_is_missing_scorer', 'news_is_missing_captain', 'news_is_missing_star',
    'odds_velocity', 'is_derby'
]



# V46/V47 Features - Used by the Surgical Intelligence Module (not for raw XGBoost)
SURGICAL_FEATURES = [
    'news_is_missing_gk', 'news_is_missing_scorer', 'news_is_missing_captain', 'news_is_missing_star',
    'h_mkt_val', 'a_mkt_val', 'ref_bias', 'is_pressure'
]

# V20 Volatility Tiers (Quantum)
# Tags features by their expected variance to inform Monte Carlo injection.
FEATURE_VOLATILITY = {
    # Low Volatility (Fixed/Slow-moving)
    "home_elo": 0.01, "away_elo": 0.01, "h_mkt_val": 0.02, "a_mkt_val": 0.02,
    "h2h_home_win_rate": 0.04, "h2h_away_win_rate": 0.04, "h2h_draw_rate": 0.04,
    "market_reliability": 0.01,
    
    # Medium Volatility (Statistical averages / Performance)
    "h_pos": 0.07, "a_pos": 0.07, "h_xg": 0.12, "a_xg": 0.12, 
    "h_sot": 0.15, "a_sot": 0.15, "h_bc": 0.18, "a_bc": 0.18,
    "h_pass_acc": 0.06, "a_pass_acc": 0.06,
    "h_int": 0.12, "h_tackles": 0.12, "h_clear": 0.15,
    "xg_elo_delta_h": 0.08, "xg_elo_delta_a": 0.08,
    
    # High Volatility (Psychological/News/Momentum/Disrupted)
    "home_motivation": 0.22, "away_motivation": 0.22, 
    "news_sent": 0.35, "v26_momentum_trend": 0.45,
    "is_pressure": 0.35, "home_injury_impact": 0.40, "away_injury_impact": 0.40,
    "h_odds_move_24h": 0.20, "a_odds_move_24h": 0.20,
    "h_def_err": 0.50, "a_def_err": 0.50  # High volatility on mistakes
}


def calculate_travel_fatigue(home_team, away_team):
    """
    Ultra Factor V19: Estimates fatigue based on Haversine distance.
    Uses a lookup table for major football cities.
    """
    if not home_team or not away_team: return 0.0
    
    COORDS = {
        # Europe
        "London": (51.5074, -0.1278), "Manchester": (53.4808, -2.2426), "Liverpool": (53.4084, -2.9916),
        "Madrid": (40.4168, -3.7038), "Barcelona": (41.3851, 2.1734), "Munich": (48.1351, 11.5820),
        "Dortmund": (51.5136, 7.4653), "Paris": (48.8566, 2.3522), "Marseille": (43.2965, 5.3698),
        "Milan": (45.4642, 9.1900), "Turin": (45.0703, 7.6869), "Rome": (41.9028, 12.4964),
        "Amsterdam": (52.3676, 4.9041), "Lisbon": (38.7223, -9.1393), "Porto": (41.1579, -8.6291),
        "Istanbul": (41.0082, 28.9784), "Athens": (37.9838, 23.7275), "Brussels": (50.8503, 4.3517),
        "Vienna": (48.2082, 16.3738), "Warsaw": (52.2297, 21.0122), "Prague": (50.0755, 14.4378),
        "Budapest": (47.4979, 19.0402), "Naples": (40.8518, 14.2681), "Frankfurt": (50.1109, 8.6821),
        "Leipzig": (51.3397, 12.3731), "Leicester": (52.6369, -1.1398), "Glasgow": (55.8642, -4.2518),
        "Aberdeen": (57.1497, -2.0943), "Belfast": (54.5973, -5.9301), "Seville": (37.3891, -5.9845),
        "Valencia": (39.4699, -0.3763), "Lille": (50.6292, 3.0573), "Lyon": (45.7640, 4.8357),
        # England expansion (League One/National League cities)
        "Birmingham": (52.4862, -1.8904), "Bristol": (51.4545, -2.5879),
        "Blackpool": (53.8175, -3.0357), "Reading": (51.4543, -0.9781),
        "Huddersfield": (53.6458, -1.7850), "Bolton": (53.5815, -2.4282),
        "York": (53.9591, -1.0815), "Rochdale": (53.6150, -2.1550), 
        "Carlisle": (54.8925, -2.9329), "Barnet": (51.6444, -0.1997),
        "Eastleigh": (50.9667, -1.3500), "Woking": (51.3162, -0.5593),
        # Middle East & Africa (Expanding for USER)
        "Riyadh": (24.7136, 46.6753), "Jeddah": (21.5433, 39.1728), "Dubai": (25.2048, 55.2708),
        "Doha": (25.2854, 51.5310), "Abu Dhabi": (24.4539, 54.3773), "Cairo": (30.0444, 31.2357),
        "Casablanca": (33.5731, -7.5898), "Tunis": (36.8065, 10.1815), "Algiers": (36.7538, 3.0588),
        "Pretoria": (-25.7479, 28.2293), "Johannesburg": (-26.2041, 28.0473), "Cape Town": (-33.9249, 18.4241),
        "Dammam": (26.4207, 50.0888), "Medina": (24.5247, 39.5692), "Mecca": (21.3891, 39.8579),
        "Kuwait City": (29.3759, 47.9774), "Manama": (26.2285, 50.5860), "Muscat": (23.5859, 58.4059),
        "Amman": (31.9454, 35.9284), "Beirut": (33.8938, 35.5018), "Baghdad": (33.3152, 44.3661)
    }
    
    # Try to find city in team name
    h_coord, a_coord = None, None
    for city, coord in COORDS.items():
        if city.lower() in home_team.lower(): h_coord = coord
        if city.lower() in away_team.lower(): a_coord = coord
    
    if not h_coord or not a_coord: return 0.0
    
    # Haversine distance (approximate)
    lat1, lon1 = h_coord
    lat2, lon2 = a_coord
    phi1, phi2 = math.radians(lat1), math.radians(lat2)
    dphi = math.radians(lat2 - lat1)
    dlambda = math.radians(lon2 - lon1)
    a = math.sin(dphi / 2)**2 + math.cos(phi1) * math.cos(phi2) * math.sin(dlambda / 2)**2
    dist = 2 * 6371 * math.atan2(math.sqrt(a), math.sqrt(1 - a))
    
    # Fatigue scale: 0 to 5.0 (5.0 = 5000km+ travel)
    return min(5.0, dist / 1000.0)
