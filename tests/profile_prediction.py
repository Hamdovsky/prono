import sys
import os
import cProfile
import pstats
import io

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'core'))

from prediction_engine import process_prediction

match_obj = {
    'homeTeam': 'Arsenal',
    'awayTeam': 'Chelsea',
    'league': 'Premier League',
    'tournament_name': '',
    'odds_home': 1.80,
    'odds_draw': 3.50,
    'odds_away': 4.50,
    'odds_home_open': 1.85,
    'odds_draw_open': 3.40,
    'odds_away_open': 4.20,
    'home_xg': 1.8,
    'away_xg': 1.3,
    'startTimestamp': 1720000000,
    'weather_desc': 'Clear',
    'weather_temp': 22,
}

N_RUNS = 5
all_stats = {}

print(f"=== Profiling process_prediction() x{N_RUNS} runs ===\n")

for i in range(N_RUNS):
    print(f"--- Run {i+1}/{N_RUNS} ---")
    profiler = cProfile.Profile()
    profiler.enable()
    result = process_prediction(match_obj)
    profiler.disable()
    
    if result.get('success'):
        print(f"  Verdict: {result.get('verdict')} | Confidence: {result.get('surgical_confidence')}%")
    
    stream = io.StringIO()
    stats = pstats.Stats(profiler, stream=stream)
    stats.sort_stats('cumulative')
    
    for key, value in stats.stats.items():
        filename, line, func = key
        cc, nc, tt, ct, callers = value
        if key not in all_stats:
            all_stats[key] = {'nc': 0, 'tt': 0.0, 'ct': 0.0}
        all_stats[key]['nc'] += nc
        all_stats[key]['tt'] += tt
        all_stats[key]['ct'] += ct

print("\n\n=== AGGREGATE RESULTS (Top 20 by cumulative time) ===\n")
print(f"{'Rank':<5} {'Cumul Time':>12} {'Tot Time':>12} {'# Calls':>10}  {'Function'}")
print("-" * 95)

sorted_items = sorted(all_stats.items(), key=lambda x: x[1]['ct'], reverse=True)
for rank, (key, val) in enumerate(sorted_items[:20], 1):
    filename, line, func = key
    short_file = os.path.basename(filename)
    print(f"{rank:<5} {val['ct']:>11.4f}s {val['tt']:>11.4f}s {val['nc']:>10}  {short_file}:{line} ({func})")
