$ErrorActionPreference = 'Stop'
$nodeCommand = Get-Command node -CommandType Application -ErrorAction Stop
& $nodeCommand.Source (Join-Path $PSScriptRoot 'install.mjs') @args
exit $LASTEXITCODE
