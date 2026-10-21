@echo off
title HCI ONE Remote relay
cd /d "%~dp0"
set "NODE=node"
if exist "%~dp0..\tools\node\node.exe" set "NODE=%~dp0..\tools\node\node.exe"
if exist "%~dp0tools\node\node.exe" set "NODE=%~dp0tools\node\node.exe"
"%NODE%" -v >nul 2>&1
if errorlevel 1 (
  echo   Node is missing. Run SETUP.bat in the Board Remote folder once, then try again.
  pause
  exit /b
)
echo.
echo   HCI ONE Remote relay, proof of concept
echo   Viewer: http://localhost:8780   Keep this window open. Close it to stop the relay.
echo   First time: your admin password is in FIRST_SIGN_IN.txt in this folder.
echo.
start "" cmd /c "timeout /t 2 >nul & start http://localhost:8780/"
"%NODE%" relay.js
pause
