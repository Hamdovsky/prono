import zipfile
import os
import sys

site_packages = r'C:\Users\HAMDI\AppData\Local\Programs\Python\Python312\Lib\site-packages'
downloads = r'C:\Users\HAMDI\Downloads'

wheels = [
    'numpy-1.26.4-cp312-cp312-win_amd64.whl',
    'xgboost-2.1.0-py3-none-win_amd64.whl'
]

print(f"Target site-packages: {site_packages}")

for wheel in wheels:
    wheel_path = os.path.join(downloads, wheel)
    if not os.path.exists(wheel_path):
        print(f"ERROR: Wheel not found at {wheel_path}")
        continue
    
    print(f"Extracting {wheel}...")
    try:
        with zipfile.ZipFile(wheel_path, 'r') as zip_ref:
            zip_ref.extractall(site_packages)
        print(f"Successfully extracted {wheel}")
    except Exception as e:
        print(f"FAILED to extract {wheel}: {e}")

print("Extraction complete.")
