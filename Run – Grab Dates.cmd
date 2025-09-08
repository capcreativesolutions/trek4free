@echo off
cd /d "%~dp0"
node tools\grab-event-dates.v2.mjs public\data\events\events.json public\data\events\patch_dates.json --verbose
pause
