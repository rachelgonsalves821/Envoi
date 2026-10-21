# Gate B-local server (docs/architecture/agent-native-v2/gate-b-local-runbook.md §2).
# Phase B flags on; authenticated REST and every Phase C flag off; local FileStore and development auth.
# Run it in its own window from a clean gate checkout at the gate SHA:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\gate-b-local\start-server.ps1 [-GateDir <private dir>]
# It writes the checkout's SHA to <GateDir>\gate-sha.txt and the built helper's SHA-256 to <GateDir>\gate-helper-sha256.txt;
# the other gate scripts check against both (gate-guard.ps1).
param([string]$GateDir = (Join-Path $env:USERPROFILE 'envoi-gate-b-local'), [int]$Port = 8787)
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
Set-Location $repo
$sha = (git rev-parse HEAD).Trim()
if (git status --porcelain) { throw 'The gate checkout is not clean; build it and commit nothing before the gate.' }
$helper = Join-Path $repo 'integrations\onboarding\dist\envoi-link.mjs'
if (-not (Test-Path $helper)) { throw 'The private helper is not built; run npm ci and npm run build first.' }
New-Item -ItemType Directory -Force $GateDir | Out-Null
[IO.File]::WriteAllText((Join-Path $GateDir 'gate-sha.txt'), "$sha`n")
[IO.File]::WriteAllText((Join-Path $GateDir 'gate-helper-sha256.txt'), "$((Get-FileHash $helper -Algorithm SHA256).Hash.ToLower())`n")
$short = $sha.Substring(0, 7)
$data = Join-Path $GateDir "data-$short"
if (Test-Path $data) { Write-Host "Reusing data directory $data (a restart within this attempt)." } else { Write-Host "Fresh data directory $data." }
$env:DATABASE_URL = ''
$env:ENVOI_AUTH_MODE = 'development'
$env:ENVOI_PORT = "$Port"
$env:ENVOI_DATA_DIR = $data
$env:ENVOI_INSTALLATIONS_V2 = 'true'
$env:ENVOI_AGENT_REGISTRATION_V2 = 'true'
Remove-Item Env:ENVOI_AUTHENTICATED_REST_ROUTE, Env:ENVOI_CASE_SESSIONS_V1, Env:ENVOI_HTTP_WAKE_V1, Env:ENVOI_PROVIDER_BROWSER_POLL -ErrorAction SilentlyContinue
$env:ENVOI_PUBLIC_URL = 'https://localhost:8443'
$env:ENVOI_CORS_ORIGIN = 'https://localhost:8443'
$env:ENVOI_RELEASE_SHA = $sha
$log = Join-Path $GateDir "server-$short.log"
Write-Host "Starting Envoi gate server at $sha on http://127.0.0.1:$Port (log $log)"
# Add-Content keeps the log UTF-8; Tee-Object in Windows PowerShell 5.1 would write UTF-16.
node src/server.js 2>&1 | ForEach-Object { $line = [string]$_; $line; Add-Content -Path $log -Value $line -Encoding utf8 }
