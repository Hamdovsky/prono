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

## 4. Estimation globale

Phase 1 (sûr, immédiat) ≈ 0,5 j. Phase 2 (vraie valeur) ≈ 1 j. Phases 3-4
≈ 1,5-2 j et dépendants réseau/produit. Total ≈ 3-4 j pour HT+Under réellement
classables. Le classement BTTS, lui, est déjà dispo aujourd'hui.

## 5. Décision en attente

Prochaine action proposée = **Phase 1** (script dry-run + garde FT, aucune écriture
de HT douteux), puis on regarde le taux de recouvrement réel avant d'ouvrir Phase 2.
