"""Lanceur planifié unique : quotidien + stats avancées si dues.

Exécute toujours la tâche quotidienne (Football-Data + ClubElo + rebuild) et
déclenche la tâche stats avancées (xG/xA) uniquement si le dernier run date de
3 jours ou plus (lu dans data/state.json). Avant tout rebuild, l'état courant
de data/ est sauvegardé (backup_data). Permet une seule entrée cron / une
seule tâche Windows au lieu de deux déclencheurs distincts.

Usage :
    python scripts/run_scheduled.py [--force] [--no-backup] [--bases] [--pg] [--pg-dry-run]
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from config import STATE_FILE  # noqa: E402
from pipeline import run_daily, run_fbref  # noqa: E402
from util import get_logger, setup_logging  # noqa: E402

log = get_logger("run_scheduled")

# Intervalle (jours) entre deux passes stats avancées (spec : tous les 3 jours).
FBREF_RUN_INTERVAL_DAYS = 3


def _state() -> dict:
    if not STATE_FILE.exists():
        return {}
    return json.loads(STATE_FILE.read_text(encoding="utf-8"))


def _fbref_due(state: dict) -> bool:
    last = state.get("fbref_last_run")
    if not last:
        return True
    try:
        last_dt = datetime.fromisoformat(last)
    except ValueError:
        return True
    age_days = (datetime.now(timezone.utc) - last_dt).total_seconds() / 86400
    return age_days >= FBREF_RUN_INTERVAL_DAYS


def run_scheduled(force: bool = False, run_pg: bool = False, pg_dry_run: bool = False,
                  no_backup: bool = False, run_bases: bool = False) -> None:
    state = _state()

    if not no_backup:
        from backup_data import backup
        backup()

    df = run_daily(force=force)

    if _fbref_due(state):
        log.info("Stats avancées dues (dernier run : %s) — exécution.",
                 state.get("fbref_last_run", "jamais"))
        run_fbref(force=force)
    else:
        log.info("Stats avancées pas encore dues (dernier run : %s).",
                 state.get("fbref_last_run"))

    if run_pg or pg_dry_run:
        from build.pg_export import export
        export(dry_run=pg_dry_run or not run_pg)
        log.info("Scheduled terminé : %d matchs au master", len(df))

    if run_bases:
        from predict_bases import main as bases_main
        try:
            bases_main()
        except SystemExit as e:
            log.info("Aucune base émise (exit %s)", e.code)


def main() -> None:
    setup_logging()
    parser = argparse.ArgumentParser(description="Pipeline planifié (quotidien + fbref si dû)")
    parser.add_argument("--force", action="store_true", help="Re-télécharge tout, ignore le cache")
    parser.add_argument("--no-backup", action="store_true", help="Ne pas sauvegarder data/ avant le rebuild")
    parser.add_argument("--bases", action="store_true", help="Génère les bases solides du jour après le rebuild")
    parser.add_argument("--pg", action="store_true", help="Backfill Postgres prod après le rebuild")
    parser.add_argument("--pg-dry-run", action="store_true", help="Rapport Postgres sans écrire")
    args = parser.parse_args()
    run_scheduled(force=args.force, run_pg=args.pg, pg_dry_run=args.pg_dry_run,
                  no_backup=args.no_backup, run_bases=args.bases)


if __name__ == "__main__":
    main()
