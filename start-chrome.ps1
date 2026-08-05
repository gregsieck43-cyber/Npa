$ErrorActionPreference = "Stop"

$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$url = "http://127.0.0.1:3137"
$serverProcess = $null

function Resolve-Node {
  param([string]$Root)

  $bundled = Join-Path $Root "node.exe"
  if (Test-Path -LiteralPath $bundled) { return $bundled }

  $command = Get-Command node -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }

  throw "Node.js was not found. Use the packaged dist copy, or install Node.js."
}

function Resolve-Chrome {
  if ($env:CHROME_PATH -and (Test-Path -LiteralPath $env:CHROME_PATH)) {
    return $env:CHROME_PATH
  }

  $candidates = @(
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe",
    "$env:LocalAppData\Google\Chrome\Application\chrome.exe"
  )
  foreach ($candidate in $candidates) {
    if ($candidate -and (Test-Path -LiteralPath $candidate)) { return $candidate }
  }

  $command = Get-Command chrome -ErrorAction SilentlyContinue
  if ($command) { return $command.Source }

  throw "Google Chrome was not found. Install Chrome or set CHROME_PATH to chrome.exe."
}

function Test-Workbench {
  try {
    $health = Invoke-RestMethod -Uri "$url/api/health" -TimeoutSec 2
    return [bool]$health.ok
  }
  catch {
    return $false
  }
}

Push-Location $root
try {
  $chrome = Resolve-Chrome
  if (-not (Test-Workbench)) {
    $node = Resolve-Node -Root $root
    Write-Host "Starting NPA local workbench at $url"
    $serverProcess = Start-Process -FilePath $node -ArgumentList "server.js" -WorkingDirectory $root -PassThru -WindowStyle Hidden

    $deadline = (Get-Date).AddSeconds(20)
    while ((Get-Date) -lt $deadline) {
      if (Test-Workbench) { break }
      Start-Sleep -Milliseconds 500
    }
    if (-not (Test-Workbench)) {
      throw "Local service did not start at $url."
    }
  }
  else {
    Write-Host "NPA local workbench is already running at $url"
  }

  Start-Process -FilePath $chrome -ArgumentList "--new-window", $url
  Write-Host "Chrome opened: $url"
  Write-Host "Keep this PowerShell window open while using the app. Press Enter to stop the local service."
  [void][Console]::ReadLine()
}
finally {
  if ($serverProcess -and -not $serverProcess.HasExited) {
    Stop-Process -Id $serverProcess.Id -Force
    Write-Host "Local service stopped."
  }
  Pop-Location
}
