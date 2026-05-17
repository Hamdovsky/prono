import os
import psycopg2

def get_db_connection():
    return psycopg2.connect(
        dbname=os.getenv('DB_NAME', 'titanium_quant'),
        user=os.getenv('DB_USER', 'postgres'),
        password=os.getenv('DB_PASSWORD', 'postgres_password'),
        host=os.getenv('DB_HOST', 'localhost'),
        port=os.getenv('DB_PORT', '5432')
    )

def log_execution_clv(match_id, selection, execution_odds, closing_odds):
    """
    Calculates and logs the Closing Line Value (CLV).
    CLV = (ExecutionOdds / ClosingOdds) - 1
    """
    if not closing_odds or closing_odds <= 0:
        return None
        
    clv = (execution_odds / closing_odds) - 1
    
    conn = get_db_connection()
    cursor = conn.cursor()
    
    query = """
        INSERT INTO event_log (event_type, aggregate_id, payload, created_at)
        VALUES (%s, %s, %s, NOW())
    """
    
    payload = {
        "selection": selection,
        "execution_odds": execution_odds,
        "closing_odds": closing_odds,
        "clv": clv
    }
    
    import json
    cursor.execute(query, ('CLV_TRACK', match_id, json.dumps(payload)))
    conn.commit()
    conn.close()
    
    return clv

if __name__ == "__main__":
    print("📈 CLV Tracker Engine Initialized.")
