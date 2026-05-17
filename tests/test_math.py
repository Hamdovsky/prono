import math
import random

def calculate_exact_score(xg_h, xg_a, p_home, p_away, h_vol=1.0, a_vol=1.0, h_def_mod=1.0, a_def_mod=1.0):
    xg_h_eff = xg_h * h_vol
    xg_a_eff = xg_a * a_vol
    
    if xg_h_eff > xg_a_eff + 1.2:
        h_final = math.ceil(xg_h_eff) 
        a_final = math.floor(xg_a_eff)
    elif xg_a_eff > xg_h_eff + 1.2:
        a_final = math.ceil(xg_a_eff)
        h_final = math.floor(xg_h_eff)
    else:
        h_final = int(round(xg_h_eff))
        a_final = int(round(xg_a_eff))

    if abs(h_final - a_final) <= 1:
        if random.random() < 0.25:
            if h_final > 0: h_final -= 1
            else: h_final += 1

    if (a_def_mod < 0.85 or xg_a_eff < 0.65) and xg_a_eff < 1.0:
        a_final = 0
    if (h_def_mod < 0.85 or xg_h_eff < 0.65) and xg_h_eff < 1.0:
        h_final = 0

    if p_home > 45 and h_final <= a_final:
        h_final = a_final + 1
    elif p_away > 45 and a_final <= h_final:
        a_final = h_final + 1

    h_final = max(0, min(7, h_final))
    a_final = max(0, min(7, a_final))
    return f"{h_final} - {a_final}"

def _team_seed_xg(team_name, match_id):
    seed = sum(ord(c) for c in team_name) + int(str(match_id)[-3:] or 0)
    return 0.8 + (seed % 100) / 50.0 # 0.8 to 2.8

for i in range(10):
    # simulate fallback scenario
    xg_h = _team_seed_xg(f"Team{i}", f"100{i}")
    xg_a = _team_seed_xg(f"Opponent{i}", f"100{i}")
    score = calculate_exact_score(xg_h, xg_a, 50, 20)
    print(f"Fallback {i}: {xg_h:.2f} vs {xg_a:.2f} -> {score}")
