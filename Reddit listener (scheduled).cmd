@echo off
rem The unattended daily run behind report.txt. Registered in Task Scheduler as
rem "Visit History Reddit listener" (09:00 daily, or as soon as the machine is awake after that). Output and warnings go to
rem run.log; the ranked list goes to report.txt.
cd /d "%~dp0"
echo Started %date% %time% > run.log
node reddit-listen.mjs --days 7 --all --report >> run.log 2>&1
echo Finished %date% %time% exit %errorlevel% >> run.log
