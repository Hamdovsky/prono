# PROJECT_PROGRESS — Pipeline de données pronos (data_pipeline)

Mise à jour : 2026-08-18

## Objectif
Construire et maintenir le `master_dataset.csv` (features Elo + xG/xA + cotes) utilisé
par le moteur de prédiction 1X2, avec des garde-fous qualité (watchdog `run_check`).

## Architecture
- `sources/` — récolte homogène via un registre (`SOURCE_BY_NAME`) :
  - `football_data` : Football-Data.co.uk (résultats + fixtures avec cotes 1X2/totaux/AH)
  - `clubelo` : ratings Elo (provenance `clubelo` | `cache` | `local`)
  - `fbref` : xG/xA via FBref, **repli Understat** (FBref = 403 Cloudflare permanent)
- `build/` — alignement des sources (TeamMapper) + features + stockage (CSV + SQLite)
- `scripts/` — orchestrateurs : `run_scheduled.py` (point d'entrée unique),
  `run_daily.py`, `run_fbref.py`, `run_check.py`, `predict_fixtures.py`, `predict_bases.py`
- Planification : tâche Windows `Pronos-DataPipeline` (07:00) / `cron_examples.md` (Linux)
- `data/state.json` — trace de provenance + complétude par source/ligue

## État des sources (dernier run 2026-08-18)
| Source | Provenance | Statut |
|---|---|---|
| Football-Data | football-data.co.uk | ✅ 5261 lignes |
| ClubElo | **local** | ⚠️ API injoignable → Elo local (ratings non officiels) |
| xG/xA | **understat** | ⚠️ FBref 403 → repli Understat |
| Cotes fixtures | football-data.co.uk | ✅ 2 affiches SP1 avec cotes (saison non démarrée) |

## Travaux récents
- Fixtures saison 26-27 via Sofascore (repli Understat) — `sources/fbref.py:fetch_schedule`
- `predict_fixtures.py --auto` : fusion des cotes réelles `football_data_fixtures.csv`
  (alignement TeamMapper) + détection de valeur ; cotes partielles gérées (NaN XGBoost)
- Alerting Telegram best-effort (`scripts/notify.py`) branché sur `run_scheduled.py`
  (Elo local, FBref 403, Football-Data vide)
- Complétude par ligue + cotes dans `data/state.json` (`completeness`)
- Node scraper : OpenLigaDB parallélisé + `fetchResults`, lock stale < 25 min,
  mojibake corrigé, mode scraper persistant

## Défauts / dette restants
- [ ] ClubElo API injoignable depuis ce réseau (403 racine / 443 bloqué) — retester, sinon
      documenter le repli local comme acceptable
- [ ] FBref toujours 403 — garder le repli Understat (coverage xG ~75 %, seuil watchdog)
- [ ] 205 fichiers `.ts` morts dans `services/`/`scripts/` (aucun importé par le JS) — purge
      dans un commit dédié
- [ ] `predict_fixtures.py --auto` : les cotes football-data ne couvrent encore que SP1
      (les autres ligues publient leurs fixtures plus tard)
- [ ] Pas d'alerte si la tâche Windows ne tourne pas (machine éteinte à 07:00) — surveiller
      `state.daily_last_run` dans `routes/scraper.js`

## Tests
- `pytest` (data_pipeline) : 103 verts
- `predict_fixtures.py --auto` : smoke OK (930 affiches prédites, value_* calculé sur cotes)