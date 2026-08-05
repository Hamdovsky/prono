# 📊 RAPPORT D'ANALYSE GÉNÉRALE — TITANIUM AI (STITCH)

**Projet**: Plateforme de prédiction football IA  
**ID Render**: `rnd_XXXX... (révoqué)`  
**Date**: 30 Juin 2026  
**Analyseur**: OpenCode AI Agent

---

## 🎯 RÉSUMÉ EXÉCUTIF

Titanium AI est une **plateforme de prédiction football sophistiquée** combinant machine learning (XGBoost), simulation Monte Carlo, et apprentissage adaptatif en temps réel. Le système présente une **architecture technique solide** mais souffre de **dette technique accumulée** et de **risques opérationnels** liés à son infrastructure Render Free (512 MB RAM).

### Verdict Global

- **Maturité technique**: ⭐⭐⭐⭐☆ (4/5) — Architecture ML avancée
- **Qualité du code**: ⭐⭐⭐☆☆ (3/5) — Fichiers massifs, couverture tests faible
- **Sécurité**: ⭐⭐⭐☆☆ (3/5) — Fichier .env présent, credentials AGENTS.md
- **Scalabilité**: ⭐⭐☆☆☆ (2/5) — SQLite en production, RAM limitée
- **Maintenabilité**: ⭐⭐☆☆☆ (2/5) — God objects, fichiers > 2000 lignes

---

## 📈 MÉTRIQUES CODEBASE

### Vue d'ensemble

| Métrique             | Valeur                                   | Statut                      |
| -------------------- | ---------------------------------------- | --------------------------- |
| **Total fichiers**   | 2,400+ fichiers                          | ⚠️ Très volumineux          |
| **Taille totale**    | 2.5 GB                                   | ⚠️ Incluant tools/ (111 MB) |
| **Langages**         | JavaScript (720), Python (207), JSX (89) | ✅ Cohérent                 |
| **Lignes de code**   | ~50,000 lignes (hors deps)               | ⚠️ Densité élevée           |
| **Couverture tests** | 10-15%                                   | 🔴 **CRITIQUE**             |

### Distribution par module

```
core/        : 95 fichiers, 1408 KB (moteur prédiction)
services/    : 118 fichiers, 938 KB (business logic)
routes/      : 13 fichiers, 147 KB (API REST)
src/         : 112 fichiers, 1729 KB (frontend React)
scripts/     : 55 fichiers, 528 KB (automation)
tests/       : 59 fichiers (23 Jest + 36 pytest)
tools/       : 397 fichiers, 111 MB (⚠️ Git/MinGit portable)
```

---

## 🏗️ ARCHITECTURE TECHNIQUE

### Stack

**Backend**

- Node.js 18+ / Express 5 / CommonJS
- SQLite (dev/prod) + PostgreSQL (migrations prêtes)
- Redis (ioredis) avec fallback in-memory
- Socket.IO pour temps réel

**Frontend**

- React 19 + Vite 7 + Tailwind CSS 3
- Socket.IO client (live updates)
- Framer Motion (animations)

**ML/AI**

- Python 3.10+ / FastAPI (port 8000)
- XGBoost 2.1 (17 modèles entraînés, 34 MB total)
- Optuna (hyperparameter tuning)
- Poisson/Dixon-Coles (simulation Monte Carlo)

### Pipeline prédiction

```
1. Match Entry → BSD/SportScore/SportSRC APIs
2. Feature Extraction (ml_features.py) → 115+ features
3. XGBoost Ensemble (3 modèles blendés 85/15)
4. Monte Carlo 10K simulations (goal_model.py)
5. Confluence Guard (triple validation)
6. Meta-Refiner (Bayesian shrinkage)
7. Adaptive Learning (post-match correction)
8. DeepSeek/Groq (tactical briefing)
```

---

## ✅ POINTS FORTS

### 1. Architecture ML sophistiquée

- **Ensemble XGBoost** : 3 modèles (V24, V55, V553) avec blend intelligent
- **Monte Carlo** : 10K simulations Poisson/Dixon-Coles pour BTTS, O/U 2.5
- **Adaptive Learning** : Correction automatique des biais par ligue
- **Confluence Guard** : Triple validation (XGBoost + Poisson + Market)
- **Neural Meta-Refiner** : Bayesian shrinkage contre overconfidence

### 2. Résilience opérationnelle

- **Fallback multi-source** : BSD → SportScore → SportSRC
- **Circuit breaker** : `autoHealRemedies.js` (patrouille 30min)
- **Redis fallback** : Bascule in-memory si Redis indisponible
- **Database adapter** : SQLite ↔ PostgreSQL transparent

### 3. Automation complète

- **Cron Manager** : 8 tâches planifiées (scraping, retrain, archivage)
- **AutoHeal Agent** : Détection et résolution automatique de pannes
- **Telegram Bot** : Notifications intelligentes + diffusion Mr. X
- **Retrain automatique** : XGBoost mensuel, modèle live hebdomadaire

### 4. Frontend moderne

- **React 19** avec code splitting Vite
- **WebSocket** : Live updates sans polling
- **Dashboard riche** : LiveLab, Evolution, Millionaire Selection
- **Responsive** : Tailwind CSS + Capacitor Android

### 5. Monitoring

- **Prometheus metrics** : `express-prom-bundle` + `prom-client`
- **Structured logging** : Winston avec rotation
- **Health checks** : `/api/health` pour Render
- **Performance audit** : Middleware latency tracking

---

## 🔴 PROBLÈMES CRITIQUES

### 1. God Objects (Violation SRP)

**Critique**: Fichiers massifs impossible à maintenir

| Fichier                | Lignes   | Statut                              |
| ---------------------- | -------- | ----------------------------------- |
| `prediction_engine.py` | **3099** | 🔴 URGENT : À splitter en 5 modules |
| `ml_features.py`       | **1591** | 🟡 Moyen : Refactor recommandé      |
| `database.js`          | **1254** | 🟡 Moyen : OK si stable             |
| `FPISEngine.js`        | **1212** | 🟡 Moyen : Splitter en 3 services   |
| `Promosport.jsx`       | **1566** | 🟡 Moyen : Composition pattern      |

**Action requise** : `prediction_engine.py` doit être découpé en :

- `feature_builder.py`
- `model_ensemble.py`
- `poisson_calculator.py`
- `validation_engine.py`
- `output_formatter.py`

### 2. Couverture tests catastrophique

**Critique**: 10-15% coverage inacceptable pour production ML

**Jest (Node.js)**

```javascript
coverageThreshold: {
  branches: 10%,    // 🔴 Minimum acceptable : 60%
  functions: 10%,   // 🔴 Minimum acceptable : 60%
  lines: 15%,       // 🔴 Minimum acceptable : 70%
  statements: 10%   // 🔴 Minimum acceptable : 60%
}
```

**Python (pytest)** : Aucun test trouvé pour `prediction_engine.py` (3099 lignes)

**Impact** :

- Bugs en production non détectés
- Refactoring dangereux sans filet de sécurité
- Regressions fréquentes sur adaptive learning

**Action requise** :

- Tests unitaires : `core/`, `services/`, `ml_features.py`
- Tests intégration : Pipeline complet `/predict`
- Tests E2E : Playwright sur Dashboard

### 3. Sécurité — Credentials exposés

**Critique**: Fichiers sensibles présents dans le repo

⚠️ **ALERTE SÉCURITÉ**

```
.env                    : Présent (140 bytes) — 🔴 À supprimer
AGENTS.md               : Credentials + API keys — 🔴 Dans .gitignore
ngrok.log               : Logs contenant URLs — 🟡 À nettoyer
ai_server_startup.log   : Logs contenant config — 🟡 À nettoyer
```

**Credentials trouvés dans AGENTS.md** :

- `API_SECRET_KEY` (nouvelle version)
- `RENDER_API_KEY` (2 comptes)
- `NEON_PASSWORD` (PostgreSQL)
- `UPSTASH_REDIS_TOKEN`

**Action requise IMMÉDIATE** :

1. `git rm --cached .env` + commit
2. Vérifier `.gitignore` inclut bien `.env`
3. Déplacer `AGENTS.md` vers coffre-fort (1Password, Vault)
4. Rotation manuelle des credentials si commit public

### 4. Infrastructure fragile

**Critique**: Plan Render Free inadapté à la charge ML

**Contraintes Render**

- **RAM** : 512 MB (XGBoost = 34 MB modèles + 100-200 MB runtime)
- **Disk** : Limité (SQLite `tactical.db` + `historical_archive.sqlite`)
- **CPU** : Partagé (throttling fréquent)

**Risques** :

- **OOM Kill** : Si Redis + XGBoost + Express simultanés
- **Cold Start** : 30-60s après inactivité (Render Free sleep)
- **SQLite Locks** : Write conflicts si traffic concurrent

**Métriques actuelles** :

```
tactical.db             : 0 MB (vide ou récent)
historical_archive.sqlite : 0 MB (vide ou récent)
models/ (17 fichiers)   : 34 MB
```

**Action requise** :

- Migrer vers **Render Starter** ($7/mois) : 512 MB → 2 GB RAM
- Ou optimiser : Lazy load des modèles XGBoost
- Monitoring : Alertes Telegram si RAM > 80%

### 5. Dette technique — Fichiers orphelins

**Critique**: Pollution du root directory

**Fichiers à nettoyer** :

```
$null                : 0.1 KB   — 🔴 Fichier vide invalide
0.6                  : 0 KB     — 🔴 Nom invalide
node                 : 0 KB     — 🔴 Symlink cassé ?
ngrok.log            : 0 KB     — 🟡 Logs à exclure
_create_script.ps1   : 1 KB     — 🟡 Script temporaire
```

**Dossiers volumineux inutiles** :

```
archive/         : 180 fichiers, 2.2 MB  — OK si historique
backups/         : 3 fichiers, 0 MB      — ✅ Minimal
tmp/             : 321 fichiers, 15.9 MB — 🔴 À nettoyer
dist_test/       : 3 fichiers, 0.6 MB    — 🟡 Build test obsolète
downloaded_files/: 1 fichier, 0 MB       — ✅ OK
tools/git/       : 397 fichiers, 111 MB  — 🔴 MinGit portable (à exclure)
```

**Action requise** :

```bash
# Supprimer fichiers invalides
Remove-Item "$null", "0.6", "node", "ngrok.log", "_create_script.ps1"

# Nettoyer tmp/
Remove-Item -Recurse tmp/*

# Exclure tools/ du repo (déjà dans .gitignore mais présent)
git rm -r --cached tools/git/
```

---

## 🟡 PROBLÈMES MOYENS

### 6. Incohérences documentation

**Impact** : Confusion développeurs, onboarding difficile

**Divergences détectées** :
| Doc | Réel | Statut |
|-----|------|--------|
| README : `--max-old-space-size=256` | `package.json : 512` | 🟡 Divergence |
| ARCHITECTURE : Puppeteer présent | `package.json` : Absent | ✅ OK (cohérent) |
| ARCHITECTURE : PM2/Prometheus | Repo : Non configuré | 🟡 Doc obsolète |
| README : "Généré le 10 Juin 2026" | Date future | 🟡 Typo |

**Action requise** :

- Synchroniser README + ARCHITECTURE.md avec code réel
- Documenter services actifs vs planifiés
- Supprimer références PM2/Grafana si non déployés

### 7. Dépendances Python fragmentées

**Impact** : Confusion installation, risque de drift

**Fichiers trouvés** :

```
requirements.txt         (30+ packages)
requirements-dev.txt     (non listé)
requirements-fastapi.txt (non listé)
requirements_cleaner.txt (non listé)
pyproject.toml          (présent mais incomplet ?)
```

**Action requise** :

- Consolider dans `pyproject.toml` unique avec extras :
  ```toml
  [project.optional-dependencies]
  dev = ["pytest", "black", "ruff"]
  fastapi = ["fastapi", "uvicorn[standard]"]
  ```

### 8. Dockerfiles multiples

**Impact** : Confusion sur image canonique

**Fichiers trouvés** :

```
Dockerfile              (FastAPI Python 3.11-slim)
Dockerfile.node         (Node.js)
Dockerfile.neural       (TensorFlow — non utilisé ?)
docker-compose.yml      (orchestration)
docker-compose.dev.yml  (dev)
```

**Action requise** :

- Un seul `Dockerfile` multi-stage :
  ```dockerfile
  FROM node:18-slim AS node-base
  FROM python:3.11-slim AS python-base
  FROM nginx:alpine AS frontend
  ```

### 9. Logs non rotatifs

**Impact** : Risque remplissage disk sur Render

**Configuration actuelle** :

- Winston sans `DailyRotateFile`
- Logs Python : `print()` au lieu de `logging`
- `ngrok.log`, `ai_server_startup.log` à la racine

**Action requise** :

```javascript
// Winston config
const dailyRotateFileTransport = new DailyRotateFile({
  filename: 'logs/app-%DATE%.log',
  datePattern: 'YYYY-MM-DD',
  maxSize: '20m',
  maxFiles: '7d',
})
```

### 10. React optimizations manquantes

**Impact** : Re-renders inutiles, UI lag

**Problèmes détectés** :

- `MatchRow.jsx` (772 lignes) : Pas de `React.memo`
- `Promosport.jsx` (1566 lignes) : State drilling excessif
- WebSocket updates : Trigger re-render global

**Action requise** :

```jsx
// Avant
function MatchRow({ match, odds }) { ... }

// Après
const MatchRow = React.memo(({ match, odds }) => { ... },
  (prev, next) => prev.match.id === next.match.id &&
                  prev.odds.home === next.odds.home
);
```

---

## 🔍 ANALYSE DÉTAILLÉE PAR MODULE

### Core (Python ML)

**Fichiers critiques** :

- `prediction_engine.py` (3099 lignes) — 🔴 God object
- `ml_features.py` (1591 lignes) — 🟡 Dense mais OK
- `train_v55.py` (887 lignes) — ✅ Bonne structure
- `goal_model.py` (754 lignes) — ✅ Cohérent

**Points forts** :

- Lazy loading XGBoost (évite crash si absent)
- Feature caching (`@lru_cache`)
- Optuna hyperparameter tuning
- Monte Carlo 10K simulations

**Points faibles** :

- Pas de type hints Python
- Global variables (`_XGB_MODEL`, `_DB_CONN`) non thread-safe
- `print()` au lieu de `logging.info()`
- Aucun test unitaire

### Services (Node.js Business Logic)

**Fichiers volumineux** :

- `FPISEngine.js` (1212 lignes, 66 KB)
- `botService.js` (1152 lignes, 63 KB)
- `adaptiveLearningEngine.js` (1083 lignes, 56 KB)

**Points forts** :

- Circuit breaker pattern (`autoHealRemedies.js`)
- Rate limiting (Bottleneck.js)
- Redis cache avec TTL dynamique
- Scraper rotation multi-source

**Points faibles** :

- `FPISEngine.js` : God object
- Pas de retry exponential backoff
- Imports circulaires potentiels
- Logging non structuré (mix `console.log` + `logger`)

### Routes (API REST)

**Endpoints** : 13 fichiers, ~50 routes

**Sécurité** :

- ✅ Helmet.js activé
- ✅ CORS configuré
- ✅ Rate limiting (100 req/15min)
- ✅ JWT auth (`authService.js`)

**Manques** :

- ❌ Pas de Swagger/OpenAPI documentation
- ❌ Timeout non configuré sur `/predict`
- ❌ Pas de CSRF tokens

### Frontend (React)

**Composants** : 45 JSX, ~12K lignes

**Points forts** :

- Code splitting Vite
- Lazy loading routes
- WebSocket reconnection automatique

**Points faibles** :

- `Promosport.jsx` : 1566 lignes, splitter
- Pas de React.memo sur composants lourds
- State management non standardisé (mix useState + props drilling)
- Pas d'error boundary sauf global

### Scripts (Automation)

**Critiques** : 47 fichiers, 232 KB

**Cron jobs actifs** :

```javascript
'0 6 * * *'     → daily_predictions.py (06:00 UTC)
'*/15 * * * *'  → live_value_alerts.js (toutes les 15min)
'0 2 * * *'     → auto_backup_db.js (02:00 UTC)
```

**Points forts** :

- Lock files (évite overlapping)
- Notifications Telegram sur erreur
- Retry logic

**Points faibles** :

- `surgical_elite_50.js` : 541 lignes, splitter
- Pas de monitoring centralisé (dead letter queue)
- Logs non rotatifs

---

## 🚀 RECOMMANDATIONS PRIORITAIRES

### 🔴 URGENT (< 1 semaine)

#### 1. Sécurité — Supprimer credentials

```bash
# Retirer .env du repo
git rm --cached .env
git commit -m "chore: remove .env from repo"

# Déplacer AGENTS.md vers coffre-fort
# Rotation des credentials si commits publics
```

#### 2. Nettoyer root directory

```bash
Remove-Item "$null", "0.6", "node", "ngrok.log", "_create_script.ps1"
Remove-Item -Recurse tmp/*
git rm -r --cached tools/git/
```

#### 3. Splitter `prediction_engine.py`

```python
# Créer 5 nouveaux fichiers
core/feature_builder.py       (extraction features)
core/model_ensemble.py        (XGBoost blend)
core/poisson_calculator.py    (Monte Carlo)
core/validation_engine.py     (Confluence Guard)
core/output_formatter.py      (JSON response)

# Garder prediction_engine.py comme orchestrateur léger (< 300 lignes)
```

#### 4. Augmenter couverture tests à 60%

```javascript
// jest.config.js
coverageThreshold: {
  global: {
    branches: 60,
    functions: 60,
    lines: 70,
    statements: 60
  }
}
```

Focus tests sur :

- `core/database.js`
- `services/adaptiveLearningEngine.js`
- `core/ml_features.py`
- `core/goal_model.py`

### 🟡 COURT TERME (2-4 semaines)

#### 5. Migration infrastructure

**Option A** : Render Starter ($7/mois)

- RAM : 512 MB → 2 GB
- Pas de sleep
- Disk : 10 GB

**Option B** : Optimisation actuelle

```javascript
// Lazy load XGBoost
let _models = null
function loadModels() {
  if (!_models) {
    _models = {
      v55: loadModel('stitch_v55_optimized.json'),
      // Charger les autres à la demande
    }
  }
  return _models
}
```

#### 6. Monitoring Prometheus

```javascript
// Activer métriques
const promBundle = require('express-prom-bundle')
app.use(
  promBundle({
    includeMethod: true,
    includePath: true,
    customLabels: { app: 'titanium' },
  })
)

// Endpoint /metrics pour Grafana
```

#### 7. Documentation API Swagger

```javascript
// swagger.js
const swaggerJsdoc = require('swagger-jsdoc')
const swaggerUi = require('swagger-ui-express')

const specs = swaggerJsdoc({
  definition: {
    openapi: '3.0.0',
    info: { title: 'Titanium API', version: '3.0' },
  },
  apis: ['./routes/*.js'],
})

app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(specs))
```

#### 8. Python type hints

```python
# Avant
def extract_ml_features(match, db):
    ...

# Après
from typing import Dict, Any, Optional
import sqlite3

def extract_ml_features(
    match: Dict[str, Any],
    db: sqlite3.Connection
) -> Dict[str, float]:
    """Extract 115+ ML features from match data.

    Args:
        match: Match dictionary with teams, league, date
        db: SQLite connection to historical data

    Returns:
        Dictionary of feature name → float value
    """
    ...
```

### 🟢 LONG TERME (1-3 mois)

#### 9. Migration PostgreSQL complète

```javascript
// Déjà préparé : core/pg_database.js, core/pg_migrations.js
// Action : Activer en production

// .env
DATABASE_URL=postgresql://user:pass@neon/db

// server.js
const db = process.env.NODE_ENV === 'production'
  ? require('./core/pg_database')
  : require('./core/database');
```

#### 10. Kubernetes (si scale requis)

```yaml
# k8s/deployment.yaml
apiVersion: apps/v1
kind: Deployment
metadata:
  name: titanium-api
spec:
  replicas: 3
  template:
    spec:
      containers:
        - name: node
          image: titanium-node:latest
          resources:
            requests:
              memory: '512Mi'
              cpu: '500m'
```

---

## 📊 MÉTRIQUES DE SUCCÈS

### Objectifs 30 jours

- [ ] Couverture tests : 15% → 60%
- [ ] `prediction_engine.py` : 3099 → 5 fichiers < 500 lignes
- [ ] Credentials : Supprimés du repo
- [ ] Root directory : Nettoyé (5 fichiers supprimés)
- [ ] RAM Render : < 80% usage moyen

### Objectifs 90 jours

- [ ] Migration PostgreSQL production
- [ ] Swagger documentation complète
- [ ] Monitoring Prometheus + Grafana
- [ ] Tests E2E Playwright (5 scénarios critiques)
- [ ] Python type hints : 100% core/

### KPIs techniques

| Métrique               | Actuel | Cible   |
| ---------------------- | ------ | ------- |
| Test coverage          | 15%    | 70%     |
| Fichiers > 1000 lignes | 5      | 0       |
| Cold start (Render)    | 30-60s | < 10s   |
| API latency p95        | ?      | < 500ms |
| Uptime                 | ?      | > 99.5% |

---

## 💡 ARCHITECTURE FUTURE RECOMMANDÉE

### Phase 1 : Stabilisation (3 mois)

```
[Frontend React]
     ↓ REST + WebSocket
[Express API] → [Redis Cache] → [PostgreSQL]
     ↓ HTTP
[FastAPI Python] → [XGBoost + Poisson]
```

### Phase 2 : Scale (6-12 mois)

```
[CloudFlare CDN]
     ↓
[Load Balancer]
     ↓
[3× Node.js] → [Redis Cluster] → [Postgres Primary + 2 Replicas]
     ↓
[Queue (RabbitMQ)]
     ↓
[3× Python Workers] → [S3 Model Storage]
```

### Phase 3 : ML Platform (12+ mois)

```
[MLflow Model Registry]
     ↓
[A/B Testing Framework]
     ↓
[Auto-retrain Pipeline]
     ↓
[Champion vs Challenger]
```

---

## 🎯 CONCLUSION

### Points clés

1. ✅ **Architecture ML solide** — Ensemble XGBoost + Poisson + Adaptive Learning
2. ⚠️ **Qualité code moyenne** — God objects, couverture tests 15%
3. 🔴 **Sécurité à renforcer** — Credentials dans repo
4. ⚠️ **Infrastructure fragile** — Render Free 512 MB RAM
5. ✅ **Automation complète** — Cron, AutoHeal, Telegram bot

### Recommandation stratégique

**Court terme** : Focus sur la **dette technique** et **sécurité** (4 semaines)

1. Supprimer credentials
2. Splitter `prediction_engine.py`
3. Tests unitaires 60%
4. Monitoring Prometheus

**Moyen terme** : **Scalabilité** et **documentation** (3 mois)

1. Migration Render Starter ou optimisation RAM
2. PostgreSQL production
3. Swagger API docs
4. Python type hints

**Long terme** : **Plateforme ML** et **scale** (12 mois)

1. Kubernetes
2. MLflow registry
3. A/B testing
4. Multi-région

### Risque majeur

Le système fonctionne **aujourd'hui** mais n'est **pas prêt pour scale**. Un doublement du traffic causerait des OOM kills sur Render Free. Priorité : **stabiliser avant d'ajouter features**.

---

**FIN DU RAPPORT**

_Généré par OpenCode AI Agent — 30 Juin 2026_  
_Pour questions : Voir `ARCHITECTURE.md` et `AGENTS.md`_
