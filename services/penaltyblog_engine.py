import os, sys, json, pickle, time, logging, sqlite3
import pandas as pd
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import penaltyblog as pb

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DATA_DIR = os.path.join(BASE_DIR, 'data')
MODELS_DIR = os.path.join(DATA_DIR, 'penaltyblog_models')
CACHE_TTL_HOURS = 24

logging.basicConfig(level=logging.INFO, format='[PB] %(message)s')
log = logging.getLogger('Penaltyblog')


class PenaltyblogEngine:
    def __init__(self, db_path=None, bsd_api_key=None, bsd_base_url=None):
        self.db_path = db_path or os.path.join(DATA_DIR, 'historical_archive.sqlite')
        self.bsd_key = bsd_api_key or self._get_env_key('BSD_API_KEY')
        self.bsd_base = bsd_base_url or 'https://sports.bzzoiro.com/api'
        self.models = {}
        self.ratings_cache = {}
        os.makedirs(MODELS_DIR, exist_ok=True)

    def _resolve_table(self):
        """Return the correct historical matches table name."""
        for t in ['archive_matches', 'historical_matches']:
            try:
                conn = sqlite3.connect(self.db_path)
                conn.execute(f"SELECT 1 FROM {t} LIMIT 1")
                conn.close()
                return t
            except Exception:
                try: conn.close()
                except: pass
        return 'historical_matches'

    @staticmethod
    def _get_env_key(name):
        path = os.path.join(BASE_DIR, '.env')
        try:
            with open(path, 'r', encoding='utf-8') as f:
                for line in f:
                    line = line.strip()
                    if line.startswith(f'{name}='):
                        return line.split('=', 1)[1].strip().strip('"').strip("'")
        except Exception:
            pass
        return os.environ.get(name)

    def _load_historical_data(self, league, min_matches=20, max_matches=500):
        conn = sqlite3.connect(self.db_path)
        table = self._resolve_table()
        query = f"""
            SELECT homeTeam, awayTeam, scoreHome, scoreAway, timestamp
            FROM {table}
            WHERE league = ? AND scoreHome IS NOT NULL AND scoreAway IS NOT NULL
            ORDER BY timestamp DESC
            LIMIT ?
        """
        df = pd.read_sql_query(query, conn, params=(league, max_matches))
        conn.close()
        if len(df) < min_matches:
            return None
        df = df.iloc[::-1].reset_index(drop=True)
        return df

    def _get_bsd_odds(self, home, away):
        if not self.bsd_key:
            return None
        headers = {'Authorization': f'Token {self.bsd_key}'}
        today = time.strftime('%Y-%m-%d')
        url = f'{self.bsd_base}/v2/events/?date_from={today}&date_to={today}&limit=100'
        try:
            import requests
            r = requests.get(url, headers=headers, timeout=10)
            data = r.json()
            for e in data.get('results', []):
                ht = (e.get('home_team') or '').lower()
                at = (e.get('away_team') or '').lower()
                if home.lower() in ht and away.lower() in at:
                    mid = e.get('id')
                    r2 = requests.get(f'{self.bsd_base}/v2/events/{mid}/odds/', headers=headers, timeout=10)
                    o = r2.json().get('odds', {})
                    if o.get('home_win') is not None:
                        return {
                            'home_win': float(o['home_win']),
                            'draw': float(o['draw']),
                            'away_win': float(o['away_win']),
                            'over_25': float(o['over_25_goals']) if o.get('over_25_goals') else None,
                            'under_25': float(o['under_25_goals']) if o.get('under_25_goals') else None,
                            'btts_yes': float(o['btts_yes']) if o.get('btts_yes') else None,
                            'btts_no': float(o['btts_no']) if o.get('btts_no') else None,
                        }
        except Exception as ex:
            log.warning(f'BSD odds fetch error: {ex}')
        return None

    def fit_league_model(self, league, force=False):
        cache_path = os.path.join(MODELS_DIR, f"{league.replace(' ', '_').replace('/', '_')}.pkl")
        if not force and os.path.exists(cache_path):
            age = time.time() - os.path.getmtime(cache_path)
            if age < CACHE_TTL_HOURS * 3600:
                try:
                    with open(cache_path, 'rb') as f:
                        model_data = pickle.load(f)
                        if 'model' in model_data:
                            self.models[league] = model_data['model']
                            log.info(f'[Cache] Loaded Dixon-Coles for {league}')
                            return model_data['model']
                except Exception:
                    pass

        df = self._load_historical_data(league)
        if df is None:
            log.warning(f'[Fit] Not enough data for {league} (< 20 matches)')
            return None

        dates = pd.to_datetime(df['timestamp'])
        xi = 0.001
        weights = pb.models.dixon_coles_weights(dates, xi=xi)

        gh = df['scoreHome'].values.astype(int)
        ga = df['scoreAway'].values.astype(int)
        th = df['homeTeam'].values
        ta = df['awayTeam'].values

        try:
            model = pb.models.DixonColesGoalModel(gh, ga, th, ta, weights=weights)
            model.fit(
                use_gradient=True,
                minimizer_options={'maxiter': 3000, 'gtol': 1e-8, 'ftol': 1e-9, 'disp': False}
            )
            self.models[league] = model

            with open(cache_path, 'wb') as f:
                pickle.dump({'model': model, 'league': league, 'fitted_at': time.time()}, f)

            log.info(f'[Fit] Dixon-Coles for {league}: AIC={model.aic:.1f}, params={model.n_params}')
            return model
        except Exception as e:
            log.warning(f'[Fit] Failed for {league}: {e}')
            return None

    def predict_match(self, home_team, away_team, league, max_goals=15):
        league = league or 'Unknown'
        if league not in self.models:
            model = self.fit_league_model(league)
            if model is None:
                log.warning(f'[Predict] No model for {league}, trying BSD odds fallback')
                odds = self._get_bsd_odds(home_team, away_team)
                if odds:
                    implied = self.implied_probabilities(odds['home_win'], odds['draw'], odds['away_win'])
                    return {
                        'success': True,
                        'model': 'bsd_odds',
                        'home_win': implied['home_prob'],
                        'draw': implied['draw_prob'],
                        'away_win': implied['away_prob'],
                        'home_odds': odds['home_win'],
                        'draw_odds': odds['draw'],
                        'away_odds': odds['away_win'],
                        'over_25': odds.get('over_25'),
                        'under_25': odds.get('under_25'),
                        'btts_yes': odds.get('btts_yes'),
                        'btts_no': odds.get('btts_no'),
                        'implied_method': implied['method'],
                    }
                return {'success': False, 'error': f'No model for {league}'}

        model = self.models[league]
        try:
            pred = model.predict(home_team, away_team, max_goals=max_goals, normalize=True)
        except Exception as e:
            log.warning(f'[Predict] Model predict failed for {home_team} vs {away_team}: {e}')
            return {'success': False, 'error': str(e)}

        return {
            'success': True,
            'model': 'penaltyblog_dixon_coles',
            'league': league,
            'home_team': home_team,
            'away_team': away_team,
            'home_win': float(pred.home_win),
            'draw': float(pred.draw),
            'away_win': float(pred.away_win),
            'home_xg': float(pred.home_goal_expectation),
            'away_xg': float(pred.away_goal_expectation),
            'btts_yes': float(pred.btts_yes),
            'btts_no': float(pred.btts_no),
            'over_25': float(pred.total_goals('over', 2.5)),
            'under_25': float(pred.total_goals('under', 2.5)),
            'double_chance_1x': float(pred.double_chance_1x),
            'double_chance_x2': float(pred.double_chance_x2),
            'double_chance_12': float(pred.double_chance_12),
            'dnb_home': float(pred.draw_no_bet_home),
            'dnb_away': float(pred.draw_no_bet_away),
            'ah_home_minus_05': float(pred.asian_handicap('home', -0.5)),
            'ah_away_plus_05': float(pred.asian_handicap('away', +0.5)),
            'expected_points_home': float(pred.expected_points_home()),
            'expected_points_away': float(pred.expected_points_away()),
            'home_goal_dist': [float(x) for x in pred.home_goal_distribution()],
            'away_goal_dist': [float(x) for x in pred.away_goal_distribution()],
            'total_goal_dist': [float(x) for x in pred.total_goals_distribution()],
        }

    def predict_ou_btts(self, home_team, away_team, league):
        result = self.predict_match(home_team, away_team, league)
        if not result.get('success'):
            return result
        return {
            'success': True,
            'model': result['model'],
            'over_25': result['over_25'],
            'under_25': result['under_25'],
            'btts_yes': result['btts_yes'],
            'btts_no': result['btts_no'],
            'home_xg': result['home_xg'],
            'away_xg': result['away_xg'],
        }

    @staticmethod
    def implied_probabilities(home_odds, draw_odds, away_odds, method='power'):
        valid_odds = [o for o in [home_odds, draw_odds, away_odds] if o and o > 0]
        if len(valid_odds) < 2:
            return {'home_prob': None, 'draw_prob': None, 'away_prob': None, 'method': method}

        try:
            result = pb.implied.calculate_implied(
                [home_odds or 0, draw_odds or 0, away_odds or 0],
                method=method,
                odds_format='decimal',
                market_names=['home', 'draw', 'away']
            )
            return {
                'home_prob': float(result.probabilities[0]),
                'draw_prob': float(result.probabilities[1]),
                'away_prob': float(result.probabilities[2]),
                'method': result.method,
            }
        except Exception as e:
            log.warning(f'Implied probs error: {e}')
            fair_total = sum(1 / o for o in valid_odds)
            margin = fair_total - 1
            if margin <= 0:
                return {'home_prob': 1/home_odds if home_odds else 0,
                        'draw_prob': 1/draw_odds if draw_odds else 0,
                        'away_prob': 1/away_odds if away_odds else 0,
                        'method': 'raw'}
            return {
                'home_prob': (1/home_odds / fair_total) if home_odds else 0,
                'draw_prob': (1/draw_odds / fair_total) if draw_odds else 0,
                'away_prob': (1/away_odds / fair_total) if away_odds else 0,
                'method': 'simple_normalized',
            }

    @staticmethod
    def calculate_ratings(home_team, away_team, home_goals, away_goals, rating_type='elo'):
        try:
            if rating_type == 'elo':
                ratings = pb.ratings.Elo(home_team, away_team, home_goals, away_goals)
            elif rating_type == 'massey':
                ratings = pb.ratings.Massey(home_team, away_team, home_goals, away_goals)
            elif rating_type == 'colley':
                ratings = pb.ratings.Colley(home_team, away_team, home_goals, away_goals)
            elif rating_type == 'pi':
                ratings = pb.ratings.Pi(home_team, away_team, home_goals, away_goals)
            else:
                return {}
            return ratings.get_ratings()
        except Exception as e:
            log.warning(f'Ratings error ({rating_type}): {e}')
            return {}

    def fit_all_leagues(self, min_matches=20):
        conn = sqlite3.connect(self.db_path)
        tbl = self._resolve_table()
        query = f"""
            SELECT league, COUNT(*) as cnt
            FROM {tbl}
            WHERE scoreHome IS NOT NULL AND scoreAway IS NOT NULL
            GROUP BY league
            HAVING cnt >= ?
            ORDER BY cnt DESC
        """
        df = pd.read_sql_query(query, conn, params=(min_matches,))
        conn.close()

        results = {}
        for league in df['league'].tolist():
            log.info(f'[FitAll] Processing {league}...')
            model = self.fit_league_model(league)
            results[league] = 'fitted' if model else 'skipped'
        return results

    def backtest_league(self, league, test_size=50):
        df = self._load_historical_data(league, min_matches=20, max_matches=500)
        if df is None or len(df) < test_size + 20:
            return {'error': f'Not enough data for backtest in {league}'}

        train_df = df.iloc[:-test_size]
        test_df = df.iloc[-test_size:].copy()

        gh_train = train_df['scoreHome'].values.astype(int)
        ga_train = train_df['scoreAway'].values.astype(int)
        th_train = train_df['homeTeam'].values
        ta_train = train_df['awayTeam'].values

        dates_train = pd.to_datetime(train_df['timestamp'])
        weights = pb.models.dixon_coles_weights(dates_train, xi=0.001)

        try:
            model = pb.models.DixonColesGoalModel(gh_train, ga_train, th_train, ta_train, weights=weights)
            model.fit(use_gradient=True, minimizer_options={'maxiter': 3000, 'disp': False})
        except Exception as e:
            return {'error': f'Fit failed: {e}'}

        results = []
        for _, row in test_df.iterrows():
            try:
                pred = model.predict(row['homeTeam'], row['awayTeam'], max_goals=15, normalize=True)
                actual_h = int(row['scoreHome'])
                actual_a = int(row['scoreAway'])
                actual_1x2 = 1 if actual_h > actual_a else (0 if actual_h == actual_a else 2)
                results.append({
                    'home': row['homeTeam'],
                    'away': row['awayTeam'],
                    'actual_h': actual_h,
                    'actual_a': actual_a,
                    'prob_h': float(pred.home_win),
                    'prob_d': float(pred.draw),
                    'prob_a': float(pred.away_win),
                    'prob_over25': float(pred.total_goals('over', 2.5)),
                    'prob_btts': float(pred.btts_yes),
                    'predicted_1x2': 1 if pred.home_win > pred.away_win else (0 if pred.draw > pred.home_win and pred.draw > pred.away_win else 2),
                    'actual_1x2': actual_1x2,
                })
            except Exception as e:
                log.warning(f'Backtest prediction error: {e}')

        if not results:
            return {'error': 'No predictions in backtest'}

        correct = sum(1 for r in results if r['predicted_1x2'] == r['actual_1x2'])
        brier = np.mean([(r['prob_h'] - (1 if r['actual_1x2'] == 1 else 0))**2 +
                         (r['prob_d'] - (1 if r['actual_1x2'] == 0 else 0))**2 +
                         (r['prob_a'] - (1 if r['actual_1x2'] == 2 else 0))**2 for r in results])

        log.info(f'[Backtest] {league}: accuracy={correct}/{len(results)} ({100*correct/len(results):.1f}%), Brier={brier:.4f}')
        return {
            'league': league,
            'test_size': len(results),
            'accuracy': correct / len(results) if results else 0,
            'correct': correct,
            'brier_score': float(brier),
            'details': results,
        }


# ────────────────────────────────────────────────────────────
# BAYESIAN HIERARCHICAL — Low-Data Handler (Club Friendlies)
# ────────────────────────────────────────────────────────────

LEAGUE_CATEGORY_PRIORS = {
    'club friendly': {
        'avg_goals': 2.8, 'home_win_rate': 0.42, 'draw_rate': 0.25,
        'away_win_rate': 0.33, 'btts_rate': 0.55, 'over25_rate': 0.52,
        'avg_home_xg': 1.45, 'avg_away_xg': 1.35,
    },
    'cup': {
        'avg_goals': 2.5, 'home_win_rate': 0.45, 'draw_rate': 0.24,
        'away_win_rate': 0.31, 'btts_rate': 0.48, 'over25_rate': 0.48,
        'avg_home_xg': 1.35, 'avg_away_xg': 1.15,
    },
    'default': {
        'avg_goals': 2.7, 'home_win_rate': 0.46, 'draw_rate': 0.24,
        'away_win_rate': 0.30, 'btts_rate': 0.50, 'over25_rate': 0.50,
        'avg_home_xg': 1.40, 'avg_away_xg': 1.20,
    },
}


class LeaguePriorBank:
    """Banque de priors extraits des ligues bien fournies pour alimenter les low-data."""

    def __init__(self, db_path=None):
        self.db_path = db_path or os.path.join(DATA_DIR, 'historical_archive.sqlite')
        self._cache = None
        self._avg_attack = None
        self._avg_defense = None

    def _resolve_table(self):
        for t in ['archive_matches', 'historical_matches']:
            try:
                conn = sqlite3.connect(self.db_path)
                conn.execute(f"SELECT 1 FROM {t} LIMIT 1")
                conn.close()
                return t
            except Exception:
                try: conn.close()
                except: pass
        return 'historical_matches'

    def _load_league_priors(self, force=False):
        if self._cache is not None and not force:
            return self._cache
        self._cache = {}
        conn = sqlite3.connect(self.db_path)
        tbl = self._resolve_table()
        try:
            rows = conn.execute(f"""
                SELECT league, AVG(scoreHome) as avg_h, AVG(scoreAway) as avg_a,
                       SUM(CASE WHEN scoreHome > scoreAway THEN 1 ELSE 0 END) * 1.0 / COUNT(*) as home_win_rate,
                       SUM(CASE WHEN scoreHome = scoreAway THEN 1 ELSE 0 END) * 1.0 / COUNT(*) as draw_rate,
                       SUM(CASE WHEN scoreHome > 0 AND scoreAway > 0 THEN 1 ELSE 0 END) * 1.0 / COUNT(*) as btts_rate,
                       SUM(CASE WHEN scoreHome + scoreAway > 2.5 THEN 1 ELSE 0 END) * 1.0 / COUNT(*) as over25_rate,
                       COUNT(*) as cnt
                FROM {tbl}
                WHERE scoreHome IS NOT NULL AND scoreAway IS NOT NULL
                GROUP BY league HAVING cnt >= 30
            """).fetchall()
            for r in rows:
                self._cache[r[0]] = {
                    'avg_home_goals': r[1], 'avg_away_goals': r[2],
                    'home_win_rate': r[3], 'draw_rate': r[4],
                    'btts_rate': r[5], 'over25_rate': r[6],
                    'match_count': r[7],
                }

            all_att_def = conn.execute(f"""
                SELECT AVG(scoreHome), AVG(scoreAway), COUNT(*) as cnt
                FROM {tbl}
                WHERE scoreHome IS NOT NULL AND scoreAway IS NOT NULL
            """).fetchone()
            if all_att_def:
                self._avg_attack = all_att_def[0] or 1.4
                self._avg_defense = all_att_def[1] or 1.2
        except Exception:
            self._avg_attack = 1.4
            self._avg_defense = 1.2
        finally:
            conn.close()
        return self._cache

    def get_priors_for(self, league):
        """Retourne les priors pour une ligue, en cascade: ligue exacte -> categorie -> defaults."""
        self._load_league_priors()
        league_lower = league.lower().strip()

        if league_lower in self._cache:
            return self._cache[league_lower]

        for known, priors in self._cache.items():
            if known.lower() in league_lower or league_lower in known.lower():
                return priors

        for cat_key, cat_priors in LEAGUE_CATEGORY_PRIORS.items():
            if cat_key in league_lower:
                return {
                    'avg_home_goals': cat_priors['avg_home_xg'],
                    'avg_away_goals': cat_priors['avg_away_xg'],
                    'home_win_rate': cat_priors['home_win_rate'],
                    'draw_rate': cat_priors['draw_rate'],
                    'btts_rate': cat_priors['btts_rate'],
                    'over25_rate': cat_priors['over25_rate'],
                    'match_count': 0,
                    '_category_prior': cat_key,
                }

        return {
            'avg_home_goals': self._avg_attack or 1.4,
            'avg_away_goals': self._avg_defense or 1.2,
            'home_win_rate': 0.46, 'draw_rate': 0.24,
            'btts_rate': 0.50, 'over25_rate': 0.50,
            'match_count': 0, '_category_prior': 'default',
        }


class BayesianLowDataHandler:
    """Handler spécialisé pour les matchs à données quasi-nulles (Club Friendlies, etc.)
    Utilise HierarchicalBayesianGoalModel pour inférer via les priors de ligue."""

    def __init__(self, db_path=None):
        self.db_path = db_path or os.path.join(DATA_DIR, 'historical_archive.sqlite')
        self.prior_bank = LeaguePriorBank(db_path)
        self._bayesian_models = {}

    def _resolve_table(self):
        for t in ['archive_matches', 'historical_matches']:
            try:
                conn = sqlite3.connect(self.db_path)
                conn.execute(f"SELECT 1 FROM {t} LIMIT 1")
                conn.close()
                return t
            except Exception:
                try: conn.close()
                except: pass
        return 'historical_matches'

    def _collect_similar_matches(self, league, max_matches=200):
        """Collecte les matchs de ligues similaires pour enrichir le prior."""
        league_lower = league.lower().strip()
        if 'friendly' in league_lower:
            keywords = ['friendly', 'club friendly', 'friendlies']
        elif 'cup' in league_lower or 'cup' in league:
            keywords = ['cup']
        else:
            keywords = [league_lower[:5]]

        conn = sqlite3.connect(self.db_path)
        results = []
        tbl = self._resolve_table()
        try:
            cond = ' OR '.join([f"league LIKE '%{k}%'" for k in keywords])
            rows = conn.execute(f"""
                SELECT homeTeam, awayTeam, scoreHome, scoreAway, timestamp
                FROM {tbl}
                WHERE ({cond}) AND scoreHome IS NOT NULL AND scoreAway IS NOT NULL
                ORDER BY timestamp DESC LIMIT ?
            """, (max_matches,)).fetchall()
            results = [
                {'home': r[0], 'away': r[1], 'home_goals': int(r[2]),
                 'away_goals': int(r[3]), 'timestamp': r[4] or ''}
                for r in rows if r[2] is not None and r[3] is not None
            ]
        except Exception as e:
            log.warning(f'[Bayesian] Similar match query failed: {e}')
        finally:
            conn.close()
        return results

    def fit_bayesian(self, league, force=False):
        """Fit un HierarchicalBayesianGoalModel pour une low-data league."""
        if league in self._bayesian_models and not force:
            return self._bayesian_models[league]

        matches = self._collect_similar_matches(league)
        if len(matches) < 5:
            log.warning(f'[Bayesian] Not enough similar matches for {league} ({len(matches)})')
            return None

        gh = np.array([m['home_goals'] for m in matches], dtype=int)
        ga = np.array([m['away_goals'] for m in matches], dtype=int)
        th = np.array([m['home'] for m in matches])
        ta = np.array([m['away'] for m in matches])

        try:
            model = pb.models.HierarchicalBayesianGoalModel(gh, ga, th, ta)
            model.fit(n_samples=2000, burn=1000, n_chains=2, thin=1)
            self._bayesian_models[league] = model
            log.info(f'[Bayesian] Fitted hierarchical model for {league} ({len(matches)} matches)')
            return model
        except Exception as e:
            log.warning(f'[Bayesian] Fit failed for {league}: {e}')
            return None

    def predict_zero_data(self, home_team, away_team, league, bookmaker_odds=None):
        """Prédiction pour match sans historique direct.
        Pipeline: 1. Implied odds baseline -> 2. Bayesian prior blend -> 3. DC blend.
        """
        priors = self.prior_bank.get_priors_for(league)
        is_low_data = 'friendly' in league.lower() or priors.get('match_count', 50) < 20

        implied = None
        if bookmaker_odds:
            implied = PenaltyblogEngine.implied_probabilities(
                bookmaker_odds[0], bookmaker_odds[1], bookmaker_odds[2]
            )

        bayesian = None
        model = self.fit_bayesian(league)
        if model:
            try:
                bayesian = model.predict(home_team, away_team, max_goals=15, normalize=True)
            except Exception:
                try:
                    bayesian = model.predict(home_team, away_team, max_goals=10, normalize=True)
                except Exception as e:
                    log.warning(f'[Bayesian] Predict failed: {e}')

        # Blending strategy
        if bayesian and implied and implied.get('home_prob'):
            w_implied = 0.35 if is_low_data else 0.20
            w_bayes = 0.65 if is_low_data else 0.80
            p_h = w_bayes * float(bayesian.home_win) + w_implied * implied['home_prob']
            p_d = w_bayes * float(bayesian.draw) + w_implied * implied['draw_prob']
            p_a = w_bayes * float(bayesian.away_win) + w_implied * implied['away_prob']
            src = 'bayesian+implied'
        elif bayesian:
            p_h = float(bayesian.home_win)
            p_d = float(bayesian.draw)
            p_a = float(bayesian.away_win)
            src = 'bayesian_hierarchical'
        elif implied and implied.get('home_prob'):
            p_h = implied['home_prob']
            p_d = implied['draw_prob']
            p_a = implied['away_prob']
            src = 'implied_odds'
        else:
            p_h = priors.get('home_win_rate', 0.46)
            p_d = priors.get('draw_rate', 0.24)
            p_a = priors.get('away_win_rate', 0.30)
            src = 'league_prior'

        s = p_h + p_d + p_a
        if s > 0:
            p_h, p_d, p_a = p_h/s, p_d/s, p_a/s
        else:
            p_h, p_d, p_a = 0.46, 0.24, 0.30

        avg_home_xg = priors.get('avg_home_goals', 1.4)
        avg_away_xg = priors.get('avg_away_goals', 1.2)

        btts_rate = priors.get('btts_rate', 0.50)
        over25_rate = priors.get('over25_rate', 0.50)

        log.info(f'[ZeroData] {home_team} vs {away_team} [{league}] -> {src}: {p_h:.3f}/{p_d:.3f}/{p_a:.3f}')
        return {
            'success': True,
            'model': src,
            'home_team': home_team,
            'away_team': away_team,
            'league': league,
            'home_win': round(p_h, 4),
            'draw': round(p_d, 4),
            'away_win': round(p_a, 4),
            'home_xg': round(avg_home_xg, 2),
            'away_xg': round(avg_away_xg, 2),
            'btts_yes': round(btts_rate, 4),
            'btts_no': round(1.0 - btts_rate, 4),
            'over_25': round(over25_rate, 4),
            'under_25': round(1.0 - over25_rate, 4),
            'double_chance_1x': round(p_h + p_d, 4),
            'double_chance_x2': round(p_d + p_a, 4),
            'double_chance_12': round(p_h + p_a, 4),
            'is_low_data': is_low_data,
            'prior_source': priors.get('_category_prior', 'default'),
        }


if __name__ == '__main__':
    engine = PenaltyblogEngine()
    print('\n=== Fitting all leagues ===')
    results = engine.fit_all_leagues(min_matches=20)
    for league, status in results.items():
        print(f'  {league:30s} -> {status}')

    print('\n=== Test prediction (Dixon-Coles) ===')
    pred = engine.predict_match('Man City', 'Liverpool', 'Premier League')
    if pred.get('success'):
        print(f'  1X2: {pred["home_win"]:.3f} / {pred["draw"]:.3f} / {pred["away_win"]:.3f}')
        print(f'  xG:  {pred["home_xg"]:.2f} - {pred["away_xg"]:.2f}')
        print(f'  O2.5: {pred["over_25"]:.1%}  BTTS: {pred["btts_yes"]:.1%}')

    print('\n=== Zero-Data Test (Club Friendly) ===')
    handler = BayesianLowDataHandler()
    z = handler.predict_zero_data('Mallorca', 'Al-Ittihad', 'Club Friendlies')
    print(f'  1X2: {z["home_win"]:.3f} / {z["draw"]:.3f} / {z["away_win"]:.3f}')
    print(f'  xG:  {z["home_xg"]:.2f} - {z["away_xg"]:.2f}')
    print(f'  Model: {z["model"]}')

    z2 = handler.predict_zero_data('Bournemouth', 'FC Augsburg', 'Club Friendlies',
                                   bookmaker_odds=[2.10, 3.50, 3.30])
    if z2.get('success'):
        print(f'  With implied: {z2["home_win"]:.3f} / {z2["draw"]:.3f} / {z2["away_win"]:.3f}')
        print(f'  Model: {z2["model"]}')

    print('\n=== Implied probabilities ===')
    implied = PenaltyblogEngine.implied_probabilities(2.10, 3.40, 3.80)
    print(f'  {implied}')

    print('\n=== League Prior Bank ===')
    bank = LeaguePriorBank()
    for test_league in ['Premier League', 'Club Friendlies', 'UEFA Europa League', 'Unknown Cup']:
        p = bank.get_priors_for(test_league)
        print(f'  {test_league:25s} -> H={p.get("home_win_rate",0):.2f} D={p.get("draw_rate",0):.2f} '
              f'A={p.get("away_win_rate",0):.2f} BTTS={p.get("btts_rate",0):.2f}')

    print('\n=== Backtest ===')
    bt = engine.backtest_league('Premier League', test_size=50)
    if 'accuracy' in bt:
        print(f'  Accuracy: {bt["accuracy"]:.1%}  Brier: {bt["brier_score"]:.4f}')
