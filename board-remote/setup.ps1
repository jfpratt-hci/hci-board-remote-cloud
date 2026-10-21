# HCI ONE Board Remote setup
# Puts a portable Node (only if this PC has none) and scrcpy (which includes adb)
# into .\tools, makes a desktop shortcut, and can start Board Remote with Windows.
# Nothing is installed system wide and no admin rights are needed.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try { [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12 } catch {}

$root  = $PSScriptRoot
$tools = Join-Path $root 'tools'
$stage = Join-Path $tools '_download'
New-Item -ItemType Directory -Force -Path $tools | Out-Null

function Say($text, $color) { if ($color) { Write-Host "  $text" -ForegroundColor $color } else { Write-Host "  $text" } }
function Fresh($dir) { if (Test-Path $dir) { Remove-Item $dir -Recurse -Force }; New-Item -ItemType Directory -Force -Path $dir | Out-Null }

Write-Host ''
Say 'HCI ONE Board Remote setup' Cyan
Write-Host ''

# 1. Node
$needNode = $true
$sysNode = Get-Command node -ErrorAction SilentlyContinue
if ($sysNode) {
  try {
    $v = (& node -v) -replace '^v', ''
    if ([int]($v.Split('.')[0]) -ge 16) { $needNode = $false; Say "Node $v found on this PC." Green }
  } catch {}
}
if ($needNode -and (Test-Path (Join-Path $tools 'node\node.exe'))) { $needNode = $false; Say 'Node already in tools.' Green }
if ($needNode) {
  try {
    Say 'Downloading Node (portable copy, about 30 MB)...'
    $index = Invoke-RestMethod 'https://nodejs.org/dist/index.json' -UseBasicParsing
    $lts = $index | Where-Object { $_.lts } | Select-Object -First 1
    $ver = $lts.version
    Fresh $stage
    $zip = Join-Path $stage 'node.zip'
    Invoke-WebRequest "https://nodejs.org/dist/$ver/node-$ver-win-x64.zip" -OutFile $zip -UseBasicParsing
    Expand-Archive $zip -DestinationPath $stage -Force
    $inner = Get-ChildItem $stage -Directory | Select-Object -First 1
    $dest = Join-Path $tools 'node'
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    Move-Item $inner.FullName $dest
    Say "Node $ver ready." Green
  } catch {
    Say "Could not download Node: $($_.Exception.Message)" Red
    Say 'Install Node from nodejs.org, then run SETUP.bat again.' Yellow
  }
}

# 2. scrcpy (live mirror) which also brings adb
$scr = Join-Path $tools 'scrcpy'
if (Test-Path (Join-Path $scr 'scrcpy.exe')) {
  Say 'scrcpy and adb already in tools.' Green
} else {
  try {
    Say 'Downloading scrcpy and adb (about 10 MB)...'
    $rel = Invoke-RestMethod 'https://api.github.com/repos/Genymobile/scrcpy/releases/latest' -Headers @{ 'User-Agent' = 'HCI-Board-Remote' } -UseBasicParsing
    $asset = $rel.assets | Where-Object { $_.name -like 'scrcpy-win64-*.zip' } | Select-Object -First 1
    if (-not $asset) { throw 'No Windows build found in the latest scrcpy release.' }
    Fresh $stage
    $zip = Join-Path $stage 'scrcpy.zip'
    Invoke-WebRequest $asset.browser_download_url -OutFile $zip -UseBasicParsing
    $out = Join-Path $stage 'x'
    Expand-Archive $zip -DestinationPath $out -Force
    $exe = Get-ChildItem $out -Recurse -Filter 'scrcpy.exe' | Select-Object -First 1
    if (-not $exe) { throw 'scrcpy.exe was not in the download.' }
    if (Test-Path $scr) { Remove-Item $scr -Recurse -Force }
    Move-Item $exe.Directory.FullName $scr
    Say "scrcpy $($rel.tag_name) ready." Green
  } catch {
    Say "Could not download scrcpy: $($_.Exception.Message)" Red
    Say 'Board Remote still works; Live mirror needs scrcpy. Run SETUP.bat again later.' Yellow
  }
}
if (Test-Path $stage) { Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue }

$sdkAdb = Join-Path $env:LOCALAPPDATA 'Android\Sdk\platform-tools\adb.exe'
if (Test-Path $sdkAdb) { Say 'Using the Android Studio adb so the two never fight.' Green }

# 3. Shortcuts
$ws = New-Object -ComObject WScript.Shell
try {
  $lnk = $ws.CreateShortcut((Join-Path ([Environment]::GetFolderPath('Desktop')) 'Board Remote.lnk'))
  $lnk.TargetPath = Join-Path $root 'START.bat'
  $lnk.WorkingDirectory = $root
  $lnk.WindowStyle = 7
  $lnk.IconLocation = (Join-Path $root "board_remote.ico")
  $lnk.Description = 'HCI ONE Board Remote'
  $lnk.Save()
  Say 'Desktop shortcut made: Board Remote.' Green
} catch { Say 'Could not make the desktop shortcut (not needed).' Yellow }

Write-Host ''
$ans = Read-Host '  Keep your boards connected every time Windows starts? (Y/N)'
$startup = Join-Path ([Environment]::GetFolderPath('Startup')) 'Board Remote.lnk'
if ($ans -match '^[Yy]') {
  $s = $ws.CreateShortcut($startup)
  $s.TargetPath = Join-Path $env:SystemRoot 'System32\wscript.exe'
  $s.Arguments = '"' + (Join-Path $root 'background.vbs') + '"'
  $s.WorkingDirectory = $root
  $s.Description = 'HCI ONE Board Remote keepalive'
  $s.Save()
  Say 'Board Remote will start quietly when you sign in to Windows.' Green
} elseif (Test-Path $startup) {
  Remove-Item $startup -Force
  Say 'Start with Windows turned off.' Yellow
}

Set-Content -Path (Join-Path $tools 'setup.done') -Value (Get-Date -Format s)
Write-Host ''
Say 'Setup done. Opening Board Remote...' Cyan
Start-Process -FilePath (Join-Path $root 'START.bat') -WorkingDirectory $root -WindowStyle Minimized
Start-Sleep -Seconds 2
