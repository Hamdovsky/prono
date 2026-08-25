"""M3 (audit F1) : re-entrainement V55 sans features derivees des closing odds.

But : corriger le skewness train/serve sur `odds_movement_24h` (present a
l'entrainement via closing odds, absent a l'inference live).

Ces tests sont NON destructifs :
- verifient l'enabler (feature_names_excluding / FEATURE_NAMES_V55_NOCLOSE)
- executent un dry-run load_data(limit) prouvant que le pipeline construit bien
  des vecteurs sans les features closing-derivees (aucun modele sauvegarde).
"""
import pytest


def test_feature_names_excluding_drops_targets():
    from core.ml_features import (
        FEATURE_NAMES_V55, CLOSING_DERIVED_FEATURES, feature_names_excluding,
    )
    out = feature_names_excluding(FEATURE_NAMES_V55, CLOSING_DERIVED_FEATURES)
    for f in CLOSING_DERIVED_FEATURES:
        assert f not in out, "%s ne doit pas rester" % f
    # ordre et autres features conservees
    assert len(out) == len(FEATURE_NAMES_V55) - len(CLOSING_DERIVED_FEATURES)
    assert all(f in FEATURE_NAMES_V55 for f in out)


def test_feature_names_v55_noclose_excludes_closing():
    from core.ml_features import FEATURE_NAMES_V55_NOCLOSE, CLOSING_DERIVED_FEATURES
    for f in CLOSING_DERIVED_FEATURES:
        assert f not in FEATURE_NAMES_V55_NOCLOSE
    # dimension correcte vs V55
    from core.ml_features import FEATURE_NAMES_V55
    assert len(FEATURE_NAMES_V55_NOCLOSE) == len(FEATURE_NAMES_V55) - len(CLOSING_DERIVED_FEATURES)


def test_load_data_noclose_builds_vectors():
    """Dry-run non destructif : le pipeline produit des vecteurs sans closing."""
    from core.train_v55 import load_data
    from core.ml_features import FEATURE_NAMES_V55_NOCLOSE

    X, y, sw, dates = load_data(
        limit=150, feature_names=FEATURE_NAMES_V55_NOCLOSE
    )
    assert len(X) > 0, "load_data doit produire des vecteurs"
    assert list(X.columns) == FEATURE_NAMES_V55_NOCLOSE, "colonnes = feature set cible"
    assert len(X.columns) == len(FEATURE_NAMES_V55_NOCLOSE)


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
