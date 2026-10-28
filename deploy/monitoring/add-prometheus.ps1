<#
  Adds Prometheus to an existing HCI backend on Windows (Docker Desktop), so Board Remote can run HCI's
  service alerts (service down, error rate, slow, Java memory, database pool, Kong) against it.
  Run on the Docker host after add-cadvisor.ps1, in PowerShell:

    powershell -ExecutionPolicy Bypass -File add-prometheus.ps1
    powershell -ExecutionPolicy Bypass -File add-prometheus.ps1 -ComposeDir D:\hci-mediacare -Port 9090
    powershell -ExecutionPolicy Bypass -File add-prometheus.ps1 -Rescan     # after services are added or removed

  What it does, and nothing else:
  1. If Prometheus already runs here, says where and stops (-Force recreates it from this kit).
  2. Finds the running compose project, copies docker-compose.prometheus.yml next to its docker-compose.yml
     (that file is not edited) and starts only the prometheus service with --no-deps.
  3. Joins the deployment's networks, asks every service from inside Prometheus's container for
     /actuator/prometheus or /metrics, and writes hci-monitoring\prometheus.yml with only those that answer,
     so nothing shows as down that never had metrics. Then restarts Prometheus to load it.
#>
param(
  [string]$ComposeDir = '',
  [int]$Port = 9090,
  [string]$Bind = '0.0.0.0',
  [string]$Version = 'v2.55.1',
  [switch]$Force,
  [switch]$Rescan
)
# Not 'Stop': in Windows PowerShell 5.1 that turns any stderr line from docker or wget (a refused port while
# scanning, "No such container") into a fatal error. Each docker call's exit code is checked instead.
$ErrorActionPreference = 'Continue'
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Override = Join-Path $Here 'docker-compose.prometheus.yml'
$Name = 'hci-prometheus'
$Skip = @(3306, 5432, 6379, 27017, 61616, 5672, 1883, 11211, 9300)   # never HTTP metrics: databases, brokers, MQTT
function Say($m) { Write-Host "  $m" }
function Fail($m) { Write-Host "  $m" -ForegroundColor Red; exit 1 }
function Show-Address($port) {
  $ips = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction SilentlyContinue | Where-Object { $_.IPAddress -notmatch '^(127\.|169\.254\.)' -and $_.InterfaceAlias -notmatch 'vEthernet|WSL|Loopback' } | Select-Object -ExpandProperty IPAddress
  Write-Host "`n  In Board Remote on a PC at this hospital: Remote, Backend containers, add the host again with Prometheus address" -ForegroundColor Green
  foreach ($ip in $ips) { Write-Host "    http://${ip}:$port" -ForegroundColor Green }
  Write-Host "  Prometheus has no sign in. Allow port $port only from the Board Remote PCs (Windows Firewall or the network).`n"
}

Write-Host "`nHCI ONE: add Prometheus to this Docker host`n" -ForegroundColor Cyan
if (-not (Get-Command docker -ErrorAction SilentlyContinue)) { Fail 'Docker is not installed or not on PATH.' }
docker info --format '{{.ServerVersion}}' *> $null
if ($LASTEXITCODE -ne 0) { Fail 'Docker is not running. Start Docker Desktop and run this again.' }
if (-not (Test-Path $Override)) { Fail 'docker-compose.prometheus.yml is missing. Keep it next to this script.' }

# 1. already here?
$existing = docker ps -a --format '{{.Names}}|{{.Image}}|{{.Label "com.hci.one.role"}}|{{.Ports}}' | Where-Object { ($_ -split '\|')[1] -match 'prometheus' }
if ($existing -and -not $Force -and -not $Rescan) {
  foreach ($e in $existing) { $f = $e -split '\|'; Say "Prometheus is already here: $($f[0]) ($($f[1])). $($f[3])" }
  if ("$existing" -match "$Name\|[^|]*\|prometheus\|") { Say 'It is from this kit; run with -Rescan to look for services again.' }
  $p = if ("$existing" -match ':(\d+)->9090') { [int]$Matches[1] } else { $Port }
  Show-Address $p; exit 0
}
if ($Rescan) { docker inspect $Name *> $null; if ($LASTEXITCODE -ne 0) { Fail "There is no $Name to rescan. Run without -Rescan first." } }

# 2. the deployment's compose project
$project = ''; $files = @()
if ($ComposeDir) {
  $yml = @('docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml') | ForEach-Object { Join-Path $ComposeDir $_ } | Where-Object { Test-Path $_ } | Select-Object -First 1
  if (-not $yml) { Fail "No docker-compose.yml in $ComposeDir." }
  $files = @($yml)
  $row = docker ps --format '{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.project.working_dir"}}' | Where-Object { ($_ -split '\|')[1] -eq $ComposeDir } | Select-Object -First 1
  $project = if ($row) { ($row -split '\|')[0] } else { (Split-Path -Leaf $ComposeDir).ToLower() }
} else {
  $rows = docker ps --format '{{.Label "com.docker.compose.project"}}|{{.Label "com.docker.compose.project.working_dir"}}|{{.Label "com.docker.compose.project.config_files"}}' | Where-Object { $_ -and -not $_.StartsWith('|') }
  $top = $rows | Group-Object | Sort-Object Count -Descending | Select-Object -First 1
  if (-not $top) { Fail 'No docker compose project runs here. Run with -ComposeDir <the folder with docker-compose.yml>.' }
  $f = $top.Name -split '\|'
  $project = $f[0]; $ComposeDir = $f[1]; $files = @($f[2] -split ',' | Where-Object { $_ -and (Test-Path $_) })
}
if (-not $files.Count) { Fail "Cannot read the compose files of $project. Run with -ComposeDir." }
Say "Deployment: $project in $ComposeDir"
$confDir = Join-Path $ComposeDir 'hci-monitoring'; $conf = Join-Path $confDir 'prometheus.yml'
New-Item -ItemType Directory -Force -Path $confDir | Out-Null

$env:PROMETHEUS_PORT = "$Port"; $env:PROMETHEUS_BIND = $Bind; $env:PROMETHEUS_VERSION = $Version
if (-not $Rescan) {
  if ($Force) { docker rm -f $Name *> $null }
  # the host port must be free (Prometheus's own 9090 inside its container never clashes)
  $inUse = { param($p) (@(Get-NetTCPConnection -State Listen -LocalPort $p -ErrorAction SilentlyContinue).Count -gt 0) -or [bool](docker ps --format '{{.Ports}}' | Select-String ":$p->") }
  if (& $inUse $Port) {
    $free = 9090..9190 | Where-Object { -not (& $inUse $_) } | Select-Object -First 1
    Fail "Port $Port is already in use here. Run again with -Port $free (or another free port)."
  }
  # start with only itself to scrape; the services are added below, once they are known to answer
  if (-not (Test-Path $conf)) { Set-Content -Encoding ascii -Path $conf -Value "global:`n  scrape_interval: 15s`nscrape_configs:`n  - job_name: prometheus`n    static_configs:`n      - targets: [localhost:9090]`n" }
  $dest = Join-Path $ComposeDir 'docker-compose.prometheus.yml'
  if ((Test-Path $dest) -and ((Get-FileHash $dest).Hash -ne (Get-FileHash $Override).Hash)) {
    $bak = "$dest.$(Get-Date -Format yyyyMMdd-HHmmss).bak"; Copy-Item $dest $bak; Say "Kept the old override as $bak"
  }
  Copy-Item $Override $dest -Force
  $dargs = @('compose', '-p', $project, '--project-directory', $ComposeDir)
  foreach ($y in $files) { $dargs += @('-f', $y) }
  # the other kit's override too, so compose knows its container is part of the deployment
  $other = Join-Path $ComposeDir 'docker-compose.cadvisor.yml'; if (Test-Path $other) { $dargs += @('-f', $other) }
  $dargs += @('-f', $dest, 'up', '-d', '--no-deps', 'prometheus')
  Say "docker $($dargs -join ' ')"
  & docker @dargs
  if ($LASTEXITCODE -ne 0) { Fail 'docker compose could not start Prometheus (see above).' }
}

# 3. reach every network the deployment uses, so services answer by their compose names
$ids = @(docker ps -q --filter "label=com.docker.compose.project=$project")
$nets = $ids | ForEach-Object { (docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' $_) -split ' ' } | Where-Object { $_ -and $_ -notin @('host', 'none') } | Sort-Object -Unique
$have = (docker inspect -f '{{range $k, $v := .NetworkSettings.Networks}}{{$k}} {{end}}' $Name) -split ' '
foreach ($n in $nets) { if ($n -notin $have) { docker network connect $n $Name; Say "Joined network $n" } }

# 4. which services answer with metrics, asked from inside Prometheus's own container
Say 'Looking for services that publish metrics...'
$found = @(); $none = @()
foreach ($id in $ids) {
  $svc = docker inspect -f '{{index .Config.Labels "com.docker.compose.service"}}' $id
  if (-not $svc -or $svc -eq 'prometheus') { continue }
  # exposed and published container ports; compose writes "8110" or "8110/tcp"
  $ports = (docker inspect -f '{{range $p, $_ := .Config.ExposedPorts}}{{$p}} {{end}}{{range $p, $_ := .HostConfig.PortBindings}}{{$p}} {{end}}' $id) -split ' ' | ForEach-Object { $_ -replace '/tcp$', '' } | Where-Object { $_ -match '^\d+$' } | ForEach-Object { [int]$_ } | Sort-Object -Unique
  $hit = $null
  foreach ($port in $ports) {
    if ($port -in $Skip) { continue }
    foreach ($path in @('/actuator/prometheus', '/metrics')) {
      $out = docker exec $Name wget -q -T 3 -O - "http://${svc}:$port$path" 2>$null | Select-Object -First 40
      if ($out -match '^# (HELP|TYPE) ') { $hit = @{ job = $svc; target = "${svc}:$port"; path = $path }; break }
    }
    if ($hit) { break }
  }
  if ($hit) { $found += $hit; Say "  metrics: $($hit.target)$($hit.path)" } else { $none += $svc }
}
if (-not $found.Count) { Say 'No service answered with metrics. Prometheus only watches itself until they do (Spring: management.endpoints.web.exposure.include=prometheus).' }

# 5. write prometheus.yml from what answered, keep the old one, restart to load it
if (Test-Path $conf) { Copy-Item $conf "$conf.$(Get-Date -Format yyyyMMdd-HHmmss).bak" }
$y = @("# Written by HCI ONE add-prometheus on $(Get-Date -Format 'yyyy-MM-dd HH:mm'). Run add-prometheus -Rescan after services change.",
  '# Jobs are the compose service names; HCI''s alert rules group by them.',
  'global:', '  scrape_interval: 15s', '  scrape_timeout: 10s', 'scrape_configs:',
  '  - job_name: prometheus', '    static_configs:', '      - targets: [localhost:9090]')
foreach ($h in $found) { $y += @("  - job_name: $($h.job)", "    metrics_path: $($h.path)", '    static_configs:', "      - targets: [$($h.target)]") }
Set-Content -Encoding ascii -Path $conf -Value ($y -join "`n")
docker restart $Name | Out-Null
$ready = $false
for ($i = 0; $i -lt 30 -and -not $ready; $i++) { try { $ready = (Invoke-WebRequest -UseBasicParsing -ErrorAction Stop -TimeoutSec 3 "http://localhost:$Port/-/ready").StatusCode -eq 200 } catch { Start-Sleep -Seconds 2 } }
if (-not $ready) { Fail "Prometheus does not answer on port $Port. See: docker logs $Name" }
Start-Sleep -Seconds 20
$t = try { (Invoke-RestMethod -ErrorAction Stop -TimeoutSec 5 "http://localhost:$Port/api/v1/targets?state=active").data.activeTargets } catch { @() }
Say "Prometheus $Version answers on port $Port and scrapes $($found.Count) service(s) plus itself; $(@($t | Where-Object { $_.health -eq 'up' }).Count) target(s) up."
if ($none.Count) { Say "No metrics from: $($none -join ', ') (fine for databases and services without Spring Boot actuator)." }
Show-Address $Port
