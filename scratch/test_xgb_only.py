import os
import sys

# Common fix for OpenMP/XGBoost hangs
os.environ['KMP_DUPLICATE_LIB_OK'] = 'True'

print("Starting test with KMP_DUPLICATE_LIB_OK=True...")
try:
    import xgboost
    print(f"XGBoost version: {xgboost.__version__}")
except ImportError:
    print("XGBoost not found.")
except Exception as e:
    print(f"Error: {e}")
print("Done.")
