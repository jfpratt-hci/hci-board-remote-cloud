# Shared by add-cadvisor.ps1 and add-prometheus.ps1: lets only the Board Remote PCs reach a monitoring port.
# cAdvisor and Prometheus have no sign in, so the port is closed to everyone else on the network with a
# Windows Firewall block rule for every other address (a block rule wins over Docker Desktop's allow rules).
#   -Allow 10.4.2.15,10.4.2.16   only those addresses (the Board Remote PCs)
#   -Open                        no rule: anyone on the network can reach the port
function Test-Allow {
  if (-not $Allow -and -not $Open) { Fail 'Say which Board Remote PCs may read this port: -Allow <PC address>[,<PC address>]. (-Open leaves it reachable from the whole network.)' }
  foreach ($ip in ($Allow -split ',' | Where-Object { $_ })) { if ($ip.Trim() -notmatch '^(\d{1,3}\.){3}\d{1,3}$') { Fail "-Allow takes IPv4 addresses, for example 10.4.2.15: $ip" } }
}
function ConvertTo-UInt($ip) { $b = ([System.Net.IPAddress]::Parse($ip)).GetAddressBytes(); [array]::Reverse($b); [BitConverter]::ToUInt32($b, 0) }
function ConvertTo-Ip([uint32]$n) { $b = [BitConverter]::GetBytes($n); [array]::Reverse($b); ([System.Net.IPAddress]::new($b)).ToString() }
# every IPv4 address except the allowed ones, as ranges Windows Firewall takes ("1.0.0.0-10.4.2.14")
function Get-OtherRanges([string[]]$ips) {
  $keep = $ips | ForEach-Object { ConvertTo-UInt $_.Trim() } | Sort-Object -Unique
  $out = @(); [uint64]$start = 0
  foreach ($k in $keep) { if ($k -gt $start) { $out += (ConvertTo-Ip ([uint32]$start)) + '-' + (ConvertTo-Ip ([uint32]($k - 1))) }; $start = [uint64]$k + 1 }
  if ($start -le [uint32]::MaxValue) { $out += (ConvertTo-Ip ([uint32]$start)) + '-255.255.255.255' }
  $out
}
function Lock-Port($port) {
  if ($Open) { Say "Port $port is open to the whole network (-Open)."; return }
  $name = "HCI ONE monitoring $port"
  try {
    Get-NetFirewallRule -DisplayName "$name*" -ErrorAction SilentlyContinue | Remove-NetFirewallRule -ErrorAction Stop
    New-NetFirewallRule -DisplayName "$name, other addresses blocked" -Direction Inbound -Protocol TCP -LocalPort $port -RemoteAddress (Get-OtherRanges ($Allow -split ',' | Where-Object { $_ })) -Action Block -ErrorAction Stop | Out-Null
    Say "Port $port answers only $Allow. Windows Firewall rule: $name, other addresses blocked."
  } catch {
    Say "Could not set the firewall rule ($($_.Exception.Message)). Run PowerShell as administrator, or allow port $port only from $Allow yourself."
  }
}
