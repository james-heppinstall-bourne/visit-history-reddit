@echo off
rem The unattended daily run behind report.txt. Registered in Task Scheduler as
rem "Visit History Reddit listener" (05:00 daily). Output and warnings go to
rem run.log; the ranked list goes to report.txt.
cd /d "%~dp0"
node reddit-listen.mjs --days 7 --all --report > run.log 2>&1
