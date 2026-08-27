# HYBRID_STACKER — Système hybride de prédiction 1X2 (méta-stacking)

Objectif : combiner le système de prédiction (Node enrichOne/QuantumQuantEngine),
Promosport XGBoost et les autres modèles via un **méta-stackeur** pour maximiser
l'accuracy 1X2 servie en prod.

## Principe (anti-fuite strict)
- Chaque membre produit des probabilités **OUT-OF-FOLD** (OOF) : un match est
  prédit par un modèle entraîné SANS l'avoir vu (expanding window + embargo 7j,
  hérité de `core/backtest_walkforward.py`).
- Le méta-stackeur (LR multinomial) est entraîné en **leave-one-fold-out** : chaque
  match est prédit par un stacker n'ayant pas vu sa cible.
- GATE : l'hybride ne ship QUE si `acc > lr_seul` ET `logloss < lr_seul` sur la
  saison 2526 (n=1752), la source de vérité `BASELINE_EVAL.md`.

## Membres candidats (Phase 1)
| Membre | Type | Diversité |
|---|---|---|
| lr | LogisticRegression (allowlist master) | référence |
| rf | RandomForest | complémentaire |
| xgb | XGBoost depth=4 | baseline |
| promo | **XGBoost depth=6** (= Promosport XGB v2 ré-entraîné) | profondeur différente |
| dc | Dixon-Coles (maison) | bayésien |
| poisson | Poisson shrinké | baseline forte |

## Modèles pré-entraînés NON utilisables
- `promosport_xgb.json` : **corrompu (0 feature)** -> remplacé par `promosport_xgb_v2.json`.
- `xgboost_v55.json`, `stitch_v55_*`, `stitch_v551/552/553_*`, `titanium_v4`,
  `xg_home/away/archive` : **0 feature** (boosters illisibles/corrompus).
- `stitch_v24_hybrid.json`, `titanium_v2.json` : 197 features mais **0 présente**
  dans `master_dataset.csv` (pipeline de features engineering incompatible) ->
  inference impossible sans recréer ces features.

## Résultats (run 2026-08-26, saison 2526 n=1752)
| Méthode | acc | logloss |
|---|---|---|
| **lr seul (référence)** | **60,27 %** | **0,88585** |
| moyenne uniforme des 6 membres | 59,02 % | 0,89841 |
| stacker LR C=1 | 56,74 % | 0,90855 |
| stacker LR C=0,05 | 56,68 % | 0,90624 |
| stacker XGB depth=2 | 58,56 % | 0,90208 |

**GATE = FAIL.** Aucun stacker ne bat lr seul. Cause : membres très corrélés
(tous biaisés H ~85 % argmax), pas de diversité à exploiter, dataset petit.

## Décision
- On **NE ship pas** l'hybride (règle mesure-first). LR reste la référence ;
  XGBoost = membre d'ensemble léger, pas modèle primaire.
- `promosport_xgb_v2.json` (non dégénéré) est conservé comme membre d'ensemble.

## Pistes si on veut vraiment dépasser LR (non testées)
1. **Diversité par features engineering** : ré-entraîner des membres sur des
   vecteurs disjoints (Elo-only, xG-only, odds-close-only) walk-forward -> briser
   la corrélation H.
2. **Gating conditionnel** : utiliser XGBoost seulement quand il diverge
   fortement de LR (écarts de proba > seuil), sinon LR.
3. **Plus de données** : élargir `master_dataset.csv` hors Top-5 (5301 matchs
   seulement) — le stacker généraliserait mieux.

## Mise à jour : 9 membres spécialisés (expérience 2)
Ajout de 3 membres à vecteur de features DISJOINT pour briser la corrélation H :
`elo_xgb` (Elo), `xg_xgb` (xG/formes), `close_xgb` (cotes de clôture). Tous
ré-entraînés walk-forward. Résultat :

| Méthode | acc | logloss |
|---|---|---|
| lr seul (référence) | **60,27 %** | **0,88585** |
| moyenne uniforme 9 membres | 58,22 % | 0,90574 |
| stacker LR C=1 | 55,54 % | 0,91266 |
| stacker LR C=0,05 | 56,22 % | 0,90892 |
| stacker XGB depth=2 | 58,96 % | 0,90061 |

**GATE = FAIL** (meilleur 58,96 % < 60,27 %). La diversité par features n'inverse
pas la hiérarchie : les membres spécialisés gardent un profil de probabilités
corrélé (tous biaisés H, écarts de proba faibles entre eux).

### Conclusion générale
Sur cette empreinte (Top-5, 5301 matchs, 2526 n=1752), **aucun stacking ni
blend testé ne bat LogisticRegression** — confirmant `BASELINE_EVAL.md`
(« XGB KEEP conditionnel — ne bat pas LR »). LR est le plafond pratique ici.

### Décisions
- LR = référence en prod (déjà le cas via le chemin Node servi).
- XGBoost (dont `promosport_xgb_v2.json` sain) = membre d'ensemble léger,
  NON primaire ; ne PAS activer `V553_OVERRIDE` pour promouvoir XGB.
- Seules voies de dépassement réalistes : **(a) plus de données** (élargir
  `master_dataset.csv` hors Top-5) ou **(b) feature engineering beaucoup plus
  riche** (embeddings équipe, H2H, contextuel) — hors scope du stacking.

## Scripts livrés
- `scripts/retrain_promosport_xgb.py` : Phase 0 (ré-entraîne promosport_xgb_v2.json).
- `scripts/gen_oof.py` : Phase 1 (génère `oof_1x2.csv`, 5301 lignes OOF, 9 membres).
- `scripts/train_stacker.py` : Phase 2-3 (LOFO + GATE, rapport JSON).
