@echo off
setlocal

cd /d "%~dp0"

echo ===============================================
echo PeerSync startup diagnostic
echo ===============================================
echo Folder:
echo %CD%
echo.

set PYTHONIOENCODING=utf-8

echo Running:
echo python "%~dp0apps\portable-python\app.py"
echo.

python.exe "%~dp0apps\portable-python\app.py"

echo.
echo ===============================================
echo Process finished
echo ErrorLevel=%ERRORLEVEL%
echo ===============================================
pause
