# Pipeline de données pronos

Pipeline Python (data_pipeline/) qui collecte, unifie et prépare les données
d'entraînement du modèle de prédiction 1X2 à partir de 3 sources.

## Sources

| Source                         | Données                                                                                                                                       | Fréquence                                              |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Football-Data.co.uk            | Résultats, cotes (B365/Pinnacle/Avg/Max), cotes **fermées** (close), totaux >2.5, handicap asiatique, stats de match (tirs, corners, cartons) | Quotidien (matin), CSV direct, pas de rate limit       |
| Football-Data.co.uk — fixtures | Cotes réelles des matchs à venir (1X2 + >2.5 + AH), **source prioritaire pour le quotidien**                                                  | Quotidien (matin), `fixtures.csv`                      |
| ClubElo                        | Rating Elo pré-match par équipe (lookup as-of)                                                                                                | Quotidien (matin), API api.clubelo.com                 |
| Stats avancées (xG/xA)         | xG/xA par match + forme attaque/défense L5/L10                                                                                                | Tous les 3 jours, `RateLimiter(3.5s)` (~15-20 req/min) |

> Le fournisseur des stats avancées est **FBref** (via `soccerdata`), qui sert
> à nouveau xG/xA dans son HTML public (fonctionnel). En cas d'échec complet,
> le pipeline retombe sur le cache local ou sur le **repli Understat**. Le
> débit est plafonné à ~15-20 requêtes/minute (`FBREF_INTERVAL_SECONDS`) pour
> éviter tout blocage.

> **ClubElo — résilience & provenance.** La détection de disponibilité de l'API
> est un vrai probe HTTP (5 s) : si l'API ne répond pas, le pipeline bascule
> sans attente sur le cache local, puis sur un Elo calculé localement (K=20,
> avantage domicile +100, init 1500). L'origine est tracée :
>
> - colonne `elo_source` du master (`clubelo` / `cache` / `local`) ;
> - `elo_source` dans `data/state.json` (dernier build) ;
> - fichier `data/raw/clubelo/elo_source.txt` (provenance du cache courant).
>   Les valeurs `local` sont auto-cohérentes et sans fuite temporelle, mais ne
>   sont PAS les ratings officiels ClubElo (ex. Man City ~1707 au lieu de ~2050).

## Commandes

```bash
.venv\Scripts\python.exe scripts\run_scheduled.py         # quotidien + xG/xA si dû (3 j) + sauvegarde
.venv\Scripts\python.exe scripts\run_scheduled.py --bases # + boutiques (paris) quotidiennes
.venv\Scripts\python.exe scripts\run_scheduled.py --no-backup  # sans sauvegarde data/
.venv\Scripts\python.exe scripts\backup_data.py           # sauvegarde seule (rétention 7 j)
.venv\Scripts\python.exe scripts\markets.py --all         # probabilités 1X2/O/U2.5/AH/OC/Corners (val + backtest)
.venv\Scripts\python.exe scripts\predict_bases.py --auto  # boutiques à valeur positive (1X2/O/U2.5/Corners)
.venv\Scripts\python.exe scripts\predict_fixtures.py --date 2026-08-15  # prédictions d'une journée de fixtures
.venv\Scripts\python.exe -m pytest                        # tests (82)
.venv\Scripts\python.exe pipeline.py --task check         # rapport qualité (couverture + provenance)
.venv\Scripts\python.exe pipeline.py --task run_check     # rapport + code de sortie ≠ 0 si qualité insuffisante
```

## Sorties (dans `data/`)

- `raw/football_data_all.csv` — résultats/cotes/stats bruts consolidés (résultats + cotes ouvertures/fermées, totaux, AH)
- `raw/football_data_fixtures.csv` — cotes réelles des matchs à venir (Top-5)
- `raw/advanced_stats.csv` — xG/xA par match
- `raw/clubelo/elo_history.csv` — historique Elo **officiel** (API ClubElo)
- `raw/clubelo/elo_history_local.csv` — Elo recalculé localement (repli si API down)
- `processed/master_dataset.csv` — master (featured, 143 colonnes)
- `processed/master.db` — SQLite, table `master_matches` (schéma : `schema.sql`)
- `predictions/markets_*.csv` — probabilités des marchés (via `markets.py`)
- `predictions/bases_*.csv` — boutiques à valeur positive (via `--bases`/`predict_bases.py`)
- `state.json` — horodatage des dernières exécutions

## Sauvegarde des données

`scripts/backup_data.py` copie `data/raw/`, `data/processed/` et `state.json`
vers `backups/data_pipeline/YYYYMMDD/` (à la racine du projet, au-dessus du
pipeline) avant toute mise à jour. Rétention de 7 jours (`--keep`), reprise
idempotente (un dossier par jour), option `--include-cache` pour inclure le
cache `soccerdata` (reconstruit par une re-sélection mais plus lent).
Activée par défaut dans `run_scheduled.py` (`--no-backup` pour la désactiver).

## Fusion & mapping

`build/align.py` fusionne sur (date, home_team, away_team) après passage par
`team_mapping.py` (dictionnaire éditable `data/team_aliases.json` + repli flou
difflib). L'Elo est rattaché en **as-of** (rating juste avant le coup d'envoi,
aucune fuite). `build/features.py` calcule les moyennes roulantes L5/L10
strictement antérieures au match (`shift(1)`).

**Cotes fermées.** Les colonnes `odds_*_close_*` (cotes au coup d'envoi) sont
plus informatives que les cotes d'ouverture. `build/features.py` en dérive des
probabilités normalisées (`P1_close_avg`, `PX_close_avg`, `P2_close_avg`) et des
signaux de mouvement de marché (`F_OddsH_Close_Diff`, `F_O25_Close_Diff`,
`F_AH_Close_Diff`). Couverture ~100 % sur les Top-5 (3 saisons).

## Cotes pour les prédictions du jour

`run_daily.py` télécharge aussi `fixtures.csv` (matchs à venir des Top-5 avec
cotes réelles). `services/oddsFusionEngine.py` consulte ce fichier en **Tier 0**
(prioritaire) via `_tier0_football_data` : il fournit 1X2 + Over/Under 2.5
(dérivé) sans aucun appel réseau. Les matchs hors Top-5 ou hors fixtures
retombent sur la chaîne existante (BSD → BetExplorer → historique → défaut).

## Pont Postgres (production)

`build/pg_export.py` backfille la table `matches` de prod (cotes réelles,
xG, forme) via `DATABASE_URL` (psycopg2). Écriture conservatrice (`COALESCE`) :
ne remplace jamais une donnée déjà présente ; pose `insufficient_data=0` quand
de vraies cotes sont écrites. Activé par `--pg` (désactivé si `DATABASE_URL`
absent). Test de correspondance sans écrire : `--pg-dry-run`.

## Planification

- **Linux/Render** : voir `cron_examples.md` (quotidien 07:00 + fbref 1,4,7,...).
- **Windows** : `powershell -ExecutionPolicy Bypass -File scripts\setup_pipeline_tasks.ps1`
  inscrit la tâche `Pronos-DataPipeline` (quotidien 07:00 ; xG/xA déclenchés
  automatiquement quand dus).
