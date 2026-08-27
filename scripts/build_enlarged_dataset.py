"""Build an enlarged 1X2 dataset from data/historical_archive.sqlite.

Goal: "plus de données" for the hybrid stacking experiment. We rebuild a
master-like dataset using ALL leagues (64) and many seasons from the local
archive, with features consistent with core/backtest_walkforward.FEATURE_ALLOWLIST.

- Elo computed locally from results (no network).
- Real xG from archive (xg_home/xg_away); xA proxied as opponent xG.
- Season codes normalised to football-data 4-digit style (e.g. 2024-25 -> 2425).
- VAL_SEASON stays 2526 (Top-5 only in archive) so we validate on the same
  hold-out as the baseline, training on many more leagues.
"""
from __future__ import annotations
import sqlite3, re, sys
from pathlib import Path
import numpy as np
import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "data_pipeline"))
from build.features import compute_features  # noqa: E402

ARCH = ROOT / "data" / "historical_archive.sqlite"
OUT = ROOT / "data_pipeline" / "data" / "processed" / "master_dataset_enlarged.csv"


def map_season(s: str) -> int | None:
    s = str(s).strip()
    m = re.match(r"^(\d{4})-(\d{2})$", s)
    if m:
        return (int(m.group(1)) % 100) * 100 + int(m.group(2))
    m = re.match(r"^(\d{4})$", s)
    if m:
        # keep football-data 4-digit codes as-is (0001..9999)
        return int(s)
    return None


def local_elo(df: pd.DataFrame) -> pd.DataFrame:
    """Assign pre-match Elo per team within each league (chronological)."""
    df = df.sort_values(["league", "date"]).copy()
    ratings: dict = {}
    home_e, away_e = [], []
    K = 30.0
    for _, r in df.iterrows():
        lg = r["league"]
        h, a = r["home_team"], r["away_team"]
        key = (lg,)
        rt = ratings.setdefault(key, {})
        eh = rt.get(h, 1500.0)
        ea = rt.get(a, 1500.0)
        home_e.append(eh)
        away_e.append(ea)
        # outcome
        if r["fthg"] > r["ftag"]:
            sh, sa = 1.0, 0.0
        elif r["fthg"] < r["ftag"]:
            sh, sa = 0.0, 1.0
        else:
            sh, sa = 0.5, 0.5
        exp_h = 1.0 / (1.0 + 10 ** ((ea - eh) / 400.0))
        exp_a = 1.0 - exp_h
        rt[h] = eh + K * (sh - exp_h)
        rt[a] = ea + K * (sa - exp_a)
    df["elo_home"] = home_e
    df["elo_away"] = away_e
    return df


def main() -> None:
    c = sqlite3.connect(str(ARCH))
    q = """
        SELECT league_code, season_code, match_date, home_team, away_team,
               score_home, score_away,
               shots_home, shots_away, corners_home, corners_away,
               xg_home, xg_away,
               odds_home, odds_draw, odds_away,
               closing_odds_home, closing_odds_draw, closing_odds_away,
               odds_over, odds_under,
               asian_handicap_line, odds_asian_home, odds_asian_away
        FROM archive_football_data
        WHERE score_home IS NOT NULL AND score_away IS NOT NULL
    """
    df = pd.read_sql_query(q, c)
    c.close()
    print("raw rows:", len(df))

    df["season"] = df["season_code"].map(map_season)
    df = df[df["season"].notna()].copy()
    df["season"] = df["season"].astype(int)
    df["date"] = pd.to_datetime(df["match_date"], errors="coerce")
    df = df[df["date"].notna()].copy()
    # keep odds columns present (NaN where missing) so feature names are stable
    for col in ["odds_home", "odds_draw", "odds_away",
                "closing_odds_home", "closing_odds_draw", "closing_odds_away",
                "odds_over", "odds_under", "asian_handicap_line",
                "odds_asian_home", "odds_asian_away", "xg_home", "xg_away"]:
        if col not in df.columns:
            df[col] = np.nan

    df = df.rename(columns={
        "league_code": "league",
        "score_home": "fthg",
        "score_away": "ftag",
        "shots_home": "hs",
        "shots_away": "away_shots",
        "corners_home": "hc",
        "corners_away": "ac",
        "xg_home": "home_xg",
        "xg_away": "away_xg",
        "odds_home": "odds_h_avg",
        "odds_draw": "odds_d_avg",
        "odds_away": "odds_a_avg",
        "closing_odds_home": "odds_h_close_avg",
        "closing_odds_draw": "odds_d_close_avg",
        "closing_odds_away": "odds_a_close_avg",
        "odds_over": "odds_o25_avg",
        "odds_under": "odds_u25_avg",
    })
    # xA proxy = opponent xG
    df["home_xa"] = df["away_xg"]
    df["away_xa"] = df["home_xg"]
    # asian handicap features (optional, may be NaN)
    df = df.rename(columns={
        "odds_asian_home": "odds_ah_h_avg",
        "odds_asian_away": "odds_ah_h_close_avg",
    })
    df["ftr"] = np.where(df["fthg"] > df["ftag"], "H",
                  np.where(df["fthg"] < df["ftag"], "A", "D"))

    # keep only leagues with enough matches
    counts = df.groupby("league").size()
    keep = counts[counts >= 50].index
    df = df[df["league"].isin(keep)].copy()
    print("leagues kept:", len(keep), "rows:", len(df),
          "seasons:", sorted(df["season"].unique()))

    df = local_elo(df)
    out = compute_features(df)
    out.to_csv(OUT, index=False)
    print("WROTE", OUT, "rows", len(out), "cols", len(out.columns))
    print("val season 2526 rows:",
          int((out["season"] == 2526).sum()))


if __name__ == "__main__":
    main()
