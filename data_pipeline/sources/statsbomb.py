"""statsbomb.py — StatsBomb Open Data via statsbombpy (StatsBomb License, research/non-commercial).

Source : https://github.com/hudl/open-data
License : StatsBomb License (research + non-commercial).
Usage : non-commercial OK. Ne pas construire de service commercial sur ces données.
"""
from __future__ import annotations

import datetime

import pandas as pd
from statsbombpy import sb

from .base import BaseSource, KIND_ADVANCED
from config import RAW_DIR
from util import get_logger

log = get_logger("statsbomb")

LOCAL_DIR = RAW_DIR / "statsbomb"
LOCAL_DIR.mkdir(parents=True, exist_ok=True)


def _current_season_label():
    y = datetime.datetime.now().year
    return f"{y-1}/{y}"


def _filter_comps(comps_df: pd.DataFrame, leagues) -> pd.DataFrame:
    if not leagues:
        return comps_df
    if isinstance(leagues, str):
        leagues = [leagues]
    fl = [l.lower().strip() for l in leagues]
    mask = pd.Series(False, index=comps_df.index)
    for idx, row in comps_df.iterrows():
        cn = str(row.get("competition_name", "")).lower()
        cr = str(row.get("country_name", "")).lower()
        sn = str(row.get("season_name", "")).lower()
        for f in fl:
            if f in cn or f in cr or f in sn:
                mask[idx] = True
                break
    return comps_df[mask]


class StatsBombSource(BaseSource):
    name = "statsbomb_open_data"
    kind = KIND_ADVANCED
    rate_limit_s = 0.0
    provenance = "github.com/hudl/open-data (StatsBomb License, research/non-commercial)"

    def _fetch(self, leagues=None, seasons=None, force: bool = False):
        comps = sb.competitions()
        if comps.empty:
            return pd.DataFrame(), self.provenance, ["No competitions returned"]

        comps = _filter_comps(comps, leagues)
        rows = []
        for _, comp in comps.iterrows():
            cid = comp["competition_id"]
            sid = comp["season_id"]
            comp_name = comp.get("competition_name", "")
            season_label = comp.get("season_name", "")
            country = comp.get("country_name", "")
            if comp.get("competition_gender", "") != "male":
                continue
            try:
                matches_df = sb.matches(competition_id=cid, season_id=sid)
            except Exception as e:
                log.warn(f"[statsbomb] Matches failed for {comp_name}: {e}")
                continue
            if matches_df is None or matches_df.empty:
                continue
            for _, match in matches_df.iterrows():
                mid = match.get("match_id")
                if mid is None:
                    mid = match.name
                match_date = match.get("match_date", "")
                home_team = match.get("home_team", "")
                away_team = match.get("away_team", "")
                if not home_team or not away_team:
                    continue
                rows.append({
                    "competition": comp_name,
                    "season": season_label,
                    "country": country,
                    "match_id": mid,
                    "date": match_date,
                    "home_team": home_team,
                    "away_team": away_team,
                    "home_score": match.get("home_score", 0) or 0,
                    "away_score": match.get("away_score", 0) or 0,
                    "home_xg": 0.0,
                    "away_xg": 0.0,
                })

        if not rows:
            return pd.DataFrame(), self.provenance, ["No matches extracted"]

        df = pd.DataFrame(rows)
        df["date"] = pd.to_datetime(df["date"], errors="coerce")
        df = df.dropna(subset=["date"])
        log.info(f"[statsbomb] {len(df)} matches (xG via poisson_model if needed)")
        return df, self.provenance, []
