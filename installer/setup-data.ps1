# HCI ONE Board Remote installer helper. Runs elevated, after the files are in place and before the
# service starts. Safe to run again.
#   1. Stops an older Board Remote that runs from a folder (START.bat / background.vbs), so the
#      service can use port 7755, and removes its start with Windows shortcut.
#   2. Brings that folder's data over: boards, settings, cloud link, health history, push history,
#      app library, audit records, snapshots, and the adb/scrcpy tools. Nothing is deleted there.
#   3. Puts the bundled scrcpy and adb in the data folder if it has none.
#   4. Locks the data folder down to SYSTEM and Administrators, because boards.json holds the
#      MediaCare login, the Claude key and the HCI ONE Cloud credential.
param([string]$Data, [string]$App, [string]$From = '')
$ErrorActionPreference = 'Continue'
$log = Join-Path $Data 'logs\install.log'
New-Item -ItemType Directory -Force -Path (Join-Path $Data 'logs') | Out-Null
function Say($t) { Add-Content -Path $log -Value ((Get-Date -Format s) + '  ' + $t) }
Say "Installing Board Remote from $App"

# 1. an older Board Remote run from a folder
$old = @()
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue | Where-Object {
  $_.CommandLine -and $_.CommandLine -match 'server\.js' -and $_.CommandLine -notmatch [regex]::Escape($App)
} | ForEach-Object {
  if ($_.ExecutablePath) {
    $dir = Split-Path ($_.CommandLine -replace '^.*"([^"]*server\.js)".*$', '$1') -Parent
    if ($dir -and (Test-Path (Join-Path $dir 'server.js'))) { $old += $dir }
  }
  Say ("Stopping the earlier Board Remote, process " + $_.ProcessId)
  Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
}
# its start with Windows and desktop shortcuts, for every user
$shell = New-Object -ComObject WScript.Shell
$profiles = Get-ChildItem 'C:\Users' -Directory -ErrorAction SilentlyContinue
foreach ($p in $profiles) {
  foreach ($lnk in @("$($p.FullName)\AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\Board Remote.lnk", "$($p.FullName)\Desktop\Board Remote.lnk", "$($p.FullName)\OneDrive\Desktop\Board Remote.lnk")) {
    if (Test-Path $lnk) {
      try {
        $s = $shell.CreateShortcut($lnk)
        $target = if ($s.Arguments -match 'background\.vbs') { Split-Path ($s.Arguments.Trim('"')) -Parent } else { Split-Path $s.TargetPath -Parent }
        if ($target -and (Test-Path (Join-Path $target 'server.js'))) { $old += $target }
        Remove-Item $lnk -Force
        Say "Removed the old shortcut $lnk"
      } catch { Say "Could not read $lnk" }
    }
  }
}
if ($From) { $old = @($From) + $old }
$old += @('C:\HCI\Board Remote', 'C:\HCI ONE\Board Remote', "$env:USERPROFILE\Desktop\HCI ONE Board Remote")
$src = $old | Where-Object { $_ -and (Test-Path (Join-Path $_ 'boards.json')) } | Select-Object -First 1

# 2. bring the data over, only where the data folder has none yet
if ($src -and -not (Test-Path (Join-Path $Data 'boards.json'))) {
  Say "Bringing over data from $src"
  foreach ($f in 'boards.json', 'deploy.json', 'health.json', 'remote.json') {
    $a = Join-Path $src $f; if (Test-Path $a) { Copy-Item $a (Join-Path $Data $f) -Force; Say "  $f" }
  }
  foreach ($d in 'audit', 'snapshots', 'apks\library', 'tools') {
    $a = Join-Path $src $d
    if (Test-Path $a) { New-Item -ItemType Directory -Force -Path (Join-Path $Data $d) | Out-Null; Copy-Item (Join-Path $a '*') (Join-Path $Data $d) -Recurse -Force -ErrorAction SilentlyContinue; Say "  $d" }
  }
  Set-Content -Path (Join-Path $Data 'migrated-from.txt') -Value $src
} elseif ($src) { Say "Data folder already has boards; left $src as it is" } else { Say 'No earlier Board Remote folder found; starting fresh' }

# 3. scrcpy and adb
$tools = Join-Path $Data 'tools\scrcpy'
if (-not (Test-Path (Join-Path $tools 'adb.exe')) -and (Test-Path (Join-Path $App 'bundled\scrcpy\adb.exe'))) {
  New-Item -ItemType Directory -Force -Path $tools | Out-Null
  Copy-Item (Join-Path $App 'bundled\scrcpy\*') $tools -Recurse -Force
  Say 'Put scrcpy and adb in the data folder'
}

# 4. only SYSTEM and Administrators may read the data folder
& icacls.exe $Data /inheritance:r /grant:r '*S-1-5-18:(OI)(CI)F' '*S-1-5-32-544:(OI)(CI)F' /T /C /Q | Out-Null
Say 'Data folder locked to SYSTEM and Administrators'
exit 0
