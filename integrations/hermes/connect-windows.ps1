param(
  [string]$SinaloaUrl = 'https://sinaloa-staging.rachelgonsalves821.workers.dev',
  [string]$StateDir = '',
  [switch]$PrepareOnly
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$hermesHome = Join-Path $env:LOCALAPPDATA 'hermes'
$hermesExe = Join-Path $hermesHome 'bin\hermes.exe'
$hermesEnv = Join-Path $hermesHome '.env'
$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$bundle = Join-Path $PSScriptRoot 'dist\run.mjs'

if (-not (Test-Path -LiteralPath $hermesExe)) { throw 'Hermes Agent is not installed in the standard Windows location.' }
$origin = [Uri]$SinaloaUrl
if ($origin.Scheme -ne 'https' -or $origin.UserInfo -or $origin.Query -or $origin.Fragment -or $origin.AbsolutePath -ne '/') {
  throw 'SinaloaUrl must be an HTTPS site origin without credentials or a path.'
}
if (-not $StateDir) { $StateDir = Join-Path $env:LOCALAPPDATA "Sinaloa\HermesBridge\$($origin.Host)" }
$session = Join-Path $StateDir 'session.json'

# This key authorizes the local bridge to call the local Hermes Gateway. It is
# never sent to Sinaloa or included in an agent prompt.
$lines = if (Test-Path -LiteralPath $hermesEnv) { [string[]][IO.File]::ReadAllLines($hermesEnv) } else { [string[]]@() }
$enabledIndexes = @()
$keyIndexes = @()
for ($i = 0; $i -lt $lines.Length; $i++) {
  if ($lines[$i] -match '^[ \t]*API_SERVER_ENABLED=') { $enabledIndexes += $i }
  if ($lines[$i] -match '^[ \t]*API_SERVER_KEY=') { $keyIndexes += $i }
}
if ($enabledIndexes.Count -gt 1 -or $keyIndexes.Count -gt 1) { throw 'Hermes has duplicate API Server settings; resolve them before connecting.' }
$changed = $false
if ($enabledIndexes.Count -eq 0) { $lines += 'API_SERVER_ENABLED=true'; $changed = $true }
elseif ($lines[$enabledIndexes[0]] -ne 'API_SERVER_ENABLED=true') { $lines[$enabledIndexes[0]] = 'API_SERVER_ENABLED=true'; $changed = $true }

$apiKey = if ($keyIndexes.Count -eq 1) { ($lines[$keyIndexes[0]] -replace '^[ \t]*API_SERVER_KEY=', '').Trim().Trim('"', "'") } else { '' }
if (-not $apiKey) {
  $bytes = New-Object byte[] 32
  $rng = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $rng.GetBytes($bytes) } finally { $rng.Dispose() }
  $apiKey = [BitConverter]::ToString($bytes).Replace('-', '').ToLowerInvariant()
  if ($keyIndexes.Count -eq 1) { $lines[$keyIndexes[0]] = "API_SERVER_KEY=$apiKey" }
  else { $lines += "API_SERVER_KEY=$apiKey" }
  $changed = $true
}
if ($changed) { [IO.File]::WriteAllLines($hermesEnv, $lines, [Text.UTF8Encoding]::new($false)) }

$gatewayExit = 0
if ($changed) { & $hermesExe gateway restart | Out-Null; $gatewayExit = $LASTEXITCODE }
else {
  $listener = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 8642 -State Listen -ErrorAction SilentlyContinue
  if (-not $listener) { & $hermesExe gateway start | Out-Null; $gatewayExit = $LASTEXITCODE }
}
if ($gatewayExit -ne 0) { throw 'Hermes Gateway could not start.' }
$listener = $null
for ($attempt = 0; $attempt -lt 30 -and -not $listener; $attempt++) {
  $listener = Get-NetTCPConnection -LocalAddress '127.0.0.1' -LocalPort 8642 -State Listen -ErrorAction SilentlyContinue
  if (-not $listener) { Start-Sleep -Milliseconds 500 }
}
if (-not $listener) { throw 'Hermes API Server did not start on 127.0.0.1:8642.' }

Push-Location $repoRoot
try {
  $vite = Join-Path $repoRoot 'node_modules\.bin\vite.cmd'
  if (-not (Test-Path -LiteralPath $vite)) {
    & npm.cmd ci
    if ($LASTEXITCODE -ne 0) { throw 'Sinaloa dependencies could not be installed.' }
  }
  & $vite build --config integrations/hermes/vite.config.ts
  if ($LASTEXITCODE -ne 0 -or -not (Test-Path -LiteralPath $bundle)) { throw 'Hermes bridge build failed.' }
}
finally { Pop-Location }

if ($PrepareOnly) {
  Write-Host 'Hermes Gateway and Sinaloa bridge are ready. Run this script again without -PrepareOnly after creating an enrollment token.'
  return
}

$env:SINALOA_API_URL = $origin.GetLeftPart([UriPartial]::Authority)
$env:SINALOA_STATE_DIR = $StateDir
$env:HERMES_API_URL = 'http://127.0.0.1:8642'
$env:HERMES_API_KEY = $apiKey

try {
  if (-not (Test-Path -LiteralPath $session)) {
    Write-Host 'Create a fresh token in Sinaloa > Agent connections > Enroll an agent.'
    $secureToken = Read-Host 'Paste the one-use enrollment token here' -AsSecureString
    $handle = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
    try { $env:SINALOA_ENROLLMENT_TOKEN = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($handle) }
    finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($handle) }
    if (-not $env:SINALOA_ENROLLMENT_TOKEN) { throw 'An enrollment token is required.' }
  }
  Write-Host 'Connecting Hermes to Sinaloa. Keep this terminal open while testing.'
  & node $bundle
  if ($LASTEXITCODE -ne 0) { throw 'The Hermes bridge stopped. Verify the Gateway and use a fresh token if enrollment did not finish.' }
}
finally {
  Remove-Item Env:\SINALOA_ENROLLMENT_TOKEN, Env:\SINALOA_API_URL, Env:\SINALOA_STATE_DIR, Env:\HERMES_API_URL, Env:\HERMES_API_KEY -ErrorAction SilentlyContinue
}
