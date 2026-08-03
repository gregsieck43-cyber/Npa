$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $PSScriptRoot
$bundledNode = Join-Path $root ".tools\node-v24.18.0-win-x64\node.exe"
$node = if (Test-Path -LiteralPath $bundledNode) { $bundledNode } else { (Get-Command node -ErrorAction Stop).Source }
$port = 41000 + (Get-Random -Minimum 0 -Maximum 2000)
$tempRoot = Join-Path $root ".tmp\api-smoke"
$cacheRoot = Join-Path $root ".cache\api-smoke"
$dataDir = Join-Path $tempRoot ("workbench-api-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $dataDir, $cacheRoot | Out-Null
$env:TEMP = $tempRoot
$env:TMP = $tempRoot
$env:npm_config_cache = $cacheRoot
$env:PORT = [string]$port
$env:WORKBENCH_DATA_DIR = $dataDir
$env:WORKBENCH_EXTERNAL_API_URL = "http://127.0.0.1:$port"
$env:WORKBENCH_SKIP_COMMAND_SMOKE = "1"

$process = Start-Process -FilePath $node -ArgumentList "server.js" -WorkingDirectory $root -PassThru -WindowStyle Hidden
try {
  $deadline = (Get-Date).AddSeconds(20)
  do {
    try {
      $response = Invoke-WebRequest -UseBasicParsing -Uri "$env:WORKBENCH_EXTERNAL_API_URL/api/health" -TimeoutSec 2
      if ($response.StatusCode -eq 200) { break }
    } catch {
      Start-Sleep -Milliseconds 250
    }
  } while ((Get-Date) -lt $deadline)

  if ((Get-Date) -ge $deadline) {
    throw "Workbench API did not become healthy on port $port"
  }

  & $node test/api-smoke.test.mjs
  if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
  }
} finally {
  Remove-Item Env:\WORKBENCH_EXTERNAL_API_URL -ErrorAction SilentlyContinue
  Remove-Item Env:\WORKBENCH_SKIP_COMMAND_SMOKE -ErrorAction SilentlyContinue
  if ($process -and -not $process.HasExited) {
    Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
    Wait-Process -Id $process.Id -Timeout 5 -ErrorAction SilentlyContinue
  }
  if (Test-Path $dataDir) { Remove-Item -LiteralPath $dataDir -Recurse -Force -ErrorAction SilentlyContinue }
  if (Test-Path $tempRoot) { Remove-Item -LiteralPath $tempRoot -Recurse -Force -ErrorAction SilentlyContinue }
  if (Test-Path $cacheRoot) { Remove-Item -LiteralPath $cacheRoot -Recurse -Force -ErrorAction SilentlyContinue }
}
