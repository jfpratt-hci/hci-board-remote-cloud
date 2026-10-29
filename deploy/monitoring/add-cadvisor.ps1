<#
  Adds cAdvisor (github.com/google/cadvisor) to an existing HCI backend on Windows (Docker Desktop),
  so Board Remote can show its containers in HCI ONE Cloud. Run on the Docker host, in PowerShell:

    powershell -ExecutionPolicy Bypass -File add-cadvisor.ps1 -Allow <Board Remote PC address>
    powershell -ExecutionPolicy Bypass -File add-cadvisor.ps1 -ComposeDir D:\hci-mediacare -Port 8098

  What it does, and nothing else:
  1. If cAdvisor already runs here, says where and stops (-Force recreates it from this kit).
  2. Finds the running compose project (for example hci-mediacare in D:\hci-mediacare), or uses -ComposeDir.
  3. Copies docker-compose.cadvisor.yml next to its docker-compose.yml (that file is not edited) and starts
     only the cadvisor service with --no-deps. Without a compose project it uses docker run instead.
  4. Waits for cAdvisor to answer and prints the address to add in Board Remote (Remote, Backend containers).
#>
param(
  [string]$ComposeDir = '',
  [int]$Port = 8098,
  [string]$Bind = '0.0.0.0',
  [string]$Allow = '',
  [switch]$Open,
  [string]$Version = '0.60.6',
  [switch]$Force
)
# Not 'Stop': in Windows PowerShell 5.1 that turns any stderr line from docker or wget (a refused port while
# scanning, "No such container") into a fatal error. Each docker call's exit code is checked instead.
$ErrorActionPreference = 'Continue'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Override = Join-Path $Here 'docker-compose.cadvisor.yml'
function Say($m) { Write-Host "  $m" }
function Fail($m) { Write-Host "  $m" -ForegroundColor Red; exit 1 }
. (Join-Path $Here 'lock-port.ps1'); Test-Allow

Write-Host "`nHCI ONE: add cAdvisor to this Docker host`n" -ForegroundColor Cyan
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Fail 'Docker is not installed or not on PATH.' }
docker info --format '{{.ServerVersion}}' *> $null
if ($LASTEXITCODE -ne 0) { Fail 'Docker is not running. Start Docker Desktop and run this again.' }
if (-not (Test-Path $Override)) { Fail "docker-compose.cadvisor.yml is missing. Keep it next to this script." }

function Wait-Cadvisor($port) {
  for ($i = 0; $i -lt 30; $i++) {
    try { if ((Invoke-WebRequest -UseBasicParsing -ErrorAction Stop -TimeoutSec 3 "http://localhost:$port/healthz").Content -match 'ok') { return $true } } catch { }
    Start-Sleep -Seconds 2
  }
  return $false
}
function Show-Address($port) {
  Lock-Port $port
  $ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and $_.InterfaceAlias -notmatch 'vEthernet|WSL|Loopback' } | Select-Object -ExpandProperty IPAddress
  Write-Host "`n  In Board Remote on a PC at this hospital: Remote, Backend containers, add" -ForegroundColor Green
  foreach ($ip in $ips) { Write-Host "    http://${ip}:$port" -ForegroundColor Green }
  Write-Host "  cAdvisor has no sign in. Allow port $port only from the Board Remote PCs (Windows Firewall or the network).`n"
}

# 1. already here?
$existing = docker ps -a --format '{{.Names}}|{{.Image}}|{{.Status}}|{{.Ports}}' | Where-Object { ($_ -split '\|')[1] -match 'cadvisor' }
if ($existing -and -not $Force) {
  foreach ($e in $existing) { $f = $e -split '\|'; Say "cAdvisor is already here: $($f[0]) ($($f[1])), $($f[2]). $($f[3])" }
  $p = if ("$existing" -match ':(\d+)->(8080|8098)') { [int]$Matches[1] } else { $Port }
  if (Wait-Cadvisor $p) { Say "It answers on port $p."; Show-Address $p; exit 0 }
  Fail "It does not answer on port $p. Run again with -Force to recreate it from this kit."
}

# 2. the deployment's compose project
$project = ''; $files = @()
if ($ComposeDir) {
  $yml = @('docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml') | ForEach-Object { Join-Path $ComposeDir $_ } | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $yml) { Fail "No docker-compose.yml in $ComposeDir." }
  $files = @($yml)
  $project = (docker ps --format '{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.project.working_dir"}}' | Where-Object { ($_ -split '\|')[1] -eq $ComposeDir } | Select-Object -First 1)
  $project = if ($project) { ($project -split '\|')[0] } else { (Split-Path -Leaf $ComposeDir).ToLower() }
} else {
  $rows = docker ps --format '{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.project.working_dir"}}|{{.Label "com.docker.compose.project.config_files"}}' | Where-Object { $_ -and -not $_.StartsWith('|') }
  $top = $rows | Group-Object | Sort-Object Count -Descending | Select-Object -First 1
  if ($top) {
    $f = $top.Name -split '\|'
    $project = $f[0]; $ComposeDir = $f[1]; $files = $f[2] -split ',' | Where-Object { $_ -and (Test-Path $_) }
    if (($rows | Group-Object | Measure-Object).Count -gt 1) { Say "More than one compose project runs here; using $project (most containers). Pick another with -ComposeDir." }
  }
}

$env:CADVISOR_PORT = "$Port"; $env:CADVISOR_BIND = $Bind; $env:CADVISOR_VERSION = $Version
if ($Force) { docker rm -f hci-cadvisor *> $null }

# the host port must be free (the port inside cAdvisor's own container never clashes with the host)
$taken = @(Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue).Count -gt 0
$byDocker = docker ps --format '{{.Names}} {{.Ports}}' | Where-Object { $_ -match ":$Port->" }
if ($taken -or $byDocker) {
  $free = (8098..8199 | Where-Object { -not (Get-NetTCPConnection -State Listen -LocalPort $_ -ErrorAction SilentlyContinue) -and -not (docker ps --format '{{.Ports}}' | Select-String ":$_->") } | Select-Object -First 1)
  Fail "Port $Port is already in use here$(if ($byDocker) { " by $(($byDocker -split ' ')[0])" }). Run again with -Port $free (or another free port)."
}

if ($project -and $files.Count) {
  # 3. compose: only the cadvisor service, nothing else recreated
  Say "Deployment: $project in $ComposeDir"
  $dest = Join-Path $ComposeDir 'docker-compose.cadvisor.yml'
  if ((Test-Path $dest) -and ((Get-FileHash $dest).Hash -ne (Get-FileHash $Override).Hash)) {
    $bak = "$dest.$(Get-Date -Format yyyyMMdd-HHmmss).bak"; Copy-Item $dest $bak; Say "Kept the old override as $bak"
  }
  Copy-Item $Override $dest -Force
  $dargs = @('compose', '-p', $project, '--project-directory', $ComposeDir)
  foreach ($y in $files) { $dargs += @('-f', $y) }
  # the other kit's override too, so compose knows its container is part of the deployment
  $other = Join-Path $ComposeDir 'docker-compose.prometheus.yml'; if (Test-Path $other) { $dargs += @('-f', $other) }
  $dargs += @('-f', $dest, 'up', '-d', '--no-deps', 'cadvisor')
  Say "docker $($dargs -join ' ')"
  & docker @args
  if ($LASTEXITCODE -ne 0) { Fail 'docker compose could not start cAdvisor (see above).' }
  Say "From now on, start the deployment with -f docker-compose.cadvisor.yml as well, or cAdvisor keeps running on its own (restart: unless-stopped)."
} else {
  # no compose project found: a plain container with the same settings
  Say 'No compose project found; starting cAdvisor with docker run.'
  & docker run -d --name hci-cadvisor --restart unless-stopped --privileged --device /dev/kmsg:/dev/kmsg -p "${Bind}:${Port}:8098" `
    -v /:/rootfs:ro -v /var/run/docker.sock:/var/run/docker.sock:ro -v /sys:/sys:ro -v /var/lib/docker/:/var/lib/docker:ro -v /dev/disk/:/dev/disk:ro `
    --label com.hci.one.role=cadvisor "ghcr.io/google/cadvisor:$Version" `
    --port=8098 --docker_only=true --housekeeping_interval=10s --store_container_labels=false `
    --disable_metrics=advtcp,cpu_topology,cpuset,hugetlb,memory_numa,percpu,perf_event,process,referenced_memory,resctrl,sched,tcp,udp
  if ($LASTEXITCODE -ne 0) { Fail 'docker run could not start cAdvisor (see above).' }
}

# 4. check it
if (-not (Wait-Cadvisor $Port)) { Fail "cAdvisor started but does not answer on port $Port. See: docker logs hci-cadvisor" }
Say "cAdvisor $Version answers on port $Port."
Show-Address $Port
