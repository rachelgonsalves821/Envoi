# Gate B-local: restart the OpenClaw connector for an already activated installation (rows 13-15), with every
# precondition checked. Not for the first activation: the host-native confirmation needs a plain interactive
# `envoi-link resume`. Run it in its OWN window, never the window running `openclaw gateway`:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\gate-b-local\start-openclaw-connector.ps1 [-GateDir <dir>] [-Node24 <node.exe>]
# Output is mirrored to <GateDir>\openclaw-connector.log; long tokens are redacted.
param([string]$GateDir = (Join-Path $env:USERPROFILE 'envoi-gate-b-local'),
  [string]$Node24 = $(if ($env:ENVOI_GATE_NODE24) { $env:ENVOI_GATE_NODE24 } else { 'C:\envoi-gate\node24\node.exe' }),
  [string]$NpmPrefix = $(if ($env:ENVOI_GATE_OPENCLAW_PREFIX) { $env:ENVOI_GATE_OPENCLAW_PREFIX } else { 'C:\envoi-gate\openclaw-npm' }),
  [string]$Origin = 'https://localhost:8443')
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$helper = Join-Path $repo 'integrations\onboarding\dist\envoi-link.mjs'
$gateSha = (Get-Content (Join-Path $GateDir 'gate-sha.txt') -Raw).Trim()
$log = Join-Path $GateDir 'openclaw-connector.log'
function Say($text) { $line = '{0:HH:mm:ss} {1}' -f (Get-Date), $text; Write-Host $line; Add-Content -Path $log -Value $line -Encoding utf8 }

$host.UI.RawUI.WindowTitle = 'OpenClaw connector'
Add-Content -Path $log -Value "`n===== start $(Get-Date -Format o) =====" -Encoding utf8

# 1. The same environment as the OpenClaw Gateway window: Node 24, the OpenClaw npm prefix, the gate CA.
$env:Path = "$NpmPrefix;$(Split-Path $Node24);" + $env:Path
$env:npm_config_prefix = $NpmPrefix
Remove-Item Env:OPENCLAW_PROFILE -ErrorAction SilentlyContinue
$env:NODE_EXTRA_CA_CERTS = Join-Path $GateDir 'localhost.pem'
Set-Location (Join-Path $GateDir 'agent-workdir')
Say "node $(& $Node24 --version), CA $(Test-Path $env:NODE_EXTRA_CA_CERTS), folder $(Get-Location)"

# 2. Preconditions: the gate answers on the gate SHA, the OpenClaw Gateway answers, no other OpenClaw connector runs.
$check = & $Node24 -e "const t=(u)=>fetch(u,{signal:AbortSignal.timeout(10000)}).then(async r=>{const b=await r.text();let s='';try{s=JSON.parse(b).releaseSha||''}catch{};return u+' '+r.status+' '+s}).catch(e=>u+' ERR '+(e.cause?.code||e.name));Promise.all([t('$Origin/health'),t('http://127.0.0.1:18789/health')]).then(r=>console.log(r.join(' | ')))"
Say "preflight: $check"
if ($check -notmatch ("$Origin/health 200 " + $gateSha)) { Say "STOP: the gate server is not answering on the gate SHA $gateSha."; exit 1 }
if ($check -notmatch '18789/health 200') { Say 'STOP: the OpenClaw Gateway is not answering on 127.0.0.1:18789. Start `openclaw gateway` in its own window, wait for "gateway ready", then rerun this script.'; exit 1 }
$other = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'envoi-link\.mjs.*--runtime openclaw' }
if ($other) { Say "STOP: an OpenClaw connector is already running (PID $($other.ProcessId -join ','))."; exit 1 }

# 3. Run the connector in the foreground. "connected" is printed before the loop starts; confirm on the server.
Say "starting: envoi-link resume $Origin --runtime openclaw (leave this window open)"
& $Node24 $helper resume $Origin --runtime openclaw 2>&1 | ForEach-Object { $text = [string]$_; Say ($text -replace '[A-Za-z0-9_\-]{40,}', '<redacted>') }
Say "connector exited with code $LASTEXITCODE"
