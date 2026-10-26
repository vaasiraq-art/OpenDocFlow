@echo off
setlocal
echo Restoring OpenCode settings, plugins and skills...
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\install.ps1" %*
set "RC=%ERRORLEVEL%"
echo.
if not "%RC%"=="0" echo Setup failed with exit code %RC%.
pause
exit /b %RC%
