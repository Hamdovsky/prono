import sys, os, json, requests
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'core'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
os.chdir(os.path.join(os.path.dirname(__file__), '..'))

from ml_features import extract_ml_features, FEATURE_NAMES_V553, get_wc2026_team_data
import xgboost as xgb

get_wc2026_team_data()

bst = xgb.Booster()
bst.load_model('models/stitch_v553_premium.json')

BSD_KEY = 'f23756ae5c82f2aca4eabc42cbb19c49ec35e057'
headers = {'Authorization': 'Token ' + BSD_KEY}
r = requests.get('https://sports.bzzoiro.com/api/v2/events/?date_from=2026-06-18&date_to=2026-06-18&limit=200', headers=headers, timeout=15)
events = r.json().get('results', [])

matches = [
    ('Canada', 'Qatar'),
    ('Switzerland', 'Bosnia & Herzegovina'),
    ('Czechia', 'South Africa')
]

team_map = {'Czechia': 'Czech Republic', 'Bosnia & Herzegovina': 'Bosnia-Herzegovina'}

for home, away in matches:
    h = team_map.get(home, home)
    a = team_map.get(away, away)

    odds_h, odds_d, odds_a = None, None, None
    for ev in events:
        ev_h = ev.get('home_team',{}).get('name','') if isinstance(ev.get('home_team'),dict) else ev.get('home_team','')
        ev_a = ev.get('away_team',{}).get('name','') if isinstance(ev.get('away_team'),dict) else ev.get('away_team','')
        if home.lower() in ev_h.lower() and away.lower() in ev_a.lower():
            odds = ev.get('odds', {})
            if not isinstance(odds, dict):
                odds = {}
            odds_h = odds.get('home_win') or ev.get('odds_home')
            odds_d = odds.get('draw') or ev.get('odds_draw')
            odds_a = odds.get('away_win') or ev.get('odds_away')
            break

    row = {
        'homeTeam': h,
        'awayTeam': a,
        'odds_h': odds_h or 2.0,
        'odds_d': odds_d or 3.3,
        'odds_a': odds_a or 3.5,
    }

    features = extract_ml_features(row)

    vec = [float(features.get(f, 0)) for f in FEATURE_NAMES_V553]
    dmat = xgb.DMatrix([vec], feature_names=FEATURE_NAMES_V553)
    probs = bst.predict(dmat)[0]

    labels = ['Home', 'Draw', 'Away']
    verdict = labels[probs.argmax()]

    print('')
    print('-' * 45)
    print('  %s vs %s' % (h, a))
    print('-' * 45)
    print('  Odds: %s / %s / %s' % (odds_h or '-', odds_d or '-', odds_a or '-'))
    print('  Probs: Home %.1f%% | Draw %.1f%% | Away %.1f%%' % (probs[0]*100, probs[1]*100, probs[2]*100))
    print('  Verdict: %s (conf: %.1f%%)' % (verdict, probs[probs.argmax()]*100))
