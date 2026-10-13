param(
    [Parameter(Mandatory = $true)]
    [ValidateSet('Setup', 'ModelTurn')]
    [string]$Action,
    [string]$Provider,
    [string]$Model,
    [Parameter(Mandatory = $true)]
    [string]$HermesHome
)

$ErrorActionPreference = 'Stop'
if (-not [System.IO.Path]::IsPathRooted($HermesHome) -or $HermesHome -notmatch '^(?:[A-Za-z]:[\\/]|\\\\)') {
    throw 'Supply an absolute disposable HermesHome.'
}
$profile = [System.IO.Path]::GetFullPath($HermesHome).TrimEnd('\')
$normalHome = [System.IO.Path]::GetFullPath((Join-Path $env:LOCALAPPDATA 'hermes')).TrimEnd('\')
if ($profile -eq $normalHome -or $profile.StartsWith($normalHome + '\', [System.StringComparison]::OrdinalIgnoreCase) -or $normalHome.StartsWith($profile + '\', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Use only the isolated disposable profile, not the regular Hermes installation or its parent.'
}
$profileEntry = Get-Item -LiteralPath $profile
if (-not $profileEntry.PSIsContainer -or ($profileEntry.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    throw 'The disposable profile must be an existing directory, not a junction or symlink.'
}
$hermesCli = Join-Path $profile 'bin\hermes.exe'
$cliEntry = Get-Item -LiteralPath $hermesCli
if ($cliEntry.PSIsContainer -or ($cliEntry.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) {
    throw 'The disposable profile must contain its own Hermes CLI file.'
}
$previousHome = $env:HERMES_HOME
try {
    $env:HERMES_HOME = $profile
    if ($Action -eq 'Setup') {
        Write-Host 'Complete model setup privately. Use your existing provider account with a separate Hermes login session.'
        Write-Host 'If offered to import Codex CLI credentials, decline; do not copy credentials or paste them into chat.'
        & $hermesCli setup model
    } else {
        Write-Host 'This operator-run model request uses the disposable profile configuration unless provider/model overrides were supplied, and may consume account usage.'
        $chatArguments = @('chat', '--oneshot', '--ignore-rules', '--toolsets', 'context_engine', '--max-turns', '3', '--run-budget', '120', '-q', 'Reply exactly READY. Do not call tools.')
        if ($Provider) {
            $chatArguments += @('--provider', $Provider)
        }
        if ($Model) {
            $chatArguments += @('--model', $Model)
        }
        & $hermesCli @chatArguments
    }
    if ($LASTEXITCODE -ne 0) {
        throw 'Hermes did not complete successfully. Keep diagnostic output private; report only the failure category.'
    }
} finally {
    $env:HERMES_HOME = $previousHome
}
