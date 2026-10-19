@echo off
rem What the Desktop shortcut runs. Shows the last report from the scheduled
rem run, then offers a fresh search. Any arguments are passed to the script.
cd /d "%~dp0"
if not exist report.txt goto run
echo Opening the last report, from the scheduled run...
start "" notepad.exe report.txt
echo.
choice /C YN /N /M "Run a fresh search now? Without API credentials it takes most of an hour. [Y/N] "
if errorlevel 2 goto end
:run
node reddit-listen.mjs %*
:end
echo.
pause
