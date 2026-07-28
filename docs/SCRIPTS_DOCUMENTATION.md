# Documentation des Nouveaux Scripts et Outils

## 📚 Table des Matières

1. [Swagger API Documentation](#swagger-api-documentation)
2. [Script de Déploiement Automatique](#script-de-déploiement-automatique)
3. [Générateur Type Hints Python](#générateur-type-hints-python)
4. [Dockerfile Multi-Stage Production](#dockerfile-multi-stage-production)

---

## 1. Swagger API Documentation

### 📄 Fichier: `config/swagger.js`

Configuration Swagger/OpenAPI 3.0 pour générer automatiquement la documentation interactive de l'API REST.

### ✨ Fonctionnalités

- **Auto-documentation** de tous les endpoints REST
- **Interface interactive** Swagger UI pour tester l'API
- **Schémas validés** pour Match, Prediction, HealthCheck, Error
- **Authentification** documentée (API Key)
- **Multi-environnements** (dev, production)

### 🚀 Installation

```bash
npm install swagger-jsdoc swagger-ui-express --save
```

### 📝 Utilisation

**1. Intégrer dans `server.js`:**

```javascript
const { specs, swaggerUi } = require('./config/swagger')

// Swagger UI route
app.use(
  '/api-docs',
  swaggerUi.serve,
  swaggerUi.setup(specs, {
    customCss: '.swagger-ui .topbar { display: none }',
    customSiteTitle: 'Titanium AI API Docs',
  })
)

console.log('📚 API Docs: http://localhost:3001/api-docs')
```

**2. Annoter vos routes:**

```javascript
/**
 * @swagger
 * /api/predict:
 *   post:
 *     summary: Générer une prédiction pour un match
 *     tags: [Predictions]
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             $ref: '#/components/schemas/Match'
 *     responses:
 *       200:
 *         description: Prédiction générée avec succès
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Prediction'
 */
router.post('/predict', async (req, res) => {
  // ...
})
```

**3. Accéder à la documentation:**

```
http://localhost:3001/api-docs
```

### 📊 Schémas Disponibles

- **Match**: Structure d'un match (id, homeTeam, awayTeam, league, etc.)
- **Prediction**: Résultat de prédiction (verdict, confidence, probabilities, etc.)
- **HealthCheck**: Status système (uptime, memory, database, etc.)
- **Error**: Format d'erreur standard

### 🔐 Sécurité

- Authentification API Key documentée
- Header: `X-API-Key`
- Exemples de requêtes avec authentification

---

## 2. Script de Déploiement Automatique

### 📄 Fichier: `scripts/deploy.js`

Script Node.js automatisé pour déployer sur Render avec vérifications pré-vol.

### ✨ Fonctionnalités

- ✅ **Pre-flight checks**: Git status, env variables
- 🧪 **Tests automatiques**: Node.js (Jest) + Python (pytest)
- 📊 **Confirmation interactive** avant déploiement
- 🚀 **Push Git automatique** vers production/staging
- 📝 **Logs détaillés** avec couleurs
- ⚠️ **Avertissements** pour déploiements production

### 🚀 Utilisation

**1. Rendre le script exécutable:**

```bash
chmod +x scripts/deploy.js
```

**2. Déployer en staging:**

```bash
node scripts/deploy.js staging
```

**3. Déployer en production:**

```bash
node scripts/deploy.js production
```

**4. Via npm scripts (recommandé):**

Ajouter dans `package.json`:

```json
{
  "scripts": {
    "deploy:staging": "node scripts/deploy.js staging",
    "deploy:prod": "node scripts/deploy.js production"
  }
}
```

Puis:

```bash
npm run deploy:staging
npm run deploy:prod
```

### 📋 Workflow du Script

1. **Check Git Status**: Vérifie si working directory est propre
2. **Check Environment Variables**: Valide présence des vars critiques
3. **Confirmation Interactive**: Demande validation utilisateur
4. **Run Tests**: Exécute Jest + pytest
5. **Commit & Push**: Git add/commit/push automatique
6. **Deploy Notification**: Confirmation déploiement Render
7. **Next Steps**: Affiche checklist post-déploiement

### ⚙️ Configuration

Variables d'environnement requises:

```bash
DATABASE_URL=postgresql://...
API_SECRET_KEY=...
NODE_ENV=production
```

### 🎨 Output Example

```
============================================================
   TITANIUM AI - AUTOMATED DEPLOYMENT
============================================================

Environment: PRODUCTION

🔍 Checking Git status...
✅ Working directory clean

🔐 Checking environment variables...
✅ All required environment variables present

⚠️  Ready to deploy to PRODUCTION
Continue? (yes/no): yes

🧪 Running tests...
✅ Node.js tests passed
✅ Python tests passed

📝 Committing changes...
✅ Committed changes: deploy: production deployment 2026-06-30T12:00:00Z

🚀 Pushing to main...
✅ Pushed to origin/main

🚀 Deploying to Render (production)...
ℹ️  Render auto-deploys on git push
ℹ️  Check deployment status at: https://dashboard.render.com

============================================================
   ✅ DEPLOYMENT COMPLETED SUCCESSFULLY
============================================================

Next steps:
1. Monitor Render logs
2. Check /api/health endpoint
3. Verify predictions working
4. Monitor RAM usage in Render dashboard
```

### 🛡️ Safety Features

- Refuse de déployer si tests échouent
- Confirmation obligatoire pour production
- Affiche uncommitted changes avant déploiement
- Gestion gracieuse des erreurs

---

## 3. Générateur Type Hints Python

### 📄 Fichier: `scripts/generate_type_hints.py`

Génère un fichier de référence avec type hints complets pour les modules Python core/.

### ✨ Fonctionnalités

- 📝 **Type hints** pour toutes les fonctions critiques
- 🎯 **Examples d'utilisation** concrets
- 📚 **Documentation** inline
- 🔍 **Support mypy** pour validation types

### 🚀 Utilisation

**1. Générer le fichier de référence:**

```bash
python scripts/generate_type_hints.py
```

**2. Output:**

```
============================================================
Python Type Hints Generator
============================================================

✅ Generated: TYPE_HINTS_REFERENCE.py

Next steps:
1. Review the type hints in TYPE_HINTS_REFERENCE.py
2. Manually add them to your core/*.py files
3. Run: mypy core/ --check-untyped-defs
4. Fix any type errors reported
```

**3. Copier les type hints dans vos fichiers:**

Ouvrir `TYPE_HINTS_REFERENCE.py` et copier les signatures vers:

- `core/prediction_engine.py`
- `core/ml_features.py`
- `core/goal_model.py`
- `core/model_manager.py`

### 📝 Exemple de Type Hints Générés

```python
from typing import Dict, List, Optional, Tuple, Any
import numpy as np

def process_prediction(
    match_obj: Dict[str, Any],
    options: Optional[Dict] = None
) -> Dict[str, Any]:
    """
    Main prediction pipeline

    Args:
        match_obj: Match data dictionary
        options: Optional configuration

    Returns:
        Complete prediction response
    """
    pass

def extract_ml_features(
    match_obj: Dict[str, Any]
) -> Dict[str, float]:
    """
    Extract 115+ ML features from match

    Args:
        match_obj: Match dictionary with teams, league, stats

    Returns:
        Dictionary of feature name -> float value
    """
    pass
```

### 🔍 Validation avec mypy

```bash
# Installer mypy
pip install mypy

# Vérifier les types
mypy core/ --check-untyped-defs

# Output example:
# core/prediction_engine.py:45: error: Argument 1 to "float" has incompatible type "str"; expected "int"
# Found 1 error in 1 file (checked 5 source files)
```

### 📦 Modules Couverts

- `prediction_engine.py`: process_prediction, \_safe_float
- `ml_features.py`: extract_ml_features, calculate_elo_rating, calculate_form_score
- `goal_model.py`: poisson_pmf, dixon_coles, monte_carlo, predict_btts, predict_ou
- `model_manager.py`: ModelManager class avec lazy loading

### 🎯 Bénéfices

- ✅ **Autocomplete IDE** amélioré (VS Code, PyCharm)
- ✅ **Détection erreurs** avant runtime
- ✅ **Documentation** automatique
- ✅ **Refactoring** plus sûr

---

## 4. Dockerfile Multi-Stage Production

### 📄 Fichier: `Dockerfile.production`

Dockerfile optimisé multi-stage pour production Render avec image minimale.

### ✨ Fonctionnalités

- 🏗️ **Multi-stage build** (4 stages)
- 📦 **Image minimale** (~300MB vs ~1.2GB)
- ⚡ **Cache optimisé** pour builds rapides
- 🔒 **Production-ready** avec health check
- 💾 **RAM optimisée** (--max-old-space-size=512)

### 🏗️ Architecture Multi-Stage

```
Stage 1: node-deps     → Install Node dependencies
Stage 2: python-deps   → Install Python packages
Stage 3: frontend-build → Build React app (Vite)
Stage 4: production    → Final image minimale
```

### 🚀 Build & Run

**1. Build l'image:**

```bash
docker build -f Dockerfile.production -t titanium-ai:latest .
```

**2. Run localement:**

```bash
docker run -p 10000:10000 \
  -e DATABASE_URL="postgresql://..." \
  -e API_SECRET_KEY="..." \
  -e NODE_ENV=production \
  titanium-ai:latest
```

**3. Run avec Docker Compose:**

```yaml
# docker-compose.prod.yml
version: '3.8'
services:
  app:
    build:
      context: .
      dockerfile: Dockerfile.production
    ports:
      - '10000:10000'
    environment:
      - NODE_ENV=production
      - DATABASE_URL=${DATABASE_URL}
      - API_SECRET_KEY=${API_SECRET_KEY}
      - USE_MODEL_MANAGER=true
    healthcheck:
      test: ['CMD', 'node', '-e', "require('http').get('http://localhost:10000/api/health')"]
      interval: 30s
      timeout: 10s
      retries: 3
```

```bash
docker-compose -f docker-compose.prod.yml up -d
```

### 📊 Comparaison Taille Images

| Build Type   | Image Size | Build Time |
| ------------ | ---------- | ---------- |
| Single-stage | ~1.2 GB    | 8 min      |
| Multi-stage  | ~300 MB    | 6 min      |
| Optimized    | ~250 MB    | 5 min      |

### ⚡ Optimisations

1. **Alpine Linux** pour Node.js (plus léger)
2. **Python slim** (pas full)
3. **npm ci --only=production** (pas dev deps)
4. **pip --no-cache-dir** (économie espace)
5. **apt-get clean** après installations
6. **COPY --from** pour stages

### 🔒 Production Best Practices

```dockerfile
# Health check intégré
HEALTHCHECK --interval=30s --timeout=10s \
  CMD node -e "require('http').get('http://localhost:10000/api/health')"

# Heap size limité pour Render Free
CMD ["node", "--max-old-space-size=512", "server.js"]

# Variables d'environnement
ENV NODE_ENV=production
ENV USE_MODEL_MANAGER=true
```

### 🐳 Render Deployment

**1. Créer `render.yaml`:**

```yaml
services:
  - type: web
    name: titanium-ai
    env: docker
    dockerfilePath: ./Dockerfile.production
    envVars:
      - key: NODE_ENV
        value: production
      - key: USE_MODEL_MANAGER
        value: true
      - key: DATABASE_URL
        sync: false
      - key: API_SECRET_KEY
        sync: false
```

**2. Push vers GitHub:**

```bash
git add Dockerfile.production render.yaml
git commit -m "feat: add production Dockerfile"
git push origin main
```

Render détectera automatiquement le Dockerfile et déploiera.

### 🛠️ Debug Image

```bash
# Inspecter l'image
docker inspect titanium-ai:latest

# Taille des layers
docker history titanium-ai:latest

# Run interactif
docker run -it titanium-ai:latest /bin/sh
```

---

## 📚 Ressources Additionnelles

### Documentation Externe

- [Swagger OpenAPI 3.0](https://swagger.io/specification/)
- [Docker Multi-Stage Builds](https://docs.docker.com/build/building/multi-stage/)
- [Python Type Hints (PEP 484)](https://peps.python.org/pep-0484/)
- [Render Docker Deployment](https://render.com/docs/docker)

### Fichiers de Configuration

```
stitch/
├── config/
│   └── swagger.js              # Swagger config
├── scripts/
│   ├── deploy.js               # Deploy script
│   └── generate_type_hints.py  # Type hints generator
├── Dockerfile.production       # Multi-stage Dockerfile
├── render.yaml                 # Render config
└── TYPE_HINTS_REFERENCE.py     # Generated type hints
```

### Commandes Utiles

```bash
# API Documentation
npm run start  # http://localhost:3001/api-docs

# Déploiement
npm run deploy:staging
npm run deploy:prod

# Type Hints
python scripts/generate_type_hints.py
mypy core/ --check-untyped-defs

# Docker
docker build -f Dockerfile.production -t titanium-ai .
docker run -p 10000:10000 titanium-ai
```

---

## 🎯 Next Steps

1. ✅ Intégrer Swagger dans `server.js`
2. ✅ Tester le script de déploiement en staging
3. ✅ Ajouter type hints aux modules core/
4. ✅ Build l'image Docker production
5. ✅ Déployer sur Render avec le nouveau Dockerfile
6. 📊 Monitorer performance et RAM usage

---

**Documentation générée le:** 2026-06-30  
**Version:** 3.1.0  
**Auteur:** Titanium AI Team
