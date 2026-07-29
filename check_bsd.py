import json, urllib.request
d = json.loads(urllib.request.urlopen('https://prono.onrender.com/api/promosport').read())
matches = d.get('matches', [])
for m in matches:
    bp = m.get('bsdProbs')
    print(f"{m['homeTeam']:>30s} vs {m['awayTeam']:<30s} bsdProbs={bp}")
print(f"\nTotal: {len(matches)}, with BSD: {sum(1 for m in matches if m.get('bsdProbs'))}")
