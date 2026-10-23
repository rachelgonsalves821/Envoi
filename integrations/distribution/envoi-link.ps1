$ErrorActionPreference = 'Stop'
$process = $null
try {
    $nodeCommand = Get-Command node -CommandType Application -ErrorAction Stop | Select-Object -First 1
    if ((Get-Location).Provider.Name -ne 'FileSystem') { throw 'Use a filesystem working directory.' }
    $launcherPath = Join-Path $PSScriptRoot 'launch.mjs'
    $quotedArguments = foreach ($argument in (@($launcherPath) + @($args))) {
        $escaped = [regex]::Replace([string]$argument, '(\\*)"', '$1$1\"')
        $escaped = [regex]::Replace($escaped, '(\\+)$', '$1$1')
        '"' + $escaped + '"'
    }
    $start = New-Object System.Diagnostics.ProcessStartInfo
    $start.FileName = $nodeCommand.Source
    $start.Arguments = $quotedArguments -join ' '
    $start.UseShellExecute = $false
    $start.WorkingDirectory = (Get-Location).ProviderPath
    $process = [System.Diagnostics.Process]::Start($start)
    $process.WaitForExit()
    exit $process.ExitCode
} catch {
    [Console]::Error.WriteLine('Local Envoi launch failed. Use an existing Node.js 22+ and a complete trusted private installation.')
    exit 1
} finally {
    if ($null -ne $process) { $process.Dispose() }
}
