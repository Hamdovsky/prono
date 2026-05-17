# -*- coding: utf-8 -*-
"""
test_fallback.py - Smoke test for the per-team xG estimator fix.
Verifies every match pair produces DISTINCT prediction percentages.
"""
import sys, io
# Force UTF-8 stdout so Unicode team names (e.g. Slavic/Azeri) don't crash on Windows
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8', errors='replace')

from prediction_engine import analyze_match_pro, _team_seed_xg, _league_xg_factor
import json

# ── Matches from the user's Telegram output ───────────────────────────────────
MATCHES = [
    # (homeTeam, awayTeam, league)
    ("River Plate", "Banfield",                   "Argentina: Liga Profesional de Fútbol"),
    ("Estudiantes de Río Cuarto", "Huracán",       "Argentina: Liga Profesional de Fútbol"),
    ("Sarmiento", "Club Atlético Unión de Santa Fe","Argentina: Liga Profesional de Fútbol"),
    ("Racing Club", "Independiente Rivadavia",      "Argentina: Liga Profesional de Fútbol"),
    ("Aldosivi", "Argentinos Juniors",              "Argentina: Liga Profesional de Fútbol"),
    ("Dynamo Kyiv", "FC Epicentr Dunaivtsi",        "Ukraine: Ukrainian Premier League"),
    ("Geylang International", "Young Lions",        "Singapore: Singapore Premier League"),
    ("Genoa U20", "Lazio U20",                      "Italy: Campionato Primavera 1"),
    ("Portuguesa", "AA Altos",                      "Brazil: Copa Betano do Brasil"),
    ("Ceará", "EC Primavera",                       "Brazil: Copa Betano do Brasil"),
    ("Kəpəz PFK", "Sumqayıt FK",                    "Azerbaijan: Misli Premier League"),
]

print("=" * 60)
print("  TEAM xG ESTIMATES (raw, before league factor)")
print("=" * 60)
for home, away, league in MATCHES:
    factor = _league_xg_factor(league)
    xg_h = round(_team_seed_xg(home) * factor, 2)
    xg_a = round(_team_seed_xg(away) * factor, 2)
    print(f"  {home:35s} xG={xg_h:.2f}")
    print(f"  {away:35s} xG={xg_a:.2f}  [×{factor} {league.split(':')[0]} factor]")
    print()

print("=" * 60)
print("  FULL PREDICTIONS (5 signals per match)")
print("=" * 60)

all_win_confs = []
for home, away, league in MATCHES:
    data = json.dumps({"homeTeam": home, "awayTeam": away, "league": league})
    preds = analyze_match_pro(data)
    win_conf = preds[0]["confidence"]
    all_win_confs.append(win_conf)
    print(f"\n{home} 🆚 {away}")
    print(f"  🏟️ {league}")
    for p in preds:
        print(f"    {p['label']:15} {p['val']:35} {p['confidence']}%")

# ── Assertion: must NOT all be identical ────────────────────────────────────
unique = len(set(all_win_confs))
total  = len(all_win_confs)
print(f"\n{'='*60}")
print(f"  Win Conf unique values: {unique}/{total}")
if unique > 1:
    print("  ✅ PASS — All matches have DIFFERENT prediction percentages")
else:
    print("  ❌ FAIL — All matches still share the same confidence!")
print("=" * 60)
