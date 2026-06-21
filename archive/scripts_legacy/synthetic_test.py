import sys, json, os

sys.path.insert(0, os.path.join(os.getcwd(), 'core'))
import top_analyst_engine

match = {
    'homeTeam': 'Real Madrid',
    'awayTeam': 'Barcelona',
    'home_xg': 2.8,
    'away_xg': 1.1,
    'odds_home_open': 2.50,
    'odds_home': 1.95,
    'odds_draw': 3.60,
    'odds_away': 3.40,
    'player_ratings_home': '[{"rating": 8.5}, {"rating": 8.2}]',
    'player_ratings_away': '[{"rating": 7.0}, {"rating": 7.1}]'
}

print('=== ⚽ TOP ANALYST ENGINE - MATHEMATICAL TEST ===')
try:
    res = top_analyst_engine.process_match_for_top_analyst(match)
    feats = res['ml_features']

    print('Prediction String: ' + res['direct_prediction'])
    print('Feature Vector Size: ' + str(len(feats)))
    print('Sharp Money Home: ' + str(feats['ta_sharp_money_h']))
    print('Value Bet Flag: ' + str(feats['ta_value_bet_flag']))
    print('Home Rating Avg: ' + str(feats['ta_h_rating']))
    print('Away Rating Avg: ' + str(feats['ta_a_rating']))
    print('Rating Diff: ' + str(round(feats['ta_rating_diff'], 2)))

    if len(feats) == 27 and feats['ta_sharp_money_h'] == 1.0 and feats['ta_h_rating'] == 8.35:
        print('\n✅ SYSTEM HEALTHY. ALL MODULES OPERATIONAL.')
    else:
        print('\n❌ SYSTEM FAILED.')
except Exception as e:
    print('Error:', str(e))
