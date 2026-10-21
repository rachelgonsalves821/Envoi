# Gate B-local: shared checks for the OpenClaw operator scripts (Rachel's review on #160, comment 6279202285).
# Dot-source it, then call the two functions before invoking the helper. Each throws "STOP: ..." instead of repairing.

# The checkout and the built helper must be the gate's: HEAD equals gate-sha.txt, the tree is clean, and the helper's
# SHA-256 equals the one start-server.ps1 recorded when the gate started. Returns the gate SHA.
function Assert-GateArtifact([string]$Repo, [string]$GateDir, [string]$Helper) {
  $gateSha = (Get-Content (Join-Path $GateDir 'gate-sha.txt') -Raw).Trim()
  $head = (git -C $Repo rev-parse HEAD).Trim()
  if ($head -ne $gateSha) { throw "STOP: this checkout is at $head, not the gate SHA $gateSha. Run the script from the gate checkout." }
  if (git -C $Repo status --porcelain) { throw 'STOP: the gate checkout has local changes. Do not rebuild or edit it mid-gate.' }
  $pinned = Join-Path $GateDir 'gate-helper-sha256.txt'
  if (-not (Test-Path $pinned)) { throw "STOP: $pinned is missing. start-server.ps1 records it when the gate starts." }
  $expected = (Get-Content $pinned -Raw).Trim()
  $actual = (Get-FileHash $Helper -Algorithm SHA256).Hash.ToLower()
  if ($actual -ne $expected) { throw "STOP: the helper $Helper is $actual, not the gate helper $expected." }
  return $gateSha
}

# One OpenClaw profile and Gateway for both the Gateway window and the helper, resolved the way the helper resolves
# them (integrations/openclaw/quick-connect-config.ts, discoverOpenClaw; Rachel's review on #167, 6304969215):
#   config:  OPENCLAW_CONFIG_PATH, else OPENCLAW_STATE_DIR\openclaw.json, else <OPENCLAW_HOME or home>\.openclaw\openclaw.json;
#   Gateway: OPENCLAW_GATEWAY_URL, else the config's gateway.url, else http://127.0.0.1:<OPENCLAW_GATEWAY_PORT or gateway.port or 18789>.
# -Config selects the config explicitly; without it an inherited config or state selector is honoured, and the default
# profile is used only when there is none. Conflicting selectors are refused, and so is OPENCLAW_PROFILE without an
# explicit config (OpenClaw 2026.10.5 ignored it while the helper honours it). Inherited Gateway URL/port selectors stay
# in effect for the helper, so the origin returned here, which the scripts probe, is the one the helper will use. A saved
# connection that names another config or Gateway is refused. Returns the config and the Gateway origin.
function Select-OpenClawProfile([string]$Config, [string]$Origin) {
  $full = { param($p) [IO.Path]::GetFullPath($p).TrimEnd('\') }
  if ($env:OPENCLAW_CONFIG_PATH -and $env:OPENCLAW_STATE_DIR -and ((& $full (Split-Path $env:OPENCLAW_CONFIG_PATH)) -ne (& $full $env:OPENCLAW_STATE_DIR))) {
    throw "STOP: OPENCLAW_CONFIG_PATH ($env:OPENCLAW_CONFIG_PATH) and OPENCLAW_STATE_DIR ($env:OPENCLAW_STATE_DIR) name different profiles."
  }
  $inherited = if ($env:OPENCLAW_CONFIG_PATH) { $env:OPENCLAW_CONFIG_PATH } elseif ($env:OPENCLAW_STATE_DIR) { Join-Path $env:OPENCLAW_STATE_DIR 'openclaw.json' } else { $null }
  if ($Config -and $inherited -and ((& $full $Config) -ne (& $full $inherited))) { throw "STOP: -OpenClawConfig $Config conflicts with the inherited OpenClaw selector ($inherited). Clear OPENCLAW_CONFIG_PATH/OPENCLAW_STATE_DIR or pass the same config." }
  if (-not $Config) { $Config = $inherited }
  if (-not $Config) {
    if ($env:OPENCLAW_PROFILE) { throw "STOP: OPENCLAW_PROFILE is set ($env:OPENCLAW_PROFILE). Pass -OpenClawConfig with that profile's openclaw.json instead." }
    $Config = Join-Path $(if ($env:OPENCLAW_HOME) { $env:OPENCLAW_HOME } else { $env:USERPROFILE }) '.openclaw\openclaw.json'
  }
  if (-not (Test-Path $Config)) { throw "STOP: no OpenClaw config at $Config." }
  $Config = & $full (Resolve-Path $Config).Path
  $gateway = (Get-Content $Config -Raw | ConvertFrom-Json).gateway
  $port = if ($env:OPENCLAW_GATEWAY_PORT) { $env:OPENCLAW_GATEWAY_PORT } elseif ($gateway.port) { $gateway.port } else { 18789 }
  $url = if ($env:OPENCLAW_GATEWAY_URL) { $env:OPENCLAW_GATEWAY_URL } elseif ($gateway.url) { $gateway.url } else { "http://127.0.0.1:$port" }
  try { $gatewayOrigin = ([Uri]$url).GetLeftPart([UriPartial]::Authority) } catch { throw "STOP: the OpenClaw Gateway selector $url is not a URL." }
  if (([Uri]$gatewayOrigin).Host -notin 'localhost', '127.0.0.1', '[::1]') { throw "STOP: the OpenClaw Gateway $gatewayOrigin is not on this host; the gate uses a local Gateway only." }
  Remove-Item Env:OPENCLAW_PROFILE -ErrorAction SilentlyContinue
  $env:OPENCLAW_CONFIG_PATH = $Config
  $env:OPENCLAW_STATE_DIR = Split-Path $Config
  $sha = [Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($Origin))
  $originKey = (-join ($sha | ForEach-Object { $_.ToString('x2') })).Substring(0, 24)
  $saved = Join-Path $env:LOCALAPPDATA "envoi\onboarding\openclaw\$originKey\connection.json"
  if (Test-Path $saved) {
    $configuration = (Get-Content $saved -Raw | ConvertFrom-Json).configuration
    if ($configuration.configPath -and ((& $full $configuration.configPath) -ne $Config)) { throw "STOP: the saved connection uses $($configuration.configPath), not $Config." }
    if ($configuration.gatewayUrl -and (([Uri]$configuration.gatewayUrl).GetLeftPart([UriPartial]::Authority) -ne $gatewayOrigin)) { throw "STOP: the saved connection uses the Gateway $($configuration.gatewayUrl), not $gatewayOrigin." }
  }
  return @{ Config = $Config; Gateway = $gatewayOrigin }
}
