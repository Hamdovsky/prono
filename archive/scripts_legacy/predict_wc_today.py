import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'core'))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))
os.chdir(os.path.join(os.path.dirname(__file__), '..'))

from ml_features import extract_ml_features, FEATURE_NAMES_V553, get_wc2026_team_data
import xgboost as xgb

wc_data = get_wc2026_team_data()
print('[WC2026] Teams loaded: %d' % (len(wc_data) if wc_data else 0))
print()

bst = xgb.Booster()
bst.load_model('models/stitch_v553_premium.json')

matches = [
    ('Czech Republic', 'South Africa'),
    ('Switzerland', 'Bosnia & Herzegovina'),
    ('Canada', 'Qatar'),
    ('Mexico', 'South Korea'),
    ('USA', 'Australia'),
    ('Scotland', 'Morocco'),
    ('Brazil', 'Haiti'),
    ('Turkey', 'Paraguay'),
    ('Netherlands', 'Sweden'),
    ('Germany', 'Ivory Coast'),
]

team_map = {
    'Bosnia & Herzegovina': 'bosnia and herzegovina',
    'USA': 'usa',
    'Ivory Coast': 'cote d\'ivoire',
    'Czech Republic': 'czechia',
    'Turkey': 'turkiye',
    'South Korea': 'korea republic',
}

results = []
for home, away in matches:
    h = team_map.get(home, home)
    a = team_map.get(away, away)

    row = {'homeTeam': h, 'awayTeam': a}
    features = extract_ml_features(row)

    vec = [float(features.get(f, 0)) for f in FEATURE_NAMES_V553]
    dmat = xgb.DMatrix([vec], feature_names=FEATURE_NAMES_V553)
    probs = bst.predict(dmat)[0]

    labels = ['Home', 'Draw', 'Away']
    verdict = labels[probs.argmax()]

    fifa_h = int(features.get('fifa_rank_h', 999))
    fifa_a = int(features.get('fifa_rank_a', 999))

    results.append((home, away, probs[0]*100, probs[1]*100, probs[2]*100, verdict, fifa_h, fifa_a))

# Print table
print('=' * 70)
print('  WORLD CUP 2026 — PREDICTIONS V553_PREMIUM')
print('=' * 70)
print('  %-25s %-25s %-15s %-10s' % ('HOME', 'AWAY', '1 / N / 2', 'FIFA'))
print('  ' + '-' * 70)
for h, a, p1, pn, p2, v, fh, fa in results:
    line = '  %-25s %-25s' % (h[:24], a[:24])
    line += ' %4.1f%%/%s/%-4.1f%%' % (p1, '%.1f%%' % pn if pn > 9 else ' %s%% ' % ('%.1f' % pn), p2)
    # highlight winner
    if v == 'Home':
        line += '  >>> 1  FIFA: %d vs %d' % (fh, fa)
    elif v == 'Draw':
        line += '  >>> N  FIFA: %d vs %d' % (fh, fa)
    else:
        line += '  >>> 2  FIFA: %d vs %d' % (fh, fa)
    print(line)
print('=' * 70)
