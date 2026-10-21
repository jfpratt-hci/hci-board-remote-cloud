@echo off
cd /d "%~dp0"
if not exist "%~dp0tools\setup.done" (
  echo First run. Setting up Board Remote...
  call "%~dp0SETUP.bat"
  exit /b
)
rem Starts the keepalive quietly (does nothing if it is already running)
wscript "%~dp0background.vbs"
powershell -NoProfile -Command "for($i=0;$i -lt 40;$i++){try{Invoke-WebRequest 'http://127.0.0.1:7755/api/ping' -UseBasicParsing -TimeoutSec 1 | Out-Null; exit 0}catch{Start-Sleep -Milliseconds 250}}; exit 1"
if errorlevel 1 (
  echo Board Remote did not start. Look in the logs folder, or run SETUP.bat again.
  pause
  exit /b
)
rem Open as its own app window in Edge
start "" msedge --app=http://localhost:7755/ --window-size=1600,940
