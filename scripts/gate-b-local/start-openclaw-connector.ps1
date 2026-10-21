# Gate B-local: restart the OpenClaw connector for an already activated installation (rows 13-15), with every
# precondition checked. Not for the first activation: the host-native confirmation needs a plain interactive
# `envoi-link resume`. Run it in its OWN window, never the window running `openclaw gateway`:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\gate-b-local\start-openclaw-connector.ps1 [-GateDir <dir>] [-Node24 <node.exe>] [-OpenClawConfig <openclaw.json>]
# Output is mirrored to <GateDir>\openclaw-connector.log; long tokens are redacted.
param([string]$GateDir = (Join-Path $env:USERPROFILE 'envoi-gate-b-local'),
  [string]$Node24 = $(if ($env:ENVOI_GATE_NODE24) { $env:ENVOI_GATE_NODE24 } else { 'C:\envoi-gate\node24\node.exe' }),
  [string]$NpmPrefix = $(if ($env:ENVOI_GATE_OPENCLAW_PREFIX) { $env:ENVOI_GATE_OPENCLAW_PREFIX } else { 'C:\envoi-gate\openclaw-npm' }),
  [string]$OpenClawConfig = '',
  [string]$Origin = 'https://localhost:8443')
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$helper = Join-Path $repo 'integrations\onboarding\dist\envoi-link.mjs'
. (Join-Path $PSScriptRoot 'gate-guard.ps1')
$log = Join-Path $GateDir 'openclaw-connector.log'
function Say($text) { $line = '{0:HH:mm:ss} {1}' -f (Get-Date), $text; Write-Host $line; Add-Content -Path $log -Value $line -Encoding utf8 }

$host.UI.RawUI.WindowTitle = 'OpenClaw connector'
Add-Content -Path $log -Value "`n===== start $(Get-Date -Format o) =====" -Encoding utf8

# 1. The gate's checkout and helper bytes, and one explicit OpenClaw profile for the Gateway and the helper.
try { $gateSha = Assert-GateArtifact $repo $GateDir $helper; $openclaw = Select-OpenClawProfile $OpenClawConfig $Origin } catch { Say $_.Exception.Message; exit 1 }
Say "gate $gateSha, helper matches; OpenClaw config $($openclaw.Config), Gateway port $($openclaw.Port)"

# 2. The same environment as the OpenClaw Gateway window: Node 24, the OpenClaw npm prefix, the gate CA.
$env:Path = "$NpmPrefix;$(Split-Path $Node24);" + $env:Path
$env:npm_config_prefix = $NpmPrefix
$env:NODE_EXTRA_CA_CERTS = Join-Path $GateDir 'localhost.pem'
Set-Location (Join-Path $GateDir 'agent-workdir')
Say "node $(& $Node24 --version), CA $(Test-Path $env:NODE_EXTRA_CA_CERTS), folder $(Get-Location)"

# 3. Preconditions: the gate answers on the gate SHA, that profile's Gateway answers, no other OpenClaw connector runs.
$gateway = "http://127.0.0.1:$($openclaw.Port)/health"
$check = & $Node24 -e "const t=(u)=>fetch(u,{signal:AbortSignal.timeout(10000)}).then(async r=>{const b=await r.text();let s='';try{s=JSON.parse(b).releaseSha||''}catch{};return u+' '+r.status+' '+s}).catch(e=>u+' ERR '+(e.cause?.code||e.name));Promise.all([t('$Origin/health'),t('$gateway')]).then(r=>console.log(r.join(' | ')))"
Say "preflight: $check"
if ($check -notmatch ("$Origin/health 200 " + $gateSha)) { Say "STOP: the gate server is not answering on the gate SHA $gateSha."; exit 1 }
if ($check -notmatch ([regex]::Escape($gateway) + ' 200')) { Say "STOP: the OpenClaw Gateway is not answering on $gateway. Start ``openclaw gateway`` in its own window, wait until it answers, then rerun this script."; exit 1 }
$other = Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'envoi-link\.mjs.*--runtime openclaw' }
if ($other) { Say "STOP: an OpenClaw connector is already running (PID $($other.ProcessId -join ','))."; exit 1 }

# 4. Run the connector in the foreground. "connected" is printed before the loop starts; confirm on the server.
Say "starting: envoi-link resume $Origin --runtime openclaw (leave this window open)"
& $Node24 $helper resume $Origin --runtime openclaw 2>&1 | ForEach-Object { $text = [string]$_; Say ($text -replace '[A-Za-z0-9_\-]{40,}', '<redacted>') }
Say "connector exited with code $LASTEXITCODE"
