# 🔧 PLAN DE REFACTORING — prediction_engine.py

**Fichier cible** : `core/prediction_engine.py`  
**Lignes actuelles** : 3099 lignes  
**Objectif** : 5 modules < 500 lignes chacun  
**Risque** : 🔴 ÉLEVÉ — Cœur métier ML  
**Durée estimée** : 3-4 jours développeur expérimenté  

---

## 📊 ANALYSE ACTUELLE

### Structure détectée
```python
# Lignes 1-200: Imports + Helpers + Cache
# Lignes 200-800: Fonctions utilitaires (H2H, patterns, modifiers)
# Lignes 800-1500: Feature engineering (xG calculation, tactical modifiers)
# Lignes 1500-2500: XGBoost ensemble + Poisson simulation
# Lignes 2500-3099: Confluence Guard + Output formatting
```

### Dépendances externes
- `goal_model.py` (Poisson/Dixon-Coles)
- `ml_features.py` (Extract features)
- `top_analyst_engine.py` (Secondary model)
- `leagues_master.py` (League classification)
- XGBoost models (17 fichiers JSON, 34 MB)

### Fonctions principales
1. `process_prediction()` — Fonction principale (orchestration)
2. `get_xgb()` — Lazy loading XGBoost ✅
3. Feature engineering functions (~15 fonctions)
4. Tactical modifiers (~10 fonctions)
5. Output formatters (~5 fonctions)

---

## 🎯 ARCHITECTURE CIBLE

### Nouveau découpage
```
core/
├── prediction_engine.py          (300 lignes) — Orchestrateur principal
├── feature_builder.py            (400 lignes) — Feature engineering
├── model_ensemble.py             (350 lignes) — XGBoost + blending
├── poisson_calculator.py         (300 lignes) — Monte Carlo simulation
├── validation_engine.py          (250 lignes) — Confluence Guard
└── output_formatter.py           (200 lignes) — JSON response builder
```

---

## 📦 MODULE 1 : `feature_builder.py`

**Responsabilité** : Construction et transformation des features ML

**Contenu à extraire** :
```python
# Lignes 800-1500 actuelles
- get_advanced_xg_adjustment()
- get_stylistic_clash_modifier()
- get_historical_patterns()
- calculate_motivation_factor()
- apply_tactical_modifiers()
- get_quality_of_performance()
- normalize_features()
```

**Interface publique** :
```python
def build_features(match_obj: Dict, raw_features: Dict) -> Dict[str, float]:
    """
    Construit l'ensemble des features ML à partir des données brutes.
    
    Args:
        match_obj: Données du match (teams, league, odds, stats)
        raw_features: Features extraites par ml_features.py
        
    Returns:
        Dictionary de 115+ features normalisées
    """
    pass
```

**Dépendances** :
- `ml_features.py` (extract_ml_features)
- `historical_archive.sqlite` (H2H data)
- Global caches (`_LEAGUE_DRAW_CACHE`, etc.)

**Tests requis** :
- ✅ Test avec match réel (Premier League)
- ✅ Test avec données incomplètes
- ✅ Test cache hit/miss
- ✅ Test normalisation features

---

## 📦 MODULE 2 : `model_ensemble.py`

**Responsabilité** : Chargement et exécution des modèles XGBoost

**Contenu à extraire** :
```python
# Lignes 1500-2000 actuelles
- load_xgboost_models()
- run_xgboost_prediction()
- blend_model_outputs() # V2 85% + V4 15%
- apply_predixsport_signal()
- meta_refiner_bayesian()
```

**Interface publique** :
```python
def predict_with_ensemble(
    features: Dict[str, float],
    league_tier: str,
    model_config: Dict
) -> Dict[str, float]:
    """
    Exécute l'ensemble XGBoost et retourne les probabilités 1X2.
    
    Args:
        features: Features normalisées (115+)
        league_tier: T1/T2/T3/BLACKLIST
        model_config: Configuration blend (weights, models path)
        
    Returns:
        {
            'prob_home': float,
            'prob_draw': float,
            'prob_away': float,
            'model_version': str,
            'confidence_raw': float
        }
    """
    pass
```

**Lazy loading** :
```python
_MODELS = None

def get_models():
    global _MODELS
    if _MODELS is None:
        _MODELS = {
            'v55': load_model('stitch_v55_optimized.json'),
            'v24': load_model('stitch_v24_hybrid.json'),
            # Charger à la demande
        }
    return _MODELS
```

**Tests requis** :
- ✅ Test lazy loading (pas de RAM spike)
- ✅ Test blend 85/15
- ✅ Test fallback si model manquant
- ✅ Test PredixSport integration

---

## 📦 MODULE 3 : `poisson_calculator.py`

**Responsabilité** : Simulation Monte Carlo et marchés chirurgicaux

**Contenu à extraire** :
```python
# Lignes 2000-2300 actuelles
- run_monte_carlo_simulation()
- calculate_btts_probability()
- calculate_over_under()
- calculate_asian_handicap()
- calculate_surgical_markets() # HT O0.5, DNB, etc.
```

**Interface publique** :
```python
def simulate_match(
    xg_home: float,
    xg_away: float,
    features: Dict,
    n_simulations: int = 10000
) -> Dict:
    """
    Exécute simulation Monte Carlo Poisson/Dixon-Coles.
    
    Args:
        xg_home: Expected goals home team
        xg_away: Expected goals away team
        features: Context features (home_advantage, etc.)
        n_simulations: Nombre de simulations (défaut 10K)
        
    Returns:
        {
            'expected_score': (home, away),
            'btts_prob': float,
            'over25_prob': float,
            'under25_prob': float,
            'surgical_markets': [
                {'type': 'AH -0.5', 'prob': 0.65, 'value': 1.23},
                ...
            ]
        }
    """
    pass
```

**Dépendances** :
- `goal_model.py` (fit_dixon_coles, monte_carlo_simulation_goalmodel)
- numpy (random distributions)

**Tests requis** :
- ✅ Test simulation 10K itérations
- ✅ Test BTTS calculation
- ✅ Test surgical markets
- ✅ Test performance (< 500ms)

---

## 📦 MODULE 4 : `validation_engine.py`

**Responsabilité** : Confluence Guard et vérifications

**Contenu à extraire** :
```python
# Lignes 2300-2600 actuelles
- confluence_guard_check()
- validate_xgboost_vs_poisson()
- validate_market_alignment()
- detect_trap_patterns()
- calculate_reliability_index()
- apply_adaptive_learning_correction()
```

**Interface publique** :
```python
def validate_prediction(
    xgb_probs: Dict,
    poisson_probs: Dict,
    market_odds: Dict,
    features: Dict
) -> Dict:
    """
    Triple validation (XGBoost + Poisson + Market).
    
    Args:
        xgb_probs: Probas XGBoost
        poisson_probs: Probas Poisson
        market_odds: Odds 1X2 du marché
        features: Features contextuelles
        
    Returns:
        {
            'valid': bool,
            'confidence_adjusted': float,
            'warnings': List[str],
            'trap_detected': bool,
            'reliability_index': float
        }
    """
    pass
```

**Règles Confluence Guard** :
1. Divergence XGBoost vs Poisson < 20%
2. Odds market alignment (CLV check)
3. Trap detection (momentum vs odds drop)
4. Adaptive learning correction

**Tests requis** :
- ✅ Test confluence pass
- ✅ Test confluence fail (divergence > 20%)
- ✅ Test trap detection
- ✅ Test adaptive correction

---

## 📦 MODULE 5 : `output_formatter.py`

**Responsabilité** : Construction de la réponse JSON finale

**Contenu à extraire** :
```python
# Lignes 2600-3099 actuelles
- format_prediction_response()
- build_analysis_object()
- generate_tactical_briefing()
- format_surgical_markets()
- add_intelligence_cards()
```

**Interface publique** :
```python
def format_response(
    prediction: Dict,
    simulation: Dict,
    validation: Dict,
    match_obj: Dict
) -> Dict:
    """
    Construit la réponse JSON finale pour l'API.
    
    Args:
        prediction: Résultats XGBoost
        simulation: Résultats Monte Carlo
        validation: Résultats Confluence Guard
        match_obj: Données match originales
        
    Returns:
        JSON response complète (voir schéma API)
    """
    pass
```

**Schéma response** :
```json
{
  "verdict": "SAFE BET",
  "confidence": 78.5,
  "selection": "Home",
  "expected_score": [2, 1],
  "probabilities": {"home": 0.65, "draw": 0.22, "away": 0.13},
  "surgical_markets": [...],
  "analysis": {...},
  "intelligence": {...}
}
```

**Tests requis** :
- ✅ Test format JSON valide
- ✅ Test tous les champs présents
- ✅ Test schéma validation (JSON Schema)

---

## 📦 MODULE 6 : `prediction_engine.py` (Nouveau)

**Responsabilité** : Orchestrateur léger (< 300 lignes)

**Structure** :
```python
from feature_builder import build_features
from model_ensemble import predict_with_ensemble
from poisson_calculator import simulate_match
from validation_engine import validate_prediction
from output_formatter import format_response

def process_prediction(match_obj: Dict, options: Dict = None) -> Dict:
    """
    Orchestrateur principal — Pipeline complet de prédiction.
    
    Pipeline:
    1. Feature building (feature_builder)
    2. XGBoost ensemble (model_ensemble)
    3. Monte Carlo simulation (poisson_calculator)
    4. Confluence Guard validation (validation_engine)
    5. Response formatting (output_formatter)
    
    Args:
        match_obj: Match data (teams, league, odds, stats)
        options: Optional config (model_version, simulation_count)
        
    Returns:
        Complete prediction response (JSON)
    """
    # 1. Extract raw features
    raw_features = extract_ml_features(match_obj)
    
    # 2. Build ML features
    features = build_features(match_obj, raw_features)
    
    # 3. XGBoost ensemble
    xgb_probs = predict_with_ensemble(features, league_tier, config)
    
    # 4. Monte Carlo simulation
    simulation = simulate_match(xg_home, xg_away, features)
    
    # 5. Confluence Guard validation
    validation = validate_prediction(xgb_probs, simulation['probs'], market_odds, features)
    
    # 6. Format response
    response = format_response(xgb_probs, simulation, validation, match_obj)
    
    return response
```

**Avantages** :
- ✅ Lisibilité parfaite (pipeline clair)
- ✅ Testabilité (mock chaque étape)
- ✅ Maintenance (bug isolation facile)
- ✅ Performance (lazy loading models)

---

## 🚀 PLAN D'EXÉCUTION

### Phase 1 : Préparation (Jour 1)
1. ✅ Créer branch `refactor/prediction-engine`
2. ✅ Écrire tests de régression sur `process_prediction()` actuel
3. ✅ Documenter tous les cas edge (T3 leagues, missing data, etc.)
4. ✅ Backup `prediction_engine.py` → `prediction_engine_legacy.py`

**Validation** : Tests passent 100% sur version actuelle

### Phase 2 : Extraction modules (Jour 2)
1. Créer `feature_builder.py` (extraire lignes 800-1500)
2. Créer `model_ensemble.py` (extraire lignes 1500-2000)
3. Créer `poisson_calculator.py` (extraire lignes 2000-2300)
4. Créer `validation_engine.py` (extraire lignes 2300-2600)
5. Créer `output_formatter.py` (extraire lignes 2600-3099)

**Validation** : Chaque module a ses propres tests unitaires

### Phase 3 : Refactor orchestrateur (Jour 3)
1. Réécrire `prediction_engine.py` (< 300 lignes)
2. Importer les 5 nouveaux modules
3. Adapter le pipeline

**Validation** : Tests de régression passent 100%

### Phase 4 : Intégration (Jour 4)
1. Tester avec `fastapi_server.py`
2. Tester avec `enriched_predictions.js`
3. Benchmark performance (avant/après)
4. Code review

**Validation** : 
- ✅ Aucune régression fonctionnelle
- ✅ Performance identique ou meilleure
- ✅ Couverture tests > 70% sur nouveaux modules

### Phase 5 : Déploiement
1. Merge dans `main`
2. Déployer sur Render staging
3. Monitoring 24h
4. Déployer production

---

## ⚠️ RISQUES ET MITIGATIONS

### Risque 1 : Régression fonctionnelle
**Impact** : 🔴 CRITIQUE — Prédictions incorrectes  
**Mitigation** :
- Tests de régression exhaustifs (50+ cas)
- A/B testing (ancien vs nouveau pendant 7 jours)
- Rollback automatique si accuracy < 55%

### Risque 2 : Performance dégradée
**Impact** : 🟡 MOYEN — Latency > 2s  
**Mitigation** :
- Benchmark avant/après
- Profiling Python (cProfile)
- Lazy loading strict

### Risque 3 : Imports circulaires
**Impact** : 🟡 MOYEN — Crash au démarrage  
**Mitigation** :
- Dependency graph analysis
- Imports lazy dans fonctions si nécessaire
- Tests d'import isolés

### Risque 4 : Breaking changes API
**Impact** : 🟡 MOYEN — Frontend crash  
**Mitigation** :
- Schéma JSON identique
- Contract tests (JSON Schema validation)
- Backward compatibility 100%

---

## 📊 MÉTRIQUES DE SUCCÈS

| Métrique | Avant | Cible | Validation |
|----------|-------|-------|------------|
| Lignes par fichier | 3099 | < 500 | ✅ Respecté |
| Couverture tests | 0% | > 70% | ✅ pytest |
| Cyclomatic complexity | > 50 | < 10 | ✅ radon |
| Latency /predict | ~1.2s | < 1.5s | ✅ Benchmark |
| Accuracy | 65% | ≥ 65% | ✅ Backtest 100 matchs |

---

## 🛠️ OUTILS RECOMMANDÉS

### Tests
```bash
# Tests unitaires
pytest core/test_feature_builder.py -v --cov

# Tests de régression
pytest tests/test_prediction_regression.py -v

# Benchmark performance
python scripts/benchmark_prediction.py --iterations 100
```

### Analyse statique
```bash
# Complexité cyclomatique
radon cc core/prediction_engine.py -a

# Type hints validation
mypy core/ --strict

# Linting
ruff check core/ --fix
```

### Profiling
```python
import cProfile
import pstats

profiler = cProfile.Profile()
profiler.enable()
result = process_prediction(match_obj)
profiler.disable()
stats = pstats.Stats(profiler)
stats.sort_stats('cumulative')
stats.print_stats(20)
```

---

## 📝 CHECKLIST PRE-REFACTOR

Avant de commencer, valider :

- [ ] Branch `refactor/prediction-engine` créée
- [ ] Tests de régression écrits (50+ cas)
- [ ] Backup `prediction_engine_legacy.py` créé
- [ ] Dependency graph analysé (imports circulaires)
- [ ] Performance baseline mesurée (latency, RAM)
- [ ] Staging environment prêt
- [ ] Rollback plan documenté

---

## 🎯 RÉSULTAT ATTENDU

**Avant** :
```
core/prediction_engine.py (3099 lignes, complexité 50+)
```

**Après** :
```
core/
├── prediction_engine.py          (300 lignes, orchestrateur)
├── feature_builder.py            (400 lignes, features)
├── model_ensemble.py             (350 lignes, XGBoost)
├── poisson_calculator.py         (300 lignes, Monte Carlo)
├── validation_engine.py          (250 lignes, Confluence)
└── output_formatter.py           (200 lignes, JSON)

Total: 1800 lignes (vs 3099) — 42% de réduction
```

**Avantages mesurables** :
- ✅ Maintenabilité : +80% (complexité divisée par 5)
- ✅ Testabilité : +300% (0% → 70% coverage)
- ✅ Onboarding : -60% temps (nouveau dev comprend en 2h vs 1 jour)
- ✅ Bug isolation : 5min vs 30min (modules isolés)

---

**FIN DU PLAN DE REFACTORING**

*Document à réviser avant exécution*  
*Estimation : 3-4 jours développeur expérimenté*  
*Priorité : 🔴 HAUTE (mais après tests unitaires)*
