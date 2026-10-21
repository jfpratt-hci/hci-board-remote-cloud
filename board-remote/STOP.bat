@echo off
powershell -NoProfile -Command "try{Invoke-RestMethod -Method Post -Uri 'http://127.0.0.1:7755/api/quit' -Headers @{'X-Board-Remote'='1'} -ContentType 'application/json' -Body '{}' | Out-Null; Write-Host '  Board Remote stopped.'}catch{Write-Host '  Board Remote was not running.'}"
timeout /t 2 >nul
