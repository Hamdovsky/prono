"""Sauvegarde horodatée de data/ (caches scraper + master) vers prono/backups/.

Copie data/raw, data/processed, data/soccerdata_cache, state.json et
team_aliases.json dans backups/data_pipeline/YYYYMMDD/, avec rétention des
`--keep` plus récentes (défaut 7). Idempotent : ne recopie pas si la sauvegarde
du jour existe déjà (--force pour refaire).

Usage :
    python scripts/backup_data.py [--keep 7] [--force]
"""
from __future__ import annotations

import argparse
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from config import DATA_DIR, PACKAGE_DIR  # noqa: E402
from util import get_logger  # noqa: E402

log = get_logger("backup")

BACKUP_ROOT = PACKAGE_DIR.parent / "backups" / "data_pipeline"
SOURCES = [DATA_DIR / "raw", DATA_DIR / "processed", DATA_DIR / "soccerdata_cache"]
FILES = [DATA_DIR / "state.json", DATA_DIR / "team_aliases.json"]


def _size(path: Path) -> str:
    total = sum(p.stat().st_size for p in path.rglob("*") if p.is_file())
    return f"{total / 1e6:.1f} MB"


def _prune(keep: int) -> None:
    if not BACKUP_ROOT.exists():
        return
    dirs = sorted([d for d in BACKUP_ROOT.iterdir() if d.is_dir()], reverse=True)
    for old in dirs[keep:]:
        shutil.rmtree(old)
        log.info("Supprimé sauvegarde expirée : %s", old)


def backup(keep: int = 7, force: bool = False) -> Path:
    """Copie l'état actuel de data/ dans une sauvegarde datée du jour."""
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d")
    target = BACKUP_ROOT / stamp
    if target.exists() and not force:
        log.info("Sauvegarde du jour déjà présente : %s (--force pour refaire)", target)
        return target

    target.mkdir(parents=True, exist_ok=True)
    for src in SOURCES:
        if not src.exists():
            continue
        dest = target / src.name
        if dest.exists():
            shutil.rmtree(dest)
        shutil.copytree(src, dest, ignore=shutil.ignore_patterns("__pycache__", "*.pyc"))
        log.info("Copié %s (%s)", src, _size(dest))
    for f in FILES:
        if f.exists():
            shutil.copy2(f, target / f.name)
    _prune(keep)
    log.info("Sauvegarde terminée : %s (rétention %d j)", target, keep)
    return target


def main() -> None:
    parser = argparse.ArgumentParser(description="Sauvegarde horodatée de data/")
    parser.add_argument("--keep", type=int, default=7, help="nombre de sauvegardes conservées")
    parser.add_argument("--force", action="store_true", help="refaire la sauvegarde du jour")
    args = parser.parse_args()
    target = backup(keep=args.keep, force=args.force)
    print(f"Backup : {target}")


if __name__ == "__main__":
    main()
