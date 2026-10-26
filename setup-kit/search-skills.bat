@echo off
setlocal
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\search-skills.ps1" %*
set "RC=%ERRORLEVEL%"
echo.
pause
exit /b %RC%
