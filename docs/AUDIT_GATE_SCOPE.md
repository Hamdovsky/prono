# AUDIT_GATE_SCOPE.md — Matrice Environnement × Transformation

**Projet** : Titanium AI / Stitch — pipeline de prédiction football
**Date** : 2026-08-26 — Audit Prio 3 (complète les Prio 1 & 2 : `accuracyEngine.lowData*`, `enrichOne.engine_exit`)
**Source de vérité** : dépôt git + lecture des fichiers listés (pas de recalcul, pas de refactoring)
**Principe** : cette matrice recense chaque **gate d'environnement** (variable `.env` / flag runtime) et la **transformation** qu'elle active/désactive, avec l'état effectif dans la config actuelle et la preuve (fichier:ligne).

> Convention d'état :
> - `OFF` = gate désactivé par défaut / par `.env` → transformation NEUTRALISÉE (pas appliquée)
> - `ON`  = gate activé → transformation ACTIVE
> - `STRUCT` = transformation « structurelle » active indépendamment des gates calibration (shrinkage de sécurité)

---

## 1. Calibration & Ajustements de probabilités

| Gate (env) | Transformation | État actuel | Preuve |
|---|---|---|---|
| `ISO_RUNTIME_APPLY=false` (.env.example:97) | Calibration isotonique **runtime** (applique le calibrateur sur les probs live) | **OFF** → neutralisée | `core/calibration_iso.py:299-300` (`if ... == 'false': return identity`) |
| `ENABLE_ISO_CALIBRATION=0` (défaut) | Entraînement/application du calibrateur isotonique dans l'ensemble | **OFF** → neutralisée | `core/ml_ensemble.py:684` (`if has_xgb and getenv(...) == '1'`) |
| `META_REFINER_PY=off` (défaut) | Neural Meta-Refiner (Bayesian shrinkage sur biais historique) | **OFF** → neutralisé | `core/ml_ensemble.py:358` (`getenv(..., 'off') == 'on'`) |
| `DRAW_PRIOR_K=1.0` (défaut) | Ajustement prior du nul (draw-prior) | **OFF** (1.0 = aucun effet) | `core/ml_ensemble.py:698` (`float(getenv('DRAW_PRIOR_K','1.0'))`) |
| `GAP_LEARNING_ENABLED=off` (défaut) | Gap learning (révision post-settlement) | **OFF** → aucun changement | `core/data_loader.py:532`, `core/prediction_engine.py:742` |
| `BASELINE_FALLBACK=off` (défaut) | Kill-switch repli sur baseline naïve | **OFF** → désactivé | `core/baseline_fallback.py:163`, `core/prediction_engine.py:100` |

### Transformations STRUCTURELLES toujours actives (non couvertes par les gates ci-dessus)
Ces shrinkages de sécurité restent appliquées même si toute calibration est OFF — elles ne sont PAS des « recalibrages » mais des plafonnements défensifs :

| Transformation | Preuve |
|---|---|
| PWR shrink | `core/ml_ensemble.py` (blend V4) |
| GNN shrink | `core/ml_ensemble.py` |
| DEX shrink | `core/ml_ensemble.py` |
| Draw dampener | `core/ml_ensemble.py:443` |
| Draw multiplier | `core/ml_ensemble.py` |
| Live feature shrink | `core/featureEngineer` / `data_loader` |
| Renormalisations finales (somme→1, clamp) | `core/ml_ensemble.py`, `core/confidence_engine.py` |

> ⚠️ Conséquence : dire « toute la calibration est coupée » est **inexact**. L'isotonic est coupée (OFF), mais 7+ shrinkages structurels restent actifs. Ils expliquent pourquoi les probs finale ne sont pas une simple sortie XGBoost brute.

---

## 2. Ensemble & Modèles

| Gate (env) | Transformation | État actuel | Preuve |
|---|---|---|---|
| `V4_ENSEMBLE_ENABLED=true` (défaut) | Blend V4 (stats-based) + V2 historique (85/15) | **ON** | `core/ml_ensemble.py:476` (`getenv(..., 'true') not in ('0','false','off')`), `:499` |
| External XGBoost (msoczi, top-5 ligues EU) | Boosters XGB locaux (fail-fast si absent) | **ON** (conditionnel ligue) | `core/external_xgb.py`, sélection dans `core/ml_ensemble.py` |
| Confluence Guard | Triple validation XGBoost + Poisson + Market | **ON** mais requiert `has_xgb=True` | `core/confluence_guard.py:32-212` (guard `if not has_xgb: skip`) |

### ZERO-DATA RESCUE (chemin low-data)
| Composant | Rôle | État | Preuve |
|---|---|---|---|
| `is_low_data_scenario` | détecte match amical/coupe sans historique | **ON** | `core/low_data_handler.py:34-52` |
| `predict_low_data` → `zero_data_rescue:True` / `is_low_data_prediction:True` | marquage du sauvetage | **ON** (Python) | `core/low_data_handler.py:105,112` |
| `BayesianLowDataHandler.predict_zero_data` (Penaltyblog) | prior league bayésien pour low-data | **ON** (uniquement via low_data) | `core/penaltyblog_engine.py:547-628` |
| Dixon-Coles | estimator ligue | **OFF** en live (uniquement `fit_all_leagues`) | `core/penaltyblog_engine.py:236-260` |
| Propagation vers `fullData` (Node prod) | les flags Python ne sont PAS consommés par le pipeline Node de prod | **NON PROPAGÉ** | grep : aucun match dans `core/*.js` / `services/*.js` ; le marqueur Node équivalent est `matches.insufficient_data` (`QuantumQuantEngine.js:51,82`, `database.js:216,601`) |

> ⚠️ Le early-return low-data de `core/prediction_engine.py:230` n'est **jamais consommé** par le pipeline de production (qui est Node : `enrichOne` → `QuantumQuantEngine` → `fullData`). Les stats low-data doivent donc être mesurées via `insufficient_data` côté Node (voir Prio 1 : `accuracyEngine.summary.lowData*`).

---

## 3. Pipeline de production (Node) — fidélité engine_exit → fullData

| Étape | Comportement | Preuve |
|---|---|---|
| `enrichOne` calcule `probs` (match_result) | point de sortie moteur = `engine_exit {p1,px,p2,btts,over25}` | `core/enrichOne.js` (snapshot `engine_exit` ajouté Prio 2) |
| `database.updatePredictions` | écrit `fullData.home_win_probability = enriched.home_win_probability \|\| …` | `core/database.js:1321-1336` |
| Résultat | `fullData.probs` == `engine_exit` par construction (même objet) | helper `engineExitDiff` (Prio 2) mesure tout écart éventuel = 0 en config actuelle |

> Aucune transformation supplémentaire ne mute `home/draw/away_win_probability` après `enrichOne` (seuls `btts_pick`, `corner_pick`, `ht_pick` sont dérivés ensuite, `database.js:1417-1438`). Donc l'écart engine_exit ↔ fullData.probs est **nul** sur match_result.

---

## 4. Mesure de performance (Prio 1) — ce qui est maintenant disponible

| Métrique | Source | Champ |
|---|---|---|
| Compteur picks low-data | `matches.insufficient_data` / `fullData.zero_data_rescue` / `is_low_data_prediction` | `accuracyEngine.summary.lowDataCount` |
| Prédictions correctes low-data | idem | `summary.lowDataCorrect` |
| Accuracy isolée low-data | idem (push O/U exclus du dénominateur) | `summary.lowDataAccuracy` (`null` si aucun pick low-data) |

Lecture seule, snapshot au temps T (aucun recalcul) — conforme au principe d'audit.

---

## 5. Résumé exécutif pour le dashboard

1. **Calibration isotonique** : OFF (les deux gates `ISO_RUNTIME_APPLY`, `ENABLE_ISO_CALIBRATION` coupées).
2. **Meta-Refiner / Gap / Draw-prior / Baseline-fallback** : tous OFF (défaut).
3. **Shrinkages structurels** : toujours ON (sécurité, non désactivables par ces gates).
4. **V4 ensemble + XGBoost externe + Confluence** : ON.
5. **ZERO-DATA RESCUE** : ON côté Python, mais **non propagé** au pipeline Node prod → la mesure low-data passe par `insufficient_data` (désormais exposée via Prio 1).
6. **Fidélité engine_exit ↔ fullData.probs** : vérifiée nulle sur match_result (Prio 2).

**Conclusion** : le pipeline n'est PAS « recalibré » au sens d'une calibration statistique active, mais il applique des shrinkages défensifs permanents. Toute affirmation « on a tout coupé » doit être nuancée (points 3 et 4 restent actifs).
