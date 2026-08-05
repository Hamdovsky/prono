@echo off
:: ---------------------------------------------------------------
:: fbref local scraper (residential IP) — run on your home machine.
::
:: IMPORTANT: set your public Render URL below ONCE.
:: API_SECRET_KEY is read automatically from the project .env file.
::
:: Usage:
::   run_fbref_scraper.bat --loop   -> scrape all fbref leagues + push, repeat every 12h
::   run_fbref_scraper.bat --once   -> single scrape + push (recommended for Task Scheduler)
:: ---------------------------------------------------------------
set RENDER_URL=https://RENDER_URL_A_REMODIFIER.onrender.com

:: Always run from this project folder (so data/ + .env resolve right).
cd /d "%~dp0.."

setlocal
set "ARGS=%*"
if /I "%ARGS%"=="--loop" (
  node scripts/local_fbref_scraper.js --loop
) else (
  node scripts/local_fbref_scraper.js
)