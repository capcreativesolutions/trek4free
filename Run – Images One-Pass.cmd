@echo off
cd /d "%~dp0"
node tools\t4f-images-onepass.mjs ^
  --events=public\data\events\events.json ^
  --out=public\data\events\events.patched.json ^
  --images=public\images\events ^
  --mode=append ^
  --limit=3
echo.
echo Open the patched file with your validator/merger and save as events.json.
pause
