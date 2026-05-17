import time
print("Testing imports...")
start = time.time()
import sys, os
print(f"sys, os loaded in {time.time() - start:.2f}s")

start = time.time()
import json
print(f"json loaded in {time.time() - start:.2f}s")

start = time.time()
import numpy as np
print(f"numpy loaded in {time.time() - start:.2f}s")

start = time.time()
sys.path.append(os.path.join(os.getcwd(), 'core'))
from prediction_engine import process_prediction
print(f"prediction_engine loaded in {time.time() - start:.2f}s")

start = time.time()
from player_props_engine import analyze_props
print(f"player_props_engine loaded in {time.time() - start:.2f}s")

start = time.time()
from mega_correlation_engine import MegaCorrelationEngine
print(f"mega_correlation_engine loaded in {time.time() - start:.2f}s")

start = time.time()
from sentiment_engine import analyze_sentiment
print(f"sentiment_engine loaded in {time.time() - start:.2f}s")

print("All imports done.")
