# CHANGELOG AUDIT C — fine-relish (Corners/HT/corners storage)

Suivi des correctifs depuis l'audit C (commits `b75a7c4`, `c4cf915`, `22a0ce0`).

---

## C2 — Validation live des marketIds Sofascore + fix Corners ✅ (2026-08-26)

### Cause racine
Le code d'`oddsService.js` (commits c4cf915/22a0ce0) supposait un mapping Sofascore **obsolète** :
- Balayage de **13 marketIds candidats** (18-30) pour Corners → inefficace et faux
- Balayage de **16 marketIds candidats** (2-17) pour HT OU/HT BTTS → **n'existe pas** dans l'API Sofascore 2026

**Validation live** (script `probe_sofa_markets.py`, 3 eventIds réels) a confirmé le mapping stable :

| `marketId` | `marketPeriod` | Contenu |
|---|---|---|
| 1 | Full-time | 1X2 (1/X/2) |
| 3 | 1st half | 1X2 HT (PAS over/under) |
| 5 | Full-time | Both teams to score (Yes/No) |
| 9 | Full-time | Match goals OU, **un bloc par choiceGroup** (0.5, 1.5, 2.5, ...) |
| 17 | Full-time | Asian handicap |
| 20 | Full-time | Total Cards (un bloc par choiceGroup) |
| **21** | Full-time | **Corners 2-Way (un bloc par choiceGroup, ex 9.5 ou 10.5)** |
| 6 | Full-time | First team to score |

**Endpoints HT testés en 404** : `/odds/2/all`, `/odds/3/all`, `/odds/half-time/all`, `/odds/HT/all`, etc. → **HT OU/HT BTTS non disponibles** dans l'API Sofascore gratuite 2026.

### Correctifs appliqués
1. **`src/services/oddsService.js`** (réécrit) :
   - `EXTRA_MARKETS` (16+13 IDs candidats) **supprimé**
   - `getExtraOdds()` (boucle 29 itérations HTTP) **supprimé**
   - `fetchSofaMarket()` / `parseOverUnder()` / `parseDecimal()` : helpers consolidés
   - **Corners** : 1 seul appel au payload existant, `markets.filter(m.id==21)` + choix du `choiceGroup` le plus bas
   - `getLiveOdds` retourne TOUJOURS `ht_over`, `ht_under`, `ht_over15`, `ht_btts = null` (signe honnête, moteur applique la valeur par défaut 1.5)
   - 1 seul `await fetch('/odds/1/all')` au lieu de 30+

2. **Câblage inchangé** dans `core/enriched_predictions.js` (lignes 186-191) — les cotes Corners continuent à atterrir sur `match.odds_corner_*` et `match.corner_line`.

3. **QuantumQuantEngine inchangé** : déjà robuste face aux valeurs `null` (fallback `|| 1.5` sur les HT, `_cornerMarkets` retourne `undefined` si `m.odds_corner_over` falsy).

### Tests
- **`__tests__/oddsServiceCorners.test.js`** (nouveau, 6 tests Jest) :
  1. 1X2 correctement parsé (7/4 → 2.75)
  2. Corners : choix du `choiceGroup` le plus bas (10.5 + 9.5 → 9.5 retenu)
  3. Corners absent → tous les champs `null`
  4. HT fields toujours `null` (documenté)
  5. `matchId=null` → retour `null`, pas de fetch
  6. `CORNERS_MARKET_ID` exporté = 21
- **`test_oddsservice_pure.js`** (pure Node, sans Jest) : 6/6 verts ✅
- Test Jest bloqué par `redis-memory-server` manquant dans `node_modules` du worktree (problème d'environnement, pas du code). À rejouer après `npm install`.

---

## C3 — Stockage HT score + Corners FT/HT via Sofascore /incidents + /statistics ✅

### Trouvailles décisives (validation live)
- **`/event/{id}/incidents`** : 29 incidents avec `homeScore`/`awayScore`/`text`/`incidentType`. L'incident `text=HT` (avec `incidentType=period`) porte le **score à la mi-temps** (ex: Schalke/Hallescher eventId 16287064 : HT = 1-0).
- **`/event/{id}/statistics`** : groupes de stats par période (`ALL`, `1ST`, `2ND`, `ET1`, `ET2`). Le groupe `Match overview` contient l'item `Corner kicks` avec home/away (Schalke/Hallescher : FT = 3-9, 1ère MT = 1-4).

### Correctifs appliqués
1. **`core/database.js`** (migration) : ajout de 4 colonnes idempotentes à `matches` :
   - `ht_score_home INTEGER`
   - `ht_score_away INTEGER`
   - `corners_ht_home INTEGER`
   - `corners_ht_away INTEGER`

2. **`services/sofascoreStatsExtractor.js`** (nouveau, 184 lignes) :
   - `fetchEventStats(eventId)` → `{ht_h, ht_a, c_ft_h, c_ft_a, c_ht_h, c_ht_a}` (tous nullables)
   - `processFinishedMatches(db, {limit})` → itère sur `matches WHERE status='finished' AND ht_score_home IS NULL`, fetche Sofascore, écrit idempotemment
   - **COALESCE** sur `corners_home/away` (n'écrase pas les valeurs déjà présentes par autoArchiver)
   - Rate limit : 220 ms/req (Sofascore : ~5 req/s safe)
   - Gestion d'erreur défensive : pas de crash si Sofascore indisponible, log warning

3. **`services/cronManager.js`** (hook) : 2 crons quotidiens (04:30, 22:30 Africa/Tunis) appellent `processFinishedMatches(limit=200)`. Idempotent, jamais d'écrasement, fail-safe.

4. **`scripts/extract_ht_corners.py`** (équivalent Python standalone) : utilisable en ligne de commande pour les tests (`--event-id 16287064`) ou batch (`--limit 100`).

5. **`scripts/apply_migration.py`** (idempotent) : applique la migration manuellement sur DB existantes.

### Validation live
- **Event 16287064** (Schalke/Hallescher, terminé) :
  - HT score : `1-0` ✅
  - Corners FT : `3-9` ✅
  - Corners HT : `1-4` ✅
- **Event 114** (SC Verl vs Hamburger SV, trop ancien) : Sofascore renvoie 404 → comportement fail-safe, 0 erreur.
- **DB main (39 Mo)** : 105 matchs `finished`, dont 104 ont déjà `corners_home/away` (autoArchiver) et 0 ont `ht_score_home`. Le worker de settlement remplira les HT au fil de l'eau.

### Caveat Sofascore (important)
Sofascore **ne garde pas les eventIds > 1-2 ans** (404 sur event 114). Pour les matchs plus anciens, **les HT scores ne pourront pas être backfillés** par cette voie. Solutions alternatives à explorer (hors scope) : Sofascore autoArchiver local, API-Football (limite 100 req/j), scraper direct BetExplorer.

---

## C4 — recalibrate_served.py (copié depuis main, prêt, inactif) 🔶

**Fichier** : `core/recalibrate_served.py` (copié de la branche main où il avait été écrit pour P4 audit).

Refit isotonic sur `engine_prob_trace.jsonl` jointe aux résultats réels, gated par `SERVED_CALIB_MIN_SAMPLES` (défaut 300). Tant que `n_trace < 300`, le script ne fait rien (no-op safe). Cf. CHANGELOG_AUDIT.md de la branche main pour la documentation complète.

---

## Non-régression
- Pas de fichier de l'audit P0→P3 touché
- `core/QuantumQuantEngine.js` : inchangé, déjà robuste aux `null`
- `core/enriched_predictions.js` : inchangé, câblage existant fonctionne
- Tests existants : non exécutés (worktree sans `node_modules` peuplé), pas de modification de leur surface

## Reste à faire
- Backfill HT scores : en attente de l'accumulation des `finished` récents (worker 2x/jour)
- ROI Corners/HT : en attente de ~200+ picks Corners/HT post-fix pour mesure significative
- Ré-exécuter les tests Jest après `npm install` (le fichier `__tests__/oddsServiceCorners.test.js` est prêt)
- Aucune action sur `prono` (fork voisin distinct)

---

## C5 — Backfill HT/corners depuis football-data.co.uk CSV ✅ (2026-08-26)

### Découverte
`data_pipeline/data/raw/football_data_all.csv` (1.9 Mo, 5301 lignes, 5300 avec HT + corners)
couvre **4 saisons** (23/24, 24/25, 25/26, 26/27) et les **Top-5 ligues européennes** (Angleterre,
Espagne, Italie, Allemagne, France) + Eredivisie. **995 matchs en 2026** (donc récents).

### Pourquoi cette source
- Sofascore 404 sur eventIds > 1-2 ans (limitation API, déjà documenté C3)
- `archive_matches.sofascore_id` n'est PAS un vrai ID Sofascore (valeurs `8xxx`/`207xxx` = autre source)
- football-data.co.uk CSV : hthg/htag/hc/ac explicites, gratuit, 4 saisons historiques

### Correctif appliqué
**`scripts/backfill_ht_corners_from_csv.py`** (nouveau, ~250 lignes) :
- Charge `config/teamAliases.js` (existant) + ajoute ~40 alias football_data (Coventry → Coventry City,
  Nott'm Forest → Nottingham Forest, etc.)
- `normalize(name)` : lowercase, strip accents, retire suffixes City/FC/United/etc., applique aliases
- Index CSV : clé (home_norm, away_norm, date) → {hthg, htag, hc, ac}
- Join avec `historical_matches` (date tolerance ±1 jour)
- **Migration auto** : ajoute 6 colonnes à `historical_matches` si absentes (ht_score_home/away,
  corners_home/away, corners_ht_home/away)
- **COALESCE implicite** : ne lit QUE les lignes où `ht_score_home IS NULL OR corners_home IS NULL`
- Dry-run par défaut, `--apply` pour écrire

### Validation réelle
- **28/3969 matchs backfillés** sur la DB actuelle (0.7% — sain : seules les Top-5 ligues matchent)
- Échantillon : Arsenal-Coventry (HT 2-0, corners 8-2), Sevilla-Rayo (HT 0-1), Atletico-Malaga,
  Marseille-Strasbourg, Hull-Man United, etc.
- DB final : 28 historical_matches avec HT + corners (avant : 0)
- Test dry-run : 9/500 sur 500 premiers (cohérent avec le ratio 0.7%)

### Limite honnête
3085/3969 équipes ne sont pas couvrables par ce CSV (ligues obscures australiennes, asiatiques,
amateur européen). Pour ces matchs, le backfill HT/corners reste **impossible sans autre source**
(API-Football 100 req/j, scraper BetExplorer, ou scraping direct Sofascore live qui ne conserve
que les eventIds récents).

### Impact sur le ROI Corners/HT
Avec 28 nouveaux matchs Top-5 avec HT + corners, l'accuracyEngine peut désormais mesurer la
précision des picks HT/Corners sur ce sous-ensemble. C'est **insuffisant statistiquement** (cible :
200+) mais c'est le point de départ. Le worker 2x/jour (câblé en C3) continuera d'accumuler
pour les matchs récents via Sofascore live.

## État final post-audit C2+C3+C4+C5+C6

| Métrique | Avant C2-C5 | Après |
|---|---|---|
| Corners cotes en live | 0/req (13 IDs faux + 403 transport) | **réelles, 3/3 eventIds validés** (marketId=21 + bypass curl_cffi) |
| HT OU/HT BTTS cotes | inconnu (404 partout) | null honnête (défaut 1.5) |
| Colonnes HT/corners en DB | 0/6 | 6/6 (matches + historical) |
| historical_matches avec HT | 0/3969 | 28/3969 |
| Extraction auto | aucune | cron 2x/jour + script CLI |

---

## C6 — Transport oddsService réparé : fallback curl_cffi + corners LIVE validés ✅ (2026-08-26)

### Constat (test live)
`oddsService.getLiveOdds` retournait **null sur 3/3 eventIds réels en ~150 ms** :
Sofascore renvoie **HTTP 403** au fetch natif Node (fingerprint TLS non navigateur).
Le mapping Corners était correct (C2) mais le transport était mort — et le wrapper
`SofascoreBypass.js` (curl_cffi, Phase 2) n'était pas branché sur ce service.

### Correctifs appliqués
1. **`scripts/sofascore_bypass.py::cmd_odds`** : extraction des CORNERS ajoutée dans
   le MÊME appel `/odds/1/all` (zéro requête supplémentaire) — `marketId == 21`
   (ou marketName contient « corner »), garde la ligne `choiceGroup` la plus BASSE
   (ligne principale), sorties `corner_line/corner_over/corner_under`.
2. **`src/services/oddsService.js`** restructuré :
   - Les échecs du chemin direct sont maintenant des `throw` (les anciens
     `return null` early-return **contournaient le catch** où vivait le fallback —
     bug d'intégration trouvé par le test live) ;
   - Fallback `SofascoreBypass.getOdds(eventId)` (spawn Python curl_cffi,
     fingerprints chrome124/safari17_0/firefox133) normalisé via `_fromBypass()`
     vers le format getLiveOdds (HT toujours null, cf. C2) ;
   - Cache 15 min conservé (les deux chemins l'alimentent).

### Validation LIVE (3/3 verts, après correctif)
| Event | 1X2 | Corners | Latence |
|---|---|---|---|
| 16287064 Schalke/Hallescher | 11 / 6.5 / 1.22 | ligne 10.5 · O 1.909 / U 1.8 | 2.1 s |
| 14023928 Aston Villa/Liverpool | 2.75 / 3.5 / 2.45 | ligne 10.5 · O 2.0 / U 1.727 | 0.9 s |
| 14109920 Rizespor/Beşiktaş | 3 / 3.75 / 2.1 | ligne 9.5 · O 1.833 / U 1.833 | 0.8 s |

(La valeur 14109920 O 1.833 = 5/6 + 1 correspond exactement au payload brut
du probe — chaîne de conversion fraction→décimale vérifiée de bout en bout.)

### Réponse à « est-ce que le corner marche bien ? »
**OUI, désormais, en conditions réelles** : cotes Corners réelles servies au moteur
(`QuantumQuantEngine._cornerMarkets`) via `enriched_predictions` (câblage C existant).
Avant C6 : mapping bon mais 403 systématique → corners jamais servis en prod.
Coût : spawn Python ~0.8–2 s au premier call par match (cache 15 min ensuite) ;
sur Render sans venv Python, `bypass` est null → dégradation propre en null (pas de crash).

---

## C7 — Extracteur HT/corners réparé lui aussi (même 403) + commande `stats` ✅ (2026-08-26)

### Constat (test live)
`sofascoreStatsExtractor.fetchEventStats('16287064')` retournait **tout null en 548 ms** :
le cron HT/corners câblé en C3 utilisait le fetch natif Node → **même HTTP 403** que C6.
Le worker 2x/jour aurait tourné à vide indéfiniment (0 erreur loggée, juste des null).

### Correctifs appliqués
1. **`scripts/sofascore_bypass.py`** : nouvelle commande `stats --event X` — joint
   `/event/{id}/incidents` (score à l'incident `text=HT`) et `/event/{id}/statistics`
   (« Corner kicks » du groupe « Match overview », périodes `ALL` + `1ST`) →
   `{found, ht_h, ht_a, c_ft_h, c_ft_a, c_ht_h, c_ht_a}` (champs partiels possibles,
   erreurs par endpoint dans `incidents_error/statistics_error`).
2. **`services/scrapers/SofascoreBypass.js`** : `getEventStats(eventId)` avec cache 7 j
   (données immuables après FT), export ajouté.
3. **`services/sofascoreStatsExtractor.js`** : `fetchEventStats` passe par le bypass
   EN PRIORITÉ ; chemin direct conservé en fallback (Render sans venv). Parsing local
   `_htScoreFromIncidents/_cornersFromStatistics` inchangé pour ce fallback.

### Validation LIVE
- Python seul : `stats --event 16287064` → `{"found": true, "ht_h":1, "ht_a":0, "c_ft_h":3, "c_ft_a":9, "c_ht_h":1, "c_ht_a":4}`
- Via Node (`fetchEventStats`) : identique, **710 ms** (bypass + caches).
- Régression oddsService re-vérifiée après refactor C6 : **4/4** (direct OK ·
  403→bypass OK · double échec→null OK · matchId null→null OK).

### État transport final (post C6+C7)
| Composant | Avant | Après |
|---|---|---|
| oddsService.getLiveOdds | 403 → null systématique | direct puis bypass → cotes réelles (corners inclus) |
| extractor.fetchEventStats | 403 → tout null | bypass prioritaire → HT + corners réels |
| Cron 2x/jour HT/corners | tournait à vide | fonctionnel (fail-safe si eventId purgé) |

## Prochaines actions (hors scope)
- `npm install` dans le worktree puis lancer les tests Jest (état : bloqué par env)
- Re-run du script de backfill CSV après chaque mise à jour football_data (07h00 quotidien)
- Worker 2x/jour Sofascore tourne en parallèle pour les nouveaux matchs
- Pour augmenter le taux de matching : API-Football (Top-5 + Euro + sud-américaines) ou
  scraper manuel BetExplorer pour les ligues exotiques les plus jouées
