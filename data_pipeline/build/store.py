"""Persistance du master dataset en CSV + SQLite.

La table `master_matches` est recréée à chaque exécution à partir des colonnes
du DataFrame (voir schema.sql pour la structure de référence documentée).
"""
from __future__ import annotations

import sqlite3

import pandas as pd

from config import MASTER_CSV, MASTER_DB
from util import get_logger

log = get_logger("store")


def _sql_type(series: pd.Series) -> str:
    if pd.api.types.is_bool_dtype(series):
        return "INTEGER"
    if pd.api.types.is_float_dtype(series):
        return "REAL"
    if pd.api.types.is_integer_dtype(series):
        return "INTEGER"
    return "TEXT"


def _create_sql(df: pd.DataFrame, table: str) -> str:
    cols = ", ".join(f'"{c}" {_sql_type(df[c])}' for c in df.columns)
    return f"CREATE TABLE {table} ({cols})"


def save(df: pd.DataFrame, csv_path=MASTER_CSV, db_path=MASTER_DB) -> None:
    """Écrit le master dataset en CSV et dans la base SQLite (remplacement)."""
    csv_path.parent.mkdir(parents=True, exist_ok=True)
    db_path.parent.mkdir(parents=True, exist_ok=True)

    df.to_csv(csv_path, index=False)

    con = sqlite3.connect(db_path)
    try:
        con.execute("DROP TABLE IF EXISTS master_matches")
        con.execute(_create_sql(df, "master_matches"))
        df.to_sql("master_matches", con, if_exists="append", index=False)
        con.execute("CREATE INDEX IF NOT EXISTS idx_master_date ON master_matches (date)")
        con.execute("CREATE INDEX IF NOT EXISTS idx_master_teams ON master_matches (home_team, away_team)")
        con.commit()
    finally:
        con.close()

    log.info("Master enregistré : %d lignes -> %s / %s", len(df), csv_path, db_path)
