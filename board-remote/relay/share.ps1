# Gives the relay a temporary https link through a Cloudflare Quick Tunnel, so a phone can reach it from anywhere.
# For testing only: the link changes every time, and anyone with it reaches the sign in page.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}
$tools = Join-Path $PSScriptRoot 'tools'
New-Item -ItemType Directory -Force -Path $tools | Out-Null
$cf = Join-Path $tools 'cloudflared.exe'
Write-Host ''
try { Invoke-WebRequest 'http://127.0.0.1:8780/api/ping' -UseBasicParsing -TimeoutSec 2 | Out-Null }
catch { Write-Host '  The relay is not running. Start RELAY.bat first, then run this again.' -ForegroundColor Yellow; exit 1 }
if (-not (Test-Path $cf)) {
  Write-Host '  Downloading cloudflared from Cloudflare (once, about 60 MB)...'
  Invoke-WebRequest 'https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe' -OutFile $cf -UseBasicParsing
}
Write-Host '  Making a temporary link. It appears below in a few seconds.' -ForegroundColor Cyan
Write-Host '  Close this window to stop sharing.'
$ErrorActionPreference = 'Continue'
& $cf tunnel --no-autoupdate --url http://localhost:8780 2>&1 | ForEach-Object {
  $line = "$_"
  if ($line -match 'https://[a-z0-9-]+\.trycloudflare\.com') {
    Write-Host ''
    Write-Host ('  Open this on your phone:  ' + $Matches[0]) -ForegroundColor Green
    Write-Host '  Sign in with your relay name and password.'
    Write-Host ''
  } elseif ($line -match 'ERR|error') {
    Write-Host ('  ' + $line) -ForegroundColor DarkYellow
  }
}
