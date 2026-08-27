"""
Phase 2 + 3 : meta-stackeur (LR multinomial) sur predictions OOF (Phase 1).

Evaluation HONNETE (anti-fuite) : leave-one-fold-out sur les 10 folds mensuels
2526. Chaque match est predit par un stacker entraine sur les AUTRES folds
(et les probs d'entree sont deja OOF vs les membres de base). Aucune fuite
membre ni cible.

Compare : stacker LR vs meilleur membre seul (lr : 60.6% / 0.882) vs moyenne
uniforme des membres.

GATE (cf plan) : stacker doit battre lr seul (acc > 0.606 ET logloss < 0.882)
sur la saison 2526, sinon on ne ship pas.

Usage :
  data_pipeline/.venv/Scripts/python.exe scripts/train_stacker.py
"""
from __future__ import annotations
import sys
from pathlib import Path
import numpy as np
import pandas as pd
from sklearn.linear_model import LogisticRegression
from sklearn.preprocessing import StandardScaler

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
from core.backtest_walkforward import metrics_multi  # même métrique que le harnais

OOF = ROOT / "data_pipeline" / "data" / "processed" / "oof_1x2.csv"
MEMBERS = ["lr", "rf", "xgb", "promo", "dc", "poisson", "elo_xgb", "xg_xgb", "close_xgb"]


def build_X(oof, members):
    cols = [f"p_{m}_{c}" for m in members for c in ("H", "D", "A")]
    return oof[cols].to_numpy().astype(float)


def evaluate(y_true, proba):
    return metrics_multi(y_true, proba)


def main():
    oof = pd.read_csv(OOF)
    # Seule la saison 2526 a un fold (val du walk-forward) -> echantillon d'evaluation
    # (n=1752), identique a BASELINE_EVAL. Les saisons antérieures ne sont pas OOF.
    oof = oof[oof["fold"].notna() & (oof["fold"].astype(str) != "")].reset_index(drop=True)
    y = oof["y_true"].astype(int).to_numpy()
    folds = sorted(oof["fold"].unique())
    print(f"[stacker] {len(oof)} matchs, {len(folds)} folds, {len(MEMBERS)} membres")

    X = build_X(oof, MEMBERS)

    # --- Baseline : meilleur membre seul (lr) ---
    lr_proba = oof[["p_lr_H", "p_lr_D", "p_lr_A"]].to_numpy().astype(float)
    base = evaluate(y, lr_proba)
    print(f"[base lr seul]      acc={base['acc']:.4f}  logloss={base['logloss']:.5f}")

    # --- Baseline : moyenne uniforme des membres ---
    uniform = np.mean([oof[[f"p_{m}_H", f"p_{m}_D", f"p_{m}_A"]].to_numpy() for m in MEMBERS], axis=0)
    uni = evaluate(y, uniform)
    print(f"[base moyenne]     acc={uni['acc']:.4f}  logloss={uni['logloss']:.5f}")

    # --- Stacker LR multinomial, leave-one-fold-out ---
    def lofo_fit_predict(make_clf):
        sp = np.zeros((len(y), 3))
        for f in folds:
            tr = oof["fold"] != f
            va = ~tr
            if tr.sum() < 50 or va.sum() < 10:
                continue
            scaler = StandardScaler().fit(X[tr])
            clf = make_clf()
            clf.fit(scaler.transform(X[tr]), y[tr])
            sp[va] = clf.predict_proba(scaler.transform(X[va]))
        return sp

    stack_proba = lofo_fit_predict(lambda: LogisticRegression(max_iter=3000, C=1.0,
                                                             class_weight="balanced"))
    stk = evaluate(y, stack_proba)
    print(f"[STACKER lr C=1]    acc={stk['acc']:.4f}  logloss={stk['logloss']:.5f}  "
          f"brier={stk['brier']:.4f}  ece={stk['ece']:.4f}")

    # Variante : LR fortement regularise (C=0.05)
    sp2 = lofo_fit_predict(lambda: LogisticRegression(max_iter=3000, C=0.05,
                                                      class_weight="balanced"))
    stk2 = evaluate(y, sp2)
    print(f"[STACKER lr C=0.05] acc={stk2['acc']:.4f}  logloss={stk2['logloss']:.5f}")

    # Variante : XGBoost peu profond (max_depth=2) comme meta
    def make_xgb_stack():
        from xgboost import XGBClassifier
        return XGBClassifier(n_estimators=150, max_depth=2, learning_rate=0.05,
                             subsample=0.8, colsample_bytree=0.8, min_child_weight=20,
                             random_state=42, n_jobs=-1, eval_metric="mlogloss",
                             objective="multi:softprob", num_class=3, tree_method="hist")
    sp3 = lofo_fit_predict(make_xgb_stack)
    stk3 = evaluate(y, sp3)
    print(f"[STACKER xgb d=2]  acc={stk3['acc']:.4f}  logloss={stk3['logloss']:.5f}")

    # Retenir le meilleur des stackers
    best = min([(stk, "lr C=1"), (stk2, "lr C=0.05"), (stk3, "xgb d=2")],
               key=lambda t: t[0]["logloss"])
    stk, stk_name = best
    print(f"-> meilleur stacker : {stk_name}")

    # --- GATE ---
    gate = stk["acc"] > base["acc"] and stk["logloss"] < base["logloss"]
    print("\n=== GATE (stacker bat lr seul) ===", "PASS" if gate else "FAIL")
    if gate:
        print("  -> Hybride valide ; passage Phase 4 autorise (integration server.js).")
    else:
        print("  -> Hybride NON superieur ; on NE ship pas (conserver lr comme reference).")

    # sauvegarde du rapport
    rep = {
        "n": int(len(y)), "folds": len(folds), "members": MEMBERS,
        "lr_alone": base, "uniform_mean": uni,
        "stacker_lr_C1": stk, "stacker_lr_C005": stk2, "stacker_xgb_d2": stk3,
        "best_stacker": stk_name, "gate_pass": bool(gate),
    }
    (ROOT / "data_pipeline" / "data" / "processed" / "stacker_report.json").write_text(
        __import__("json").dumps(rep, indent=2)
    )
    print("[stacker] rapport -> data_pipeline/data/processed/stacker_report.json")


if __name__ == "__main__":
    main()
