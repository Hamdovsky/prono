import os
import psycopg2
import json

def get_db_connection():
    return psycopg2.connect(
        dbname=os.getenv('DB_NAME', 'titanium_quant'),
        user=os.getenv('DB_USER', 'postgres'),
        password=os.getenv('DB_PASSWORD', 'postgres_password'),
        host=os.getenv('DB_HOST', 'localhost'),
        port=os.getenv('DB_PORT', '5432')
    )

def get_features(team_id: str, as_of_timestamp: str):
    """
    CRITICAL: Retrieves features strictly BEFORE the as_of_timestamp.
    Prevents any look-ahead bias or future data leakage.
    """
    conn = get_db_connection()
    cursor = conn.cursor()
    
    # Query team_stats_snapshots STRICTLY before the timestamp
    query = """
        SELECT rolling_xg, rolling_possession, rolling_shots_on_target, raw_stats
        FROM team_stats_snapshots
        WHERE team_id = %s
        AND recorded_at < %s
        ORDER BY recorded_at DESC
        LIMIT 1
    """
    
    cursor.execute(query, (team_id, as_of_timestamp))
    result = cursor.fetchone()
    conn.close()
    
    if result:
        return {
            "rolling_xg": float(result[0]) if result[0] else 1.0,
            "rolling_possession": float(result[1]) if result[1] else 50.0,
            "rolling_shots_on_target": float(result[2]) if result[2] else 4.0,
            "raw_stats": result[3] if result[3] else {}
        }
    else:
        return {
            "rolling_xg": 1.0,
            "rolling_possession": 50.0,
            "rolling_shots_on_target": 4.0,
            "raw_stats": {}
        }

def reconstruct_match_state(match_id: str, as_of_timestamp: str):
    """
    Reconstructs the full match context at an exact point in time.
    """
    conn = get_db_connection()
    cursor = conn.cursor()
    
    cursor.execute("""
        SELECT home_team, away_team FROM matches_history 
        WHERE match_id = %s AND valid_from < %s
        ORDER BY valid_from DESC LIMIT 1
    """, (match_id, as_of_timestamp))
    
    match = cursor.fetchone()
    if not match:
        conn.close()
        return None
        
    home_team, away_team = match
    
    home_feats = get_features(home_team, as_of_timestamp)
    away_feats = get_features(away_team, as_of_timestamp)
    
    # Get latest odds tick before timestamp
    cursor.execute("""
        SELECT home_odds, draw_odds, away_odds 
        FROM odds_ticks 
        WHERE match_id = %s AND recorded_at < %s
        ORDER BY recorded_at DESC LIMIT 1
    """, (match_id, as_of_timestamp))
    odds = cursor.fetchone()
    
    conn.close()
    
    return {
        "home_team": home_team,
        "away_team": away_team,
        "timestamp": as_of_timestamp,
        "features": {"home": home_feats, "away": away_feats},
        "odds": {"home": odds[0], "draw": odds[1], "away": odds[2]} if odds else None
    }
