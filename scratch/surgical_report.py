import json
import math
import random
import sys

# Ensure UTF-8 output
if sys.platform == 'win32':
    import io
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')

# Mocking the surgical logic based on the user's rules
def poisson_prob(lam, k):
    return (math.exp(-lam) * (lam**k)) / math.factorial(k)

def calculate_probs(xg_h, xg_a):
    pH, pD, pA = 0, 0, 0
    pBTTS = 0
    pOver25 = 0
    pHTGoal = 0
    
    # 1st half approximation
    ht_xg_h = xg_h * 0.45
    ht_xg_a = xg_a * 0.45
    
    for h in range(7):
        for a in range(7):
            prob = poisson_prob(xg_h, h) * poisson_prob(xg_a, a)
            if h > a: pH += prob
            elif h < a: pA += prob
            else: pD += prob
            
            if h > 0 and a > 0: pBTTS += prob
            if h + a > 2.5: pOver25 += prob
            
    # HT Goal (Over 0.5 HT)
    pHTGoal = 1 - (poisson_prob(ht_xg_h, 0) * poisson_prob(ht_xg_a, 0))
    
    return {
        '1X2': {'1': pH, 'X': pD, '2': pA},
        'BTTS': pBTTS,
        'Over25': pOver25,
        'HT05': pHTGoal,
        'Handicap': pH if pH > pA else pA # Simplified
    }

def get_surgical_selection(match_name, xg_h, xg_a):
    probs = calculate_probs(xg_h, xg_a)
    
    markets = [
        ('1X2', max(probs['1X2'].values()), f"فوز {match_name.split(' vs ')[0] if probs['1X2']['1'] > probs['1X2']['2'] else match_name.split(' vs ')[1]}"),
        ('BTTS', probs['BTTS'], "كلا الفريقين يسجل (BTTS)"),
        ('Over25', probs['Over25'], "أكثر من 2.5 هدف"),
        ('HT05', probs['HT05'], "هدف في الشوط الأول (HT 0.5)"),
    ]
    
    # Surgical logic: highest success rate
    strongest = max(markets, key=lambda x: x[1])
    
    # Fallback logic
    remaining = [m for m in markets if m[0] != strongest[0]]
    fallback = max(remaining, key=lambda x: x[1])
    
    return {
        'match': match_name,
        'strongest': strongest,
        'fallback': fallback
    }

# Today's matches with estimated xG (from system context/stats)
matches = [
    ("Korona Kielce vs Piast Gliwice", 1.25, 1.15),
    ("Viking vs Rosenborg", 2.10, 0.95),
    ("Lokomotiv Moscou vs Dynamo Moscou", 1.85, 1.65),
    ("Aalborg BK vs Hobro IK", 1.55, 1.10),
    ("Al-Aïn vs Al Wahda", 1.90, 1.40)
]

results = []
for name, xgh, xga in matches:
    results.append(get_surgical_selection(name, xgh, xga))

print(json.dumps(results, ensure_ascii=False, indent=2))
