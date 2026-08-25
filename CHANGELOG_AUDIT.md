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

## ÉTAPE 2 — Chantier 1 : Whitelist des labels de prédiction (D3) ✅

**Date** : 2026-08-12
**Statut** : appliquée et testée (tests Jest verts, lint 0 erreur) — diff validé par l'utilisateur avant commit

### Diagnostic (validé)

Répartition de `matches.prediction` (267 matchs) : **261 en 1X2** (1/X/2/1X/X2/12), **3 en « O0.5 »**, **2 en « RISKY BET »**, 1 sans pick.

| Valeur | Nb | Verdict diagnostic |
|---|---|---|
| `O0.5` | 3 | **Format valide** (O+seuil, déjà accepté par `OU_RE`) mais **anomalie de marché** : ce sont des picks `first_half` du moteur quant (`quant.markets.first_half.O0.5`, prob ~80 %, odds 1.5) promus en `prediction` via `quantResult.main_pick` — le label ne code pas le marché (HT vs FT), l'évaluation accuracy contre les buts FT serait triviale et non représentative |
| `RISKY BET` | 2 | **Pas un label métier** : fallback par défaut de l'upsert (`database.js:1182` / `pg_database.js:444`) quand aucune prédiction n'est fournie. Les 2 lignes sont des artefacts de test (`update-test-001`, `update-enriched-001` — `database.test.js`) |

### Trouvaille annexe (bug PG latent, corrigé)

`pg_database.js:444` donnait **priorité à `data.verdict` sur `data.prediction`** (`data.verdict || enriched?.verdict || data.prediction`) — l'**inverse** de SQLite. Sur PG, un match avec `verdict:'SAFE'` + `prediction:'1'` aurait écrit `'SAFE'` en colonne → pollution de l'accuracy. **Ordre canonique unifié** appliqué aux deux : `data.prediction || data.enriched?.prediction || data.verdict || null`.

### Correctif appliqué

1. **Fallback null** (`database.js:1182`, `pg_database.js:444`) : le défaut `'RISKY BET'` est remplacé par `null` — un match sans prédiction passe en `noPredictionCount`, plus jamais en garbage label. **+ alignement de l'ordre SQLite/PG** (trouvaille annexe ci-dessus).
2. **`PENDING` séparé** (`accuracyEngine.js`) : verdict légitime (émission `enriched_predictions.js:1546-1557`, HONESTY GATE « données insuffisantes ») désormais compté dans `summary.pendingCount` — **distinct** de `excludedLabels` (vraies anomalies) et de `noPredictionCount`.
3. **Option A — `market_scope`** (`core/marketScope.js` nouveau + `enriched_predictions.js:1473`) : dérivation du **marché réel** du main_pick (`full_time_1x2` / `full_time_ou` / `full_time_dc` / `first_half` / `btts` / `unknown`), persistée dans fullData. **Strictement informatif** : rien de changé dans ce qui est promu en colonne `prediction`. Permettra à accuracyEngine d'évaluer chaque pick contre le bon référentiel (ex: O0.5 évalué mi-temps, pas full-time).
4. **Tests** (`__tests__/chantier1.test.js`, 13 tests) : fallback null, priorité canonique, `PENDING` compté séparément (matches + historique), `marketScopeOf` (first_half/full_time_ou/full_time_1x2/full_time_dc/btts/unknown/null).

### ⚠️ À TRAITER AU CHANTIER 2 (diagnostic seulement, non corrigé ici)

**Contradiction `risk_label:"PENDING"` + `sufficient:true`** sur 2 des 3 matchs « O0.5 » (Anapolis/Guarani, Club Leon W/Tigres W) : le fullData porte en même temps un verdict de rejet (`risk_label:'PENDING'`) et un pick complet (`quant.main_pick`, `predictions[]` non vide). Deux passes d'enrichissement différentes semblent cohabiter dans le même fullData (`enriched.quant.main_pick` = "12" pour Leon, `prediction` "2" pour Anapolis — instabilité du main_pick). À investiguer lors de l'analyse du taux de PENDING.

---

## ÉTAPE 2 — Chantier 2 : path PENDING (33/42) — fix structurel ✅

### Cause racine confirmée

**Contradiction `risk_label:"PENDING"` + `sufficient:true`** (19 matchs du slate actif) :
`resultData = { ...m, ... }` (`enriched_predictions.js:1434`) **hérite silencieusement des
champs de la passe précédente**. Le bloc HONESTY GATE était **asymétrique** :

| Champ | Branche `insufficient` | Branche `else` | Conséquence |
|---|---|---|---|
| `sufficient` | `false` (l.1574) | `true` (l.1576) | ✅ cohérent |
| `verdict` / `prediction` | `'PENDING'` / `null` | recalculés frais | ✅ cohérent |
| `risk_label` (top-level) | `'PENDING'` (l.1557) | **jamais réinitialisé** | ❌ **hérité de `...m`** |
| `enriched.sufficient` | non touché | non touché | ❌ **hérité** (écrit par fallback_enricher) |

Un match passé de « insuffisant » (passe N) à « suffisant » (passe N+1) **conservait**
`risk_label:'PENDING'` et `enriched.sufficient:false` périmés → la contradiction. C'est
l'**écriture via `updatePredictions`/fallback_enricher** (`enriched_predictions.js:1434`) qui
recréait l'état stale — pas le quant engine (déjà synchrone).

### Décompte réel sur le slate actif (267 matchs `matches`)

| Anomalie | Nb | Explication |
|---|---|---|
| `risk_label='PENDING'` + `sufficient:true` | **19** | stale hérité de l'ancienne passe |
| `enriched.sufficient` contradictoire | **1** (dont inclus dans les 19) | idem, via fallback_enricher |
| `risk_label='PENDING'` + `sufficient:false` (verdict légitime) | **0** | HONESTY GATE ne produit plus cet état |

Les **33 `historical_matches` PENDING sont des verdicts légitimes** (bulk 08-08, évalués
comme tels) : le chantier 2 ne les touche pas.

### Correctif appliqué

1. **Module pur `core/honestyGate.js`** (nouveau) : le HONESTY GATE est extrait du
   `enriched_predictions.js` (remplace les l.1545-1594) pour être testable unitairement.
   **Resets symétriques** : la branche `else` réinitialise explicitement `risk_label`
   (`quant.risk_label || verdict || 'SAFE'`) et `enriched.sufficient/risk_label/
   insufficient_data` — **plus jamais d'héritage via `...m`**. La branche `insufficient`
   synchronise aussi `enriched.*`.
2. **Script one-shot `scripts/fix_stale_risk_labels.js`** (`--dry-run` par défaut /
   `--apply`) : corrige les 19 lignes `matches` à la prochaine exécution manuelle. Ne
   touche **jamais** `historical_matches`.
3. **Tests** (`__tests__/chantier2.test.js`, 4 tests) : insuffisant → neutralisation
   complète + enriched synchro ; suffisant après insuffisant → **risk_label réinitialisé,
   contradiction éliminée** ; suffisant sans cotes → pick conservé, value neutralisée ;
   downgrade `quant.risk_label` → reporté sur top-level et enriched.

### Note

Le `market_scope` (Chantier 1) et ce fix structurel sont indépendants. L'évaluation
accuracy des 19 matchs corrigés reste identique (le verdict/prediction ne change pas —
seul `risk_label` reflète à nouveau le verdict courant).

---

## ÉTAPE 2 — Chantier 3 (prévu) : audit des cotes manquantes (D1, 97 % sans cote)

*Chaque modification ultérieure sera ajoutée à ce fichier.*

---

## ÉTAPE 2 — Chantier 3 — Point 1 : robustesse du matcher équipes BetExplorer ✅

### Correctifs appliqués (`scripts/betexplorer_aliases.json` → `canonical`)
1. **`utd` → `united`** — fix d'une **régression** détectée en validation : `Sydney United 58` ne matchait plus `Sydney Utd` (suffixe numérique `58` + alias manquant). Cas #9 du Bloc 1 (APIA Leichhardt vs Sydney United 58, Australia Cup) : `no_odds` → **trouvé**.
2. **`dep` → `deportivo`** — amélioration dans le périmètre Point 1 (abréviations d'équipe) : `Dep. A Coruna` ↔ `Deportivo (La) Coruna`.

### Tests ajoutés (`scripts/test_bypass_scraper.py`)
- `test_teams_match_utd_alias_suffix_number` : `Sydney United 58` ↔ `Sydney Utd` → True
- `test_teams_match_dep_alias` : `Deportivo (La) Coruna` ↔ `Dep. A Coruna` → True
- `test_no_false_positive_dep_alias` : `Dep. Madrid` vs `Deportivo Riestra` → False ; `Dep. Madrid` vs `Atletico Tucuman` → False

**Suite complète : 38/38 tests OK.**

### Validation Bloc 1 — Régression (10 matchs reconstitués) : **8/10**

| # | Match (ligue) | Résultat |
|---|---|---|
| 1 | PSG vs Aston Villa (UEFA Super Cup) | ✅ trouvé |
| 2 | Atl. Tucuman vs Independiente (Copa Argentina) | ✅ trouvé |
| 3 | Helsingborgs IF vs Vaernamo (Superettan) | ✅ trouvé |
| 4 | Orlando City vs San Luis (Leagues Cup) | ❌ échec légitime (couverture) |
| 5 | CSKA Sofia II vs Hebar (Vtora Liga) | ❌ échec légitime (couverture) |
| 6 | PSG vs Marseille (Ligue 1, avec date 2027-02-07) | ✅ trouvé |
| 7 | Deportes Recoleta vs Rangers (Primera B) | ✅ trouvé |
| 8 | Club La Union vs Aucas (Copa Ecuador) | ✅ trouvé |
| 9 | APIA Leichhardt vs Sydney United 58 (Australia Cup) | ✅ trouvé (fix utd) |
| 10 | Charlotte Independence vs Hartford (USL Cup) | ✅ trouvé |

### Validation Bloc 2 — Stress-test (paires clés)
- ✅ Trouvé : Barcelona vs Real Madrid (La Liga)
- ❌ Réseau (page vide / slug manquant), matcher OK : Man Utd vs Leeds (friendlies), Deportivo Coruña vs Real Madrid (friendlies), Bragantino vs Atl. MG (Copa Sudamericana non mappée), Inter Miami vs Leon (Leagues Cup), FC Copenhagen vs Debrecen (Conf. League Qualif non mappée), Chasetown vs Kidsgrove (NPL West), Forfar vs Aberdeen B (slug `Challenge Cup` → Irlande du Nord au lieu d'Écosse)
- ✅ **Zéro faux positif** confirmé : Man Utd vs Man City → False, Atl. Madrid vs Atl. Mineiro → False, Dep. Madrid vs Deportivo Riestra → False

### Validation Bloc 3 — Aléatoire (6 tirés, ligues mappées)
- ✅ Trouvé : Daejeon vs FC Seoul (K League 1), Lechia Gdańsk vs Legia (Ekstraklasa), Zagłębie vs Pogoń (Ekstraklasa)
- ❌ Mapping ligue générique → pays erroné : Riffa vs Al Bahrain (« Premier League » → Angleterre), Ulytau vs Caspiy (« Premier League »), US Monastir vs AS Soliman (« Ligue 1 » → France)

### Points hors périmètre → à traiter en Point 2/3
1. **Mapping ligue générique par pays** : `Premier League` → Angleterre, `Ligue 1` → France — **impact potentiellement large sur le slate réel** (slate : `Premier League` = Bahreïn/Azerbaïdjan, `Ligue 1` = Tunisie).
2. **Slug `Challenge Cup` ambigu** (Écosse vs Irlande du Nord) — Forfar vs Aberdeen B non résolu.
3. **Dépendance à la date** pour désambiguïser les rencontres aller-retour (PSG vs Marseille : 2 candidats Ligue 1 sans date → HONESTY GATE rejette).
4. **Pages de couverture vides** : friendlies, Leagues Cup, NPL West, Vtora Liga (CSKA Sofia II vs Hebar non listé).

---

## ÉTAPE 2 — Chantier 4 : Diagnostic priors low-data & biais home (D2) — 🔴 PRIORITÉ HAUTE

**Date** : 2026-08-12 — **Statut** : diagnostic validé, **puis FIX appliqué** (voir section « Chantier 4 : FIX APPLIQUÉ » ci-dessous)

### Contexte
D2 constatait **81 % de prédictions « 1 »** sur le slate actif (267 matchs `matches` : **215 « 1 », 80.5 %**). Le Point 4 devait vérifier si le fallback prior low-data (`LEAGUE_CATEGORY_PRIORS['club friendly']` = 0.42/0.25/0.33, `penaltyblog_engine.py:374-386`) injectait ce biais. **La trouvaille est plus structurante : le biais n'a presque rien à voir avec le prior.**

### Volet 1 — Le fallback prior n'est JAMAIS actif sur le slate
- **266/267** matchs : `ai_source: TITANIUM_QUANT_V4` (moteur quant JS). **0 marqueur** `low_data` / `prior_source` / `bayesian` dans les fullData.
- Le prior `league_prior` (`predict_zero_data`, `penaltyblog_engine.py:617-621`) ne s'active que si ni bayésien ni cotes implicites ne tournent. Ici : jamais.
- **Contribution au biais home : ~0 point.**

### Volet 2 — Le vrai biais : mismatch `prediction` vs `quant.main_pick` à 97 %
- Colonne `matches.prediction` : 80.5 % « 1 ». **Mais** `enriched.quant.main_pick` (pick réel du moteur) : **1X (94), O0.5 (91), 12 (70), X2 (9) — 0 pick « 1 » pur.**
- **Mismatch colonne `prediction` vs `quant.main_pick` : 260/267 = 97 %.** Déconnectés par construction.
- ~73 % du slate partage des probas quasi-constantes (48.4/25.1/26.5 ×158 ; 47.5/24.5/28.0 ×37) et des xG par défaut (1.58/1.1 ×172) → sortie Poisson de **league base-xG** (cotes absentes sur ~97 % des matchs).

### 🐛 Volet 3 — Cause racine : trou de séquencement dans la boucle INDEPENDENT-ENRICH
1. `server.js:488-536` lit `m` (colonne DB incluse) → `enrichOne(m)`.
2. `enrichOne` (`server.js:471-485`) retourne probs + `quant` mais **omet la clé `prediction`** (et `verdict`).
3. `server.js:519` : `updatePredictions(m.id, { ...m, ...enriched })` → `data.prediction` hérite de la **colonne stalée**.
4. `database.js:1178-1182` : `verdict = data.prediction || enriched.prediction || data.verdict` → **réécrit la valeur stalée**.
5. Dès qu'un « 1 » entre en colonne (écriture initiale du backfill 08-08 d'ÉTAPE 1b), le pick réel `quant.main_pick` est recalculé à chaque passe mais **ne remonte jamais à la colonne**.

> `RESPONSE_FLOOR` (`routes/matches.js:502`) et `_buildOfflineState` (`enriched_predictions.js:1562`) sont des **fallbacks réels et gated** (probas absentes) ; RESPONSE_FLOOR n'est qu'un floor de **réponse GET** (aucun `updatePredictions` dans cette route) et n'écrit pas la DB.

### Volet 4 — Le prior codé en dur est bien calibré (hypothèse initiale réfutée)
| Référence | n | Home / Draw / Away |
|---|---|---|
| Prior `club friendly` | — | 0.42 / 0.25 / 0.33 |
| Prior `default` | — | 0.46 / 0.24 / 0.30 |
| `archive_matches` | 1 096 | 0.426 / 0.255 / 0.319 |
| `promosport_archive` | 7 586 | 0.424 / 0.257 / 0.321 |
| `archive_football_data` | 144 397 | 0.449 / 0.269 / 0.282 |

→ Prior global ≈ réalité (écart < 2 pp). Seul écart réel : les **amicaux** (`International Friendly`, n=48 → 0.44/0.33/0.23) : draw sous-estimé (0.25 vs 0.33), away sur-estimé (0.33 vs 0.23).

**Proposition de valeurs corrigées (NON appliquées — diagnostic seul)** : `club friendly` → **0.44/0.33/0.23** ; `default`/`cup` → **~0.43/0.26/0.32** (aligné `archive_football_data`).

### 🔴 Impact sur les métriques existantes — RÉINTERPRÉTATION OBLIGATOIRE
> **Les mesures de biais home (D2) et de calibration menées avant l'investigation de ce mismatch doivent être réinterprétées à la lumière de cette découverte.** L'accuracyEngine évalue la colonne `prediction`, qui n'est PAS la sortie du moteur (97 % de divergence avec `quant.main_pick`). Les M1/M2 futures et le D2 lui-même risquent de mesurer un artefact de pipeline plutôt que le modèle.

### Suites — PRIORITÉ HAUTE (chantier futur, pas seulement « à planifier »)
1. **Fix de séquencement** : `enrichOne` doit retourner `prediction: quant.main_pick` (et `verdict`), ou `server.js:519` doit propager `quant.main_pick` vers la colonne — sinon tout nouvel enrichissement continuera de figer la valeur stalée.
2. **Re-baseline des métriques** après fix (M1/M2 futures sur données propres).
3. Réévaluer le biais home réel une fois la colonne = sortie moteur.

### Périmètre
`penaltyblog_engine.py`, `StatisticalEngine.js`, `enriched_predictions.js`, `server.js`, `database.js`, routes : **aucun changement**. Ce volet est documentaire uniquement.

---

## ÉTAPE 2 — Chantier 4 : FIX APPLIQUÉ — enrichOne écrit TOUS les champs dérivés

**Date** : 2026-08-12 — **Statut** : résolu (commit `bb27b4e`, tag `audit-etape2-chantier4-enrichone-before` avant)

### Le fix
- `core/enrichOne.js` (nouveau module pur, extracté de la closure `server.js`) : le `return` écrit désormais **tous** les champs dérivés — `prediction: quant.main_pick`, `verdict: risk_label`, `risk_label`, `confidence`, `sufficient: true`, `market_scope` (via `core/marketScope.js`), `quant` complet **et** `enriched` (sous-objet incluant `quant`, pour que `updatePredictions` ne laisse plus `enriched.quant.main_pick` stale).
- `server.js` : la fonction locale `enrichOne` est supprimée, remplacée par `require('./core/enrichOne')` (1 hunk isolé via `git add -p` ; le guard JWT_SECRET en attente reste hors commit).
- `scripts/sync_enrichone_columns.js` : one-shot **sync** (pas recalcul — voir ci-dessous) qui aligne colonne `prediction`, `market_scope` sur le pick stocké dans fullData. `--dry-run` par défaut, `--apply` pour écrire.
- `__tests__/chantier4.test.js` : 7 tests (prediction fraîche jamais stale, market_scope par marché : double_chance→`full_time_dc`, first_half O0.5→`first_half`, ou→`full_time_ou`, 1→`full_time_1x2`, enriched synchronisé).

### Résultat (re-mesuré après --apply, 266 matchs actifs)
| Métrique | Avant | Après |
|---|---|---|
| Mismatch colonne `prediction` vs `quant.main_pick` | **251/266 (94 %)** | **0/266** |
| `market_scope` manquant | — | **0** |
| Distribution colonne | 80.5 % « 1 » | 1X 95, O0.5 92, 12 68, X2 10, 1 (×1) |
| market_scope | — | full_time_dc 173, first_half 92, full_time_1x2 1 |

### ⚠️ Point critique — pourquoi le sync ne RECALCULE pas
`enrichOne` lit `m.insufficient_data` comme entrée (dispersion dans `QuantumQuantEngine.analyze`) et l'écrit `m.insufficient_data || 1`. Recalculer = muter l'entrée du run suivant → **oscillation** (ex : `insufficient_data` 0→`12`, 1→`O0.5`). En boucle server ça n'apparaît pas (matches filtrés après enrichissement) mais un one-shot qui re-passe tout doit **geler les valeurs stockées**, pas les re-dériver. Le script sync est donc déterministe et idempotent.

### Impact D2 — RÉINTERPRÉTATION
Le biais home « 81 % de 1 » est **un artefact de pipeline** (colonne déconnectée du moteur), pas un biais modèle. La colonne vaut désormais la sortie moteur (1X/O0.5/12/X2). **Toute re-mesure de calibration/accuracy doit se faire sur cette base propre.** Nota : `accuracyEngine` doit filtrer par `market_scope` avant d'évaluer (chantier séparé) — un pick `first_half` (O0.5) ne peut pas être jugé contre les buts full-time.

---

## ⚠️ POINT DE VIGILANCE — fork `prono` (à ne pas confondre avec `stitch`)

`C:\Users\HAMDI\prono` est un **second dépôt git distinct, toujours actif** :
remote `https://github.com/Hamdovsky/prono.git` (identique à l'`origin` de `stitch`),
historique partagé jusqu'au merge-base `6fefca2`, puis `stitch` a avancé (4 commits d'audit locaux).
Activité observée jusqu'au 11/08 (`.env`, `app.js`, `scripts/*`).

**Conséquence directe** : `scripts/bypass_scraper.py` (et le `sys.path` de `test_bypass_scraper.py`)
étaient désynchronisés — le copy `prono` (33 KB, 10/08) est l'ancienne version pré-rebuild
(mécanisme par pays `_country_betexplorer_slug`), le copy `stitch` (24 KB, rebuild `1cdfb61`)
est la version cible. **Corrigé au Chantier 3** : `sys.path` du test → relatif au repo `stitch`,
jamais `prono`.

Aucune action sur `prono` requise pour l'instant. À ne PAS modifier, ne PAS commiter,
ne PAS fusionner — risque de divergence silencieuse si on édite les deux copies.

---

## ⚠️ Diagnostic — market_scope `unknown` (BLOC 3 re-test, C3P3)

**Fait lors du re-test réseau Bloc 3 (voir ci-dessus) :** 202/262 matchs du slate
actif portent `fullData.market_scope = 'unknown'` dans la colonne `matches.market_type`
(NULL partout via ce chemin) et `enriched.quant` ne contient que 3 clés
(`main_pick`, `ev_score`, `risk_label`) — **sans `markets`**.

**Conclusion : PAS un marché non couvert, artefact de persistance précédant le fix P0.**

- `marketScopeOf(pick, fd.quant.markets)` (objet **top-level**, complet) → **0/266 `unknown`**.
  Tous les picks du slate (`1X`, `O0.5`, `12`, `X2`, `1`) sont couverts par les
  5 marchés définis dans `core/marketScope.js`
  (`match_result`, `over_under`, `double_chance`, `first_half`, `btts`).
- `marketScopeOf(pick, enriched.quant.markets)` → **216/266 `unknown`** car
  `enriched.quant.markets` est présent dans seulement **50/266** lignes.
- Les timestamps `last_updated` des lignes `unknown` (06:35–07:40 UTC) précèdent
  le commit P0 `bb27b4e` (07:43 UTC) → ces écritures proviennent de l'**ancien**
  chemin d'enrichissement, dont `enriched.quant` était tronqué.

**À traiter dans le futur chantier « filtre market_scope accuracyEngine »** :
dériver le scope depuis `fd.quant.markets` (top-level, source fiable) et backfiller
`fullData.market_scope` (exemple : `livescore_1806476`, pick `12` → `full_time_dc`).

---

# AUDIT ROI & CALIBRATION — P1 → P5 (2026-08-24)

Constats initiaux : précision globale 65,8 % (7j)/66,8 % (30j) mais **ROI flat
négatif** (−6,9 %/−8,2 %), 1X2 pur à 40,5 %, backtest 72h « à 37 % », et deux
fichiers dépréciés encore lus par des modules actifs.

## Cause racine n°1 — Sur-confiance systémique (corrigée en P1)

`services/probabilityCalibrator.js/.ts` lisait encore `retro_accuracy_report.json`
(fichier déprécié ÉTAPE 1 : oracle du favori avec look-ahead) et appliquait la
courbe biaisée `EV_OPTIMIZED` + des défauts codés en dur encore pires :
`0.60-0.70 → 0.90`, `0.70-0.80 → 0.99`, `≥0.80 → 1.0`, fallback `×1.15`.
Preuve avant/après (`calibrateProb`) :

| Probabilité brute | AVANT | APRÈS |
|---|---|---|
| 0.65 (bin 60-70) | 0.899 | ≈0.45 (bande 50-60 réelle 42,8 % après normalisation) |
| 0.75 | **0.989** | **0.667** (réel observé bande 70-80 : 66,7 %) |
| 0.85 | **1.000** | **0.643** (réel bande 80-90 : 64,3 %) |

Correctif P1 : source unique = `data/accuracy_report.json`
(`rolling.last30days.calibrationCurve`, snapshot au temps T), bandes avec
n < 30 ignorées, **fallback identité** (plus aucun défaut gonflant, plus de ×1.15).

## P1b — Harmonisation confiance affichée

- `MarketIntelligenceService.applyMarketBoosts` : boost sharp +0.05 arbitraire →
  **+0.02 plafonné**, rattrapage correlation (ancien saut direct jusqu'à +0.20)
  → progression **+0.02 max/appel**, et **log structuré `[MARKET_BOOST]`**
  (sharp_score, master_confidence, avant/après/delta par contribution).
- `promosportIntelligence.js/.ts optimizeGrid()` : la confiance affichée et les
  seuils de pick utilisent désormais les probabilités **calibrées** (`p1Cal/pxCal/p2Cal`
  exposés) et non plus les brutes.
- `src/components/MegaTicket1000.jsx` : **suppression de toutes les probabilités
  et cotes fabriquées** (ex : DNB prob 0.94 hardcodé, DC 0.9, Score Exact 2-1
  prob 0.11…). Chaque sélection est dérivée des vraies probabilités modèle
  (normalisées 1X2 ; combos O/U via `ou_25_prob`) et des cotes réelles quand
  elles existent (sinon fair-value). La composition DIAMOND (garde globalProb
  ≥ 0.78) repose donc sur des chiffres honnêtes.
- Seuils UI codés en dur inventoriés (re-validation différée, cf. Différé) :
  `IntelligenceCard.jsx:65` (Golden ≥88), `MarketTerminal.jsx` (couleurs ≥70/55),
  `TicketDuJour.jsx:310` (filtre ≥75), `DataScienceLab.jsx:49` (>0.85).

## P2 — Boucle backtest → live blindée

`services/autoBacktestService.js` : quand aucun match fini en 72h n'existe en base,
l'ancien code retombait sur 100 matchs **archivés non-snapshot** puis mettait à jour
`league_dynamic_weights.json` ET nourrissait la mesure qui alimente le live.
C'est l'explication du faux « 37 % sur 72h » (`source: archived-fallback`,
méthodologie incompatible avec accuracyEngine). Correctif :
- **poids dynamiques gelés** en fallback (plus d'écriture `league_dynamic_weights.json`),
- rapport marqué `methodology: 'archived-fallback-non-snapshot'` + `provisional: true`
  (chemin normal : `local-db-72h-recorded-predictions`).

## P3 — ROI : échantillon élargi + vue EV-filtrée

Pourquoi 44 paris/1516 : `accuracyEngine` exclut tout pick sans cote exploitable
(`roiExcluded: 1472`) — cause n°1 = cotes manquantes (O/U structurellement sans
cotes archivées + colonnes odds_* vides). Correctifs :
- `recordFromMatches` : fallback sur les cotes figées dans `fullData` quand les
  colonnes sont vides (même logique que historical_matches).
- Nouvelles métriques dans le rapport : `avgOddsWinners` / `avgOddsLosers`
  (global + par marché) — le cœur de l'analyse « pourquoi le ROI est négatif » ;
  `oddsMissingByMarket` (diagnostic des exclusions par marché).
- `roiEvFiltered` : vue alternative ne comptant comme pariables que les picks à
  espérance modèle positive (**p × cote > 1.05**). Kelly volontairement écarté
  tant que calibration non validée sur n ≥ 200 (décision utilisateur : flat stake).

## P4 — Marché 1X2 pur masqué (réversible)

Diagnostic (`scripts/diagnose_1x2.js`, n=1252, sortie `data/diagnosis_1x2.json`) :
- accuracy 1X2 pur **42,2 % < break-even 42,6 %** → verdict : maintien du masquage ;
- pas de biais directionnel majeur (picks 1 : 41,6 %, picks 2 : 43,6 %) ;
- distribution réelle équilibrée (1: 40,2 %, 2: 39,5 %, X: 20,3 %) ;
- **sur-confiance confirmée** : confiance affichée ~74 % vs réel ~42 %.

Implémentation : nouveau module `core/marketPolicy.js` + flag
`DISABLE_PURE_1X2=true` (.env / .env.example). Branché aux 4 points d'écriture
(`database.js insertMatch/updatePredictions`, `pg_database.js idem`) :
'1'→'1X', '2'→'X2', 'X'→côté probable, original conservé dans
`fullData.originalPrediction`. Réactivation : ≥ 42,6 % calibré sur n ≥ 200.

## P5 — Nettoyage fichiers dépréciés

- Renommés avec `_deprecatedNote` explicative : `data/promosport_accuracy_trend.deprecated.json`,
  `data/retro_accuracy_report.deprecated.json`.
- Redirections : `routes/evolution.js` (/api/evolution/accuracy/trend →
  `data/accuracy_trend.json`) ; `scripts/sync_accuracy_git.js` (committe
  `accuracy_trend.json` + `accuracy_report.json`).
- Neutralisés par guard d'exécution (warn + exit 0, n'écrivent plus) :
  `scripts/accuracy_snapshot.js/.ts`, `scripts/retro_accuracy_analysis.js/.ts`.
- Grep final : **zéro référence active** (uniquement commentaires/doc historiques).
- Doc mise à jour : `docs/SCRIPTS_DOCUMENTATION.md`.

## Différé (post-stabilisation)

1. Comparer la courbe JS recalibrée vs Python isotonic (`confidence_engine.py`)
   dès n ≥ 200 post-P1 — vérifier la non-divergence des deux systèmes.
2. Re-valider les seuils UI (liste P1b) sur la nouvelle échelle.
3. Tester 1/4 Kelly en shadow mode parallèle au flat stake, bascule seulement si
   calibration stable et n ≥ 200 paris.
4. Backfiller `fullData.market_scope` (chantier existant, section précédente).

---

# VÉRIFICATIONS DIFFÉRÉES J+0 (2026-08-24) — exécution des points 1-3 du différé

Préambule honnête : **0 échantillons post-P1** en base locale au moment de
l'analyse (déploiement du jour). Analyses menées sur l'échantillon total
(n=2299 évalués avec confiance stockée, majoritairement pré-P1) — conclusions
marquées 🔶 provisoires. Décision : **pas de sonde Neon**, point de contrôle
**J+30** sur base locale.

## 1. Courbe JS vs Python isotonic — divergence majeure, contamination prouvée

**Fait** : `models/isotonic_model.pkl` fitted le **2026-08-23T03:51:31**, cinq
secondes après l'écriture du `backtest_results.json` biaisé (03:51:26,
`source: archived-fallback`, 37 %). Le fit (n=201) a absorbé les brackets
contaminés via `_bracket_aggregates()`.

Échelle native Python (confiance stockée, n=2299) vs sortie iso :

| Bande | n | Réel | Python iso | Écart |
|---|---|---|---|---|
| 50-60 % | 9 | 44,4 % | 32,3 % | −12 pts |
| 60-70 % | 14 | 42,9 % | 36,4 % | −6 pts |
| 70-80 % | 1430 | **53,6 %** | **39,5 %** | **−14 pts** |
| 80-90 % | 583 | **54,7 %** | **46,7 %** | **−8 pts** |
| 90-100 % | 52 | 40,4 % | 50,0 % | +9,6 pts |

Côté JS (proba-pick, rolling 30j accuracyEngine) : 70-80 → **66,7 %**,
80-90 → 64,3 %. Écart JS↔Python jusqu'à **27 pts** (bande 70-80).

Causes : (1) contamination fallback ; (2) périmètres différents (Python =
accuracy_log 1X2 seul ; JS = tous marchés snapshot-T) ; (3) échelles
différentes (confiance stockée ≠ proba du pick) ; (4) warning sklearn
1.8.0 picklé vs runtime 1.9.0.

### Correctifs appliqués

- **V1** — `core/calibration_iso.py::_bracket_aggregates()` : brackets ingérés
  UNIQUEMENT si `methodology === 'local-db-72h-recorded-predictions'` ET
  `provisional === false`. Preuve : appel sur le fichier actuel → **0 bracket**
  + warning `[ISO-CAL] brackets ignorés`. Le cron nocturne fittera proprement
  sur les entrées per-pick 1X2 de `accuracy_log.json` seul.
- **V2-prêt** — nouvelle `_accuracy_report_aggregates()` lisant
  `accuracy_report.json → rolling.last30days.calibrationCurve` (6 bandes
  extraites : mid 35→91,9 % … mid 75→66,7 %, bande 90-100 exclue n<30),
  activable par env `ISO_SOURCE=accuracy_report`. **Non activée — refit
  effectif différé** à n ≥ 200 post-P1 (évite un « isotonic v2 » encore biaisé
  par l'historique pré-P1).

## 2. Seuils UI — mesurés sur l'échelle pré-P1 🔶

| Seuil | n dessus | Précision dessus | Dessous | Verdict / action |
|---|---|---|---|---|
| Golden ≥88 (`IntelligenceCard`) | 123 | **45,5 %** | 54,7 % | 🔴 Inversé → **délabelé immédiatement (V3)** |
| Verte ≥70 (`MarketTerminal`) | 2065 | 53,6 % | 59,4 % | 🟠 Conserver, re-mesurer post-P1 |
| Jaune ≥55 (`MarketTerminal`) | 2081 | 53,5 % | 60,6 % | 🟠 Idem |
| TicketDuJour ≥75 | 1178 | **55,3 %** | 53,1 % | 🟡 Seul discriminant (+2,2 pts) — conserver |
| DataLab >85 | 272 | 52,6 % | 54,4 % | 🔴 Non discriminant — re-mesurer post-P1 |

**V3 appliqué** : `IntelligenceCard.jsx` — suppression de `isGolden`
(`is_confirmed && confidence >= 88`) et de la classe `golden-pick`. Le badge
sélectionnait pire que la moyenne et induisait activement en erreur.
Réactivation possible plus tard sur valeur CALIBRÉE + n minimal, ou via le
pattern MatchCard « réel ≈X% (n) » quand les données bracket atteignent le
composant. Les autres seuils ne sont pas retouchés : ils sont calibrés sur
l'échelle gonflée qui disparaît avec P1 — re-mesure à J+30 avant ajustement.

## 3. Kelly ¼ shadow — test statistiquement vide, verdict structurel

Seuls 13-16 paris simulables (cotes+probs complets, tout historique) :

| Mode | Paris | ROI | Mise moy. | σ mises | Max DD |
|---|---|---|---|---|---|
| Flat EV>1.05 | 13 | −7,62 % | 1u | 0 | 6u |
| Kelly¼ probas brutes | 13 | −7,62 % | 2u (=cap) | 0 | 12u |
| Kelly¼ probas calibrées | 16 | −12,75 % | 2u (=cap) | 0 | 14u |

Enseignement structurel : probas brutes gonflées ⇒ f\* > plafond en permanence
⇒ Kelly¼ **dégénère en flat ×2** (σ=0) et **double le drawdown**.
**Décision : ne pas activer.** Critères de bascule future : n ≥ 200 paris
post-P1 ET courbe de calibration monotone croissante ET `roiEvFiltered`
positif sur 30 j consécutifs. Shadow logging automatisé à câbler à ce stade.

## Point de contrôle J+30 (base locale uniquement)

1. `node scripts/accuracy_report.js` — vérifier que la calibrationCurve est
   monotone croissante sur les bandes peuplées (n ≥ 30).
2. Compter les évalués post-P1 (`ts ≥ 2026-08-24`, cible n ≥ 200).
3. Si OK : activer `ISO_SOURCE=accuracy_report` + refit isotonic sous sklearn
   1.9.0 (purge du pickle 1.8.0), puis re-comparer JS↔Python.
4. Re-mesurer les seuils UI restants (≥70/≥55/≥75/>85) sur l'échelle calibrée.
5. Ré-exécuter la sim Kelly shadow sur les paris post-P1.

---

## Contrôle J+1 post-V1 (2026-08-24, 03h16–04h00 UTC)

### Constat principal : le cron nocturne ne peut pas tirer sans serveur

- Aucun process Node projet actif cette nuit (seuls `omniroute` hors projet).
  La seule tâche planifiée Windows est `Pronos-DataPipeline` (07:00, pipeline
  data Python) — rien ne relance `server.js`. Or `cronSchedules.init()` vit
  dans le serveur : sans lui, ni auto-backtest ni fit isotonic nocturne.
- Démarrage manuel de `node server.js` (04h15 locale) pour contrôle en direct.
- Boot réel : `[SETTLEMENT] Done: 116 settled` (le flux repart) et startup
  auto-backtest à 03:16:58Z → fallback archivé détecté et…
  **`[BACKTEST] Fallback archivé : poids dynamiques et confidenceScorer GELÉS
  (données non-snapshot)`** → preuve en production réelle du garde-fou P2.
- Le cron quotidien est reprogrammé à J+1 quand le boot a lieu après 02:30 UTC
  (`cronSchedules.js:106`) → chaîne exécutée manuellement à l'identique
  (`runAutoBacktest()` + `runIsotonicCalibration()`, équivalent cron).

### Preuve V1 sur passage réel

```
[ISO-CAL] brackets ignorés (source non-snapshot/provisional:
          methodology='archived-fallback-non-snapshot', provisional=True)
[ISO-CAL] Fitted on 196 1X2 samples (log + backtest brackets)
   Brier before=0.2365 -> after=0.1936
```

Le fichier biaisé fraîchement régénéré par le fallback a bien été REFUSÉ.
Fit effectué uniquement sur les entrées per-pick 1X2 d'accuracy_log.json.

### État post-fit (`--check`)

| | AVANT (contaminé, 23/08) | APRÈS (J+1, gardé) | Réel observé |
|---|---|---|---|
| fitted_at | 23/08 03:51:31 | **24/08 03:54:39** | — |
| n_samples | 201 (incl. brackets biaisés) | **196 (per-pick seul)** | — |
| conf 70 % → | 39,5 % | **50,0 %** | ~53,6 % |
| conf 80 % → | 46,7 % | **75,0 %** | ~64,3 % |
| conf 90 % → | 48,4 % | 75,0 % | 40-66 % (n faible) |
| Brier | 0.2239→0.1598 | 0.2365→0.1936 | — |

La carte redevient croissante et se rapproche du réel ; le palier à 75 % sur
les bandes hautes reflète les limites des 196 per-pick pré-P1 (max_conf 81,3 %
— peu de données au-dessus). **ISO_SOURCE=accuracy_report reste NON activé**
(refit V2 différé maintenu jusqu'à n ≥ 200 post-P1).

### Inflow accuracy_log — point de vigilance

- Toujours **196 per-pick 1X2**, dernier timestamp **2026-08-19 13:45Z** :
  les 116 settlements du boot n'ont alimenté aucune entrée 1X2 (marchés
  DC/OU majoritaires dans ce lot ou picks sans probas exploitables).
- Rythme historique : 3→19→34→51/jour (13-16 août) puis quasi-nul.
- Estimation n≥200 NOUVEaux : non calculable au rythme actuel (~0/jour) tant
  que le serveur ne tourne pas en continu. Décision requise (hors audit) :
  service local permanent vs fenêtres planifiées vs reconsidérer la sonde Neon.

### Décisions & suites

1. Serveur de contrôle **arrêté après vérification** (voir ci-dessous).
2. Prochain passage cron réel : prochaine nuit avec serveur actif — la garde
   V1 est désormais prouvée sur les deux chemins (appel unitaire + chaîne complète).
3. Point de contrôle J+30 inchangé (critères : n≥200 post-P1 · courbe monotone ·
   roiEvFiltered positif 30 j).

---

## Option 2 — Fenêtres planifiées Windows (2026-08-24, suite contrôle J+1)

Décision : tester les fenêtres planifiées 5-7 jours avant toute sonde Neon.
Si le compteur per-pick 1X2 reste bloqué à 196 au **2026-08-31** → décision Neon.

### Mise en place

- **Script** : `scripts/server_window.ps1 -Minutes 25` — démarre `node server.js`
  (anti-doublon intégré), laisse tourner 25 min (settlements initiaux à +3 min,
  cycle toutes les 15 min, auto-backtest startup à +30 s), arrêt propre, puis
  fit isotonic **garde V1 incluse** (`calibration_iso.py --fit`).
- **Tâche planifiée** : `Pronos-Fenetres-P1` (Ready) — triggers quotidiens
  **07:10** (juste après `Pronos-DataPipeline` 07h00 → résultats frais réglés)
  et **22:45** (fin des matchs du soir). Timezone machine : UTC+01.

### Test end-to-end du jour (fenêtre 4 min)

- Boot PID 18136 → `[SETTLEMENT] Done: 200 settled` → arrêt propre → fit :
  brackets refusés par la garde (`provisional=True`) + fit sur 196 per-pick,
  Brier 0.2365→0.1936. Logs : `logs/scheduled_windows.log`.
- Compteur inchangé (196, dernier 19/08) : **normal** — les 200 settlements
  étaient des re-settlements idempotents de matchs déjà connus
  (`accuracyStore.appendResult` remplace par match_id). Le compteur ne bougera
  qu'avec de VRAIS nouveaux matchs réglés — objectif exact des fenêtres.

### Procédure de contrôle J+7 (2026-08-31)

1. Compteur : compter les per-pick 1X2 avec timestamp > 24/08 dans
   `data/accuracy_log.json` (byLeague[].[].market==='1X2').
2. `python core/calibration_iso.py --check` — n_samples et probes.
3. `Get-ScheduledTaskInfo Pronos-Fenetres-P1` — LastRunTime/LastTaskResult.
4. Si nouveaux ≈ 0 sur 7 jours → activer la sonde Neon (lecture seule) ou
   service permanent ; sinon poursuivre jusqu'à n≥200 puis basculer
   `ISO_SOURCE=accuracy_report` + refit (V2).

---

# MARCHÉ BTTS — état des lieux & tracking (2026-08-24, audit BT1→BT4)

## État des lieux des 3 marchés supplémentaires du dashboard

| Marché | Pick émis/persisté ? | Résultat réel dispo ? | Précision mesurable ? |
|---|---|---|---|
| **BTTS** | ❌ (proba `matches.btts_prob` seule ; pick dérivé côté frontend) | ✅ dérivable des scores FT | **Oui — baseline dérivée : 50,0 % global · 53,4 % à 65 %+ de confiance (n=726)** |
| But 1ère MT | ❌ heuristique frontend (`MatchRow.jsx` : (O/U+BTTS)/2+5, cap 89 %) | ❌ aucun score mi-temps stocké (0 ligne) | Non — double manque (modèle + data HT). Dépriorisé |
| O/U corners | ⚠️ volant (`routes/matches.js` → `cornersVerdict`, non persisté) | ❌ colonnes corners_home/away jamais renseignées (0 ligne FT) | Non — bloqué par l'absence de source gratuite de corners FT. Dépriorisé |

Autres constats : `accuracy_log.json` ne contient AUCUN pick BTTS
(distribution : DC 2234 · OTHER[=O0.5] 943 · 1X2 196) bien que
`classifyMarket` supporte 'BTTS*' ; `calibration_metrics.json` a un
brierBTTS par ligue mais `_global` repose sur le fallback archivé et des
ligues à n≈2 → non exploitable.

## Correctifs appliqués

- **BT1** — `core/marketPolicy.js::deriveBttsPick()` (source prioritaire
  `quant.markets.btts.YES`, fallback colonne `btts_prob`, seuil ≥50 %),
  persisté en `fullData.btts_pick`/`btts_pick_prob` au temps T aux 4 points
  d'écriture DB (mêmes hooks que P4). Zéro migration SQL.
- **BT2** — `services/accuracyEngine.js` : whitelist étendue
  (**BTTSYES/BTTSNO** après normalisation), `isCorrect` via scores,
  `marketKey→'BTTS'`, filtre `'all'|'btts'`, et **second record par match**
  quand `btts_pick` existe (matches ET historical), avec `pBtts` +
  cotes `odds_btts_yes/no` → ROI flat/calibration/EV-filtre fonctionnent
  pour BTTS comme pour DC/OU/1X2. `byMarket.BTTS` inclut désormais
  avgOddsWinners/Losers.
- **BT3** — masquage UI réversible `VITE_DISABLE_BTTS_DISPLAY=true`
  (.env/.env.example) via nouveau `src/utils/displayPolicy.js`, branché sur
  MatchRow (BOX BTTS → '--'), MatchCard (chip/cellule), MarketTerminal
  (2 blocs + header tableau), EdgePanel (onglet+vue). Inputs internes
  (heuristiques HT/scores exacts) inchangés.
- **Tests** — 4 nouveaux cas Jest (émission second record, BTTS NO incorrect,
  ROI flat @1.85 + filtres, snapshot historical) → suite accuracyEngine :
  **15/15 verts**.

## Baseline historique vs mesure propre (distinction importante)

Les 726 matchs passés ne possèdent pas de `btts_pick` archivé au temps T :
leur précision (50,0 % / 53,4 %) est une **baseline DÉRIVée** (re-pick
post-hoc sur proba stockée), pas la mesure de picks émis. Le tracking propre
démarre au prochain settlement post-BT1. Ne pas confondre les deux séries.

## Critère de réactivation de l'affichage BTTS (double condition, n ≥ 200 picks émis post-BT1)

1. Précision calibrée ≥ **55 %** (bandes peuplées, courbe monotone) ;
2. **Rentabilité réelle croisée** — exactement comme le diagnostic global :
   `byMarket.BTTS.flatRoi > 0` ou `roiEvFiltered > 0`, lus avec
   `avgOddsWinners vs avgOddsLosers`. Une précision ≥55 % avec des cotes
   moyennes défavorables reste perdante (leçon du marché global).
   Caveat : cotes BTTS archivées rares aujourd'hui (n=11 FT) → le croisement
   ROI ne sera significatif qu'après accumulation.

### ⚠️ Incident exécution BT3 (transparence)

L'insertion des imports via une commande shell (`Get-Content -TotalCount N |
Set-Content`) a **tronqué** les 4 composants à leurs seules lignes d'en-tête.
`git checkout -- <fichiers>` a restauré les versions HEAD (fonctionnelles),
et les masquages ont été réappliqués via édition contrôlée. Résiduel : la
version de travail NON commitée de `MatchCard.jsx` (205 lignes vs 159 HEAD)
a été perdue — vérification faite : HEAD contient déjà toutes les features
visibles (parseRow, relBadge, mcc-chips, bttsVerdict) ; il s'agissait donc
d'une variante redondante, mais l'incident justifie un commit rapide du
travail en cours. Leçon retenue : toute réécriture de fichier passe par
l'outil d'édition, jamais par un pipeline shell de troncature.




---

## Phase 1 — Bridge football-data.co.uk (cotes bookmaker gratuites) — 2026-08-24

### Contexte
Gate honnêteté : 92 % des matchs à venir affichent « 🔮 est. modèle » (26/328 avec
vraies cotes, source livescore). Sweep nocturne `[CRON] Odds sweep: 0/549` : cause
racine `_tryFbref` (priorité 1) pendait **30 s timeout par match** avant d'atteindre
les vraies sources — et fbref ne fournit aucune cote bookmaker (stats xG uniquement).

### Changements
1. `services/dataFusionService.js`
   - **fbref retiré** de la chaîne odds (fini le pendeur 30 s/match).
   - **Chaîne réduite aux sources gratuites réellement fonctionnelles** :
     `sofascore` (dormant, kill-switch DISABLE_SOFASCORE) + `scrapeservice`
     (BetExplorer via bypass) + **`footballdata`**. Les stubs d'APIs payantes
     (polymarket, bsd, therundown, apifootball, oddspapi, sportmonks, oddsapiio)
     brûlaient 5 erreurs + cooldown chacun par match sans jamais renvoyer de
     cote → retirés de la chaîne ; `BOOKMAKER_SOURCES` = {footballdata}.
   - **Nouveau bridge FD-Odds** : `_loadFootballData()` indexe les CSV locaux
     `data_pipeline/data/raw/football_data_{fixtures,all}.csv` (refresh 07h00,
     ~10 600 lignes historique + fixtures J-3→J) avec normalisation d'équipes
     (accents + alias `team_aliases.json`), tolérance date ±1 j et inversion
     home/away. `_tryFootballdata(match)` réel remplace le stub : renvoie
     cotes 1X2 + O/U 2.5 (priorité Avg → B365 → PP/SkyBet), timestamps
     secondes→ms corrigés.
2. `services/accuracyEngine.js` — marché O/U alimenté par cotes archivées :
   `pickOdds` gère `O2.5/U2.5` via colonnes `odds_over25/odds_under25`
   (seuil 2.5 uniquement) ; records live/historiques enrichis.
3. `__tests__/accuracyEngine.test.js` — schéma étendu + tests ROI O/U ;
   suite **18/18 verte**.
4. Tâche planifiée `Pronos-DataPipeline` réparée : passait l'argument fantôme
   `--bases` (supprimé lors d'un refactor) → exit 1 quotidien à 07h00 malgré un
   pipeline qui réussissait ; relancée manuellement (5 263 matchs, master OK),
   arguments corrigés.

### Métriques (sonde post-déploiement)
- Enrichissement immédiat : **4/400 matchs à venir** (Fulham-Chelsea,
  Osasuna-Levante, Bologna-Lazio, Roma-Fiorentina — tous avec O/U) —
  football-data ne publie les cotes que J-3→J ; lookup total 0,1 s (CSV local).
- Historique : 10 602 lignes indexées pour le rétro-ROI (roiEvFiltered,
  avgOddsWinners/Losers, byMarket.OU).
- Boot vérifié après cleanup : warnings sources mortes 24 → ~0.

### Limites honnêtes
- Couverture football-data = **Top-5 européens uniquement** ; une partie des
  « ligues » DB est polluée par des noms génériques (« Premier League » =
  Torpedo Zhodino/Biélorussie, « Serie A » = Botafogo/Brésil) qui ne matcheront
  jamais — à corriger côté mapping de ligues si souhaité.
- La couverture large hors Top-5 passe par la **Phase 2 SofascoreBypass**
  (curl_cffi validé en live : search/team-events/event-odds 200, cotes au
  format fractionnel à convertir decimal = 1 + num/den).

---

## Phase 2 — SofascoreBypass (contournement ban) + sentinelle no-data — 2026-08-24

### Changements
1. `scripts/sofascore_bypass.py` (nouveau) — accès API publique Sofascore via
   curl_cffi (fingerprints chrome124/safari17_0/firefox133 en rotation) :
   `resolve` (search team -> /team/{id}/events/{next,last}/0 -> event id,
   matching par contenance normalisée ±7 j) et `odds` (/event/{id}/odds/1/all).
   Décodage : cotes fractionnelles -> décimales (« 9/1 » -> 10.0), 1X2 par
   choix 1/X/2, O/U 2.5 par marchés « Match goals » à `choiceGroup=2.5`
   (les lignes 0.5→10 sont des marchés séparés !), BTTS par marketName.
2. `services/scrapers/SofascoreBypass.js` (nouveau) — wrapper Node :
   spawn venv python (curl_cffi présent dans .venv ET data_pipeline/.venv),
   cache event-id 12 h + cotes 10 min, timeouts 35 s, ne jette jamais.
3. `services/dataFusionService.js`
   - `_trySofascore` réécrit : bypass direct (plus de chemin mort
     oddsService->scraperProxy payant), kill-switch DISABLE_SOFASCORE gardé ;
     « sofascore » ajouté aux BOOKMAKER_SOURCES (agrégat bookmakers réels).
   - **Sentinelle `_odds_no_data`** : une recherche propre sans données
     (équipe absente du CSV/Sofascore) n'est plus comptée comme erreur de
     source -> fini les cooldowns 5 min abusifs qui faisaient rater des
     matchs couverts (90 % des matchs DB = ligues obscures).

### Validation live
- Schalke/Hallescher : resolve -> event 16287064 ; odds 11.0/6.25/1.22 +
  O/U 1.40/2.875 + BTTS 1.95/1.80 (~1,7 s).
- Roma/Fiorentina via fetchOdds complet : sofascore 1.70/3.90/4.75 (bookmaker)
  ; cohérent avec football-data 1.57/3.95/5.76.
- Stack relancée : API ok, **0 cooldown** après sentinelle (vs 6+ avant).
- Sonde 30 prochains matchs DB : **ENRICHIS 10/30 (33 %)**, tous avec
  1X2 + O/U + BTTS, source `betexplorer` (le chantier BetExplorer local
  répond !) — vs **4/400 (1 %)** avant Phases 1+2. Couverture cumulée :
  football-data (Top-5, J-3→J) + BetExplorer (large, y c. ligues exotiques)
  + Sofascore (redondance).

---

## Étape 1 — Politique ligues : désambiguïsation Top-5 par pays — 2026-08-24

### Problème
La source livescore étiquette les matchs par le seul nom local du championnat :
Torpedo Zhodino (Biélorussie) « Premier League », Botafogo (Brésil) « Serie A »,
Kuwait SC « Premier League », etc. → pollution des stats par ligue, routage
XGBoost top-5 erroné pour des matchs non-européens, bruit dans leagues_config.

### Changements
1. `core/leaguePolicy.js` (nouveau) : `GENERIC_TOP5` {Premier League=England,
   LaLiga=Spain, Serie A=Italy, Bundesliga=Germany, Ligue 1=France} ;
   `resolveTrueLeague(league, country)` réétiquette `« {Pays} - {ligue} »`
   quand le pays extrait (fullData.country > category) ne correspond pas au
   pays officiel ; `applyLeaguePolicy(m)` hook non-bloquant.
2. Câblé dans `core/database.js::insertMatch` et `core/pg_database.js::insertMatch`
   (même motif que P4/BT1), log `[LEAGUE_POLICY] id 'ancien' -> 'nouveau' (pays=X)`.

### Réparation one-shot (`scripts/repair_league_names.js`, idempotent)
Scan 27 lignes étiquetées Top-5 → **19 réétiquetées** (Kuwait ×6, Tanzania ×4,
Egypt ×3, Belarus ×2, Kazakhstan/Israel/Ecuador/Brazil ×1), **8 vrais Top-5**
conservés (pays vérifiés England/Spain/Italy). Vérif post-fix : ne restent à
venir sous label Top-5 pur que LaLiga×4 / PL×1 / Serie A×1, tous pays corrects.

---

## Étapes 2+3 — Garde ISO_CAL automatisé + horodatage settled_at — 2026-08-24

### Étape 2 : garde de réactivation isotonique (`scripts/check_iso_gate.js`)
Vérifie les deux critères du plan V2 avant toute activation d'ISO_SOURCE :
- **C1** : n>=200 picks post-fix (cutoff 23/08 20h UTC) avec settle connu
  → **déjà OK : 631** (la DB tourne à haut volume).
- **C2** : courbe de calibration monotone (bandes triées, montée globale,
  aucune chute >3 pts, >=4 bandes n>=30) → **PAS ENCORE** : la fenêtre 30j
  contient encore les données pré-fix contaminées (bande 30-40 % -> 91,9 %,
  bande 90-100 % -> 50 % = courbe inversée typique de la sur-confiance ancienne).
`--activate` bascule .env + relance `calibration_iso.py --fit`
(ISO_SOURCE=accuracy_report) UNIQUEMENT si GO ; sinon simple rapport.
Tâche planifiée hebdomadaire `Pronos-ISO-Gate` (lundi 07:45, log
logs/iso_gate.log) → activation automatique dès que C2 devient vrai.

### Étape 3 : settled_at enfin alimenté
`updateMatchResult` (SQLite + PG) n'écrivait jamais la colonne malgré le
schéma. Fix : `settled_at=Date.now()` posé dès que le score final/status
finished arrive (patch.settled_at prioritaire). Les indicateurs de fraîcheur
de settle deviennent utilisables ; la ligne fd.settled_at existante (sync
fullData) en profite.

---

## Étapes A+B — Gardes de sortie 1X2/BTTS + fixes persistance/settle — 2026-08-24

### A0 : bug de persistance `originalPrediction` corrigé
Le hook P4 tournait (logs `[MARKET_POLICY]`) mais **0 ligne** ne portait
`fullData.originalPrediction` : dans `updatePredictions` (SQLite ET PG),
`fullData` était construit AVANT que le hook ne pose la clé sur `data`.
Fix set-if-absent après hook, deux backends. Le pick BTTS n'était pas
touché (écrit directement dans fullData). Les colonnes `btts_pick*`
n'existent pas en base — le pick vit dans fullData JSON, ce qu'accuracyEngine
lit déjà via son fallback.

### B : settled_at — leçon de pollution assumée
Premier backfill naïf (`scoreHome IS NOT NULL`) a posé settled_at sur les
1037 lignes scheduled (score 0-0 = défaut d'insertion, PAS un résultat).
**Réparé** : remise à NULL des 1037 ; script réécrit avec garde de statut
(`finished/FT` pour matches, proxy archived_at pour historical_matches,
587 lignes légitimement backfillées). `updateMatchResult` (fix précédent)
reste le point d'entrée propre pour les futurs settles.

### A1+A2 : gardes de sortie (`scripts/check_market_gates.js`)
Miroir de l'ISO gate, critères du plan :
- 1X2 pur : >=42,6 % sur n>=200 verdicts ORIGINAUX post-fix settlés -> GO =
  DISABLE_PURE_1X2=false. État : **n=0** (les originalPrediction commencent
  seulement à s'accumuler grâce à A0).
- BTTS : >=55 % ET ROI flat >0 sur n>=200 picks post-fix settlés -> GO =
  VITE_DISABLE_BTTS_DISPLAY=false. État : n=0 en données propres.
Sources bi-tables : matches.settled_at OU historical_matches.archived_at ;
cotes BTTS via colonne ou fallback fullData. `--activate` bascule .env et
redémarre la stack UNIQUEMENT si GO. Tâche hebdo `Pronos-MarketGates`
(lundi 07:50, log logs/market_gates.log).

### Correction honnête ISO gate (C1)
Le « 631/200 OK » précédent comptait des 0-0 non joués. C1 corrigé :
prédiction émise post-fix (timestamp) ET settle réel, bi-tables ->
**55/200, PAS ENCORE**. C2 (courbe monotone) toujours fausse tant que la
fenêtre 30j contient du pré-fix. Activation auto conservée quand tout passera.

---

## Étape A — Statut consolidé + gates en modules importables — 2026-08-24

`scripts/status_audit.js` : un seul rapport pour tout le suivi d'audit —
1) état des 3 gardes (ISO_CAL / 1X2 pur / BTTS, logique **importée** des
scripts de gates sans duplication des critères), 2) couverture cotes à venir
(odds_source renseigné, détail par source), 3) derniers événements politiques
du journal ([MARKET_POLICY], [LEAGUE_POLICY], dernière cote DATAFUSION),
4) dernier résultat + prochaine exécution des 4 tâches planifiées audit.

Refactor associé : `check_iso_gate.js` et `check_market_gates.js` exportent
leurs fonctions (`isoGate`, `gate1x2`, `gateBtts`, …) avec garde
`require.main === module` — comportement CLI inchangé pour les tâches
planifiées. Lecture seule : `status_audit.js` n'active jamais rien.

---

## Gel de la cascade de calibration — 2026-08-24

### Diagnostic (audit précision complet)
Les probabilités traversaient **3 correcteurs empilés entraînés sur l'ère
contaminée** (pré-fix) :
1. **Isotonique Python runtime** (`calibration_iso.isotonic_calibrate` via
   `confidence_engine.py`) appliquée à CHAQUE prédiction. Preuve mesurée :
   (0.55, 0.25, 0.20) -> **(0.32, 0.38, 0.30)** — distorsion massive allant
   jusqu'à inverser le classement des issues !
2. **`services/calibrator.js`** (Top Picks : filtre + EV + Kelly) — courbe PAVA
   construite sur bets/historical contaminés : tout le DC effondré en paliers
   (35 %->63.4 = 65 %->63.4), discrimination détruite.
3. **probabilityCalibrator** (affichage Promosport) — bandes globales inversées
   (35 %->91.9 %).
(`ml_ensemble.py:646` déjà derrière ENABLE_ISO_CALIBRATION=0 — dormant.)

### Fixes
1. **Python** : `ISO_RUNTIME_APPLY=false` court-circuite `isotonic_calibrate`
   (identité) — couvre aussi le fallback caché vers calibrate_probs v54.
   Réactivation UNIQUEMENT par `check_iso_gate.js --activate` (refit propre,
   qui réarme désormais ISO_RUNTIME_APPLY=true lui-même).
2. **Node** : `MARKET_CALIB_IDENTITY=true` (défaut) -> identité tant que
   <150 échantillons propres ; `buildCurve` filtrée définitivement sur
   `h.timestamp >= cutoff-gel` (24/08T19hZ). Leçon validée en probe :
   filtrer sur b.created_at était faux (pari récent -> prédiction ancienne) ;
   AUTO-UNFREEZE intégré quand nClean >= 150. La contamination ne peut plus
   revenir même en forçant le flag.

### Validation
Sondes : Python (0.55,0.25,0.20)->identité avec flag / distorsion sans ;
Node DC75->75, DC55->55, « échantillon propre: 0/150 », flag-off toujours
identité. Jest 18/18. Stack relancée healthy, log live
« [CALIBRATOR] identité imposée ». Flags documentés dans .env.example
(.env local modifié, non commité).

Effet assumé : confiances affichées et Top Picks recalculés sur probas brutes
honnêtes — c'est la condition pour que les gardes reconstruisent des
calibrations fiables quand les données propres suffiront (auto).

---

## Cohérence du gel (couche affichage) + mapping équipes complet — 2026-08-24

### A. probabilityCalibrator gelé lui aussi
Troisième et dernière couche : l'affichage Promosport/MegaTicket utilisait la
courbe globale encore inversée (35 %->91.9 %). Fixes :
- `PROBA_CALIB_IDENTITY=true` (défaut .env) -> identité ; réactivation par
  `check_iso_gate.js --activate` qui réarme désormais les TROIS couches
  (ISO_RUNTIME_APPLY, PROBA_CALIB_IDENTITY) après refit propre.
- **Garde de santé permanente** dans loadCalibration : une courbe non-monotone
  est ignorée (identité + warning) — plus jamais de fou non-monotone même si
  un fichier de rapport se dégrade.
Sonde : 35->35 / 75->75 / 85->85.

### B. Mapping équipes : zéro orphelin, xG 80 % -> **99,7 %**
Le pipeline journalier loguait des dizaines d'« équipe non mappée » (noms
FBref + abréviations football-data.co.uk) -> features Elo/xG ratées pour ces
clubs, V4/XGBoost dégradés. `team_aliases.json` enrichi :
- +2 canoniques initiaux (Saint-Etienne, Hamburger SV) puis +12 clubs promus/
  absents (Sunderland, Racing Santander, Deportivo La Coruna, Levante,
  Real Oviedo, Real Valladolid, Pisa, St Pauli, Holstein Kiel, Le Havre,
  Paris FC, Malaga) — référentiel : 130 canoniques.
- Aliens abréviations vers existants : VfB Stuttgart/RasenBallsport Leipzig/
  FC Cologne/FC Heidenheim/Parma Calcio 1913/Nott'm Forest/Ath Bilbao/
  Ath Madrid/M'gladbach/Darmstadt/Ein Frankfurt/St Etienne/Santander/
  Dep. A Coruna/Oviedo/Valladolid/Le Havre AC.
Résultat pipeline : **0 équipe non mappée**, Elo 100 %, **xG couvert 99,7 %**
(contre 80 % en début d'audit).

---

## Cohérence cutoffs post-gel + visibilité gels — 2026-08-25

- `check_iso_gate.js` / `check_market_gates.js` : cutoff aligné sur le **gel de
  la cascade** (24/08T19hZ) au lieu du fix P4 (23/08T20hZ). Les probas émises
  entre les deux restaient déformées par l'isotonique runtime encore active ->
  les gardes ne doivent compter QUE du post-gel. Compteurs honnêtement repartis
  de ~0 (C1=14, 1X2 n=2, BTTS n=4).
- `status_audit.js` : nouvelle section « GELS CASCADE » (état des 5 flags .env)
  + dernière ligne [CALIBRATOR] dans les événements.

---

## P0 — Audit données + baseline backtestable ✅ (2026-08-25)

Objectif : probabilités réalistes, non-leakées, backtestables, avec gardes de
réactivation automatiques. Aucune donnée/résultat fabriqué. Validateurs + gates
iso/marché codés AVANT d'ajuster le moteur (principe d'audit).

### A. Data Quality (✅ commit c6f6351 + 80eec0b)
- `data_pipeline/data_quality.py` (compute_dq / summarize / write_availability),
  branchement dans `pipeline.py::_rebuild`, `availability.json` généré.
- `data_pipeline/tests/test_data_quality.py` : 6 tests PASS.
- Build réel : 5301 matchs, DQ moyenne 0,996, 8 matchs < 0,8, 2 incohérents.
- Alias `team_aliases.json` enrichi (132 canoniques) : 0 équipe non mappée,
  Elo 100 %, xG couvert 99,7 %.

### B. Moteur walk-forward (✅ commit 97db99e)
- `core/backtest_walkforward.py` : folds mensuels (expanding window), embargo 7j,
  métriques LogLoss/Brier/Acc/ECE, tripwire leakage B0 (corrélation max one-hot
  vs cible > 0,97 -> exclusion auto), persistance immuable `backtest_runs.sqlite`.
- `tests/test_walkforward.py` : 4 tests PASS (embargo, tripwire, run synth,
  poisson). Embargo respecté sur 100 % des folds.

### C/D. Baseline Poisson vs ML (✅ commit 97db99e + docs/BASELINE_EVAL.md)
- `poisson_params` / `poisson_predict` : baseline attaque/défense shrinkée (k=3)
  par ligue, grille scores 0..10, dérive 1X2/OU25/BTTS.
- RUN OFFICIEL (saison 2526, n=1752, 10 folds, embargo OK) :
  - 1X2 : LR 0,882 < RF 0,888 < XGB 0,900 < Poisson 1,006  -> **LR gagnant**
  - OU25 : LR 0,580 < XGB 0,591 < RF 0,602 < Poisson 1,411  -> **LR gagnant**
  - BTTS : RF 0,617 < XGB 0,623 < LR 0,634 < Poisson 0,699  -> **RF gagnant**
- Décisions : LR + RF KEEP ; XGB (features master) ne bat pas LR -> gardé
  conditionnel (re-tester après features enrichies) ; Poisson DROP comme
  prédicteur, GARDÉ comme baseline de contrôle. Dixon-Coles penaltyblog = itér 2
  (non couvert ici ; le MC DC runtime reste inchangé). ECE pré-calibration.

### E. Groundwork lineups/injuries Sofascore (✅ commit ea21796)
- `scripts/sofascore_bypass.py` : cmds `lineups`/`injuries`
  (`/event/{id}/lineups`, `/event/{id}/injuries`) ; parsers `parse_lineups` /
  `parse_injuries` tolérants (validés sur payload réel lineups event 16287064 :
  confirmed, formation 4-4-2, 20 joueurs). Fix encodage stdout UTF-8 + import `re`.
- `services/scrapers/SofascoreBypass.js` : `getLineups` / `getInjuries` (cache).
- `core/database.js` + `core/pg_migrations.js` : table `player_absences`
  (event_id, side, team, player, position, status, detail) + upsert
  `savePlayerAbsences` / `getPlayerAbsences` (SQLite smoke-testé : create+upsert
  +read OK). Feature `absence_impact_pondéré` stockée mais DÉSACTIVÉE du modèle.
- `tests/test_sofascore_lineups.py` : 3 tests PASS (parsers, cas vide).

### Gardes de réactivation (codées en amont, dans .env)
- ISO_REARM_AT, MARKET_REARM_AT, ISO/MC gates : réarmeront les isotoniques/MC
  APRÈS accumulation post-gel, jamais sur données historiques (B2/C2 respectés).

### 9. Ingestion lineups/injuries dans le sweep (✅ commit 876d87f)
- `SofascoreBypass.getAbsencesForMatch(match)` : résout l'event, récupère
  `/event/{id}/injuries`, persiste dans `player_absences` (via `savePlayerAbsences`),
  calcule `absence_impact_pondéré` (pondération poste × sévérité, normalisée /3).
- Hook dans `dataFusionService._trySofascore` (déjà sous kill-switch
  `DISABLE_SOFASCORE`) : impact attaché aux cotes + colonne `matches.absence_impact_pondéré`
  mise à jour (best-effort, try/catch — ne casse jamais la fusion).
- `computeAbsenceImpact` fonction pure testée (4 tests jest PASS).
- **Garde d'honnêteté** : feature stockée mais VOLONTAIREMENT HORS `FEATURE_ALLOWLIST`
  (modèle l'ignore). Les absences passées ne sont pas dans master_dataset
  (events expirés) -> gain backtest impossible sur historique -> activation
  conditionnée à l'accumulation live + re-run walk-forward prouvant le gain.

### 10. Ré-entraînement modèles retenus (✅ commit b9873dd)
- `train_baselines(markets, models, out_dir)` : (ré)entraîne LR/RF sur l'allowlist
  causale (41 features, colonnes cibles/closing/stats in-match exclues -> 0 fuite)
  et exporte `models/baseline_{lr,rf}_{1x2,ou25,btts}.pkl` + `baseline_metadata.json`.
- CLI : `--train` sur `core.backtest_walkforward` régénère les artefacts (idempotent).
  (.pkl ignorés par .gitignore -> artefacts = build reproductible, pas versionnés.)
- Modèles RETENUS (BASELINE_EVAL) : **LR** pour 1X2+O/U2.5, **RF** pour BTTS.
- Re-run walk-forward de CONTRÔLE : chiffres IDENTIQUES à la passe initiale
  (LR 1X2 0,88209 / OU25 0,57971 / RF BTTS 0,61651) -> entraînement reproductible.
- `test_train_baselines_export_et_predict` : export + reload + predict validés (5/5).

### C-suite. Baseline Dixon-Coles (✅ commit d5dd489)
- `dixon_coles_params` / `dixon_coles_predict` : impl. MAISON (penaltyblog absent
  du venv -> scipy L-BFGS-B). Poisson + rho (correction bas-scores 0-0/1-0/0-1/1-1)
  + décroissance temporelle xi=0.0019, par ligue (attack/defense sum-zero).
- RUN OFFICIEL (5 modèles) : DC bat le Poisson naïf sur les 3 marchés mais
  reste au-dessus de LR/RF/XGB :
  - 1X2 : LR 0,882 < RF 0,888 < XGB 0,900 < DC 0,9996 < Poisson 1,006
  - OU25 : LR 0,580 < XGB 0,591 < RF 0,602 < DC 0,692 < Poisson 0,696
  - BTTS : RF 0,617 < XGB 0,623 < LR 0,634 < DC 0,695 < Poisson 0,699
- **BUG corrigé** : extraction O/U2.5 utilisait `triu_indices(G+1,3)` qui oubliait
  des cellules total≥3 (ex. (1,2)) -> Poisson OU25 sur-estimé (1,41). Corrigé par
  masque `i+j>=3` -> 0,696 (cohérent). `BASELINE_EVAL.md` mis à jour (table
  corrigée + ligne DC). `test_dixon_coles_proba_valides` ajouté (6/6 pytest).
- Décision : DC = **baseline classique de référence** (toute évolution du runtime
  doit rester < DC). ML (LR/RF) confortés comme modèles retenus.

### 10-suite. Fallback A/B FastAPI (✅ commit 0e9cde4)
- `core/baseline_fallback.py` : charge `models/baseline_{lr,rf}_{market}.pkl`
  (LR 1X2/OU25, RF BTTS) et prédit pour un match via lookup master_dataset
  (clé ligue+équipes+date). `predict_for_match` renvoie None si match inconnu.
- Hook `_attach_baseline_fallback` dans `prediction_engine.process_prediction` :
  attache `baseline_fallback` au résultat **SEULEMENT si BASELINE_FALLBACK=on**
  (défaut OFF -> zéro impact prod, import paresseux -> zéro risque si module KO).
- Test `tests/test_baseline_fallback.py` : 2 PASS (réel valide sum=1, inconnu None,
  default-off). Smoke : probs 1X2 [0,27/0,37/0,36], OU25 [0,51/0,49], BTTS [0,32/0,68].
- **Limite honnête** : pas de feature store live -> le fallback ne s'active que
  pour les matchs présents dans master_dataset (historique/replay). Matchs futurs
  non archivés -> None (les runtime league codes diffèrent aussi des codes master).
  Activation réelle en prod nécessite le feature store (voir reste).

### Reste à faire (hors P0)
- Activer `absence_impact_pondéré` dans le modèle SEULEMENT après accumulation
  live + backtest walk-forward prouvant un gain (sinon rester désactivé).
- **Feature store** : produire les 41 features allowlist à l'inférence (depuis
  master/agrégats + normalisation ligue runtime->master) pour que le fallback A/B
  s'active sur les matchs live et pas seulement historiques.
- Validation transverse : jest 610/610 PASS, pytest vert (suites P0 + 9 + 10 + DC + fallback).
- AUCUN push Render effectué (déploiement = action manuelle séparée).
