# BASELINE_EVAL — Comparaison des modèles en walk-forward

> Source de vérité : moteur `core/backtest_walkforward.py` (run immuable en
> `data_pipeline/data/processed/backtest_runs.sqlite`). Aucun chiffre de perf
> ne doit être annoncé ailleurs sans provenir d'un run de ce moteur.

## Protocole

- Données : `master_dataset.csv` Top-5 football-data.co.uk — **5301 matchs,
  saisons 2324→2526**
- Validation : saison 2526, **folds mensuels glissants (expanding window)**,
  refit par fold
- **Embargo 7 jours** entre fin de train et début de validation (respecté sur
  100 % des folds — flag `embargo_all_ok`)
- Features : allowlist causale stricte (Elo, xG/xA, formes L5/L10, cotes
  **open uniquement**) — stats in-match, scores et colonnes closing EXCLUES
- Tripwire B0 : corrélation max one-hot vs cible > 0,97 → exclusion auto
- Imputation médiane fitée train uniquement

## Résultats (saison 2526, n=1752)

### 1X2 (logloss multiclasse)
| Modèle | LogLoss ↓ | Brier ↓ | Acc |
|---|---|---|---|
| **LR** ✅ | **0,88209** | 0,51716 | 60,6 % |
| RF | 0,88752 | 0,52136 | 60,0 % |
| XGB | 0,90039 | 0,52780 | 58,6 % |
| Poisson (means shrinké) | 1,00558 | 0,60029 | 50,9 % |

### Over/Under 2.5 (binaire)
| Modèle | LogLoss ↓ | Brier ↓ | Acc | ECE ↓ |
|---|---|---|---|---|
| **LR** ✅ | **0,57971** | 0,19764 | 69,5 % | 0,070 |
| XGB | 0,59071 | 0,20311 | 67,6 % | 0,089 |
| RF | 0,60221 | 0,20738 | 67,8 % | 0,078 |
| Poisson | 1,41066 | 0,42658 | 47,5 % | 0,423 ⚠️ |

### BTTS (binaire)
| Modèle | LogLoss ↓ | Brier ↓ | Acc | ECE ↓ |
|---|---|---|---|---|
| **RF** ✅ | **0,61651** | 0,21307 | 68,0 % | 0,082 |
| XGB | 0,62302 | 0,21548 | 67,0 % | 0,079 |
| LR | 0,63407 | 0,22177 | 64,0 % | 0,070 |
| Poisson | 0,69920 | 0,25276 | 52,9 % | 0,074 |

## Décisions (keep/drop)

| Modèle | Décision | Motif |
|---|---|---|
| LogisticRegression | **KEEP** — référence | Domine 2 marchés /3 ; relations quasi-linéaires + dataset modeste |
| RandomForest | **KEEP** | Meilleur sur BTTS ; complémentaire LR |
| XGBoost (features master) | **KEEP conditionnel** | Ne bat pas LR ici — à re-tester après Phase 9/10 (features enrichies) avant tout rôle étendu |
| Poisson means shrinké | DROP comme prédicteur | Battu partout ; **garde comme baseline de contrôle** (toute évolution doit rester > Poisson) |
| Dixon-Coles penaltyblog | À ÉVALUER (itération 2) | Non couvert par cette passe ; le MC DC du runtime reste inchangé |

## Caveats honnêtes

1. Le « poisson » testé est une baseline attaque/défense shrinkée simple —
   PAS le Dixon-Coles rho du runtime ni celui de penaltyblog.
2. Le XGBoost évalué ici utilise UNIQUEMENT l'allowlist master ; le XGBoost
   runtime (FastAPI) consomme un vecteur différent — comparaison non concluante
   entre les deux, seulement entre modèles sur features égales.
3. ECE pré-calibration ; le réarmement isotonique (gate ISO) s'appliquera
   APRÈS accumulation post-gel, jamais sur ces données historiques.

*Run généré par `python -m core.backtest_walkforward` — config hashée en base.*
