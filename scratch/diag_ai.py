import sys
import os

print("--- AI Server Diagnostics ---")
print(f"Python version: {sys.version}")
print(f"Working directory: {os.getcwd()}")

def check_import(name):
    try:
        mod = __import__(name)
        print(f"[OK] {name} found")
        return mod
    except ImportError as e:
        print(f"[FAIL] {name} NOT found: {e}")
        return None
    except Exception as e:
        print(f"[ERROR] Error importing {name}: {e}")
        import traceback
        traceback.print_exc()
        return None

check_import("fastapi")
check_import("uvicorn")
check_import("xgboost")
check_import("numpy")

sys.path.append(os.path.join(os.getcwd(), 'core'))

print("\nAttempting to import ml_features...")
check_import("ml_features")

print("\nAttempting to import prediction_engine...")
try:
    import prediction_engine
    print("[OK] prediction_engine imported")
except Exception as e:
    print(f"[FAIL] prediction_engine import failed: {e}")
    import traceback
    traceback.print_exc()

print("--- End Diagnostics ---")
