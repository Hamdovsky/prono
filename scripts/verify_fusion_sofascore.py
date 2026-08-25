import sys, os, json
sys.path.insert(0, 'services')
import importlib.util
spec = importlib.util.spec_from_file_location('ofe', 'services/oddsFusionEngine.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
eng = m.OddsFusionEngine()
with open('data/today_matches.json', 'r', encoding='utf-8') as f:
    matches = json.load(f)
sofa = 0
total = 0
for mt in matches:
    home = mt.get('home')
    away = mt.get('away')
    lg = mt.get('league', '')
    if not home or not away:
        continue
    total += 1
    o = eng.get_odds(home, away, lg)
    if o.get('source') == 'sofascore':
        sofa += 1
        print('[sofascore] %s vs %s: H=%s D=%s A=%s OU=%s/%s BTTS=%s/%s tiers=%s' % (
            home, away, o['home_win'], o['draw'], o['away_win'],
            o['over_25'], o['under_25'], o['btts_yes'], o['btts_no'], o['_tiers']))
print('---')
print('Total matchs: %d | source=sofascore: %d' % (total, sofa))
