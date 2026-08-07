"""Lanceur quotidien : Football-Data + ClubElo, puis rebuild du master.

Usage :
    python run_daily.py [--force] [--pg] [--pg-dry-run]
"""
from __future__ import annotations

import argparse

from pipeline import run_daily
from util import setup_logging

if __name__ == "__main__":
    setup_logging()
    parser = argparse.ArgumentParser(description="Pipeline quotidien (Football-Data + ClubElo)")
    parser.add_argument("--force", action="store_true", help="Re-télécharge tout, ignore le cache")
    parser.add_argument("--pg", action="store_true",
                        help="Backfill le Postgres de prod après le rebuild (cotes/xG/forme)")
    parser.add_argument("--pg-dry-run", action="store_true",
                        help="Rapport de correspondance Postgres sans écrire")
    args = parser.parse_args()
    run_daily(force=args.force)
    if args.pg or args.pg_dry_run:
        from build.pg_export import export
        export(dry_run=args.pg_dry_run or not args.pg)
