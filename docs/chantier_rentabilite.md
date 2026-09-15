# Chantier : Rentabilité & Calibration (ROI 1X2/DC positif)

Ouvert 2026-09-14. Cible = générateur de value réellement rentable (paris réels,
ROI>0), pas l'accuracy. Scope retenu : **1X2/DC d'abord** (meilleur échantillon),
mise critique = **ROI 1u + IC95** (Kelly capé 2 % indicatif secondaire).

## Constat de départ (mesuré, pas supposé)
- Modèle brut, tous matchs (accuracyEngine) : accuracy 66 % mais **ROI négatif
  partout** (global −6,9 %, DC −4,9 %, 1X2 −14,3 %, EV-filtre −12,5 %). Pattern :
  raison sur les cotes basses, tort sur les hautes -> précision ne paie pas.
- Filtre curaté `top_picks` : 62 lignes, **4 réglées, cotes synthétiques** -> ROI
  du générateur de value JAMAIS réellement mesuré.
- Population mesurable (proba + cote RÉELLE + résultat) : **~251** seulement.

## Cause racine n°1 : la mesure est impossible sans échantillon coté
D'où l'ordre : **Étape 1 (cotes) -> Étape 0 (harnais) -> Étape 2 (calibration+edge)**.

## Étape 1 — Persistance des cotes  [FAITE partiellement, E29]
- **1.1 ✅** Ne plus perdre les cotes à l'archivage. Helper pur `core/archiveMerge.js`
  `mergeOddsIntoFullData` (n'écrase pas, n'invente rien), câblé dans
  `core/db/matches.js:696 archiveFinishedMatches()` et `core/pg_database.js`. Test (6).
- **1.3 ✅(partiel)** Backfill cotes 1X2 closing football-data. Helper pur
  `core/fdJoin.js` (normTeam via config/teamAliases, ftCoherent = garde score final,
  pickClosingOdds B365>Avg>PS) + `scripts/backfill_odds_footballdata.js` (dry-run,
  transaction, idempotent). Appliqué : +225 cotes (0 incohérent).
- **LIMITE honnête** : population mesurable 251 -> ~463, PAS des milliers. FD ne
  couvre que l'Europe et l'archive (non-européenne) n'a jamais eu de cotes. Le
  vrai levier d'échantillon = le 1.1 qui mûrit avec le temps (capture au sweep +
  préservation à l'archive), ou une source de cotes couvrant nos ligues.
- **1.2 ⏳** Exclure toute cote synthétique de la MESURE (via `odds_source`) -> sera
  appliqué dans le harnais (Étape 0), pas par heuristique fragile.

## Étape 0 — Harnais de mesure walk-forward  [À FAIRE]
- Rejouer `core/backtest_walkforward.py` (folds mensuels, embargo, `leakage_tripwire`)
  pour 1X2/DC : par config -> n, accuracy, Brier, score de calibration, **ROI 1u,
  IC95**, ROI Kelly. Sortie `data/roi_harness_1x2.json`. `requireRealOdds=1` (1.2).
- Sans harnais, aucune config de calibration/edge ne peut être validée.

## Étape 2 — Calibration + Edge strict  [À FAIRE, backtest d'abord]
- 2.1 N'évaluer EV/edge/Kelly que sur **probas calibrées** (étendre `calibrator.js` ;
  l'EV actuel sur probas brutes est le piège : roiEvFiltered −12,5 %).
- 2.2 `edge_pp = (p_calibrée − p_implicite_déviggée)*100` ; `NO BET` si `edge<min`
  OU `EV_devig<=0`. Config `config/edge_gate.json`, flag off. Casse le biais favoris.
- 2.3 Balayer calibration × seuil via le harnais. **Question de vérité** : une config
  ROI 1u>0 (IC95>0) en walk-forward ? sinon -> défaut de SIGNAL (features), prouvé.

## Étape 3 — (hors scope 1)  [DIFFÉRÉ]
HT/OU : les `odds_ht_*`/over-under en fullData (1.1) les rendront mesurables ; `byCac`
(ROI par tranche, E16/E21) attendra son échantillon réglé.

## Risques / garde-fous
- Jamais de ROI sur cote synthétique ; walk-forward + anti-lookahead obligatoires ;
  chaque gate/flag derrière un `*=off` (défaut non-régression) ; non-régression Jest
  à chaque étape ; `data/tactical.db` gitignoré (enrichissement local réversible).

## Statut
- Étape 1 : 1.1 fait, 1.3 fait (partiel, plafond FD), 1.2 -> harnais. Commit E29 (en attente).
- Prochaine action : **Étape 0 harnais** (dès que l'échantillon réel le permet), puis
  Étape 2. DECISION OUVERTE : accepter de travailler sur ~460 paris (conclusions
  prudentes, IC larges) OU d'abord augmenter la capture de cotes sur les matchs À
  VENIR (sweep) avant de conclure.

## Étape B1 — Entraînement O/U (Poisson buts) : TENTÉ puis REJETÉ (E30)
`core/ou_model.py` (IPF forces équipe + HFA + shrinkage, P(Over2.5) par Poisson),
walk-forward temporel sur 9313 matchs terminés :
- TRAIN bat le plancher (−8,5 %) mais **TEST out-of-sample PIRE que la constante**
  (+5,2 %) ; subset « équipes récurrentes » (n=737) encore +2,3 % > plancher.
- Cause : longue traîne (~4700 clubs de ligues mineures peu récurrents) + xG absent.
**Verdict : pas de déploiement** (--train non lancé, 0 écriture). Le moteur O/U maison
sur buts n'a PAS d'edge généralisable ici.
**Reco O/U** : se fier au **marché dé-viggé** (cotes réelles, Étape 1-bis) + calibration
(Étape A) ; un modèle maison ne se justifie QUE sur ligues avec xG + clubs récurrents.
ou_model.py = diagnostic reproductible conservé.

## Étape 1-bis — Cotes O/U réelles (E31) : FAITE
`pickClosingOU` (fdJoin) + backfill FD étendu (1X2 **et** O/U) → +226 vraies cotes
O/U écrites (0 conflit FT). Population O/U mesurable 145 → **359** ; archiveMerge
préserve déjà `odds_over25/under25` (futur). **Verdict chiffré** (n=359, base Over
58,2 %, Brier base ~0,243) : **marché dé-viggé Brier 0,233 (bat la base)** vs
**modèle `ou_25_prob` 0,251 (pire que la base)**. → Moteur O/U = **cote de marché
dé-viggée + calibration**, proba interne à jeter. Prochain : calibrer le marché
(Étape A sur le marché OU), edge/EV vs cote (Étape C), et couvrir plus de vraies
cotes O/U au sweep (seulement ~6 % des matchs à venir sont cotés aujourd'hui).

## Étape test — Mouvement de ligne O/U (E32) : EDGE NEGATIF (efficience)
`scripts/ou_line_movement.js` (n≈22 000, FD ouverture `Avg>2.5` vs clôture `AvgC>2.5`
+ score réel) : Brier ouverture 0,2404 → clôture 0,2391 (la clôture à peine
meilleure = efficient). « Bet the drift » réussit 55-58 % **mais ROI négatif à la cote
de clôture (−1,7 % à −3,1 %)** : le mouvement est informatif, déjà dans le prix,
non exploitable gratuitement. 
→ **Synthèse O/U (E30+E31+E32) : le moteur O/U optimal = proba implicite du MARCHÉ
(dé-viggée) ; ni modèle maison, ni line-movement n'ajoutent d'edge.** Un edge O/U
exigerait d'informer avant le marché (xG/news non publics) + exécution à meilleure cote
que la clôture (CLV). Le pré-requis concret reste la **couverture des vraies cotes
O/U au sweep** (~6 % aujourd'hui).

## Étape 3 — Couverture des vraies cotes (EN COURS, E33) : fondations
Diagnostic (agent explore) des 4 tueurs : whitelist `oddsSweeper.js:47` (~69 % sautés),
univers football-data local trop étroit, scraping réseau en échec local, et **trou
d'honnêteté** (`fair_odds_model` accepté comme réel dans `topPicksEngine`).
- **Fait (E33)** : `core/oddsSource.js` `isRealBookmakerSource` (pur, testé ×4) branché
  dans `topPicksEngine.hasRealOddsSource` (rejette source synthétique même si numérique)
  → ferme l'EV circulaire qui corromprait calibration + CLV. `scripts/odds_coverage.js`
  (lecture seule) = **baseline** : vraie cote 1X2 **5,1 %**, O/U 4,2 %, BTTS 3,3 %,
  94,7 % sans cote. Ligues sautées = celles hors whitelist (NM Cup, non-league, Serie C).
- **À faire (couverture)** : (a) brancher les CSV **football-data par saison**
  (`FootballDataScraper`, déjà écrit, sans réseau, avec ouverture+clôture) dans
  `dataFusion` ; (b) whitelist configurable/étendue + corriger la collision `'Ligue'` ;
  (c) ne pas persister `fair_odds_model` dans les colonnes numériques de `dataFusion`.
- **Ensuite (Étape 2)** : dégel calibration 1X2/DC (≥150 échantillons propres), puis
  gate **CLV**   (`quant_performance`/`clv_value` existent mais vides ; il faut alimenter
  `odds_history` type≠LIVE au sweep pour avoir une vraie ligne de clôture).

## Étape CLV — Groundwork (E35) : FAITE
- `oddsSweeper.recordOddsHistory` : snapshot pré-match marqué **`'SWEEP'`** (avant :
  `'LIVE'`, confondu avec l'en-jeu). Le sweep (cron */15) alimente enfin une histoire de
  cotes pré-kickoff → la dernière avant kickoff = vraie closing line.
- `core/clv.js` `pickClosingSnapshot` (pur, testé ×6) : rend la dernière ligne
  `timestamp <= kickoff`, kickoff inconnu → dernière (compat), que du post-kickoff → null.
- `proPlanBankroll.closingOddsFor` branché dessus → **CLV calculé sur la vraie clôture**.
  (`quantRiskService.logTradePerformance` = code mort, non utilisé.)
Effet : dès que le sweep tourne avec réseau + serveur relancé, `quant_performance.clv`
devient significatif → condition du **gate CLV** (edge réel vs marché) de l'Étape 2.

## Levier A (E36) : ne pas s'arrêter à une cote synthétique — FAIT (gated)
`dataFusion.fetchOdds` : un résultat `fair_odds_model` court-circuitait la chaîne (return
immédiat → sofascore/betexplorer jamais essayés). Ajout garde `ODDS_REJECT_SYNTHETIC`
(env, défaut **off** = non-régression stricte) : quand ON, une cote synthétique ne fait
plus `return` → `continue` vers une vraie cote, l'estimateur n'étant rendu qu'en **dernier
recours** si aucune réelle trouvée. Test intégration `dataFusionSynthetic.test.js` (×3).
**Activer** = `.env` `ODDS_REJECT_SYNTHETIC=on` +
relancer, puis `node scripts/odds_coverage.js` pour mesurer la hausse (> 5,1 % attendu là
où ultimate échoue mais sofascore/betexplorer réussissent). Reste (b) : whitelist étendue/configurable + CSV
football-data par saison (univers).

## Étape 7 — Source stats via FotMob (E37) : FAITE (gated)
Sofascore étant 403 (IP-banni, proxies morts) et FotMob répondant **sans clé/proxy**,
bascule des stats d'équipe sur FotMob :
- `fotmobClient.py` corrigé (routes `/api/data/*`, en-têtes `x-mocks`, **fix encodage
  UTF-8** qui faisait échouer tout nom accentué), `fotmobService.getMatchStats`.
- `fotmobStatsExtractor.js` + `scripts/backfill_fotmob_stats.js` (dry-run→write) :
  lien `livescore→fotmob_id` par (date + équipes normalisées), écrit
  `home_xg/away_xg/corners/shots/possession` (+ `xg_ht` 1re MT), COALESCE idempotent.
- HT via **livescore** (`updateMatchResult`), gated `HT_FROM_LIVESCORE`.
- Colonnes `fotmob_id/shots/possession` (schema + PG), `archiveMerge` préserve tout à
  l'archive, cron `#15b` route vers FotMob si `FOTMOB_STATS_ENABLED=on`.
- Flags **off par défaut** (non-régression), suite **96/918**.
**Prochaine** : activer les 2 flags + relancer, laisser le cron/`backfill_fotmob_stats
--write` peupler, puis `train_corners/train_ht/O-U` en walk-forward → **ROI** (le juge).
