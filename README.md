# Titanium AI - Stitch System

**Advanced AI-Powered Football Prediction Platform**

Système de prédiction football de nouvelle génération combinant XGBoost, Monte Carlo, réseaux bayésiens et apprentissage adaptatif. Déployé sur Render avec pipeline d'inférence temps réel.

---

## 📋 Table des matières

- [Architecture](#-architecture)
- [Features](#-features)
- [Stack Technique](#-stack-technique)
- [Sources de Données](#-sources-de-données)
- [Pipeline de Prédiction](#-pipeline-de-prédiction)
- [Modules Système](#-modules-système)
- [APIs & Routes](#-apis--routes)
- [Déploiement Render](#-déploiement-render)
- [Variables d'Environnement](#-variables-denvironnement)
- [Maintenance](#-maintenance)

---

## 🏗 Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Frontend React                     │
│  Dashboard │ LiveLab │ Evolution │ Admin │ Settings  │
└──────────────────────┬──────────────────────────────┘
                       │ Socket.IO / REST
┌──────────────────────▼──────────────────────────────┐
│              Express 5 API Server                    │
│  routes/  ->  services/  ->  core/                     │
│  Socket.IO broadcast  │  Cron jobs  │  AutoHeal      │
└──────────────────────┬──────────────────────────────┘
                       │ HTTP / Child Process
┌──────────────────────▼──────────────────────────────┐
│               FastAPI Inference (Python)              │
│  /predict  │  /predict-live  │  /health              │
│  XGBoost  │  Monte Carlo  │  Meta-Refiner            │
└──────────────────────┬──────────────────────────────┘
                       │
┌──────────────────────▼──────────────────────────────┐
│              Data Layer                              │
│  SQLite tactical.db  │  historical_archive.sqlite    │
│  Redis (Render KV)   │  Team/Player Registry         │
└─────────────────────────────────────────────────────┘
```

---

## ✨ Features

### 🔮 Prédictions
- **Prédiction 1X2** avec XGBoost entraîné sur 5000+ matchs historiques
- **Under/Over 2.5** & **BTTS** via Poisson + Monte Carlo
- **Marchés dynamiques** (HT O0.5, HT O1.5, HT BTTS, Double Chance)
- **Score exact attendu** via simulation 1000x
- **Blend externe** : PredixSport (20%) pour top-5 ligues
- **Confluence Guard** : triple validation XGBoost + Poisson + Market

### 🔴 Live
- **Matchs en direct** multi-source (BSD -> SportScore -> SportSRC)
- **Prédiction de buts live** (modèle XGBoost AUC 0.88-0.92)
- **Logging des prédictions** pour amélioration continue
- **Fallback** matchs à venir quand aucun live

### 🧠 Apprentissage Automatique
- **Adaptive Learning Engine** : autopsie des erreurs, correction des poids par ligue
- **Evolution Layer** : base de connaissance des échecs (19 taxonomies)
- **Apprentissage adversaire** : champion vs challenger, auto-promotion
- **Confidence Calibration** : ajustement bayésien par tier de cotes
- **Retrain automatique** mensuel (XGBoost) + hebdomadaire (live)

### 📊 Dashboard
- **Matchs du jour** avec prédictions enrichies
- **LiveLab** : analyse temps réel des matchs en direct
- **Evolution Dashboard** : visualisation des patterns d'échecs
- **Millionaire Selection** : paris à haute valeur
- **System Intelligence** : métriques globales

### 🤖 Automatisation
- **AutoHeal Agent** : patrouille toutes les 30min, détection/résolution automatique
- **AutoArchiver** : archivage des matchs terminés
- **Cron Manager** : tâches planifiées (analyse, scraping, retrain)
- **Bot Telegram** : alertes, rapports quotidiens, diffusion Mr. X

---

## 🛠 Stack Technique

### Backend (Node.js)
| Technologie | Version | Utilisation |
|------------|---------|-------------|
| Node.js | 18+ | Runtime |
| Express | 5 | API REST |
| Socket.IO | 4 | Temps réel |
| better-sqlite3 | - | Base SQLite |
| ioredis | - | Cache Redis |
| node-cron | - | Planification |
| axios | - | HTTP client |

### Frontend (React)
| Technologie | Version | Utilisation |
|------------|---------|-------------|
| React | 19 | UI |
| Vite | 7 | Build |
| Tailwind CSS | 3 | Styles |
| Socket.IO Client | - | Temps réel |

### ML/AI (Python)
| Technologie | Version | Utilisation |
|------------|---------|-------------|
| FastAPI | - | Serveur d'inférence |
| XGBoost | 2.1 | Modèle principal |
| scikit-learn | - | Feature engineering |
| numpy | - | Calculs matriciels |
| Optuna | - | Hyperparameter tuning |

---

## 📡 Sources de Données

| Source | API | Limite | Coût | Données |
|--------|-----|--------|------|---------|
| **BSD** | REST | Illimité | Gratuit | Fixtures, odds, stats, prédictions |
| **SportScore** | REST | 10k req/j | Gratuit | Live scores, matchs à venir |
| **SportSRC** | REST | 1k req/j | Gratuit | Live scores, streams |
| **PredixSport** | REST | 200/mois | Gratuit | Prédictions top-5 ligues |
| **Big Balls Data** | REST | 1000/j | Gratuit | xG, stats, lineups |
| **API-Football** | REST | 100/j | Gratuit | Fixtures, H2H, odds |
| **Odds-API.io** | REST | 100/h | Gratuit | Odds backup |
| **OpenWeatherMap** | REST | 60/min | Gratuit | Météo |

---

## 🔧 Pipeline de Prédiction

```
Match Entry
    │
    ▼
Classification ligue (T1/T2/T3/BLACKLIST)
    │
    ▼
Extraction features (115+ features)
    │
    ├── Imputation données manquantes
    │
    ▼
Calcul xG (précomputed -> moyennes -> advanced weighted)
    │
    ▼
Modificateurs tactiques (style, Time Machine, blessures, fatigue, marché, arbitre)
    │
    ▼
Monte Carlo Simulation (Poisson xG, 1000 itérations)
    │
    ▼
XGBoost (tiered Gaussian noise, 1000-1500 DMatrix)
    │
    ▼
Ensemble V2+V4 (85/15 blend)
    │
    ▼
PredixSport blend (20% top-5 ligues)
    │
    ▼
Neural Meta-Refiner (Bayesian shrinkage)
    │
    ▼
Confluence Guard (triple validation)
    │
    ▼
Gap Learning (correction par ligue)
    │
    ▼
Live event adjustment (cartons rouges)
    │
    ▼
Surgical Markets (AH, DNB, O/U, BTTS)
    │
    ▼
Risk Scoring (7 règles d'intégrité)
    │
    ▼
Verdict + Confiance + Score attendu
```

---

## 🧩 Modules Système

### Core (Python)
| Module | Rôle |
|--------|------|
| `prediction_engine.py` | Moteur de prédiction principal (2850+ lignes) |
| `ml_features.py` | Extraction de 115+ features |
| `train_v24_top_analyst.py` | Entraînement XGBoost V24 |
| `train_live_model.py` | Entraînement modèle live goal |
| `live_goal_predictor.py` | Inférence live goal |
| `fastapi_server.py` | Serveur FastAPI |

### Services (Node.js)
| Service | Rôle |
|---------|------|
| `bsdService.js` | API BSD (fixtures, odds, stats) |
| `predixSportService.js` | API PredixSport |
| `bigBallsDataService.js` | API Big Balls Data |
| `liveMatchService.js` | Polling multi-source live |
| `LiveGoalPredictor.js` | Prédiction de buts live |
| `adaptiveLearningEngine.js` | Apprentissage adaptatif |
| `EvolutionEngine.js` | Base d'intelligence des échecs |
| `autoHealAgent.js` | Patrouille auto-réparation |
| `socketService.js` | Broadcast Socket.IO |

---

## 🌐 APIs & Routes

### Frontend
| Route | Vue |
|-------|-----|
| `/` | Dashboard prédictions |
| `/accuracy` | Précision |
| `/evolution` | Evolution Layer |
| `/grids` | Grilles "hot" |
| `/bets` | Suivi de paris |
| `/training` | Entraînement des modèles |

### Backend REST
| Endpoint | Méthode | Description |
|----------|---------|-------------|
| `/api/upcoming` | GET | Matchs à venir (prédictions enrichies) |
| `/api/live` | GET | Matchs live + prédictions |
| `/api/live-lab` | GET | Données Live Lab enrichies |
| `/api/live/goal-predictions` | GET | Prédictions de buts live |
| `/api/predictions` | GET | Prédictions passant le seuil |
| `/api/learn` | POST | Envoyer un résultat |
| `/api/learn/batch` | POST | Envoyer plusieurs résultats |
| `/api/learn/report/:league` | GET | Rapport d'apprentissage |
| `/api/learn/weights/:league` | GET | Poids par ligue |
| `/api/learn/leagues` | GET | Ligues suivies |
| `/api/learn/challenger/:league` | GET | Stats champion vs challenger |
| `/api/evolution/intelligence` | GET | Intelligence des échecs |
| `/api/evolution/performance-metrics` | GET | Métriques de performance |
| `/api/evolution/sensors` | GET | Signaux marché |
| `/api/evolution/accuracy` | GET | Précision par ligue |
| `/api/evolution/heatmap` | GET | Heatmap d'évolution |

### Python (FastAPI)
Le moteur FastAPI (`core/fastapi_server.py`) tourne **dans le même conteneur** que le serveur Node (voir `Dockerfile`), pas sur un service externe.

---

## 🚀 Déploiement Render

### Services
| Service | Type | Plan |
|---------|------|------|
| `pronostico` | Web Service (Node.js + FastAPI dans un seul conteneur) | Free (512MB RAM) |

URL de production : https://pronostico.onrender.com

### Build
```dockerfile
# Dockerfile — build frontend (vite build) puis serveur Node + uvicorn FastAPI
# Node heap: --max-old-space-size=384
# Puppeteer désactivé (PUPPETEER_SKIP_DOWNLOAD=true) — pas de Chromium dans l'image
```

### Déploiement continu
- `git push origin main` -> auto-deploy sur Render (service `pronostico`)
- Variables d'environnement configurées dans Render Dashboard

---

## 🔐 Variables d'Environnement

```env
# ✅ Configurées sur Render (service pronostico)
BSD_API_KEY=xxx
ODDSAPI_IO_KEY=xxx
API_SECRET_KEY=xxx

# ❌ Optionnel — non configuré (les services concernés passent en fallback/désactivés)
BBS_API_KEY=xxx
PREDIXSPORT_API_KEY=xxx
FOOTBALL_DATA_API_KEY=xxx
OPENWEATHERMAP_API_KEY=xxx
SPORTSDATA_IO_KEY=xxx
SPORTSRC_API_KEY=xxx

# Base de données
DATABASE_URL=xxx        # sinon SQLite local (data/tactical.db)
REDIS_URL=rediss://...  # sinon pas de cache Redis

# Sécurité / Notifications
TELEGRAM_BOT_TOKEN=xxx  # sinon bot Telegram désactivé
TELEGRAM_CHAT_ID=xxx

# Configuration
FASTAPI_URL=http://127.0.0.1:8000   # FastAPI embarqué dans le même conteneur
FRONTEND_URL=https://pronostico.onrender.com
```

---

## 🔄 Maintenance

### Automatique
| Tâche | Horaire | Description |
|-------|---------|-------------|
| AutoHeal Patrol | Toutes les 30min | Détection/résolution de problèmes |
| AutoArchiver | Toutes les 2h | Archivage matchs terminés |
| Adaptive Learning | 02:30 | Traitement des résultats |
| XGBoost Retrain | 1er du mois 04:00 | Ré-entraînement modèle |
| Live Model Retrain | Dimanche 05:00 | Ré-entraînement modèle live |
| Database Maintenance | 03:00 | VACUUM + ANALYZE |
| Accuracy Analysis | 23:00 | Rapport de précision quotidien |

### Manuelle
```bash
# Ré-entraînement XGBoost
npm run retrain

# Ré-entraînement modèle live
python core/train_live_model.py

# Audit de performance
python scripts/audit_performance.py --last 50

# Vérification santé
curl https://pronostico.onrender.com/api/health
```

---

## 📈 Métriques Clés

| Métrique | Valeur |
|----------|--------|
| Modèle XGBoost V24 | ~65-70% accuracy |
| Live Goal next5 AUC | 0.88 |
| Live Goal next10 AUC | 0.90 |
| Live Goal next15 AUC | 0.92 |
| Sources live | 3 (BSD, SportScore, SportSRC) |
| Features ML | 115+ |
| Matchs historiques | 5000+ |

---

## 📜 Licence

Projet privé --- TITANIUM NEURAL-X v5.0

---

*Généré le 10 Juin 2026 --- Dernier commit: [git log --oneline -1]*
