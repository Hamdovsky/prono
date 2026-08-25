"""Smoke-test runtime du modele V55 de PRODUCTION (adoption M3/F1).

Valide que le modele servicable (get_v55_booster -> model_manager), via le VRAI
pipeline de features (extract_ml_features + FEATURE_NAMES_V55, comme ml_ensemble.py),
produit une distribution de probabilite valide (sum=1, [0,1], non-NaN) — y compris en
condition de service (features closing mises a 0, comme a l'inference live).

Regression guard : si un futur re-entrainement reintroduit un skew train/serve sur
les closing odds, ce test echouera (probas differentes ou invalides).
"""
import os
import sys
import numpy as np
import xgboost as xgb

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(ROOT, "core"))

from ml_features import FEATURE_NAMES_V55, CLOSING_DERIVED_FEATURES  # noqa: E402
from train_v55 import load_data  # noqa: E402
from model_manager import get_v55_booster  # noqa: E402


def _softmax3(arr):
    a = np.asarray(arr, dtype=float)
    e = np.exp(a - a.max())
    return e / e.sum()


def _check(X_df, label):
    bst = get_v55_booster()
    assert bst is not None, "booster V55 non charge"
    probs = np.array([_softmax3(r) for r in bst.predict(xgb.DMatrix(X_df.values))])
    assert probs.shape[1] == 3
    assert np.all(np.isfinite(probs)), "%s: NaN" % label
    assert np.all((probs >= -1e-9) & (probs <= 1 + 1e-9)), "%s: hors [0,1]" % label
    assert np.allclose(probs.sum(axis=1), 1.0, atol=1e-5), "%s: sum != 1" % label
    return probs


def test_v55_serve_produces_valid_probs():
    X, _, _, _ = load_data(limit=50, feature_names=FEATURE_NAMES_V55)
    assert X.shape[1] == 223, "V55 attendu 223 features, got %d" % X.shape[1]

    p_train = _check(X, "train-dist")
    # Condition de service : closing features a 0 (comme a l'inference live)
    X_serve = X.copy()
    for c in CLOSING_DERIVED_FEATURES:
        if c in X_serve.columns:
            X_serve[c] = 0.0
    p_serve = _check(X_serve, "serving(closing=0)")

    # M3 : le modele doit etre INVARIANT aux closing features (skew supprime)
    assert np.allclose(p_train, p_serve, atol=1e-6), \
        "M3 non resolu : probas different selons closing (skew train/serve)"
