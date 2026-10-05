@echo off
setlocal EnableExtensions
cd /d "%~dp0"

echo ===============================================
echo PeerSync by Nickston - portable build
echo ===============================================
echo.
echo Building PSN.exe
echo Log: %~dp0build-portable.log
echo Do not close this window until it says Done or FAILED.
echo.

powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\build-portable-win.ps1"
set "ERR=%ERRORLEVEL%"
echo.
if not "%ERR%"=="0" (
  echo FAILED errorlevel=%ERR%
) else (
  echo Done.
  echo PSN.exe:
  echo   %~dp0PSN.exe
  echo   %~dp0dist\PSN.exe
)
echo.
pause
exit /b %ERR%
