"""Lanceur quotidien : Football-Data + ClubElo, puis rebuild du master.

Usage :
    python run_daily.py [--force]
"""
from __future__ import annotations

import argparse

from pipeline import run_daily
from util import setup_logging

if __name__ == "__main__":
    setup_logging()
    parser = argparse.ArgumentParser(description="Pipeline quotidien (Football-Data + ClubElo)")
    parser.add_argument("--force", action="store_true", help="Re-télécharge tout, ignore le cache")
    args = parser.parse_args()
    run_daily(force=args.force)
