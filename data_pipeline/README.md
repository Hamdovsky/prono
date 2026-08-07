# Pipeline de données pronos

Pipeline Python (data_pipeline/) qui collecte, unifie et prépare les données
d'entraînement du modèle de prédiction 1X2 à partir de 3 sources.

## Sources

| Source                | Données                                           | Fréquence       |
|-----------------------|---------------------------------------------------|-----------------|
| Football-Data.co.uk   | Résultats, cotes (B365/Pinnacle/Avg/Max), stats de match (tirs, corners, cartons) | Quotidien (matin), CSV direct, pas de rate limit |
| ClubElo               | Rating Elo pré-match par équipe (lookup as-of)    | Quotidien (matin), API api.clubelo.com |
| Stats avancées (xG/xA)| xG/xA par match + forme attaque/défense L5/L10     | Tous les 3 jours, `RateLimiter(3.5s)` (~15-20 req/min) |

> Le fournisseur des stats avancées est **Understat** (via `soccerdata`) :
> FBref ne sert plus xG/xA dans son HTML public. Le débit est plafonné à ~15-20
> requêtes/minute pour éviter tout blocage.

> **ClubElo — résilience & provenance.** La détection de disponibilité de l'API
> est un vrai probe HTTP (5 s) : si l'API ne répond pas, le pipeline bascule
> sans attente sur le cache local, puis sur un Elo calculé localement (K=20,
> avantage domicile +100, init 1500). L'origine est tracée :
> - colonne `elo_source` du master (`clubelo` / `cache` / `local`) ;
> - `elo_source` dans `data/state.json` (dernier build) ;
> - fichier `data/raw/clubelo/elo_source.txt` (provenance du cache courant).
> Les valeurs `local` sont auto-cohérentes et sans fuite temporelle, mais ne
> sont PAS les ratings officiels ClubElo (ex. Man City ~1707 au lieu de ~2050).

## Commandes

```bash
.venv/bin/python run_daily.py            # Football-Data + ClubElo → master
.venv/bin/python run_fbref.py            # stats avancées (xG/xA) → master
.venv/bin/python run_scheduled.py        # quotidien + xG/xA si dû (3 j)
.venv/bin/python run_scheduled.py --pg   # + backfill Postgres prod
.venv/bin/python -m pytest               # tests
.venv/bin/python pipeline.py --task check  # rapport qualité (couverture + provenance)
```

## Sorties (dans `data/`)

- `raw/football_data_all.csv` — résultats/cotes/stats bruts consolidés
- `raw/advanced_stats.csv` — xG/xA par match
- `raw/clubelo/elo_history.csv` — historique Elo
- `processed/master_dataset.csv` — master (featured)
- `processed/master.db` — SQLite, table `master_matches` (schéma : `schema.sql`)

## Fusion & mapping

`build/align.py` fusionne sur (date, home_team, away_team) après passage par
`team_mapping.py` (dictionnaire éditable `data/team_aliases.json` + repli flou
difflib). L'Elo est rattaché en **as-of** (rating juste avant le coup d'envoi,
aucune fuite). `build/features.py` calcule les moyennes roulantes L5/L10
strictement antérieures au match (`shift(1)`).

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
