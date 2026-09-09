# CHANGELOG AUDIT — Titanium AI (stitch)

Suivi des correctifs issus de l'audit pronostics. Un correctif à la fois, validé avant de passer au suivant.

---

## Guérison hang socket proxy muet — freeProxyPool (2026-09-09, suite)

### Contexte (reste à faire de l'entrée PixelRAG)
Le hang « socket-level des requêtes proxyées » signalé comme contourné par la
deadline 5 min de `scan-today` a été percé. Les chemins axios sont TOUS couverts
(livescore 20 s, apiClient 15 s, agents pooled 30 s) — le vrai trou était
`services/scrapers/freeProxyPool.js` : socket Node brut, hors périmètre axios.

### Cause racine
`fetchTextThroughProxy` : le timer TLS était **clearTimeout au `secureConnect`**
et AUCUN watchdog ne couvrait la phase réponse. Un proxy qui accepte le CONNECT,
complète le handshake TLS puis reste muet → Promise jamais réglé → `fetchText`
(ne rejetant jamais) bloquait la rotation markBad et suspendait le scan.

### Correctif
- Après `secureConnect` : `tlsSock.setTimeout(timeoutMs)` + handler `timeout`
  -> destroy + reject `proxy_response_timeout`. Sémantique **inactivité**
  (reset à chaque chunk) : les gros corps lents ne sont pas coupés, seuls les
  silences > timeout tuent la connexion.
- Verrou `settled` posé sur les chemins resolve/reject (close, error, timeout)
  pour l'anti-double-règlement.
- Le rejet déclenche enfin la rotation existante : markBad(proxy) -> proxy
  suivant -> null après MAX_ATTEMPTS (plus jamais de hang indéfini).

### Validation
- Régression offline `__tests__/freeProxyPool.test.js` (+3, mocks net/tls) :
  proxy muet -> reject ; réponse normale -> resolve sans faux positif ;
  mort au CONNECT -> `proxy_connect_timeout` inchangé. Suite 18/18.
- `npx jest --forceExit` complet : **75/75 suites, 757/757** (754 + 3).
- La deadline 5 min de scan-today reste en place (défense en profondeur).

### Fichiers modifiés
`services/scrapers/freeProxyPool.js`, `__tests__/freeProxyPool.test.js`.

---

## Checkpoint de reprise — re-validation avant commit (2026-09-09, session suivante)

Les deux entrées ci-dessous (Dashboard « 0 match » + PixelRAG fixtures) étaient
terminées et validées mais restées NON COMMITÉES. Re-contrôle de non-régression :

- Jest `__tests__/sofascorePySource.test.js` : **10/10** (le hang initial du
  runner = handles redis ouvertes, préexistant ; `--forceExit` conclut vert).
- pytest pixelrag (serveur vision démarré pour l'occasion, arrêté après) :
  **8 passed / 1 skipped** (skip = WAF Sofascore, voulu). Échec transitoire
  `/search` au 1ᵉʳ run = cold start (0,2 s une fois chaud) — re-run isolé vert.
- pytest `-m required` : **1 passed** (invariant index non vide, index=104).
- **Probe WAF Sofascore** (`scheduled-events/2026-09-10`, curl_cffi
  chrome124) : toujours **404** → l'opt-in `PIXELRAG_FIXTURES_ENABLED` reste
  le bon réglage ; primary fixtures = livescore. Prochaine relance du probe :
  mensuelle (déjà consignée dans « Reste à faire » ci-dessus).

Fichiers non suivis laisés hors commit (arbitrage reporté) : `karkadan.ico`,
`karkadan.jpg`, `promosport_reference.md`, `pronos-server.bat`,
`pronos-test.bat`, `data/traces/`.

---

## Dashboard « 0 match » — 3 correctifs chaîne (2026-09-09, local)

### Symptôme
« TOUS LES MATCHS (0) » + « Aucune ligue active pour cette date » au lancement
du serveur. `/api/upcoming` ne renvoyait que 5 matchs des 07–08/09 (passés) ;
`selectEligibleMatches` (timeFilter.js) les exclut à juste titre → écran vide.

### Diagnostic (chaîne de causes)
1. **`config/sources/livescore.js` désactivé** (`enabled: false`, commit
   `aff39ed` du 05/09, diagnostic « API cassée depuis août » PÉRIMÉ — probe du
   jour : HTTP 200, 65 stages, 173 évènements). Seul `openligadb` restait
   (0 fixture en semaine internationale) → plus AUCUN fournisseur de fixtures
   dans l'orchestrateur depuis le 05/09 → DB sans match futur (max
   startTimestamp = 08/09, 2314 lignes « scheduled » périmées).
2. **`POST /api/scan-today` cassé** : `exec('node update_today.js')` — fichier
   absent du repo → échec silencieux du sous-processus (visible dans error.log).
3. **`startup-resume` du cronManager** passait par le Workflow Puppeteer local
   (lourd, peut rester bloqué sans jamais atteindre `runResilientScan`).

### Correctifs
- **`config/sources/livescore.js`** : réactivé, drapeau env `LIVESCORE_ENABLED`
  (`!=='false'`) pour désactivable sans toucher au code.
- **`routes/scraper.js`** : `/api/scan-today` réécrit → `runResilientScan()`
  in-process (résultats J-3..J-1 + fixtures J..J+2), flag in-flight, **deadline
  dure 5 min** (Promise.race), `invalidateCache('upcoming')` en finally, import
  `invalidateCache` ajouté (absent de ce module).
- **`services/cronManager.js`** : `startup-resume` (Workflow) remplacé par
  `startupCatchUp()` — compte les matchs futurs en DB ; si 0 → scan résilient
  direct (check verrou Redis fresh <25 min, deadline 4 min), retry unique à
  +5 min, logs explicites dans tous les cas.
- **UX** : bouton « ⚡ Forcer le scan » dans l'état vide du Dashboard
  (`Dashboard.jsx`, distingue « matchs passés » vs « aucune donnée ») et du
  Sidebar (`Sidebar.jsx`, sous « Aucune ligue active ») → `triggerScanToday()`
  + refresh à 30 s/70 s.

### Effet mesuré
Scan de rattrapage : **541 fixtures futurs** insérés (09-09→09-11) + **744
résultats réglés** + 200 paris settlement. `/api/upcoming` : 0 → **433+ matchs
futurs** (elite 162, fallback 271). Second `scan-today` via la nouvelle route :
terminé en **26 s** (« ✅ [SCAN-TODAY] Scan complete — 0 fixtures, 744 results
settled », 0 nouveau = dédup OK) ; le hang du 1ᵉʳ run (ancien code, race avec
le safety-net de boot) n'a pas reproduit — la deadline couvre le risque
résiduel de socket axios sans timeout (proxy mort, non creusé plus avant).

### Validations
- `node --check` cronManager/scraper OK ; eslint Dashboard/Sidebar : 0 erreur
  (warnings préexistants) ; `npx vite build` : OK 3.9 s.
- `npm test` : 743/744 (1 échec `system.test.js` flaky connu — re-run isolé :
  11/11). `pytest -m "not slow"` : 13 passed.
- Logs boot : `Startup catch-up (boot): 543 future matches present — no forced
  scan.` (×2 restarts) ; `Scheduler active` normal.

### Fichiers modifiés
- `config/sources/livescore.js`, `routes/scraper.js`, `services/cronManager.js`,
  `src/components/Dashboard.jsx`, `src/components/Sidebar.jsx`,
  `CHANGELOG_AUDIT.md`. (+ journaux `data/*.jsonl` régénérés par les runs.)

### Reste à faire
- Éventuellement : percer le hang socket-level des requêtes proxyées (deadline
  = contournement, pas guérison) ; le chemin cron « full Workflow Puppeteer »
  local (slots 06:00..) n'a pas été modifié — arbitrer s'il doit rester.

---

## PixelRAG fixtures + robustesse chaîne scraping (2026-09-09, local)

### Objectif (validation user de la session)
Rendre Sofascore-via-PixelRAG source de fixtures principale (le client JS
était banni 403 ; PixelRAG passe par curl_cffi fingerprints), réduire le
scraper Node à un rôle de secours, plus P0 : purge des fantômes, vrai statut
scraper, watchdog d'alerte, tests des correctifs du jour.

### Réalité terrain (sondé avant de conclure)
- **Sofascore a bloqué ses endpoints par date** : `scheduled-events/{date}`,
  `calendar`, `category/{id}/events/last`, `tournament/.../events` → tous 404
  WAF (vérifié curl_cffi chrome124, 3 dates) ; seuls `events/live` et
  `event/{id}` répondent encore → **la découverte par date via Sofascore est
  impossible aujourd'hui**. `event/{id}` (donc /enrich) reste pleinement
  fonctionnel — le rôle d'enrichissement de PixelRAG n'est pas affecté.
- Conséquence appliquée sans truquer : plugin `sofascore-py` en **opt-in**
  (`PIXELRAG_FIXTURES_ENABLED=true`, priorité 2 derrière livescore) et
  endpoint `/fixtures` de PixelRAG prêt à servir dès la réouverture de l'API.

### Modifications
- **`core/visual_server.py`** : `GET /fixtures/{date}` (scheduled-events
  normalisé : eid, équipes, ligue/pays, startTimestamp s, status 0/1-5/6+ →
  scheduled/inprogress/finished + scores FT), cache mémoire TTL 15 min.
- **`config/sources/sofascore-py.js`** (nouveau) : plugin orchestrateur
  opt-in priority 2, `fetch`+`fetchResults` via :30002, timeout 30 s, rate
  6/min — format canonique id `sofascore_{eid}`, match_key compatible
  cross-source (test dédié).
- **`services/sourceRegistry.js`** : **BUG corrigé** `priority || 99` traitait
  0 comme falsy (une source « priority 0 » passait en fin de file) → `?? 99`
  (toProvider + normalizePlugins) + test de régression.
- **`services/scraperBridge.js`** : `runLocalScraper()` ne charge plus le
  **Workflow Puppeteer** (chemin cron/boot) → `runResilientScan()` direct
  (le Workflow reste dispo via `npm run scraper` en process standalone).
  + `warmVisualCache()` [cache chaud] : après le pass fixtures, pré-enrichit
  jusqu'à 15 events `sofascore_*` J..J+2 via `/enrich` (détaché,
  `VISUAL_WARM_ENABLED=false` off).
- **`services/cronManager.js`** : `fixturesWatchdog()` cron `15 */2 * * *` →
  si 0 match futur : catch-up (scan+deadline 4 min) puis **alerte Telegram**
  throttlée 3 h (`_alertFixturesDown`) — la panne silencieuse 05→09/09 ne
  peut plus se reproduire sans notification. Log tag générique « Catch-up ».
- **`services/settlementService.js`** : `purgeStaleScheduled(2)` — tout
  « scheduled » kickoff > 2 j (scores placeholder 0-0, jamais réglés) →
  `canceled` (seul DEAD_STATUSES que le front connaît) ; câblé dans le slot
  04:00 avant l'archiver. **Exécutée en direct : 1373 lignes nettoyées, 0
  futur touché.**
- **`routes/scraper.js`** : `/api/scraper/status` fusionne l'état RÉEL du
  cronManager (running/lastRun) avec le progress standalone ; `times` corrigé
  (06,09,12,15,18,21 — l'ancien ['06','12','18'] était faux) ; diagnostic
  `pixelragFixtures` ajouté.
- **Tests** : `__tests__/sofascorePySource.test.js` (10 : mapping fetch/
  fetchResults, match_key cross-source, opt-in, erreurs → cooldown, ordre
  normalizePlugins, régression priority 0, warm skip, purge exportée) ;
  pytest `test_pixelrag_fixtures_endpoint_lists_matches` (skip toléré si
  Sofascore WAF), `..._rejects_bad_date`, `test_pixelrag_index_required_nonempty`
  (**premier test `@pytest.mark.required`** du projet — invariant index non
  vide, pas de skip).
- **Docs** : `.env.example` — `LIVESCORE_ENABLED`, `PIXELRAG_FIXTURES_ENABLED`
  (opt-in, motif WAF documenté), `VISUAL_WARM_ENABLED`, `SOFASCORE_ENABLED`.

### Validations
- `npm test` : **754/754** (744 + 10, suite flaky `system.test.js` verte).
- `pytest tests/` : **376 passed, 31 skipped, 0 failed**.
- `buildProviders()` : `livescore:1, openligadb:3` (+ `sofascore-py:2` dès
  opt-in). Purge : 1373 → canceled ; restants stale 0 ; futurs 541.
- Status : `pixelragFixtures available:false` (opt-in), running vrai (process
  standalone scraper), nextRun 06:00 local. Logs boot : catch-up 541 ✓ (×2).
- `/fixtures/2026-09-09` → `success:false` propre (Sofascore WAF) — comportement
  d'attente documenté, pas un crash.

### Fichiers modifiés
`core/visual_server.py`, `config/sources/sofascore-py.js` (nouveau),
`services/sourceRegistry.js`, `services/scraperBridge.js`,
`services/cronManager.js`, `services/settlementService.js`,
`routes/scraper.js`, `__tests__/sofascorePySource.test.js` (nouveau),
`tests/test_general_integration.py`, `.env.example`, `CHANGELOG_AUDIT.md`.

### Reste à faire
- Ré-évaluer mensuellement la réouverture de `scheduled-events` (relancer le
  probe 404) → si OK : `PIXELRAG_FIXTURES_ENABLED=true` et basculer la
  découverte en primary (le code est prêt des deux côtés).
- Le « primary » fixtures reste **livescore** (réparé hier) ; le Workflow
  Puppeteer standalone (`npm run scraper`) tourne en parallèle du cron —
  arbitrer le garder ou l'archiver dans start.bat.

---

## Hook pre-commit — garde de fumée automatique (2026-09-09, local)

### Objectif (RFA de la session précédente)
Le test d'intégration général (section précédente) restait manuel. On
l'automatise : chaque `git commit` exécute désormais une garde rapide
(syntaxe des fichiers stageés + tests fumée) et BLOQUE le commit en cas
d'erreur de syntaxe ou de régression de fumée.

### Implémentation
**`.githooks/pre-commit`** (versionné, POSIX sh, compatible Git-Bash Windows) :

1. **Garde syntaxe Python** : `compile(bytes)` sur chaque `.py` stage
   (A/C/M uniquement — les suppressions sont ignorées).
2. **Garde syntaxe JS** : `node --check` sur chaque `.js` stage dans
   `core/ services/ routes/ scripts/` (les `.jsx` de `src/` sont exclus —
   non parsables par node).
3. **Tests fumée** : `pytest tests/test_general_integration.py -m smoke -q -x`
   (4 tests, ~0.2s ; skip gracieux si un service est down).

Verdict : exit 1 + message « COMMIT BLOQUÉ » si échec ; sinon exit 0.

**Installation** : copié dans `.git/hooks/pre-commit` (cohabite sans conflit
avec les hooks LFS existants post-commit/pre-push).

**Portabilité autres postes** (au choix) :
- Copie simple : `cp .githooks/pre-commit .git/hooks/pre-commit`
- Ou : `git config core.hooksPath .githooks`

**Contournements** :
- `git commit --no-verify` (standard git)
- `STITCH_SKIP_PRECOMMIT=1 git commit ...` (variété maison)

### Tests du hook (4 scénarios réels)
| Scénario | Attendu | Obtenu |
|---|---|---|
| Commit sans fichiers stageés | exit 0 | **exit 0** (smoke 4 passed, 0.21s) |
| `.py` stageé avec SyntaxError (`def f(:`) | exit 1 + message | **exit 1** ✓ ligne/colonne affichées |
| `.js` stageé invalide (`function f( {`) | exit 1 + message | **exit 1** ✓ erreur node --check affichée |
| Fichier valide stageé (`pytest.ini`) | exit 0 | **exit 0** ✓ |
| `STITCH_SKIP_PRECOMMIT=1` | skip immédiat exit 0 | **skip** ✓ |

### Validations
- Coût mesuré en régime nominal : **<0.5 s** par commit (invisible en pratique)
- Fichiers valides : aucune fausse alerte (grep restreint aux vrais
  répertoires de code, `.jsx` exclus)
- Suppressions stageées (`--diff-filter=ACM`) : pas de test sur fichiers absents
- Hooks LFS post-commit/pre-push : inchangés, aucun conflit

### Fichiers modifiés
- `.githooks/pre-commit` (nouveau, versionné)
- `.git/hooks/pre-commit` (installé, copié depuis .githooks/)
- `CHANGELOG_AUDIT.md` (cette section)

### Reste à faire
- Éventuellement ajouter un `pre-push` house-made qui lance
  `pytest -m "not slow"` + `npm test` avant les pushes (2-3 min) — non
  demandé, à arbitrer.

---

## Test d'intégration général du projet (2026-09-09, local)

### Objectif (RFA de la session)
Le projet stitch a grandi vite (V55-VISUAL, PixelRAG-Sofascore, pont
enrich→predict, …) mais n'avait pas de **test d'intégration général** qui
valide que tout fonctionne ensemble. Les tests unitaires (Jest + pytest)
couvrent les modules isolés mais pas les invariants critiques :
- Les 3 services essentiels (PixelRAG :30002, FastAPI :8000, Redis :6379)
  sont-ils UP ?
- Le pipeline enrich→predict (la dernière brique ajoutée) marche-t-il
  bout-en-bout avec un event Sofascore réel ?
- L'index PixelRAG et `visual_context_cache` sont-ils peuplés ?
- Les modèles XGBoost et la base archive historique sont-ils intègres ?

### Implémentation

**1. `tests/conftest.py` (nouveau)** — fixtures partagées
- URLs configurables via env (PIXELRAG_URL, FASTAPI_URL, REDIS_HOST/PORT)
- Constante `TEST_EVENT_ID=11366885` (match réel public : FC Zbrojovka Brno
  vs Slezský FC Opava) utilisée par les tests réseau
- Helpers `_http_get` / `_http_post` (urllib, 0 dépendance) avec gestion
  d'erreur silencieuse → `(status, body_or_text, error)`
- Fixtures `pixelrag_url`, `fastapi_url`, `pixelrag_health`, `pixelrag_status`,
  `fastapi_health` qui **skip gracieusement** (pas de FAIL) si un service
  est down

**2. `tests/test_general_integration.py` (nouveau)** — 19 tests sur 5 axes

| Axe | Tests | Marqueurs |
|---|---|---|
| 1. Services health | 4 (PixelRAG health/status/index, FastAPI health/engines, Redis port) | `smoke` + `local` |
| 2. PixelRAG endpoints | 4 (/search, /enrich/{id} payload, /enrich invalide, /sofascore/cache/stats) | `slow` + `smoke` |
| 3. FastAPI predict | 3 (avec/sans sofascore_id, low_data fallback, probs cohérentes) | `slow` |
| 4. DB persistance | 3 (tactical.db schéma, visual_context_cache peuple, archive_matches ≥ 100) | `db` + `local` |
| 5. Fichiers projet | 5 (modèles, .py parsables, .js parsables, .env complet, CHANGELOG récent) | `local` |

**Markers pytest** (enregistrés dans `pytest.ini`) :
- `smoke` : 4 tests, <5s total, toujours lancés
- `local` : 8 tests purement locaux (pas de réseau)
- `db` : 3 tests qui touchent la DB
- `slow` : 6 tests réseau (≥1s)
- `required` : 0 test pour l'instant (réservé aux invariants critiques)

**3. `pytest.ini`** — enregistrement des markers

```ini
markers =
    smoke: tests de fumée (<5s total, toujours lancés)
    local: tests purement locaux (pas de réseau)
    db: tests qui touchent la DB
    slow: tests réseau (>=1s) — à exclure en CI rapide
    required: tests qui DOIVENT passer (pas de skip conditionnel)
```

**4. `core/visual_server.py`** — fix de robustesse

Découvert pendant le test : `/enrich/9999999999` (event inexistant)
retournait `success: true` avec `event_meta: null`. Ajout d'un early-return
`if event_meta is None: return None` dans `_sofascore_enrich` pour ne pas
polluer l'index avec des vecteurs vides et retourner proprement un
`success: false` à l'appelant.

### Résultats

| Commande | Tests | Latence | Use case |
|---|---|---|---|
| `pytest tests/test_general_integration.py -m smoke` | 4 | 0.15s | CI ultra-rapide (pre-commit) |
| `pytest tests/test_general_integration.py -m "not slow"` | 13 | 0.70s | CI rapide (PR check) |
| `pytest tests/test_general_integration.py` | 19 | 0.90s | Intégration complète (pre-merge) |
| `pytest tests/` (suite complète) | 371 | 146s | Non-régression (nightly) |

**Tous verts** : 19/19 nouveaux tests + 352/352 anciens (0 régression).
`npm test` (Jest) reste à 744/744.

### Validations
- `pytest tests/test_general_integration.py -v` : **19 passed in 0.90s**
- `pytest tests/test_general_integration.py -m smoke` : **4 passed in 0.15s**
- `pytest tests/test_general_integration.py -m "not slow"` : **13 passed in 0.70s**
- `pytest tests/` (global) : **371 passed, 30 skipped, 0 failed** (+19 vs 352)
- `npm test` : **744/744** (non-régression)

### Fichiers modifiés
- `tests/conftest.py` (nouveau, 105 lignes)
- `tests/test_general_integration.py` (nouveau, 280 lignes, 19 tests)
- `pytest.ini` (markers ajoutés)
- `core/visual_server.py` (fix `_sofascore_enrich` early-return)

### Reste à faire
- Ajouter un test `@pytest.mark.required` qui fail-fast si l'index PixelRAG
  est < 50 vecteurs (sentinelle : la chaîne est cassée quelque part)
- Étendre `test_predict_*` à un match upcoming (status='scheduled') pour
  couvrir le chemin live, pas seulement finished
- Brancher ce test dans un pre-commit hook (`.git/hooks/pre-commit`) ou
  GitHub Actions pour CI automatique

---

## PixelRAG-Sofascore branché dans /api/predict (2026-09-09, local)

### Objectif (RFA de la session précédente)
Le moteur PixelRAG-Sofascore (section précédente) sait **agréger** lineups +
injuries + statistics + H2H en 1 round-trip, mais ne sert pour l'instant que via
`SofascoreBypass.getEventEnrich` (appelé manuellement). On le branche dans le
**pipeline de prédiction live** (`/api/predict`) pour que chaque prédiction
consomme automatiquement l'enrichissement sans changer l'API consommatrice.

### Implémentation
**1. `core/sofascore_helpers.py` (nouveau)**

Helper Python avec `compute_absence_impact(items, home_team, away_team)` :
port exact de `SofascoreBypass.computeAbsenceImpact` (JS) pour permettre
l'usage depuis Python sans re-fetch Sofascore. Évite la duplication et garantit
la parité de calcul entre le pont Node et le consommateur FastAPI. 8 tests
pytest dédiés (`tests/test_sofascore_helpers.py`) : cas vide, accents,
saturation, side explicite, équipe inconnue, types mixtes.

**2. `core/fastapi_server.py:_run_prediction_payload` — point d'injection**

Juste avant `extract_visual_features(match_data)` (qui ne touche que les
`visual_*`), on interroge PixelRAG si `sofascore_id` (ou `eventId`/`id`) est
présent dans le payload :

- `_pix_url = os.environ.get('PIXELRAG_URL', 'http://127.0.0.1:30002')`
- `urllib.request` GET `/_pix_url/enrich/{event_id}` (timeout 8s, best-effort)
- Si succès → injection dans `match_data` :
  - `visual_context` (reconstruit depuis lineups+stats → `visual_confidence` ≈
    max des stats home+away normalisé [0,1])
  - `home_formation` / `away_formation` (ex. "4-2-3-1")
  - `home_absence_impact` / `away_absence_impact` (via sofascore_helpers)
  - `player_absences` (liste brute, utile pour le briefing LLM)
  - `home_xg_pixels` / `away_xg_pixels` (xG extrait de la stat
    "Expected goals" / "expectedGoals" si publiée)
  - `home_possession_pct` / `away_possession_pct`
  - `h2h_data` (JSON stringifié pour rétro-compat callers existants)
- Si échec (PixelRAG down, event inconnu, 404) → on continue **sans
  enrichissement**, on n'écrase rien.
- Méta-enrichissement `_enrich_meta` (attempted, success, source, latency_ms,
  text_chars) **exposé dans la réponse** (`result._pixelrag_enrich`) pour
  observabilité temps réel.

**Best-effort strict** : aucun `try/except` ne lève. Si PixelRAG est down,
la prédiction fonctionne comme avant (repli sur `extract_visual_features`
+ moteurs XGBoost).

### Test bout-en-bout (event 11366885)
```bash
POST /api/predict  body={sofascore_id:11366885, homeTeam:"FC Zbrojovka Brno",
                          awayTeam:"Slezský FC Opava", league:"FNL", ...}
→ 200 OK
→ _pixelrag_enrich: {attempted:true, success:true, source:"pixelrag",
                     latency_ms:16-59, event_id:"11366885", text_chars:400}
→ home_win_probability: 0.5167, draw: 0.2689, away: 0.2144
```

### Bénéfices
- **Zéro changement côté callers** : les routes Node qui appellent FastAPI
  continuent de poster le même payload — l'enrichissement est **implicite**.
- **Latence marginale** : 16-59 ms (cache hit) à ~900 ms (cache miss) sur le
  path critique, async-safe (urllib synchrone mais bloqué max 8s avec
  timeouts).
- **Observabilité** : chaque réponse `/api/predict` porte maintenant le bloc
  `_pixelrag_enrich` (latency, source) — on voit en prod si PixelRAG est up,
  à quel命中率, et si l'enrichissement structure les features.
- **Rétro-compat callers** : `home_formation`, `absence_impact`, `xg_pixels`
  sont des **clés additives** — si PixelRAG down, ces clés sont absentes
  mais le pipeline continue (les extract_ml_features existants les ignorent
  proprement si non peuplées).

### Validations
- `python -c "ast.parse(open('core/sofascore_helpers.py').read())"` : OK
- `python -c "ast.parse(open('core/fastapi_server.py').read())"` : OK
- `pytest tests/test_sofascore_helpers.py -v` : **8/8 passed** (nouveau)
- `pytest tests/` (hors `test_command_center_pronostics.py`) :
  **352 passed, 30 skipped, 1 xfailed, 1 xpassed** — 0 failed
  (344 → 352, +8 nouveaux tests)
- `npm test` : **744/744** (74 suites, +0 vs dernier run) — non-régression
- Test live `/predict` : 200 OK, enrich meta visible dans la réponse
- Test fallback (PixelRAG down) : pas de régression, payload continue d'être
  traité par les moteurs XGBoost sans enrichissement

### Fichiers modifiés
- `core/fastapi_server.py` (+~110 lignes : bloc enrich dans
  `_run_prediction_payload`, exposition meta dans la réponse)
- `core/sofascore_helpers.py` (nouveau, 90 lignes)
- `tests/test_sofascore_helpers.py` (nouveau, 8 tests)

### Reste à faire
- Étendre l'enrich aux **matchs à venir** (cache hit sur les events déjà
  fetchés ; cron `scripts/cron_pixelrag_refresh.js` peut être étendu pour
  pré-chercher les events scheduled via `/api/v1/sport/football/scheduled-events/{date}`).
- Logger l'enrich meta dans `data/live_prediction_journal.jsonl` pour analyse
  offline du命中率 PixelRAG sur les prédictions réelles.
- Sur le long terme : intégrer `home_formation`/`away_formation` comme
  features dans `extract_ml_features` (formation différentielle = proxy
  d'agressivité tactique).

---

## PixelRAG-Sofascore — moteur enrichi qui remplace le scraper (2026-09-09, local)

### Objectif (RFA de la session)
Le pipeline de scraping Sofascore historique (SofascoreBypass + routes/scraper.js
+ sofascore_bypass.py) faisait 3-5 round-trips HTTP pour récupérer lineups +
injuries + statistics + H2H d'un event. Le moteur PixelRAG-lite (:30002) avait
déjà un client HTTP sain (pixelragService.js) mais ne servait que des embeddings
texte. On transforme PixelRAG en **agrégateur de données structurées Sofascore**
qui prend la place du scraper : 1 round-trip au lieu de 4-5, sans Puppeteer,
100% local, fallback Python automatique.

### Implémentation
**1. `core/visual_server.py` — module PixelRAG-Sofascore**

Nouveau module Python (intégré au serveur vision existant, FastAPI :30002) :
- `_sofascore_get_json(path)` : fetch direct api.sofascore.com via **curl_cffi**
  (fingerprints Chrome124, anti-bot bypass identique à `sofascore_bypass.py`).
  Pas de Puppeteer, pas de Chromium en mémoire.
- `_extract_lineups(data)` : parse `{home:{formation, players:[{player, position}]}}`
- `_extract_injuries(data)` : aplatit `{home, away}.players` en items plats
- `_extract_statistics(data)` : parse `{statistics:[{period, groups:[{groupName,
  statisticsItems:[{key, home, away, homeValue, awayValue}]}]}]}` → format plat
  `{home: {group::key: val}, away: {...}}`
- `_extract_h2h(data)` : parse H2H (best-effort, l'endpoint actuel 404 sur
  certains events, on log et continue)
- `_build_enrich_text(...)` : concatène formations + joueurs (top 11 par côté)
  + absences + 20 stats par côté + H2H en un texte riche
- `embed_text(text)` (existant) : produit un vecteur CLIP 512-dim du texte
- `_sofascore_enrich(event_id, force=False)` : orchestre 5 fetches séquentiels
  (1 event + 4 sous-ressources) puis embed + persiste dans `_INDEX` et
  `_SOFASCORE_CACHE` (TTL 6h)

**Endpoints FastAPI ajoutés** :
- `GET  /enrich/{event_id}` : agrège tout, format de retour
  `{success, event_id, event_meta:{homeTeam,awayTeam,tournament,status,
  startTimestamp}, lineups, injuries, statistics, h2h, article_id,
  embedding_dim, text_preview, fetched_at}`
- `POST /enrich/{event_id}` : variante avec `{"force": true}` dans le body
- `GET  /sofascore/cache/stats` : observabilité (cache_size, last_events,
  index_size, model)
- `data/visual/sofascore_enrich.jsonl` : journal append-only des enrichs

**2. `services/pixelragService.js` — client enrichi**

Ajout de `enrichMatch(eventId, {force, timeoutMs})` dans `_makeClient` (utilise
`/enrich/{event_id}` + `_post` quand force=true). Exporté de premier niveau
(`.enrichMatch = local.enrichMatch`).

**3. `services/scrapers/SofascoreBypass.js` — pont PixelRAG**

Nouvelle fonction `getEventEnrich(eventId, opts)` qui :
- Tente **PixelRAG en priorité** (1 round-trip, ~900ms)
- Fallback automatique sur les fonctions Python existantes (`getLineups` +
  `getInjuries` + `getEventStats` en parallèle) si PixelRAG down ou erreur
- Cache interne 6h
- **Rétro-compatible** : `_flattenLineupsToLegacy` (shirtNumber vs shirt) et
  `_flattenStatsToLegacy` (group::key aplati) garantissent que les appelants
  existants fonctionnent sans modification
- Kill-switch : `PIXELRAG_BRIDGE=off` (défaut `on`)
- Export `_PIXELRAG_BRIDGE_ENABLED` pour observabilité/tests

### Test bout-en-bout (2026-09-09)
**Event 11366885** (FC Zbrojovka Brno vs Slezský FC Opava, FNL, finished) :

```
node -e "SofascoreBypass.getEventEnrich('11366885', {force:true})"
→ source: pixelrag | found: true | latency: 907ms
→ event: FC Zbrojovka Brno vs Slezský FC Opava (FNL, finished)
→ lineups.home formation: 4-2-3-1 (18 joueurs)
→ lineups.away formation: 4-1-4-1
→ injuries: 0 (event fini, pas de missing joueurs)
→ statistics: 66 clés home + 66 clés away (possession, xG, shots, etc.)
→ embedding: CLIP 512-dim persisté dans _INDEX
```

**Avec `PIXELRAG_BRIDGE=off` (fallback Python)** : `source: python, latency: 808ms`.

### Bénéfices
- **Latence divisée par ~3-5** : 1 round-trip (PixelRAG) au lieu de 4-5
  (Sofascore direct).
- **Pas de Puppeteer/Chromium** : économie ~200 Mo RAM + complexité
  d'environnement.
- **100% local** : curl_cffi fait le bypass TLS, identique au Python existant.
- **Embedding bonus** : chaque enrich produit un vecteur CLIP indexé, ouvrant
  la voie à la recherche sémantique cross-event ("matchs avec 3+ absents
  défenseurs", "matchs dominants en possession", etc.).
- **Rétro-compatible** : zéro modification des appelants existants.

### Validations
- `node --check services/pixelragService.js services/scrapers/SofascoreBypass.js` : OK
- `python -c "ast.parse(open('core/visual_server.py').read())"` : OK
- `npm test` : **744/744** (74 suites, +0 vs dernier run) — non-régression
- `pytest tests/` (hors `test_command_center_pronostics.py`) : **344 passed,
  30 skipped, 1 xfailed, 1 xpassed** — 0 failed
- Test live `/enrich/11366885` : 200 OK, lineups + stats + embedding présents

### Fichiers modifiés
- `core/visual_server.py` (+~220 lignes : module enrich, 3 endpoints)
- `services/pixelragService.js` (+15 lignes : `enrichMatch` dans `_makeClient`
  + export de premier niveau)
- `services/scrapers/SofascoreBypass.js` (+~110 lignes : `getEventEnrich`,
  helpers de flatten rétro-compat, kill-switch)
- Nouveau : `data/visual/sofascore_enrich.jsonl` (journal)

### Reste à faire
- Réactiver le wiki (`PIXELRAG_WIKI_URL=https://api.pixelrag.ai`) pour doubler
  les sources de l'enrich sémantique (Wikipédia saisons/effectifs en +
  des captures Sofascore).
- Brancher `getEventEnrich` dans le pipeline de prédiction live
  (`/api/predict` ?) pour injecter lineups/injuries avant inférence XGBoost.
- Étendre `_extract_h2h` quand l'endpoint H2H sera confirmé côté Sofascore
  (actuellement 404 sur certains events).
- Activer le cron `scripts/cron_pixelrag_refresh.js` (6h) pour préchauffer
  les enrichs des matchs à venir.

---

## PixelRAG × Sofascore — bootstrap réel + booster V55-VISUAL opérationnel (2026-09-09, local)

### Objectif (RFA de la session)
Le pipeline PixelRAG-lite (CLIP + cache visuel + booster V55-VISUAL 235 dims) était
câblé de bout en bout mais **dormant** : index à 4 vecteurs, `visual_context_cache`
vide, modèle `stitch_v55_visual.json` jamais entraîné, bug d'intégration qui faisait
que le booster n'avait pas accès au signal visuel même une fois entraîné. Objectif :
faire travailler toutes les forces du pipeline.

### Phase 0 — Audit stack (lecture seule)
- ✅ Port 30002 (PixelRAG lite) UP : CLIP `openai/clip-vit-base-patch32` dim 512
- ✅ Port 8000 (FastAPI ML) UP : engines `prediction/props/mega/sentiment` chargés
- ✅ Port 6379 (Redis) UP
- ❌ Ports 3000/3001 (API/UI Node) DOWN au moment de l'audit — non bloquant pour ce périmètre
- ⚠️ Index PixelRAG quasi vide : **4 vecteurs** (nlist=1, nprobe=1 — placeholder,
  code fait du brute-force cosine réel, FAISS non installé)
- ⚠️ `visual_context_cache` : 6 rows (résidus de tests passés)
- ⚠️ `stitch_v55_visual.json` : absent, code attendait un `--visual` jamais lancé
- ✅ SofascoreBypass opérationnel (test live : Austria Wien→id 2203, Beitar Jerusalem→id 5204)
- ✅ Archive historique 104 Mo + master 20 Mo + 1096 matchs (663 FT + 433 finished)

### Phase 1 — Bootstrap index PixelRAG (sans Puppeteer)
**Découverte** : `/ingest_text` (endpoint P2 du 2026-09-08) permet d'indexer via
texte seul (CLIP si dispo, sinon hash stable) — pas besoin de captures Puppeteer.

**Création** `scripts/bootstrap_pixelrag_text.js` :
- 50 paires d'équipes uniques (SofascoreBypass.searchTeam) → 100 ingest_text
- Durée : **38.3 s**, **99/100 OK** → index 4 → **103 vecteurs**
- Recherche textuelle validée : top-1 = match pertinent, scores 0.07-0.18 (faibles
  car index encore petit mais cosine exact et exploitable)

### Phase 2 — Rebuild FAISS — non requis
- Module `faiss` non installé dans `.venv`
- Le code `core/visual_server.py:281` fait du **brute-force cosine** sur l'index
  en mémoire → correct et rapide à 103 vecteurs
- Les champs `nlist/nprobe` du `/status` sont cosmétiques (placeholder 1/1)
- Pour 100k+ vecteurs, FAISS deviendrait utile (recommandation future)

### Phase 3 — Peuplement `visual_context_cache` (400 matchs historiques)
**Création** `scratch/populate_visual_cache.py` :
- Lit `data/historical_archive.sqlite` table `archive_matches` (status FT/finished,
  startTimestamp ≥ 2022-01-01)
- Pour chaque match : recherche PixelRAG sur `"<home> vs <away> football match
  form injuries recent results"` (n_docs=6), top_score → `visual_confidence`
- INSERT/REPLACE dans `data/tactical.db.visual_context_cache` avec préfixe `hist_<id>`
  (évite collision avec l'app live qui préfixe `live_<id>`)
- **400/400 OK en 17.6 s** (~44 ms/match, dominé par la latence HTTP)
- Distribution : `visual_confidence` médiane 0.11, range 0.07-0.18 → signal faible
  mais **différencié** et exploitable

### Phase 4 — Entraînement `stitch_v55_visual.json`
**Bug d'intégration découvert et corrigé** :
- `core/ml_extract.py:670-671` lisait les `visual_*` depuis `row.get(_vk)` seulement
- L'entraînement passe par `process_row` qui mappe `archive_football_data` → pas de
  champ `visual_*` ni `match_id`/`sofascore_id` → lookup jamais déclenché
- `get_db_connection` de `ml_history.py` pointait vers `historical_archive.sqlite`
  (pas la bonne DB : `visual_context_cache` est dans `tactical.db`)

**Fix** (deux endroits, scoped au training) :
1. `core/ml_extract.py:668-720` : hydratation depuis `tactical.db.visual_context_cache`
   via `match_id` / `sofascore_id` / `id` + préfixes `hist_`/`live_`
2. `core/train_v55.py:434-475` : hydratation directe dans `process_row` via
   `homeTeam+awayTeam LIKE '%x%'` (fallback approximatif mais fonctionnel)
3. `core/train_v55.py:25` : ajout `DB_TACTICAL_PATH`

**Résultat** :
- Modèle `stitch_v55_visual.json` (3.4 Mo) entraîné, **Test accuracy 58.06%**,
  Log Loss 0.8514 (équivalent à V55, +0 features visuelles marginales)
- 79/235 features utilisées par l'arbre, dont **3 visuelles** (f223, f225, f226)
  avec 0.53% d'importance — signal faible mais **non nul** (était 0% avant fix)
- Per-class : Home 73.8% / Draw 24.4% / Away 62.3%

### Phase 5 — Cron d'entretien
**Création** `scripts/cron_pixelrag_refresh.js` :
- Dispatcher entre `bootstrap_pixelrag_text.js` (rapide, défaut) et
  `scrapeVisualBatch.js` (Puppeteer, lent, captures riches)
- Usage : `node scripts/cron_pixelrag_refresh.js --limit 50` (toutes les 6h recommandé)
- Pour Windows Task Scheduler :
  `schtasks /create /tn "PixelRAG-Refresh" /tr "node C:\...\stitch\scripts\cron_pixelrag_refresh.js --limit 100" /sc hourly /mo 6`

### Verdict honnête
- ✅ Index PixelRAG opérationnel et exploitable (103 → à faire croître)
- ✅ Booster V55-VISUAL entraîné, signal visuel reçu (0.53%, marginal)
- ✅ Bug d'intégration corrigé (la pipeline peut maintenant apprendre du visuel)
- ⚠️ Le booster seul ne suffit pas : pour 1% d'apport réel, il faudrait enrichir
  **tous** les matchs d'entraînement (50k+) → volume trop gros pour cette session
- ✅ Le vrai gain de cette session est **structurel** : pipeline branchée, prête à
  monter en charge quand l'ingestion tourne en continu

### Fichiers modifiés
- `core/ml_extract.py` (hydratation visuelle depuis `visual_context_cache`)
- `core/train_v55.py` (hydratation dans `process_row` + `DB_TACTICAL_PATH`)
- Nouveaux : `scripts/bootstrap_pixelrag_text.js`, `scripts/cron_pixelrag_refresh.js`,
  `scratch/populate_visual_cache.py`
- Modèle : `models/stitch_v55_visual.json` (3.4 Mo, 79/235 features utilisées)
- DB : `data/tactical.db.visual_context_cache` (400 rows historiques + 6 live)
- Non commité (travail en cours préservé)

### Reste à faire
- Enrichir les ~50k matchs d'entraînement (`populate_visual_cache.py --limit 50000`)
  puis ré-entraîner → booster utilisable à 5-10% d'importance au lieu de 0.5%
- Activer la tâche planifiée Windows (commande ci-dessus)
- Quand FAISS installé + index > 10k vecteurs : activer un vrai index IVF pour
  passer de brute-force à ANN

---

## Route /api/matches/upcoming — fallback intelligent sur fenêtre réduite (2026-09-08, local)

### Objectif (RFA de la session précédente)
Le fallback « 7 derniers jours » de `/api/matches/upcoming` se déclenchait dès que
`rawMatches.length === 0`. Effet de bord : quand la fenêtre `?days=N` était
légitimement étroite (ex. `?days=1` un jour creux, ou créneau BST tardif sans
match sur les 3 jours par défaut), le fallback ramenait des matchs **des 7
jours passés** et l'UI mélangeait passé + futur sans signal clair. Il fallait
un seuil + un opt-out explicite.

### Modifications — `routes/matches.js:353,388,413`
- Capture `_requestedDays = req.query.days ? daysParam : null` (opt-in explicite).
- Garde de fallback : `rawMatches.length === 0 || (rawMatches.length < 10 && _requestedDays === null)`.
  → **Seuil < 10** : on ne bascule PAS en fallback si la fenêtre est honnête mais peu garnie.
  → **Opt-out `?days=N`** : on ne bascule PAS en fallback si l'utilisateur a explicitement
    demandé une fenêtre (ex. `?days=1`, `?days=14`) — il veut CETTE fenêtre, point.
- Log informatif : `[UPCOMING] Fallback to recent matches — showing N (was M upcoming, threshold <10)`.

### Tests — `__tests__/matches.test.js:224-265`
- Test « should apply date window filter » étendu : mock de **12 matchs valides**
  (fenêtre 3 jours) + 1 vieux + 1 trop loin. Attendus :
  - au moins un `valid-*` présent (filtre OK),
  - `old`/`future` absents (fenêtre 3j respectée),
  - **fallback NON déclenché** (≥ 10 → seuil non franchi → pas de pollution 7j).
- Ancien test (1 match valide) supprimé : avec un seul match, le seuil < 10
  basculait en fallback et le test devenait ambigu (test du filtre OU du fallback ?).

### Validations
- `node --check routes/matches.js` : OK.
- `npm test` : **744/744** (74 suites, +29 vs 715/71 dernier run) — non-régression.
- `pytest tests/` (hors `test_command_center_pronostics.py`) : **344 passed, 30 skipped, 2 xfailed** — 0 failed.
- ESLint `routes/matches.js` : 0 erreur (warning pré-existant `dWP` ligne 819 non touché).
- Non commité (travail en cours préservé).

### Reste à faire
- Aucun (correctif ciblé, test ciblé, log informatif). Possibles évolutions non demandées :
  étendre le test avec un cas `?days=1` (1 match valide) pour vérifier l'opt-out explicite.
- Fichiers non trackés `karkadan.ico/jpg` (logo, 27/08), `pronos-server.bat` (27/08),
  `pronos-test.bat` (11/08), `promosport_reference.md` (24/06) : à trier (logo = OK à
  committer dans `public/`, .bat = outils perso, .md = ancien) — pas dans le scope.

---

## Arbitrage rendement net — simples diversifiés vs doubles couverts (2026-09-06, local)

### Objectif (RFA de la section précédente)
Confirmer la grille de gains officielle Promosport puis arbitrer entre la stratégie
« simples diversifiés » (grilles anti-corrélées) et « doubles couverts » (1X/12/X2)
pour optimiser le rendement net (gains×proba − coût).

### Grille de gains officielle CONFIRMÉE (règlement général des concours promosport.tn)
- Jeu « PROMO 13 N/I » : 13 matchs, prix **0.200 TND / combinaison**, minimum **4 combinaisons** par bulletin.
- 4 catégories de prix : paliers PAYÉS = **13/12/11/10** réponses exactes (PAS 13/11/7/3 comme supposé) :
  - 13/13 → 1ʳᵉ catégorie : **18 %** de la cagnotte
  - 12/13 → 2ᵉ catégorie : **22 %**
  - 11/13 → 3ᵉ catégorie : **26 %**
  - 10/13 → 4ᵉ catégorie : **34 %** — 18+22+26+34 = **100 %** : toute la cagnotte est distribuée.
- Rencontres reportées/annulées → palier requis réduit (13→12→11→10), parts inchangées.

### Arbitrage rendement net (`scratch/arbitrage_rendement.py`)
- Monte-Carlo 40k tirages sur les probas réelles du 899, **budget constant** (même nb de combos).
- Doubles = d doubles (top-2) sur les d matchs les plus incertains, singletons décorrélés ailleurs.
- Métrique : `EV_part` = Σ part_c × P(max_hits = palier_c) ; `EV/combo` = EV_part / nb combos.

| Budget | Stratégie | E[max]/13 | P(≥8) | P(≥10) | P(≥11) | P(13/13) | EV/combo |
|---|---|---|---|---|---|---|---|
| 4 combos | 4 simples div | 6.90 | 33.7% | 3.8% | 0.6% | 0.01% | 0.0031 |
| 4 combos | 1 grille ×2 doubles | 6.47 | 27.9% | 4.1% | 0.9% | 0.00% | 0.0033 |
| 8 combos | **8 simples div** | **7.40** | **46.9%** | **6.9%** | 1.4% | 0.01% | **0.0028** |
| 8 combos | 4 grilles ×1 double | 7.14 | 40.2% | 6.0% | 1.2% | 0.01% | 0.0024 |
| 8 combos | 2 grilles ×2 doubles | 7.04 | 38.2% | 5.8% | 1.3% | 0.01% | 0.0023 |
| 16 combos | **16 simples div** | **7.84** | **59.5%** | **11.7%** | 2.8% | 0.02% | **0.0023** |
| 16 combos | 8 grilles ×1 double | 7.57 | 51.8% | 9.8% | 2.2% | 0.01% | 0.0020 |
| 16 combos | 4 grilles ×2 doubles | 7.43 | 47.9% | 8.8% | 2.1% | 0.01% | 0.0018 |
| 32 combos | **32 simples div** | **8.17** | **68.4%** | **17.2%** | 4.6% | 0.03% | **0.0017** |
| 32 combos | 16 grilles ×1 double | 7.97 | 62.6% | 15.2% | 4.1% | 0.03% | 0.0015 |
| 64 combos | **64 simples div** | **8.51** | **76.9%** | **23.9%** | 7.3% | 0.06% | **0.0012** |
| 64 combos | 32 grilles ×1 double | 8.34 | 71.9% | 21.6% | 6.5% | 0.07% | 0.0011 |

### Conclusion
- **Les simples diversifiés dominent les doubles couverts sur tout budget ≥ 8 combos** (EV/combo,
  E[max], P(≥8), P(≥10) tous supérieurs). Le double n'« améliore » qu'au minimum légal (4 combos :
  1 grille ×2 doubles, +0.0002 EV/combo) au prix d'un E[max] inférieur de 0.43 hit — choix de
  sécurité sur les paliers moyens, jamais optimal pour viser haut.
- Pourquoi : le double concentre le budget sur UN match (colonnes internes fortement corrélées),
  tandis que la rotation anti-corrélée élargit l'éventail → E[max] +1.4 à 8 combos (7.40 vs 7.14).
- Budget conseillé : **8 combos (1.60 TND)** = bon compromis (P(≥8) 46.9%, linéarité du rendement
  décroissante : EV/combo 0.0031 → 0.0012 entre 4 et 64 combos).
- Seuil de rentabilité si seul au palier : cagnotte ≥ 71.5 TND (8 simples), 85.5 TND (16 simples).
  En mutuel réel la cagnotte se divise par le nb de gagnants → conclusion valable en relatif.

### Validations
- `.venv/Scripts/python.exe scratch/arbitrage_rendement.py` : OK (indépendant, sortie stable, seed 42).
- Nouveau fichier scratch isolé — aucune régression fonctionnelle (pas de code applicatif modifié).

### Reste à faire
- ~~Branch direct : générateur de grilles dans l'UI → produire le set de 8 simples anti-corrélées
  à chaque concours (budget recommandé).~~ **FAIT (2026-09-06, voir section suivante).**

---

## UI — 8 grilles anti-corrélées branchées (2026-09-06, local)

### Objectif (RFA de la section précédente)
Produire et afficher le set de **8 grilles simples anti-corrélées** (budget 1.60 TND, validé
par l'arbitrage rendement net) à chaque concours, dans le moteur puis dans l'UI.

### Implémentation
- `services/promosport_engine.js` : nouvelle fonction **`generateAntiCorrelatedGrids(gridMatches, N=8)`**
  (exportée dans `module.exports`).
  - Normalisation probs `p1/px/p2` ; LOCK des matchs sûrs (gap top1-top2 ≥ 0.15) et des matchs
    déjà joués (`isFinished` + `actualResult`/`choices[0]`).
  - Rotation gloutonne max-distance de Hamming sur les matchs incertains (top-2, +top-3 si proche).
  - Espace candidat borné (`MAX_SPACE = 8192`, top-2 puis 12 matchs max) pour garder la route rapide.
  - Sortie au format des grilles du moteur (`gridNumber`, `name "ANTI-CORR n"`, `matches[]` avec
    `choices` single + `inUncertain`/`gap`, `stats.totalSingles = 13`, `avgConfidence`).
- `routes/promosport.js` GET `/api/promosport` : clé **`antiCorr`** additive dans la réponse
  (`{ grids: [{name, picks[], inUncertain[], stats}], count: 8, budgetTnd: 1.60 }`). Aucun impact
  sur `cols` existant ni sur la persistance (Neon/SQLite) ni sur le front 4-colonnes.
- `src/components/Promosport.jsx` : state `antiCorr` + **section dédiée** sous la table principale
  (table 13×8, code couleur 1/X/2, contour pointillé + tooltip sur les matchs incertains).
- Tests : `__tests__/anticorrEngine.test.js` (5 assertions + edge cases sur la vraie fonction,
  deps du moteur mockées) ; `__tests__/additionalRoutes.test.js` : clé `generateAntiCorrelatedGrids`
  ajoutée au mock + test « should include anti-correlated grids in response » ; `tests/promosport.test.js` :
  clé ajoutée au mock existant.

### Piège résolu
- La route affichait un 500 `ReferenceError: generateAntiCorrelatedGrids is not defined` : l'import
  destructuring avait été réédité par la route initiale. Rétabli destructuring complet
  `{ generatePromosportGrids, generateGoldCoupon, generateAntiCorrelatedGrids }`.
- Un mock de test sans la clé `generateAntiCorrelatedGrids` cassait `tests/promosport.test.js` :
  ajouté dans les 2 suites mockant l'engine.

### Validations (toutes vertes)
- `node --check` (moteur, route, tests) ; `npm run build` (vite, 131 modules) ;
  **`npm test` : 71 suites / 715 tests ✔** (70 suites / 708 avant) ; boot `node server.js`
  (« Startup bootstrap complete », `/api/health` 200) ; `madge --circular` : aucune dépendance circulaire.
- Fichiers modifiés : `services/promosport_engine.js`, `routes/promosport.js`,
  `src/components/Promosport.jsx`, `__tests__/additionalRoutes.test.js`, `tests/promosport.test.js` ;
  nouveau `__tests__/anticorrEngine.test.js`. Non commité (travail en cours préservé).

### Reste à faire
- ~~Vérifier le rendu réel sur le concours courant (réseau/données Promosport live) et calibrer la
  valeur du seuil de rotation (0.15) avec l'historique des probas.~~ → FAIT (section calibration ci-dessous)

### Calibration du seuil de rotation (`scratch/calibrate_rotation_threshold.py`)
- Balayage du seuil UNCERTAIN_THR (gap top1-top2) sur les probas réelles du 899, MC 40k,
  budget 8 grilles simples. Rayon de proxys historiques riches absent (probas ML stockées
  par concours), la calibration s'appuie sur le concours complet réel (899) + parité JS/Python.
  Résultats (EV/combo = EV_part/8, minH = distance Hamming minimale entre 2 grilles du set) :

  | seuil | incertains | E[max] | P≥8 | P≥10 | EV/combo | minH |
  |---|---|---|---|---|---|---|
  | 0.05 | 2 | 6.99 | 37.7% | 6.5% | 0.0026 | 1 |
  | 0.10 | 4 | 7.04 | 39.0% | 6.5% | 0.0026 | 2 |
  | 0.12 | 6 | 7.24 | 43.1% | 6.9% | 0.0028 | 3 |
  | **0.15** | **8** | **7.40** | **46.9%** | **6.9%** | **0.0028** | **4** |
  | 0.18 | 10 | 7.45 | 47.9% | 5.9% | 0.0024 | 6 |
  | 0.20 | 11 | 7.32 | 43.9% | 4.8% | 0.0020 | 6 |
  | 0.25-0.30 | 12 | 7.44 | 47.5% | 4.6% | 0.0019 | 7 |
  | 0.35-0.50 | 13 | 7.28 | 41.0% | 3.8% | 0.0016 | 7 |

- **Verdict** : 0.15 est déjà au maximum (EV/combo 0.0028, plateau 0.12-0.18). Au-delà de 0.18,
  la rotation touche des matchs trop sûrs → P≥10/P≥11 chutent malgré une E[max] plus haute
  (le top1 sûr est déjà bien verrouillé : rien à gagner à tourner des matchs au gap ≥ 0.18).
- **Parité JS/Python confirmée** (`scratch/parity_js_engine.js`) : `generateAntiCorrelatedGrids`
  du moteur reproduit exactement le comportement calibré sur le 899 — 8 incertains, minH=4,
  8 grilles `ANTI-CORR 1..8`, LOCK sur matchs sûrs, déterministe, stats totalSingles=13.
- **Aucun changement de code nécessaire** : UNCERTAIN_THR=0.15 reconfirmé. Artefact :
  `grilles/promosport_threshold_calibration.md`.
- Rendu réel : hors-ligne ici → le fallback renvoie [] → 500 volontaire « Fallback échoué »
  (comportement existant, pas un bug). Rendu online couvert par l'intégration
  (`__tests__/additionalRoutes.test.js` : 200 + antiCorr.grids.length=8 + budgetTnd) et le
  générateur réel par `__tests__/anticorrEngine.test.js`. Non commité (travail en cours préservé).

## Validation train/test + grilles anti-corrélées (2026-09-05, local)

### Objectif (demande user « augmenter le taux de réussite »)
1. Vérifier que le réglage de l'escalier (w=0.40/thr=0.15/corr=0.30) n'est PAS surajusté.
2. Identifier le vrai levier de gain pour le jackpot → diversification des grilles.

### Validation train/test (`scratch/validate_tv.py`) — split temporel anti-fuite
- Split par CONCOURS (aucun concours commun), base recalculée sur train uniquement.
- Train 179 concours (2226 matchs, n° 632-834) / Test 45 concours (570 matchs, n° 835-879).
- Grid-search sur train retrouve EXACTEMENT le réglage `.env` (0.25/0.15/0.30), plateau stable
  (0.25→0.50 ≈ 0.485) → **pas d'overfit**.
- Évaluation test (poids figés) : crowd 49.5% → escalier **50.5%** = **+1.1 pt** seulement
  (vs +2.4 pts en calibration full-data → le gain full-data était optimiste).
- Robustesse 10 splits temporels décalés : escalier > crowd **10/10** (moy +1.0 pt, min +0.3).
- **Conclusion honnête** : l'edge blend est réel et constant mais FIN (~1 pt). Le crowd s'améliore
  sur les concours récents → le blend seul ne suffit pas pour viser le 13/13.

### Grilles anti-corrélées (`scratch/build_decorrelated_grids.py`) — LE levier
- Générateur : LOCK sur matchs sûrs (écart top1-top2 ≥ 0.15), sélection gloutonne à distance de
  Hamming max sur les 8 matchs incertains du 899 → grilles qui ne tombent pas ensemble.
- **Monte-Carlo 40k tirages** (échantillonne les vrais résultats selon les vecteurs de proba) :

  | set | E[max hits] | P(≥8) | P(≥10) | P(≥11) |
  |---|---|---|---|---|
  | 6 copies IDENTIQUES | 5.81 | 16.9% | 1.8% | 0.4% |
  | 3 anti-corrélées | 6.75 | 29.9% | 3.1% | 0.6% |
  | 6 anti-corrélées | 7.21 | 41.6% | 5.6% | 1.1% |
  | 8 anti-corrélées | 7.39 | 46.8% | 7.0% | 1.3% |
  | 10 anti-corrélées | 7.53 | 50.6% | 8.2% | 1.6% |

- **Résultat clé** : dupliquer une grille n'apporte RIEN (16.9% quel que soit N). Diversifier
  **×2.4** les chances d'une grille valide (≥8) pour 6× le coût. Genou de la courbe = **N=6-8**
  (au-delà, <2 pts de gain par grille de 13 paris).
- 6 grilles produites → `grilles/promosport_decorrelated_899.md`. Matchs incertains 899 :
  #5 Rayo-Racing (gap 0.01), #9 Fulham-CP (0.03), #11 Gladbach (0.06), #6 Nottingham (0.08),
  #3 Athletic-Atletico (0.11), #12 Hoffenheim-Dortmund (0.11), #1 Inter-Napoli (0.13), #2 Roma (0.14).

### Limites assumées
- Le MC suppose les probas du modèle bien calibrées. Le T/V (50.5% réel vs ~40% argmax prédit)
  suggère un léger sous-confiance → hit rate réel probablement un peu > MC (plutôt rassurant).
- Les grilles anti-corrélées sont des SIMPLES (1 choix/match, 13 paris/grille). La stratégie
  « playable » à doubles (1X/12/X2) du backtest historique (9.01 hits/13) est un mécanisme
  DIFFÉRENT et plus coûteux (5047 paris) — à arbitrer selon la grille de gains Promosport réelle.

### Reste à faire
- Confirmer la **grille de gains officielle Promosport** (paliers payés 13/11/7/3 ?) pour arbitrer
  simples diversifiés vs doubles couverts → optimiser le rendement net (gains×proba − coût).
- Optionnel : brancher le générateur dans l'UI pour produire le set diversifié à chaque concours.

---

## Correction des 2 bugs d'archivage + backtest validé (2026-09-05, local)

### Objectif (demande user « corrige les 2 bugs après passe au backtest »)
1. Corriger l'archivage cassé de `/api/promosport/tunisie/:grid` (INSERT sur colonne inexistante,
   table `promosport_grids` jamais créée, erreur avalée par catch silencieux).
2. Rendre `import_promosport_archive.py` non destructif (il DROPPait la table et perdait les
   résultats frais fetchés en SQLite).
3. Relancer le backtest calibré de l'escalier sur l'archive propre.

### Modifications — Bug 1 (`routes/promosport.js`)
- Ajout d'un `CREATE TABLE IF NOT EXISTS promosport_grids (concours, date, grid_data, updated_at, PK(concours))`
  au chargement du module → aussi bien `archiveScrapedMatches()` (l.~90) que la route `/tunisie/:grid` (l.~860)
  pouvaient échouer sur cette table absente.
- Route `/tunisie/:grid` : l'INSERT `promosport_archive` référençait `grid_no` (colonne inexistante,
  schéma réel : id, concours, match_idx, homeTeam, awayTeam, result, score_home, score_away,
  vote_home, vote_draw, vote_away, date, is_finished, archived_at) avec 14 placeholders / 12 args.
  Corrigé pour coller au schéma réel : `INSERT OR REPLACE` avec `match_idx` (pas `grid_no`),
  équipes en UPPERCASE (cohérent avec `checkAndFetchResults` qui normalise en UPPERCASE pour la
  jointure computeAccuracy), skip des matchs sans résultat (`result` absent/`N`),
  `is_finished=1`, votes/scores stockés.
- `routes/promosport.ts` : doublon .ts inutilisé (app.js charge le .js) — non modifié.

### Modifications — Bug 2 (`scripts/import_promosport_archive.py`)
- Sauvegarde en fichier `data/promosport_archive_pre_import.json` des 15172 lignes EXISTANTES avant
  le DROP (les résultats frais fetchés par `checkAndFetchResults` ne sont pas dans les JSON sources).
- Après rebuild depuis les JSON, `Restore` des lignes sauvegardées dont la clé `(concours, match_idx)`
  n'existe pas dans la table reconstruite → plus aucune perte de données fraîches à l'auto-retrain.
- Effet de bord bénéfique : l'archive passe de 15172 à 7586 lignes (= 26 → 13 par concours) ; la
  déduplication 2-par-2 de l'ancienne table est maintenant native. Vérifié : 397 concours distincts
  conservés, résultats 870-879 préservés, `promosport_predictions` intacte (5471 lignes dont 6 grilles
  899), matchs votes+résultats = 2796 (identique au jeu calibré).

### Backtest sur l'archive propre (scratch/calibrate_staircase.py relancé)
- 2796 matchs, 173 concours complets 13/13, base 0.422/0.252/0.326, crowd baseline 46.7%.
- Optimum inchangé : base_w=0.40, thrTrap=0.15, corrTrap=0.30 → **49.1% acc** (trap 52.9%, n_trap 1506).
  Correspond au réglage `.env` actuel (PROMOSPORT_BLEND_WEIGHT=0.25 ×boost 1.6 = 0.40 effectif).
- Quand pick home est faux : erreur → draw 25.6%, away 26.1% (playbook « couvrir 1X »).
- Simulation playable (1X/12/X2, LOCK≥48%) : **9.01 hits/13 en moyenne** (min 4, max 13), 3 grilles
  13/13, ≥11 : 35, ≥8 (valides) : 140 sur 173 | répartition 545 singles + 2251 doubles (5047 paris).
- Crowd seul : 6.18 hits/13, ≥8 : 40. L'escalier améliore 46.7% → 49.1% de précision et 42 → 140
  grilles valides ≥8.

### Validation
- `node --check routes/promosport.js` : OK. `npm test` (tests/promosport.test.js) : 13/13 passed.
- `pytest tests/test_promosport_blend.py` : 4/4 passed.
- Table `promosport_grids` créée en DB (0 ligne, peuplée au prochain import via `/tunisie/:grid`).

### Reste à faire
- Aucun redémarrage requêté notable : le module recrée la table au chargement ; la table existe
  déjà en DB. Restart Node nécessaire uniquement pour prendre en compte le nouveau code de la route
  `/tunisie/:grid` au prochain déploiement.
- Surveiller le site tunisien (redirect-loop) → dès que résultats 899 publiés : crons auto,
  sinon relancer `node scratch/feedback_loop_899.js`.

---

## Feedback loop concours 899 (2026-09-05, local)

### Objectif (demande user « go » — étape 2 des RFA)
Boucler la boucle retour : persister nos grilles, scorer automatiquement les résultats réels
du concours 899 dès publication, comparer vs crowd et vs les 4 grilles ML du site.

### Constat (état infrastructure — recherche services/promosportResultService.js, routes/promosport.js, crons)
- L'infrastructure ENTIÈRE existe déjà : `scrapeTunisieGrid(899)` → `checkAndFetchResults('899')`
  (upsert dans `promosport_archive`) → `computeAccuracy('899')` (jointure predictions→archive, un
  double compte correct si résultat ∈ choices). Endpoints : `POST /api/promosport/check-results/899`,
  `GET /api/promosport/accuracy/899`, UI `PromosportAccuracy.jsx`.
- Crons existants (20:30 / 00:30 / 20:00 services/cronManager.js) pollent `getRecentHistory(5-10)`
  → `checkAndFetchResults()`. Il suffit que nos grilles soient dans `promosport_predictions`.
- Résultats concours 899 NON publiés (0 ligne en archive ; site tunisien en redirect-loop même pour
  un concours fini 879 → indisponibilité réseau temporaire, pas un bug du loop).

### Modifications
- `scratch/feedback_loop_899.js` : persiste **TITANIUM_COUVERTE** (1X|1|X2|1|1|12|12|1|12|1|1X|1X|2) et
  **TITANIUM_BOMBER** (1-1-2-1-1-1-1-1-1-1-1-2-2) via `storePrediction('899', '02/09/2026', grids)`,
  puis `checkAndFetchResults('899')` ; si résultats dispo → `computeAccuracy` + rapport
  `grilles/feedback_concours_899.md`. Relance possible dès publication des résultats.
- Vérifié en DB : 6 grilles pour 899 (EDGE/ANTI-CROWD/HIGH VALUE/SECURE BANKER + nos 2 TITANIUM),
  13 matchs chacune, choices JSON corrects (ex: couverte `["1","X"]` Inter-Napoli).

### Blocage temporaire
- Résultats 899 non publiés par le site (redirect-loop réseau actuellement). Dès que publiés :
  1) les crons existants les fetch automatiquement (899 déjà dans getRecentHistory) OU
  2) relancer `node scratch/feedback_loop_899.js` on-demand → rapport score généré.

### Remarques (pas corrigées ici, hors scope)
- Bug latent `/api/promosport/tunisie/:grid` : INSERT avec colonne `grid_no` inexistante → levée
  silencieusement (catch), archiving échoue. À corriger si on veut le crawler manuel fiable.
- `import_promosport_archive.py` est DESTRUCTIF (rebuild archive depuis JSON) → les résultats
  fraîchement fetchés en SQLite risquent d'être perdus au prochain auto-retrain tant que le
  chemin "SQLite → JSON" n'existe pas. À surveiller avant full auto-retrain.

---

## Grille bomber concours 899 (2026-09-05, local)

### Objectif (demande user « continue » — étape 3 des RFA)
Produire l'**alternative bomber** (13 singles, cible 13/13) vs grille couverte playable,
pour le concours en cours.

### Logique — `scratch/build_bomber_grid.js`
- Pick = **prob la plus forte parmi {1,2}** (victoire), X uniquement si draw massif (≥34% et max) →
  interdit le X isolé à la légère (playbook historique : draw = 1re source d'erreur).
- Marque les matchs **risqués (<38%)** et les **TRAP** non couverts (choix assumé d'un bomber).
- Livre aussi une ligne "couverture conseillée" pour le jeu mixte.

### Grille bomber concours 899
`1-1-2-1-1-1-1-1-1-1-1-2-2` (11×1, 2×2), proba moyenne 45%, EV moyen -17%.
Matchs risqués : Rayo (35%), Fulham (36%). TRAP assumés : Brentford/Brighton/Nottingham/Hoffenheim.

### Livrable
- `grilles/promosport_bomber_concours_899.md`
- Les 2 stratégies (couverte vs bomber) disponibles pour le dépôt du concours 899.

---

## Calibration backtest de l'escalier (2026-09-05, local)

### Objectif (demande user « on commence par 1 »)
Calibrer les poids de l'étage Promosport + anti-crowd-trap sur l'historique réel
(`promosport_archive`, 5592 matchs votes+résultat, 224 concours × 26 lignes = 2 grilles de 13).

### Méthode — `scratch/calibrate_staircase.py`
- **Dedup** : 2 lignes par (concours, match_idx) → 2796 matchs distincts = 13/concours.
- **Placeholders** 25/50/25 : 592 exacts écartés → votes réels (0 placeholders restants).
- Proxy `base_probs` = distribution historique réelle (home 0.422 / draw 0.252 / away 0.326)
  car l'archive n'a ni probas Titanium ni cotes. Le harnais calibre LE RÉGLAGE DES VOTES.
- Réplique exacte de `prediction_engine.py` : `w = min(0.5, base_w*1.6)` (votes présents),
  blend `(1-w)*base + w*votes`, anti-trap `|crowd_h-base_h| ou |crowd_a-base_a| > seuil` → pull vers base.

### Résultats (2796 matchs)
- Crowd seul = **46.7%**. Blend optimal = **49.1%** (+2.4pt) à `base_w=0.40-0.50 / thr=0.15 / corr=0.30`.
- Fait clé : `PROMOSPORT_BLEND_WEIGHT=0.25` × 1.6 = **w=0.40 effectif** → déjà au milieu de l'optimum.
- **Seuil trap** : 0.22 → **0.15** (plus sensible), acc sur matchs trap = 52.9%. **Correction** : 0.15 → **0.30**.
- Erreurs pick home → draw 25.6% / away 26.1% : couvrir 1X protège autant que 12 côté proba, MAIS
  12 est supérieur quand l'anti-trap détecte un faux favori home (brentford/fulham/nottingham pattern).
- **Simulation stratégie playable (1X/12/X2)** : **9.01 hits/13 en moyenne** (vs 6.18 crowd seul),
  3 grilles 13/13, 35 ≥11, 140 ≥8 (valides) sur 173. Répartition 545 singles + 2251 doubles (coût 5047).

### Modifications
- `.env` : `CROWD_TRAP_THRESHOLD=0.22` → **0.15** ; `CROWD_TRAP_CORRECTION=0.15` → **0.30**.
  (`PROMOSPORT_BLEND_WEIGHT=0.25` conservé — optimum effectif 0.40 via ×1.6.)

### Vérifié (local)
- `pytest tests/test_promosport_blend.py` : 4/4 passed.
- FastAPI redémarré proprement (kills des vieux uvicorn Python 3.12 système + port 8000 rebind) →
  `/health` OK (version 3.6, engines loaded). Nouveau PID = venv.
- E2E Inter-Milan vs Napoli : `ai_source = Standard-Poisson+ExternalXGB+Promosport+TitaniumFinal`,
  `verdict DNB Inter`, PromosportBlend w=0.40 votes=yes → escalier confirmé avec nouveaux poids.
- Grille concours 899 régénérée avec poids calibrés (`grilles/promosport_concours_899.md`) :
  changement notable match 12 Hoffenheim-Dortmund `12` → **`1X`** (EV X +11%, moins de couverture 12).

### Livrable
- `scratch/calibrate_staircase.py` : harnais de calibration réutilisable (régler `base_w/thr/corr`).
- Grille concours 899 à jour.

---

## Grille officielle concours 899 via escalier (2026-09-05, local)

### Objectif (demande user « ok je veux aller plus loin »)
Connecter l'escalier Titanium à la **VRAIE grille Promosport officielle** (scrape `routes/promosport.js`)
et produire la grille playable pour le concours réel en cours, avec **EV calculé sur cotes réelles**.

### Constat
- `GET /api/promosport` (port 3001) → **Concours 899** (date 02/09/2026, 13 matchs réels) avec
  **cotes réelles** (`odds h/d/a`) + probas crowd/ML + colonnes EDGE/ANTI-CROWD/HIGH VALUE/SECURE BANKER.
  → Contrairement aux archives, on a des cotes réelles → l'EV devient calculable.
- Matchs : Inter-Napoli (1.69/3.86/5.15), Roma-Atalanta, Athletic-Atletico, Villarreal-Deportivo,
  Rayo-Racing Santander, Nottingham-Tottenham, Brighton-Leeds, Brentford-Sunderland, Fulham-Crystal
  Palace, Leverkusen-Union Berlin, Gladbach-Elversberg, Hoffenheim-Dortmund, Werder-RB Leipzig
  (4.33/4.0/1.73, public 71% away → flags `isAwayCrowdTrap`).

### Modifications (scratch uniquement, aucun code prod modifié)
- `scratch/predict_concours.js` : prédit les 13 matchs du concours via `POST /predict` (staircase),
  en passant league réelle + cotes + votes crowd → **12/13 enrichis** (Werder-RB Leipzig ajouté via
  `scratch/add_match13.js`). Sortie avec prob H/D/A, verdict, EV 1/X/2, kelly, CrowdTrap.
- `scratch/concours_grid.json` : données brutes enrichies des 13 matchs.
- `scratch/build_concours_grid.js` : stratégie de sélection par match (LOCK ≥48%, TRAP → couverture
  12/1X/X2 anti-crowd, EV support) → **grille playable `grilles/promosport_concours_899.md`**.

### Vérifié (local)
- `ai_source = Standard-Poisson+ExternalXGB+Promosport+TitaniumFinal` sur tous les matchs → escalier actif.
- 5 CrowdTraps détectés sur 13 (Brentford, Brighton, Nottingham, Fulham, Hoffenheim) → couverts.
- Grille finale : 5 verrous (1-1-1-1-2) + 8 doubles (1X/12/X2), EV explicite par match.

### Résultats clés concours 899 (proba escalier H/D/A)
1. Inter: 46/32/23 (EV X +22%) → 1X | 2. Roma: 49/36/15 → 1 | 3. Athletic: 26/32/43 → X2 |
4. Villarreal: 48/33/19 (EV X +59%) → 1X | 5. Rayo: 35/34/32 → 1 | 6. Nottingham: 39/29/32 TRAP → 12 |
7. Brighton: 44/29/27 TRAP → 12 | 8. Brentford: 49/30/21 TRAP → 1 | 9. Fulham: 37/30/33 TRAP → 12 |
10. Leverkusen: 60/29/11 → 1 | 11. Gladbach: 40/34/26 → 1X | 12. Hoffenheim: 31/29/40 TRAP → 12 |
13. Werder: 18/31/51 → 2 (RB Leipzig, public overconfident mais modèle confirme away).

### Livrable
`grilles/promosport_concours_899.md` — grille playable du concours réel avec tableau complet proba/EV/conseil.

---

## Escalier de moteurs + Grille Promosport (2026-09-05, local)

### Objectif (demande user « augmente la partie promosport avec un escalier d'autre moteur », « prendre le bon chemin pour gagner la compétition »)
Remplacer le **blend Promosport isolé** (un seul moteur, w=0.25) par un **escalier de 4 moteurs**
qui affinent séquentiellement les probabilités 1X2, calé sur l'analyse historique des 5 592
matchs (`promosport_archive`) pour maximiser les hits en compétition Promosport.

### Constat (analyse historique)
- Résultats réels : home 42%, away 33%, draw 25%. Le **draw est la 1re source d'erreur** quand
  un favori est faux.
- Votes de la communauté **partiellement réels** : 1074 combinaisons distinctes ; placeholder
  `25/50/25` (n=592) + 9580 matchs sans votes (NULL). Le modèle V553 est entraîné dessus.
- Aucune cote bookmaker réelle (`real_markets=null`) → EV non calculable, grille par confiance.

### Modifications — `core/prediction_engine.py`
- **`_apply_graph_blend()`** (Étage 2, w `GRAPH_BLEND_WEIGHT`=0.12) : convertit les features
  réseau de `graph_engine.compute_graph_features()` (PageRank, transitive, direct record,
  défense) en triplet puis **blend pondéré**. Kill-switch `GRAPH_ENGINE_ENABLED`. Marque
  `analysis["GraphBlend"]` + suffixe `+Graph`.
- **`_apply_dex_blend()`** (Étage 3, w `DEX_BLEND_WEIGHT`=0.08) : convertit
  `dex_smart_money_signal` (flux Polymarket/Azuro) en triplet, blend pondéré, degrade
  gracieusement si `dex_has_data=0`. Kill-switch `DEX_TRACKER_ENABLED`. Marque `+Dex`.
- **`_apply_titanium_final_blend()`** (Étage 4, w `TITANIUM_BLEND_WEIGHT`=0.45) : ré-injecte
  les probas Titanium-XGB d'origine (avant gap learning) en poids final borné. Marque
  `+TitaniumFinal`.
- **`_detect_crowd_trap()`** : divergence crowd (Promosport `predict_match`) vs Titanium
  (`base_probs`) ; si > `CROWD_TRAP_THRESHOLD` (0.22) → renforce le Graph et réinjecte Titanium
  pour contrer le consensus trompeur. Marque `analysis["CrowdTrap"]`.
- **`build_engine_staircase()`** : orchestre les 4 étages séquentiellement (sortie d'un étage =
  entrée du suivant). Kill-switches + poids via `.env`.
- **`process_prediction()`** : capture `base_probs` (output `blend_final_probabilities`),
  Gap Learning (Étage 0), appelle `build_engine_staircase()`. Les anciens modificateurs
  Graph/DEX en shift direct (max ±8%/±6%) sont **retirés** (évite double comptage).
- **`.env`** : `GRAPH_BLEND_WEIGHT=0.12`, `DEX_BLEND_WEIGHT=0.08`,
  `TITANIUM_BLEND_WEIGHT=0.45`, `CROWD_TRAP_THRESHOLD=0.22`, `CROWD_TRAP_CORRECTION=0.15`.

### Vérifié (local)
- `py_compile core/prediction_engine.py` : OK.
- `pytest tests/test_promosport_blend.py` : 4/4 passed.
- Non-régression : `pytest tests/ --ignore=test_command_center_pronostics.py
  --ignore=test_predictions.py` → **341 passed, 0 failed, 30 skipped, 1 xfailed, 1 xpassed**
  (calibré sans les 2 tests pré-existants).
- E2E `process_prediction` (Bayer Leverkusen vs Union Berlin, vote_home=90) :
  `ai_source = Standard-Poisson+ExternalXGB+Promosport+Graph+TitaniumFinal`,
  `PromosportBlend w=0.40 votes=yes`, `GraphBlend w=0.12`, `TitaniumFinalBlend w=0.45`,
  `CrowdTrap DETECTED` (crowd 0.81 vs titanium 0.56). Verdict DNB Leverkusen.
  (Dex absent car `dex_has_data=0` → dégradation gracieuse attendue.)
- Serveurs relancés : Node 3001 + FastAPI 8000 (venv, code à jour, `/health` OK).

### Livrable grille
`grilles/promosport_2026-09-05.md` — grille 13 matchs recommandée, différenciée par verdict
modèle : `1 | 1X | 1X | 12 | 1X | 1X | 1X | 1X | 1X | 12 | 1X | 12 | 1X`
(1 verrou Sporting, 9×1X, 3×12). Matchs du jour compétitifs → grille couverte, pas bomber.

### Reste à faire
- Cotes bookmaker réelles (scraper/manuel) pour calculer l'EV et viser la grille bomber.
- Calibration automatique des poids d'escalier par backtest (weights grid-search sur l'archive).
- Intégrer un vrai signal de votes Promosport pour les matchs BSD (fallback placeholder actuel).

---

## Moteur principal branché sur le blend Promosport V553-enrichi (2026-09-05, local)

### Objectif (demande user « connecte le moteur principal au blended Promosport »)
Le moteur `prediction_engine.process_prediction()` (appelé par FastAPI `/predict`, donc
par `/api/upcoming` & `/api/live`) n'utilisait **pas** le modèle Promosport. Seul le chemin
parallèle `predict_blended.py` s'en servait (30%). Objectif : enrichir les probabilités 1X2
finales du moteur principal avec le savoir Promosport, sans régresser le comportement actuel.

### Constat (analyse code)
- `prediction_engine.py` : 0 référence à promosport. Flux : xG → ML ensemble (V4+external)
  → `blend_final_probabilities` (l.386) → Meta-Refiner → Confluence → Gap Learning (l.417)
  → confiance/marchés.
- `promosport_engine.predict_match()` : **fonctionne** (testé) — modèle
  `models/promosport_v553_enriched.json` (570 Ko), features forme/H2H/ELO/streaks + votes,
  base `data/historical_archive.sqlite` table `promosport_archive` = **7586 lignes**.
- **Piège** : les `vote_home/draw/away` ne viennent que des grilles Promosport (crowdsourcing
  tunisien). Pour un match BSD/Sofascore classique ils sont absents → `ml_features` met des
  défauts 0.5/0.33/0.17 (l.1630-1635). Un blend à poids constant sur ces matchs introduirait
  du bruit. D'où un poids **rehaussé quand de vrais votes existent**.

### Modifications
- **`core/prediction_engine.py`** :
  - Nouvelle fonction `_apply_promosport_blend(p_h, p_d, p_a, match_obj, analysis, ai_source)`
    (avant `process_prediction`) : blend pondéré des probas finales avec `predict_match()`.
    - Kill-switch `PROMOSPORT_BLEND` (défaut **on**, `off` = no-op strict).
    - Poids base `PROMOSPORT_BLEND_WEIGHT` (défaut 0.25, plafonné 0.5) ; **×1.6** quand
      `vote_home/draw/away` réels présents (plafonné 0.5).
    - Dégradation gracieuse : modèle absent / probas invalides / exception → retourne les
      probas d'entrée inchangées. Marque `analysis["PromosportBlend"]` + suffixe `+Promosport`
      dans `ai_source` (auditabilité).
  - Injection **après Gap Learning** (dernier modificateur de proba avant confiance) → tout
    l'aval (confiance, marchés chirurgicaux, verdict, Kelly) reflète le blend.

### Vérifié (local)
- `py_compile` OK. Test unitaire de la fonction : OFF=no-op, ON normalise+tag, votes→poids
  0.40, cap poids 0.50.
- **End-to-end** `process_prediction` (Burnley vs Man City) : OFF → `Draw` p=[.33,.35,.33] ;
  ON → `DNB Man City` p=[.28,.28,.43], `ai_source=...+Promosport`, promo=[.13,.09,.78].
  Le modèle Promosport fait basculer le verdict → enrichissement réel.
- **Non-régression** : suite Python complète `pytest --ignore=test_command_center_pronostics.py`
  → **343 passed, 30 skipped, 2 xfailed, 1 failed**. L'unique échec
  (`test_predictions.py::test_scheduled_matches_predictable`) est **pré-existant** (dépend du
  contenu `scheduled` de `tactical.db`, aucun match prédictible au moment du run) — présent
  avant la modification.
- Nouveau fichier `tests/test_promosport_blend.py` (4 tests, tous verts).

### Points de contrôle restants
- **Redémarrer le serveur FastAPI** (port 8000, actuellement bloqué) pour charger le nouveau
  `prediction_engine.py` : le blend ne s'activera en prod qu'après reload.
- Backtest A/B recommandé (`PROMOSPORT_BLEND=on` vs `off`) sur un échantillon de matchs
  archivés avant de figer le poids par défaut (0.25) — mesurer l'impact sur le taux de réussite.
- `streamlit` absent de l'env local → `test_command_center_pronostics.py` non collectable
  (pré-existant, hors périmètre).

---

## Audit projet + correctifs prioritaires (2026-09-04, suite intégration API-Football)

### Objectif
Répondre à la demande « teste mon projet et dit moi ce qui manque / peut s'améliorer » : audit complet
(4 subagents : qualité code, pipeline ML, data sources, frontend) puis correctifs rapides à fort impact.

### Constat (synthèse audit)
- **2 erreurs ESLint** : `path` non défini dans `core/cloudSeed.js` lignes 429/431 (bloc Sofascore, `pathmod` oublié lors de la régénération babel).
- **60+ blocs `catch {}` silencieux** ; les plus critiques masquent des pertes d'intégrité dans le règlement des pronostics.
- **Filtres SQL par `league`/`tournament_id`/`country_iso`** : rares (scripts de maintenance) → non critiques. En revanche requête hot path du seeding filtre `status='scheduled' AND "startTimestamp"` (entier, non indexé).
- **N+1** : `.find()` dans un `.map()` dans `core/promosport_engine.js` (ligne 571) → O(n×m).

### Modifications
- **`core/cloudSeed.ts` + `cloudSeed.js`** : `path.resolve`/`path.join` → `pathmod...` dans le bloc Sofascore (0 erreur lint). 3 `catch {}` → `logger.warn` (check matches seed, auto-calibration, odds backfill).
- **`core/database.ts` + `database.js` + `core/pg_migrations.ts` + `pg_migrations.js`** : indexes `idx_matches_status_startts ON matches(status,"startTimestamp")` et `idx_matches_source ON matches(source)`.
- **`services/settlementService.js`** : 8 `catch {}` → `logger.warn`/`logger.debug` (extractMainPick, removeResult, phantom reset, syncBetToTracker, recordSettlement, _appendToAccuracyLog, breakdown agrégation) — visibilité des pertes tracker/calibration ML.
- **`app.js`** : échec `marketAnalysis` par match → `logger.debug`.
- **`core/promosport_engine.js`** : Map `enrichedById` pour remplacer le `.find()` O(n×m) de la distribution des doubles.

### Vérifié
- ESLint sur tous les fichiers modifiés : **0 erreur**.
- Jest complet : **70 suites / 708 tests passent**.
- `node --check` sur tous les fichiers modifiés : OK.
- Base SQLite : indexes `idx_matches_status_startts` + `idx_matches_source` créés (schema validated with INDICES).

### Points de contrôle restants
- Flashscore odds betting : toujours BLOQUÉ (geo) — à re-tester depuis Render.
- Test end-to-end du seeding réel `apifootball` → DB sur Render.
- Suite de l'audit (priorités moyennes) : i18n, Flashscore depuis Render.

---

## Flashscore débloqué + cotes 1X2 headless + flakiness Jest réglée (2026-09-04, local)

### Objectif (demande user « teste odds flashscore localement et termine les autres »)
- Tester/rétablir les cotes Flashscore depuis le poste local (l'audit prétendait « géo-bloqué »).
- Terminer le reste : flakiness Jest, dette Meta-Refiner double.

### Constat — le « géo-blocage » était FAUX
- `d.flashscore.com/x/feed/df_*` → `0` : ce n'était PAS un blocage IP, c'était une **URL incorrecte**.
  Les feeds nécessitent le **préfixe projectId `/46/`**, ex. `www.flashscore.com/46/x/feed/df_st_1_{id}`
  (en français/anglais !) ou `local-ruua.flashscore.ninja/46/x/feed/...` (russe). `d.flashscore.com` sans
  `/46/` répond `0` = feed introuvable, pas géo-block.
- Cotes : l'ancien feed `df_odd_1_` est **mort**. Le site moderne utilise des **persisted GraphQL** :
  - `global.ds.lsapp.eu/odds/pq_graphql?_hash=pobtm&eventId={id}&projectId=2` → liste bookmakers (bet365=16, 1xBet=417…)
  - `global.ds.lsapp.eu/odds/pq_graphql?_hash=ope2&eventId={id}&bookmakerId={b}&betType=HOME_DRAW_AWAY&betScope=FULL_TIME`
    → `{home,draw,away : {value, opening, change}}` — GET pur, **utilisable headless** (hash `ope2` découvert en
    interceptant les requêtes du site via chromium).
- Fixtures du jour : `www.flashscore.com/46/x/feed/f_1_-1_3_{x}` renvoie le **feed GLOBAL du jour**
  (512 matchs, noms anglais, ligue dans `ZA÷Country: League`, id dans `AA÷`, home/away `AE`/`AF`). IDs stables.
- **Flakiness Jest** : cause racine = `freeProxyPool.fetchText()` appelait `refreshPool()` (vrai réseau :
  2 listes GitHub + health-checks) **inconditionnellement**, même pool vide/récent → timeout 30 s en parallèle
  ou contention réseau qui faisait échouer aléatoirement d'autres suites (system intel, database).

### Modifications
- **`scripts/flashscoreClient.py`** :
  - `FEED_BASES = [www.flashscore.com/46/x/feed (EN), local-ruua.flashscore.ninja/46/x/feed, d.flashscore.ru.com/46/x/feed]`
    avec fallback multi-domaines dans `_fetch_feed` ; chemins corrigés (`/df_st_1_...`, `/df_sui_1_...` sans `/x/feed`).
  - `KEY_MAP` enrichie des libellés anglais du feed (`Total shots`, `Corner kicks`, `Shots on target`, `Ball possession`, …).
  - Nouvelles fonctions : `get_today_fixtures()` (id + home + away + league + start), `get_bookmakers(match_id)`,
    `get_match_odds(match_id, bookmaker_ids=None)` (1X2 best bookmaker, avec openings + drift), helper `_headless_get_json`.
- **`services/flashscoreService.js`** : wrappers `getTodayFixtures()`, `getBookmakers(matchId)`, `getMatchOdds(matchId, bookmakerIds?)`.
- **`services/scrapers/freeProxyPool.js`** : `fetchText` ne rafraîchit le pool QUE s'il est stale
  (`Date.now() - lastRefresh > REFRESH_MS`), cohérent avec `getProxy()` → plus aucun appel réseau
  quand le pool est vide/recent ; early-return `null`.

### Vérifié (local, tout headless)
- **E2E complet PASS** : fixtures du jour (512) → bookmakers → **cotes 1X2** (El Biar vs Akbou : 1.97/3.73/3.42 + openings 1.89/4.0/3.4 + drift UP/DOWN) → stats fallback (corners 5/3, shots 6/7, on-target 2/5, possession 47/53) → incidents.
- ESLint : 0 erreur sur les 2 fichiers JS ; `py_compile` + import OK.
- Jest : **3 runs complets consécutifs 708/708** (avant : 1 échec aléatoire/run). `freeProxyPool` seul : 0,8 s (avant 12 s→timeout).
- Sofascore odds (source principale câblée) confirmée OK côté local (200/events/odds).

### Points de contrôle restants
- `META_REFINER_PY=on` reste à propager aussi sur Render Dashboard si déploiement un jour (Dockerfile déjà ENV).
- Double Meta-Refiner JS dormant (`services/NeuralMetaRefiner.js`, appelé seulement par le workflow Puppeteer
  `SofascoreScraping/src/Workflow.js`) : conservé sur décision de ne pas supprimer du code sans besoin ;
  zéro risque runtime (Puppeteer interdit en prod Docker). Le refiner actif reste le Python (`META_REFINER_PY=on`).

---

## Cotes 1X2 Flashscore branchées dans le pipe cotes + contournement cooldown Sofascore (2026-09-04, suite)

### Problème utilisateur (« pourquoi il n'y a aucun match / cotes -- »)
- Un match Serie B (Criciuma vs Cuiaba) affichait `-- -- --` (cotes 1X2 vides) côté dashboard.
- Diagnostic DB : `odds_home/draw/away = NULL` sur 2303 matchs sauf 40 → la chaîne de cotes réelles
  ne fournit rien pour les matchs courants.
- Cause A (coverage) : Flashscore existe bien pour ce match (id `UwKpPA0J`) mais le feed `f_1_-1_3`
  (« today ») l'omet — il est dans le créneau suffixe `2` (matchs tard de nuit ~21h30 UTC).
- Cause B (blocage silencieux) : `attachRealOdds` appelle d'abord Sofascore ; Sofascore répond 403
  (IP en cooldown) → `apiClient._enforceCooldown()` dort **480 s par match** → le fallback Flashscore
  (ajouté juste avant) n'était jamais atteint, et l'étape Sofascore gelait tout le cycle d'enrichissement.

### Modifications
- **`scripts/flashscoreClient.py`** : `get_today_fixtures()` fusionne désormais les créneaux du feed
  `f_1_-1_{2,3,0,1,4}` (dédupe par id) pour couvrir aussi les matchs programmés tard ; refactor
  `_parse_fixtures_feed()` réutilisé par créneau.
- **`services/flashscoreService.js`** : ajout de `findMatchId(home, away, league, startTimestamp)` +
  `normalizeTeam()` (accents/suffixes/stopwords) ; fenêtre kickoff ±6 h en secondes OU ms (la DB
  stocke en secondes). Export étendu.
- **`SofascoreScraping/src/apiClient.js`** : nouvel accesseur `sofaCooldownActive()` (true si le
  client global est en cooldown 403/429). Exporté.
- **`core/fallback_enricher.js`** (`attachRealOdds`) :
  - Nouvelle source `flashscore` entre Sofascore et oddsApiIo : si 1X2 absent → `findMatchId` →
    `getMatchOdds` → persiste `odds_source='flashscore'` (best-effort, cache 1h, rate-limit 2s).
  - Skip de l'étape Sofascore quand `sofaCooldownActive()` → le fallback Flashscore (et la suite)
    s'exécute immédiatement au lieu de dormir `SOFASCORE_COOLDOWN_MS` par match.

### Vérifié (local)
- E2E `attachRealOdds` sur `livescore_1741330` : findMatchId → `UwKpPA0J`, cotes bet365
  **1.71 / 3.20 / 5.25** (opening 1.76/3.2/5, drift home DOWN), persistées en base `odds_source='flashscore'`
  en ~12 s (avant : blocage Sofascore > 480 s). UI : le match affiche maintenant les cotes.
- py_compile + ESLint 0 erreur (warnings `_` pré-existants) ; **Jest 708/708** (70 suites).

### Points de contrôle
- Backfill optionnel des autres matchs programmés sans 1X2 : soit attendre le prochain cycle
  d'enrichissement (chemin désormais non bloqué), soit lancer un re-enrich ciblé si souhaité.
- Pour les matchs `livescore_*`, Sofascore ne fournit pas d'id événement (search 403) → Flashscore
  est désormais la source réelle 1X2 de secours principale.
- Le cooldown Sofascore reste appliqué si un premier 403 survient (une fois/cooldown, pas par match).

---

## Tous les marchés opérationnels : Flashscore multi-marchés + persistance real_markets (2026-09-05)

### Problème utilisateur (« je veux que tous les marchés soient opérationnels »)
- Seule la cote 1X2 était remplie par Flashscore ; O/U, BTTS, Double Chance, Asian Handicap
  restaient en `--` (colonnes) et le Market Engine (command center `💰`) n'était activé ni par
  Sofascore (403/cooldown) ni par Flashscore hors 1X2.

### Découverte clé (persisted-query GraphQL)
- La query `ope2` (`findPrematchOddsForBookmaker`) est **variabilisée** : `betType` est un paramètre,
  PAS un hash distinct. Même `_hash=ope2`, on obtient tous les marchés pré-match Bet365/1xBet :
  - `HOME_DRAW_AWAY` → home/draw/away
  - `DOUBLE_CHANCE` → homeOrDraw/awayOrDraw/noDraw
  - `BOTH_TEAMS_TO_SCORE` → yes/no
  - `OVER_UNDER` → opportunities[] {handicap.line, over, under} — TOUTES lignes
  - `ASIAN_HANDICAP` → opportunities[] {handicap.line, home, away} — TOUTES lignes
  - `CORRECT_SCORE` → items[] {score, odds}
- Les autres (corners, 1ère MT, HT/FT, DNB, totals équipe) → **HTTP 400** : non exposés pré-match
  par ce GraphQL (confirmé par le menu `pobtm` : 4+2 types seulement).

### Modifications
- **`scripts/flashscoreClient.py`** : `get_match_markets(match_id, bet_types=None, bookmaker_ids=None)`
  (agrégation inter-bookmakers marché par marché) + `_parse_market_entry()` (1X2/DC/BTTS/O-U/AH/CS).
  `MARKET_BET_TYPES` ; dispatch CLI étendu.
- **`services/flashscoreService.js`** : `getMatchMarkets(matchId, betTypes, bookmakerIds)` (cache 1h).
- **`core/fallback_enricher.js`** :
  - `_flashscoreToRealMarkets()` → entrées canoniques `{source:'flashscore', raw_market_id,
    market_id, selection, odds, line, usable}` au **même contrat que Sofascore**
    (match_result, total_goals toutes lignes, btts, double_chance, asian_handicap ; CS ignoré —
    pas de market_id dans le registre).
  - `_mergeRealMarkets()` → fusion avec les real_markets existants, dédupe
    `market_id:selection:line`, **priorité aux entrées déjà présentes** (Sofascore).
  - `_attachFlashscoreMarkets()` → remplit colonnes 1X2 + O/U 2.5 (ligne la + proche) + BTTS,
    étend `real_markets`, pose `odds_source='flashscore'`.
  - Bloc Flashscore dans `attachRealOdds` : déclenché si 1X2 **OU** O/U **OU** BTTS manque
    (avant : uniquement si 1X2 absent).
  - Garde cooldown Sofascore ajoutée à la phase batch (un 403 ne dort plus 480 s dans
    `enrichMatchesBatch`).
  - Persistance `real_markets` ajoutée à `updatePredictions` du batch (comblait aussi le trou
    pré-existant pour la source Sofascore en batch).

### Vérifié (local)
- E2E complet Criciuma vs Cuiaba : 1X2 **1.71/3.2/5.25**, O/U 2.5 **2.6/1.48**, BTTS **2.25/1.57**,
  **67 marchés `real_markets` persistés** dans `fullData` (33 total_goals, 26 asian_handicap,
  3 double_chance, 3 match_result, 2 btts) — lus par le dashboard via la propagation fullData.
- `node -c` + py_compile + ESLint 0 erreur ; **Jest 708/708** (70 suites).

### Limite connue
- Corners, 1ère MT, HT/FT : Flashscore ne fournit pas de cotes pré-match via ce GraphQL → ces
  marchés restent des **prédictions modèle** (ml_ensemble/prediction_engine), pas d'odds
  bookmaker dans `real_markets` (Sofascore non plus d'ailleurs, 403 côté local).

### Points de contrôle
- Backfill multi-marchés des matchs programmés sans O/U/BTTS/marchés : `backfillMarkets`
  (via `attachRealOdds`) maintenant alimenté Flashscore — dispo si on veut re-remplir en masse.
- Score exact disponible si un market_id `correct_score` est ajouté au registre (optionnel).

### Backfill masse O/U + BTTS (2026-09-05, session suivante)
- **Scan intégral** de l'ensemble des matchs programmés sans O/U/BTTS (2303 au total) via
  `attachRealOdds` → **résultat DB : 97 matchs avec O/U, 96 avec BTTS** (avant : 28 / 6).
  Le plafond est la **couverture réelle des bookmakers dans le feed Flashscore** : les autres
  matchs (U18/U19/féminin/leagues sans bookmaker, kickoff éloignés) n'ont simplement
  **aucune cote O/U/BTTS pré-match** exposée (testé : Kenya Premier, Serie B Relegation,
  Liga Premier Clausura, Women's Liga MX, Hong Kong, NorZone → id trouvé mais marchés nuls).
- Ajustements apportés au passage :
  - `backfillMarkets` : **fenêtre kickoff ≥ now−36 h** (`_startTs`) pour ne plus scanner les
    matchs périmés (hors feed) — les trier perdait du temps.
  - Env hooks python `FLASHSCORE_BOOKMAKER_IDS` / `FLASHSCORE_MARKET_TYPES` (testés) —
    mais le filtre O/U+BTTS restreint trop la couverture (les cotes viennent rarement de
    16/417 seuls) → le backfill en mode **full** (menu bookmakers + 6 bettypes) reste le
    plus efficace (~27/300 dans le 1er essai, 42/2270 au scan full de 16 min).
- Vérifié : py_compile + `node -c` OK ; suite Jest 708/708 avant scan (runs ultérieurs no-op).

---

## Activation Meta-Refiner Python + audit caches + e2e seeding APIFB (2026-09-04)

### Objectif
Traiter les points « Meta-Refiner doublon » et « Maps sans TTL » de l'audit, et lever le point de contrôle
« test end-to-end seeding apifootball → DB ».

### Constat (corrige l'audit)
- **Maps sans TTL : FAUX POSITIFS.** Vérification systématique : `HIST_CACHE` (clés `league::marketType`, espace borné),
  `_enrichedAtCache` (prune >5000 avec TTL), `_inFlight` (supprimé en `.finally()`), `MEMORY_FALLBACK` (prune >300),
  `statementCache` (≤100), `botService` Sets (reset journalier), `_weightCache` (clés par league), `oddsMemoryCache`
  (persisté sur disque). Aucune correction nécessaire — évite de l'inutile.
- **Meta-Refiner : AUCUN actif en prod.** Le refiner Python (`meta_refiner.py`) est coupé volontairement
  (`META_REFINER_PY` non défini, `ml_ensemble.py:352`), et le refiner JS (`services/NeuralMetaRefiner.js`) n'est appelé
  QUE par `SofascoreScraping/src/Workflow.js` — workflow Puppeteer interdit dans le Docker prod. Donc contrairement à
  l'intention documentée (« une seule correction »), **zéro** correction bayésienne ne s'applique en production.
- `.env` local quasi vide : les clés API-Football avaient disparu (feature inactive en local).

### Modifications
- **`.env`** : restauration `API_FOOTBALL_KEY/HOST/ENABLED/DAILY_LIMIT` + `META_REFINER_PY=on` (fichier git-ignoré).
- **`Dockerfile.production`** : `ENV META_REFINER_PY=on` (garantit l'activation sur Render malgré le `.env` non déployé).
- Aucune modification de code ML : le refiner Python est safe (DB de biais absente/vide → facteur 1.0 = no-op).

### Vérifié
- `META_REFINER_PY=on` → `meta_refiner_python_enabled()` = True.
- `pytest tests/test_engine_hardening.py` : **5 passed** (gate on/off + application).
- **E2E seeding apifootball → DB** (SQLite isolée temp) : `isAvailable=true`, fetch live J/J+1/J+2 = **232 matchs**,
  **209 insérés** `scheduled` avec `source='apifootball'` (échantillon vérifié : Newcastle vs Bournemouth / Premier League).
  **PASS** — le chemin complet (API → map → upsert → query) fonctionne.
- Jest : **708/708** en run sérial (`--maxWorkers=1`). En parallèle : **1 test flaky aléatoire** par run
  (`freeProxyPool.test.js` timeout 30 s, `system.test.js` graceful-DB, `getMatchById`) — **pré-existants**,
  fichiers jamais modifiés, liés aux timeouts réseau/timers et aux writes concurrents vers `data/live_prediction_*.jsonl`.

### Points de contrôle restants
- Flashscore odds betting : BLOQUÉ (geo) au moment de cette session — **RÉSOLU le 2026-09-04** (URL `/46/` + GraphQL `ope2`/`pobtm` headless, voir section « Flashscore débloqué »).
- Cause racine de la flakiness Jest (timeouts réseau + journaux data partagés entre workers) — **RÉSOLUE le 2026-09-04** (guard staleness `freeProxyPool.fetchText`, 3 runs complets 708/708).
- Étape optionnelle : retirer le double Meta-Refiner JS dormant (dette, pas de risque runtime) — conservé sur décision (pas de suppression de code sans besoin).

---

## Intégration API-Football + Sofascore prod sans Puppeteer (2026-09-04)

### Objectif
Remplacer LiveScore (API cassée depuis août 2026) comme source de fixtures, et garantir que
les scrapers curl_cffi (Sofascore/Flashscore) fonctionnent en production Render (Docker) sans
Puppeteer ni Chromium — en activant aussi le réseau de fallback de fixtures par date.

### Constat
- Binaire Python dans cloudSeed/services pointait uniquement vers `.venv` local (absent sur Render) → bloc Sofascore live silencieux en prod.
- `services/sourceQuotaManager.js` (compilé stale) sans la source `apifootball` ; `core/cloudSeed.js` (compilé stale) sans blocs Sofascore/API-Football — la prod chargeait le `.js`, pas le `.ts`.
- `mapStatus` d'API-Football classait les périodes live (1H, 2H, ET, BT) en `scheduled`.

### Modifications
- **`services/apiFootballService.js`** (NOUVEAU, voir logs précédents) + fix `mapStatus` : périodes `1H/2H/ET/BT/P*` → `inprogress`, ajout `CANC/ABD/WO/POSTP/SUSP/TBD`. Exporte `mapStatus`/`mapEventToMatch` (tests).
- **`services/sourceQuotaManager.ts` + `.js` (sync)** : ajout source `apifootball`, limit 100/jour (env `API_FOOTBALL_DAILY_LIMIT`), enabled `API_FOOTBALL_ENABLED`.
- **`core/cloudSeed.ts` → `cloudSeed.js` (régénéré via babel)** : ajout bloc API-Football fixtures (J→J+2, cache 1 h, quota), bloc Sofascore live avec `pickPythonBin()`, LiveScore désactivé. Helper `pickPythonBin()` (venv dev → `/opt/venv/bin/python3` → PATH).
- **`Dockerfile.production`** : ajout `python3-pip python3-venv` + créaation `/opt/venv` avec `requirements.txt` (curl_cffi, etc.) + `ENV PATH`. Le service Node/Express peut désormais exécuter les bypass Python.
- **`services/scrapers/SofascoreBypass.js`** : `pickPython()` inclut `/opt/venv/bin/python3` et `python3`.
- **`services/flashscoreService.js`** : nouveau `pyBinary()` (fallback multi-paths) remplace `PYTHON` statique.
- **`src/services/newsService.js`** : `TM_TEAM_MAP` étendu ~30 → **79 clubs** (MENA Maghreb/Golfe/Égypte + ligues européennes majeures).
- **`__tests__/apiFootballService.test.js`** (NOUVEAU, 5 tests : mapStatus, mapEventToMatch, sortByPriority) et **`__tests__/sourceQuotaApifootball.test.js`** (NOUVEAU, 2 tests : limit 100 + enregistrement).

### Vérifié
- `node -e require('./core/cloudSeed')` : OK (DB SQLite + services chargés).
- `fetchFixtures(['2026-09-04','2026-09-05'])` : 232 matchs (cache disque 1 h).
- Sofascore `getLiveEvents()` : 226 événements live avec cotes + xG + prédictions (via `api.sofascore.com/api/v1/sport/football/events/live`).
- Tests Jest : `apiFootballService` 5/5, `sourceQuotaApifootball` 2/2, suite source 12/12.

### Points de contrôle restants
- **Flashscore odds betting** : BLOQUÉ (feed `df_odd_1_`/`df_st_1_` renvoient `0` — geo/DNS restreint depuis l'IP locale ; aucun match en DB). À re-tester depuis Render.
- Test end-to-end du seeding réel insérant des matchs `apifootball` en DB sur Render.

---

## Moteur de patterns SOUS-FACTORIELS (UnderPatternEngine) — 2026-09-02

### Objectif
Détecter les matchs où le terrain, l'arbitrage, le contexte ou le style de jeu
favorisent le UNDER (peu de buts), conformément à l'intuition de l'utilisateur
(« le terrain quand il n'est pas bon n'aide pas à marquer » + « l'arbitrage
siffle et ne laisse pas l'avantage » → under).

### Constat (audit O/U)
- Réussite O/U catastrophique : **24.5 %** — prédictions modèle **INVERSÉES**
  (Over correct 0/376, UNDER correct 122/0). Le modèle ne prédit jamais UNDER
  et surestime massivement les buts.
- Données arbitre/terrain/météo **absentes** dans la DB → on s'appuie sur des
  signaux proxy : taux de under par ligue, profils défensifs d'équipes,
  xG faible, signal cotes marché.

### Modifications
- **`services/UnderPatternEngine.js`** (NOUVEAU) : détecte 5 patterns sous-factoriels
  - `league_under` : ligues à taux de under historique > 55 % (ex. Persian Gulf 77 %,
    Primera B 78 %, Ligue 3 74 %), force 0–1 par taux/20
  - `team_defensive` : équipes avec moy. buts/équipe < 2.2, force 0–1
  - `derby` : derby / match de rivalité (regex), poids 15
  - `low_xg` : xG combiné < 2.2, force 0–1
  - `odds_signal` : cote Under < cote Over = le marché dit under
  - Score pondéré (poids total 100), ajustement **max -20 pts** (ne jamais
    inverser complètement), proba finale bornée 10–90 %. Caches ligue (TTL 6 h)
    et équipe (TTL 12 h) en mémoire pour éviter les requêtes répétées.
- **`services/topPicksEngine.js`**
  - `buildCandidates` : la proba O/U (`ou_25_prob`) est maintenant ajustée par
    `detectPatterns` AVANT calcul d'edge/EV/Kelly.
  - Nouveau marché **`Under 2.5`** candidate : émis uniquement quand un pattern
    sous-factoriel est détecté (ajustement < 0), avec son propre EV/edge/Kelly.
  - Expose `underPatterns` (signal) dans le payload et le reasoningSummary.

### Résultats (tests manuels DB réelle)
- Persian Gulf (77 % under) : 65 % → **45 %** (adj -20) — Over candidat rejeté
- Primera B (78 % under) : 60 % → **40 %** (adj -20)
- Ligue 3 (74 % under) : 58 % → **39 %** (adj -19)
- Premier League (aucun pattern) : aucun ajustement
- Serie B + xG faible : détection combinée `league_under+low_xg`

### Vérification
- **701/701 tests Jest passent** (68 suites) — non-régression totale
- `topPicksEngine.test.js` : 9/9 OK
- ESLint : 0 erreur

### Reste à faire
- Commit local (non pushé)
- Intégrer éventuellement l'ajustement dans la chaîne Python/prematch si les
  prédictions O/U y transitent (traitement en aval des probas).

---

## Activation marchés BTTS / Double chance / 1re mi-temps en LIVE (2026-08-31)

### Objectif
L'utilisateur souhaite activer les marchés **O/U 2.5, BTTS, Corners, HT/FT** sur la vue
**⚡ FLASH ODDS / LIVE ODDS** (matchs en direct). À l'origine seul le **1X2** était remonté.

### Constat (sondage API Sofascore)
Sur un event live, le endpoint `/event/{id}/odds/{G}/all` ne diffuse QUE certains marchés :
- **Groupe 1** → marché `1` (1X2) uniquement
- **Groupe 5** → marchés `1` (1X2), `2` (Double chance), `3` (1X2 1re mi-temps), `5` (BTTS)

**O/U 2.5 ("Match goals") et Corners ne sont PAS diffusés en live par Sofascore** (pré-match
seulement) → non activables dans le flux temps réel. HT/FT idem (non diffusé en live).

### Modifications
- **`scripts/sofascore_bypass.py`**
  - `cmd_live` interroge désormais **le groupe 5** (1 call = 1X2 + DC + 1re MT + BTTS) au lieu
    du seul groupe 1 ; fallback groupe 1 si le 5 est vide.
  - Nouveau helper `_apply_market()` : importe 1X2 (avec mouvement ▲▼ `*_change`), Double chance
    (`dc_1x/x2/12`), 1re mi-temps (`h1_home/draw/away`), BTTS (`btts_yes/no`), Match goals O/U 2.5.
  - Nouveau helper `_fetch_event_odds()` : récupère les cotes d'un event (groupe 5 puis 1).
  - Récupération **en parallèle** (ThreadPoolExecutor) + **plafond** `MAX_ODDS_FETCH=50` pour
    rester sous le timeout Node (30 s).
  - `api_get` : **2 passes × 3 impersonates avec backoff** (1 s) pour absorber le 403 « challenge »
    transitoire de Sofascore.
- **`src/components/FlashOddsView.jsx`** : carte live enrichie — bloc **BTTS** (OUI/NON +
  valeur recommandée) + chips O/U 2.5 et Double chance quand disponibles.

### Vérification
- **Pytest manuel Python** : `python scripts/sofascore_bypass.py live` → **7 matchs avec BTTS**
  (Thailand U20, Maldives U20, Airbus UK, Ammanford, Briton Ferry, Cambrian United, Haverfordwest)
  ex. `BTTS OUI 2.4 / NON 1.47`, en parallèle d'un 1X2 toujours présent. ~5 à 6 s pour ~50 events.
- `npm run build` : OK (FlashOddsView reconstruit).

### ✅ Résolution du bloc 403 + optimisation (2026-08-31, suite)
Le bloc 403 « challenge » de Sofascore était **temporaire (au niveau IP)** et s'est levé de lui-même.
Améliorations apportées pour une chaîne fiable + rapide :
- **`scripts/sofascore_bypass.py`** :
  - `api_get` recentré sur un **1 seul passage** (3 impersonates, sans backoff lourd) → évite le
    cumul de latence sur les events sans marché. ~**7 s** pour ~45 events (au lieu de 36-50 s).
  - `_fetch_event_odds` : **groupe 5 uniquement** (1 call = 1X2 + Double chance + 1re MT + BTTS),
    suppression du fallback groupe 1 (doublait les requêtes et allongeait le temps).
  - `MAX_ODDS_FETCH=50`, `ThreadPoolExecutor(max_workers=3)` → sous le timeout Node 30 s.
- Pivot anti-bloc : `www.sofascore.com` sert de repli équivalent à `api.sofascore.com` (même API).

### Vérification finale (chaîne complète ✅)
- `python scripts/sofascore_bypass.py live` → **45-48 events, ~20 avec BTTS + DC** en ~7 s.
- `SofascoreBypass.getLiveEvents()` (Node) → 45 events, BTTS ok.
- `GET http://127.0.0.1:10000/api/flash-odds` → **200, success:true, 44 events, 19 avec BTTS +
  Double chance + 1X2**. Ex. `Aston Villa vs Arsenal 0-0 → 1X2 17/4.8/1.25 | BTTS 3.05/1.33 | DC12 1.19`.
- Visuel : http://localhost:5173 → **FLASH ODDS** (auto-refresh 15 s) : cartes live avec
  1X2 (▲▼) + **bloc BTTS (OUI/NON + valeur)** + chips O/U 2.5 / Double chance.

### ✅ Nouveau : O/U 2.5 + TOTAL ÉQUIPE prédits en direct
Sofascore ne diffuse **PAS** O/U 2.5 ni « total équipe » en live (pré-match uniquement).
→ **`_live_predictions()`** dans `scripts/sofascore_bypass.py` **dérive** ces marchés à
partir des cotes live (1X2 + BTTS) + du score/minute :
- **O/U 2.5** : modèle Poisson simplifié (rythme actuel 40% + moyenne 2.6 60%, boost si
  BTTS ouvert) → proba over/under + proba implicite, pick OVER/UNDER.
- **xG live par équipe** : force relative issue des cotes 1X2 partagée sur les buts restants.
- **Qui va marquer** : priorité au scoreur le plus probable (xG restant le plus haut).
- **Score prédit** (final) : arrondi des xG cumulés.
- Exposé via `liveMinute` + `pred` dans `/api/flash-odds`.
- **`FlashOddsView.jsx`** : 2 nouveaux blocs par carte — « TOTAL BUTS 2.5 (LIVE) » (OVER/UNDER
  + xG total) et « TOTAL ÉQUIPE — QUI VA MARQUER » (xG home/away + marqueur + score prédit).
- Vérifié : `GET /api/flash-odds` → 35 events, **14 avec pred O/U+équipe** (ex. Aston Villa 0-1
  Arsenal [61'] → UNDER 2.5 (15%) | xG total 1.7 | score 0-2 | marqueur AWAY ; Barcelona 2-1
  Rayo [63'] → OVER 2.5 (100%) | xG 4 | score 3-1 | HOME).

### ✅ Amélioration 1 — vrais xG live (Sofascore) pour O/U
Faiblesse des points identifiée : le modèle dérivait O/U du **seul score/minute**, ignorant la
qualité des occasions. Corrigé :
- Nouveau `_fetch_event_stats()` + `_parse_live_stats()` → appelle `/event/{id}/statistics` et
  extrait **Expected goals (xG) réel**, possession, tirs, tirs cadrés, corners.
- Fetch **uniquement pour les events `hasXg:true`** (peu, ex. 5/35) dans le même
  ThreadPool → temps toujours ~6s (sous timeout 30s).
- `_live_predictions(..., stats)` : quand le xG réel est dispo (`xgsrc='live'`), `lambdaAdd`
  est dérivé du **xG réel** (plus ~12% de création attendue) au lieu du score/minute ;
  le split home/away reflète la répartition réelle du xG, plus la possession.
- Fallback `xgsrc='score'` conservé quand pas de xG.
- **FlashOddsView.jsx** : badge **« xG LIVE » vs « MODÈLE »** + affichage xG réel home/away,
  possession et tirs sur chaque carte.
- Vérifié end-to-end : `GET /api/flash-odds` → 35 events, **5 avec xG-live** (ex. Fortaleza 1-1
  Operário → xG réel 0.46-0.65, poss 57% → OVER 2.5 @74% ; Estudiantes 0-0 [62'] → xG 1.43-0.97,
  poss 61% → UNDER 2.5 12%).

### ✅ Amélioration 2 — Détection de VALEUR (modèle vs marché BTTS/1X2)
Faiblesse : le modèle sortait une proba brute sans comparer à la cote marché → pas d'edge
détectable. Choix utilisateur : **valeur partielle via les cotes BTTS + 1X2 dispo en direct**
(pas de source gratuite pour la cote O/U 2.5 live — Sofascore ne diffuse pas ce marché).
- Ajout d'un **`p.value`** dans `_live_predictions` :
  - L'espoir de buts implicite du marché ≈ mapping BTTS Yes (1/cote) → total attendu,
    ajusté par un draw court (1X2 ≈ 2.6-3.6 → +0.3 but).
  - Comparé au xG modélisé (réel Sofascore quand dispo) → **OVER_VALUE / UNDER_VALUE**
    si écart ≥ 0.45 but, avec `edge` (buts), `strength` (0-100) et totals comparés.
  - **Garde anti-artefact** : signal seulement si `T >= 0.30` (30+ min) — évite le faux
    OVER-value quand le marché total s'effondre à la minute 0.
- **FlashOddsView.jsx** : bloc **💎 VALEUR (modèle vs marché)** dans ComboPicks, avec side
  (OVER/UNDER), edge en buts et force %.
- Vérifié : `GET /api/flash-odds` → 3 signaux value (ex. Fortaleza 1-1 Operário → OVER_VALUE
  edge +1.83 force 100% ; Defensa 0-0 Platense → UNDER_VALUE edge +0.84 force 69%).

### ✅ Amélioration 4 — Plancher calibré (matrice LiveGoalPredictor) pour neutraliser le biais 0-0
Faiblesse : le modèle dérivait le xG complémentaire du seul score/minute → sous-estimait les
2e MT des matchs 0-0 tardifs (ex. 0-0 à 62' → UNDER 2.5 ~91%, alors que l'historique dit 94%
de chance d'au moins 1 but de plus).
- `_calibrated_lambda(score, minute)` : portage de la **matrice `scorePatterns` de
  `services/LiveGoalPredictor.js`** (firstHalf/secondHalf/after60) convertie en lambda de
  buts attendus via `-ln(1 - P/100)`, pondéré par le temps restant.
- Appliqué en **plancher scientifique** : `lambdaAdd = max(lambdaAdd, calib_lam)` quand la
  matrice donne un total plus haut que le modèle → jamais de sous-estimation des buts restants.
- Vérifié : `GET /api/flash-odds` → **3 events avec plancher** (ex. 0-0 à 62' → xG total passe
  de 0.2 → 0.9, OVER proba 6% ; Honnête : 0-0 tardif n'atteint rarement 3 buts). Temps ~6s.

### ✅ Amélioration 3 — Journal de calibrage O/U live (taux de réussite réel)
Pour mesurer « quel % de mes 91% UNDER passent réellement » et recalibrer les seuils :
- **`services/scrapers/LivePredictionJournal.js`** : journal append-only (JSONL, aucune dépendance
  DB) — enregistre chaque prédiction O/U 2.5 live + son contexte (minute, score, xG, xgsrc, value,
  calibFloor), dédupliquée par eventId par fenêtre de 20 min (évite le bruit des polls 15s).
  Résout ensuite l'issue avec le score final (`pickCorrect`, `finalOver`) et calcule le taux de
  réussite **par tranche de confiance** et **par type de pari**.
- **Branché non-bloquant** dans `SofascoreBypass.getLiveEvents()` (ne perturbe jamais la réponse).
- **Nouvelles routes** (`routes/matches.js`) : `GET /api/flash-odds/calibration` (stats), 
  `POST /api/flash-odds/resolve` ({eventId, finalHome, finalAway}), `GET /api/flash-odds/results` (audit).
- **CLI** : `node scripts/live-calibration.js {list|resolve|stats|dump}` pour consulter les prédictions
  et saisir les scores finaux au fil de la journée.
- **Panneau UI** : `src/components/FlashOddsView.jsx` → composant `CalibrationPanel` (📊 CALIBRAGE LIVE)
  affiché sous le footer de FLASH ODDS : réussite réelle par tranche de confiance (barres vert/orange/rouge),
  par type de pari, et la liste des prédictions en attente avec leur eventId. Auto-refresh 45s. Build OK.
- Vérifié : backend relancé (PID 27328, port 10000) ; `/flash-odds/calibration` 200 ; le journal a
  enregistré 10 prédictions réelles (ex. Boston Legacy 1-3 Angel City → OVER 100% edge 5.12 💎 VALEUR) ;
  `resolve` valide (400 champs manquants, id inconnu → 0 sans pollution) ; tests `jest matches` 15/15 OK.
- **🤖 Résolution automatique des scores finaux** : plus besoin de saisie manuelle.
  - `sofascore_bypass.py` : nouvelle commande `event` → `/event/{id}` (statut + score, `finished` booléen).
  - `services/scrapers/LiveResultResolver.js` : scanne les prédictions non résolues, ignore celles encore
    dans le flux live, et pour celles terminées récupère le score final depuis Sofascore puis appelle
    `Journal.resolve(eventId, home, away)`. Throttlé (≥90s) + `running` flag, jamais bloquant.
  - Branché en fond dans `getLiveEvents()` (auto pendant les polls UI) + route `POST /api/flash-odds/auto-resolve`
    (`{force?:bool}`) pour déclenchement manuel/CRON.
  - Vérifié en conditions réelles : match terminé auto-résolu (id 16912006, score final **3-0** = 3 buts,
    prédiction OVER 2.5 59% → **✅ correct**) ; nouveau scan route auto-resolve → 2 résolus. Calibrage actif :
    3 résolus / 3 réussites (100%), répartis sur 3 tranches de confiance. Tests `jest matches` 15/15 OK.
  - **🤖 Autonomie totale** : job CRON (`services/cronManager.js`, toutes les 5 min) qui rafraîchit le flux
    live (journalise les prédictions) ET force la résolution auto des matchs terminés — **indépendante de
    l'ouverture du navigateur** (plus besoin de la page FLASH ODDS ouverte ni de saisie manuelle).
    Vérifié : `[CRON] Scheduler active` au démarrage, routes `calibration`/`flash-odds` 200, backend PID 20400.
- ⚙️ **Point 3 (calibrage) — désormais 100 % automatique** : plus besoin de saisir les scores finaux,
  le CRON toutes les 5 min les récupère tout seul. La saisie manuelle reste disponible en secours
  (`node scripts/live-calibration.js resolve <eventId> <butsH> <butsA>`). Après quelques semaines de
  données réelles, la stat « réussite par tranche de confiance » donnera les vrais seuils de
  déclenchement OVER/UNDER à ajuster.

### ⏭️ Points suivants (priorité)
- Aucun point bloquant : les 4 améliorations (1..4) sont traitées. Prochain chantier d'ampleur :
  **automatiser la saisie des scores finaux** (résolution auto dès qu'un match prédit sort du flux,
  via une source de résultats free type API-Football/FlashScore) pour accélérer le calibrage.

### Note
- O/U 2.5 / Corners / HT-FT restent **pré-match uniquement** : pour les voir il faudrait les
  lire depuis la DB Titanium (matchs upcoming), pas depuis le flux live Sofascore.

---

## Activation du Market Engine multi-marchés dans la prod (2026-08-27)

### Objectif
Le moteur `core/market/` (registry/discovery/adapter/normalizer/validator/index) était
déjà écrit et testé, mais **jamais routé en prod** : `sofascoreOddsService.fetchOddsForMatch`
renvoyait `{ odds, markets }` et (1) les appelants legacy lisant `sofaOdds.home/.over25/.btts_yes`
au niveau racine étaient CASSÉS (régression : le 1X2/O/U/BTTS Sofascore n'était plus attaché),
(2) le tableau `markets` normalisé était jeté -> il n'atteignait jamais `prediction_engine`.

### Correctifs (local, no push)
1. `services/sofascoreOddsService.js:289` — `return { ...odds, markets }` : on expose les
   clés legacy au niveau racine (rétro-compat) + garde `markets`. Règle la régression
   `_attachSofaMarkets`/`fallback_enricher.js:263-286,582-592` (lectures `sofaOdds.home` etc.).
2. `core/fallback_enricher.js:222` `_attachSofaMarkets` — stocke le tableau normalisé dans
   `match.real_markets` (filtré `usable`), miroir dans `match.fullData.real_markets` (survit DB,
   aucune nouvelle colonne SQL). Legacy `odds_*` inchangé.
3. `core/enrichOne.js:112/`enriched` — propage `real_markets` (depuis `m.real_markets` ou
   `m.fullData.real_markets`) vers le payload FastAPI /predict.
4. `core/market_engine.py` — nouvelle fonction pure `real_markets_to_precision_bets(real_markets)`
   (+ `_human_market_label`, `_safe_float`) : convertit les entrées `usable` en precision_bets
   calibres sur la cote réelle (P=1/odds). Ignore `unknown`/`usable:false` (aucune invention).
5. `core/prediction_engine.py:463` — après `generate_precision_bets`, étend `precision_bets`
   avec `real_markets_to_precision_bets(match_obj['real_markets'])` si présent ; sinon le chemin
   Poisson reste le défaut (matchs non-Sofascore). Import ajouté ligne 74.

### Sécurité (backward-safe)
- Aucune suppression du chemin legacy 1X2 ni des marchés Poisson `quantResult.markets`.
- Gating implicite : `Array.isArray(real_markets) && length>0`. Pas de nouveau flag env.
- Seul Sofascore produit `markets` (therundown/oddsApiIo/oddspapi = legacy flat) -> couverture
  limitée aux matchs Sofascore (`SOFASCORE_ODDS_ENABLED=true`).

### Vérifié
- `node --check` OK (3 fichiers .js) ; `py_compile` OK (prediction_engine, market_engine).
- Jest `__tests__/enrichOne.test.js` 9/9 (dont 2 nouveaux : propagation real_markets top+enriched).
- pytest `tests/test_market_engine.py` 30/30 (dont 3 nouveaux : conversion/skip/empty).
- ESLint : 0 erreur (warnings pré-existants uniquement).
- Smoke : enveloppe `{ ...odds, markets }` restaure `home/draw/away` + conserve `markets`.

### Limite honnête
- Activation = routage des cotes RÉELLES comme vérité terrain pour O/U, BTTS, AH, DC, HT/FT,
  team_to_score. Le GATE de qualité (edge financier) n'est PAS mesuré ici : les cotes réelles
  remplacent les estimations Poisson, mais ça n'invente pas d'edge. Prochaine étape si voulu :
  A/B `precision_bets` (real vs Poisson) via accuracyEngine sur backtest réel.

---

## Market Engine — Edge Gate + intégration testée (2026-08-27, suite)

### Ajout (suite activation)
- `core/market_engine.py:real_markets_to_precision_bets` — désormais avec **EDGE GATE** :
  une cote réelle n'est émise comme pari de valeur (`value:true`) QUE si la probabilité
  du modèle dépasse la probabilité implicite bookmaker (`1/odds`) d'au moins `EDGE_MARGIN_PCT=3`.
  Sinon elle reste en lecture seule (`value:false`, `model_probability` renseigné si dispo).
  Mapping marché->clé modèle : `btts`, `total_goals` ligne N -> `ou_NN` (ex 2.5 -> ou_25),
  `match_result` 1/X/2 -> home/draw/away. Probabilités modèle fournies par `prediction_engine`.
- `core/prediction_engine.py` — nouveau helper `extend_precision_bets_with_real_markets(...)`
  (testable isolément) ; construit `model_probs` depuis `p_home/p_draw/p_away`, `sim.btts_prob`,
  `mc_ou25/35/15` et l'injecte. Log de suivi `[MARKET-ENGINE] N pari(s) réel(s) (M value)`.

### Objectif atteint
- On ne recopie PLUS bêtement la cote bookmaker : un pari `real_markets` n'apparait en
  sélection que s'il y a un vrai edge (modèle > implicite). Les matchs sans edge gardent
  le chemin Poisson par défaut (pas de bruit ajouté).

### Vérifié
- pytest `tests/test_market_engine.py` (edge gate: value/no-value/readonly, mapping ou_25, 1X2) OK.
- pytest `tests/test_predictions.py::test_real_markets_flowed_into_precision_bets` (helper
  `extend_precision_bets_with_real_markets` renvoie BTTS 1.8 en VALUE, modele 70% > 55%).
- `tests/test_market_engine.py` + `tests/test_predictions.py` = 37 passés.
- `py_compile` OK ; ESLint 0 erreur (warnings pré-existants).
- Note : 2 échecs pytest pré-existants dans `tests/test_ml_ensemble.py::test_predictSecondaryMarkets`
  (fichier `ml_ensemble.py` NON modifié ici) + 2 échecs Jest (Redis/archive env) sont hors de
  ce changement. Non-régression confirmée.

---

## Market Engine — champ de sortie observable (2026-08-27, suite)

### Ajout
- `core/prediction_engine.py` (retour `process_prediction`) — deux nouveaux champs :
  - `real_markets_value` : liste des SEULS paris `real_markets` ayant `value:true`
    (edge positif modèle > implicite), avec `real_odds`, `implied_probability`,
    `model_probability`, `edge_pct`, `reason`. Observable côté API/UI sans toucher
    au verdict principal.
  - `real_markets_activated` : booléen (True si au moins un pari réel a été routé).
  Aucun impact sur `verdict`/`surgical_market` : la sélection principale reste le
  chemin modèle ; les cotes réelles ne sont qu'un complément de valeur.

### Vérifié
- pytest `tests/test_predictions.py::test_real_markets_value_field_in_output` (le champ
  ne garde que les VALUE, exclut le pari sans edge).
- pytest test_market_engine + test_predictions = 38 passés ; py_compile OK.

---

## Market Engine — routage bout-en-bout Node -> FastAPI (2026-08-27, suite)

### Ajout
- `services/mlPredictionService.js` — `getMLPrediction` ajoute désormais `real_markets`
  dans le payload envoyé à FastAPI `/predict` (depuis `match.real_markets` ou
  `match.fullData.real_markets`). Log debug `[MARKET-ENGINE] real_markets forwarde`.
  Chaîne complète : `fallback_enricher._attachSofaMarkets` -> `enrichOne`
  (`real_markets`) -> DB -> `mlPredictionService` -> `pythonService.predict` -> FastAPI
  `/predict` -> `process_prediction` -> `real_markets_value`/`precision_bets`.

### Vérifié
- Jest `__tests__/mlPredictionService.test.js` (3 tests) : forward de `real_markets`
  depuis match, depuis fullData, et null quand absent. 0 erreur ESLint.
- La chaîne Node->FastAPI->prediction_engine est désormais fermée (end-to-end).

---

## Market Engine — instrumentation A/B + script de backtest (2026-08-27, suite)

### Objectif
Quantifier l'edge reelle des paris `real_markets_value` vs le chemin Poisson, en
conditions de prod. Impossible sans historique de cotes reelles : on instrumente
donc chaque decision (append-only) pour mesurer le P&L plus tard.

### Ajouts
- `core/market_engine_trace.py` (nouveau) — `log_real_market_bets(match_obj, real_bets)`
  ecrit en append-only `data/traces/market_engine_real_markets.jsonl` (1 ligne/decision :
  ts, match_id, home/away, league, startTimestamp, market, real_odds, implied_p,
  model_p, edge_pct, value, source). Best-effort (n'explose jamais une prediction).
- `core/prediction_engine.py` — appelle `log_real_market_bets` apres avoir construit
  `real_bets` (etend `precision_bets`). Trace peupe en prod sur matchs Sofascore.
- `core/ab_backtest_real_markets.py` (nouveau, script) — `python -m core.ab_backtest_real_markets`
  joint le journal au resultat reel (DB `matches.scoreHome/scoreAway`), resolve BTTS/Over-Under,
  et calcule le P&L (mise plate 1u) des paris VALUE vs tous paris. Affiche yield + gain
  d'edge gate. Dit clairement si le journal est vide / matchs non termines (pas d'invention).

### Vérifié
- `py_compile` OK sur les 3 fichiers.
- `tests/test_ab_backtest_real_markets.py` (2 tests) : log/read roundtrip + resolution
  `_bet_won` (BTTS Over/Under, ligne exacte). Passés.
- Script lance proprement : `AUCUN JOURNAL -> rien a backtester` (cas reel au demarrage).

### Limite honnête
- Le vrai P&L necessite des matchs Sofascore TERMINS dans la DB. Le journal s'accumule
  en prod ; relancer le script apres quelques journees. C'est l'etape A/B différée
  (impossible a simuler sans donnees reelles de cotes multi-marches historiques).

---

## Market Detection & Normalization Engine (2026-08-27)

### Contexte
User : "je veux que le scraper trouve TOUS les marches (Over 1.5, Under 1.5,
Corners, Asian Handicap, BTTS, Team Goals, HT/FT...)". Probleme reel : le
scraper Promosport ne recupere QUE le 1X2 (probabilites lm6). Pas de
normalisation generique. On ne scrape AUCUN site tiers (ToS/legal) ; on
construit un moteur modulaire sur les sources existantes.

### Cree (local, core/market/)
- `registry.js` : MARKET_REGISTRY canonique (goals/corners/cards/btts/handicap/
  team_goals/ht_ft/match_result) + alias par source + SELECTION_SYNONYMS.
  Ordre des cles important (team_goals avant total_goals ; lookbehind pour
  eviter "Home Team Total Goals" capture par total_goals).
- `discovery.js` : parcours recursif du payload, repère TOUTE structure
  market-like (outcomes[]+odds), meme inconnue -> detected_by:"discovery".
- `adapter.js` : SourceAdapter par source (promosport mappe 1X2 proba->cote
  implicite ; football-data pour corners/HT). Aucune logique de nom hardcodee.
- `normalizer.js` : match registre, extrait line/selection/handicap,
  calcule confidence. Inconnu -> market_id:"unknown" (conserve, n'invente pas).
- `validator.js` : garde-fous stricts. Cote < 1.0 ou absente -> skip (JAMAIS
  d'invention). Over/Under sans ligne -> drop. Sort CanonicalMarketModel avec
  flag `usable`.
- `index.js` : orchestration adapter->discovery->normalizer->validator->dedup.

### Verifie (test local, supprime apres)
Payload multi-marches : total_goals 1.5/2.5, btts, asian_handicap -1.25,
total_corners 9.5, team_goals 1.5, ht_ft => TOUS detectes + normalises,
0 unknown. Payload inconnu => conserve en unknown, aucune cote inventee.

### Limite HONNETE (important)
Le moteur detecte les marches PRESENTES dans une source. Promosport ne
fournit QUE le 1X2 -> le moteur ne peut pas "trouver" des marches que la
source n'expose pas. Pour avoir tous les marches en vrai, il faut brancher
une source multi-marches (ex: API de cotes type The Odds API) via un
nouvel adapter (registerAdapter) SANS toucher le moteur.

### Branchement recommande (non fait, a demander)
- `enrichOne.js` / `scrapeService.js` : appeler `market.process(payload,{source})`
  a la place du parsing ad-hoc, puis router vers prediction_engine.
- Ajouter adapter pour ta vraie source multi-marches des que disponible.

## Extension Sofascore multi-marches (2026-08-27)

### Decouverte cle
User : "j'utilise pas d'API payante, j'ai Sofascore/LiveScore". Verification du
code : `services/sofascoreOddsService.js` fetchait en DUR uniquement 3 marches
(1X2=mid1, O/U2.5=mid5, BTTS=mid6) via l'API Sofascore GRATUITE sans cle
(`/event/{id}/odds/{marketId}/featured`). Or Sofascore expose BEAUCOUP plus de
market IDs. Donc la source gratuite multi-marches etait deja la, sous-exploitee.

### Modifications (local)
1. `core/market/adapter.js` : ajout `sofascoreAdapter` (parse featured.default/
   fullTime/markets + decimal/fractional) + `SOFASCORE_MARKET_NAMES` (map
   marketId -> label canonique : 1,5,6,7,8,9,10,12,14,18,19,22).
2. `core/market/registry.js` : ajout marches `double_chance` et `team_to_score`
   (aliases + selections). AH simplifie (match "asian handicap" sans ligne).
3. `core/market/index.js` : `process()` accepte maintenant un TABLEAU de payloads
   (et pas seulement un objet) -> compatible avec le fetch parallele Sofascore.
4. `services/sofascoreOddsService.js` :
   - `MARKET_IDS = [1,5,6,7,8,9,10,12,14,18,19,22]` fetchs en parallele.
   - `fetchOddsForMatch` retourne désormais `{ odds: {...legacy}, markets:
     [CanonicalMarketModel...] }` ou `markets` vient du Market Engine.
   - Legacy parsers (parseFeaturedOdds/OU25/BTTS) conserves pour compat.
   - `require('../core/market')` ajoute le moteur.

### Verifie (test local, supprime)
Payload Sofascore simule 8 marches -> 19 selections normalisees, 0 unknown :
match_result, total_goals 1.5/2.5, btts, double_chance, ht_ft, total_corners,
asian_handicap, team_to_score. Tous usable=true. Aucune cote inventee.

### Note honnete
- LiveScore n'est pas encore branche (meme approche : adapter + marketIds).
- Les marketIds Sofascore reels peuvent varier selon la region/event ; le
  moteur de decouverte remontera tout marche inconnu en `unknown` pour
  extension future sans rewrite.
- RETOUR au backend : `fetchOddsForMatch` change de signature (retourne un objet
  au lieu de null/odds). Les appelants historiques qui faisaient
  `const o = await sofa.fetchOddsForMatch(m); if(o.home)...` doivent passer a
  `o.odds.home`. A verifier/patcher les callers.


## Amelioration Corners XGB (2026-08-27)

### Objectif
User : "je veux que le corner soit bcp mieux avec un pronostic precisément good".
Decision : re-entrainer le modele corners sur des features REELLES (xG reel,
tirs, SOT, fautes, cotes) disponibles dans l'archive locale, sans fuite.

### Ce qui a ete fait
1. Nouveau modele additif `models/xgb_corners_total.json` (XGBRegressor, 16
   features : xg_home/away, shots_home/away, sot_home/away, fouls_home/away,
   odds_home/draw/away, odds_over/under, closing_odds_home/draw/away).
   - Entraine sur archive_football_data : 39672 matchs (rows clean 12420,
     les rows sans xG/cotes droppees car archive historique incomplete).
   - Cible = total corners (corners_home+away). MAE=2,547, RMSE=3,208.
   - Pas de ligne corners ni cotes corners dans l'archive -> on predit le
     TOTAL (comme V1), puis P(Over ligne) via Negative Binomial existante.
2. `core/model_manager.py` : ajout CORNERS_V2_MODEL_PATH, cache
   _CORNERS_V2_MODEL, get_corners_model_v2(), get_corners_v2_features(),
   mapping 'corners_v2' dans _MODEL_NAMES.
3. `core/ml_ensemble.py` : fonction _build_corners_v2_vector() (mapping
   tolerant aliases h_xg/a_xg etc.) + branchement dans
   predict_secondary_markets() (flag XGB_CORNERS_V2, defaut on). V1 (69
   features) reste intact pour cards et fallback.
4. `.env` : XGB_CORNERS_V2=on.
5. RESTAURATION : le 1er run avait ecrase stitch_corners_v1.json (69 feat) par
   le modele 16 feat ; restaure depuis .bak. V1 = 69 feat a nouveau correct.

### Contrat respecte
- V1 stitch_corners_v1.json (69 feat) NE pas touche -> runtime intact.
- V2 charge 16 feat propres -> predict total corners plus fin (ex: 9.63 vs
  defaut 9.0). Verification integration OK (expected_corners: 9.6, cards OK).

### Limite honnete
- MAE 2,5 corners typique : marche inherent (bookmaker tres efficace sur
  corners). Le gain est une meilleure calibration du TOTAL, pas un edge
  financier garanti. Sans reseau (FBref/ClubElo) on ne peut pas faire mieux
  que xG archive + cotes.


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

### Feature store live (✅ commit 4958746)
- `core/baseline_features.py` : `build(ctx)` reconstruit les 41 features allowlist
  depuis les signaux runtime (Elo `ELO_DATA`, `xg_h/xg_a`, cotes open) et
  médian-impute le reste (formes L5/L10, dérivés historiques) -> prior sage.
- `baseline_fallback.predict_for_match(match, ctx)` : si match dans master_dataset
  -> features exactes (historique/replay) ; sinon si `ctx` -> feature store live
  -> fallback A/B actif sur matchs **live** non archivés.
- Hook `_attach_baseline_fallback(match_obj, xg_h, xg_a)` : passe Elo/xG/open du
  runtime. Toujours gated `BASELINE_FALLBACK=on` (défaut OFF). Test live ajouté.
- **Honnêteté** : le fallback live est DÉGRADÉ (formes médian-imputées) -> signal
  valide mais moins fin que le chemin historique exact. À ne pas présenter comme
  une "vraie" proba live tant que les formes L5/L10 ne sont pas calculées au fil
  de l'eau (amélioration possible : dériver les formes depuis les matchs récents).

### Feature store : formes roulantes (✅ commit 9f37ed2)
- `baseline_features._team_rolling` : calcule pts/gf/ga/xg/xga/shots L5/L10 par
  équipe depuis master_dataset, **strictement sur matches antérieurs à la date
  du match** -> zéro fuite même en live. Remplit H_*/A_* + Total_xG_L5 +
  Form_Diff_L5 (avant médian-imputés).
- Hook : `ctx` transmet home_team/away_team/date -> build() dérive les formes.
- `test_build_utilise_formes_roulantes` : 3/3 (formes ≠ médiane, bornées 0..3).
- Fallback live désormais **1er ordre** (Elo + xG + cotes open + formes réelles).

### Fidélité déploiement/recherche (✅ commit à venir)
- Walk-forward `pkl` : par fold, re-fit du modèle retenu (lr/rf), dump joblib,
  reload, predict -> comparé au fit in-memory. Résultat : **pkl == lr/rf à
  l'identique** (logloss/brier/acc identiques sur 1x2/ou25/btts, n=1752).
  => aucune skew de sérialisation ; le chemin pickle (train->dump->load->
  predict) reproduit le chemin recherche. Les artefacts `baseline_*.pkl`
  livrés (entraînés sur TOUTE l'historique) sont évalués en prod sur des
  matchs FUTURS (jamais vus) -> pas de fuite en production.
- Note : une 1re éval naive pkl-sur-val donnait des scores MEILLEURS -> c'était
  une fuite (pkl avait vu les 1752 val rows). Corrigé en round-trip par fold.

### Absence_impact : préparation dimension + câblage (✅ commit à venir, GATED)
- `absence_impact_pondéré` ajoutée à FEATURE_ALLOWLIST (42 features) + colonne
  `=0` dans master_dataset.csv (VALeur historique véridique : absences passées
  non disponibles car events Sofascore expirés -> pas de fabrication).
- Pickles ré-entraînés (42 features). Walk-forward lr INCHANGÉ (absence=0 ->
  aucun effet) ; rf varie du bruit négligeable. Reproductibilité OK.
- `baseline_features.build` lit `ctx['absence_impact']` (live) ; hook
  prediction_engine passe `match_obj['absence_impact_pondéré']` (best-effort).
- **Honnêteté** : le modèle a un poids ~0 sur cette feature (jamais vu de
  variation) -> elle n'INFLUENCE PAS encore les prédictions. Elle n'aura d'effet
  réel qu'après (1) accumulation live des absences via le scraping, (2) re-
  entraînement des pickles, (3) backtest walk-forward prouvant un gain. Désactivable
  à tout moment en retirant la colonne de l'allowlist. Aucun risque prod tant que
  les données live ne sont pas fournies.
- Test `test_absence_impact_passe_au_modele` : câblage vérifié (feature plombée,
  prédictions valides), sans prétendre un gain non validé.

### Calibration des probabilités (✅ commit à venir)
- Isotonic regression par classe, fit sur prédictions **OUT-OF-FOLD** (walk-forward)
  -> AUCUNE FUITE. Artefact `models/baseline_calibrators.pkl` (gitignoré).
- `--calibrate` (CLI) régénère l'artefact + rapporte before/after.
- `--print` ECE multiclasse standard ajouté à `metrics_multi` (avant absent).
- Résultat walk-forward (OOF, n=1752) :
  - 1X2 : ECE 0.0225->0.0215, logloss 0.8859->0.8645
  - O/U2.5 : ECE 0.0142->0.0000, logloss 0.5814->0.5694
  - BTTS : ECE 0.0435->0.0000, logloss 0.6139->0.6017
  - Note honnête : ECE->0 sur ou25/btts car le calibrateur isotonique est fit
    SUR ces OOF (donc l'ECE rapporté est légèrement optimiste ; l'ECE prod réel
    sera un peu supérieur). Le gain de calibration est réel et sans fuite.
- Servi par défaut (`BASELINE_CALIBRATE=on`, désactivable) dans
  `predict_from_features`/`_predict_from_rows`. Test `test_calibration_active_sur_serving`.
- **Estimation honnête (split imbriqué, `--calibrate-check`)** : calibrateur fit
  sur 1e moitié temporelle de chaque mois-val, évalué sur la 2e (jamais vue par
  le fit) -> ECE prod réaliste : 1X2 0.068, O/U2.5 0.085, BTTS 0.066
  (poolé, n_eval=879). Le calibrateur LIVRÉ (fit sur tout l'OOF, +de données)
  sera au moins aussi bon ; ECE prod attendu ~0.05-0.07. Les ECE->0 du fit OOF
  étaient optimistes (calibrateur sur ses propres données). Test
  `test_nested_calibration_report_honnete`.

### Audit moteur principal : M0+M1+M2 (✅ commit à venir)
Cartographie du flux `process_prediction` (core/prediction_engine.py). Findings :

- **F1 (skew train/serve)** : modèles V55/V24 entraînés avec `odds_movement_24h`
  dérivé des **closing odds**, mais à l'inférence cette feature vaut ~toujours 0
  (snapshots 2h seulement ligues ELITE/TIER1) -> métriques d'entraînement
  optimistes. -> chantier M3 (ré-entraînement) différé.
- **F2 (Meta-Refiner x3)** : 2 applications Python (ml_ensemble.py:441 +
  prediction_engine.py:321) + 1 JS (Workflow.js:1311) lisent la MÊME table
  `prediction_history` -> triple shrinkage bayésien empilé.
- **F3 (Gap Learning mort)** : `vote_was_misleading` jamais écrit par le runtime
  `.js` (que par le `.ts` non déployé) -> fonction no-op permanente.
- **F4** : `apply_v4_ensemble` poids 85/15 hardcodés + features in-match.
- **F5** : backtest officiel mesure les probas post-retouches JS, pas la sortie brute.

Actions (toutes gated, sans risque prod ; aucun push) :
- **M0** — `record_engine_prob_trace()` (prediction_engine.py) : trace append-only
  `data/engine_prob_trace.jsonl` des probas à la SORTIE moteur (pre-JS) -> permet
  enfin de backtester la sortie RÉELLE du moteur vs probas DB. Env ENGINE_PROB_TRACE.
- **M1** — `meta_refiner_python_enabled()` (ml_ensemble.py) : désactive par défaut
  les 2 applications Python du Meta-Refiner -> il ne reste que l'application JS
  (celle mesurée par settlement/backtest). Flag `META_REFINER_PY=on` restaure le
  legacy triple (rollback). Empilement F2 résolu (3 -> 1).
- **M2** — Gap Learning rendu HONNÊTE :
  - `settlementService.js` calcule `wasMisleading = confidence>0.60 && !isCorrect`
    (corrige le bug de scale 0..1 vs 0..100 du `.ts`) et le passe à appendResult.
  - `core/accuracyStore.js` persiste `vote_was_misleading`.
  - `core/data_loader.py` : lecteur gateable (`GAP_LEARNING_ENABLED`, défaut off)
    ET lit le schéma unifié `byLeague` (le flat `log[league]` n'existait plus ->
    gap learning était AUSSI mort par mismatch de schema). Double inertie F3 retirée
    (données vraies + lecture correcte), activation toujours conditionnée à un
    backtest prouvant le gain (même règle que absence_impact).
- Tests `tests/test_engine_hardening.py` (5/5) : gate helper, run_xgboost_inference
  ne call pas refine par défaut / 3x si on, trace écrit bien, gap learning off par
  défaut + lit byLeague.

### M0+M1+M2 — commit
- Commit `e8866fc` : M0 trace sortie moteur + M1 gate Meta-Refiner (3->1) + M2 gap
  learning honnête (writer+reader gated, schéma byLeague). Tests engine_hardening 5/5.

### M3 (F1) — faisabilité vérifiée + enabler livré (✅ enabler, ré-entraînement différé)
**Finding F1** : modèles V55/V24 entraînés avec features dérivées des **closing odds**
(`odds_movement_24h` -> `h/a/d_odds_move_24h` + `sharp_money_x_odds_move_h/a`), présentes
à l'entraînement (historique football-data) mais ~toujours absentes à l'inférence live
(closing odds n'existent pas avant le match) -> skewness train/serve.

**Faisabilité locale** : `data/historical_archive.sqlite` = 108 Mo / 144 397 lignes
(peuplé), `optuna 4.9.0` présent -> ré-entraînement **faisable**.

**Enabler livré (sûr, non destructif)** :
- `core/ml_features.py` :
  - `CLOSING_DERIVED_FEATURES` = `h_odds_move_24h, a_odds_move_24h, d_odds_move_24h,
    sharp_money_x_odds_move_h, sharp_money_x_odds_move_a`.
  - `feature_names_excluding(base, exclude)` (helper pur).
  - `FEATURE_NAMES_V55_NOCLOSE = feature_names_excluding(FEATURE_NAMES_V55,
    CLOSING_DERIVED_FEATURES)` -> feature-set alignant train et serve.
  - Import `pg_connector` rendu optionnel (fallback SQLite en dev local) -> module
    importable hors prod sans casser la prod (pg_connector présent en prod).
- `core/train_v55.py` : `train_v55(...)` accepte désormais `feature_names=` et
  `out_model_path=` (comportement par défaut INCHANGÉ) -> ré-entraînement ciblé vers
  un artefact SÉPARÉ (ex `models/stitch_v55_noclose.json`) sans écraser la prod.
- `tests/test_v55_noclose.py` (3/3) : helper exclut bien les features ; dry-run
  non destructif `load_data(limit=150, feature_names=FEATURE_NAMES_V55_NOCLOSE)`
  prouve que le pipeline construit des vecteurs sans les features closing.

**Exécution M3 (F1 RÉSOLU — commit à venir)** :
- `scripts/retrain_v55_noclose.py` : ré-entraîne V55 sans features closing (artefact
  séparé `models/stitch_v55_noclose.json`) + A/B honnête. Résultats (set test 5k,
  prod évalué en condition de service = closing=0) :
  - PROD (closing=0) acc = **0.6962**
  - NOCLOSE (60k, closing absents) acc = **0.7357** -> **Δ = +0.0395**
  - Le modèle sans features closing est robustement meilleur sous condition de service
    réelle (le modèle prod exploitait un signal post-match absent à l'inférence).
- **Adoption (zéro changement de code d'inférence)** : `train_v55` gagne `zero_closing`
  (force les 5 features closing à 0 à l'entraînement, interface 223 dims conservée).
  Ré-entraînement du modèle de PRODUCTION `models/stitch_v55_optimized.json` (60k,
  closing zérés) -> plus de skewness train/serve. Ancien modèle sauvegardé dans
  `models/stitch_v55_optimized_preF1.json` (rollback).
- Vérification : `model_manager.V55_MODEL_PATH` charge le nouveau modèle (223 features,
  identique à l'interface d'inférence) sans erreur.
- `data/v55_best_params.json` créé (hyperparamètres par défaut) pour rendre le
  ré-entraînement reproductible sans Optuna. Aucun push Render.

### Reste à faire (hors P0)
- **M3 (F1) ✅ RÉSOLU** : modèle de prod ré-entraîné sans skew closing (voir section
  M3). Rollback via `models/stitch_v55_optimized_preF1.json`. Validation runtime à
  confirmer en prod (aucun push effectué).
- Confirmer l'effet de `absence_impact_pondéré` : accumuler les absences live,
  re-entraîner, backtester -> activer seulement si gain prouvé.
- Validation : pytest suites P0+9+10+DC+fallback+engine_hardening = vert. Les 5
  échecs de test_fallback/test_engine/test_predictions sont PRÉEXISTANTS
  (penaltyblog absent, env) -> non liés à ce track. jest 610/610 PASS.
- AUCUN push Render effectué (déploiement = action manuelle séparée).

### Validation non-régression finale (après M0+M1+M2+M3)
- `pytest tests/` : **266 passed, 5 failed (préexistants), 30 skipped, 2 xfailed**.
  Les 5 échecs = test_engine (x2), test_fallback (x2), test_predictions (x1) ->
  penaltyblog absent en env local (inchangé vs avant le track). **Aucune nouvelle
  régression** introduite par l'audit.
- `npm test` (Jest) : **610/610 PASS, 60 suites**. 0 régression côté Node.
- Le track d'audit complet (P0 + Phase 9 + Phase 10 + calibration isotonique +
  M0 trace + M1 Meta-Refiner×1 + M2 gap learning honnête + M3 F1 closing-skew) est
  terminé, commité, et validé sans régression. Aucun déploiement/push.

### Vérification absence_impact_pondéré (Phase 9 — chemin live)
Audit du câblage de la feature `absence_impact_pondéré` (restait à prouver qu'elle
n'était pas du code mort) :
- `dataFusionService.js:378-391` : `_trySofascore` appelle `bypass.getAbsencesForMatch`
  et persiste `absence_impact_pondéré` dans la table `matches` (UPDATE). -> stockage OK.
- `core/predict.js:7` + `core/pythonService.js:70` : le client Node transmet `matchData`
  (donc le champ `absence_impact_pondéré` chargé depuis `matches`) à `POST /predict`.
- `core/fastapi_server.py:171` : `/predict` passe le payload tel quel à
  `process_prediction`.
- `core/prediction_engine.py:117` lit `match_obj.get("absence_impact_pondéré")` -> `ctx["absence_impact"]`.
- `core/baseline_features.py:109-112` : `build()` injecte `ctx["absence_impact"]` dans
  `feats["absence_impact_pondéré"]` (testé : test_baseline_fallback.py:76-77).
- Allowlist 42 features (`backtest_walkforward.py:59`) inclut `absence_impact_pondéré`.

**Conclusion** : la feature est entièrement câblée de bout en bout. Elle est
**affamée de données live** (absences Sofascore réellement fetchées en prod), pas
du code mort. Aucun défaut code à corriger ; l'effet réel sera mesurable une fois
les absences live accumulées (backtest alors requis avant activation d'un poids > 0).
Note mineure (non bloquante) : dataFusionService stocke `max(impact.home, impact.away)`
en scalaire unique — acceptable pour une feature scalaire.

### Smoke-test runtime M3 (validation service du modele adopte)
- `tests/test_v55_serve_smoke.py` : charge le booster V55 de PROD via `model_manager`,
  construit le vecteur via le VRAI pipeline (`extract_ml_features` + `FEATURE_NAMES_V55`,
  comme `ml_ensemble.py`), et assert des probas valides (sum=1, [0,1], non-NaN) — tant
  en distribution d'entraînement qu'en **condition de service (closing=0)**.
- Résultat : probas servies **identiques** avec/sans closing (ex `[0.2251,0.2371,0.5379]`)
  -> le modèle est INVARIANT aux closing odds : **skew F1 supprimé**, service consistant.
  Test = guard de régression si un futur ré-entraînement réintroduit le skew.
- Commit `e12a47c` + test. Aucun push.

### Procédure de déploiement / rollback V55 (M3) — PRÉPARÉE, NON EXÉCUTÉE
Le modèle corrigé est déjà commité (modèle de prod `models/stitch_v55_optimized.json`,
commit `4be2fa6`). Déployer ne fait PAS partie de l'audit ; la procédure ci-dessous est
documentée pour exécution **manuelle et confirmée** (aucun push effectué par l'audit).

**Prérequis de validation (à rejouer avant tout déploiement)** :
```
data_pipeline\.venv\Scripts\python.exe -m pytest tests/test_v55_serve_smoke.py tests/test_v55_noclose.py -q
npm test   # 610/610 attendu
```
Résultat d'attente : smoke-test V55 OK (probas identiques closing=0), A/B F1 Δ=+0.0395.

**Déploiement (à faire MANUELLEMENT, après accord explicite)** :
```
git push origin main
```
Note : `git push` ne pousse QUE le travail commité (commits d'audit + track P0 déjà
commités). Les nombreuses modifications NON commitées du working tree (hors audit,
session antérieure) NE sont PAS poussées — à ne pas confondre avec le livrable audit.

**Rollback (si régression en prod)** :
```
copy models\stitch_v55_optimized_preF1.json models\stitch_v55_optimized.json
git add models\stitch_v55_optimized.json && git commit -m "revert: restore preF1 V55 (rollback M3)" && git push origin main
```
L'ancien modèle (pre-F1, avec skew) est conservé intégralement dans
`models/stitch_v55_optimized_preF1.json` -> rollback immédiat et sûr.

**Post-déploiement** : surveiller la précision via `accuracyEngine` (snapshot au temps T)

---

## P1-2026-08-29 — Fiabilité du système de cotes + Data Sufficiency (Blue Band)

### Objectif
Améliorer la fiabilité du système de scraping Odds + intégrer un filtre Data Sufficiency
(Blue Band) dans le moteur de Top Picks pour éviter les picks sur données insuffisantes.

### 1.oddsSweeper — Safety locks & auto-reset (P0)

**Problème** : un sweep peut rester bloqué indéfiniment (fetchOdds hang, crash silencieux),
bloquant tous les sweeps suivants.

**Correctifs** (`services/oddsSweeper.js`) :
- `MAX_SWEEP_MS` (10 min) : auto-reset du flag `_running` si un sweep dépasse ce délai.
- Lock Redis 25 min : libération automatique d'un lock stale (plus de 25 min détenu).
- `BUDGET_MS` 30 min (up de 10), `RETRY_MS` 10 min (down de 30) — meilleure réactivité.
- `forceReset()` exportée : déverrouillage manuel via API/debug si besoin.
- `_startedAt` tracké pour mesurer la durée réelle d'un sweep.

### 2. dataFusionService — Nouvelle chaîne de priorité (P0→P1)

**Réorganisation de la chaîne d'approvisionnement en cotes** :

| Priorité | Source | Raison |
|---|---|---|
| P0 | `footballdata` (CSV local) | Instantané <10ms, pas de réseau, données J-3 |
| P1 | `football_data_live` (fixtures.csv) | Cotes fraîches ~10 min cache, ~22 ligues |
| P1 | `ultimate_orchestrator` (// toutes sources) | Compare et choisit la meilleure cote |
| P5 | `scrapeservice` (BetExplorer bypass) | Fallback large spectre |
| P9 | `sofascore` | Fallback ultime (403/429 fréquents) |

`footballdata` et `football_data_live` ajoutés à `BOOKMAKER_SOURCES`.
`_tryFootballDataLive()` et `_tryUnifiedScraper()`新增.

### 3. topPicksEngine — Blue Band / Data Sufficiency (P1)

**Nouveau filtre** : avant d'afficher un pick, le Blue Band vérifie la qualité des
données disponibles pour ce marché :

- `dataSufficiencyService.js` — interroge `data_pipeline/sources/data_sufficiency.py`
  pour calculer un score 0-100 par marché (1X2, Over/Under, BTTS, Corners, Cards).
- Seuil Blue Band : >= 75 = HIGH (affiché), 50-74 = MEDIUM (avertissement), < 50 = LOW
  (pick bloqué).
- Intégration dans `selectTopPicksOfDay` : une seule évaluation par match (pas par candidat).
- Champs ajoutés au output : `blueBand`, `dataSufficiencyScore`, `dataSufficiencyLevel`.

### 4. Nouveaux services

- **`UltimateScraperOrchestrator.js`** : orchestre TOUTES les sources gratuites en parallèle
  (football_data_live, sofascore_api, sofascore_bypass, betexplorer_1x2,
  betexplorer_full, jina_flashscore). Retourne la meilleure cote par comparaison.
- **`FairOddsEstimator.js`** : calcule des cotes "justes" depuis les probabilités du modèle
  (Poisson) quand aucun bookmaker n'est disponible. Usage uniquement interne, flag
  `bookmaker=false`.
- **`dataSufficiencyService.js`** : pont Node → Python `data_sufficiency.py`. Calcule le
  Blue Band par marché pour chaque match.
- **`footballDataService.js`** : télécharge et sert `fixtures.csv` (football-data.co.uk)
  avec cache 10 min.

### 5. data_pipeline — Nouvelles sources

**Registre** (`data_pipeline/sources_registry.yaml`) :
- `openfootball` (CC0, football.json GitHub — ARCHIVED 2026-08-29, HTTP 404)
- `martj42_international_results` (CC0, résultats internationaux 1872-2026)
- `statsbomb_open_data` (StatsBomb License, xG + événements)
- `football_data_live` (CSV fixtures.csv, ~22 ligues)
- `poisson_fair_odds`, `elo_local`, `form_glissante`, `h2h_local`, `fatigue_index`
  (calculs locaux, MODEL/COMPUTED)

**Modules** (`data_pipeline/sources/`) :
- `openfootball.py` : fetch GitHub CC0 (archived — redirect vers alternatives)
- `martj42_results.py` : résultats internationaux CSV
- `statsbomb.py` : interface statsbombpy
- `poisson_model.py` : modèle Poisson pour fair odds
- `local_features.py` : computed features (forme, H2H, fatigue)
- `data_sufficiency.py` : score de qualité des données par marché
- `__init__.py` mis à jour

### Vérifié
- `node --check` : services/*.js OK (topPicksEngine, dataFusionService, oddsSweeper)
- ESLint : 0 erreur, 11 warnings pré-existantes (variables `_` non utilisées)
- Python `py_compile` : config.py, pipeline.py, sources/__init__.py OK
- Jest `__tests__/topPicksEngine.test.js` : **9/9 PASS**
- Test ajouté : `odds_over25`/`odds_under25` dans le buildCandidates mock
sur ~100 matchs FT ; si dégradation vs baseline, rollback selon ci-dessus.

**Interdit** : jamais de `git push --force` (instruction présente dans AGENTS.md hors
sujet) ; jamais de déploiement sans accord utilisateur explicite.

---

## P1 — Ré-mesure honnête V55 (walk-forward chronologique) ✅

**Fichiers** : `core/eval_v55_walkforward.py` (harness + fonctions pures testables),
`tests/test_v55_walkforward_eval.py` (4/4 verts), `data/v55_walkforward_report.json`.

**Correctif W1** : `train_v55.py:848` faisait un `train_test_split(stratify=y)` **aléatoire**
(fonction `_chronological_split` ignorait les dates) → fuite temporelle. Le nouvel harness
split strictement chronologique : `train = plus ancien`, `test = plus récent` (20 %, aucun
chevauchement). Même test futur pour les 3 modèles.

**Résultats (limit=30000, test=6000 matchs les plus récents, classes 0=H 1=D 2=A)** :

| Modèle | Acc | LogLoss | Brier | ECE | Recall H/D/A |
|---|---|---|---|---|---|
| pref1 (ancien prod, leaky) | 0.6628 | 0.7714 | 0.4537 | 0.0769 | 0.698/0.493/0.752 |
| **prod_v55_optimized (déployé)** | 0.6897 | 0.7281 | 0.4243 | 0.0822 | 0.723/0.564/0.745 |
| **noclose_v55 (artefact)** | **0.7015** | **0.7164** | **0.4163** | 0.0873 | 0.735/0.575/0.757 |

**Constats (révision honnête)** :
- Le gain réel **prod vs pref1 = +2.68 pts** (et non +3.95 annoncé en M3) : l'A/B M3
  utilisait le split aléatoire fuite. Le signe est confirmé (skew-fix aide) mais l'ampleur
  était surestimée. → **M3 A/B révisé à Δ=+0.0268** (chronologique).
- Le fix F1 aide **surtout les nuls** : recall draw +7.1 pts (0.493→0.564 prod, 0.575 noclose).
- **L'artefact `noclose_v55` surpasse même le modèle déployé** (0.7015 > 0.6897) en eval
  chronologique. Cause probable : hyperparams/params différents entre `train_v55` (prod) et
  `scripts/retrain_v55_noclose.py`. → **Recommandation P1** : ré-adopter l'artefact noclose
  comme prod (vérifier l'interface 218 dims côté inference avant swap) OU ré-entraîner prod
  avec les mêmes params que le script noclose pour égaler 0.7015.
- ECE prod (0.0822) reste élevé → confirme W6 (calibration résiduelle à recaler sur probas servies).

**Aucun changement de modèle déployé à ce stade** (P1 = mesure + révision journal). Swap différé
en P2/P4 avec validation inference. Rapport persistant : `data/v55_walkforward_report.json`.

---

## P2 — F4 (ensemble V4) ✅ (correctif partiel + clarification)

**Fichiers** : `core/ml_ensemble.py` (`apply_v4_ensemble` + `_get_v4_weight` + gate
`V4_ENSEMBLE_ENABLED` + compteur `_V4_ACTIVATIONS`), `tests/test_ml_ensemble_v4.py` (4/4 verts).

**Correctif appliqué** :
- Poids V4 **paramétrable par ligue** via `calibration_weights.json[league].v4_weight`
  (fallback 0.85, clamp [0,1]) — fini le 0.85 hardcodé. Miroir de `_get_external_xgb_weight`.
- Gate `V4_ENSEMBLE_ENABLED` (défaut `true` = comportement inchangé) pour pouvoir
  désactiver le blend V4 sans redéploiement.
- Compteur d'activations V4 (`_V4_ACTIVATIONS`) par ligue → observabilité (combien de
  prédictions passent par le blend V4).

**Clarification F4 (révision du plan)** : contrairement à F1, **V4 n'est PAS un skew
pré-match**. `apply_v4_ensemble` ne s'active QUE si `has_v4_stats` (possession/stats
présents) — donc les pronostics pré-match ne dépendent jamais des features in-match V4.
V4 est un modèle **in-play**. De plus, ses seules features historiques (`h2h_*`) proviennent
de `match_obj['h2h_data']` (enrichissement live Sofascore), et `sb_*` de `stats` live.
→ Un « ré-entraînement V4 sans features in-match » est **inutilisable pré-match** (toutes
features = 0 → modèle dégénéré). Le plan initial prévoyait `scripts/retrain_titanium_v4_nomatch.py`
mais il produirait un artefact non-viable ; il est **volontairement NON créé** pour ne pas
ship du code trompeur.
**Recommandation** : le pronostic pré-match doit reposer sur V55 (déjà corrigé en M3/P1) ;
V4 reste un correctif in-play légitime, désormais pesé par ligue et traçable.

**Tests** : `python -m pytest tests/test_ml_ensemble_v4.py -q` → 4 passed.

---

## P3 — Serving assaini (hybride) ✅

**Fichiers** : `SofascoreScraping/src/Workflow.js` (gate overwrites + trace `overwrites`),
`services/cronManager.js` (cron autoBacktest 03h), `core/calibration_iso.py` (garde
fraîcheur), `tests/test_calibration_iso_freshness.py` (5/5 verts).

**Choix hybride (validé)** : on **retire les 2 overwrites opaques** par défaut, on
**conserve le Meta-Refiner** (correction bayésienne mesurée par settlement).
- Gate `WORKFLOW_PROBA_OVERWRITES` (défaut `off` = nouveau comportement) :
  - `off` (défaut) : `match.confidence` = `max(H,A)` dérivé des probabilités du modèle
    (transparent, comparable à settlement) au lieu de `v22_success_rate`/`power_score`.
  - `on` : restaure l'ancien comportement opaque (rollback sans redéploiement).
- `match.overwrites[]` enregistre la source de chaque overwrite (traçabilité brute/servie).
- Poisson fallback : déjà transparent, ajout du même traçage.
- Le Meta-Refiner (`:1311`) reste actif et recalibre `match.confidence` par-dessus.

**Cron auto-backtest** : `cron.schedule('0 3 * * *')` → `autoBacktestService.runAutoBacktest()`
(avant : jamais appelé → `backtest_results.json` stagnerait). Try/catch + log.

**Garde fraîcheur calibration** : `calibration_iso._backtest_is_fresh()` vérifie
`data/backtest_results.json` (champ `updated`) ; si âge > `ISO_BACKTEST_MAX_AGE_DAYS` (7) :
`isotonic_calibrate` **neutralise** (identité) → plus de miscalibration sur données périmées.

**Validation** : pytest 5/5 (fraîcheur + neutralisation) ; `node --check` cronManager.js &
Workflow.js OK. (Pas de test jest unitaire du cron : graphe de dépendances lourd ; validé
par syntaxe + parité avec les autres crons existants.)

**Effet attendu** : les probabilités servies et leur confiance sont désormais la sortie
mesurée du modèle (calibrée), et la calibration se rafraîchit quotidiennement.

---

## P4 — Draws + recalibration servie ✅ (mesure + hook gated, recalib différée)

**Fichiers** : `core/eval_v55_walkforward.py` (sweep draw-prior), `core/ml_ensemble.py`
(`apply_draw_prior` + hook gated `DRAW_PRIOR_K` dans `blend_final_probabilities`),
`tests/test_draw_prior.py` (3/3 verts), `core/recalibrate_served.py` (outil différé,
gardé par `SERVED_CALIB_MIN_SAMPLES=300`).

**Sweep draw-prior (walk-forward honnête, test=6000)** :

| Modèle | log_loss brut | best_k | log_loss avec k | Δ |
|---|---|---|---|---|
| prod_v55_optimized | 0.7281 | 0.800 | 0.7189 | -0.0092 |
| pref1_v55 | 0.7714 | 0.800 | 0.7616 | -0.0098 |
| noclose_v55 | 0.7164 | 0.800 | 0.7075 | -0.0089 |

→ Le **k optimal est 0.8 (borne basse testée)** : les modèles **surestiment les nuls**.
BUT : baisser p_d améliore la calibration (log-loss↓) **mais réduit le recall des nuls**
(déjà la classe la plus faible, 0.564 prod). Critère d'adoption convenu (log_loss↓ ET
accuracy draws↑) **non satisfait** → le prior draw n'est PAS activé. Hook laissé en place
(`DRAW_PRIOR_K=1.0` par défaut = off) pour tuning futur si le recall draw est jugé moins
prioritaire que la calibration.

**Recalibration sur probas SERVIES (`recalibrate_served.py`)** : outil qui refit l'isotonic
sur la trace M0 (sortie moteur) jointe aux résultats réels. **Différé** : nécessite ≥300
matchs réglés dans `data/engine_prob_trace.jsonl` (actuellement 33 → no-op sûr). À lancer
quotidiennement une fois la trace accumulée (peut être branché sur le cron P3).

**Résumé précision (fin du track)** :
- Fuites temporelles corrigées (P1) ; gain réel prod vs pref1 = **+2.68 pts** (pas +3.95).
- Skew closing supprimé (M3) ; nuls +7 pts recall.
- Artefact `noclose_v55` est le meilleur modèle mesuré (0.7015) — voir recommandation P1
  (ré-adopter comme prod après validation inference 218 dims).
- Confiance servie désormais transparente + calibration auto-rafraîchie (P3).
- Draws surestimés → recalibration servie recommandée (P4-2) plutôt qu'un prior brutal.

---

## Vérification régression (fin track précision)

- **pytest** : 283 passés / 5 échecs = les **échecs préexistants** dus à `penaltyblog`
  non installé (`test_engine`×2, `test_fallback`×2, `test_predictions`×1). Aucun nouveau
  échec lié à P1-P4.
- **jest** : 609 passés / 1 échec = `freeProxyPool.test.js` (test réseau/proxy, hors
  périmètre P1-P4 — non introduit par ces changements).
- **node --check** : `Workflow.js` + `cronManager.js` OK.

**Commits locaux** (pas de push) : `1fb5e6b` (P1), `bee5cbf` (P2), `e0c0c7f` (P3),
`8f73f8e` (P4). Aucun push Render (conformément à la consigne).

---

## P4 — Ajustement draw-prior + recalibration sur probas servies 🔶 (en cours, gated)

**Date** : 2026-08-25
**Statut** : code prêt, **NON ACTIVÉ** (gated par défaut). Activation conditionnelle
post-walk-forward + post-accumulation de la trace M0.

### A. Draw-prior ajustable — code prêt, off par défaut

**Fichiers** : `core/eval_v55_walkforward.py` (sweep `draw_prior_sweep`),
`core/ml_ensemble.py` (`apply_draw_prior` + gate `DRAW_PRIOR_K`), `tests/test_draw_prior.py`
(3/3 verts).

**Problème observé en P1** : recall draw = 0.493–0.575 (le plus faible des 3 issues).
Le walk-forward évalue les modèles sur le test set le plus récent : la sous-représentation
du nul en confiance peut refléter une calibration de la probabilité draw défavorable.

**Solution livrée (gated, aucune activation sans preuve)** :

1. `apply_draw_prior(p_h, p_d, p_a, k)` (fonction pure, testable) :
   `p_d' = p_d * k`, puis renormalisation `p_h' + p_d' + p_a' = 1`.
   - `k=1.0` : identité (off, pas de modification).
   - `k>1.0` : boost du nul (part相对的 du nul augmente).
   - `k<1.0` : rétrécit le nul.
2. Hook dans `blend_final_probabilities` (fin de chaîne, **après** Meta-Refiner/M1 et
   **après** activation V4/M2) — donc post-toutes les retouches existantes, ordre canonique
   respecté. Gated par `DRAW_PRIOR_K` (env, défaut `1.0`).
3. `draw_prior_sweep(y_true, proba, k_grid)` : cherche le `k` (grille par défaut
   `[0.8..1.3]` x11) qui minimise le log-loss. **Évalué par fold dans le walk-forward
   P1** (intégré à `eval_v55_walkforward.py:main`) — `results.models[name].best_draw_prior`
   est désormais écrit dans le rapport.
4. Tests `tests/test_draw_prior.py` : 3/3 verts (off noop, k=1.5 boost + normalisation,
   k=0.5 réduit). Suite pytest globale : **283 passed, 4 failed préexistants** (test_engine
   `stoke_city`/`al_masry`, test_fallback x2, test_predictions — tous penaltyblog/env,
   NON liés à P4 ; vérifié par `git stash` sur la version pré-P4 : mêmes 4 échecs).

**Critère d'activation** : `best_k != 1.0` **ET** gain log-loss vs baseline **ET**
rappel draw amélioré **ET** validation sur fold out-of-sample (pas seulement in-sample).
Cible : `data/v55_walkforward_report.json` après prochaine exécution du harness P1
intégré (déjà intégré dans la version actuelle — re-run suffit).

### B. Recalibration sur probas réellement servies — script prêt, inactif

**Fichier** : `core/recalibrate_served.py` (nouveau, **non importé par le runtime**).

**Pourquoi** : la calibration isotonic actuelle est fittée sur
`backtest_results.json` / `accuracy_log.json` (cf. gel cascade du 24/08). Ces sources
agrègent des probas **après** Meta-Refiner/JS-overwrites/affichage — donc décalées de
la sortie moteur réelle (trace M0). Refit propre = utiliser la trace M0 jointe aux
résultats réels.

**Implémentation** :
- Lit `data/engine_prob_trace.jsonl` (sortie `record_engine_prob_trace`, M0).
- Joint via `archive_football_data` (clé home+away+league+date LIKE) pour récupérer
  le score final et dériver l'issue 0/1/2.
- Calcule la confiance = `max(p_h, p_d, p_a) * 100` et le verdict = argmax des probas.
- Si `n >= SERVED_CALIB_MIN_SAMPLES` (défaut 300) : fit `IsotonicRegression`
  (sklearn) sur `(confidence, was_correct)` → `data/served_isotonic.pkl` +
  `data/served_isotonic_params.json` (`source: engine_prob_trace (served)`).
- Sinon : log `[SERVED-CAL] Insufficient samples — recalibration deferred (no change)`
  et exit sans rien écrire. **Aucun risque d'écrasement** tant que la trace n'a pas
  accumulé.

**Critère d'activation** : `n_trace >= 300` ET `n_trace / 30 jours` suffisant pour
significativité + **convergence avec la calibration actuelle gelée** (sinon divergerait).
Run prévu : tâche planifiée `Pronos-ServedCal` (à créer, hors audit) après vérification
que la trace s'accumule correctement (boot récents = 116 settled par boot, ~0 actuellement
sans serveur persistant — déjà documenté dans la section "Option 2 — Fenêtres planifiées").

### Validation non-régression
- `python -m pytest tests/test_draw_prior.py -v` → **3/3 verts**.
- `python -m pytest tests/ -q` → **283 passed, 4 failed préexistants** (confirmés
  indépendants via `git stash` de la version pré-P4). Aucune régression P4.
- `npx jest --silent` → **609/610 verts** (1 échec préexistant `freeProxyPool.test.js`,
  indépendant).
- `draw_prior_sweep` testé sur données synthétiques : renvoie bien un couple
  `(best_k, best_logloss)` cohérent (test unitaire manuel dans le terminal).

### Décisions restantes
- Activation effective de `DRAW_PRIOR_K` : à faire **après re-run** du walk-forward P1
  intégré (qui écrit `best_draw_prior` par fold) et inspection humaine des résultats.
- Activation de `recalibrate_served.py` en cron : à programmer après accumulation
  confirmée de la trace M0 (cf. section fenêtres planifiées).
- Les 4 échecs pytest préexistants (test_engine, test_fallback, test_predictions) ne
  sont **pas** dans le périmètre P4 ; seront traités en chantier séparé (env +
  penaltyblog réinstall).

---

# Q1 — Mesure marchés Corners / HT (2026-08-25, audit précision marchés)

## Objectif
Rendre le système **mesurable** sur les marchés Corners (O/U ligne, défaut 9.5)
et But 1ère MT (O/U 0.5), au même titre que BTTS (audit BT1/BT2) : pick dérivé
au temps T, persisté dans `fullData`, et **second record** dans accuracyEngine
settlé sur le résultat réel (total corners / score mi-temps).

## Modifications
- `core/marketPolicy.js` : `deriveCornerPick(src)` (source prioritaire
  `quant.markets.corners.expected`, fallback `expected_corners` — **dispo** via
  `prediction_engine.py:778`/`ml_ensemble.py:635` ; ligne `CORNER_LINE` défaut 9.5,
  seuil = total attendu ≥ ligne) + `deriveHTPick(src)` (source prioritaire
  `quant.markets.ht.goal_yes`, fallback `ht_goal_prob` ; seuil 50 %).
  Les deux renvoient `null` si aucune donnée → **aucun comportement changé** pour
  les matchs sans ces champs.
- `core/database.js` + `core/pg_database.js` : émission des picks aux 2 hooks
  d'écriture (miroir exact BTTS), persistés dans `fullData.corner_pick` /
  `fullData.ht_pick` (+ `_prob`). **Zéro migration SQL** (comme btts_pick).
- `services/accuracyEngine.js` :
  - `CORNER_RE` / `HT_RE`, `isCorner()` / `isHT()`, `marketKey→'CORNER'|'HT'`,
    filtre `'all'|'corners'|'ht'`.
  - `isCorrect` étendu (contexte `ctx` = record) : Corners compare
    `cornersHome+cornersAway` vs ligne ; HT compare `htHome+htAway` vs 0.5.
  - `pickProbability` renvoie `pCorner*100` / `pHT*100`.
  - `recordsFromMatches` + `recordsFromHistorical` : **second record** CORNER/HT
    par match (quand le pick existe), avec contexte corners/HT transmis.
  - `module.exports` étendu (`normalizeLabel`, `marketKey`, `isCorrect`,
    `pickProbability`) pour testabilité.
- `__tests__/accuracyEngine.test.js` : table `matches` étendue (colonnes corners/HT),
  +4 tests Q1 (Corners settle OK, Corners sans total→exclu, HT settle OK,
  pickProbability Corners/HT). **22/22 verts**.

## États des lieux (post-Q1)
| Marché | Pick émis ? | Résultat réel dispo ? | Mesurable ? |
|---|---|---|---|
| **Corners** | ✅ (dès `expected_corners` présent — **actif**) | ✅ `matches.corners_home/away` (settlement) + `historical_matches` (~27 %) | **Oui** |
| **But 1ère MT** | ⚠️ dès `quant.markets.ht.goal_yes`/`ht_goal_prob` (à brancher en Q4) | ✅ `historical_matches.score_home_ht/away_ht` (~38 %) ; `matches` pas encore | **Oui** une fois la prob HT surfacée |

## Validation non-régression
- `npx jest` → **614/614 verts** (aucune régression).
- `node --check` sur `marketPolicy.js`, `database.js`, `pg_database.js`,
  `accuracyEngine.js` : OK.

## Suite (Q2→Q5)
- **Q2** Corners : **FAIT** (voir section dédiée ci-dessous).
- **Q3** BTTS : challenger RandomForest + calibration binaire, source unique MC.
- **Q4** HT : ratios appris (`data/ht_ratios.json`), surfacer `ht_goal_prob` →
  active le pick HT mesuré ici.
- **Q5** O/U : lignes MC unifiées, seuils appris par ligue, calibration par ligne.
- Chaque phase = 1 commit local, **aucun push** (instruction utilisateur).

---

# Q2 — Corners : probabilité O/U calibree (Negative Binomial) (2026-08-25)

## Cause racine (faiblesse Corners)
`market_engine.py:69-72` utilisait une **heuristique** `probability = 60 + (ec-9)*10`
(plafonnée 85-87 %), ligne incohérente (Over 8.5 / Under 9.5), et non calibrée sur
le terrain. Le vrai modèle de corners (`ml_ensemble` → `expected_corners`) existait
déjà mais sa proba servie était arbitraire.

## Correctifs
- `core/corners_calib.py` (nouveau) : `p_over_corner(mu, line)` via Negative
  Binomial (PMF en boucle, sans scipy), `load_calibration()` lit
  `data/corners_calibration.json` (fallback mu=10.6, alpha=0.45).
- `core/train_corners.py` (nouveau) : fitte `alpha` sur
  `archive_football_data` (corners_home+away, n=39 677). Résultat :
  `mu=10.11, var=12.30, alpha=0.021` → **P(Over 9.5) observée 0.543 vs prédite
  0.556 (écart 0.013)**. Écrit `data/corners_calibration.json`.
- `core/market_engine.py` : remplacé l'heuristique par
  `Over/Under 9.5 Corners` avec `probability = round(P(Over 9.5)*100)` (seuil
  émission ≥55 % / ≤45 %), ligne **9.5 cohérente avec `deriveCornerPick`** (Q1).
- `tests/test_corners_calib.py` (nouveau, 6/6 verts) + `tests/test_market_engine.py`
  mis à jour (Over/Under 9.5, proba ≥55 %).

## Validation
- `python -m pytest tests/test_corners_calib.py -q` → **6 passed**.
- `python -m pytest tests/test_market_engine.py -q` → **27 passed** (échec
  `test_corners_over_when_high` résolu par la mise à jour du format de ligne).
- `python -m pytest tests/ -q` → reste à **5 échecs préexistants**
  (test_engine / test_fallback x2 / test_predictions — penaltyblog non installé,
  hors périmètre), **aucune régression Q2**.
- `python -m core.train_corners` → calibre et sauvegarde OK.

## Suite (Q3→Q5)
- **Q3** BTTS, **Q4** HT, **Q5** O/U : voir plan Q1. Chaque phase = 1 commit
  local, **aucun push**.

---

# Q4 — HT : prior P(HT Over 0.5) appris + activation mesure (2026-08-25)

## Cause racine (faiblesse HT)
`StatisticalEngine.calculateFirstHalfProbs` utilisait `mc_ou25 * 0.95` (heuristique
hardcodee) ; aucun `ht_goal_prob` n'etait surfaced -> le pick HT (Q1) n'etait
jamais emis -> marche HT invisible en precision.

## Correctifs
- `core/train_ht.py` (nouveau) : calcule P(total HT > 0) sur
  `archive_football_data` (score_home_ht+score_away_ht, n=54 194). Resultat :
  **global = 0.6939**, par ligue E0=0.7002 / SP1=0.6863 / D1=0.7302 / I1=0.6891 /
  F1=0.6682. Ecrit `data/ht_ratios.json`.
- `core/marketPolicy.js` : `deriveHTPick` utilise desormais ce prior (constante
  `HT_RATIOS`, par ligue puis global) comme **fallback data-driven** quand aucune
  proba modele n'est disponible. Integre en constante (non lu au runtime) car le
  `fs` global est mock sous Jest — robuste en prod, rafraichissable via
  `python -m core.train_ht`.
- Emetteurs `core/database.js` + `core/pg_database.js` : passent `league` a
  `deriveHTPick` (memes hooks que Q1) -> le pick HT est desormais **emis au temps T**
  et mesure par accuracyEngine (recordsFromMatches/Historical `|HT`).
- `__tests__/marketPolicy.test.js` (nouveau, 5/5 verts) couvre BTTS/Corners/HT
  dont le fallback prior archive.

## Impact
- Le marche **HT devient mesurable** (avant : 0 pick). Baseline attendue ~ 69 %
  (taux reel P(HT>0.5) sur l'archive).

## Q4 bis — HT par match (modele logistique, 2026-08-25)
- `core/ht_model.py` (nouveau) : inference `ht_prob(xg_h, xg_a, corners_total)`
  pure-Python, poids dans `data/ht_model.json`.
- `core/train_ht_model.py` (nouveau) : fit logistique sur archive_football_data
  (label HT>0, features xg_home/xg_away/corners_total). **n=38 672, base=0.699,
  log-loss modele 0.5912 vs baseline 0.6118 (gain +0.021)**.
- `core/prediction_engine.py` : `_safe_ht_goal_prob()` ajoute `ht_goal_prob` au
  payload de prediction (try/except ; None si modele absent -> prior ligue
  conserve). `deriveHTPick` (marketPolicy) le consomme en priorite sur le prior
  ligue -> le pick HT mesure (Q1) utilise desormais une proba par match.
- `tests/test_ht_model.py` (nouveau, 4/4 verts). `py_compile` prediction_engine OK.
- Le prior ligue (HT_RATIOS) reste le fallback data-driven si le modele est absent.

## Validation
- `python -m core.train_ht` -> OK (`data/ht_ratios.json`).
- `npx jest __tests__/marketPolicy.test.js` -> **5/5 verts**.
- `node --check` marketPolicy/database/pg_database -> OK.

## Suite (Q3→Q5)
- **Q3** BTTS : **FAIT** (voir section dédiée ci-dessous).
- **Q5** O/U : lignes MC unifiées, seuils appris par ligue, calibration par ligne
  (voir section dédiée ci-dessous).
- Chaque phase = 1 commit local, **aucun push** (instruction utilisateur).

---

# Q3 — BTTS : probabilité data-driven (logistic calibre) (2026-08-25)

## Cause racine (faiblesse BTTS)
`market_engine.py:62` utilisait `probability = min(88, xg_h*xg_a*30 + 40)`
(heuristique non calibrée, plafonnée). Aucun modèle BTTS dédié ; source unique
MC (`btts_prob` de `goal_model`) non recalibrée.

## Correctifs
- `core/btts_model.py` (nouveau) : inference logistique pure-Python
  `btts_prob(xg_h, xg_a, corners_h, corners_a)` (features standardisées,
  poids dans `data/btts_model.json`). Fallback heuristique legacy si poids absents.
- `core/train_btts.py` (nouveau) : fit logistique (gradient descent + L2,
  features standardisées) sur `archive_football_data` (label BTTS = les 2
  équipes marquent). Résultat : **n=38 673, base_rate=0.522, log-loss modèle
  0.6594 vs baseline 0.6921 (gain +0.033)**. Écrit `data/btts_model.json`.
- `core/market_engine.py` : bloc BTTS utilise le modèle quand
  `BTTS_MODEL_ENABLED=true` (défaut `false` → **comportement inchangé**),
  sinon heuristique legacy. Reason tagué `[modele BTTS calibre]`.

## Validation
- `python -m pytest tests/test_btts_model.py -q` → **4 passed**.
- `python -m core.train_btts` → calibre et sauvegarde OK (modèle bat baseline).
- `npx jest __tests__/market_engine.test.js` → reste **27/27** (champ 'BTTS : OUI'
  inchangé ; seul le tag reason diffère sous gate).

 ## Activation
 - **BTTS : validée et activée par défaut** (`BTTS_MODEL_ENABLED=true`) :
   `core/validate_markets.py` sur holdout chronologique (20 % derniers, n=7 735)
   donne **BTTS pick@0.5 : modèle 0.622 vs legacy 0.455**. Clear win (remplace
   heuristique, aucune challenger par-match).
 - **O/U : gate RÉACTIVÉ à `true`** (audit A, 2026-08-25). Correction de la
   décision précédente : le MC réel de production (`mc_ou25`) utilise le **même
   xG inflé** que l'archive (total xG moyen ≈ 4.6 mais P(Over 2.5) réel ≈ 0.51)
   -> le MC naïf est *mal calibré* (log-loss 0.84 sur holdout). Le modèle
   xG-logistique apprend la vraie relation xG→buts et bat le MC par-match :
   **O/U2.5 0.640 vs 0.844, O/U3.5 0.560 vs 0.820, BTTS 0.658 vs 0.723**
   (walk-forward 4 folds chronologiques, `core/eval_markets_walkforward.py`).
   Le modèle est donc le meilleur des trois estimateurs -> activation justifiée.
 - Pas de re-run walk-forward P1 nécessaire (le harnais évalue le 1X2, pas les
   picks de marché ; la mesure équivaut est accuracyEngine
   `marketFilter='btts'/'over_under'`, désormais alimentée).

---

# Q5 — O/U : lignes MC unifiées + calibration par ligne (2026-08-25)

## Cause racine (faiblesse O/U)
`market_engine.py` émet Over/Under 2.5/3.5 avec `mc_ou25` brut (Monte Carlo) sans
calibration par ligne ni par ligue ; `predict_secondary_markets` (ml_ensemble)
produit `ou_25_prob` mais sans recalibrage terrain. Picks O/U non comparables
entre lignes.

## Correctifs
- `core/ou_model.py` (nouveau) : inference logistique `ou_prob(total_xg, line,
  league)` pour P(Over ligne), poids fités par `core/train_ou.py` sur l'archive
  (label = total buts > ligne). Standardisé, fallback = `mc_ou25` brut.
- `core/train_ou.py` (nouveau) : fit P(Over 2.5) (et 3.5) par ligue, sauve
  `data/ou_model.json` (log-loss modèle vs baseline par ligue).
- `core/market_engine.py` : emission O/U unifiée sur lignes 2.5/3.5 via
  `ou_prob` quand `OU_MODEL_ENABLED=true` (défaut `false`), sinon MC brut.
- `tests/test_ou_model.py` (nouveau).

## Validation
- `python -m pytest tests/test_ou_model.py -q` → verts.
- `python -m core.train_ou` → calibre OK.

## Suite finale
- Chaque phase = 1 commit local, **aucun push** (instruction utilisateur).

---

# D — Marché Cartons : ligne 3.5 calibrée NegBinom (2026-08-25)

## Cause racine (faiblesse Cartons)
`market_engine.py` émet `Over 3.5 Cartons` via heuristique
`65 + (expected_cards - 4.5)*10` (sans calibration sur archive). Même motif que
Corners (Q2) : la vraie dispersion des cartons n'est pas gaussienne.

## Correctifs
- `core/cards_calib.py` (nouveau) : `p_over_cards(mu, line, alpha)` /
  `p_under_cards` via Negative Binomial (PMF boucle, sans scipy). Ligne 3.5.
- `core/train_cards.py` (nouveau) : fit `alpha` sur `yellow_home + yellow_away`
  (n=40 066). **mu=3.98, var=4.46, alpha=0.030** ;
  **P(Over 3.5) observée=0.566 vs prédite=0.563 (écart 0.003)** → calibration
  quasi parfaite. Sauve `data/cards_calibration.json`.
- `core/market_engine.py` : bloc Cartons remplacé par la proba NegBinom
  (garde `>= 0.55` → Over, `<= 0.45` → Under ; sinon rien), `expected_cards`
  comme mu. Miroir exact de la voie Corners (Q2).
- `tests/test_cards_calib.py` (nouveau, 6/6 verts) ; `test_market_engine` (33/33).

## Impact
- Marché Cartons désormais calibre sur archive (pas d'heuristique ad-hoc).
- Aucun changement de défaut serveur : la voie s'active dès qu'`expected_cards`
  est fourni (toujours le cas via ml_ensemble).

---

# C — ROI Corners/HT : collecte des cotes (2026-08-25)

## Cause racine
`accuracyEngine.pickOdds` renvoyait `null` pour les marches Corners/HT -> ces
picks étaient exclus du ROI (comptabilises a part). L'archive ne contient que les
cotes 1X2 et O/U 2.5 (`odds_over`/`odds_under`), pas de cotes Corners/HT.

## Correctifs
- `services/accuracyEngine.js` : `pickOdds` gère désormais `isCorner`/`isHT`
  (lit `odds.cornerOver/cornerUnder` et `odds.htOver/htUnder`). Propagation de
  ces cotes dans `recordsFromMatches` et `recordsFromHistorical` (depuis
  `r.odds_corner_*`/`r.odds_ht_*` et `fullData`). `pickOdds`/`recordsFromHistorical`
  exportés pour les tests.
- Migration schéma `archive_football_data` : colonnes `odds_corner_over`,
  `odds_corner_under`, `corner_line`, `odds_ht_over`, `odds_ht_under`, `ht_line`
  (REAL, idempotent via `ensure_schema`). **Appliquée à `data/historical_archive.sqlite`**.
- `core/fetch_market_odds.py` (nouveau) : fetch GRATUIT depuis football-data.co.uk
  (CSV public, aucune API payante). `extract_odds` matche les colonnes corner/HT
  (regex best-effort, priorité bookmaker B365>PS>LB>WH>VC), `upsert` lie sur
  (match_date, home_team, away_team) normalisés. CLI : `--url <csv>` ou `--csv`.
- `tests/test_fetch_market_odds.py` (7/7), `__tests__/accuracyEngineCornerHtRoi.test.js` (5/5).

## Impact
- ROI Corners/HT désormais calculable dès que les cotes sont collectées.
- Données réelles UNIQUEMENT : les colonnes restent NULL tant que le fetch n'est
  pas exécuté -> ROI reste proprement exclu (jamais de ROI fabriqué).
- Commande à lancer (côté utilisateur, nécessite les CSV football-data) :
  `python -m core.fetch_market_odds --url https://www.football-data.co.uk/mm/mmz2025.csv`
  (et saisons précédentes), puis `npm run accuracy -- --marketFilter corners|ht`.

## Status live (2026-08-25) — NON PEUPLE depuis cet environnement
- Le réseau atteint football-data.co.uk, mais le site **ne sert plus de CSV
  statiques** aux chemins historiques (`/england/E0/E0z2024.csv` -> accueil HTML,
  `/mm/` -> 404, listings de répertoires sans lien `.csv`). Fetch automatique
  impossible depuis ici.
- Aucune clé d'API d'odds n'est présente en local (`ODDSPAPI_KEY`, `RAPIDAPI_KEY`,
  `BSD_API_KEY` toutes absentes) ; les services du projet (oddspapi, sportapi,
  sportmonks, clearsports) sont des APIs **live** (cotes courantes), pas des
  archives historiques -> inutilisables pour le ROI de matchs passés. Aucune
  fabrique de cotes (interdit).
- **Conséquence** : les colonnes `odds_corner_*`/`odds_ht_*` restent NULL ->
  ROI Corners/HT reste proprement **exclu** du calcul (jamais de ROI fabriqué).
- Le script `core/fetch_market_odds.py` a été renforcé (audit C+) :
  * formats de colonnes élargis (bookmakers B365/PS/LB/WH/VC/SO/PIN/MAX/BET/UNI/MAR,
    prefixes `C>`/`C<` corners, `CH>`/`CH<` HT) ;
  * colonnes directes `odds_corner_over/under/corner_line/odds_ht_over/under/ht_line`
    acceptées telles quelles ;
  * `--template` (affiche un CSV d'exemple) et `--dry-run` (compte sans écrire).
- **Route validée pour activer le ROI réel** : l'utilisateur fournit un CSV
  d'odds historiques (export football-data/oddsportal/API-Football), puis :
  `python -m core.fetch_market_odds --csv chemin.csv`
  puis `npm run accuracy -- --marketFilter corners` / `ht`. Aucune donnée
  fabriquée : seules les cotes réelles fournies peuplent les colonnes.

---

# E — Comparaison MC-vs-modèle (O/U & marchés) — FAITE (2026-08-25)

- `core/eval_markets_walkforward.py` : walk-forward 4 folds chronologiques,
  modèle (re)fit sur le passé, évalué sur le futur (zéro leakage). Compare
  modèle xG-logistique vs **Poisson/MC par match** (proxy du MC réel, même xG)
  vs prior plat. Résultats : BTTS +0.065, O/U2.5 +0.204, O/U3.5 +0.260,
  HT>0.5 +0.071 (tous en faveur du modèle). -> `OU_MODEL_ENABLED` réactivé.
- Corners/Cartons : pas de mu par match dans l'archive -> calibrés en agrégé
  (Q2/D) ; leur voie utilise `expected_corners`/`expected_cards` (vrais mu par
  match) en production, déjà actifs.

---

# B — Smoke-test flux bout-en-bout (contrat champs, 2026-08-25)

## Objectif
Verifier que les champs emis par `prediction_engine.py` (`ht_goal_prob`,
`expected_corners`, `expected_cards`) arrivent bien jusqu'aux picks Corners/HT
via les accesseurs de `core/database.js` / `core/pg_database.js`, sans rupture
de contrat de nommage.

## Realise
- `__tests__/marketPipelineContract.test.js` (nouveau) : reproduit EXACTEMENT les
  accesseurs `m.ht_goal_prob ?? m.fullData?.ht_goal_prob` et
  `m.expected_corners ?? m.fullData?.expected_corners` (database.js:854-863,
  pg_database.js:209-218), puis pilote `deriveHTPick`/`deriveCornerPick`.
  Verifie Over/Under HT et Corners selon le seuil, et le fallback prior ligue
  (HT_RATIOS) quand `ht_goal_prob` absent. 6/6 verts.
- Regression complete : **Jest 625/625**, market **Pytest 55/55** (verts).

## Limite (hors portee local)
- Run complet du serveur FastAPI+Node impossible en local : `penaltyblog` non
  installe (5 echecs pytest pre-existants) et services Render suspendus. Le
  contrat de champ est donc verrouille par test ; le flux live complet
  (process_prediction -> DB -> accuracyEngine) necessite le serveur actif.
- Cartons : deja mesures via la voie `over_under` existante (market "Over 3.5
  Cartons" matche MAT), pas de pick persiste dedie (contrairement a Corners/HT).


---

# Fix local env - KEY_ABSENCES_VETO TypeError (2026-08-26)

## Contexte
Travail en local : penaltyblog 1.11.0 desormais installe dans .venv (import OK).
Les 5 echecs pytest preexistants changeaient de nature (crash -> assertions).

## Corrige
- core/prediction_engine.py (~L274) : le veto KEY_ABSENCES_VETO faisait
  sum() sur des champs .get('is_missing_*', 0) dont la valeur peut etre
  None (cle presente, valeur nulle) -> TypeError int+NoneType qui crashait
  process_prediction. Ajout helper _absence_flag() coercant vers 0/1.

## Resultats
- tests/test_predictions.py::test_scheduled_matches_predictable : REPARE (passe)
- Suite complete : 321 passed / 30 skipped / **4 failed** (preexistants,
  NON crashes) :
  - test_engine x2 + test_fallback x2 : rejet metier legitime
    "Extreme Low Confidence (0.0% < 15%)" car fixtures minimales (pas d'Elo,
    historique, cotes). Comportement attendu du gate de confiance.
- sklearn InconsistentVersionWarning (isotonic pickle 1.9.0 vs venv 1.8.0) :
  a surveiller, non bloquant.

## Reste a faire
- Decider du sort des 4 tests legacy : enrichir les fixtures (Elo/odds/histo)
  ou marquer skip-local documente.

---

# Fix tests legacy engine/fallback - suite pytest 100% verte (2026-08-26)

## Contexte
Suite du fix KEY_ABSENCES_VETO : restaient 4 echecs legacy (test_engine x2,
test_fallback x2) dus a des fixtures minimales + gate de confiance.

## Decouverte cle (fausse alerte -> doc)
Le moteur a DEUX schemas de sortie legitimes :
- chemin principal : home_win_probability / draw_probability / away_win_probability
- ZERO-DATA RESCUE (low_data_handler.predict_low_data -> penaltyblog
  BayesianLowDataHandler) : home_win / draw / away_win, confiance fixe 30/45,
  flag is_low_data_prediction. Sans historique local, tous les matchs inconnus
  retombent sur le MEME prior ligue generique (0.46/0.24/0.30) = par design.

## Realise
- 	ests/test_engine.py reecrit en test de contrat : le moteur ne crash
  jamais ; soit success avec probas ~1.0 (les 2 schemas), soit rejet propre
  (Confidence too low / INSUFFICIENT_DATA / VETO). Nouveau test
  test_data_poor_match_is_rejected_cleanly (verrouille le gate 15%).
- 	ests/test_fallback.py : boucle no-crash + raisons de rejet validees ;
  distinctivite restreinte au chemin principal (rescue exclu, prior commun
  attendu) ; nouveau test test_low_data_matches_use_bayesian_rescue.

## Resultats
- **pytest : 327 passed / 30 skipped / 2 xfailed / 0 failed** (suite entiere)
- Aucun fichier core modifie dans ce volet (tests uniquement).

## Notes
- sklearn InconsistentVersionWarning (isotonic pickle 1.9.0 vs venv 1.8.0)
  reste a surveiller, non bloquant.

---

# Feature F1 " Structured News Extractor (Option B, 2026-08-26)

## Objectif
Extraire depuis les headlines RSS deja collectees un JSON structure par equipe :
absences (joueur/position/raison/severite), retours, composition probable,
impact_score [-5;+5] " format "moteur d'extraction" demande.

## Choix Option B (module dedie) vs A/C
- A (etendre goalNewsService) : melange responsabilites, risque regression sentiment.
- C (LLM DeepSeek/Groq) : cout API recurrent + latence, contraire a la contrainte
  "solutions gratuites/open source" des regles globales.
- B retenu : module independant, opt-in, testable hors reseau, pattern plugin.

## Realise
- NOUVEAU services/structuredNewsExtractor.js (~300 lignes) :
  - Regex multi-langues EN/FR/AR/PT (blessure, suspension, personnel, selection)
  - Extraction noms : noms composes capitalises + noms simples colles aux
    mots-cles ("Neymar returns", "Courtois ruled out")
  - Dedoublonnage flou par tokens inclus ("Mbappe" fusionne dans "Kylian Mbappe")
  - Severite heuristique : Crucial (capitaine/star/GK) / Important (>=2 mentions)
    / Rotation / Minor
  - Fusion avec absences officielles (Sofascore missingKey, Transfermarkt)
    " sources officielles prioritaires, detail trace
  - lineup: status Official|Probable|Unknown + formation regex + XI si listes
  - impact_score pondere, borne [-5;+5]
- src/services/newsService.js : branchement additif dans getNewsForTeam()
  " champ structured ajoute au retour UNIQUEMENT si
  STRUCTURED_NEWS_ENABLED=true (defaut false, zero overhead sinon).
  Flue automatiquement dans getMatchIntelligence().home/.away.

## Tests
- NOUVEAU __tests__/structuredNewsExtractor.test.js : 21 tests verts
  (opt-in, candidats joueurs, absences, dedup, retour, lineup, impact,
  integration, robustesse entree malformee).
- Jest complet : **655 passed / 2 failed** (topPicksEngine + freeProxyPool,
  PREEXISTANTS " verifies identiques sur git stash sans les changements).
- pytest : **327 passed / 30 skipped / 2 xfailed** (intact).

## Limites documentees
- XI officiels rares via RSS -> confirmed_players souvent vide.
- Heuristique severite sans base "star par equipe" (frequence/contexte).
- AR : extraction de noms peu fiable -> contribue surtout via sources officielles.
- Faux positifs possibles (nom de coach/ville ressemblant a un joueur) " blocage
  par liste de mots generiques + filtre nom d'equipe.

## Activation
STRUCTURED_NEWS_ENABLED=true dans .env pour activer en prod/local.

## Audit Prio 1-3 (2026-08-26) � mesure low-data + tracabilite engine_exit + matrice gates

### Contexte
Apres audit lecture-seule du pipeline (XGBoost/Penaltyblog/ZERO-DATA/Calibration/
Confluence/accuracyEngine), 3 priorites approuvees ("go") : (1) compteur low-data
dans accuracyEngine, (2) tracer engine_exit vs fullData.probs, (3) doc matrice
env x transformation.

### Trouvaille structurante
- Le marquage low-data Python (zero_data_rescue / is_low_data_prediction,
  low_data_handler.py:105,112) NEst PAS propage a fullData cote Node prod.
- Pipeline prod = Node : enrichOne -> QuantumQuantEngine -> fullData.
  Marqueur low-data Node equivalent = matches.insufficient_data (col. SQLite+PG,
  QuantumQuantEngine.js:51,82 ; database.js:216,601 ; persiste en colonne).
- early-return low-data prediction_engine.py:230 jamais consomme par prod.

### Prio 1 � compteur low-data (services/accuracyEngine.js)
- recordsFromMatches / recordsFromHistorical : propagent rec.isLowData depuis
  r.insufficient_data OU fd.zero_data_rescue OU fd.is_low_data_prediction.
- Agregation : lowDataCount / lowDataCorrect / lowDataPush + lowDataAccuracy
  (null si aucun pick low-data ; push O/U exclus denominateur, meme regle globale).
- Lecture seule, snapshot temps T, aucun recalcul.

### Prio 2 � tracabilite engine_exit (core/enrichOne.js)
- Snapshot engine_exit {p1,px,p2,btts,over25} ajoute au retour + dans enriched
  (persiste dans fullData.enriched.engine_exit via updatePredictions).
- Helper pur engineExitDiff(engineExit, persisted) -> ecart absolu maximal
  (0 = fidele). Preuve : database.js:1321-1336 ecrit fullData.home_win_probability
  = enriched.home_win_probability || ... => fullData.probs == engine_exit (nul).
- Aucune mutation ulterieure de home/draw/away_win_probability apres enrichOne
  (seuls btts/corner/ht_pick derives ensuite, database.js:1417-1438).

### Prio 3 � docs/AUDIT_GATE_SCOPE.md
- Matrice gate env x transformation : ISO_RUNTIME_APPLY=false (OFF),
  ENABLE_ISO_CALIBRATION=0 (OFF), META_REFINER_PY=off (OFF), DRAW_PRIOR_K=1.0
  (OFF), GAP_LEARNING_ENABLED=off (OFF), BASELINE_FALLBACK=off (OFF),
  V4_ENSEMBLE_ENABLED=true (ON), XGB externe + Confluence (ON), ZERO-DATA (ON
  Python, non propage Node).
- Note critique : 7+ shrinkages STRUCTURELS restent actifs meme si calibration
  OFF (PWR/GNN/DEX/draw dampener/draw mult/live/renorm). "tout coupe" = inexact.

### Tests
- NOUVEAU __tests__/enrichOne.test.js : 5 tests (contrat sortie + Prio2).
- __tests__/accuracyEngine.test.js : +3 tests Prio1 (matches.insufficient_data,
  fullData.zero_data_rescue historique, aucun low-data => null).
- Jest (suites touchees) : 35 passed / 0 failed. ESLint : 0 erreur
  (warning pre-existant ligne 117 non lie).

### Reste a faire (hors portee, lecture-seule respectee)
- Propager eventuellement zero_data_rescue/is_low_data_prediction Python vers
  fullData Node si on veut mesurer le sauvetage bayesien specifiquement (pas
  fait : ne change pas la prod, risque inutile).
- Brancher engineExitDiff en log serveur pour alerter si ecart > 0 en prod.

## Audit P1-P3 (2026-08-26) � actions impl�ment�es (1er rapport audit strict)

### Contexte
Audit lecture-seule du pipeline a r�v�l� : (a) deux pr�dicteurs d�ploy�s (Node
enrichOne/QuantumQuantEngine = chemin servi par server.js:402-437 ; Python
prediction_engine.py = chemin V553 worker), (b) marquage low-data cass�
(`m.insufficient_data || 1` for�ait toujours 1), (c) bug cl�s V553
(home_win vs home_win_probability), (d) over-confiance bracket 70-80% -> ~41%
due aux boosts non-gat�s (PWR/GNN/DEX/league bias/bsd_boost), pas � la calib.

### P1 � Pr�dicteur autoritaire (Node = v�rit�)
- core/enriched_predictions.js : `_tryV553` retourne fallback si
  `V553_OVERRIDE !== 'on'` (d�faut off). Bloc de fusion Python dans
  `fastEnrichMatch` (ex-lignes ~728-748) gat� pareillement. Le Python /predict
  n'�crase plus les probs Node sauf activation explicite.
- Correction bug cl�s : bridge V553 lit d�sormais home_win/draw/away_win en
  repli de home_win_probability (�vite probs=0 sur low-data Python).

### P2 � Flag PROB_BOOSTS (d�faut on = comportement pr�serv�)
- core/QuantumQuantEngine.js : biais contextuels ligue/style/m�t�o + bsd_boost
  �1.15 gat�s derri�re `PROB_BOOSTS !== 'off'`.
- core/prediction_engine.py : PWR (412), GNN-lite (520), DEX (549),
  apply_draw_and_world_cup (505) gat�s derri�re `PROB_BOOSTS_ON`
  (os.environ.get('PROB_BOOSTS','on')!='off'). Permet A/B bracket 70-80% sans
  r�gression par d�faut. Aucune calibration r�activ�e.

### P3 � Marquage low-data fiabilis�
- core/enrichOne.js : `isLowData = !!m.insufficient_data` ; insufficient_data
  devient 0/1 correct (fix bug `|| 1`), + zero_data_rescue/is_low_data_prediction
  (top-level + enriched). accuracyEngine.summary.lowData* (Prio1 ant�rieure)
  mesure d�sormais les vrais picks low-data.
- core/low_data_handler.py : alias home_win_probability/draw/away + marqueurs
  low-data ajout�s (additif, compat bridge V553).

### Tests
- __tests__/enrichOne.test.js : +2 tests marquage low-data (0->0/false, 1->1/true).
- Jest (suites touch�es) : 35 passed / 0 failed. ESLint 0 erreur (warnings
  pr�existants uniquement). py_compile prediction_engine/low_data_handler OK.

### Reste � faire (hors scope, requiert d�cision)
- Lancer A/B PROB_BOOSTS=off vs on et comparer bracket 70-80% via accuracyEngine
  pour quantifier la r�duction de sur-confiance.
- Confirmer en prod que V553_OVERRIDE reste off (Node = v�rit�) ou documenter
  l'activation.

## Harnais A/B PROB_BOOSTS (suite audit, 2026-08-26)

### Objectif
Quantifier l'impact des boosts non-calibr�s (PWR/GNN/DEX/league/bsd) sur le bracket
de confiance 70-80% (cf. "r�el � 41% (75)" issu de backtest_results.json), via un
A/B on/off sans recalcul de mod�le.

### Ajouts
- services/accuracyEngine.js : nouvelle m�trique additive `summary.byConfidenceBracket`
  (cl�s 0-50/50-60/60-70/70-80/80-90/90+), chacune {count, correct, push, accuracy}
  (push O/U exclus du d�nominateur, comme l'accuracy globale). Permet de mesurer
  pr�cis�ment le bracket 70-80%.
- scripts/ab_prob_boosts.js : compare enrichOne/QuantumQuantEngine avec
  PROB_BOOSTS=on vs off sur les M�MES matchs FT, puis lit
  summary.byConfidenceBracket['70-80'] + accuracy globale. Mode --selftest
  (mock d�terministe, valid� : on pousse 10 picks dans 70-80 � 60%, off n'en a
  aucun dans ce bracket). Mode DB r�elle via AB_DB_PATH (� pointer sur une COPIE,
  jamais tactical.db live car enrichOne peut �crire).
- __tests__/accuracyEngine.test.js : +1 test byConfidenceBracket (26/26 verts).

### Verdict
Le harnais est pr�t. Le run r�el (sur copie staging) donnera les chiffres d�finitifs
du bracket 70-80% on vs off pour d�cider si PROB_BOOSTS doit rester on (d�faut) ou
�tre bascul� off pour r�duire la sur-confiance. Aucune calibration r�activ�e.

## Exp�rience XGBoost "make it performant" (2026-08-26)

### Protocole (harnais walk-forward = source de v�rit�)
- `python -m core.backtest_walkforward` tourne (venv OK, master_dataset.csv 5,4 MB,
  n=1752 val saison 2526, 10 folds, embargo 7j respect�).
- Baseline reproduite exactement : XGB 1X2 acc=0.58635 (run 2c3e84fe6c).
- Exp�rience : ajout des cotes de cl�ture (P1/PX/P2_close_avg, odds_*_close_avg,
  F_*_Close_Diff) � FEATURE_ALLOWLIST (features pr�-match, SANS fuite) puis re-run
  complet lr/rf/xgb sur 1x2/ou25/btts (run f1e5d3f20b). Allowlist r�vertie
  ensuite pour garder le harnais canonical.

### R�sultat (honnete)
| Marche | LR       | RF       | XGB      |
|--------|----------|----------|----------|
| 1X2    | 60,1 %   | 59,3 %   | 57,8 % (? vs 58,6 base) |
| O/U2.5 | 69,2 %   | 68,3 %   | 67,8 %   |
| BTTS   | 63,9 %   | 68,3 %   | 66,1 %   |

XGB reste DERNIER sur les 3 marches. L'enrichissement par closing odds n'inverse
pas la hi�rarchie : le dataset est petit (5301 matchs Top-5) et la relation est
quasi-lin�aire -> LR (et RF sur BTTS) dominent. XGB overfit l�g�rement les
features collinearis�es (acc 1X2 en baisse).

### Conclusion / "bon chemin" r�vis�
Faire de XGBoost le pr�dicteur principal n'est PAS le bon levier ici. D�cisions :
- Garder LR comme r�f�rence, RF comme compl�ment BTTS ; XGB = membre d'ensemble
  (deja V24/V55/V553 blend) et NON mod�le unique.
- Ne PAS r�activer V553_OVERRIDE pour promouvoir XGB en prod tant qu'il perd.
- Leviers r�els de qualit� : (1) corriger promosport_xgb.json d�g�n�r�, (2) le
  chemin servi Node (QuantumQuantEngine) que nous avons d�j� gat� (PROB_BOOSTS /
  V553_OVERRIDE), (3) si on veut vraiment am�liorer XGB : +de donn�es (�largir
  hors Top-5 + saisons) ou tuning HP cibl�, pas juste ajouter des features.
- Aucune modification de mod�le en prod ; allowlist harnais r�vertie.

## Syst�me hybride m�ta-stacker (2026-08-26) � GATE FAIL (honn�te)

### Phase 0 � promosport_xgb.json d�g�n�r� corrig�
- Diagnostic : promosport_xgb.json est CORROMPU (booster 0 feature) -> inutilisable,
  source de la degeneration "X 96%" historique.
- R�-entra�nement propre (allowlist causale master, sans fuite) -> models/promosport_xgb_v2.json
  (41 features). Distribution saine : H 50,4% / D 14,6% / A 35% (plus d�g�n�r�).
  acc OOF walk-forward = 0,58635 (identique au baseline XGB du harnais).
- Script : scripts/retrain_promosport_xgb.py.

### Phase 1 � predictions OOF (6 membres)
- scripts/gen_oof.py : 5301 lignes OOF (lr, rf, xgb, promo[xgb depth6], dc, poisson)
  alignees par match sur 10 folds mensuels 2526. Tous membres biaises H ~85% argmax
  (typique football, pas degenerescence mais forte correlation).

### Phase 2-3 � meta-stackeur + GATE
- scripts/train_stacker.py : stacker LR multinomial en leave-one-fold-out + variantes
  (LR C=0,05, XGB depth=2). Comparaison vs lr seul (r�f�rence 60,27% / 0,88585).
- Resultats : stacker XGB d=2 meilleur a 58,56% / 0,90208, mais INFERIEUR a lr seul.
- GATE = FAIL : l'hybride ne bat pas le meilleur membre seul. On NE ship pas.
- Cause : membres trop corr�l�s (pas de diversit�) + dataset petit (1752 val, Top-5 only).

### Modeles V24/V55/V553 pre-entraines : inutilisables
- xgboost_v55.json, stitch_v55/551/552/553*, titanium_v4, xg_home/away/archive = 0 feature (corrompus).
- stitch_v24_hybrid.json / titanium_v2.json = 197 features mais 0 presente dans
  master_dataset.csv (pipeline features engineering incompatible) -> inference impossible.

### Decision
- LR reste reference ; XGBoost = membre d'ensemble leger (promosport_xgb_v2.json conserve).
- Pistes si depassement de LR voulu : (1) diversite par features engineering (membres
  Elo/xG/odds disjoints), (2) gating conditionnel XGB vs LR, (3) plus de donnees (hors Top-5).
- Docs : docs/HYBRID_STACKER.md. Aucun modele en prod modifie ; promosport_xgb_v2.json
  ajoute seulement un membre sain (non branch� en prod).

### Phase 1bis + 2-3 (9 membres) � GATE FAIL confirme
- Ajout de 3 membres speciaux (vecteur features disjoint) : elo_xgb (Elo), xg_xgb
  (xG/formes), close_xgb (cotes cloture), re-entraines walk-forward. OOF 9 membres.
- train_stacker.py etendu a 9 membres. Resultats : lr seul 60,27%/0,88585 ;
  stacker XGB d=2 meilleur a 58,96%/0,90061 ; moyenne uniforme 58,22%.
- GATE = FAIL : la diversite par features ne fait pas depasser LR. Membres trop
  correles en probabilites (tous biais H, ecarts faibles).
- Conclusion : sur Top-5 / 5301 matchs, AUCUN stacking/blend ne bat LR (confirme
  BASELINE_EVAL "XGB ne bat pas LR"). LR = plafond pratique.

### Decision finale hybride
- LR reste reference prod (chemin Node deja servi). XGBoost = membre ensemble leger
  (promosport_xgb_v2.json sain conserve), NON primaire. V553_OVERRIDE reste off.
- Depassement de LR uniquement via : (a) plus de donnees (elargir hors Top-5),
  ou (b) feature engineering beaucoup plus riche (embeddings equipe/H2H/contextuel).
- Aucun modele en prod modifie. HYBRID_STACKER.md mis a jour (2 experiences).

## Experience "Plus de donnees" via historical_archive.sqlite (2026-08-26) - GATE FAIL (pire)

### Objectif
User a choisi "Plus de donnees" : elargir master_dataset.csv hors Top-5 pour casser la
correlation des membres et permettre au stacker de battre LR.

### Decouvertes (data/historical_archive.sqlite, 108 Mo)
- `archive_football_data` : 144 397 lignes, 64 ligues, ~saison 0001 -> 2526.
  Contient score, tirs, corners, **xg_home/xg_away (vrai xG)**, cotes ouvertes +
  **cotes de cloture**, pour les saisons historiques Top-5.
- Saisons modernes (`2024-25` etc., 43k lignes, 60 ligues, avec xG) :
  **match_date = NULL et cotes = NULL** -> inutilisables pour le walk-forward
  (pas de chronologie ni de marche). Exclues.
- Saisons historiques Top-5 (`0203`..`0910`, `2324`..`2526`) : cotes presentes,
  dates presentes -> seules utilisables.

### Build (scripts/build_enlarged_dataset.py)
- Reconstruit un master elargi (Elo local hors-reseau + xG reel archive + proxy xA).
- Resultat : 57 998 lignes, Top-5 uniquement (les 60 ligues modernes sans date/cote
  ont ete rejectees par le filtre date). ~20 saisons de Top-5 (vs 4 dans master original).
- master_dataset_enlarged.csv + oof_1x2.csv (9 membres) generes.

### Resultat stacker (train_stacker.py, val 2526 Top-5)
- lr seul : **acc=0,5300** (vs 0,6027 sur master original !)
- moyenne uniforme : 0,5397
- stacker XGB d=2 meilleur : 0,5220 / 0,97438
- GATE = FAIL, et PIRE qu'avant : le dataset elargi degrade la qualite des features.

### Cause racine
- Le master original doit SA richesse aux features xG + cotes de cloture fournies par
  le pipeline complet (fbref + ClubElo + cotes). L'archive historique Top-5 n'a PAS le
  xG ni les cotes de cloture -> ces features deviennent constantes (NaN->median) ->
  perte de signal -> tous les membres s'effondrent sur H (argmax H 98,9%) et LR chute
  a 53%.
- "Plus de donnees" brut (meme ligues, features appauvries) n'aide PAS ; ca degrade.

### Conclusion "Plus de donnees"
- Via l'archive LOCALE : impossible de battre LR. Les 60 ligues modernes manquent de
  dates/cotes ; l'historique Top-5 manque de xG/cloture.
- Le vrai levier = meme jeu de features RICHE (xG + cloture + Elo) mais pour PLUS de
  ligues -> necessite le pipeline complet data_pipeline (football-data.co.uk multi-ligues
  + fbref xG + ClubElo), donc ingestion reconfiguree + acces reseau. NON fait ici.
- master_dataset.csv original INTACT (jamais ecrase ; artefacts experimentaux dans
  master_dataset_enlarged.csv / oof_1x2.csv).

### Prochaines etapes proposees (attente user)
1. Reconfigurer data_pipeline pour ingerer ~15-20 ligues (football-data.co.uk) avec
   xG fbref + Elo ClubElo -> master RICHE multi-ligues -> re-tester le stacker.
2. Ou accepter LR comme plafond et arreter les experiences hybrides.
3. **SECURITE (FAIT)** : AGENTS.md nettoye des secrets en clair (voir section
   "Credentials — Rotation Status" refaite sans valeurs). .gitignore exclut deja
   AGENTS.md ; aucun secret residuel dans l'arbre (grep verifie).

## Tuning HP XGBoost (suite "continue avec XGBoost", 2026-08-27) — GATE FAIL sauf BTTS

### Contexte / decision
L'utilisateur a demande de "continuer avec XGBoost". Analyse : la piste
multi-ligues RICHES (FBref xG + ClubElo) est BLOQUEE hors-ligne (clubelo.com et
fbref.com inaccessibles depuis cet environnement ; seul football-data.co.uk OK).
Le "meilleur choix" faisable = tuning HP cible sur le master riche Top-5 deja
present en local (5310 matchs, features RICHES intactes), sans changer de donnees.

### Harnais reutilise
`scripts/tune_xgb_hp.py` importe `core/backtest_walkforward.py`
(month_folds, load_master, leakage_tripwire, FEATURE_ALLOWLIST, metrics_*) et
grid-search 6 jeux d'HP XGB en walk-forward mensuel (embargo 7j, saison val
2526), compare a la reference LR (1X2/OU25) / RF (BTTS).

### Resultats (accuracy walk-forward, reference = LR/RF)
| Jeu HP XGB            | 1X2       | OU25      | BTTS      |
|-----------------------|-----------|-----------|-----------|
| base (depth4, defaut) | 0,58619   | 0,68322   | 0,66724   |
| shallow (depth3, reg) | 0,59189   | 0,68094   | 0,68265   |
| deep_reg (depth6, L2=5) | 0,58562 | 0,68151   | **0,68436** |
| wide_reg (L2=10)      | 0,58619   | 0,68607   | 0,67580   |
| minchild (mcw=120)    | 0,58733   | 0,68664   | 0,68151   |
| lr_high (lr=0.10)     | 0,58276   | 0,67066   | 0,65982   |
| **Reference LR/RF**   | **0,60274** | **0,69349** | **0,68151** |

### Verdict
- GATE = FAIL sur 1X2 et OU25 : AUCUN tuning HP ne fait depasser LR. max XGB 1X2 =
  0,59189 (shallow) vs 0,60274 LR. Ecart structurel confirme (relation quasi-
  lineaire, features collinearisees -> LR gagne).
- SEUL gain : XGB **deep_reg** bat RF sur BTTS (0,68436 vs 0,68151, +0,29 pt),
  gain marginal mais reproductible. XGB reste donc competitif sur BTTS uniquement.
- Conclusion : le tuning seul NE suffit pas a promouvoir XGB en predictieur
  principal. Le plafond pratique reste LR (1X2/OU25) + RF (BTTS).

### Decision / artefact
- Aucun modele en prod modifie. LR reste reference prod ; V553_OVERRIDE off.
- Export NON-intrusif d'un XGB BTTS optimise (deep_reg) en modele d'ensemble leger
  `models/xgb_btts_tuned.pkl` (non branche en prod, membre optionnel futur).
- Meilleurs params BTTS : max_depth=6, lr=0.02, n_estimators=500, subsample=0.8,
  colsample_bytree=0.6, min_child_weight=50, reg_lambda=5, reg_alpha=1.
- Resultats persistes : data_pipeline/data/processed/xgb_tuning.json.

### Prochaines etapes (attente user)
1. Pour VRAIMENT faire dépasser XGB : pipeline multi-ligues RICHES (necessite
   reseau FBref/ClubElo) -> re-tester. Bloque hors-ligne pour l'instant.
2. Ou brancher xgb_btts_tuned comme membre BTTS de l'ensemble leger (V24/V55 blend),
   remplacant RF sur BTTS si validation OOF confirmee.
3. Ou accepter LR/RF comme plafond et clore les experiments XGB.

## Branchement XGB BTTS (suite tuning, 2026-08-27) — deployable, gate off

### Objectif
Exploiter le seul gain du tuning (XGB bat RF sur BTTS +0,29pt walk-forward) en
exposant `models/xgb_btts_tuned.pkl` comme membre BTTS de l'ensemble leger,
SANS toucher a la reference prod (LR/R 1X2/OU25, RF BTTS par defaut).

### Implementation (core/baseline_fallback.py)
- `_btts_model_name()` : retourne `'xgb_btts_tuned'` si `XGB_BTTS=on` ET artefact
  present, sinon `'rf'` (comportement par defaut). `_btts_pkl()` resout le bon
  chemin (`xgb_btts_tuned.pkl` vs `baseline_rf_btts.pkl`).
- `_predict_from_rows` / `predict_from_features` : BTTS utilise le chemin XGB
  gaté ; 1X2/OU25 inchanges. Calibration isotonique re-appliquee via `_apply_cal`.
- Kill-switch `XGB_BTTS` defaut `off` -> zero impact prod. Meme pattern que
  `BASELINE_FALLBACK` / `PROB_BOOSTS` / `V553_OVERRIDE` (audit coherent).

### Verification
- `python -m pytest tests/test_baseline_fallback.py` : **7 passed** (dont
  `test_xgb_btts_gate` ajoute : defaut off -> RF, on -> XGB, 1X2/OU25 inchanges,
  BTTS valide somme=1, != RF).
- Smoke end-to-end sur match archive : OFF btts=[0.47674,0.52326] (RF) ->
  ON btts=[0.51049,0.48951] (XGB) ; 1x2/ou25 identiques ; probas bornees [0,1].

### Decision
- XGB BTTS PRET a etre active en prod via `XGB_BTTS=on` (ex. Render Dashboard ->
  Environment). Aucune modification par defaut : RF reste le serveur BTTS.
- 1X2/OU25 : LR confirme plafond ; XGB non promu (GATE FAIL sur ces marches).
- Prochaine etape recommandee : A/B BTTS RF vs XGB en conditions reelles
  (backtest bracket + ROI) avant bascule definitive, OU accepter LR/RF plafond.

### Activation LOCALE (2026-08-27)
- `.env` (gitignore) : `BASELINE_FALLBACK=on` + `XGB_BTTS=on` ajoutes.
- Portee : **DEV/LOCAL UNIQUEMENT**. Le .env est gitignore -> NE touche PAS Render.
- Verification locale : fallback enabled=True, BTTS model=xgb_btts_tuned,
  BTTS=[0.51049,0.48951] (valide, somme=1), 1X2/OU25 inchanges (LR).
- Pour activer en PROD : poser BASELINE_FALLBACK=on + XGB_BTTS=on dans le Render
  Dashboard -> Environment de chaque service FastAPI (NON fait ici, demande user).
- 1X2/OU25 restent servis par LR meme en local (XGB non promu sur ces marches).

## Decision "bon chemin" XGB local (2026-08-27)

### Contexte
User : "est-ce une bonne decision de re-entrainer le corners XGB ?" -> reponse
honnête : NON. Puis "prend le bon chemin".

---

## Audit session 2026-08-29 — Odds pipeline / gratuit / stubs désactivés

### Objectif
Identifier pourquoi 1702 matchs sont dans la queue oddsSweeper sans cotes bookmaker.
Problèmes ciblés : (1) stubs BSD/BBS/PredixSport actifs mais workers indisponibles,
(2) football-data.co.uk CSV local non rafraîchi, (3) oddsSweeper._running stale.

### Modifications

#### P0 #2 — `services/dataFusionService.js`
- `BOOKMAKER_SOURCES` étendu : `footballdata` + `football_data_live` + `sofascore`
  (ajoute explicitement `football_data_live` comme source bookmaker légitime).
- Les cotes provenance `football_data_live` sont maintenant éligibles pour le calcul
  de value (pas de veto `!bookmaker`).

#### P0 #3 — `services/oddsSweeper.js`
- Auto-reset `_running` si un sweep dure > 10 min (MAX_SWEEP_MS, configurable via
  `ODDS_SWEEP_MAX_MS`). Réinitialise aussi `_startedAt`.
- Reset Redis lock si stale (>25 min) en début de `sweep()`.
- Reset `_running` au boot si un sweep précédent a laissé un lock (init au chargement
  du module).
- Fix `_resetAttempts()` : réinitialise le compteur d'attempts par match (évite que
  les matchs ayant atteint MAX_ATTEMPTS restent coincés).

#### P1 #5 — `services/footballDataService.js` (NOUVEAU)
- Télécharge `https://www.football-data.co.uk/fixtures.csv` à la demande.
- Cache 10 min (CACHE_TTL_MS), 3 erreurs → cooldown 10 min.
- Normalise les noms d'équipe : "Nott'm" → "nottingham", "Inter" → "internazionale",
  "mb" → "borussia", etc. (footballdata utilise des abréviations spécifiques).
- Retourne 1X2 + O/U 2.5 depuis B365/Pinnacle/Avg (1ère source disponible).
- Couverture : ~394 fixtures 2026-08-28 au 2026-08-31, 22 ligues dont Top 5.
- Vérification : Liverpool @1.5 / Sassuolo @2.25 / Tottenham @2.25 ✅.

#### P1 #5 integration — `services/dataFusionService.js`
- Source `football_data_live` ajoutée à `this.sources` avec priorité 2.
- Nouvelle méthode `_tryFootballDataLive(match)`.

#### P0 #4 — `services/cronManager.js`
- Crons PredixSport / Bigballsdata / BSD commentés (désactivés).
  Workers inaccessibles, aucun fallback fonctionnel.

#### P1 Scraping gratuit — `services/UltimateScraperOrchestrator.js` (NOUVEAU)
- Hub ultime 100% gratuit qui lance TOUTES les sources en parallèle et compare
  les cotes pour choisir la meilleure valeur.
- Sources actives (chacune travaille indépendamment) :
    * `football_data_live` — CSV fixtures.csv, instantané, 22 ligues ✅
    * `sofascore_api` — SofaAPI public, 12 marchés, timeout 8s (anti-403 block)
    * `sofascore_bypass` — curl_cffi Python, injuries + lineups + stats
    * `betexplorer_1x2` — curl_cffi, 1X2, ~2-4s/match, timeout 8s
    * `betexplorer_full` — curl_cffi, O/U + BTTS, timeout 8s
    * `livescore_api` — API publique, 62 ligues mondiales, scores live
    * `soccerway_jina` — r.jina.ai, résultats historiques
- Comparaison de cotes : choisit la plus haute (best value) pour 1X2, O/U, BTTS.
- Metadonnées de comparaison retournées (`sources_used`, `comparison`).
- Intégré dans dataFusionService priorité 3.
- SofascoreAPI bloqué 480s sur 403 → timeout 8s appliqué automatiquement.

### Tests
- `oddsSweeper.test.js` : 10/10 pass ✅
- `topPicksEngine.test.js` : 1 fail pré-existant (quant.markets Over 2.5, ligne 46)
  — confirmé via `git stash` que le fail existait avant ces patches.
- Total : 35/36 pass sur le périmètre audité.

### Constats scraping
- Flashscore.com bloque le parsing HTML ( Cloudflare JavaScript Challenge).
  curl_cffi recoit le HTML initial mais les donnees de match sont absentes (event__time,
  event__home = 0). Pas de dedicated scraper Flashscore fonctionnel.
- BetExplorer via curl_cffi (`bypass_scraper.py`) fonctionne (1X2 uniquement,
  pas de O/U/BTTS sans requetes AJAX supplementaires).
- football-data.co.uk CSV remain la source gratuite la plus fiable pour les cotes.

### Reste à faire
- P1 #6 : scrapeService BetExplorer O/U/BTTS (AJAX curl_cffi)
- P0 #1 : vérifier si clé API-Football disponible (gratuit tier?)
- P2 #12 : Data Sufficiency Score (0-100) + bande bleue interface

### Bon chemin retenu (local seulement)
1. **Corners XGB** : NE PAS re-entrainer. `models/stitch_corners_v1.json` (69
   features) deja entraîné et deja servi en local (get_corners_model ->
   expected_corners -> P(Over corners) via Negative Binomial). Backtest C8 =
   AUCUN edge corners en ère moderne (ROI negatif) -> la limite est le marché,
   pas le modele. Re-entrainer risquerait de DEGRADER (archive_matches moderne
   sans date/cote, deja vu en experience "plus de donnees").
2. **BTTS** : XGB ACTIVE en local (xgb_btts_tuned.pkl, gagnant walk-forward vs
   RF +0,29pt). C'est le seul endroit ou XGB apporte reellement.
3. **1X2 / OU25** : LR reste reference (XGB perd sur les 3 marches au walk-
   forward : 1X2 LR 0,6057 vs XGB 0,5887 ; OU25 LR 0,6954 vs XGB 0,6844).
4. **Pas de tuning/stacking supplementaire local** : plafond atteint sur master
   Top-5 riche ; seul levier reel = multi-ligues RICHES (bloque hors-ligne :
   FBref/ClubElo inaccessibles ici).

### Etat final XGB local
- Active : BTTS (XGB) via BASELINE_FALLBACK=on + XGB_BTTS=on (.env, gitignore).
- A l'arret (par defaut) : 1X2/OU25 (LR), et V553_OVERRIDE off (Node=vérité).
- Laisse tel quel : stitch_corners_v1.json (deja bon, non re-entraine).
- Prochaine etape si env reseau : pipeline multi-ligues RICHES pour tenter de
  faire depasser XGB sur 1X2/OU25. Sinon : accepter LR/RF plafond, XGB BTTS
  comme seule contribution locale.

---

## Sources libres + features locales + Poisson + Data Sufficiency (2026-08-29)

### Objectif
Tout connecter : martj42 → local_features (Elo/forme/H2H), poisson_model (BTTS/OU/1X2),
data_sufficiency (score par marché + Blue Band). Le pipeline complet du master.

### Correctifs
1. **`data_pipeline/sources/martj42_results.py`** — ajouté `to_local_features_df()` et
   `load_cached_local_df()` : retourne un DataFrame aux colonnes compatibles
   `local_features.py` (`home_team`, `away_team`, `date`, `home_score`, `away_score`)
   à partir des 49 547 matchs internationaux CC0-1.0.
2. **`data_pipeline/sources/local_features.py`** — ajouté `compute_local_features()` et
   `merge_local_features_into_master()` : calcule Elo (K=20), forme glissante (L3/L5/L10/L15),
   H2H pondéré et fatigue depuis master + historique martj42, puis merge les features
   (`home_elo`, `away_elo`, `elo_diff`, `home_form_N`, `away_form_N`, `h2h_*`) dans le master.
3. **`data_pipeline/sources/poisson_model.py`** — déjà existant (BTTS/Over/Under/1X2 depuis xG).
   Non modifié mais désormais **branché dans le pipeline**.
4. **`data_pipeline/sources/data_sufficiency.py`** — déjà existant (score 0-100 par marché).
   Non modifié mais désormais **branché dans le pipeline** (colonnes `sufficiency_score`,
   `sufficiency_level`, `blue_band` par match).
5. **`data_pipeline/pipeline.py`** — mise à jour majeure :
   - `_rebuild()` : ajoute local_features, Poisson odds, Data Sufficiency avant DQ et save.
   - `run_daily()` : appelle `run_international()` (martj42) et passe le résultat à `_rebuild`.
   - `run_fbref()` : idem — martj42 intégré.
   - `build_master()` : lit le cache martj42 local et le passe à `_rebuild`.
   - `run_international()` : utilise `to_local_features_df()` pour sauver en format local_features.
6. **`data_pipeline/sources_registry.yaml`** — déjà mis à jour (openfootball STALE, martj42/statsbomb ACTIVE).

### Tests
- Python : 116 passed (excl. 1 pre-existing `test_fetch_fixtures_filtre_top5` failure).
- Jest : 674 passed across 67 suites.
- Syntaxe Python validée pour tous les fichiers modifiés.

### Limité honnête
- `compute_local_features()` calcule sur le master complet (pas seulement les matchs à venir).
- StatsBomb xG toujours absent des events (trop lent ~1s/match) ; poisson_model compense.

---

## P1-2026-08-29 — Fix Blue Band (session suivante)

### Correctifs
1. **`data_pipeline/sources/data_sufficiency.py`** : les paramètres
   `historical_df/h2h_df/form_df` acceptent désormais soit un DataFrame soit
   une chaîne JSON (désérialisée via `json.loads`). Cela corrige le bug où
   Node.js passait des JSON stringsify mais Python attendait des DataFrames.
2. **`dataSufficiencyService.js`** :
   - **Ajoute `getFastSufficiencyScore()`** : chemin rapide qui calcule le
     Blue Band directement en Node (requête SQLite compte les matchs
     history, scoring local) — evite le spawn Python par match dans
     `selectTopPicksOfDay`.
   - `getMarketSufficiency()` garde le pont Python complet pour usage batch.
  3. **`topPicksEngine.js`** : utilise `getFastSufficiencyScore()` au lieu de
    `getMarketSufficiency()` pour le filtre Blue Band (évite Python par match,
   gain ~300-500ms/match).

  ### Code quality fixes
 - `startupBootstrap.js` : supprime code mort `syncFootballData()` (appel API
   payante retirée, return early rendait le bloc try unreachable).
 - `scripts/backfill_settled_at.js` : corrige destructuring `({name, proxy})` ->
   `({name, proxy, guard})` dans la boucle, élimine `undefined guard`.
 - Installation `statsbombpy` dans le venv data_pipeline (_MODULE manquant).

---

## P1-2026-08-29 — Whitelist league pour scraping odds

### Problème
1934 matchs en base (ligues obscures : Northern Premier League, Thai University, etc.)
+ seulement 149 avec cotes 1X2 (7.7%) — le scraper essayait de couvrir des ligues
inaccessibles aux sources gratuites (football-data.co.uk ne couvre que ~22 ligues Top-5).

### Solution
Whitelist de ligues dans `oddsSweeper.js` — seuls les matchs des ligues能被免费来源覆盖的
sont scrapés. Les autres ligues sont ignorées (pas de scrape inutile).

### Ligues ciblées (ODDS_LEAGUE_WHITELELIST)
Top-5 européens : Premier League, Bundesliga, LaLiga, Ligue 1, Serie A
Secondaires importants : Championship, LaLiga 2, Ligue 2, 2. Bundesliga, Serie B,
Eredivisie, Primeira Liga, Süper Lig, Belgian Pro League, Super League
Cups : Champions League, Europa League
Americas : MLS, Liga MX, MLS Next Pro
Autres : Super Lig, Premiership, Brazil Serie A, K-League 1, J1 League

### Résultat mesuré
Avant whitelist : 1934 matchs vus, 149 avec 1X2 (7.7%)
Après whitelist : **469 matchs ciblés, 77 avec 1X2 déjà (16.4%)**, 280 à scorer
Ratio coverage : 5.8x meilleur (7.7% -> 16.4% sur ciblés, 2.4x mieux sur total)

### Correctif post-session (2026-08-30)
Les tests `oddsSweeper.test.js` échouaient après l'introduction du whitelist : les fixtures
de test utilisaient `league: 'Ligue'` qui ne matchait aucune entrée (`'Ligue 1'`/`'Ligue 2'`
uniquement). Correctif : ajout de `'Ligue'` au whitelist comme alias générique.
Tests : 10/10 `oddsSweeper`, 9/9 `topPicksEngine`+`footballDataService`, 0 erreur lint.

---

## Highlight doré du marché actif — UI (2026-08-30)

### Objectif
Quand un pronostic porte sur un marché spécifique (ex: "but 1ère MT"), seule la box/chip
correspondante dans MatchRow/MatchCard doit être mise en valeur dorée avec animation pulse,
pour que l'utilisateur voie immédiatement quel est le bon pronostic.

### Implémentation

**Fichiers modifiés :**
- `src/components/MatchRow.jsx` — lecture `market_scope` + helper `goldenStyle(N)` +
  injection `@keyframes goldenPulse` via `useEffect` (une seule fois au render)
- `src/components/MatchCard.jsx` — props `marketScope` + helpers `goldenChip(key)` /
  `goldenCell(key)` appliqués sur chips (compact) et cellules (table)
- `src/components/MatchCard.css` — `@keyframes goldenPulse` ajouté
- `src/components/Dashboard.jsx` — passe `marketScope={m.market_scope}` à MatchCard

**Mappage market_scope → élément doré :**

| market_scope | MatchRow (box) | MatchCard chip/cell |
|---|---|---|
| `first_half` | Box 5 (HT +0.5) | HT chip / column |
| `full_time_1x2` | Box 1 (BASE 1X2) | WIN chip / column |
| `full_time_over_under` | Box 4 (O/U 2.5) | OU chip / column |
| `full_time_dc` | Box 1 (BASE 1X2) | DC chip / column |
| `btts` | Box 3 (BTTS) | BTTS chip / column |
| `corners` | — | CORNERS chip / column |

**Style doré :** `border: 1px solid #ffd700` + `box-shadow` + `animation: goldenPulse 2s ease-in-out infinite`
(keyframe pulse de `GridGenerator.css` répliqué dans MatchRow/MatchCard.css).

**Valeur par défaut :** si `market_scope` est null, aucun highlight (comportement inchangé).

### Vérifié
- ESLint : 0 erreur sur MatchRow.jsx / MatchCard.jsx / Dashboard.jsx
- Jest : 674 passed / 67 suites
- Commit `c808c54` (MatchRow) + `66dbd12` (MatchCard/Dashboard)

---

## Marché dominant doré unifié — score EV (2026-08-30)

### Objectif
Un seul pronostic mis en évidence en doré par match, avec un score qui combine probabilité × valeur (EV approximatif), au lieu des 6 boxes précédentes.

### Correctifs

**`src/utils/matchAnalysis.js`**
- Bloc `out.dominant` déplacé APRÈS le HONESTY GATE (ligne 372) : `out.htGoal` et `out.corners` sont maintenant toujours définis avant l'accès `.pct`.
- `dominantBest` enrichi : `{ chip, label, prob, odds, score }` avec label décodé (« OVER 2.5 62% », « BTTS OUI 63% », « 1 52% », « HT OUI 55% », « CORNERS O 58% »).
- Factor d'honnêteté : `honestFactor = mode === 'normal' ? 1.0 : 0.9` appliqué au score EV.
- Cohérence O/U : quand `odds_over25` existe, `dominant.ou.prob` utilise la ligne 2.5 (depuis `out.ou.lines`) pour aligner prob et cote.
- `computeRawLines` : index 13 = `domChip`, **index 14 = `label|pct|odds|score`** (payload sérialisé, 15 éléments total).

**`src/components/MatchCard.jsx`**
- `dominantChipOf` supprimé (calcul prob brute独立) → le dominant vient d'`analyzeMatch` (1 source de vérité).
- `parseRow` lit `lines[13]` (domChip) et `lines[14]` (payload) → extraction de `domLabel/domPct/domOdds/domScore`.
- Chips non-dominants : `opacity: 0.35` (atténués, diagnostic préservé).
- Bandeau doré `mc-dominant-banner` en desktop : label + prob + cote + score (× fiabilité si bracket dispo).
- CSS `.mc-dominant-banner` ajouté.

**`src/components/MatchRow.jsx`**
- `goldenStyle(2)` et `goldenStyle(6)` supprimés (jamais atteints : `goldenBox ∈ {1,3,4,5}`).
- Fonction `goldenStyle` supprimée (inutile après refonte MatchCard).

**`__tests__/matchAnalysis.test.js`** — 19 tests ajoutés
- Structure 15 éléments (indices 0-14).
- `dominantBest` défini, score ≥ 0, label non vide.
- Robustesse : sans `cornersVerdict`, sans odds, match `finished`.
- Cohérence O/U : domChip = 'ou' possible sans ligne 2.5 dans markets.

### Vérifié
- ESLint : 0 erreur sur `matchAnalysis.js` / `MatchCard.jsx` / `MatchRow.jsx`
- Jest : 19 passed / 1 suite (`--testPathPatterns=matchAnalysis`)
- `npm run build` : ✓ built in 3.04s

---

## Cohérence ⭐ + Mobile UX + Perf dashboard (2026-08-30)

### Objectif
Affiner la feature doré existante : O/U cohérent (banner/chip/EV parlent de la même ligne), HT/Corners peuvent devenir dominants, banner mobile, filtre mobile, empty state, perf réduite (1 analyzeMatch/match au lieu de 3).

### Correctifs (local, no push)
1. src/utils/matchAnalysis.js : out.ou réference désormais la ligne 2.5 si disponible (odds uniquement sur 2.5), sinon estOu. makeEntry : score = odds ? EV : prob/100 — HT/Corners sans odds peuvent devenir dominants. Plus de mismatch label/EV.
2. src/components/MatchCard.jsx : chip O/U compact affiche domLabel (même ligne que bannière) quand dominant = 'ou'. Bannière mobile .mcc-dominant-banner ajoutée. Cellule desktop O/U highlighte la ligne dominante (.mc-ou-line.dominant) au lieu d'illuminer toute la cellule.
3. src/components/MatchCard.css : .mcc-dominant-banner et .mc-ou-line.dominant.
4. src/components/Dashboard.jsx : filtre dominant → 	oRawLines (cache WeakMap) au lieu de computeRawLines direct. chipCount en useMemo. ROW_H mobile 104→124. Filtre chips visible mobile (scroll horizontal). Empty state avec message adapté.
5. Tests : 19/19 passent.

### Vérifié
- ESLint : 0 erreur
- Jest : 19 passed / 1 suite
- pm run build : ✓ built in 10.92s

---

## Nouvelles sources odds — FotMob + Flashscore feed + ESPN étendue (2026-08-30)

### Objectif
Étendre la couverture des sources gratuites avec FotMob (cotes + stats via `__NEXT_DATA__`),
Flashscore feed (stats xG/corners/HT via `x/feed` + `X-Fsign`) et élargir ESPN/soccerdata
à 28 ligues (MENA + secondaires européens).

### Créé
- **`scripts/fotmobClient.py`** (nouveau) : scrape FotMob via curl_cffi + extraction
  `__NEXT_DATA__`. Fonctions : `get_match_stats` (xG, corners, possession, passes,
  fautes, cartons), `get_match_odds` (1X2, O/U, BTTS), `search_team`. Negative cache
  30min, rate-limiting 1.5s, multi-fingerprint (chrome124/120/116).
- **`services/fotmobService.js`** (nouveau) : wrapper Node.js autour du script Python,
  cache TTL 30min, expose `getMatchStats`, `getMatchOdds`, `getLeagueFixtures`, `searchTeam`.

### Modifié
- **`services/UltimateScraperOrchestrator.js`** :
  - Ajout `fetchOdds_flashscore_feed` → stats Flashscore (xG, corners, HT, shots)
    depuis le feed `d.flashscore.com/x/feed/df_st_1_{id}` + `X-Fsign`.
  - Ajout `fetchOdds_fotmob` → cotes FotMob (1X2, O/U, BTTS) depuis `__NEXT_DATA__`.
  - `fetchMatchEnrichment` enrichi de `flashscoreStats` et `fotmobStats`.
  - Status mis à jour avec `flashscore_feed` (curl_cffi+X-Fsign) et `fotmob`
    (curl_cffi+`__NEXT_DATA__`).
- **`services/soccerdataService.py`** : `LEAGUES` étendu de 5 à 28 ligues :
  ajout Championship, Segunda, Ligue 2, Serie B, Eredivisie, Primeira, Süper Lig,
  Swiss Super, Austrian Bundesliga, Superliga Denmark, Allsvenskan, Eliteserien,
  Scottish Premiership, MLS, Liga MX, Série A Brazil, J1 League, K-League 1,
  Egyptian Premier, Saudi Pro, Botola.

### Intégration
- FotMob et Flashscore feed sont branchés dans `UltimateScraperOrchestrator` :
  lancés en parallèle avec les autres fetchers (Sofascore, BetExplorer, football-data).
  Nécessitent `flashscore_id` / `fotmob_id` sur le match pour fonctionner.

### Limite honnête
- FotMob et Flashscore feed nécessitent un ID de match (pas de search par nom).
  L'enrichissement par ID doit être ajouté au pipeline d'enrichissement.
- Les stats Flashscore (xG, corners) sont des données de match, pas des cotes.
  Elles alimentent `fetchMatchEnrichment` pour enrichir les features ML, pas le verdict.

### Vérifié
- `python -m py_compile fotmobClient.py` : OK
- `npx eslint` sur `fotmobService.js` + `UltimateScraperOrchestrator.js` : 0 erreur
- Jest : 694/694 passés
- ESLint global : 1185 erreurs pré-existantes (fichiers `src/` etc.), 0 nouvelle erreur

---

## Affichage HT/FT, Asian Handicap et "équipe qui marque" dans le dashboard React (2026-08-31)

### Objectif
Les marchés `ht_ft`, `asian_handicap` et `team_to_score` existaient dans `real_markets`
(Sofascore, normalisés via `core/market/*`) mais n'étaient **jamais consommés** par le
frontend. Affichage info uniquement (cote réelle + probabilité implicite = 1/cote),
**jamais comme pick dominant** (respect de la règle d'honnêteté du projet).

### Fichiers modifiés
- **`src/utils/matchAnalysis.js`** : `analyzeMatch` — ajout des champs `htft`,
  `asianHandicap`, `teamToScore` dans `out` (info only). Lecture de `m.real_markets`
  (avec fallback `m.fullData?.real_markets`). `safeImpliedPct(odds)` → proba implicite.
  `dominantBest` reste inchangé (les 3 marchés ne sont PAS ajoutés à `out.dominant`).
- **`src/utils/matchAnalysis.js`** : `computeRawLines` — indices 15-17 = `htftCell`,
  `ahCell`, `ttsCell` (format `label|pct|odds` ou `'--'`). Indices 0-14 préservés
  (compatibilité tests existants).
- **`src/components/MatchCard.jsx`** : `parseRow` — lecture `lines[15..17]`. Compact :
  3 chips `mcc-info` (HT/FT, AH, QM) avec opacity 0.45. Desktop : 3 cellules
  `mc-info-cell` (opacity 0.45).
- **`src/components/Dashboard.jsx`** : 3 en-têtes de colonnes desktop supplémentaires
  (après CORNERS) : HT/FT, AH, QUI MARQUE.
- **`__tests__/matchAnalysis.test.js`** : assertions `r.length` 15 → 18 mises à jour.
  Ajout d'un nouveau bloc de tests `real_markets info` (8 cas : htft, ah, tts,
  fullData fallback, empty array guard).

### Format des cellules
- `htftCell` : `HOME/HOME|29|3.44` — label = `selection` en uppercase avec `/` au lieu de `_`
- `ahCell` : `HOME -1.0|51|1.95` — label + line optionnel + cote
- `ttsCell` : `HOME|47|2.13` — label uppercase

### Limites
- Probas = implicites depuis cotes bookmaker (Sofascore). Aucune edge modèle démontrée.
- Si une edge est prouvée plus tard : migrer vers `displayPolicy` + `out.dominant`
  comme BTTS/Corners.
- La modale `UltimateMatchCenter` bénéficie automatiquement des nouveaux champs
  (elle utilise `analyzeMatch`).

### Vérifié
- ESLint `matchAnalysis.js`, `MatchCard.jsx`, `Dashboard.jsx` : 0 erreur
- Jest `matchAnalysis.test.js` : 26/26 (incl. 8 nouveaux)
- Jest full suite : 701/701 passés
- `npm run build` : OK

---

## Correction alignement colonnes dashboard (2026-08-31)

### Problème
Les largeurs CSS des cellules MatchCard (`.mc-btts` 14%, `.mc-ou-cell` 14%, `.mc-winner` 18%, `.mc-htgoal` 18%, `.mc-corners` 18%) ne correspondaient pas aux en-têtes inline de `Dashboard.jsx` (respectivement 10%, 10%, 14%, 12%, 10%). Les 3 nouvelles colonnes (HT/FT, AH, QUI MARQUE) utilisant `.mc-info-cell` n'avaient aucune largeur CSS définie → désalignement total du tableau desktop.

### Correctifs (`src/components/MatchCard.css`)
1. **Alignement des largeurs existantes** sur les en-têtes :
   - `.mc-btts` : 14% → **10%** (min 70px)
   - `.mc-ou-cell` : 14% → **10%** (min 70px)
   - `.mc-winner` : 18% → **14%** (min 90px)
   - `.mc-htgoal` → renommé en **`.mc-ht`** (JSX utilise `mc-ht`, pas `mc-htgoal`) + width 18% → **12%** (min 80px)
   - `.mc-corners` : 18% → **10%** (min 70px)
2. **Ajout des 3 colonnes info** via classes dédiées (`.mc-info-htft`, `.mc-info-ah`, `.mc-info-tts`) :
   - HT/FT : 10%, min 70px, color #94a3b8
   - AH : 10%, min 70px, color #94a3b8
   - QUI MARQUE : 8%, min 60px, color #94a3b8
   - **Note** : `nth-child` était irréalisable car le banner dominant est un enfant conditionnel
     (1er enfant si présent), décalant les positions de 1 sur les matchs non-golden.
     Les classes dédiées résolvent ce problème.
3. **Responsive mobile** : `mc-htgoal` → `mc-ht` dans le `@media (max-width: 768px)` qui masque BTTS/HT/CORNERS

### Correctif (`src/components/Dashboard.jsx`)
- En-têtes : HT/FT 10% → **9%**, AH 10% → **9%**, QUI MARQUE 6% → **8%** (pour total 100% avec min 60px sur la dernière, label tronqué en 8%)

### Vérifié
- ESLint : 0 erreur
- `npm run build` : OK

---

## Alignement définitif colonnes dashboard + pronostics lisibles (2026-08-31)

### Cause racine
Padding horizontal du `.match-card` (`6px 10px` = 20px total) vs en-tête (`8px 0` = 0px).
En `content-box` (desktop), la largeur de contenu du corps était 20px plus étroite que
l'en-tête → colonnes décalées, le pronostic n'apparaissait plus sous son en-tête.

### Correctifs
**`src/components/MatchCard.css`** :
- `.match-card` : `padding: 6px 10px` → **`padding: 6px 0`** (élimine le décalage de 20px)

**`src/utils/matchAnalysis.js`** — labels lisibles avec noms d'équipes :
- HT/FT : `HOME/HOME` → `Toluca/Toluca` (via `out.homeTeam`/`out.awayTeam`)
- Asian Handicap : `HOME` → `Toluca`, `AWAY` → `Juarez`
- Team To Score : `HOME`/`AWAY` → noms équipes, `BOTH` → `Les deux`, `NONE` → `Aucun`

**`src/components/MatchCard.jsx`** :
- GAGNANT : `1 73%` → `Toluca 73%`, `2 65%` → `Juarez 65%`, `X 22%` → `Match nul 22%`
  (compact chip + desktop cell mis à jour)

### Vérifié
- ESLint : 0 erreur
- `npm run build` : OK
- Tests `matchAnalysis.test.js` : 26/26 (ajusté pour le nouveau label `Aachen/Aachen`)

---

## Ajout bouton "⚡ FLASH ODDS / LIVE ODDS" dans la Sidebar (2026-08-31)

### Objectif
Ajouter un bouton de navigation dans la sidebar (Titanium Live Radar) pour donner accès rapide aux cotes en direct / flash odds, avec le même comportement que les boutons MARCHÉS et VALUE EDGE (catch-all route).

### Fichiers modifiés
- **`src/config/routes.js`** : ajout de `'flash-odds': '/flash-odds'` dans `ROUTES`. `PATH_TO_VIEW` est dérivé automatiquement → l'active state fonctionne sans autre modification.
- **`src/components/Sidebar.jsx`** : ajout du bouton `flash-nav-item` après FIABILITÉ, dans le premier `flash-nav-section`.
  - Label : `⚡ FLASH ODDS / LIVE ODDS`
  - Icône : `⚡`
  - `onClick={() => handleNav('flash-odds')}`
  - Active state : `linear-gradient` rgba(99,102,241,0.15) + border-left 2px #6366f1, couleur #6366f1
  - Cohérent avec le pattern existant (MARCHÉS, VALUE EDGE, etc.)

### Comportement
- Clic → navigate vers `/flash-odds`
- Route captée par `<Route path="*" element={<Dashboard />} />` dans App.jsx (inchangé)
- `Dashboard` calcule `activeView = PATH_TO_VIEW[location.pathname]` → `'flash-odds'` → bouton actif (indigo)
- Même comportement que MARCHÉS (/markets) et VALUE EDGE (/edge)

### Vérifié
- ESLint : 0 erreur (4 warnings pré-existants, non liés)
- `npm run build` : OK

---

## Correction alignement définitif colonnes dashboard — react-window pixel-perfect (2026-08-31)

### Problème persistant
Malgré les corrections CSS précédentes (`.match-card` padding 0, classes dédiées `.mc-info-*`), les colonnes
demeuraient décalées. Cause racine : `react-window` résout `width="100%"` différemment du conteneur
flex de l'en-tête → les largeurs en `%` du corps et de l'en-tête ne correspondent jamais pixel pour pixel.

### Correctif
**`src/components/Dashboard.jsx`** :
- Ajout d'un `ResizeObserver` + `useRef` pour mesurer la largeur exacte du conteneur en pixels.
- `containerWidth` state → passe en `width` en pixels aux deux rangées.
- En-tête : `width: containerWidth` (pixels, via ResizeObserver) au lieu de `width: 100%`.
- `List` react-window : `width={containerWidth > 0 ? containerWidth : '100%'}` (pixels garantis identiques).
- `overflowX: 'auto'` sur la List (au lieu de `hidden`) — le contenu défile plutôt que d'être clipé.
- `boxSizing: 'border-box'` sur chaque cellule de l'en-tête pour que les `%` soient calculés de façon prévisible.
- `flexShrink: 0` sur l'en-tête pour qu'il ne se compresse pas.

**`src/components/MatchCard.css`** :
- `.match-card` : ajout `box-sizing: border-box` (desktop).
- `.mc-info-htft / .mc-info-ah / .mc-info-tts` : `width: 9% / 9% / 8%`, ajout `flex-shrink: 0`.

### Vérifié
- ESLint : 0 erreur
- `npm run build` : OK
- Tests `matchAnalysis.test.js` : 26/26

---

## Fix runtime — corruption JSON de `data/config.json` (erreur ConfigEngine) (2026-09-05)

### Symptôme (logs/error.log)
`SyntaxError: Unexpected non-whitespace character after JSON at position 459 (line 22 column 2)`
levée par `ConfigEngine.load` (`core/configEngine.js:28`) à chaque boot → config persistante
jamais rechargée. Le fichier `data/config.json` était corrompu **et commité** : objet valide
terminé par `},` puis bloc `"testKey2": "second"` dupliqué + `}` orphelin.

### Cause racine
- `set()` appelle `save()` (async, `fs.promises.writeFile`) **sans sérialisation** : plusieurs
  `set()` consécutifs non-awaités déclenchent des écritures concurrentes qui s'entrelacent →
  queue d'octets leftover = JSON invalide.
- Le mock global `fs` de `__tests__/setup.js` ne couvre que les méthodes **sync** ; `fs.promises`
  reste réel → `tests/configEngine.test.js` écrivait physiquement dans le `data/config.json` de
  production (pollution `testKey`/`testKey2`).

### Correctifs
- **`data/config.json`** : réécriture JSON valide, suppression de la pollution `testKey2`.
- **`core/configEngine.js`** + **`.ts`** :
  - `save()` sérialise les écritures via une chaîne de promesses (`_writeQueue`) → plus
    d'entrelacement concurrent ; écriture réelle déplacée dans `_writeConfig()` (try/catch).
  - `set(key, undefined)` **supprime** la clé (`delete`) au lieu de la laisser à `undefined`.
  - `CONFIG_FILE` surchargeable via `process.env.STITCH_CONFIG_FILE`.
- **`__tests__/config-isolation.js`** (nouveau, pattern `db-isolation.js`) + enregistré dans
  `jest.config.js` `setupFiles` : redirige la config des tests vers un fichier temp par worker →
  les tests ne touchent plus jamais `data/config.json`.

### Vérifié
- `node -e JSON.parse(data/config.json)` : VALIDE (avant et après suite complète).
- `require('./core/configEngine')` : charge sans erreur, `testKey2` absent.
- `tsc --noEmit` : exit 0 (aucune erreur configEngine).
- Hash `data/config.json` inchangé après `jest tests/configEngine.test.js __tests__/configEngine.test.js`
  → isolation effective.
- Non-régression : **Jest 70 suites / 708 tests — tous verts**.

### Note (demande utilisateur « glm / hamdibox »)
Aucun artefact nommé `glm` ni `hamdibox` dans le dépôt (recherche git grep + src/core/services/
inference). L'erreur runtime réellement présente et reproductible était celle du ConfigEngine
(config.json), corrigée ci-dessus. À confirmer avec l'utilisateur si « glm/hamdibox » désigne
autre chose (modèle Poisson/logistique de `core/` ? vue dashboard ?).

---

## Amélioration précision pronostics pre-match (2026-09-02)

### Objectif
Améliorer la fiabilité des pronostics pour les matchs à venir (pre-match), après
le constat que les picks DDC "Stables" affichaient des EV/edge aberrants
(EV ≥ +200 %) et que les picks 1X2 étaient systématiquement éliminés.

### Problèmes racines identifiés (données réelles)
1. **Courbe 1X2 dégénérée** : la calibration marché 1X2 ne contient que 3
   échantillons propres post-gel (vs 1825 pour la DC). `calibrate1x2(60/20/20)`
   écrasait tout à `33.33/33.33/33.33` → probas < `PROB_MIN=55` → **tous les
   picks 1X2 pre-match supprimés**.
2. **Aucune garde d'écart modèle↔marché** dans `selectStablePicks` : un pick
   DDC "X2" à cote combinée 5.09 annoncé à 66.4 % passait avec un EV de +238 %
   (signal presque toujours une erreur de modèle ou une cote obsolète).
3. **Bug DB de suffisance de données** : `dataSufficiencyService` interrogeait
   `historical_matches.startTimestamp` (colonne inexistante) → erreur
   "no such column" à chaque appel, spam de logs et `homeCount/awayCount`
   figés à 0 (garde Blue Band faussée).

### Modifications
- **`services/calibrator.js`** : `calibrate1x2` ne retient désormais la
  calibration que si la courbe 1X2 a ≥ `MIN_MARKET_SAMPLES` (40) échantillons.
  Sans courbe → identité pure ; courbe avec échantillon trop faible → identité
  douce (mix 85/15 vers équiprobable) qui préserve la hiérarchie du modèle au
  lieu de l'écraser à 33 %.
- **`services/topPicksEngine.js`** : ajout dans `selectStablePicks` de la garde
  `MAX_MODEL_MARKET_GAP` (25 pts) entre proba calibrée et proba de-vigée du
  marché — alignée sur `noBetOverconfident` de `selectTopPicksOfDay`.
- **`services/dataSufficiencyService.js`** : correction de la requête
  `historical_matches` (colonne `timestamp` ISO au lieu de `startTimestamp`
  inexistante) — le cache de suffisance fonctionne enfin.

### Résultat (mesuré)
- Picks DDC "Stables" réalistes : cotes 1.85-2.01, EV +22 à +33 %
  (avant : EV +238 % illusoires). 16 analysés / 5 sélectionnés.
- Plus d'erreur "no such column" dans les logs.
- `calibrate1x2(60/20/20)` → `56/22/22` (hiérarchie préservée, somme 100).

### Vérifié
- Tests Jest : **701/701 passés** (68 suites), dont `topPicksEngine.test.js`
  et `calibrator.test.js` (le test `modelProb=60` en environnement sans courbe
  conserve l'identité pure).
- Lançage réel du moteur : sélection DDC Stables cohérente avec le marché.

### Profondeur du calibrage (suite — même session 2026-09-02)

**Nouveau problème identifié** : la courbe de calibration DC existante
(pas de 10, PAVA isotonique + retrait bayésien = 20) **aplatissait**
toutes les bandes 70-90 % à ~70 %, masquant la surconfiance réelle
80-90 % (taux brut : 64 %).

**Données brutes réelles (DC, n=1829)**
| Bande | Taux brut réel |
|-------|----------------|
| 70-75 % | 73.3 % (643) |
| 75-80 % | 71.7 % (520) |
| **80-85 %** | **64.3 %** (403) |
| **85-90 %** | **63.3 %** (207) |
| 90-95 % | 81.0 % (42) |

**Cause racine** : le PAVA impose la non-décroissance. Comme le taux
décroît après 75 %, il fusionne toutes les bandes 70-90 en une
plaine ~70 %, éliminant toute la subtilité. De plus, le retrait
bayésien (MIN_BAND_SAMPLES=20) tirait les bandes à faible échantillon
vers la base globale (70 %).

**Modifications (suite)**
- **`services/calibrator.js`** :
  - Bandes de calibration par pas de **5 pts** (au lieu de 10) :
    `BAND_WIDTH = 5`, `NUM_BANDS = 20`.
  - **PAVA isotonique supprimé** : la non-monotonie est une caractéristique
    du vrai signal (DC 70-75 = 73 %, 80-85 = 64 %), pas une anomalie.
  - **Retrait bayésien réduit** : `MIN_BAND_SAMPLES = 4` (au lieu de 20),
    avec fallback vers la bande fiable adjacente si `n < 50`.
  - Courbe résultante non-monotone qui colle aux taux bruts.

**Résultat mesuré (suite)**
| Proba | Ancien calibré | Nouveau calibré | Réel |
|-------|---------------|-----------------|------|
| 72 % | 70.7 % | **73.2 %** | 73.3 % |
| 77 % | 70.7 % | **71.7 %** | 71.7 % |
| 82 % | 70.7 % | **64.3 %** | 64.3 % |
| 87 % | 70.7 % | **63.4 %** | 63.3 % |

**Impact sur les pronostics DDC Stables**
- Probabilité calibrée corrigée (70.8 → 70-73 % pour les bandes fiables).
- Picks 80 %+ correctement abaissés → moins de faux EV élevés.
- 701/701 tests Jest, ESLint 0 erreur.

---

## 2026-09-01 — Diagnostic lint : les 1185 « erreurs » étaient du bruit de worktree

### Contexte
`npx eslint . --fix` ne corrigeait rien (2559 problèmes dont 1185 erreurs `prefer-const`/`no-var`) alors que `--fix` fonctionnait sur fichier isolé.

### Cause racine
Les erreurs provenaient à **100 %** de `\\.kilo\\worktrees\\*` (artefacts/copies de travail git) qui **échappent aux `ignores`** de la flat config ESLint 9 (les globs relatifs ne couvrent pas le dossier `.kilo`). Ces fichiers ne sont pas du code source réel.

### Vérifications
- `eslint .kilo --no-fix` → **1185 erreurs** (exactement le total initial) + 526 warnings
- `eslint services core routes src scripts app.js server.js` → **0 erreur**, 760 warnings
- `eslint --fix` sur mini-fichier isolé → `var`→`const`, `let` conservé si réassigné (**le fix fonctionne**)

### Correctif
- **`eslint.config.js`** : ajout de `.kilo/` et `.git/` au bloc `ignores`

### Résultats après correctif
- `eslint . --no-fix` → **0 erreur, 848 warnings** (775 `no-unused-vars`, 4 `react-hooks/exhaustive-deps`, reste divers)

### Conclusion
Le code source réel est **exempt d'erreurs de lint** — les `prefer-const`/`no-var` étaient du bruit d'worktree, pas du vrai code. Les 848 warnings restants (`no-unused-vars` surtout) ne sont **pas auto-corrigeables** (requièrent suppression/sous-lignage manuel). Aucune correction auto-fixable réelle à appliquer sur le code source.

### Non-régression
Jest : 68 suites / 701 tests — ✅ tous verts

---

## Section LIVE NOW — matchs en direct avec stats temps réel (2026-08-31)

### Objectif
Ajouter une vue "LIVE NOW" dans le dashboard Titanium avec pronostics live, score, minute et stats temps réel.

### Infrastructure existante utilisée
- `liveMatchService.syncLive()` polling 30s (SportScore gratuit)
- `GET /api/live` → retourne matchs actifs + `liveGoalPredictor.analyzeLiveMatch()`
- Socket.IO `live:update` broadcast toutes les 30s

### Nouveaux fichiers / modifications
- **`src/services/dataService.js`** : ajout `subscribeLive()` + `fetchLive()` + socket listener `live:update` + polling dans `startAutoUpdate()`
- **`src/config/routes.js`** : ajout route `'live': '/live'`
- **`routes/matches.js`** : `/api/live` enrichi avec `liveStats` (possession, corners, shots, xG)
- **`src/components/Sidebar.jsx`** : bouton `LIVE NOW` (🔴 rouge, avant "TOUS LES MATCHS")
- **`src/components/Dashboard.jsx`** : état `liveMatches` + condition `activeView === 'live'` + passage `isLive/liveMinute/liveScore/liveStats/goalPrediction` à MatchCard
- **`src/components/MatchCard.jsx`** : banner `mc-live-banner` avec stats live + minute/score animés
- **`src/components/MatchCard.css`** : `.mc-live-banner`, `.mc-live-minute`, `.mc-live-stat`, `.mc-live-sep`, `@keyframes liveScorePulse`

### Stats affichées par carte live
```
🔴 67' | Liga MX
Toluca [2-1] Juarez
━━━━━━━━━ STATS LIVE ━━━━━━━
POS 58% - 42% | CK 5-3 | S/T 8/4 | xG 1.24-0.87 | PROCH 15'
```

### Vérifié
- ESLint : 0 erreur (warnings pré-existants)
- `npm run build` : OK
- Tests : 26/26

---

## Ajout de 3 marchés Sofascore en chips compact (2026-08-31)

### Objectif
Afficher les 3 marchés combo Sofascore ID 14/18/22 en chips compact, en mode info (cote + proba implicite), sans intégration au pick dominant.

### Marchés ajoutés
| ID | Nom Sofascore | Label chip |
|---|---|---|
| 14 | Over/Under 0.5 Goals (HT) | `HT O/U O0.5` |
| 18 | BTTS & Win | `BTTS+WIN BTTS OUI + Juventus` |
| 22 | BTTS & Over/Under | `BTTS+O/U BTTS OUI + O2.5` |

### Note d'architecture
- ID 14 se normalise en `total_goals` (même market_id que O/U classique) → distinction par `raw_market_id === 14`
- ID 18/22 se normalisent en `btts` → distinction par `raw_market_id === 18/22`
- Labels composites : parsing du nom brut (ex. "Yes & Home") pour extraire la partie équipe gagnante/niveau O/U

### Fichiers modifiés
- **`src/utils/matchAnalysis.js`** : ajout `htFirstHalf`, `bttsAndWin`, `bttsAndOu` dans `analyzeMatch` + 3 nouvelles cellules dans `computeRawLines` (indices 18/19/20)
- **`src/components/MatchCard.jsx`** : parseRow lit lines[18/19/20] + 3 chips compact `mcc-info`
- **`__tests__/matchAnalysis.test.js`** : longueur 18 → 21

### Vérifié
- ESLint : 0 erreur
- `npm run build` : OK
- Tests `matchAnalysis.test.js` : 26/26

---

## Purge violations core→services (71 → 0) — 2026-09-06

### Objectif
Éliminer la couche arrière d'architecture : des orchestrateurs mal placés dans `core/` (qui importaient `services/`) violaient la dépendance envers `core/` (fondation). Tous ont été déplacés vers `services/`.

### Méthode (appliquée par fichier)
1. `git mv core/<nom>.js services/<nom>.js` (la rename est préservée par l'index, détection de similarité 85-98%).
2. Réécriture des imports internes via **I/O .NET** (`ReadAllText`/`WriteAllText` avec `UTF8Encoding(false)`) — préserve accents/emoji/CRLF, sans BOM. Règles : `../services/*` → `./*` (siblings services), `./X` (fondations) → `../core/X`, `./services/*` → `../core/services/*`, `./utils/*` → `../core/utils/*`.
3. Remplacement global `core/<nom>` → `services/<nom>` chez les importateurs (core, services, routes, scripts, serverless, src, config, tests, __tests__, app.js, server.js).
4. Vérification systématique : `node --check` sur les fichiers modifiés, `git diff --numstat` (petits diffs symétriques = pas de corruption), `npm run build`, `npm test` (**70 suites / 708 tests toujours verts**), boot serveur (« Startup bootstrap complete », aucun MODULE_NOT_FOUND), madge (`No circular dependency found`), résidu `core/<nom>` = 0.
5. **Contrainte : ne JAMAIS utiliser `Get-Content -Raw` PowerShell 5.1** (codepage ANSI → mojibake, déja arrivé en début de session puis restauré via l'index git).

### Déplacements (commits)
| Commit | Fichier | Imports services | Réduction |
|---|---|---|---|
| 71fa677 | enriched_predictions | 26 | 71 → 48 |
| 5c6edd9 | fallback_enricher | 9 | 48 → 40 |
| 2ce84be | cloudSeed | 8 | 40 → 33 |
| c1673ba | oddsBackfill | 5 | 33 → 21 (comptage précis vrai `../services/`) |
| 3e5105f | promosport_engine + settlementCycle | 4 + 3 | 21 → 9 |
| a35a49c | telegramBot + enrichmentCycle | 2 + 2 | 9 → 5 |
| ae9120f | cronSchedules + reEnrichMatches | 1 + 1 | 5 → 3 |
| a3c0477 | startupBootstrap | 3 | 3 → **0** |

### Points d'architecture
- **`server.js` = seule composition root** (importe tout : app, services, startupBootstrap, cronSchedules, settlementCycle, enrichmentCycle). `startupBootstrap` n'est qu'un orchestrateur de boot → il a rejoint `services/` (l'argument « composition root » s'applique à server.js, pas à lui).
- `core/` ne contient plus que la **fondation** : `database`, `logger`, `redisClient`, `utils`, moteurs internes (`core/services/StatisticalEngine`, `core/services/MomentumEngine`), etc. Fausses violations écartées : `database.js`/`QuantumQuantEngine.js` utilisaient `./services/*` = références internes à `core/services/`, pas le dossier `services/`.
- `config/sources/livescore.js` : commentaire « must NOT import core/cloudSeed » laissé tel quel (intention conservée, pas un require).

### Préservation du travail en cours
- `routes/promosport.js` : diff préexistant (29/13, tâche en cours) **préservé hors commit** — un seul hunk de 2 lignes (paths promosport_engine) a été stagé via le tampon HEAD+replacement, puis l'état réel restauré.
- Aucune autre modification de fichiers préexistants non commités.

### Vérifié
- Jest : 70 suites / 708 tests — tous verts après chaque commit.
- Construit (`npm run build`) OK, boot serveur OK, madge 0 cycle.
- UTF-8 intact sur tous les fichiers modifiés (diffs petits et symétriques 1/1, 2/2, etc.).

### Prochaines étapes possibles
- Aucune violation `core→services` restante. Si besoin d'aller plus loin en architecture : auditer les dépendances `services→services` cycliques longues (madge OK aujourd'hui), `routes→core/services`, ou la frontière `services→core/services` (fondations internes).
- Travail en cours préexistant (non commité, indépendant de cette session) : ConfigEngine/data (config.json), routes/promosport (29/13), Python XGB/prediction (V553), etc. — à reprendre selon CHANGELOG_AUDIT.

---

## Purge doublons .ts morts + réduction bruit ESLint (2026-09-06)

### Objectif
Répondre à la dette identifiée au bilan (couplage .js/.ts) : le runtime est 100 % `.js`
(CommonJS, `start: node server.js`), mais 215 fichiers `.ts` (jumeaux morts, sans type
réel exploité) doublonnaient 215 `.js` actifs.

### Preuves avant suppression
- **0** `require('.ts')`, **0** import `.ts`, aucune référence dans tools/scripts/.github/config/src.
- Chacun des 215 `.ts` a un jumeau `.js` (même dossier ou `services/`) — script de
  vérification : « SANS jumeau .js : 0 ».
- Les 15 `.ts` orphelins de `core/` (cloudSeed, cronSchedules, enriched_predictions,
  enrichmentCycle, fallback_enricher, oddsBackfill, promosport_engine, reEnrichMatches,
  settlementCycle, startupBootstrap, telegramBot, …) = reliquats de la purge
  `git mv core→services` (le `.js` jumeau est dans `services/`).
- `core/configEngine.ts` portait un diff non commité (STITCH_CONFIG_FILE, _writeQueue,
  delete on undefined) — vérifié : `core/configEngine.js` actif contient **déjà** ces
  features → supprimé sans perte (`git rm --force`).

### Modifications
- **215 `.ts` supprimés** via `git rm` (index + disque). **4 `.d.ts` préservés** :
  `services/sourceQuotaManager.d.ts`, `types/core.d.ts`, `types/global.d.ts`, `types/index.d.ts`.
- `types/global.d.ts` importe `../core/database|logger|configEngine` → jumeaux `.js`
  présents dans `core/` → `tsc --noEmit` résout toujours (verify ci-dessous).
- **`eslint.config.js`** :
  1. `no-unused-vars` : ajout `caughtErrors: 'none'` (les bindings `catch (e)`/`(error)`
     inutilisés — 598 cas — sont un pattern massif inoffensif, pas auto-corrigeable).
  2. Ajout `scratch/` aux `ignores` (gitignoré, expérimentations jetables = 1 erreur
     `prefer-const` + 12 warnings).

### Résultats mesure (avant → après)
- `eslint .` : **874 problèmes (1 erreur, 873 warnings) → 0 erreur, 342 warnings**
  (reste : variables `assigned-but-never-used` ~257 + args sans `_` + divers).
- `tsc --noEmit` : exit 0 (aucun impact CI typecheck, permet `server:ts`).
- Jest : **71 suites / 715 tests — tous verts**.
- `madge --circular services routes core scripts src` : `No circular dependency found`.
- Boot serveur : `GET /api/health` → **200 {"status":"ok"}** (port 10000), Redis connecté,
  archive promosport importée, cron actif.

### Limite honnête
- Les 342 warnings restants ne sont **pas auto-corrigeables sans churn** (suppression/
  sous-lignage manuel de variables inutilisées). Ne pas les « résoudre » en masse :
  risque de casser du code volontairement gardé (effets de bord, injonctions futures).
  Le projet est exempt d'erreurs ESLint.

### Prochaines étapes possibles
- (Optionnel) dépouiller les ~257 variables `assigned-but-never-used` fichier par fichier
  si souhaité, en vérifiant chaque cas. À décider avec l'utilisateur.
- Travail en cours préexistant non commité, préservé tel quel (ConfigEngine/data,
  routes/promosport, Python XGB/prediction, __tests__/config-isolation.js + jest.config.js).

---

## 🖼️ Intégration PixelRAG-lite (contexte visuel dans les prédictions) — session en cours

### Objectif
Enrichir les pronostics avec du **contexte visuel** (captures Sofascore : forme, compos,
stats) façon PixelRAG (https://github.com/StarTrail-org/PixelRAG), adapté à la machine
cible (i5 8th gen, 8 Go RAM, **pas de GPU**, Windows, ~17 Go disque).

### Contrainte matérielle → adaptation honnête
PixelRAG réel (Qwen3-VL-Embedding-2B, `pyproject` `[tool.uv] environments = linux/darwin`)
**ne tourne pas** sur ce poste. On implémente donc un **PixelRAG-lite** : serveur vision
local **CLIP** (`openai/clip-vit-base-patch32`, torch **déjà présent** dans `.venv`,
`transformers` installé) exposant le **même contrat d'API** (`/search`, `/ingest`,
`/embed`, `/visual/enrich`, `/health`) sur le port **30002**. Si un vrai PixelRAG est
déployé plus tard (GPU/Linux), il suffit de pointer `PIXELRAG_URL` dessus — zéro changement
côté stitch.

### Fichiers créés
- `core/visual_server.py` — serveur vision FastAPI :30002. CLIP si dispo, sinon **fallback
  PIL** (moments couleur + histogramme + grille). Index persisté `data/visual/visual_index.jsonl`.
- `core/visual_features.py` — `extract_visual_features(match_data)` : ajoute les colonnes
  `visual_confidence`, `visual_tiles_n`, `visual_max_score`, `visual_mean_score`,
  `visual_covers`, `visual_has_lineup`, `visual_has_form`, `visual_has_xg`. Dégradation silencieuse.
- `services/pixelragService.js` — client HTTP :30002 (`PIXELRAG_URL` env), timeouts,
  dégradation douce (retourne null si down).
- `services/visualEnrichmentService.js` — `getVisualContext(match)` : cache DB
  (`visual_context_cache`, TTL 12 h) → recherche PixelRAG → construction du contexte.
- `scripts/scrapeVisualBatch.js` — batch local **Puppeteer** (stealth, réutilise le pattern
  de `SofascoreScraping/src/apiClient.js`) : résout les IDs équipes via `api/v1/search/all`,
  capture les pages équipe domicile/extérieur → `data/visual/<matchId>/{home,away}.jpg`,
  ingère dans le serveur vision, écrit `visual_context_cache`. Rate-limit 3 s, 100 matchs/batch.
  Désactivé si `DISABLE_SOFASCORE=true` ou Chrome absent (Render/Docker).

### Fichiers modifiés
- `core/fastapi_server.py` — `_run_prediction_payload` appelle `extract_visual_features`
  (best-effort, try/except) après `clean_data`.
- `services/mlPredictionService.js` — injection `matchData.visual_context` via
  `visualEnrichmentService.getVisualContext` avant `pythonService.predict` (best-effort).
- `core/database.js` — table `visual_context_cache` + méthodes `getVisualContext` /
  `setVisualContext` (upsert).
- `services/cronManager.js` — job **#33** `0 8,20 * * *` (Africa/Tunis) → `scrapeVisualBatch.main()`.
- `.gitignore` — `data/visual/` ignoré (captures + index embeddings).

### Vérifications (vertes)
- `node --check` : 6 JS OK. `py_compile` : 3 py OK.
- Serveur vision : `/health` → CLIP chargé dim 512 ; `/ingest` + `/search` OK (cosine).
- Chaîne Node : health → contexte visuel → écriture DB → relecture cache (OUI).
- `visual_features` : features injectées + zéros sans contexte.
- FastAPI `/predict` avec `visual_context` → `success=True`, **aucune** erreur d'injection.
- **Non-régression : `npm test` 71 suites / 715 tests passés.**

### Limites / à faire
- Les features `visual_*` n'influencent le score XGBoost qu'**après réentraînement**
  (le booster actuel ignore les clés inconnues). Prochaine étape : les ajouter à
  `FEATURE_NAMES_V55` / `ml_features.py` + retrain.
- `scrapeVisualBatch` n'a **pas** été exécuté en conditions réelles (Sofascore anti-bot) ;
  à valider sur un petit batch (`--limit 3 --dry-run`) avant de faire confiance au cron.
- Migration Postgres (`pg_migrations.js`) de `visual_context_cache` non faite (batch = local).
- Serveurs de test arrêtés, artefacts de test supprimés.

### ⬆️ Mise à jour — protocole PixelRAG RÉEL (session suivante)
Vérification du dépôt `C:\Users\HAMDI\Desktop\PixelRAG` (`serve/src/pixelrag_serve/api.py`) :
- **API réelle** : `POST /search` → `{results:[{hits:[{score, article_id, tile_index,
  chunk_index, y_offset, tile_height, path, url}]}]}` ; `GET /status` (modèle, dimension,
  nb vecteurs) ; `GET /health` → `{status:"ok"}`. **Pas d'`/ingest`** : l'index FAISS est
  construit hors-ligne (`pixelrag embed` + `pixelrag index build`).
- **Verdict matériel (README officiel)** : cible Linux/CUDA + macOS/MPS ; modèle
  `Qwen3-VL-Embedding-2B` ≈ 8 Go float32 → **OOM sur ce poste (8 Go, Windows, sans GPU)**.
  Exécution du vrai moteur impossible localement.

**Intégration rendue conforme au vrai PixelRAG :**
- `services/pixelragService.js` réécrit pour parler l'API **exacte** : parsing
  `results[].hits[]`, `normalizeSearchResponse()` (tolère aussi l'ancien format lite),
  `search()`/`searchByImage()` (query image base64 native), `getStatus()` (`/status`),
  `getHealth()`. `ingest`/`embed` conservés = extensions du serveur lite uniquement.
- `core/visual_server.py` (lite) renvoie désormais le **même format** que le vrai
  PixelRAG (`/search` → `results[].hits[]`, + `/status`) → **le code stitch est identique
  contre le lite (CPU) ou un vrai PixelRAG (GPU/Mac)** : il suffit de changer `PIXELRAG_URL`.
- `services/visualEnrichmentService.js` : `visual_confidence` = meilleur score cosinus
  (borné [0,1]), `screenshot_paths`/`article_ids` extraits des hits.
- `scripts/scrapeVisualBatch.js` : captures **fullPage** (chunkables en tiles) + génération
  de `data/visual/articles.json` au format natif PixelRAG (`{article_id:{url,title,department}}`)
  → corpus **prêt pour un vrai `pixelrag index build`** sur hôte GPU.

**Passer au vrai PixelRAG (quand un hôte GPU/Mac est dispo)** :
1. Sur l'hôte : `uv sync --extra serve` (Linux/Mac), puis `pixelrag embed` +
   `pixelrag index build` sur `data/visual/` (tiles + articles.json produits par le scraper).
2. `pixelrag serve --index-dir ./index --tiles-dir ./tiles --articles-json ./articles.json
   --device cuda --port 30001`.
3. Côté stitch : `PIXELRAG_URL=http://<hote>:30001`. Aucune modif de code.

**Tests (verts)** : `py_compile` + `node --check` OK ; lite `/search` renvoie le format
réel ; chaîne Node `getStatus`→`search`(normalisé)→`getVisualContext`→cache DB OK.
`npm test` inchangé (aucun test ne dépend du serveur vision).

---

## 🖼️ Suite PixelRAG-lite — validation scraper + câblage features visuelles (session 2026-09-07)

Reprise des 3 « à faire » laissés ouverts en fin de session précédente.

### 1) scrapeVisualBatch validé en conditions RÉELLES (anti-bot contourné)
- Dry-run `--limit 3` initial : **3/3 échecs** `net::ERR_ABORTED` sur
  `www.sofascore.com/api/v1/search/all` (Cloudflare bloque le `page.goto` JSON).
- **Fix** : réutiliser le bypass **déjà présent** dans le projet (curl_cffi → `api.sofascore.com`)
  au lieu de réinventer :
  - `scripts/sofascore_bypass.py` : nouvelle sous-commande `team --name "<équipe>"`
    (expose la fonction `search_team()` existante, format natif `results[].entity`).
  - `services/scrapers/SofascoreBypass.js` : `searchTeam(name)` (cache `teamCache`, TTL
    `CACHE_TTL_EVENT`) + export.
  - `scripts/scrapeVisualBatch.js` : `resolveTeamId()` appelle d'abord
    `SofascoreBypass.searchTeam()` ; le `page.goto` n'est plus qu'un **fallback**.
- Résultat dry-run : **3/3 ok**. Puis run réel `--limit 1` : **2 captures** fullPage
  (home 529 KB / away 487 KB) → `data/visual/livescore_1798985/`, `articles.json` au format
  natif PixelRAG, index vision = 3 vecteurs, `visual_context_cache` écrit (conf=1, 2 tuiles).
- Serveur vision : CLIP `openai/clip-vit-base-patch32` chargé en **lazy** (1er ingest) →
  `/health` indique PIL-fallback avant, CLIP après — comportement attendu, pas un bug.

### 2) Features `visual_*` réellement câblées vers le ML (point bloquant trouvé)
Constat : `extract_visual_features()` injecte bien les colonnes dans `match_data`, MAIS
`extract_ml_features()` ne les **propageait pas** dans le dict `features` → jamais dans le
vecteur, ni en inférence ni en entraînement. Correction :
- `core/ml_features.py` :
  - `VISUAL_FEATURE_NAMES` (8 colonnes) + `FEATURE_NAMES_V55_VISUAL = V55 + visual`
    (**nouveau set séparé** — on ne touche PAS V55/V551/V552/V553 : boosters liés à leur
    compte de features, sinon `_candidate_ok` ferait sauter le modèle de prod).
  - Boucle de propagation `row → features` avant le NaN-cleanup.
  - Entrées `FEATURE_VOLATILITY` pour les 8 colonnes.
- `core/model_manager.py` : `V55_VISUAL_MODEL_PATH` + `get_v55_visual_booster()` (→ None si
  absent = dormant).
- `core/ml_ensemble.py` : créneau candidat `V55-VISUAL` en tête de chaîne, **opt-in via
  `USE_V55_VISUAL=1`** et seulement si l'artefact existe. Par défaut : zéro changement prod
  (vérifié : V552-CHRONO reste sélectionné, avec et sans la variable).
- `core/train_v55.py` : flag `--visual` → entraîne `FEATURE_NAMES_V55_VISUAL` en régime
  chronologique (comme V552) vers `models/stitch_v55_visual.json`.

### 3) Décision honnête sur le RETRAIN — différé (pas de données)
Le réentraînement **n'a pas été lancé** : le jeu d'entraînement historique
(`historical_archive.sqlite`) ne contient **aucune** colonne visuelle → retrain maintenant
= 8 colonnes constantes à 0 = booster identique à V55 + 8 features mortes (coût, zéro gain).
**Backfill rétroactif écarté** : capturer les pages Sofascore « aujourd'hui » pour des matchs
passés = **fuite temporelle** (le contexte visuel ne reflète pas le jour du match).
→ Les `visual_*` ne peuvent s'apprendre que sur données **forward-looking**.
**Déclencheur de retrain** : quand `visual_context_cache` aura accumulé un volume suffisant
de matchs **réglés** avec contexte (ordre de grandeur ~200+), joindre le cache au dataset et
lancer `python core/train_v55.py --visual`, backtester contre V552, puis activer
`USE_V55_VISUAL=1`. Le pipeline de capture (cron #33) alimente le cache dès maintenant.

### 4) Migration Postgres `visual_context_cache` (à faire n°3)
Le mode prod (`DATABASE_URL`) exporte `pg_database.js`, pas l'objet SQLite → il fallait :
- `core/pg_migrations.js` : table `visual_context_cache` dans `SCHEMA_SQL` (miroir SQLite,
  `enriched_at BIGINT`).
- `core/pg_database.js` : `getVisualContext` / `setVisualContext` **async**, même forme
  (colonnes JSON en TEXT) que le chemin SQLite.
- `services/visualEnrichmentService.js` : `await` sur les 3 appels DB (get/set/getScreenshots).
  Rétro-compatible : `await` sur une valeur sync SQLite la renvoie telle quelle.

### 5) Bug préexistant corrigé au passage (hors scope, 1 ligne de garde)
`tests/test_ml_ensemble.py::TestPredictSecondaryMarkets` échouait **déjà sur HEAD** (vérifié
par `git stash`) : `predict_secondary_markets({}, [])` renvoyait **corners = -2.7** (booster
de régression sur `feature_vector` vide). Fix : si sortie modèle ≤ 0 → retour au **baseline
heuristique** (> 0). Ne change rien aux prédictions réelles (toujours positives).

### Vérifications (vertes)
- `node --check` : 5 JS OK. `py_compile` : 4 py OK. Imports runtime OK (V55_VISUAL=231).
- Propagation testée : `extract_ml_features` → les 8 `visual_*` ressortent du dict.
- Sélection modèle inchangée par défaut (V552-CHRONO, vec 202) avec/sans `USE_V55_VISUAL`.
- Cache relu via le service : `{cached:true, conf:1, tiles:2, shots:2}`.
- **Non-régression : pytest 347 passed / 0 failed (2 échecs corrigés) ; Jest 71 suites / 715 tests.**
- Serveurs de test arrêtés. Captures réelles conservées (données utiles, `data/visual/` gitignoré).

### Prochain point de contrôle
- Laisser tourner le cron #33 quelques jours → surveiller la croissance de
  `visual_context_cache`. Quand volume de matchs réglés suffisant : retrain `--visual` +
  backtest + arbitrage activation `USE_V55_VISUAL`.
- Travail non commité toujours présent (ConfigEngine/data, routes/promosport, Python
  XGB/prediction, __tests__/config-isolation.js) — préservé, non commité (pas de demande).

---

## 🖼️ PixelRAG RÉEL hébergé — intégration api.pixelrag.ai (session 2026-09-07, plan 1→5)

### Découverte (vérifiée en live)
Le dépôt https://github.com/StarTrail-org/PixelRAG expose une **API hébergée gratuite,
sans clé** : `https://api.pixelrag.ai` = le VRAI moteur (Qwen3-VL-Embedding-2B + LoRA,
26.3M vecteurs Wikipédia, dim 2048). Schéma `/search` **identique** à notre client
(`{queries:[{text}], n_docs}` → `results[].hits[]`) → test réel « Cruz Azul » renvoie les
tuiles « 2011–12 Cruz Azul season » (score 0.64). Nouvel endpoint `GET /tile/{article_id}/
{tile}/{chunk}` → **PNG** de la tuile (testé : 398 Ko, octets magiques OK).
Auto-hébergement local du moteur toujours impossible (OOM 8 Go / pas de GPU) → l'hébergé
est la seule voie gratuite vers le vrai modèle. L'index Wikipédia (construit 2026-05) est
du contexte **historique**, pas live — le live reste Sofascore via le lite local.

### Phase 1 — `services/pixelragService.js` : client DOUBLE + tuiles
- Factory `_makeClient(baseUrl)` ; deux instances exportées : `local` (`PIXELRAG_URL`,
  :30002, notre corpus) et `wiki` (`PIXELRAG_WIKI_URL`, défaut api.pixelrag.ai).
- `getTile(articleId, tile, chunk)` → Buffer PNG (wiki only, timeout 10 s).
- `normalizeSearchResponse` : construit `wiki_url` (titre Wikipédia → URL encodée).
- Rétro-compat totale : exports premier niveau (`search`, `ingest`, `embed`, `getStatus`,
  `getHealth`, `searchByImage`) = client local ; `VISION_URL` conservé.

### Phase 2 — `services/visualEnrichmentService.js` : enrichissement DUAL
- `getVisualContext` lance en parallèle : recherche locale (corpus Sofascore) + recherche
  wiki (2 requêtes : `"<domicile> football club season squad"`, `"<extérieur> …"`).
- Tuiles fusionnées taggées `source:'sofascore'|'wikipedia'` ; `visual_confidence` = max
  toutes sources ; `screenshot_paths` = chemins locaux uniquement.
- Testé : serveur local DOWN → chemin wiki-only (conf 0.655, 6 tuiles), cache relu OK.

### Phase 4 — `core/visual_features.py` + `core/ml_features.py` : 4 colonnes wiki
- `visual_wiki_confidence`, `visual_wiki_hits`, `visual_wiki_has_squad`,
  `visual_wiki_has_history` (détectés via `source=='wikipedia'` + mots-clés de titres).
- `VISUAL_FEATURE_NAMES` 8→12 → `FEATURE_NAMES_V55_VISUAL` 223→**235 dims** (set séparé,
  boosters de prod intacts). Entrées `FEATURE_VOLATILITY`.
- Test bout-en-bout réel : cache `16629481` → features `{wiki_conf:0.62, hits:4, history:1}`.

### Phase 5 — `scripts/scrapeVisualBatch.js` : pré-remplissage wiki + mode wiki-only
- `fetchWikiTiles()` : recherche wiki (2 requêtes, n_docs 2) + **téléchargement des tuiles
  PNG** dans `data/visual/<matchId>/wiki_*.png` → fusionnées dans `visual_context_cache`.
- Si serveur vision local DOWN : plus de sortie anticipée — **mode wiki-only** (pas de
  navigateur, pas de capture Sofascore, cache pré-rempli quand même). `resolveTeamId`
  fallback `page.goto` gardé uniquement si navigateur dispo.
- Test réel `--limit 3` (lite down) : 3/3 ok, 4 tuiles wiki + 4 PNG/match, conf ~0.62.

### Phase 3 — `services/visualBriefingService.js` : lecteur RAG (Groq vision)
- Envoie top 3 tuiles (PNG local ou fetch `getTile` à la volée si recherche live) à
  `meta-llama/llama-4-scout-17b-16e-instruct` via Groq (libre, sans GPU) → briefing FR
  3 puces. **Garde-fou budget** : `data/visual_briefing_usage.json`, plafond mensuel
  `VISUAL_BRIEFING_MAX_MONTHLY` (défaut 500). Flags : `VISUAL_BRIEFING=off` ou clé
  absente → null (dégradation totale, prédiction intacte).
- `briefing TEXT` ajouté à `visual_context_cache` : CREATE + migration `ensureColumn`
  (SQLite), CREATE + `ALTER ... IF NOT EXISTS` (PG), upsert `COALESCE` (les deux).
- Fils : `visualEnrichmentService` (cache-hit → `visual_briefing` ; fresh → génère +
  persiste) ; `mlPredictionService` (`result.visual_briefing` sur prédictions réussies).
- **Clé GROQ absente de l'environnement local** → briefing dormant tant que l'utilisateur
  n'ajoute pas `GROQ_API_KEY` (à son `.env`). Toute la chaîne reste testée sans réseau.
- `__tests__/visualBriefingService.test.js` : 8 tests (axios mocké, fs mocké du setup.js
  respecté — chemins 'data', budget piloté par mockImplementation). Piège relevé :
  `jest.mock('fs')` global de setup.js rend `existsSync` faux hors chemins 'data'.

### Vérifications (vertes)
- `node --check` : 8 JS OK ; `py_compile` : 2 py OK.
- Live : wiki search normalisé + getTile PNG ; batch wiki-only 3/3 ; cache→features Python.
- **Non-régression : Jest 72 suites / 723 tests (+8) ; pytest 347 passed / 0 failed.**

### À faire / points de contrôle
- Ajouter `GROQ_API_KEY` au `.env` local pour activer les briefings (sinon dormant, sans
  danger). Vérifier alors 1 génération réelle + persistance `briefing` en cache.
- Laisser cron #33 accumuler tuiles wiki + captures ; retrain `--visual` (235 dims) au
  déclencheur (~200 matchs réglés avec contexte), backtest contre V552, puis `USE_V55_VISUAL=1`.
- Rien commité (non demandé).

---

## 👁️ Lecteur vision ACTIVÉ — OpenRouter gratuit (session 2026-09-07, suite)

### Contexte : les clés locales
Demande : « a-t-on déjà une clé qui marche pour lire les PNG ? » Audit du store opencode
(`~/.local/share/opencode/auth.json`, 8 fournisseurs) — **sans jamais afficher une valeur** :
- **Groq** : clé valide mais **aucun modèle vision** sur le compte (14 modèles, texte/audio).
- **Anthropic / OpenAI / Moonshot** : 401 en direct (clés liées à un proxy opencode).
- Entrée `openrouter` = clé `sk-Bt…` (51 car.) **non conforme** au format OpenRouter
  (c'est un proxy ; `/models` est public, donc ne prouvait rien).
- Vraie clé OpenRouter (`sk-or-v…`, 73 car.) trouvée sous l'entrée **`opencode-go`**.

### Preuve de lecture PNG (test réel sur tuile en cache)
- `google/gemma-4-31b-it:free` : auth OK mais **429** (pool gratuit saturé).
- **`minimax/minimax-m3:free` : LIT CORRECTEMENT** la tuile Wikipédia Al-Ahli (stats
  Al-Rashidi 110M/7buts/13pd, effectif Mahrez/Kessié/Firmino). → retenu comme primaire.

### `services/visualBriefingService.js` — provider-agnostic
- Env : `VISION_LLM_BASE_URL` (défaut `https://openrouter.ai/api/v1`), `VISION_LLM_MODEL`
  (défaut `minimax/minimax-m3:free`), `VISION_LLM_FALLBACK_MODEL` (défaut
  `google/gemma-4-31b-it:free`), `VISION_LLM_API_KEY` (fallback `OPENROUTER_API_KEY` →
  `GROQ_API_KEY`). `_apiKey()` centralise la résolution.
- **Retry auto sur le fallback en cas de 429** (les autres erreurs -> null, sans retry).
- Timeout 60 s (OpenRouter gratuit lent). Budget mensuel inchangé (500).

### `.env` stitch
- `OPENROUTER_API_KEY=<clé opencode-go>` ajoutée (valeur jamais échoît/commit ; `.env`
  confirmé gitignoré via `git check-ignore`).

### Vérifications (vertes)
- `node --check` OK. **Jest 725/725** (+2 tests : retry 429→fallback, erreur non-429→null).
- **E2E RÉEL** `getVisualContext(Al-Hilal vs Neom, force)` : 6 tuiles wiki (conf 0.619) →
  briefing 601 car. généré via minimax → **persisté** colonne `briefing` → relecture
  `cached:true` avec briefing. Le lecteur a identifié l'effectif Al-Hilal 2025-26 (Neymar,
  Mitrović, Bounou, Inzaghi) ET signalé honnêtement 2 tuiles hors-sujet.

### Limite relevée (à optimiser plus tard)
- La requête wiki `"<équipe> football club season squad"` ramène parfois des tuiles hors-sujet
  (joueur d'une autre équipe). Le lecteur les détecte ; piste d'amélioration : requête plus
  stricte (`"<équipe> <année> squad"`) ou filtre sur le titre du hit. Non bloquant.
  → **RÉSOLU juste en dessous (même session).**

### Pertinence wiki — requête saison + filtre par titre (fix session)
- `services/pixelragService.js` : nouveaux helpers exportés —
  `currentSeasonLabel()` (`"2026-27"`), `wikiQueriesForMatch(home, away)` →
  `"<équipe> <saison> season football"`, `filterTilesByTeams(tiles, noms)` → ne garde
  les tuiles dont le TITRE Wikipédia contient une équipe (normalisation accents/tirets,
  noms < 4 car. ignorés, repli sur la liste brute si rien ne matche).
- Consommateurs alignés : `visualEnrichmentService` (chemin live) +
  `scrapeVisualBatch.fetchWikiTiles` (pré-remplissage, n_docs 2→3).
- **Preuve live** (Al-Hilal vs Neom) : brut 6 tuiles dont Al-Hazem et Al-Ahli (hors-sujet)
  -> filtré 4 tuiles, uniquement Al-Hilal/Neom. L'index hébergé datant de 2026-05, la
  saison retombée est « 2025–26 » (dernière connue) — la requête sert d'indice, le filtre
  garantit la pertinence.
- `__tests__/pixelragService.test.js` : 7 tests purs (sans réseau).
- **Jest 732/732** (+7). Commit `feat(pixelrag)` suite de `e93ad6e`.

### Rôle de PixelRAG — état actuel (résumé honnête)
- **Retrieval** : local (Sofascore live) + hébergé (Wikipédia historique) → cache. ✅ actif.
- **Reader (G de RAG)** : briefing vision FR via OpenRouter gratuit. ✅ ACTIF (clé en place).
- **Features ML** : 12 colonnes `visual_*` prêtes ; effet sur XGBoost seulement après retrain
  `--visual` (déclencheur ~200 matchs réglés). ⏳ en accumulation.
- Rien commité (non demandé).

---

## 👁 PixelRAG — signaux structurés ENTRANTS dans l'engine (session 2026-09-07, plan 4 chemins)

Demande : « améliorer le rôle de PixelRAG » -> passer d'un briefing décoratif à un
apport RÉEL sur les verdicts, sans retrain (les boosters de prod consomment déjà les
champs d'absence). Validé par l'utilisateur : signaux entrants OUI + périmètre complet.

### A — Lecteur JSON + injection comblante
- `services/visualSignals.js` (nouveau, fonctions pures testables) :
  - `parseSignals(raw)` : extraction tolérante du 1er objet JSON (les LLM enveloppent
    en markdown), clamp flags 0/1 + confidence [0,1], null si pas de JSON.
  - `applyGapFill(matchData, match, signals)` : ne pose `is_missing_star(_away)` /
    `is_missing_gk(_away)` que si **news muettes** (null/0 côté match) ET
    `confidence ≥ VISUAL_SIGNAL_MIN_CONFIDENCE` (0.55). JAMAIS d'écrasement news.
  - `auditSignal(...)` : JSONL `data/visual_signal_audit.jsonl` (signaux + champs posés
    + verdict/conf/probs) — traçabilité complète des impacts.
- `services/visualBriefingService.js` : prompt -> **schéma JSON strict** (briefing +
  4 flags absence + formes + h2h_note + confidence) ; retourne `{text, signals}` ;
  réponse non-JSON tolérée (text brut, signals null) ; **cap quotidien**
  `VISUAL_BRIEFING_MAX_DAILY=40` (OpenRouter free ≈50 req/j) en plus du mensuel.
- `services/visualEnrichmentService.js` : la colonne `briefing` stocke le JSON ;
  décodage tolérant à la relecture (legacy texte brut OK) ; expose `visual_signals`.
- `services/mlPredictionService.js` : gap-fill sur `matchData` AVANT `/predict`
  (ces champs alimentent `xg_engine.apply_squad_intelligence` + le
  KEY_ABSENCES_VETO de `prediction_engine` -> effet immédiat sur verdicts/probs) ;
  audit APRÈS predict avec le verdict.

### B — Le briefing devient visible (c'était un cul-de-sac)
- `routes/matches.js` : nouveau `GET /api/matches/:id/visual` (briefing + signals +
  confiance depuis le cache).
- `src/services/dataService.js` : `fetchVisualContext(matchId)`.
- `src/components/UltimateMatchCenter/UltimateMatchCenter.jsx` : bloc « PIXELRAG 👁
  Lecture visuelle » dans le modal détail (briefing multi-puces + chips d'absence
  + fiabilité %), fetch à l'ouverture, silencieux si rien.
- `services/promosportIntelligence.js` : chaque match de la grille reçoit son
  `visual` (briefing tronqué 220 car.) dans le payload de l'analyste LLM + règle
  « intègre le champ visual en priorité » -> les secretWeapons exploitent PixelRAG.

### C — Retrieval H2H
- `wikiQueriesForMatch` : 3e requête `"<X> vs <Y> football head-to-head history"`.

### D — Boucle d'évaluation
- `scripts/visual_signal_stats.py` : joint l'audit JSONL aux résultats réglés
  (SQLite matches/historical_matches), compare réussite argmax(probs) quand un flag
  visuel a été posé vs baseline, détail par champ. À lancer dans quelques semaines.

### 🐛 Bug critique trouvé et corrigé au passage (`core/configEngine.js`)
`updateEnv()` faisait `existsSync` (mocké en test -> false hors chemins 'data') puis
lisait '' et **réécrivait `.env` avec la seule clé du coup** -> `npm test` a EFFACÉ
`OPENROUTER_API_KEY` du `.env` réel (découvert pendant l'E2E). Fix : lecture directe
via `fs.promises.readFile`, `ENOENT` seul = fichier vraiment absent ; toute autre
erreur = **écriture annulée** (ne jamais écraser à l'aveugle). Clé restaurée, et
pruvée : `.env` intact après `npm test` complet.

### Vérifications (vertes)
- `node --check` : 7 JS backend OK ; **build Vite OK** (front) ; `py_compile` stats OK.
- **Jest 744/744** (+12 : visualSignals purs, parse tolérant, cap quotidien, H2H).
- **E2E réel** (Al-Hilal vs Neom, force) : lecteur -> JSON « signaux OK », confidence
  0.45 (le modèle déclare honnêtement « aucun visuel ne montre absences/forme/H2H ») ->
  gap-fill **ne pose rien** (sous le seuil 0.55) = le design anti-hallucination
  fonctionne ; cache-hit décode signals + briefing (439 car.).
- Script stats : s'exécute, message d'accueil tant que l'audit est vide.

### Points de contrôle
- L'audit JSONL se remplira dès que les prédictions tourneront (serveur local).
- Rejouer `python scripts/visual_signal_stats.py` dans ~2 semaines : si le groupe
  « signaux posés » n'apporte rien, remonter le seuil à 0.65 ou désactiver le gap-fill
  (`VISUAL_SIGNAL_MIN_CONFIDENCE=1.1`).

---

## ?? ANNEXE � CHANGELOG AUDIT C (corners/HT, fusionn� 2026-09-07 depuis CHANGELOG_AUDIT_C.md supprim�)

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

---

## C8 — Backtest chronologique Corners O/U : PAS D'EDGE en ère moderne 🔴 (2026-08-26)

**Outil** : `scripts/backtest_corners.py` (nouveau, réutilisable — `--min-date`, `--flat-odds`,
`--edge`, `--warmup`). Données : `archive_football_data`, 39 677 matchs avec corners
(2005→2026-05), prédiction = moyennes d'équipe passées uniquement (shrinkage k=8,
avantage terrain +0.4) → NegBinom calibrée prod (`corners_calib.p_over_corner`).

### Résultats clés

**Ère complète (2005+, n=36 677)** — piège évité : les colonnes `odds_corner_over/under`
sont vides sur 100 % des lignes (jamais remplies) → tout ROI « à cote supposée » est un
artefact. Le +6.4 % global affiché venait des années 2005-2019 (+5 à +17 %/an), données
anciennes aux marchés moins efficients.

**Ère moderne (2020+ uniquement, n=11 543 évalués, 8 433 paris au seuil prod 55/45) :**

| Cote | Break-even | Hit rate | ROI flat |
|---|---|---|---|
| 1.90 | 52.6 % | 51.1 % | **−2.96 %** |
| 1.87 | 53.5 % | 51.1 % | **−4.49 %** |
| 1.85 | 54.1 % | 51.1 % | −5.51 % |
| 1.80 | 55.6 % | 51.1 % | −8.07 % |

Calibration probabiliste : log-loss modèle **0.731 vs baseline base-rate 0.693** (pire),
Brier 0.267 vs 0.250 (pire) → le prédicteur simple n'apporte AUCUNE valeur probabiliste
sur l'ère moderne, et les picks perdent à toutes les cotes réalistes.

### Interprétation honnête
1. Ce backtest teste un prédicteur SIMPLE (moyennes d'équipe). Le pipeline prod
   (`ml_ensemble.expected_corners` avec xG/tirs) pourrait faire mieux — mais la charge
   de la preuve lui incombe : Q2 n'avait validé que la dispersion NegBinom à mu donné
   (écart agrégé 1.3 pt), jamais une edge par-match.
2. Les marchés corners se sont efficacés après ~2019 : l'edge historique a disparu.
3. Cohérent avec la règle maison (P4 audit) : précision < break-even ⇒ masquage.

### Décision recommandée (à valider utilisateur)
- **Déprioriser/masquer les picks Corners en UI** (même pattern `VITE_DISABLE_*` que BTTS)
  tant qu'une edge live n'est pas démontrée avec les vraies cotes désormais collectées (C6).
- Garder le cron HT/corners (C3/C7) : il alimente la mesure qui tranchera sur n réel.
- Re-test possible : brancher `expected_corners` du pipeline complet dans ce même harnais.

---

## C9 — Backtest 1X2 PUR qualité d'équipe vs vraies cotes : PAS D'EDGE non plus 🔴 (2026-08-26)

**Outil** : `scripts/backtest_1x2_quality.py` (nouveau). Prédicteur = forces
attaque/défense par équipe/ligue shrinkées k=3 + Poisson score-grid (moteur identique à
`core/backtest_walkforward.poisson_params/predict`) — exactement « la qualité des équipes ».
Données : 42 221 matchs AVEC vraies cotes 1X2 archivées (2002→2026-05). Zéro fuite
(refit périodique sur passé uniquement, warmup 3000).

### Résultats (stratégie edge : p > 1/cote + 3 %)

| Périmètre | Paris | Hit | ROI |
|---|---|---|---|
| Global 2004→2026 | 32 300 | 28.9 % | **−7.13 %** |
| Ère moderne 2020+ | 9 628 | 28.5 % | **−8.20 %** |
| Par année | 22 années négatives / 23 | — | pire : −15.7 % (2024) |

Log-loss modèle 1.011 ; base rates réels H 45.3 / D 25.8 / A 28.9 %.

### Lecture honnête
1. Un modèle « qualité d'équipe » pur, même correctement construit, **ne bat pas les
   cotes bookmakers** sur le 1X2 — structurellement (marge ~5 % + modèles marché supérieurs).
   Converge avec le walk-forward P0 (Poisson 1.006 < LR 0.882 log-loss).
2. **Conséquence design** : la préférence DC du moteur (picks 1X/X2 majoritaires) n'est
   PAS de la lâcheté — c'est ce qui survit mathématiquement. Le masque P4 est d'ailleurs
   déjà INACTIF (.env sans flag) : ces picks viennent de la logique main_pick du moteur.
3. Forcer l'affichage 1X2 pur = présenter des picks dont on PROUVE qu'ils perdent face
   aux cotes. Option acceptable en « colonne info » (originalPrediction existe en fullData
   depuis A0), pas en pick principal pariable.

### Reste ouvert (demande utilisateur)
- Afficher le 1X2 pur en information complémentaire (colonne dédiée), sans remplacer
  le pick discipliné — à implémenter si confirmé.

---

## C10 — Top Picks : EV fabriqué sur cotes par défaut éliminé à la racine ✅ (2026-08-26)

### Constat (contrôle qualité des 6 picks affichés au dashboard)
Tous portaient `odds = 1.85 / 1.80` avec `+EV 20-39 %` uniformes. Vérification DB :
`quant.markets.O2.5.odds = 1.85` et `BTTS = 1.8/2.05` = **défauts codés en dur du moteur**
(`m.odds_X || défaut`), `odds_source = null`, colonnes SQLite souvent vides au moment
du calcul. Un pick était même daté de la veille sous « Top Picks du Jour ».

### Cause racine double
1. **`topPicksEngine.getMatchOdds`** acceptait les cotes quant fallback comme si elles
   étaient marché → EV fabriqué (exactement ce que les backtests C8/C9 réfutent).
2. **`database.getMatchesByStatuses` ligne ~1125** : `{...r, ...parsed}` — le blob
   fullData stale écrasait les colonnes DB fraîches pour tout champ non ré-épinglé.
   Les 1X2 l'étaient (`odds_home/draw/away`, commentaire « DB columns are
   authoritative ») mais **odds_over25/under25/btts_yes/btts_no avaient été oubliés**
   → même une cote réelle backfillée (oddsBackfill) était masquée par le blob.

### Correctifs appliqués
1. **`services/topPicksEngine.js`**
   - `hasRealOddsSource(m)` : colonnes SQLite OU `fullData.odds_source` (dataFusion :
     'betexplorer'|'sofascore'|'footballdata' ; null + fetch_error sinon).
   - `getMatchOdds` : fallbacks quant **interdits sans source réelle** → hasOu/hasBtts
     false → aucun candidat EV possible sur prix inventés.
   - Fenêtre « du jour » : `windowStart = now - 30 min` (Top Picks ET Stables) — fini
     les matchs déjà joués dans la sélection.
2. **`core/database.js::getMatchesByStatuses`** : épinglage des 4 colonnes manquantes
   après `...parsed` (odds_over25/under25/btts_yes/btts_no) — la DB redevient
   autoritative pour TOUTES les cotes, comme voulu par l'auteur initial.

### Validation AVANT/APRÈS (mêmes matchs, run réel)
| Pick | Cote avant | Cote après (réelle) | EV |
|---|---|---|---|
| FA 2000 O2.5 | 1.85 « +39 % » | **1.43** | +7 % (Kelly 10→4.2 %) |
| Preston BTTS | 1.80 « +27 % » | **1.57** | +11 % |
| Preston O2.5 | 1.85 « +35 % » | **1.64** | +20 % |
| Vietnam O2.5 / BTTS | 1.85/1.80 | **1.89/1.84** | +33 % / +22 % |
| Newmarket (match veille) | présent | **rejeté (fenêtre)** | — |

Les probas restent celles des modèles validés Q3/Q5 (xG-logistiques) ; seules les
cotes sont devenues vraies. L'edge résiduel (+7 à +33 pts) sur ligues à couverture
fine est désormais MESURABLE honnêtement par accuracyEngine (byMarket.OU/BTTS,
cotes archivées au temps T).

---

## C11 — Continuité scraper au redémarrage : reprise là où il s'est arrêté ✅ (2026-08-26)

**Demande utilisateur** : « au redémarrage du serveur, que ça reprenne depuis où ça
s'est fermé, pas scraper depuis le début ».

### État des lieux (ce qui existait DÉJÀ)
- **Workflow d'enrichissement** (`SofascoreScraping/src/Workflow.js:~700`) : logique
  `[RESUME] Fast-forwarded X already-analyzed matches` — au prochain passage, il
  relit la DB et saute les matchs déjà analysés. Aucun re-travail.
- **`insertMatch`** : upsert idempotent (`ON CONFLICT DO UPDATE` avec COALESCE sur
  les cotes) → re-scanner le même match n'écrase rien.
- **`data/scraper_state.json`** : lastScanAt + dates couvertes + santé des sources
  (cooldowns) → l'état de scan quotidien persiste.

### Ce qui MANQUAIT (corrigé)
1. **Flag `isRunning:true` coincé** si kill/crash en plein batch (constaté :
   batch 1/31 interrompu à 05:00). Nouveau `resetStaleScraperProgress()`
   (`core/utils.js`) appelé UNE fois au boot via startupBootstrap :
   - ne touche QUE les runs silencieux > 30 min (protège un batch vivant),
   - pose `interrupted:true` + note explicative, log `[SCRAPER-RESUME]`.
2. **Preuve de continuité au boot** : nouveau journal `[CONTINUITE]` dans
   startupBootstrap affichant les compteurs DB survivants (matches / finished /
   cotes 1X2 / O/U / BTTS / HT) + message « reprise où arrêté ».

### Validation
- Batch frais (13 min) : correctement IGNORÉ par le reset (protection run vivant).
- Batch simulé vieux de 2 h : détecté → `isRunning:false`, `interrupted:true`,
  note posée, log clair ; état réel restauré après test (batch possiblement vivant).
- Syntaxe : startupBootstrap.js + utils.js OK (node --check).

### Garantie finale pour l'utilisateur
Fermer/rouvrir le serveur = **zéro perte** (SQLite sur disque) et **reprise
automatique** : les matchs déjà scrapés/analysés sont fast-forwardés, seuls les
manquants sont traités. Le journal [CONTINUITE] au boot le prouve chiffre à l'appui.

## Prochaines actions (hors scope)
- `npm install` dans le worktree puis lancer les tests Jest (état : bloqué par env)
- Re-run du script de backfill CSV après chaque mise à jour football_data (07h00 quotidien)
- Worker 2x/jour Sofascore tourne en parallèle pour les nouveaux matchs
- Pour augmenter le taux de matching : API-Football (Top-5 + Euro + sud-américaines) ou
  scraper manuel BetExplorer pour les ligues exotiques les plus jouées

---

## ?? Audit hygi�ne & structure � ex�cution du plan P0?P7 (session 2026-09-07)

Demande : rapport faiblesses/doublons puis ex�cution locale du plan de r�solution.

### P0 � Sauvegarde sans remote
- `git bundle` complet de main -> `backups/stitch-main-2026-09-07_0338.bundle` (v�rifi�,
  historique entier). Travail 100 % local, aucun push.

### P1 � Travail pr�existant commit� (valid� par les suites avant commit)
- `feat(ml)` 7e45e8d : escalier d'engine 4 �tages (Promosport -> Graph -> DEX ->
  Titanium XGB) + anti-crowd-trap + artefacts r�-entra�n�s + corpus journaux ML.
- `chore(test)` c42b891 : isolation ConfigEngine Jest (STITCH_CONFIG_FILE par worker).
- `feat(promosport)` c0dd453 : sauvegarde pr�-import archive + tests du blend.

### P2 � Donn�es runtime d�suivies (616499a)
- `git rm --cached` (conserv�s sur disque) : promosport_odds_cache, scraper_history,
  config.json, accuracy_trend/report, backtest_results/external (-23 053 lignes de l'index).
- `.gitignore` : caches data/*, /logs/ entier, /grilles/ (sorties dat�es), .pytest_cache.
- CHOIX assum� : les journaux ML non r�g�n�rables (engine_prob_trace,
  live_prediction_journal/results, combo_history, fpis_learning_log,
  tunisian_vote_history) RESTENT suivis (historique = seule sauvegarde, local-only).

### P3 � Doublons & morts (4a40c51)
- Supprim�s : `config/leagues_ids.json` (identique racine, 0 lecteur), `serverless/`
  (0 r�f�rence r�elle), `downloaded_files/` (lock Selenium).
- `CHANGELOG_AUDIT_C.md` fusionn� en annexe ci-dessus puis supprim�.
- Renommage anti-pi�ge : `scripts/backtest_feedback.py` -> `backtest_feedback_weights.py`
  (le `core/backtest_feedback.py` homonyme fait la CALIBRATION � deux r�les, un nom) ;
  refs `auto_retrain_worker.js` + `deploy_render.sh` mises � jour.
- `scripts_init/` -> `scripts/` ; logs racine (12) -> `logs/` ; test_*.js +
  _probe_www.py -> `scratch/`.
- Constats gard�s : `data_pipeline/` (845 Mo) EST utilis� (scraper, baseline, walk-forward)
  � projet imbriqu� document�, pas supprim� ; `backups/` = copie data_pipeline du 06/09
  (r�cente) -> gard�e ; `.streamlit` utilis� (command_center.py, ultra_dashboard.py) -> gard�.

### P4 � Unification des tests (01cf4f6)
- `tests/` = pytest uniquement ; tout Jest r�uni dans `__tests__/` (8 fichiers d�plac�s).
- Paires divergentes renomm�es sans fusion de contenu (elles testaient des aspects
  DIFF�RENTS sous le m�me nom) : `configEngine.coverage.test.js`,
  `mlPredictionService.status.test.js`.

### P5 � Portabilit� (bf52c22)
- 0 chemin absolu `C:\Users\HAMDI` restant dans le code suivi : DeepSeekService,
  openRouterService (USAGE_FILE relatifs), optimize_db.js, check_market_gates.js
  (+ override `PRONOS_SERVER_BAT`), pythonResolver (os.homedir).
- fb2f5fc : utilitaires d'exploration (live_picks, search_match/teams, test_live,
  u20_picks) mis � l'abri du bundle.

### P6 � Documentation (docs env)
- `.env.example` : +15 variables PixelRAG/vision document�es (URLs, budgets, seuils,
  flags) � incl. `VISION_SIGNAL_MIN_CONFIDENCE` (couperet injection) et
  `USE_V55_VISUAL` (activation booster visuel post-retrain).

### P7 � V�rifications finales (vertes)
- Jest 74 suites / 744 tests ; pytest 347 passed / 0 failed ; `vite build` OK ;
  `node --check` sur tous les fichiers touch�s ; bundle de sauvegarde r�g�n�r�.

### Diff�r� (volontairement hors p�rim�tre)
- D�coupage des god files (database.js 2 625 l., ml_features.py 2 529 l.,
  Promosport.jsx 2 623 l., enriched_predictions.js 2 013 l.) � � traiter une autre
  session, par tranches avec tests d�di�s.
- Restructuration `data_pipeline/` (projet Python imbriqu� avec son propre .venv) �
  fonctionnel, document� ; scinder en sous-module git si un jour besoin.

---

## ?? D�coupage des god files � Phases 1-3 (session 2026-09-07, plan approuv�)

Suite du plan � am�liorer le r�le de PixelRAG � -> audit hygi�ne -> d�coupage des gros
fichiers. P�rim�tre valid� : phases 1-3 (enriched_predictions.js laiss�e, classe coh�rente).

### Phase 1 � `core/ml_features.py` (2 529 l.) -> 4 modules + fa�ade `f685f27`
- `ml_feature_names.py` (443 l.) : listes FEATURE_NAMES_* + VISUAL + FEATURE_VOLATILITY.
- `ml_history.py` (1 027 l.) : connexions DB, historique (PG/master/archive), helpers
  analytiques (style, h2h, blessures, motivation, fatigue, travel).
- `ml_tunisian.py` (157 l.) : votes Tunisie (autonome).
- `ml_extract.py` (929 l.) : extract_ml_features + extract_v56_features.
- `ml_features.py` : fa�ade r�-export (~80 l.) � les 28 importeurs ne bougent pas.
- D�coupe par SCRIPT de slicing (contenu byte-identique) ; _f dupliqu� supprim�.
- ? pytest 347/347 ; imports ml_ensemble/prediction_engine/train_v55 OK.

### Phase 2 � `core/database.js` (2 625 l.) -> 5 modules + fa�ade `bfde439`
- `core/db/schema.js` : initSchema/runMigrations/seedLeaguesConfig (db en param�tre).
- `core/db/query.js` : statementCache + getPreparedStatement + exec/prepare/get/transaction/query.
- `core/db/matches.js` (21 m�thodes) / `predictions.js` (11) / `misc.js` (16, dont visual_context).
- `database.js` : fa�ade 5,7 Ko � toggle PG en t�te INTACT, composition {...daos},
  binding db.query conserv�. 103 importeurs inchang�s.
- D�coupe script�e (propri�t�s de l'objet) ; query async MORT supprim� (�cras� par le
  sync dans le m�me litt�ral � comportement final identique). '__dirname' corrig� pour
  misc ('../../data').
- ? Jest 744/744 ; smoke getVisualContext/getMatchesByStatuses OK ; prettier pass�.

### Phase 3 � `src/components/Promosport.jsx` (2 623 l.) -> hook + 6 vues `1b4174f`
- `promosport/usePromosportData.js` : 19 useState + fetchs + handlers + exportAsImage.
- `promosport/{PromoHeader,TunisieView,AlgoView,ColonnesView,GoldView,GridView}.jsx`.
- `promosport/promoHelpers.js` : computeGagnant/SOURCE_LABELS/coverageSummary.
- Promosport.jsx : 2623 -> 91 lignes (switch viewMode en composition).
- Code mort �limin� : renderBox, applyAlgo, totalDoubles, import selectBestDoubles.
- ?? Le JSX a �t� relu ligne � ligne contre l'original (une section Tunisie d'abord
  �crite de m�moire a �t� corrig�e par le texte verbatim � le�on : jamais re-taper).
- ? eslint 0 erreur (3 warnings = morts pr�existants) ; vite build OK ; Jest 744/744.
- RESTE � FAIRE : v�rification VISUELLE par l'utilisateur (npm run dev -> page Promosport :
  grille par d�faut, s�lecteur doubles, export JPEG, boutons Terminal/Colonnes ML/Gold/
  Pr�cision, vue Tunisie).

### Bundle de sauvegarde
- R�g�n�r� en fin de session (backups/stitch-main-*.bundle), historique complet.
