"""Lanceur stats avancées (xG/xA) : à exécuter tous les 3 jours.

Usage :
    python run_fbref.py [--force]
"""
from __future__ import annotations

import argparse

from pipeline import run_fbref
from util import setup_logging

if __name__ == "__main__":
    setup_logging()
    parser = argparse.ArgumentParser(description="Pipeline stats avancées (xG/xA, tous les 3 jours)")
    parser.add_argument("--force", action="store_true", help="Re-télécharge tout, ignore le cache")
    args = parser.parse_args()
    run_fbref(force=args.force)
