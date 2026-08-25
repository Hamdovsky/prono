"""
recalibrate_served.py — P4 (audit, différé)

Refit l'isotonic calibration sur les probabilités RÉELLEMENT SERVIES (sortie moteur
Python, trace M0) joints aux résultats réels, au lieu de backtest_results.json.

Pré-requis : la trace M0 (ENGINE_PROB_TRACE) doit avoir accumulé suffisamment de
matchs réglés. Tant que < MIN_SAMPLES, le script ne fait rien (neutre, sans danger).

Usage:
    python core/recalibrate_served.py
"""
import os
import sys
import json
import sqlite3

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, HERE)

MIN_SAMPLES = int(os.environ.get("SERVED_CALIB_MIN_SAMPLES", "300"))
TRACE_PATH = os.environ.get(
    "ENGINE_PROB_TRACE", os.path.join(ROOT, "data", "engine_prob_trace.jsonl")
)
MODEL_PATH = os.path.join(ROOT, "data", "served_isotonic.pkl")
PARAMS_PATH = os.path.join(ROOT, "data", "served_isotonic_params.json")

DB_CANDIDATES = [
    os.path.join(ROOT, "data", "football_data.db"),
    os.path.join(ROOT, "data", "predictions.db"),
    os.path.join(ROOT, "data", "archive.db"),
]


def _load_trace():
    if not os.path.exists(TRACE_PATH):
        return []
    rows = []
    with open(TRACE_PATH, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    rows.append(json.loads(line))
                except Exception:
                    pass
    return rows


def _open_db():
    for db in DB_CANDIDATES:
        if os.path.exists(db):
            try:
                conn = sqlite3.connect(db)
                conn.row_factory = sqlite3.Row
                return conn
            except Exception:
                pass
    return None


def _outcome_for(conn, rec):
    """Find the actual result for a trace record (best-effort join)."""
    home = rec.get("home")
    away = rec.get("away")
    league = rec.get("league")
    date = rec.get("date")
    sql = (
        "SELECT scoreHome, scoreAway FROM archive_football_data "
        "WHERE homeTeam=? AND awayTeam=? AND league=? AND match_date LIKE ? LIMIT 1"
    )
    try:
        cur = conn.execute(sql, (home, away, league, f"{date}%"))
        row = cur.fetchone()
        if row and row["scoreHome"] is not None:
            h, a = int(row["scoreHome"]), int(row["scoreAway"])
            return 0 if h > a else (1 if h == a else 2)
    except Exception:
        pass
    return None


def main():
    rows = _load_trace()
    conn = _open_db()
    if conn is None:
        print("[SERVED-CAL] No DB found — cannot join outcomes. Deferred.")
        return

    X, y = [], []
    for rec in rows:
        probs = rec.get("engine_exit")
        if not probs:
            continue
        outcome = _outcome_for(conn, rec)
        if outcome is None:
            continue
        ph = float(probs.get("home", 0))
        pd_ = float(probs.get("draw", 0))
        pa = float(probs.get("away", 0))
        s = ph + pd_ + pa
        if s <= 0:
            continue
        ph, pd_, pa = ph / s, pd_ / s, pa / s
        conf = max(ph, pd_, pa) * 100.0
        pred = 0 if ph > pa and ph > pd_ else (2 if pa > ph and pa > pd_ else 1)
        X.append(conf)
        y.append(1.0 if pred == outcome else 0.0)

    conn.close()
    n = len(y)
    print(f"[SERVED-CAL] usable served samples = {n} (min required = {MIN_SAMPLES})")
    if n < MIN_SAMPLES:
        print("[SERVED-CAL] Insufficient samples — recalibration deferred (no change).")
        return

    try:
        from sklearn.isotonic import IsotonicRegression
        import numpy as np
        import pickle
    except Exception as e:
        print(f"[SERVED-CAL] sklearn unavailable: {e}")
        return

    X = np.array(X, dtype=float).reshape(-1, 1)
    y = np.array(y, dtype=float)
    iso = IsotonicRegression(y_min=0.0, y_max=1.0, out_of_bounds="clip")
    iso.fit(X[:, 0], y)
    os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)
    with open(MODEL_PATH, "wb") as f:
        pickle.dump(iso, f)
    params = {
        "fitted_at": str(__import__("datetime").datetime.now(__import__("datetime").timezone.utc).isoformat()),
        "n_samples": n,
        "source": "engine_prob_trace (served)",
        "status": "fitted",
    }
    with open(PARAMS_PATH, "w", encoding="utf-8") as f:
        json.dump(params, f, indent=2)
    print(f"[SERVED-CAL] Fitted on {n} served samples -> {MODEL_PATH}")


if __name__ == "__main__":
    main()
