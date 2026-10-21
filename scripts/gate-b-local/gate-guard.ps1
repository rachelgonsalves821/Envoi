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

# One explicit OpenClaw profile for the Gateway and the helper. -Config is that profile's openclaw.json; it defaults to
# the default profile. OPENCLAW_PROFILE alone is refused: OpenClaw 2026.10.5 ignored it while the helper honours it, so
# the two could read different profiles. The helper gets the same profile through OPENCLAW_CONFIG_PATH and
# OPENCLAW_STATE_DIR. A saved connection that names another config or Gateway is refused. Returns the config and port.
function Select-OpenClawProfile([string]$Config, [string]$Origin) {
  if (-not $Config) {
    if ($env:OPENCLAW_PROFILE) { throw "STOP: OPENCLAW_PROFILE is set ($env:OPENCLAW_PROFILE). Pass -OpenClawConfig with that profile's openclaw.json instead." }
    $Config = Join-Path $env:USERPROFILE '.openclaw\openclaw.json'
  }
  if (-not (Test-Path $Config)) { throw "STOP: no OpenClaw config at $Config." }
  $Config = (Resolve-Path $Config).Path
  $port = (Get-Content $Config -Raw | ConvertFrom-Json).gateway.port
  if (-not $port) { $port = 18789 }
  Remove-Item Env:OPENCLAW_PROFILE -ErrorAction SilentlyContinue
  $env:OPENCLAW_CONFIG_PATH = $Config
  $env:OPENCLAW_STATE_DIR = Split-Path $Config
  $sha = [Security.Cryptography.SHA256]::Create().ComputeHash([Text.Encoding]::UTF8.GetBytes($Origin))
  $originKey = (-join ($sha | ForEach-Object { $_.ToString('x2') })).Substring(0, 24)
  $saved = Join-Path $env:LOCALAPPDATA "envoi\onboarding\openclaw\$originKey\connection.json"
  if (Test-Path $saved) {
    $configuration = (Get-Content $saved -Raw | ConvertFrom-Json).configuration
    if ($configuration.configPath -and ((Resolve-Path $configuration.configPath -ErrorAction SilentlyContinue).Path -ne $Config)) { throw "STOP: the saved connection uses $($configuration.configPath), not $Config." }
    if ($configuration.gatewayUrl -and $configuration.gatewayUrl -ne "http://127.0.0.1:$port") { throw "STOP: the saved connection uses the Gateway $($configuration.gatewayUrl), not http://127.0.0.1:$port." }
  }
  return @{ Config = $Config; Port = [int]$port }
}
