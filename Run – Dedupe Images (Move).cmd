@echo off
cd /d "%~dp0"
node tools\dedupe-images.mjs public\images\events --mode=move --out=public\images\_dupes --threshold=6
pause
