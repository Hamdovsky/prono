# Changelog

## [Unreleased]

### Added
- Validation des requêtes API avec Zod (schemas pour seed-match, elo/update, scrape/trigger)
- Documentation Swagger complète pour FastAPI avec descriptions, tags et exemples
- Tests Python pytest pour les modules ML (prediction_engine, goal_model, calibration, ml_features)
- Fichier `.env.example` complet avec documentation de toutes les variables
- CHANGELOG.md pour le suivi des versions

### Changed
- `.gitignore` étendu avec plus de patterns pour fichiers de données générés
- Le endpoint `/api/seed-match` utilise maintenant `req.validatedBody` après validation Zod
- Le endpoint `/api/elo/update` utilise maintenant `req.validatedBody` après validation Zod
- Le endpoint `/api/scrape/trigger` utilise maintenant `req.validatedBody` après validation Zod
- FastAPI endpoints documentés avec summary, description, et tags OpenAPI

### Removed
- Fichiers dump inutiles de `SofascoreScraping/` (clean_keys.json, stats_html_dump.json, etc.)
- Fichiers de données obsolètes dans `data/` (fichiers .disabled, dumps JSON, logs)
- Répertoires `data/raw/`, `data/soccerdata_cache/`, `data/training_reports/`, `data/neural_data/`
- Répertoire `scripts/data/`

### Security
- `.env.example` mis à jour avec instructions claires pour changer `API_SECRET_KEY`
- Ajout de validation de schéma pour les endpoints critiques
- Dépendance `zod` ajoutée pour la validation côté serveur

## [1.0.0] - 2026-06-10

### Initial Release
- Système de prédiction football Titanium AI
- Moteur XGBoost avec 115+ features
- Pipeline Monte Carlo (1000 itérations)
- Adaptive Learning Engine
- Evolution Layer avec 19 taxonomies
- Frontend React avec Dashboard, LiveLab, Evolution
- Bot Telegram
- AutoHeal Agent
- Déploiement Render
