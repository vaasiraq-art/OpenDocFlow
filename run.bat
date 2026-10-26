@echo off
setlocal
if exist "%~dp0dist\win-unpacked\OpenDocFlow.exe" (
  start "" "%~dp0dist\win-unpacked\OpenDocFlow.exe"
) else (
  pushd "%~dp0"
  call npx electron .
  popd
)
