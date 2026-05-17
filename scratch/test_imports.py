
import sys
import os
import time

print("Testing imports...")
sys.path.append(os.path.join(os.getcwd(), 'core'))

start = time.time()
try:
    print("Importing prediction_engine...")
    from prediction_engine import process_prediction
    print(f"Done in {time.time() - start:.2f}s")
except Exception as e:
    print(f"FAILED prediction_engine: {e}")

start = time.time()
try:
    print("Importing player_props_engine...")
    from player_props_engine import analyze_props
    print(f"Done in {time.time() - start:.2f}s")
except Exception as e:
    print(f"FAILED player_props_engine: {e}")

start = time.time()
try:
    print("Importing mega_correlation_engine...")
    from mega_correlation_engine import MegaCorrelationEngine
    print(f"Done in {time.time() - start:.2f}s")
except Exception as e:
    print(f"FAILED mega_correlation_engine: {e}")

start = time.time()
try:
    print("Importing sentiment_engine...")
    from sentiment_engine import analyze_sentiment
    print(f"Done in {time.time() - start:.2f}s")
except Exception as e:
    print(f"FAILED sentiment_engine: {e}")

print("All imports tested.")
