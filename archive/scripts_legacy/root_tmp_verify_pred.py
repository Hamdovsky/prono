"""Verify model predictions with full archive"""
import sys; sys.path.insert(0, 'core')
from prediction_engine import process_prediction

tests = [
    ('Man City vs Arsenal H2.1/D3.5/A3.4', {'homeTeam':'Man City','awayTeam':'Arsenal','league':'E0','tournament_name':'Premier League','odds_home':2.1,'odds_draw':3.5,'odds_away':3.4,'startTimestamp':0,'force_predict':True}),
    ('Bayern vs Augsburg H6.0/D4.5/A1.5', {'homeTeam':'Augsburg','awayTeam':'Bayern Munich','league':'D1','tournament_name':'Bundesliga','odds_home':6.0,'odds_draw':4.5,'odds_away':1.5,'startTimestamp':0,'force_predict':True}),
    ('Everton vs Liverpool H4.0/D3.6/A1.85', {'homeTeam':'Everton','awayTeam':'Liverpool','league':'E0','tournament_name':'Premier League','odds_home':4.0,'odds_draw':3.6,'odds_away':1.85,'startTimestamp':0,'force_predict':True}),
    ('Barcelona vs Real Madrid H2.2/D3.4/A3.2', {'homeTeam':'Barcelona','awayTeam':'Real Madrid','league':'SP1','tournament_name':'La Liga','odds_home':2.2,'odds_draw':3.4,'odds_away':3.2,'startTimestamp':0,'force_predict':True}),
]

for label, mo in tests:
    pred = process_prediction(mo)
    if pred.get('success'):
        h = pred.get('home_win_probability', pred.get('xgboost_probs_h', 0))
        d = pred.get('draw_probability', pred.get('xgboost_probs_d', 0))
        a = pred.get('away_win_probability', pred.get('xgboost_probs_a', 0))
        if h > d and h > a: pick = 'HOME'
        elif d > h and d > a: pick = 'DRAW'
        else: pick = 'AWAY'
        print(f'{label}: H={h:.3f} D={d:.3f} A={a:.3f} -> {pick}')
    else:
        err = pred.get('error', '?')
        print(f'{label}: FAILED - {err}')
