# Arabic Football Sentiment Keywords
# V60 - Advanced Intel Core

ARABIC_KEYWORDS = {
    # Positive / Advantage
    "فوز": 0.8,
    "انتصار": 0.9,
    "تألق": 0.7,
    "جاهزية": 0.6,
    "عودة": 0.5,
    "تحفيز": 0.6,
    "روح": 0.5,
    "استقرار": 0.7,
    "هجمة": 0.3,
    "نجم": 0.5,
    "صفقة": 0.4,
    "تجديد": 0.5,

    # Negative / Disadvantage
    "هزيمة": -0.9,
    "خسارة": -0.8,
    "إصابة": -0.7,
    "غياب": -0.6,
    "أزمة": -0.9,
    "إقالة": -1.0,  # Sack/Dismissal
    "استقالة": -0.8,
    "تمرد": -1.0,    # Rebellion/Strike
    "خلاف": -0.7,
    "تراجع": -0.5,
    "ضغط": -0.4,
    "مشاكل": -0.8,
    "غيابات": -0.7,
    "عقوبة": -0.9,
    "توقيف": -0.8,
    "تدهور": -0.7,
    "صيام": -0.4,   # Drought (goals)
    "إحباط": -0.6,
    "احتجاج": -0.5,
}

def get_arabic_sentiment(text):
    if not text: return 0
    # Clean text: remove common prefixes to match root-ish keywords
    # و (and), ل (for), ب (with/by)
    clean_text = text.replace("و ", " ").replace("ل ", " ").replace("ب ", " ")
    words = clean_text.split()
    score = 0
    matches = 0
    
    for word in words:
        # Check direct match
        if word in ARABIC_KEYWORDS:
            score += ARABIC_KEYWORDS[word]
            matches += 1
            continue
            
        # Check with prefixes removed (e.g., وتألق -> تألق)
        for prefix in ['و', 'ل', 'ب', 'ال']:
            if word.startswith(prefix) and len(word) > len(prefix):
                stem = word[len(prefix):]
                if stem in ARABIC_KEYWORDS:
                    score += ARABIC_KEYWORDS[stem]
                    matches += 1
                    break
                    
    return score / matches if matches > 0 else 0
