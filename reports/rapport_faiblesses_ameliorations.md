# Rapport d'Audit : Titanium AI — Faiblesses & Améliorations

**Date :** 24 juin 2026  
**Projet :** Stitch System (prono-k6gc.onrender.com)

---

## 1. FAIBLESSES CRITIQUES

### 1.1 Bases de données vides (BLOCKANT)
- `data/tactical.db` = **0 octets** (aucune table, aucun match)
- `data/historical_archive.sqlite` = **0 octets** (idem)
- **Conséquence :** Le dashboard Streamlit (`ultra_dashboard.py`) affiche "No match data found", les prédictions ML ne peuvent pas fonctionner, le frontend React ne reçoit aucune donnée.
- **Cause :** Les fichiers ont été créés mais jamais initialisés/populés. Le `initSchema()` crée les tables mais `tactical.db` est vide car il n'y a pas eu de seed ou de sync.

### 1.2 PostgreSQL : Permissions insuffisantes (BLOCKANT)
- **Erreur :** `"doit être le propriétaire de la table"` sur toutes les tables (matches, prediction_history, etc.)
- **Erreur :** `"droit refusé pour la séquence"` sur toutes les séquences
- **Cause :** L'utilisateur PostgreSQL (Neon/Supabase) n'a pas les droits `OWNER` sur les tables. Les migrations CREATE INDEX, ALTER TABLE et GRANT échouent.
- **Conséquence :** Les index ne sont pas créés (requêtes lentes), l'insertion dans `prediction_history` échoue systématiquement.

### 1.3 camelCase PostgreSQL : Regex dangereuse dans pg_database.js
- **Fichier :** `core/pg_database.js:19`
- **Code :** `.replace(/(?<!")\b([a-z]+[A-Z]\w*)\b(?!")/g, '"$1"')`
- **Problème :** Cette regex auto-quote **tous** les mots en camelCase, y compris les mots-clés SQL, les alias, et les noms de colonnes déjà corrects.
- **Exemple d'échec :** La colonne `startTimestamp` est référencée sans quotes dans certaines requêtes → erreur `"la colonne « starttimestamp » n'existe pas"` car PostgreSQL lowercase les identifiants non-quotés.

### 1.4 Aucune seed data / pas de fixtures
- Le fichier `.env` ne contient que `TEST_VAR` et `BROWSERLESS_TOKEN`. Aucune des clés API essentielles n'est présente en local :
  - `BSD_API_KEY` ❌
  - `FOOTBALLDATA_KEY` ❌
  - `RAPIDAPI_KEY` ❌
  - `SUPABASE_URL` ❌
  - etc.
- Les services de scraping et de données externes ne peuvent pas fonctionner.

### 1.5 Logs d'erreur saturés
- `error.log` = **4.2 MB** avec des milliers d'erreurs PostgreSQL répétitives (permissions, séquences)
- `info.log` = **634 KB** aussi avec des warnings
- **Problème :** Les erreurs de permissions tournent en boucle à chaque démarrage et à chaque cycle de sync (toutes les 5 min).

---

## 2. FAIBLESSES MOYENNES

### 2.1 Accuracy Log : données de test uniquement
- `data/accuracy_log.json` ne contient que des entrées `"test_123"` avec des valeurs factices (50/30/20). Aucune vraie donnée de performance n'est collectée.

### 2.2 Python Bridge instable
- **Erreur :** `[PythonBridge] Exit code 1` — le pont Python (FastAPI) échoue régulièrement
- Les modèles ML Python (XGBoost V552, etc.) ne sont pas accessibles depuis Node.js

### 2.3 AutoHeal sur les APIs externes
- Plusieurs APIs externes sont détectées comme "down" régulièrement :
  - `therundown_api_down`
  - `apifootball_api_down`
  - `sportmonks_api_down`
  - `bigballsdata_api_down`
- L'AutoHeal tourne en boucle pour essayer de les récupérer

### 2.4 Requêtes PostgreSQL lentes
- Requêtes lentes détectées (800-1200ms) sur la table `learning`
- Les index manquants à cause des permissions aggravent le problème

### 2.5 Clés API manquantes sur Render
- Malgré `render.yaml`, plusieurs clés sont marquées `sync: false` et doivent être configurées manuellement
- Services désactivés : OddsPapi, BBS, OddsAPI.io, FutPythonTrader

---

## 3. FAIBLESSES MINEURES

### 3.1 Tests inadaptés
- Les tests Jest existants (`__tests__/`) sont basiques et ne couvrent pas les scénarios réels
- `accuracy_log.json` contient des données de démonstration non réalistes

### 3.2 Fichier .env vide
- Seulement 2 variables, aucune configuration réelle
- Risque de commit accidentel du `.env` (même si vide)

### 3.3 Dashboard Streamlit non déployé
- `ultra_dashboard.py` existe mais n'est pas déployé sur Render. Il faudrait un service Streamlit séparé ou un accès direct.

### 3.4 Rapports markdown statiques
- Les rapports dans `reports/` sont générés manuellement ou par des scripts qui ne tournent probablement pas en production

---

## 4. AMÉLIORATIONS PRIORITAIRES

### 4.1 🔴 URGENT : Réparer les permissions PostgreSQL
```sql
-- Dans Supabase/Neon SQL Editor :
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO CURRENT_USER;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO CURRENT_USER;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO CURRENT_USER;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO CURRENT_USER;
```

### 4.2 🔴 URGENT : Corriger la regex camelCase dans pg_database.js
Remplacer la regex ligne 19 par une approche plus ciblée qui ne quote que les vrais noms de colonnes camelCase, pas les mots-clés :

```javascript
// Avant (trop agressif - ligne 19) :
.replace(/(?<!")\b([a-z]+[A-Z]\w*)\b(?!")/g, '"$1"')

// Après (uniquement pour les colonnes spécifiques) :
// Ne pas auto-quoter aveuglément. Utiliser des mappings explicites.
```

### 4.3 🔴 URGENT : Populer les bases de données
- Ajouter un script `seed.js` qui peuple `tactical.db` avec des données de démonstration (au moins 50 matchs)
- Déclencher le cloud seed au démarrage (déjà présent dans `server.js` mais qui échoue car les APIs ne sont pas configurées)

### 4.4 🟡 HAUTE : Configurer les clés API dans Render
Depuis le Dashboard Render → Environment, ajouter :
- `BSD_API_KEY`, `FOOTBALLDATA_KEY`, `RAPIDAPI_KEY`
- `SUPABASE_URL` + `SUPABASE_ANON_KEY` + `SUPABASE_SERVICE_ROLE_KEY`
- `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID`

### 4.5 🟡 HAUTE : Améliorer la gestion des erreurs des permissions
- Attraper les erreurs de permissions PostgreSQL proprement
- Logger une seule fois au démarrage, pas à chaque cycle
- Désactiver les migrations qui nécessitent OWNER si l'utilisateur n'est pas propriétaire

### 4.6 🟡 HAUTE : Ajouter un mécanisme de seed data d'urgence
Créer un endpoint `/api/seed/emergency` qui insère 20-30 matchs de démonstration avec des prédictions simulées pour que le dashboard s'affiche même sans API externe.

### 4.7 🟡 MOYENNE : Nettoyer les logs
- Activer la rotation des logs (max 5 MB par fichier)
- Filtrer les erreurs PostgreSQL répétitives en erreur unique + compteur
- Archiver les logs de plus de 7 jours

### 4.8 🟡 MOYENNE : Dashboard Streamlit sur Render
Ajouter un service Render pour le dashboard Streamlit :
```yaml
- type: web
  name: prono-dashboard
  env: python
  buildCommand: pip install -r requirements.txt
  startCommand: streamlit run core/ultra_dashboard.py --server.port $PORT
```

### 4.9 🟢 BASSE : Améliorer les tests
- Ajouter des tests d'intégration qui vérifient les endpoints API avec une vraie base SQLite de test
- Mock les services externes pour les tests unitaires
- Supprimer les données de test factices de `accuracy_log.json`

### 4.10 🟢 BASSE : Ajouter un rapport dashboard dans le frontend
Créer un composant React qui affiche un résumé quotidien :
- Nombre de matchs analysés
- Top picks du jour
- Accuracy par ligue
- Santé des APIs

---

## 5. DIAGNOSTIC RAPIDE

| Métrique | Statut |
|---|---|
| Base SQLite locale | ❌ Vide (0 octets) |
| PostgreSQL (Neon/Supabase) | ⚠️ Permissions insuffisantes |
| Frontend (build dist) | ✅ OK (1.6 MB) |
| Scripts Python | ⚠️ Bridge instable |
| APIs externes | ❌ Non configurées en local |
| Tests Jest | ⚠️ Basiques, sans coverage réel |
| Logs | ✅ Présents mais saturés |
| Dashboard Streamlit | ❌ Non déployé |

---

## 6. PLAN D'ACTION RECOMMANDÉ

1. **Ce soir :** Corriger les permissions PostgreSQL via Supabase SQL Editor
2. **Ce soir :** Ajouter les clés API manquantes dans Render Dashboard
3. **Ce soir :** Créer un script de seed d'urgence pour peupler tactical.db
4. **Cette semaine :** Corriger la regex camelCase dans pg_database.js
5. **Cette semaine :** Mettre en place la rotation des logs
6. **Cette semaine :** Déployer le dashboard Streamlit
7. **Ce mois :** Ajouter des tests d'intégration
8. **Ce mois :** Nettoyer les données de test et le code mort
