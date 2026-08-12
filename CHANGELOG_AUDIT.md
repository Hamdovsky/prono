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

