$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$runtimePath = Join-Path $repoRoot ".local/curve-test/runtime.json"
if (-not (Test-Path -LiteralPath $runtimePath)) { Write-Host "No curve test stack recorded."; exit 0 }
$runtime = Get-Content -LiteralPath $runtimePath -Raw | ConvertFrom-Json
$owner = Get-CimInstance Win32_Process -Filter "ProcessId = $($runtime.pid)"
if (-not $owner -or $owner.CommandLine -notmatch 'scripts[\\/]curve-stack\.mjs') { throw "Recorded launcher is no longer running; no processes were stopped." }
foreach ($childId in $runtime.children) {
    $childProcess = Get-CimInstance Win32_Process -Filter "ProcessId = $childId"
    if ($childProcess -and $childProcess.ParentProcessId -eq $runtime.pid) { & taskkill.exe /PID $childId /T /F | Out-Null }
}
Stop-Process -Id $runtime.pid
Write-Host "Stopped the isolated curve stack. Reports and test vault remain on disk."
