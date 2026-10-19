# Gate B-local: make a NEW, uncloned Hermes profile ready for the gate, after it was created and its model set:
#   & $hermes profile create <name> --no-alias ; & $hermes -p <name> model
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\gate-b-local\prepare-hermes-profile.ps1 -ProfileName <name>
# It checks the profile is fresh (no MCP servers and no Envoi config or skill), sets gateway.standalone: true (one
# Gateway per profile), and enables the local API Server on 127.0.0.1:<Port> with a new private key that is never printed.
param([Parameter(Mandatory = $true)][ValidatePattern('^[a-z0-9][a-z0-9_-]{0,40}$')][string]$ProfileName, [int]$Port = 8652)
$ErrorActionPreference = 'Stop'
$profileHome = Join-Path $env:LOCALAPPDATA "hermes\profiles\$ProfileName"
$config = Join-Path $profileHome 'config.yaml'
if (-not (Test-Path $config)) { throw "Profile $ProfileName not found. Create it first: hermes profile create $ProfileName --no-alias, then hermes -p $ProfileName model" }
$text = [IO.File]::ReadAllText($config)

# 1. Fresh: no Envoi configuration, no MCP servers, no Envoi skill, and a model set.
if ($text -match '(?im)envoi') { throw "config.yaml of $ProfileName already mentions Envoi; it is not fresh. Use a new profile name." }
if ($text -match '(?m)^mcp_servers:\s*\r?\n[ \t]+\S') { throw "$ProfileName already has MCP servers configured; it is not fresh. Use a new profile name." }
$skills = Join-Path $profileHome 'skills'
if (Test-Path $skills) {
  # Look only below skills\ (the profile name itself may contain "envoi"), at names and contents.
  $root = (Resolve-Path $skills).Path.TrimEnd('\') + '\'
  $files = Get-ChildItem $skills -Recurse -File -ErrorAction SilentlyContinue
  $named = $files | Where-Object { $_.FullName.Substring($root.Length) -match '(?i)envoi' }
  $mentions = $files | Where-Object { $_.Length -lt 1MB } | Select-String -Pattern 'envoi' -SimpleMatch -List -ErrorAction SilentlyContinue
  if ($named -or $mentions) { throw "$ProfileName has an Envoi skill; it is not fresh. Use a new profile name." }
}
if ($text -notmatch '(?m)^model:\s*\r?\n[ \t]+\S') { throw "$ProfileName has no model configured yet. Run: hermes -p $ProfileName model" }

# 2. One Gateway per profile.
if ($text -match '(?m)^gateway:\s*\r?\n[ \t]+standalone:\s*true') { Write-Host 'gateway.standalone is already true.' }
elseif ($text -match '(?m)^gateway:') { throw 'config.yaml already has a gateway: section without standalone: true. Add `standalone: true` under it by hand, then rerun.' }
else { Add-Content -Path $config -Value "gateway:`n  standalone: true" -Encoding utf8; Write-Host 'Set gateway.standalone: true.' }

# 3. Local API Server: the helper calls this profile's Gateway on loopback.
$envFile = Join-Path $profileHome '.env'
$lines = if (Test-Path -LiteralPath $envFile) { [string[]][IO.File]::ReadAllLines($envFile) } else { [string[]]@() }
foreach ($name in 'API_SERVER_ENABLED', 'API_SERVER_PORT', 'API_SERVER_KEY') {
  if ($lines | Where-Object { $_ -match "^[ \t]*$name=" }) { throw "$name is already set in $envFile; leaving it unchanged. Check it by hand." }
}
$bytes = New-Object byte[] 32
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
$key = [Convert]::ToBase64String($bytes).TrimEnd('=').Replace('+', '-').Replace('/', '_')
$lines += 'API_SERVER_ENABLED=true', "API_SERVER_PORT=$Port", "API_SERVER_KEY=$key"
[IO.File]::WriteAllLines($envFile, $lines)
Write-Host "API Server enabled for $ProfileName on http://127.0.0.1:$Port (key written to its private .env, not shown)."
Write-Host "Next: start its Gateway in its own window: hermes -p $ProfileName gateway run"
