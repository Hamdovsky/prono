# 🚀 GUIDE D'ACTIVATION — Model Manager Optimisé

**Version** : 3.1.0  
**Date** : 30 Juin 2026  
**Impact** : -60 à -85% RAM sur chargement modèles XGBoost  

---

## 📋 RÉSUMÉ

Le nouveau `model_manager.py` permet de :
- ✅ Charger uniquement les modèles nécessaires (selon league tier)
- ✅ Économiser 60-85% de RAM
- ✅ Réduire les risques OOM sur Render Free (512 MB)
- ✅ Backward compatible à 100%

---

## 🎯 ACTIVATION EN 3 ÉTAPES

### Étape 1 : Tester localement

```bash
# 1. Installer psutil (pour monitoring)
pip install psutil

# 2. Lancer le benchmark
python scripts/benchmark_model_loading.py

# 3. Vérifier les résultats
cat benchmark_results.json
```

**Résultats attendus** :
- T1 leagues : -30 à -50% RAM
- T3 leagues : -60 à -85% RAM
- Temps de chargement : équivalent ou plus rapide

---

### Étape 2 : Activer en dev

```bash
# Ajouter dans .env
USE_MODEL_MANAGER=true

# Tester l'application
npm run dev

# Vérifier les logs
# Vous devriez voir : "✅ [MODEL MANAGER] Using optimized model loading"
```

**Vérification** :
```bash
# Tester une prédiction
curl -X POST http://localhost:3001/api/predict \
  -H "Content-Type: application/json" \
  -d '{
    "homeTeam": "Manchester City",
    "awayTeam": "Arsenal",
    "league": "Premier League"
  }'
```

---

### Étape 3 : Déployer en production

#### Option A : Render Dashboard (Recommandé)
1. Aller sur https://dashboard.render.com
2. Sélectionner service `prono-k6gc`
3. Environment → Add Variable
   - Key: `USE_MODEL_MANAGER`
   - Value: `true`
4. Save Changes → Auto-deploy

#### Option B : Via Git
```bash
# Ajouter dans .env.example
echo "USE_MODEL_MANAGER=true" >> .env.example

# Commit
git add .env.example
git commit -m "feat: enable model_manager in production"
git push origin main
```

---

## 📊 MONITORING

### Vérifier que ça fonctionne

```bash
# 1. Logs Render
# Chercher : "✅ [MODEL MANAGER] Using optimized model loading"

# 2. Endpoint de monitoring (à créer)
curl https://prono-k6gc.onrender.com/api/system/health

# 3. RAM usage
# Render Dashboard → Metrics → Memory Usage
# Avant : ~400-500 MB
# Après : ~200-300 MB (selon tier moyen)
```

### Cache statistics

```python
# Dans enriched_predictions.js ou route /api/system/health
# Ajouter endpoint pour voir cache stats

from core.model_manager import get_model_manager

stats = get_model_manager().get_cache_stats()
print(stats)
# {'loaded_models': ['v55', 'v24'], 'count': 2}
```

---

## 🔄 ROLLBACK (si problème)

### Rollback immédiat

```bash
# Option 1 : Désactiver le flag
# Render Dashboard → Environment
USE_MODEL_MANAGER=false

# Option 2 : Supprimer la variable
# Render Dashboard → Remove USE_MODEL_MANAGER

# L'ancien système reprend automatiquement
```

### Rollback Git

```bash
# Si commits récents cassent quelque chose
git revert HEAD
git push origin main
```

---

## ⚙️ CONFIGURATION AVANCÉE

### Charger uniquement certains modèles

```python
# Dans prediction_engine.py ou enriched_predictions.js
from core.model_manager import get_model_manager

manager = get_model_manager()

# Stratégie 1 : Selon league tier (automatique)
models = manager.get_required_models('T1', is_wc2026=False)
# Charge : v55 + v24

# Stratégie 2 : Manuel
v55_model = manager.get_model('v55')
v24_model = manager.get_model('v24')

# Stratégie 3 : Preload au démarrage (optionnel)
# Dans server.js ou fastapi_server.py
manager.get_model('v55')  # Preload v55 au boot
```

### Clear cache (long-running processes)

```python
# Si le service tourne plusieurs heures sans redémarrer
from core.model_manager import get_model_manager

# Clear tous les modèles
get_model_manager().clear_cache()

# Ou unload un seul
get_model_manager().unload_model('v553_premium')
```

---

## 🧪 TESTS

### Tests unitaires

```bash
# Tester model_manager seul
pytest tests/test_model_manager.py -v

# Tous les tests
pytest tests/ -v --cov=core
```

### Tests d'intégration

```bash
# Tester avec vraie prédiction
node __tests__/integration_prediction.test.js

# Ou manuel
npm test -- --testPathPattern=prediction
```

---

## 📈 MÉTRIQUES DE SUCCÈS

### Avant activation

| Métrique | Valeur Avant |
|----------|--------------|
| RAM Render (idle) | ~150 MB |
| RAM Render (peak) | ~450-500 MB |
| Models chargés | 7 modèles (34 MB) |
| Cold start | 30-60s |

### Après activation (attendu)

| Métrique | Valeur Après | Amélioration |
|----------|--------------|--------------|
| RAM Render (idle) | ~100 MB | -33% |
| RAM Render (peak T1) | ~250-300 MB | -40% |
| RAM Render (peak T3) | ~150-200 MB | -60% |
| Models chargés | 1-2 selon tier | -70% |
| Cold start | 20-40s | -33% |

---

## ❓ FAQ

### Q1 : Est-ce que ça casse l'existant ?
**R** : Non, 100% backward compatible. Si `USE_MODEL_MANAGER=false` ou absent, l'ancien système tourne.

### Q2 : Quelle est la différence de performance ?
**R** : Chargement équivalent ou légèrement plus rapide. Économie RAM principale.

### Q3 : Que se passe-t-il si un modèle manque ?
**R** : `get_model()` retourne `None` gracieusement. Le système utilise les fallbacks existants.

### Q4 : Faut-il modifier prediction_engine.py ?
**R** : Non immédiatement. Le wrapper `model_loader.py` gère la transition. Refactoring complet = REFACTORING_PLAN.md (plus tard).

### Q5 : Ça marche sur PostgreSQL aussi ?
**R** : Oui, indépendant de la DB. Seuls les modèles XGBoost sont concernés.

### Q6 : Et pour le déploiement Docker ?
**R** : Ajouter `ENV USE_MODEL_MANAGER=true` dans Dockerfile, ou passer via docker-compose.

---

## 🔗 RESSOURCES

- **Code** : `core/model_manager.py`
- **Tests** : `tests/test_model_manager.py`
- **Benchmark** : `scripts/benchmark_model_loading.py`
- **Wrapper** : `core/model_loader.py`
- **Documentation** : `REFACTORING_PLAN.md`

---

## 🆘 SUPPORT

### Problème : "Module model_manager not found"
```bash
# Vérifier que le fichier existe
ls -la core/model_manager.py

# Vérifier PYTHONPATH
python -c "import sys; print(sys.path)"
```

### Problème : "XGBoost not available"
```bash
# Installer XGBoost
pip install xgboost==2.1.0

# Vérifier
python -c "import xgboost; print(xgboost.__version__)"
```

### Problème : RAM toujours élevée
```bash
# Vérifier que le flag est actif
python -c "import os; print(os.getenv('USE_MODEL_MANAGER'))"

# Vérifier les logs
grep "MODEL MANAGER" logs/app.log
```

---

## ✅ CHECKLIST D'ACTIVATION

### Dev/Staging
- [ ] `pip install psutil`
- [ ] Lancer benchmark : `python scripts/benchmark_model_loading.py`
- [ ] Vérifier résultats : RAM saved > 30%
- [ ] Ajouter `USE_MODEL_MANAGER=true` dans `.env`
- [ ] Tester l'app : `npm run dev`
- [ ] Vérifier logs : "Using optimized model loading"
- [ ] Tester une prédiction manuelle
- [ ] Lancer tests : `pytest tests/test_model_manager.py -v`

### Production
- [ ] Backup base de données (précaution)
- [ ] Noter RAM usage actuel (Render Metrics)
- [ ] Activer flag sur Render Dashboard
- [ ] Attendre redémarrage automatique (~2 min)
- [ ] Vérifier logs Render
- [ ] Tester `/api/health` endpoint
- [ ] Monitorer RAM pendant 1h
- [ ] Valider prédictions correctes
- [ ] Documenter changement dans CHANGELOG

---

**Dernière mise à jour** : 30 Juin 2026  
**Prochaine étape** : Refactoring complet prediction_engine.py (voir REFACTORING_PLAN.md)
