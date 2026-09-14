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
