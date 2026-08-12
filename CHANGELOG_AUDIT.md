# CHANGELOG AUDIT — Titanium AI (stitch)

Suivi des correctifs issus de l'audit pronostics. Un correctif à la fois, validé avant de passer au suivant.

---

## ÉTAPE 1 — Unifier la mesure de performance ✅

**Date** : 2026-08-12
**Statut** : appliquée (baseline calculé, routes dashboard NON branchées — attente validation utilisateur)
**Tag git** : `audit-etape1-before` (état avant modifications)

### Cause racine de l'écart ×2.3 (27.3 % vs 61.7 %)

Les deux fichiers mesuraient des artefacts opposés, AUCUN ne reflétait le moteur :

1. **`promosport_accuracy_trend.json` (27.3 %)** — `scripts/accuracy_snapshot.js` → `promosportResultService.getOverallStats()`.
   - Source : `historical_archive.sqlite` (grilles `promosport_predictions` backfillées).
   - **Problème** : la grille `ML_MODEL` représente 99 % des prédictions (5133/5185) et prédit **« X » dans 4932/5133 cas (96 %)** → le modèle `promosport_xgb.json` est **dégénéré vers le nul** ; l'accuracy ≈ taux de base des nuls (25.6 % dans l'archive). De plus, le backfill a du look-ahead (`_getTeamStats` sans filtre `beforeDate`).
   - C'est la performance d'un backfill corrompu, pas du moteur.

2. **`retro_accuracy_report.json` (61.7 %)** — `scripts/retro_accuracy_analysis.js` + `promosportSurpriseService.js`.
   - Source : `promosport_historical_results.json` (370 concours / 4790 matchs, figé au 21/07).
   - **Problème** : le rapport ne teste pas les prédictions réelles. Il fabrique des probabilités `computeProbs()` à partir des **taux historiques d'équipe**, puis `bestSingle()` = « toujours le favori ».
   - **Look-ahead massif** : `computeSurpriseRates()` (ligne 70) agrège les stats d'équipe sur les **370 concours d'un coup** ; `getSurpriseStats()` (ligne 92) réutilise ces taux **globaux** pour chaque match passé, y compris le match lui-même et les concours futurs. → 61.7 % = oracle du favori avec connaissance du futur.
   - Fuite secondaire : noms d'équipes non normalisés → chute sur defaults codés en dur (0.424/0.259/0.317).

3. **Conséquence** : l'écart ×2.3 n'était **pas** une contradiction de performance du moteur. La vraie précision du moteur (`prediction_engine.py`) était **inconnue** : `matches` a 0 match FT, `backtest_results.json` n'existe pas (autoBacktestService n'a jamais écrit).

### Correctif appliqué

- **`services/accuracyEngine.js`** (nouveau) — métrique UNIQUE :
  - Périmètre : matchs terminés (`matches` FT + `historical_matches`), score définitif requis.
  - **Snapshot au temps T** : prédiction/confiance telles qu'enregistrées (`prediction` / `fullData` archivée). AUCUN recalcul post-hoc, aucun backfill dans la mesure.
  - **Whitelist stricte** : `1, X, 2, 1X, X2, 12, O<seuil>, U<seuil>`. Labels hors whitelist (`RISKY BET`, `PENDING`, …) **exclus du calcul** et comptés dans `excludedLabels`.
  - Métriques : accuracy brute (hors push O/U), Brier score, log-loss, courbe de calibration par bande de 10 %, accuracy par ligue.
  - Deux vues (rolling 7j/30j + cumulé) via le **même** code — seul le filtre `from/to` change.
  - Cas vide : retourne une structure valide (`accuracy=null`, `empty=true`), jamais de NaN.
- **`__tests__/accuracyEngine.test.js`** (nouveau) — 9 tests Jest (nominal, whitelist, O/U, fenêtres, cas vide, snapshot au temps T). **9/9 verts**.
- **`scripts/accuracy_report.js`** (nouveau) — écrit `data/accuracy_report.json` (rolling 7j/30j + cumulé).
- **`data/promosport_accuracy_trend.json`** et **`data/retro_accuracy_report.json`** — marqués `deprecated: true` + `reason` (contenu conservé).
- **`routes/evolution.js` / `app.js`** — **NON touchés** (attente validation du chiffre baseline).

### Baseline mesuré (données actuelles, 2026-08-12)

`node scripts/accuracy_report.js`

| Vue | Matchs évalués | Corrects | Accuracy |
|---|---|---|---|
| rolling 7j | 9 | 8 | 88.9 % |
| rolling 30j | 9 | 8 | 88.9 % |
| cumulé | 9 | 8 | 88.9 % |

**Lecture critique** (importante) :
- `matches` : **0 match FT** (266 scheduled, 1 live) → seul `historical_matches` contribue.
- `historical_matches` : **441 matchs finis**, dont **432 SANS prédiction exploitable** (`noPredictionCount=432`), **9 évalués**.
- L'accuracy 88.9 % sur **n=9** n'est **pas statistiquement significative**. Le vrai signal de cette étape : **l'échantillon de prédictions réellement évaluables est quasi nul** — cohérent avec D4 (matchs FT purgés/archivés sans conservation de la prédiction) et D2 (peu de prédictions stockées).

### Prochaines actions (attente validation)
1. Brancher `routes/evolution.js` + `app.js` sur `data/accuracy_report.json` (ÉTAPE 1b).
2. ÉTAPE 2 : nettoyage données (whitelist en amont, flux FT→historique, audit cotes).

---

## ÉTAPE 1b — Fix perte de prédiction à l'archivage ✅

**Date** : 2026-08-12
**Statut** : appliquée et testée (tests Jest 6/6 verts, lint 0 erreur, migration appliquée sur `tactical.db`)

### Diagnostic (validé) : ce n'était PAS un simple oubli d'archivage — c'est une race condition + backfill externe

Cycle de vie reconstruit sur les **441 matchs FT archivés** :

| Cause | Effectif | Preuve |
|---|---|---|
| (a) « jamais prédit » | **0 / 441** | tous ont des lignes `prediction_history` (probas réelles, somme≈1) écrites par `updatePredictions` (bulk 08-08 12:36) |
| (b) prédit puis perdu à l'archivage | **399 / 441** | fullData écrasé → objet minimal 9 clés (`updatedBy: "backfill_livescore_scores"`), puis `archiveFinishedMatches` ne copiait que `fullData` |
| fullData intact (étalon) | **42 / 441** | dont 9 exploitables + **33 PENDING légitimes** (rejet moteur, `enriched_predictions.js:1552-1557`) |

Détails clés :
- **0/33 PENDING n'ont subi l'écrasement** : 33/33 ont un fullData complet avec `verdict:"PENDING"` explicite = vrai rejet « données insuffisantes », distinct du bug d'archivage.
- Le clobberer `backfill_livescore_scores` est **absent du repo** (script externe/ponctuel, déjà supprimé). Il a REMPLACÉ `matches.fullData` par 9 clés.
- Les 4 services de sync du repo (bigBalls/futpython/predixSport/footballData) font déjà un merge — mais **sans ordre garanti** (crons indépendants 6h/12h/boot + `workerBridge` → processus séparé `scraper-worker.js` vs enrichissement toutes les 20 min) → risque latent de **lost-update cross-process**.

### Correctif appliqué (SQLite + PG, tests uniquement SQLite)
1. **Migration** : `historical_matches` gagne `prediction, confidence, home_win_probability, draw_probability, away_win_probability, expected_score, result, settled_at` — ajoutés dans `runMigrations()` (database.js), la SCHEMA PG (pg_migrations.js) et un bloc `ALTER TABLE ADD COLUMN IF NOT EXISTS` PG.
2. **`archiveFinishedMatches`** (database.js + pg_database.js) : INSERT étendu aux nouvelles colonnes + **anti-écrasement** (ré-injecte le verdict depuis les colonnes indexées si le fullData a été écrasé avant l'archivage).
3. **`mergeFullData`** (nouveau helper, database.js + pg_database.js) : merge gardé — les services de sync n'écrasent QUE leur clé namespace et la **ré-injection colonnes→fullData** restaure la prédiction même sur un stale-read. Branche sur bigBallsDataService, futpythonService, predixSportService, startupBootstrap.
4. **Tests** (`__tests__/archivalGuard.test.js`, 6/6) : séquence `updatePredictions → service → archive` ; anti-écrasement sur fullData minimal ; ordre service/prédiction dans les 2 sens ; **troll lost-update cross-process avec ordre aléatoire** (30 itérations PRNG déterministe) — la prédiction survit toujours.
5. **Pas de recalcul d'accuracy sur l'historique perdu** : les 399 restent perdus. La reconstruction argmax (≈44.9 % sur le batch 08-08) n'est qu'un **repère qualitatif**, pas une métrique.

### ⚠️ NOTE DE FIABILITÉ DES MÉTRIQUES (importante)
> **Les métriques de performance historiques antérieures à ce correctif ne sont PAS fiables** : l'échantillon évaluable était vicié par la perte de prédiction à l'archivage (n=9 sur 441, cohorte non représentative — les picks conservés étaient les meilleurs du batch, d'où le 88.9 % trompeur). **Seules les prédictions post-correctif** (date de déploiement du fix) doivent être utilisées pour évaluer le modèle. Toute comparaison avec les 27.3 %/61.7 % antérieurs est invalide par construction.

---

## ÉTAPE 2 — prévue (whitelist labels sales + audit cotes D1 + biais home D2)

*Chaque modification ultérieure sera ajoutée à ce fichier.*
