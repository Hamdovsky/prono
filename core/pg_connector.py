"""
pg_connector.py — Python Neon PostgreSQL connection module
Mirrors the Node.js pg_connector.js API for the Python inference pipeline.
Enables ml_features.py and data_loader.py to read from the 1M+ row archive
on Neon instead of the local SQLite file.
"""
import os
import json
import functools

_DB_POOL = None
_DB_CONN = None

DATABASE_URL = os.environ.get('DATABASE_URL', '')

def using_postgres():
    return bool(DATABASE_URL) and DATABASE_URL.startswith('postgres')

def get_pg_connection():
    global _DB_CONN, _DB_POOL
    if _DB_CONN is not None:
        return _DB_CONN
    if not using_postgres():
        return None
    try:
        import psycopg2
        conn = psycopg2.connect(DATABASE_URL, sslmode='require')
        conn.autocommit = True
        _DB_CONN = conn
        return conn
    except Exception as e:
        import sys
        sys.stderr.write(f"[PG] Connection error: {e}\n")
        return None

def close_pg():
    global _DB_CONN, _DB_POOL
    if _DB_CONN:
        try:
            _DB_CONN.close()
        except:
            pass
        _DB_CONN = None

def query(sql, params=None):
    conn = get_pg_connection()
    if not conn:
        return None
    try:
        with conn.cursor() as cur:
            cur.execute(sql, params or ())
            if cur.description:
                cols = [desc[0] for desc in cur.description]
                rows = cur.fetchall()
                return [dict(zip(cols, row)) for row in rows]
            return []
    except Exception as e:
        import sys
        sys.stderr.write(f"[PG] Query error: {e}\n")
        return None

@functools.lru_cache(maxsize=64)
def get_league_params(league_name=None):
    """Fetch calibrated league_model_parameters from Neon."""
    if not using_postgres():
        return {}
    if league_name:
        rows = query(
            "SELECT team_name, attack_rating, defense_rating, home_advantage, rho, mu, num_matches FROM league_model_parameters WHERE tournament_name ILIKE %s",
            (f'%{league_name}%',)
        )
    else:
        rows = query(
            "SELECT team_name, tournament_name, attack_rating, defense_rating, home_advantage, rho, mu, num_matches FROM league_model_parameters"
        )
    if not rows:
        return {}
    result = {}
    for r in rows:
        key = (r.get('team_name') or '').lower()
        result[key] = {
            'attack_rating': float(r.get('attack_rating', 1.0)),
            'defense_rating': float(r.get('defense_rating', 1.0)),
            'home_advantage': float(r.get('home_advantage', 0.08)),
            'rho': float(r.get('rho', 0.02)),
            'mu': float(r.get('mu', 0.0)),
            'num_matches': int(r.get('num_matches', 0))
        }
    return result
