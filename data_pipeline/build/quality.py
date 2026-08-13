"""Rapport de qualité et de provenance du master dataset (watchdog).

Répond à « est-ce que le pipeline marche et donne des données correctes ? »
en un coup d'œil : couverture de chaque source, distribution de la provenance
de l'Elo, fraîcheur des derniers runs (state.json) et plage de dates couverte.
"""
from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

import pandas as pd

from config import MASTER_CSV, STATE_FILE
from util import get_logger

log = get_logger("quality")

# colonnes du master -> source de données correspondante
COVERAGE = {
    "odds": ["odds_h_avg", "odds_d_avg", "odds_a_avg"],
    "xG": ["home_xg", "away_xg"],
    "Elo": ["elo_home", "elo_away"],
    "forme L5": ["H_pts_L5", "A_pts_L5"],
}


def _state(state_file: Path) -> dict:
    if not state_file.exists():
        return {}
    return json.loads(state_file.read_text(encoding="utf-8"))


def report(csv_path: Path = MASTER_CSV, state_file: Path = STATE_FILE) -> dict:
    """Calcule le rapport qualité. Ne modifie aucun fichier."""
    state = _state(state_file)
    report_dict = {"state": state, "checks": [], "summary": {}}

    if not csv_path.exists():
        report_dict["summary"] = {"error": f"master absent : {csv_path}"}
        log.error("Master absent : %s", csv_path)
        return report_dict

    df = pd.read_csv(csv_path)
    df["date"] = pd.to_datetime(df["date"], errors="coerce")

    checks = []
    for name, cols in COVERAGE.items():
        present = [c for c in cols if c in df.columns]
        cov = float(df[present].notna().mean().mean()) if present else 0.0
        checks.append({"source": name, "coverage_pct": round(100 * cov, 1)})
        log.info("Couverture %-9s : %6.1f%%", name, 100 * cov)

    if "elo_source" in df.columns:
        dist = {k: int(v) for k, v in df["elo_source"].value_counts().items()}
        checks.append({"source": "elo_provenance", "distribution": dist})
        log.info("Provenance Elo : %s", dist)
    else:
        log.warning("Colonne elo_source absente du master.")

    # Couverture par source (registre homogène : traçage dans state.json)
    sources = state.get("sources", {})
    for name, info in sources.items():
        checks.append({
            "source": f"src_{name}",
            "kind": info.get("kind"),
            "provenance": info.get("provenance"),
            "rows": info.get("rows"),
            "last_run": info.get("last_run"),
            "duration_s": info.get("duration_s"),
            "warnings": info.get("warnings", []),
        })
    if sources:
        log.info("Sources tracées : %s",
                 ", ".join(f"{n}={i.get('provenance')}" for n, i in sources.items()))

    summary = {
        "rows": int(len(df)),
        "first_match": str(df["date"].min().date()) if df["date"].notna().any() else None,
        "last_match": str(df["date"].max().date()) if df["date"].notna().any() else None,
        "last_build": state.get("last_build"),
        "elo_source": state.get("elo_source"),
        "sources": sources,
        "checks": checks,
    }
    report_dict["summary"] = summary
    log.info("Master : %d matchs (%s -> %s), dernier build %s, Elo source=%s",
             summary["rows"], summary["first_match"], summary["last_match"],
             summary["last_build"], summary["elo_source"])
    return report_dict
