import sys
import json
import re
from vaderSentiment.vaderSentiment import SentimentIntensityAnalyzer
from textblob import TextBlob
from arabic_keywords import get_arabic_sentiment

def is_arabic(text):
    return bool(re.search('[\u0600-\u06FF]', text))

def analyze_sentiment(text):
    if not text:
        return {"score": 0, "label": "Neutral", "subjectivity": 0}
    
    # Check for Arabic
    if is_arabic(text):
        score = get_arabic_sentiment(text)
        label = "Neutral"
        if score >= 0.1: label = "Positive"
        elif score <= -0.1: label = "Negative"
        return {"score": round(score, 3), "label": label, "subjectivity": 0.5, "lang": "Ar"}

    # VADER for polarity (English)
    analyzer = SentimentIntensityAnalyzer()
    vs = analyzer.polarity_scores(text)
    compound = vs['compound']
    
    # TextBlob for subjectivity
    blob = TextBlob(text)
    subjectivity = blob.sentiment.subjectivity
    
    # Labeling
    label = "Neutral"
    if compound >= 0.05:
        label = "Positive"
    elif compound <= -0.05:
        label = "Negative"
        
    return {
        "score": round(compound, 3),
        "label": label,
        "subjectivity": round(subjectivity, 3),
        "lang": "En"
    }

if __name__ == "__main__":
    import io
    sys.stdin = io.TextIOWrapper(sys.stdin.buffer, encoding='utf-8')
    sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
    # Read from stdin
    try:
        input_data = sys.stdin.read()
        if not input_data:
            print(json.dumps({"error": "No input received"}))
            sys.exit(0)
            
        payload = json.loads(input_data)
        text = payload.get('text', '')
        headlines = payload.get('headlines', [])
        
        results = []
        if headlines:
            for h in headlines:
                results.append(analyze_sentiment(h))
        elif text:
            results.append(analyze_sentiment(text))
            
        # Aggregate if multiple
        if results:
            avg_score = sum(r['score'] for r in results) / len(results)
            avg_subj = sum(r['subjectivity'] for r in results) / len(results)
            
            final_label = "Neutral"
            if avg_score >= 0.05: final_label = "Positive"
            elif avg_score <= -0.05: final_label = "Negative"
            
            main_lang = results[0].get('lang', 'En')
            
            print(json.dumps({
                "success": True,
                "score": round(avg_score, 3),
                "label": final_label,
                "subjectivity": round(avg_subj, 3),
                "lang": main_lang,
                "details": results
            }))
        else:
            print(json.dumps({"success": False, "error": "No text to analyze"}))
            
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}))
