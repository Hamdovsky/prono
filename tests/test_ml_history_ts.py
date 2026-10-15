import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "core"))

import ml_history  # noqa: E402


def test_normalize_ts_none_and_zero():
    assert ml_history._normalize_ts(None) is None
    assert ml_history._normalize_ts(0) is None
    assert ml_history._normalize_ts(0.0) is None


def test_normalize_ts_seconds_unchanged():
    assert ml_history._normalize_ts(1700000000) == 1700000000
    assert ml_history._normalize_ts(1700000000.0) == 1700000000


def test_normalize_ts_milliseconds_converted():
    assert ml_history._normalize_ts(1700000000000) == 1700000000
    assert ml_history._normalize_ts(1700000000123) == 1700000000


def test_normalize_ts_string_and_invalid():
    assert ml_history._normalize_ts("1700000000000") == 1700000000
    assert ml_history._normalize_ts("not-a-ts") is None


def test_master_history_accepts_milliseconds():
    master = os.path.join(ROOT, "data_pipeline", "data", "processed", "master.db")
    if not os.path.exists(master):
        return
    ml_history.get_team_history.cache_clear()
    sec = ml_history._get_team_history_master("Arsenal", limit=3, current_match_ts=1700000000)
    ml_history.get_team_history.cache_clear()
    ms = ml_history._get_team_history_master("Arsenal", limit=3, current_match_ts=1700000000000)
    assert sec is not None
    assert ms is not None
    assert len(ms) == len(sec)
