"""M3 (F1) : re-entrainement V55 SANS features closing-derivees + A/B vs prod.

- Ecrit des hyperparametres par defaut si data/v55_best_params.json absent (evite
  le crash de train_v55 et le cout d'Optuna).
- Re-entraine UNIQUEMENT vers models/stitch_v55_noclose.json (artefact separe,
  la prod n'est JAMAIS ecrasee).
- A/B honnete : prod evalue en condition de service (features closing mises a 0,
  comme a l'inference live) vs noclose (features closing absentes par construction).
"""
import os
import sys
import json
import time
import numpy as np
import xgboost as xgb

CORE = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "core")
if CORE not in sys.path:
    sys.path.insert(0, CORE)

from ml_features import FEATURE_NAMES_V55, FEATURE_NAMES_V55_NOCLOSE, CLOSING_DERIVED_FEATURES  # noqa: E402
from train_v55 import train_v55, load_data, MODEL_PATH  # noqa: E402

BASE = os.path.dirname(CORE)
NO_CLOSE_PATH = os.path.join(BASE, "models", "stitch_v55_noclose.json")
BEST_PARAMS_PATH = os.path.join(BASE, "data", "v55_best_params.json")

DEFAULT_PARAMS = {
    "learning_rate": 0.05, "max_depth": 6, "subsample": 0.8,
    "colsample_bytree": 0.8, "min_child_weight": 1,
    "gamma": 0, "reg_alpha": 0, "reg_lambda": 1,
}

print("[M3] Preparation des hyperparametres...", flush=True)
if not os.path.exists(BEST_PARAMS_PATH):
    with open(BEST_PARAMS_PATH, "w") as f:
        json.dump(DEFAULT_PARAMS, f, indent=2)
    print("[M3] best params par defaut ecrits", flush=True)
else:
    print("[M3] best params existants utilises", flush=True)

t0 = time.time()
print("[M3] Re-entrainement V55 NOCLOSE (echantillon representatif 20000 lignes)...", flush=True)
train_v55(
    post2010=True,
    feature_names=FEATURE_NAMES_V55_NOCLOSE,
    out_model_path=NO_CLOSE_PATH,
    max_rows=int(os.environ.get("M3_MAX_ROWS", 20000)),
)
print("[M3] Modele NOCLOSE sauvegarde en %.1fs" % (time.time() - t0), flush=True)

# --- A/B ---
print("[M3] Construction du set de test (features V55 completes)...", flush=True)
X_full, y, sw, dates = load_data(limit=5000, feature_names=FEATURE_NAMES_V55)
y = np.array(y)

close_idx = [X_full.columns.get_loc(c) for c in CLOSING_DERIVED_FEATURES if c in X_full.columns]

# Prod en condition de service : closing features mises a 0 (comme a l'inference)
X_prod_serving = X_full.copy()
for c in CLOSING_DERIVED_FEATURES:
    if c in X_prod_serving.columns:
        X_prod_serving[c] = 0.0

# Noclose : on retire les colonnes closing
X_noc = X_full.drop(columns=[c for c in CLOSING_DERIVED_FEATURES if c in X_full.columns])

prod = xgb.Booster()
prod.load_model(MODEL_PATH)
noc = xgb.Booster()
noc.load_model(NO_CLOSE_PATH)


def acc(bst, X):
    p = np.argmax(bst.predict(xgb.DMatrix(X.values)), axis=1)
    return float((p == y).mean())


pa = acc(prod, X_prod_serving)
na = acc(noc, X_noc)
print("=" * 50, flush=True)
print("[M3-A/B] PROD (closing=0, condition service)  acc = %.4f" % pa, flush=True)
print("[M3-A/B] NOCLOSE (closing absent)            acc = %.4f" % na, flush=True)
print("[M3-A/B] delta (noclose - prod)              = %.4f" % (na - pa), flush=True)
print("=" * 50, flush=True)
print("[M3] Termine en %.1fs" % (time.time() - t0), flush=True)
