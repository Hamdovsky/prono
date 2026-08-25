"""Tests du fallback A/B des baselines retenues (Phase 10 suite)."""
import os
import sys
from pathlib import Path

import pandas as pd

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from core import baseline_fallback as bf  # noqa: E402


def test_is_enabled_default_off():
    os.environ["BASELINE_FALLBACK"] = "off"
    assert bf.is_enabled() is False


def test_predict_for_match_reel_et_inconnu():
    os.environ["BASELINE_FALLBACK"] = "on"
    df = pd.read_csv(bf.MASTER_CSV)
    r = df.iloc[500]
    m = {
        "league": r["league"],
        "home_team": r["home_team"],
        "away_team": r["away_team"],
        "date": str(pd.to_datetime(r["date"]).date()),
    }
    out = bf.predict_for_match(m)
    assert out is not None
    assert set(out.keys()) >= {"1x2", "ou25", "btts"}
    for v in out.values():
        assert abs(sum(v) - 1) < 1e-6 and all(0 <= p <= 1 for p in v)
    # inconnu -> None (pas de feature store live)
    assert bf.predict_for_match(
        {"league": "ZZ", "home_team": "X", "away_team": "Y", "date": "2099-01-01"}
    ) is None
    os.environ["BASELINE_FALLBACK"] = "off"
