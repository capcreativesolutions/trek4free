@echo off
cd /d "%~dp0"
node tools\grab-event-images.v3.mjs public\data\events\events.json public\images\events images_patch.json
pause
