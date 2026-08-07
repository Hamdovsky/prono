"""Export du master vers le Postgres de production (backfill cotes/xG/forme).

Alimente la table `matches` de prod (voir core/pg_database.js) avec les vraies
données du pipeline :

  - odds_home / odds_draw / odds_away : cotes moyennes (football-data.co.uk) ;
  - home_xg   / away_xg                : xG par match (Understat via soccerdata) ;
  - home_form_pts / away_form_pts      : points moyens L5 de chaque équipe.

Rapprochement par (homeTeam, awayTeam, jour du startTimestamp) après
normalisation des noms (même normalisation que util.normalize_name). L'écriture
est conservatrice : COALESCE(target, valeur) — on ne remplace jamais une donnée
réelle déjà présente. Quand de vraies cotes sont écrites, insufficient_data est
forcé à 0 (hasRealOdds devient vrai dans le gate d'honnêteté de prod).

Désactivé (no-op) si DATABASE_URL n'est pas défini.
"""
from __future__ import annotations

import os
from datetime import datetime, timezone
from pathlib import Path

import pandas as pd

from config import MASTER_CSV
from util import get_logger, normalize_name

log = get_logger("pg_export")

DATABASE_URL = os.environ.get("DATABASE_URL", "")

# Fenêtre de rapprochement : ne backfille que les matchs récents (fixtures à
# venir + ~13 mois de résultats) pour borner le scan de la table `matches`.
LOOKBACK_DAYS = 400
LOOKAHEAD_DAYS = 90

ODDS_COLS = ["odds_h_avg", "odds_d_avg", "odds_a_avg"]
XG_COLS = ["home_xg", "away_xg"]
FORM_COLS = ["H_pts_L5", "A_pts_L5"]


def is_enabled() -> bool:
    return bool(DATABASE_URL) and DATABASE_URL.startswith("postgres")


def _connect():
    import psycopg2

    return psycopg2.connect(DATABASE_URL, sslmode="require")


def build_lookup(match_rows: list[dict]) -> dict[tuple[str, str, str], list[str]]:
    """Clé (home normalisé, away normalisé, 'YYYY-MM-DD') -> [ids de match prod].

    Les clés sont construites à partir des lignes prod ; fonction pure, testable.
    """
    lookup: dict[tuple[str, str, str], list[str]] = {}
    for row in match_rows:
        ts = row.get("startTimestamp")
        if not ts:
            continue
        day = datetime.fromtimestamp(float(ts), tz=timezone.utc).strftime("%Y-%m-%d")
        key = (normalize_name(row.get("homeTeam")), normalize_name(row.get("awayTeam")), day)
        lookup.setdefault(key, []).append(str(row["id"]))
    return lookup


def load_master(path: Path = MASTER_CSV) -> pd.DataFrame:
    df = pd.read_csv(path)
    df["date"] = pd.to_datetime(df["date"], errors="coerce")
    return df.dropna(subset=["date"])


def _num(series: pd.Series, idx: int):
    val = series.iloc[idx]
    if val is None or (isinstance(val, float) and pd.isna(val)):
        return None
    return float(val)


def _candidates(df: pd.DataFrame, lookup: dict, mapper) -> list[dict]:
    """Fait correspondre chaque match du master aux ids prod candidats."""
    matched: list[dict] = []
    for idx, row in df.iterrows():
        day = row["date"].strftime("%Y-%m-%d")
        key = (normalize_name(mapper.map(row["home_team"])), normalize_name(mapper.map(row["away_team"])), day)
        ids = lookup.get(key)
        if not ids:
            continue
        matched.append({
            "id": ids[0],
            "date": day,
            "home_team": row["home_team"],
            "away_team": row["away_team"],
            "odds": tuple(_num(df[c], idx) for c in ODDS_COLS),
            "xg": tuple(_num(df[c], idx) for c in XG_COLS),
            "form": tuple(_num(df[c], idx) for c in FORM_COLS),
        })
    return matched


def _update_sql() -> str:
    return """
        UPDATE matches
        SET odds_home       = COALESCE(matches.odds_home, %s),
            odds_draw       = COALESCE(matches.odds_draw, %s),
            odds_away       = COALESCE(matches.odds_away, %s),
            home_xg         = COALESCE(matches.home_xg, %s),
            away_xg         = COALESCE(matches.away_xg, %s),
            home_form_pts   = COALESCE(matches.home_form_pts, %s),
            away_form_pts   = COALESCE(matches.away_form_pts, %s),
            insufficient_data = CASE WHEN %s IS NOT NULL AND %s IS NOT NULL AND %s IS NOT NULL
                                     THEN 0 ELSE matches.insufficient_data END,
            last_updated    = NOW()
        WHERE id = %s
    """


def export(dry_run: bool = False) -> dict:
    """Backfill le Postgres de prod depuis le master. Retourne un rapport."""
    if not is_enabled():
        log.warning("DATABASE_URL absent — export Postgres désactivé (no-op).")
        return {"enabled": False}

    from team_mapping import TeamMapper

    df = load_master()
    now = datetime.now(timezone.utc)
    lo = now.timestamp() - LOOKBACK_DAYS * 86400
    hi = now.timestamp() + LOOKAHEAD_DAYS * 86400

    conn = _connect()
    try:
        with conn.cursor() as cur:
            cur.execute(
                'SELECT id, "homeTeam", "awayTeam", "startTimestamp" FROM matches '
                'WHERE "startTimestamp" IS NOT NULL AND "startTimestamp" BETWEEN %s AND %s',
                (lo, hi),
            )
            rows = [dict(r) for r in cur.fetchall()]
        lookup = build_lookup(rows)
        matches = _candidates(df, lookup, TeamMapper())

        report = {
            "enabled": True,
            "master_rows": int(len(df)),
            "prod_matches_scanned": int(len(rows)),
            "matched": int(len(matches)),
            "with_odds": sum(1 for m in matches if all(o is not None for o in m["odds"])),
            "with_xg": sum(1 for m in matches if any(x is not None for x in m["xg"])),
        }

        if dry_run:
            log.info("DRY-RUN : %s", report)
            return report

        updated = 0
        with conn.cursor() as cur:
            for m in matches:
                cur.execute(_update_sql(), (
                    *m["odds"], *m["xg"], *m["form"],
                    m["odds"][0], m["odds"][1], m["odds"][2],
                    m["id"],
                ))
                updated += cur.rowcount
        conn.commit()
        report["updated"] = int(updated)
        log.info("Export Postgres : %s", report)
        return report
    finally:
        conn.close()


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Backfill Postgres prod depuis le master")
    parser.add_argument("--dry-run", action="store_true", help="Rapport sans écrire")
    args = parser.parse_args()
    export(dry_run=args.dry_run)


if __name__ == "__main__":
    main()
