@echo off
setlocal
echo Updating the portable OpenCode setup from this PC...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\snapshot.ps1" %*
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" echo Snapshot failed with exit code %RC%.
pause
exit /b %RC%
