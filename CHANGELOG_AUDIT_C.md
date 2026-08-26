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
