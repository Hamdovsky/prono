# Chantier : rendre mesurables « 1re mi-temps (HT) » et « Under »

Ouvert 2026-09-14 (session pronostico). Diagnostic fondé sur le code réel + la
base `data/tactical.db` (lecture seule). Ne RIEN écrire sans la garde FT décrite.

## 0. Constat chiffré (preuve)

- `accuracyEngine` par marché (global) : **DC 70,8 %** (n 4891) · BTTS 53,9 %
  (n 5430) · 1X2 sec 42,9 % (n 2325) · **OU 94,3 % (n 2025) mais TRIVIAL**.
- Marché HT : `evaluated = 0`. Corners : 0. Under : **0 pick dans toute la base**
  (labels FT = `1X/12/O0.5/X2` ; le seul pick buts est `O0.5`).
- `matches` finished : 191 (2026-09), `ht_score_home` non-null = **0**.
  `historical_matches` : `ht_score_home` non-null = **28 / 9557**, `fd.ht_score_*` = 0.
- Sofascore `stats --event` → **HTTP 403** sur `/incidents` & `/statistics` (testé,
  y compris sur un VRAI id Sofascore 15421225 issu de `/api/live`). Blocked = à la
  source, pas un mauvais id.
- ids matchs = `livescore_<Eid>` (939/939) ≠ id event Sofascore. Colonne
  `home_team_id` = NULL (le `home_team_id` de fullData est un id d'**équipe**).

## 1. Infra DÉJÀ en place (ne pas recréer)

- Prob HT par match : `core/ht_model.py` → `data/ht_model.json` ; exposée via
  `StatisticalEngine` (`probs.ht_goal`) → `enriched_predictions.js:1600`
  `ht_goal_prob`. `marketPolicy.deriveHTPick()` lit `ht_goal_prob` (sinon prior).
- Précision HT : LUE et corrigée en **E23** (noms de colonnes `ht_score_home` +
  repli `fullData`). Le seul maillon manquant = la DONNÉE `ht_score_home` au
  règlement, et des picks HT non dégénérés (Under).

## 2. Pourquoi ça ne marche pas aujourd'hui (3 verrous indépendants)

- V1 — Ingestion : la seed livescore (`cloudSeed.js` mapLiveScore) ne lit que
  `Tr1/Tr2` (FT). Le score de MT n'est jamais capturé → rien à stocker.
- V2 — Sofascore : endpoints stats 403 en local (anti-bot). Et même hors 403,
  l'extracteur `sofascoreStatsExtractor.processFinishedMatches` est cassé : il
  prend `home_team_id` comme id EVENT Sofascore (alors = id équipe / NULL, et nos
  ids sont `livescore_`). Il ne sélectionne jamais de ligne → 0 écriture.
- V3 — football-data (gratuit, non-bloqué, a `HTHG/HTAG`) : ne couvre QUE
  certaines ligues européennes ; nos finished courants sont surtout
  Amériques/Afrique/Asie → recouvrement faible sur CE jeu, mais utile pour le
  long terme (Serie B, etc.) et pour `historical_matches` européen.

## 3. Plan par phases (du plus sûr au plus coûteux)

### Phase 1 — Backfill HT via football-data (garde FT stricte) — SÛR, gratuit
- Script `scripts/backfill_ht_footballdata.js`, DRY-RUN par défaut, `--write` opt.
- Jointure : `date(YYYY-MM-DD)` + équipes **normalisées** + **`FTHG==scoreHome &&
  FTAG==scoreAway`** obligatoire (sinon SKIP). N'écrire `ht_score_home/away` que
  si `NULL`. Cible `matches` finished ET `historical_matches`.
- Idempotent ; couvre les ligues FD (E0 SP1 I1 D1 F1 G1, et 2es divisions I2/…
  selon fichiers dispo). Rapporte : candidates / jointures sûres / écrits / conflits.
- Coût : ~0,5 j. Bénéfice : HT mesurable pour le sous-ensemble FD (petit ici,
  gros sur l'archive européenne). **Aucun HT faux écrit** grâce à la garde FT.

### Phase 2 — Capturer HT à l'ingestion (source live) — requis pour le FUTUR
- Identifier un canal gratuit exposing half-time : livescore event detail
  (`/event/{Eid}` renvoie les interval scores « R1/R2 »), ou football-data
  `results.csv` quotidien. Le parser au **règlement** (`mapLiveScore` /
  service de résultats) pour peupler `ht_score_home/away` + `corners_ht_*`.
- Coût : ~1 j + dépendance payload source. Bénéfice : HT alimenté dès maintenant,
  futur automatique ; rend le classement HT réellement significatif.

### Phase 3 — Réparer l'extracteur Sofascore (optionnel, si hors-403 dispo)
- `sofascoreStatsExtractor` : résoudre l'id EVENT Sofascore par `SofascoreBypass.resolveEvent(home, away, ts)`
  (au lieu de `home_team_id`), puis `getEventStats`. Ne sert QUE si le réseau
  contourne le 403 (Render / autre fingerprint). Non testable en local (V2).
- Coût : ~0,5 j, mais **bloque réseau** → à valider hors-ligne impossible.

### Phase 4 — Émission des « Under » + picks HT Under — DÉCISION PRODUIT
- C'est un **choix**, pas un bug : le picker n'émet que `O0.5` (ligne sûre) et
  convertit 1X2→DC (`DISABLE_PURE_1X2`). Pour des Unders réels : autoriser le
  pick `U<x>` quand P(U) franchit le seuil EV/garde divergence (E17), et brancher
  `deriveHTPick` sur la VRAIE prob (ht_model) pour produire des `HT UNDER 0.5`.
- Nécessite un arbitrage risque/rendement (ROI sous, pas seulement précision).
  Coût : ~1-1,5 j + backtest ROI.

### Phase 4a — DIAGNOSTIC posé (read-only, 2026-09-14) : le HT est un PRIOR, pas un modèle
Mesure sur `data/tactical.db` : **751** picks HT en base, **99,9 % OVER / 0 UNDER**,
et **704/751 = proba ≈ 69 %** (exactement `HT_RATIOS.global=0.6939`). Cause :
`core/db/matches.js:64` et `pg_database.js:215` appellent `deriveHTPick({ht_goal_prob:
m.ht_goal_prob ?? m.fullData?.ht_goal_prob})` — cette proba est **NULL au moment de la
persistance** pour la quasi-totalité → repli prior → pick constant. Le VRAI calcul
Poisson HT existe (`StatisticalEngine` `goal_yes`, `ht_model.py`) et est produit par
la voie enrichie (`enriched_predictions.js:1600 ht_goal_prob: quantResult.probs.ht_goal`),
mais n'est pas rechargé sur l'objet persisté (seed livescore brute, et passes sans
enrichissement quant → ht_goal_prob absent). Donc « pas de HT skill » = **câblage
interrompu entre le calcul et la persistance**, pas une absence de modèle.

Implémentation PROPOSÉE (flaggée, réversible, NE PAS appliquer sans GO) :
- Assurer que `fullData.ht_goal_prob` (ou `data.ht_goal_prob`) soit écrit pour les
  matchs effectivement passés par le quant (StatisticalEngine/ht_model) AVANT que
  matches.js/pg_database ne dérivent ht_pick. Point de jonction = là où
  enriched_predictions construit le résultat persisté (ligne ~1600/1735).
- Gate `HT_MODEL=on|off` (défaut off) ; quand off → comportement actuel (prior).
- Mesurer ensuite calibration P(HT over 0.5) modèle vs réel (accuracyEngine, qui
  saura LIRE grâce à E23 + données E24) et backtest ROI avant d'activer en prod.
- Risque : touche le chemin de persistance des prédictions LIVE → exige validation
  explicite + suite verte + non-régression BTTS/DC/1X2 inchangés.

### Statut d'exécution
- Phase 1 : **FAITE** (E24) — 223 ht_score_home écrits, HT now mesurable (147 eval).
- Phase 2 : non faite (ingestion) — la seule voie qui alimente les matchs FUTURS.
- Phase 3 : bloque reseau (Sofascore 403) — non testable local.
- Phase 4a : **FAITE (E25)** — `HT_MODEL` (defaut **off** = non-regression totale) +
  `HT_GOAL_SHARE` : quand pas de prob HT directe, estimation `1-exp(-share*E[total])`
  depuis les buts attendus, aux 3 sites de persistance. Picks HT UNDER possibles +
  calibration mesurable une fois le flag active. Activer en prod = decision utilisateur
  (backtest d'abord), .env.example documente. Tests marketPolicy +4 (883 verts).


## 4. Estimation globale

Phase 1 (sûr, immédiat) ≈ 0,5 j. Phase 2 (vraie valeur) ≈ 1 j. Phases 3-4
≈ 1,5-2 j et dépendants réseau/produit. Total ≈ 3-4 j pour HT+Under réellement
classables. Le classement BTTS, lui, est déjà dispo aujourd'hui.

## 5. Décision en attente

Prochaine action proposée = **Phase 1** (script dry-run + garde FT, aucune écriture
de HT douteux), puis on regarde le taux de recouvrement réel avant d'ouvrir Phase 2.
