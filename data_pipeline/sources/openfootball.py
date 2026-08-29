"""openfootball.py — Résultats historiques depuis openfootball/football.json (CC0-1.0).

Source : https://github.com/openfootball/football.json
License : CC0-1.0 Public Domain — usage commercial OK.

Données : résultats matchs pour ~50 ligues mondiales (1990s-2026).
Structure JSON par league/season avec (date, home_team, away_team, score).
"""
from __future__ import annotations

import json as _json
import re
from pathlib import Path

import pandas as pd
import requests

from proxy_manager import fetch_with_proxy
from util import get_logger

log = get_logger("openfootball")

BASE_URL = "https://raw.githubusercontent.com/openfootball/football.json/master"
LOCAL_DIR = Path(__file__).resolve().parent.parent / "data" / "raw" / "openfootball"
LOCAL_DIR.mkdir(parents=True, exist_ok=True)


def _norm_team(name):
    if not name:
        return ""
    s = str(name).lower().strip()
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    return s


class OpenFootballSource:
    name = "openfootball"
    provenance = "github.com/openfootball (CC0-1.0 Public Domain)"

    def fetch(self, force=False):
        cache_path = LOCAL_DIR / "football.json"
        cache_path.parent.mkdir(parents=True, exist_ok=True)

        if not force and cache_path.exists():
            age_s = (pd.Timestamp.now() - pd.Timestamp(cache_path.stat().st_mtime)).total_seconds()
            if age_s < 86400:
                log.info(f"[openfootball] Cache hit ({cache_path.stat().st_size / 1024:.0f} KB)")
                with open(cache_path, encoding="utf-8") as f:
                    raw = _json.load(f)
        else:
            url = f"{BASE_URL}/football.json"
            log.info(f"[openfootball] Fetching {url}")
            try:
                resp = fetch_with_proxy(url, headers={"User-Agent": "Mozilla/5.0"}, timeout=60)
                resp.raise_for_status()
                raw = resp.json()
                with open(cache_path, "w", encoding="utf-8") as f:
                    _json.dump(raw, f, ensure_ascii=False)
            except Exception as e:
                log.error(f"[openfootball] Failed to fetch {url}: {e}")
                return pd.DataFrame(), self.provenance, [f"URL returned 404 — source archived: {e}"]

        rows = []
        for comp in raw.get("competitions", []):
            comp_name = comp.get("name", "")
            for season in comp.get("seasons", []):
                season_label = season.get("name", "")
                for m in season.get("matches", []):
                    date = m.get("date", "")
                    home = m.get("home_team", "")
                    away = m.get("away_team", "")
                    ft = str(m.get("ft_score") or "")

                    def parse_score(s):
                        if not s or s in ("", "NULL", "None"):
                            return None, None
                        for sep in ["-", "–", " — "]:
                            if sep in s:
                                parts = s.split(sep)
                                try:
                                    return int(parts[0].strip()), int(parts[-1].strip())
                                except (ValueError, IndexError):
                                    pass
                        return None, None

                    h, a = parse_score(ft)
                    rows.append({
                        "league": comp_name,
                        "season": season_label,
                        "date": date,
                        "home_team": home,
                        "away_team": away,
                        "home_score": h,
                        "away_score": a,
                        "source": "openfootball",
                    })

        if not rows:
            return pd.DataFrame(), self.provenance, []

        df = pd.DataFrame(rows)
        df = df[df["date"].notna() & df["home_team"].notna() & df["away_team"].notna()]
        df["date"] = pd.to_datetime(df["date"], errors="coerce")
        df = df.dropna(subset=["date", "home_score", "away_score"])
        df["result"] = df.apply(
            lambda r: "H" if r["home_score"] > r["away_score"]
            else ("A" if r["home_score"] < r["away_score"] else "D"), axis=1
        )
        df["home_norm"] = df["home_team"].apply(_norm_team)
        df["away_norm"] = df["away_team"].apply(_norm_team)
        log.info(f"[openfootball] {len(df)} matches parsed")
        return df.reset_index(drop=True), self.provenance, []
