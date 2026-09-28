@echo off
setlocal
set PSModulePath=
cd /d "%~dp0"
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%~dp0check.ps1"
echo.
pause
