# Planification — Pipeline de données pronos

Un **point d'entrée unique** (`run_scheduled.py`) déclenche les étapes dues
selon `state.json` :

| Étape                   | Cadence           | Déclencheur                        |
| ----------------------- | ----------------- | ---------------------------------- |
| Sauvegarde              | chaque exécution  | toujours (avant toute mise à jour) |
| Football-Data + ClubElo | quotidien         | `--daily` / par défaut             |
| Stats avancées (xG/xA)  | 3 jours           | `--fbref` (automatiquement si dû)  |
| Rebuild `master`        | après mise à jour | automatique                        |
| Boutiques (paris)       | quotidien         | `--bases`                          |

Exécution depuis le répertoire du pipeline (`C:\Users\HAMDI\Desktop\HamdiProno\stitch\data_pipeline`) :

```bash
.venv\Scripts\python.exe scripts\run_scheduled.py            # quotidien
.venv\Scripts\python.exe scripts\run_scheduled.py --bases   # + boutiques
.venv\Scripts\python.exe scripts\run_scheduled.py --no-backup   # sans sauvegarde
```

Sorties (dans `data/`) :

- `processed/master_dataset.csv` — master complet (CSV)
- `processed/master.db` — master complet (SQLite, table `master_matches`)
- `state.json` — horodatage des dernières exécutions
- `predictions/markets_*.csv` — probabilités des marchés (avec `--bases`)
- `predictions/bases_*.csv` — boutiques à valeur positive (avec `--bases`)

Sauvegardes (dans `backups/data_pipeline/YYYYMMDD/`) : copie de `data/raw/`,
`data/processed/` et `state.json` avant chaque mise à jour ; rétention de
7 jours (`--keep` dans `scripts/backup_data.py`).

---

## Linux / Render (cron)

```cron
# Chaque matin à 07:00 (timezone du serveur)
0 7 * * *  cd /chemin/vers/prono/data_pipeline && .venv/bin/python scripts/run_scheduled.py --bases >> /var/log/prono_pipeline.log 2>&1
```

> La crontab standard ne gère pas « tous les N jours » nativement :
> `run_scheduled.py --fbref` vérifie l'horodatage dans `state.json` et
> n'exécute la mise à jour que si elle est due (3 jours), le reste est géré
> automatiquement par le point d'entrée unique.

## Windows (Planificateur de tâches)

1. **Ouvrir le Planificateur de tâches** → « Créer une tâche ».
2. Onglet **Général** : nom = `Pronos-DataPipeline`, cocher
   « Exécuter avec les autorisations maximales ».
3. Onglet **Déclencheurs** : « Chaque jour » à 07:00.
4. Onglet **Actions** :
   - Programme : `C:\Users\HAMDI\Desktop\HamdiProno\stitch\data_pipeline\.venv\Scripts\python.exe`
   - Arguments : `scripts\run_scheduled.py --bases`
   - Démarrer dans : `C:\Users\HAMDI\Desktop\HamdiProno\stitch\data_pipeline`
5. Rien de plus : les étapes dues (Football-Data, ClubElo, xG/xA, backup)
   sont déclenchées automatiquement.

Le script `scripts\setup_pipeline_tasks.ps1` crée cette tâche en une commande :
`powershell -ExecutionPolicy Bypass -File scripts\setup_pipeline_tasks.ps1`.

## Note sur le taux de requêtes (FBref / stats avancées)

Les appels réseau vers le fournisseur de stats avancées sont espacés de
`3,5 s` (`FBREF_INTERVAL_SECONDS` dans `config.py`), soit ~15-20 requêtes/min,
pour éviter tout blocage. Football-Data et ClubElo utilisent des CSV/API
directs sans contrainte particulière.
