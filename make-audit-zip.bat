@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ===============================================
echo PeerSync by Nickston - external audit archive
echo ===============================================
echo.
echo Creating PeerSync-external-audit.zip in the project root...
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\make-audit-zip.ps1"
set "ERR=%ERRORLEVEL%"
if not "%ERR%"=="0" (
  echo.
  echo FAILED errorlevel=%ERR%
  exit /b %ERR%
)
echo.
echo Done: %~dp0PeerSync-external-audit.zip
exit /b 0
