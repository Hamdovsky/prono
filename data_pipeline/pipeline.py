"""Orchestrateur du pipeline : tâches daily / fbref / build."""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone

import pandas as pd

import build.features as features_mod
import build.store as store
import sources.clubelo as clubelo_mod
import sources.fbref as fbref_mod
import sources.football_data as football_data_mod
from build.align import align
from config import ADVANCED_CSV, STATE_FILE
from team_mapping import TeamMapper
from util import RateLimiter, get_logger, setup_logging

log = get_logger("pipeline")


def _load_advanced() -> pd.DataFrame | None:
    if ADVANCED_CSV.exists():
        df = pd.read_csv(ADVANCED_CSV)
        df["date"] = pd.to_datetime(df["date"], errors="coerce")
        return df
    return None


def _update_state(patch: dict) -> None:
    state = {}
    if STATE_FILE.exists():
        state = json.loads(STATE_FILE.read_text(encoding="utf-8"))
    state.update(patch)
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    STATE_FILE.write_text(json.dumps(state, indent=2), encoding="utf-8")


def _get_elo(fd: pd.DataFrame) -> pd.DataFrame:
    """Elo pré-match par équipe (API ClubElo, sinon cache, sinon calcul local)."""
    return clubelo_mod.fetch_histories(limiter=RateLimiter(0.0), fallback_results=fd)


def _rebuild(fd, elo, adv) -> pd.DataFrame:
    mapper = TeamMapper()
    df = align(fd, elo, adv, mapper)
    df = features_mod.compute_features(df)
    store.save(df)
    return df


def run_daily(force: bool = False) -> pd.DataFrame:
    """Quotidien matin : Football-Data + ClubElo, puis rebuild du master."""
    log.info("=== Tâche quotidienne (Football-Data + ClubElo) ===")
    fd = football_data_mod.fetch(force=force)
    elo = _get_elo(fd)
    df = _rebuild(fd, elo, _load_advanced())
    _update_state({
        "daily_last_run": datetime.now(timezone.utc).isoformat(),
        "last_build": datetime.now(timezone.utc).isoformat(),
    })
    log.info("=== Tâche quotidienne terminée : %d matchs ===", len(df))
    return df


def run_fbref(force: bool = False) -> pd.DataFrame:
    """Tous les 3 jours : stats avancées (xG/xA), puis rebuild du master."""
    log.info("=== Tâche stats avancées (xG/xA) ===")
    adv = fbref_mod.fetch(limiter=RateLimiter(3.5), force=force)
    fd = football_data_mod.fetch()
    elo = _get_elo(fd)
    df = _rebuild(fd, elo, adv)
    _update_state({
        "fbref_last_run": datetime.now(timezone.utc).isoformat(),
        "last_build": datetime.now(timezone.utc).isoformat(),
    })
    log.info("=== Tâche stats avancées terminée : %d matchs ===", len(df))
    return df


def build_master(force: bool = False) -> pd.DataFrame:
    """Reconstruit le master à partir des données déjà en cache (aucun réseau)."""
    log.info("=== Rebuild du master (cache) ===")
    fd = football_data_mod.fetch(force=False)
    elo = _get_elo(fd)
    df = _rebuild(fd, elo, _load_advanced())
    _update_state({"last_build": datetime.now(timezone.utc).isoformat()})
    log.info("=== Rebuild terminé : %d matchs ===", len(df))
    return df


def main(argv=None) -> None:
    setup_logging()
    parser = argparse.ArgumentParser(description="Pipeline de données pronos")
    parser.add_argument("--task", choices=["daily", "fbref", "build"], default="daily")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args(argv)
    if args.task == "fbref":
        run_fbref(force=args.force)
    elif args.task == "build":
        build_master(force=args.force)
    else:
        run_daily(force=args.force)


if __name__ == "__main__":
    main()
