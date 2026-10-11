# Windows-side SSM tunnels to the AUTOMINUS rig.
# NOTE: WSL is NAT mode -> tunnels opened here are reachable only from Windows (browser, Windows node),
#       NOT from the worker in WSL. For the worker use: wsl -d Ubuntu -- bash -lc 'cd ~/mongomation; bash scripts/rig-tunnels.sh start'
#
# Usage:  powershell -ExecutionPolicy Bypass -File scripts\rig-tunnels.ps1 start [-Modbus]
#         powershell -ExecutionPolicy Bypass -File scripts\rig-tunnels.ps1 status|stop
# Env: RIG_INSTANCE + RIG_FIO_HOST required (values in the private ENDPOINTS.md handoff; read from env, else from
#      the repo's gitignored .env), RIG_REGION (default us-west-2), AWS_PROFILE respected.
# Requires AWS CLI v2 + Session Manager plugin for Windows, and a valid AWS login.
param([Parameter(Position=0)][string]$Action = "help", [switch]$Modbus)

$EnvFile = if ($env:RIG_ENV_FILE) { $env:RIG_ENV_FILE } else { Join-Path (Split-Path $PSScriptRoot -Parent) ".env" }
function From-Env($k) {
  $v = [Environment]::GetEnvironmentVariable($k)
  if ($v) { return $v }
  if (Test-Path $EnvFile) {
    $line = Get-Content $EnvFile | Where-Object { $_ -match "^$k=" } | Select-Object -Last 1
    if ($line) { return ($line -replace "^$k=", "").Trim().Trim('"', "'") }
  }
  return ""
}
$Region   = From-Env "RIG_REGION"; if (-not $Region) { $Region = "us-west-2" }
$Instance = From-Env "RIG_INSTANCE"
$FioHost  = From-Env "RIG_FIO_HOST"
$Dir = Join-Path $env:TEMP "rig-tunnels"
New-Item -ItemType Directory -Force $Dir | Out-Null

function Test-Port($p) { try { $c = New-Object Net.Sockets.TcpClient; $c.Connect("127.0.0.1", $p); $c.Close(); $true } catch { $false } }

function Start-Tunnel($lport, $doc, $params) {
  $pidf = Join-Path $Dir "$lport.pid"
  if ((Test-Path $pidf) -and (Get-Process -Id (Get-Content $pidf) -ErrorAction SilentlyContinue)) { "[$lport] already running"; return }
  if (Test-Port $lport) { "[$lport] port already in use - skipping"; return }
  $log = Join-Path $Dir "$lport.log"
  $p = Start-Process -FilePath "aws" -WindowStyle Hidden -PassThru `
        -RedirectStandardOutput $log -RedirectStandardError "$log.err" `
        -ArgumentList @("ssm","start-session","--region",$Region,"--target",$Instance,"--document-name",$doc,"--parameters",$params)
  Set-Content -Path $pidf -Value $p.Id
  "[$lport] started (pid $($p.Id), log $log)"
}

switch ($Action) {
  "start" {
    if (-not $Instance -or -not $FioHost) {
      "Set RIG_INSTANCE (EC2 instance id) and RIG_FIO_HOST (Factory I/O private IP) - see the private ENDPOINTS.md handoff (section 2)."; exit 3 }
    if (-not (Get-Command session-manager-plugin -ErrorAction SilentlyContinue) -and
        -not (Test-Path "C:\Program Files\Amazon\SessionManagerPlugin\bin\session-manager-plugin.exe")) {
      "Session Manager plugin for Windows not installed."; exit 1 }
    aws sts get-caller-identity --region $Region *> $null
    if ($LASTEXITCODE -ne 0) { "AWS not logged in. Run: aws login   (or aws sso login --profile <p>)"; exit 2 }
    Start-Tunnel 8443 "AWS-StartPortForwardingSession" "portNumber=8443,localPortNumber=8443"
    Start-Tunnel 7410 "AWS-StartPortForwardingSessionToRemoteHost" "host=$FioHost,portNumber=7410,localPortNumber=7410"
    if ($Modbus) { Start-Tunnel 5020 "AWS-StartPortForwardingSession" "portNumber=502,localPortNumber=5020" }
  }
  "stop" {
    Get-ChildItem $Dir -Filter *.pid | ForEach-Object {
      $id = Get-Content $_.FullName
      & taskkill /PID $id /T /F *> $null
      "[$($_.BaseName)] stopped (pid $id)"; Remove-Item $_.FullName
    }
  }
  "status" { foreach ($p in 8443, 7410, 5020) { "[$p] port: " + $(if (Test-Port $p) { "listening" } else { "closed" }) } }
  default { Get-Content $PSCommandPath -TotalCount 8 }
}
