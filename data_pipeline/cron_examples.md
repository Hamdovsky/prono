# Planification (cron) — Pipeline de données pronos

Le pipeline est composé de **2 tâches**, à planifier comme suit :

| Tâche            | Fréquence              | Commande                                        |
|------------------|------------------------|-------------------------------------------------|
| `run_daily.py`   | **Chaque matin**       | Football-Data + ClubElo → rebuild `master`      |
| `run_fbref.py`   | **Tous les 3 jours**   | Stats avancées (xG/xA) → rebuild `master`       |

Exécution depuis le répertoire du pipeline :

```bash
cd /chemin/vers/prono/data_pipeline
.venv/bin/python run_daily.py        # quotidien
.venv/bin/python run_fbref.py        # tous les 3 jours
```

Sorties (dans `data/`) :
- `processed/master_dataset.csv` — master complet (CSV)
- `processed/master.db` — master complet (SQLite, table `master_matches`)
- `state.json` — horodatage des dernières exécutions

---

## Linux / Render (cron)

```cron
# Chaque matin à 07:00 (timezone du serveur)
0 7 * * *  cd /chemin/vers/prono/data_pipeline && .venv/bin/python run_daily.py >> /var/log/prono_pipeline.log 2>&1

# Tous les 3 jours (ex. : 1er, 4, 7, ... de chaque mois à 07:30)
30 7 1,4,7,10,13,16,19,22,25,28 * *  cd /chemin/vers/prono/data_pipeline && .venv/bin/python run_fbref.py >> /var/log/prono_pipeline.log 2>&1
```

> La crontab standard ne gère pas « tous les N jours » nativement : la liste
> `1,4,7,...,28` approche correctement un intervalle de 3 jours.

## Windows (Planificateur de tâches)

1. **Ouvrir le Planificateur de tâches** → « Créer une tâche ».
2. Onglet **Général** : nom = `Pronos - Pipeline quotidien`, cocher
   « Exécuter avec les autorisations maximales ».
3. Onglet **Déclencheurs** : « Chaque jour » à 07:00.
4. Onglet **Actions** :
   - Programme : `C:\Users\HAMDI\prono\data_pipeline\.venv\Scripts\python.exe`
   - Arguments : `run_daily.py`
   - Démarrer dans : `C:\Users\HAMDI\prono\data_pipeline`
5. Répéter pour `Pronos - Stats avancées` avec le programme `run_fbref.py`,
   déclencheur « Tous les 3 jours ».

## Note sur le taux de requêtes (FBref / stats avancées)

Les appels réseau vers le fournisseur de stats avancées sont espacés de
`3,5 s` (`FBREF_INTERVAL_SECONDS` dans `config.py`), soit ~15-20 requêtes/min,
pour éviter tout blocage. Football-Data et ClubElo utilisent des CSV/API
directs sans contrainte particulière.
