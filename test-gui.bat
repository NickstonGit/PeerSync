@echo off
setlocal EnableExtensions EnableDelayedExpansion

cd /d "%~dp0"

echo ===============================================
echo PeerSync by Nickston - GUI from source
echo ===============================================
echo.
echo Working directory:
echo %CD%
echo.
echo Starting:
echo "%~dp0apps\portable-python\app.py"
echo.

where python.exe >nul 2>&1
if errorlevel 1 (
    echo ERROR: python.exe not found in PATH
    pause
    exit /b 1
)

python.exe -u "%~dp0apps\portable-python\app.py" > "%~dp0peersync_startup.log" 2>&1

set "ERR=%ERRORLEVEL%"

echo.
echo Exit code: %ERR%
echo Log: %~dp0peersync_startup.log

if not "%ERR%"=="0" (
    echo.
    echo FAILED. Last lines from log:
    echo -----------------------------------------------
    powershell -NoProfile -Command "Get-Content '%~dp0peersync_startup.log' -Tail 30"
    echo -----------------------------------------------
) else (
    echo Done.
)

echo.
pause
exit /b %ERR%
