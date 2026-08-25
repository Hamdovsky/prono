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
| Dixon-Coles (maison) | 0,99961 | 0,59509 | 51,0 % |
| Poisson (means shrinké) | 1,00558 | 0,60029 | 50,9 % |

### Over/Under 2.5 (binaire)
| Modèle | LogLoss ↓ | Brier ↓ | Acc | ECE ↓ |
|---|---|---|---|---|
| **LR** ✅ | **0,57971** | 0,19764 | 69,5 % | 0,070 |
| XGB | 0,59071 | 0,20311 | 67,6 % | 0,089 |
| RF | 0,60221 | 0,20738 | 67,8 % | 0,078 |
| Dixon-Coles (maison) | 0,69239 | 0,24916 | 56,2 % | 0,079 |
| Poisson | 0,69624 | 0,25093 | 54,2 % | 0,090 |

### BTTS (binaire)
| Modèle | LogLoss ↓ | Brier ↓ | Acc | ECE ↓ |
|---|---|---|---|---|
| **RF** ✅ | **0,61651** | 0,21307 | 68,0 % | 0,082 |
| XGB | 0,62302 | 0,21548 | 67,0 % | 0,079 |
| LR | 0,63407 | 0,22177 | 64,0 % | 0,070 |
| Dixon-Coles (maison) | 0,69538 | 0,25045 | 55,0 % | 0,075 |
| Poisson | 0,69920 | 0,25276 | 52,9 % | 0,074 |

## Décisions (keep/drop)

| Modèle | Décision | Motif |
|---|---|---|
| LogisticRegression | **KEEP** — référence | Domine 2 marchés /3 ; relations quasi-linéaires + dataset modeste |
| RandomForest | **KEEP** | Meilleur sur BTTS ; complémentaire LR |
| XGBoost (features master) | **KEEP conditionnel** | Ne bat pas LR ici — à re-tester après Phase 9/10 (features enrichies) avant tout rôle étendu |
| Dixon-Coles (maison) | **KEEP comme baseline forte** | Bat le Poisson naïf sur les 3 marchés, mais reste > LR/RF/XGB → baseline de contrôle de référence (toute évolution doit rester < DC) |
| Poisson means shrinké | DROP comme prédicteur | Battu par DC partout ; **garde comme baseline minimale** de contrôle |

## Caveats honnêtes

1. Le « poisson » testé est une baseline attaque/défense shrinkée simple ;
   le **Dixon-Coles** (impl. maison : Poisson + rho + décroissance temporelle xi)
   est désormais évalué et sert de baseline classique de référence. penaltyblog
   non installé dans le venv -> DC codé à la main (scipy), validé.
2. Le XGBoost évalué ici utilise UNIQUEMENT l'allowlist master ; le XGBoost
   runtime (FastAPI) consomme un vecteur différent — comparaison non concluante
   entre les deux, seulement entre modèles sur features égales.
3. ECE pré-calibration ; le réarmement isotonique (gate ISO) s'appliquera
   APRÈS accumulation post-gel, jamais sur ces données historiques.
4. **Bug corrigé (Phase C suite)** : extraction O/U2.5 utilisait
   `triu_indices(G+1,3)` qui excluait des cellules total≥3 (ex. (1,2)) ->
   Poisson OU25 sur-estimé à 1,41 ; corrigé par masque `i+j>=3` -> 0,696.
   Toute la table ci-dessus est la version corrigée.

*Run généré par `python -m core.backtest_walkforward` — config hashée en base.*
