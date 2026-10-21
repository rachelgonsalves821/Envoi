# Gate B-local rows 18-20: reconnect the revoked OpenClaw agent as the SAME agent (existing_agent).
# Run it in its OWN interactive window (not the `openclaw gateway` window) and leave that window open afterwards:
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\gate-b-local\reconnect-openclaw.ps1 [-GateDir <dir>] [-Node24 <node.exe>] [-OpenClawConfig <openclaw.json>]
# It never prints a credential. The claim code it shows is for the owner only: type it at /claim, never paste it anywhere else.
param([string]$GateDir = (Join-Path $env:USERPROFILE 'envoi-gate-b-local'),
  [string]$Node24 = $(if ($env:ENVOI_GATE_NODE24) { $env:ENVOI_GATE_NODE24 } else { 'C:\envoi-gate\node24\node.exe' }),
  [string]$NpmPrefix = $(if ($env:ENVOI_GATE_OPENCLAW_PREFIX) { $env:ENVOI_GATE_OPENCLAW_PREFIX } else { 'C:\envoi-gate\openclaw-npm' }),
  [string]$OpenClawConfig = '',
  [string]$Origin = 'https://localhost:8443')
$ErrorActionPreference = 'Stop'
$repo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$helper = Join-Path $repo 'integrations\onboarding\dist\envoi-link.mjs'
. (Join-Path $PSScriptRoot 'gate-guard.ps1')
$host.UI.RawUI.WindowTitle = 'OpenClaw reconnect'

# 1. The gate's checkout and helper bytes, and one explicit OpenClaw profile for the Gateway and the helper.
try { $gateSha = Assert-GateArtifact $repo $GateDir $helper; $openclaw = Select-OpenClawProfile $OpenClawConfig $Origin } catch { Write-Host $_.Exception.Message -ForegroundColor Red; exit 1 }
Write-Host "Gate $gateSha, helper matches; OpenClaw config $($openclaw.Config), Gateway port $($openclaw.Port)"

# 2. The same environment as the OpenClaw Gateway window.
$env:Path = "$NpmPrefix;$(Split-Path $Node24);" + $env:Path
$env:npm_config_prefix = $NpmPrefix
$env:NODE_EXTRA_CA_CERTS = Join-Path $GateDir 'localhost.pem'
Set-Location (Join-Path $GateDir 'agent-workdir')
Write-Host "Node $(& $Node24 --version), working folder $(Get-Location)"

# 3. Preconditions: the gate on the gate SHA, that profile's Gateway answering, no OpenClaw connector running.
$gateway = "http://127.0.0.1:$($openclaw.Port)/health"
$check = & $Node24 -e "const t=(u)=>fetch(u,{signal:AbortSignal.timeout(10000)}).then(async r=>{const b=await r.text();let s='';try{s=JSON.parse(b).releaseSha||''}catch{};return u+' '+r.status+' '+s}).catch(e=>u+' ERR '+(e.cause?.code||e.name));Promise.all([t('$Origin/health'),t('$gateway')]).then(r=>console.log(r.join(' | ')))"
Write-Host "Preflight: $check"
if ($check -notmatch ("$Origin/health 200 " + $gateSha)) { Write-Host "STOP: the gate server is not answering on the gate SHA $gateSha." -ForegroundColor Red; exit 1 }
if ($check -notmatch ([regex]::Escape($gateway) + ' 200')) { Write-Host "STOP: the OpenClaw Gateway is not answering on $gateway. Start ``openclaw gateway`` in its own window, wait until it answers, then rerun this script." -ForegroundColor Red; exit 1 }
if (Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -match 'envoi-link\.mjs.*--runtime openclaw' }) { Write-Host 'STOP: an OpenClaw connector is already running.' -ForegroundColor Red; exit 1 }

# 4. The saved connection must already record the revoke. Expected: "state":"revoked".
Write-Host "`nStep A - saved connection status (expected: revoked):" -ForegroundColor Cyan
$status = & $Node24 $helper status $Origin --runtime openclaw 2>&1 | Out-String
Write-Host $status.Trim()
if ($status -notmatch '"state":"(revoked|registration_ended|needs_reconnect)"') { Write-Host 'STOP: the saved connection is not marked as ended. Send this output to Lane A before going on.' -ForegroundColor Red; exit 1 }

# 5. One new registration for the same agent. Interactive; it stays in the foreground as the connector.
Write-Host "`nStep B - new registration. When the claim URL and code appear:" -ForegroundColor Cyan
Write-Host '  1. Open the claim URL in the signed-in browser and type the code there.'
Write-Host '  2. Choose "Reconnect an existing agent" and pick the revoked agent. Do not create a new agent.'
Write-Host '  3. Approve, then come back here and confirm when this window asks (check: workspace, agent, permissions).'
Write-Host '  4. Leave this window open afterwards: it becomes the OpenClaw connector.'
& $Node24 $helper connect $Origin --runtime openclaw --new
Write-Host "Connector exited with code $LASTEXITCODE" -ForegroundColor Yellow
