import sqlite3
import json
import os

DB_PATH = 'data/tactical.db'

def extract_bias_matrix():
    """
    Extracts the performance bias of the AI from prediction_history.
    Returns a dictionary mapping (league, prediction_type) -> success_rate_offset.
    """
    if not os.path.exists(DB_PATH):
        return {}

    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()

    # Query finished predictions with results
    query = """
        SELECT league, prediction_type, probability, result
        FROM prediction_history
        WHERE result IS NOT NULL AND status = 'finished'
    """
    cursor.execute(query)
    rows = cursor.fetchall()
    
    stats = {} # (league, type) -> {sum_prob: 0, sum_actual: 0, count: 0}
    
    for r in rows:
        key = (r['league'], r['prediction_type'])
        if key not in stats:
            stats[key] = {'sum_prob': 0, 'sum_actual': 0, 'count': 0}
        
        prob = float(r['probability'] or 0)
        actual = 1.0 if r['result'] == 'won' else 0.0
        
        stats[key]['sum_prob'] += prob
        stats[key]['sum_actual'] += actual
        stats[key]['count'] += 1
        
    bias_matrix = {}
    for key, data in stats.items():
        if data['count'] < 5: continue # Need at least 5 matches to establish a bias
        
        avg_prob = data['sum_prob'] / data['count']
        avg_actual = data['sum_actual'] / data['count']
        
        # Corrective factor: if actual is 0.7 and prob was 0.8, factor is 0.875
        factor = avg_actual / avg_prob if avg_prob > 0 else 1.0
        bias_matrix[f"{key[0]}|{key[1]}"] = round(factor, 3)
        
    conn.close()
    return bias_matrix

def refine_prediction(league, pred_type, initial_prob):
    """
    Applies the Neural Meta-Refiner correction to an initial probability.
    """
    matrix = extract_bias_matrix()
    key = f"{league}|{pred_type}"
    
    factor = matrix.get(key, 1.0)
    
    # Global bias fallback (if league specific is missing)
    if factor == 1.0:
        global_keys = [k for k in matrix.keys() if k.endswith(f"|{pred_type}")]
        if global_keys:
            factor = sum(matrix[k] for k in global_keys) / len(global_keys)
            
    refined_prob = initial_prob * factor
    return min(0.99, max(0.01, refined_prob)), factor

if __name__ == "__main__":
    # Test
    matrix = extract_bias_matrix()
    print("BIAS MATRIX EXTRACTED:")
    print(json.dumps(matrix, indent=2))
