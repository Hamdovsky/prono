"""martj42_results.py — martj42/international_results (CC0-1.0 Public Domain).

Source : https://github.com/martj42/international_results
License : CC0-1.0 Public Domain — usage commercial OK.
Données : 49 000+ matchs internationaux (1872-present).
"""
from __future__ import annotations

import re
from pathlib import Path

import pandas as pd
import requests

from .base import BaseSource, KIND_BASE
from proxy_manager import fetch_with_proxy
from util import get_logger, retry

log = get_logger("martj42_results")

BASE_URL = "https://raw.githubusercontent.com/martj42/international_results/master"
LOCAL_DIR = Path(__file__).resolve().parent.parent / "data" / "raw" / "martj42_results"
LOCAL_DIR.mkdir(parents=True, exist_ok=True)


def _normalize_team(name):
    if not name:
        return ""
    s = str(name).lower().strip()
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    s = re.sub(r" {2,}", " ", s).strip()
    return s


class Martj42ResultsSource(BaseSource):
    name = "martj42_international_results"
    kind = KIND_BASE
    rate_limit_s = 0.0
    provenance = "github.com/martj42/international_results (CC0-1.0)"

    @retry(n=3, delay=5, exceptions=(requests.RequestException,))
    def _fetch(self, leagues=None, seasons=None, force: bool = False):
        cache_path = LOCAL_DIR / "results.csv"
        if not force and cache_path.exists():
            age_h = (pd.Timestamp.now() - pd.Timestamp(cache_path.stat().st_mtime)).total_seconds() / 3600
            if age_h < 24:
                log.info(f"[martj42] Using cache ({cache_path.stat().st_size / 1024:.0f} KB)")
                df = pd.read_csv(cache_path, encoding="utf-8-sig")
                return df, self.provenance, []

        url = f"{BASE_URL}/results.csv"
        log.info(f"[martj42] Fetching {url}")
        resp = fetch_with_proxy(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=60)
        resp.raise_for_status()
        from io import BytesIO
        df = pd.read_csv(BytesIO(resp.content), encoding="utf-8-sig")
        cache_path.parent.mkdir(parents=True, exist_ok=True)
        cache_path.write_bytes(resp.content)
        log.info(f"[martj42] Cached {len(df)} matches")
        return df, self.provenance, []

    def fetch_dataframe(self, leagues=None, seasons=None, force: bool = False) -> pd.DataFrame:
        result = self.fetch(leagues=leagues, seasons=seasons, force=force)
        if result.df is None or result.df.empty:
            return pd.DataFrame()
        df = result.df.copy()
        if "score" in df.columns:
            def parse_score(s):
                if pd.isna(s) or str(s).strip() in ("", "NULL"):
                    return None, None
                s = str(s)
                for sep in [" - ", "-", "–", "—"]:
                    if sep in s:
                        parts = s.split(sep)
                        try:
                            return int(parts[0].strip()), int(parts[-1].strip())
                        except (ValueError, IndexError):
                            pass
                return None, None
            home_scores, away_scores = zip(*df["score"].apply(parse_score))
            df["home_score_int"] = home_scores
            df["away_score_int"] = away_scores
            df = df.dropna(subset=["home_score_int", "away_score_int"])
            df["result"] = df.apply(
                lambda r: "H" if r["home_score_int"] > r["away_score_int"]
                else ("A" if r["home_score_int"] < r["away_score_int"] else "D"), axis=1
            )
        if "date" in df.columns:
            df["date"] = pd.to_datetime(df["date"], format="%Y-%m-%d", errors="coerce")
            df = df.dropna(subset=["date"])
        if "home_team" in df.columns and "away_team" in df.columns:
            df["home_norm"] = df["home_team"].apply(_normalize_team)
            df["away_norm"] = df["away_team"].apply(_normalize_team)
        return df

    def to_local_features_df(self, force: bool = False) -> pd.DataFrame:
        """Retourne un DataFrame compatible avec local_features.py
        (colonnes: home_team, away_team, date, home_score, away_score)."""
        df = self.fetch_dataframe(force=force)
        if df.empty:
            return pd.DataFrame()
        df = df.rename(columns={
            "home_score_int": "home_score",
            "away_score_int": "away_score",
        })
        for col in ["home_team", "away_team", "date", "home_score", "away_score"]:
            if col not in df.columns:
                return pd.DataFrame()
        df["date"] = pd.to_datetime(df["date"])
        df["home_score"] = df["home_score"].astype(int)
        df["away_score"] = df["away_score"].astype(int)
        return df[["home_team", "away_team", "date", "home_score", "away_score"]].copy()

    def load_cached_local_df(self) -> pd.DataFrame:
        """Charge le CSV cache pour usage local_features sans re-fetch."""
        cache_path = LOCAL_DIR / "results.csv"
        if not cache_path.exists():
            return pd.DataFrame()
        df = pd.read_csv(cache_path, encoding="utf-8-sig")
        if df.empty or "home_team" not in df.columns:
            return pd.DataFrame()
        if "home_score_int" not in df.columns:
            return pd.DataFrame()
        df = df.rename(columns={
            "home_score_int": "home_score",
            "away_score_int": "away_score",
        })
        df["date"] = pd.to_datetime(df["date"], errors="coerce")
        df = df.dropna(subset=["date", "home_team", "away_team"])
        df["home_score"] = pd.to_numeric(df["home_score"], errors="coerce")
        df["away_score"] = pd.to_numeric(df["away_score"], errors="coerce")
        df = df.dropna(subset=["home_score", "away_score"])
        df["home_score"] = df["home_score"].astype(int)
        df["away_score"] = df["away_score"].astype(int)
        return df[["home_team", "away_team", "date", "home_score", "away_score"]].copy()
