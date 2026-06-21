@echo off
REM run_daily_predictions.bat
REM Execute daily predictions pipeline

cd /d "C:\Users\HAMDI\Desktop\HamdiProno\stitch"
python scripts\daily_predictions.py >> logs\daily_predictions.log 2>&1
