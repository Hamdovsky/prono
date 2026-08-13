"""Orchestrateur du pipeline : tâches daily / fbref / build."""
from __future__ import annotations

import argparse
import json
from datetime import datetime, timezone

import pandas as pd

import build.features as features_mod
import build.store as store
from build.align import align
from config import ADVANCED_CSV, STATE_FILE
from sources import SOURCE_BY_NAME
from team_mapping import TeamMapper
from util import get_logger, setup_logging

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


def _get_elo(fd: pd.DataFrame) -> tuple[pd.DataFrame, str]:
    """Elo pré-match par équipe via la source ClubElo (registre homogène).

    Retourne `(historique, provenance)` avec provenance ∈ {"clubelo", "cache", "local"}.
    """
    src = SOURCE_BY_NAME["clubelo"]
    src.fallback_results = fd
    res = src.fetch()
    return res.df, res.provenance


def _rebuild(fd, elo, adv) -> pd.DataFrame:
    elo_hist, elo_source = elo
    mapper = TeamMapper()
    df = align(fd, elo_hist, adv, mapper, elo_source=elo_source)
    df = features_mod.compute_features(df)
    store.save(df)
    return df


def run_daily(force: bool = False) -> pd.DataFrame:
    """Quotidien matin : Football-Data + ClubElo, puis rebuild du master."""
    log.info("=== Tâche quotidienne (Football-Data + ClubElo) ===")
    fb = SOURCE_BY_NAME["football_data"]
    fd = fb.fetch(force=force).df
    fb.fetch_fixtures(force=force)
    elo = _get_elo(fd)
    df = _rebuild(fd, elo, _load_advanced())
    _update_state({
        "daily_last_run": datetime.now(timezone.utc).isoformat(),
        "last_build": datetime.now(timezone.utc).isoformat(),
        "elo_source": elo[1],
    })
    log.info("=== Tâche quotidienne terminée : %d matchs (Elo source=%s) ===", len(df), elo[1])
    return df


def run_fbref(force: bool = False) -> pd.DataFrame:
    """Tous les 3 jours : stats avancées (xG/xA), puis rebuild du master."""
    log.info("=== Tâche stats avancées (xG/xA) ===")
    adv = SOURCE_BY_NAME["fbref"].fetch(force=force).df
    fd = SOURCE_BY_NAME["football_data"].fetch().df
    elo = _get_elo(fd)
    df = _rebuild(fd, elo, adv)
    _update_state({
        "fbref_last_run": datetime.now(timezone.utc).isoformat(),
        "last_build": datetime.now(timezone.utc).isoformat(),
        "elo_source": elo[1],
    })
    log.info("=== Tâche stats avancées terminée : %d matchs (Elo source=%s) ===", len(df), elo[1])
    return df


def build_master(force: bool = False) -> pd.DataFrame:
    """Reconstruit le master à partir des données déjà en cache (aucun réseau)."""
    log.info("=== Rebuild du master (cache) ===")
    fd = SOURCE_BY_NAME["football_data"].fetch(force=False).df
    elo = _get_elo(fd)
    df = _rebuild(fd, elo, _load_advanced())
    _update_state({"last_build": datetime.now(timezone.utc).isoformat(), "elo_source": elo[1]})
    log.info("=== Rebuild terminé : %d matchs (Elo source=%s) ===", len(df), elo[1])
    return df


def _evaluate(rep: dict) -> list[str]:
    """Critères watchdog : échec si master absent, xG < 75 %, Elo < 60 % ou Elo local."""
    failures: list[str] = []
    if "error" in rep.get("summary", {}):
        return [rep["summary"]["error"]]
    for c in rep["summary"].get("checks", []):
        if c.get("source") == "xG" and c.get("coverage_pct", 0) < 75:
            failures.append(f"Couverture xG trop faible : {c['coverage_pct']}% (< 75 %)")
        if c.get("source") == "Elo" and c.get("coverage_pct", 0) < 60:
            failures.append(f"Couverture Elo trop faible : {c['coverage_pct']}% (< 60 %)")
    if rep["summary"].get("elo_source") == "local":
        failures.append("Elo en mode local (API ClubElo inaccessible) : ratings non officiels")
    return failures


def run_check() -> dict:
    """Rapport qualité + évaluation watchdog. Échec = code de sortie ≠ 0."""
    log.info("=== Vérification qualité du master ===")
    from build import quality
    rep = quality.report()
    rep["failures"] = _evaluate(rep)
    if rep["failures"]:
        for f in rep["failures"]:
            log.error("CHECKS FAILED: %s", f)
    else:
        log.info("CHECKS OK")
    return rep


def main(argv=None) -> None:
    setup_logging()
    parser = argparse.ArgumentParser(description="Pipeline de données pronos")
    parser.add_argument("--task", choices=["daily", "fbref", "build", "check", "run_check"], default="daily")
    parser.add_argument("--force", action="store_true")
    args = parser.parse_args(argv)
    if args.task == "fbref":
        run_fbref(force=args.force)
    elif args.task == "build":
        build_master(force=args.force)
    elif args.task == "check":
        run_check()
    elif args.task == "run_check":
        rep = run_check()
        if rep.get("failures"):
            raise SystemExit(1)
    else:
        run_daily(force=args.force)


if __name__ == "__main__":
    main()
