# Gate B-local HTTPS front end: https://localhost:8443 -> http://127.0.0.1:8787 (runbook §2).
# Needs a locally trusted certificate in <GateDir>\localhost.pem and localhost-key.pem. Run it in its own window:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\gate-b-local\start-https.ps1 [-GateDir <private dir>]
param([string]$GateDir = (Join-Path $env:USERPROFILE 'envoi-gate-b-local'))
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $repo
$log = Join-Path $GateDir 'proxy.log'
node scripts/local-https-proxy.mjs --cert (Join-Path $GateDir 'localhost.pem') --key (Join-Path $GateDir 'localhost-key.pem') --listen 8443 --target http://127.0.0.1:8787 2>&1 |
  ForEach-Object { $line = [string]$_; $line; Add-Content -Path $log -Value $line -Encoding utf8 }
