@echo off
rem Runs the Reddit listener and keeps the window open so the list can be read.
rem Any arguments are passed through, e.g. "Reddit listener.cmd" --days 30 --all --misses
cd /d "%~dp0"
node reddit-listen.mjs %*
echo.
pause
