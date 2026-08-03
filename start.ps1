$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$bundledNode = Join-Path $root "node.exe"
$node = if (Test-Path -LiteralPath $bundledNode) { $bundledNode } else { (Get-Command node -ErrorAction Stop).Source }
if (Test-Path -LiteralPath $bundledNode) {
  $env:WORKBENCH_DATA_DIR = Join-Path $env:LOCALAPPDATA "ClaudeWorkbench\data"
}

Push-Location $root
try {
  $existing = Get-NetTCPConnection -LocalPort 3137 -State Listen -ErrorAction SilentlyContinue
  if ($existing) {
    Write-Host "Local Claude Workbench is already running at http://localhost:3137"
    return
  }

  if (!(Test-Path -LiteralPath (Join-Path $root "frontend\dist\index.html")) -and (Test-Path -LiteralPath (Join-Path $root "package.json"))) {
    $npm = (Get-Command npm.cmd -ErrorAction Stop).Source
    $env:TEMP = Join-Path $root ".tmp"
    $env:TMP = $env:TEMP
    $env:npm_config_cache = Join-Path $root ".cache"
    & $npm run build
    if ($LASTEXITCODE -ne 0) { throw "Frontend build failed." }
  }

  Write-Host "Local Claude Workbench starting at http://localhost:3137"
  Write-Host "Keep this PowerShell window open while using the app."
  & $node server.js
}
finally {
  Pop-Location
}
