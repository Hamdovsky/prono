"""Tests du mappage de noms d'équipes entre sources."""
from __future__ import annotations

import pytest

from team_mapping import TeamMapper


@pytest.fixture(scope="module")
def mapper() -> TeamMapper:
    return TeamMapper()


def test_alias_direct(mapper: TeamMapper) -> None:
    assert mapper.map("Man Utd") == "Manchester United"
    assert mapper.map("MUFC") == "Manchester United"
    assert mapper.map("PSG") == "Paris Saint-Germain"
    assert mapper.map("Atlético Madrid") == "Atletico Madrid"


def test_canonical_maps_to_itself(mapper: TeamMapper) -> None:
    for name in ("Arsenal", "Real Madrid", "Bayern Munich", "Liverpool"):
        assert mapper.map(name) == name


def test_fuzzy_match(mapper: TeamMapper) -> None:
    assert mapper.map("Atletico Madrid CF") == "Atletico Madrid"


def test_unmapped_returns_original(mapper: TeamMapper) -> None:
    assert mapper.map("AC Something Unknown") == "AC Something Unknown"


def test_map_with_flag(mapper: TeamMapper) -> None:
    canon, ok = mapper.map_with_flag("Man City")
    assert canon == "Manchester City"
    assert ok is True
    canon, ok = mapper.map_with_flag("Fc Inconnu Xyz")
    assert ok is False


def test_normalization_is_case_and_accent_insensitive(mapper: TeamMapper) -> None:
    assert mapper.map("man utd") == "Manchester United"
    assert mapper.map("Cologne") == "Koln"
    assert mapper.map("OL") == "Lyon"
