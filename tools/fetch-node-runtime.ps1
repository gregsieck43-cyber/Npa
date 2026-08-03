param(
  [ValidatePattern('^\d+\.\d+\.\d+$')]
  [string]$Version = "24.18.0",
  [ValidateSet("win-x64")]
  [string]$Architecture = "win-x64",
  [switch]$DryRun,
  [switch]$Force
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$tools = Join-Path $root ".tools"
$cache = Join-Path $tools "node-runtime-cache"
$tmp = Join-Path $tools ".tmp-node-runtime"
$archiveName = "node-v$Version-$Architecture.zip"
$archiveUrl = "https://nodejs.org/dist/v$Version/$archiveName"
$sumsUrl = "https://nodejs.org/dist/v$Version/SHASUMS256.txt"
$targetDir = Join-Path $tools "node-v$Version-$Architecture"
$targetNode = Join-Path $targetDir "node.exe"
$archivePath = Join-Path $cache $archiveName
$sumsPath = Join-Path $cache "SHASUMS256-v$Version.txt"

function Assert-UnderRoot([string]$path) {
  $full = [IO.Path]::GetFullPath($path)
  $rootFull = [IO.Path]::GetFullPath($root).TrimEnd('\') + '\'
  if (!$full.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to operate outside project root: $full"
  }
}

Assert-UnderRoot $tools
Assert-UnderRoot $cache
Assert-UnderRoot $tmp
Assert-UnderRoot $targetDir

if ($DryRun) {
  Write-Output "NODE_RUNTIME_DRY_RUN_OK"
  Write-Output ("version=" + $Version)
  Write-Output ("architecture=" + $Architecture)
  Write-Output ("archive=" + $archiveUrl)
  Write-Output ("shasums=" + $sumsUrl)
  Write-Output ("target=" + $targetDir)
  exit 0
}

# Redirect all temporary/cache writes into the project. This keeps an offline
# or CI invocation from polluting the user's profile or system temp directory.
New-Item -ItemType Directory -Force -Path $tools, $cache, $tmp | Out-Null
$env:TEMP = $tmp
$env:TMP = $tmp
$env:npm_config_cache = $cache
$env:NODE_RUNTIME_CACHE = $cache

if (!$Force -and (Test-Path $targetNode -PathType Leaf)) {
  Write-Output "NODE_RUNTIME_ALREADY_PRESENT"
  Write-Output $targetNode
  exit 0
}

try {
  if ($Force -or !(Test-Path $archivePath -PathType Leaf)) {
    Invoke-WebRequest -UseBasicParsing -Uri $archiveUrl -OutFile $archivePath
  }
  if ($Force -or !(Test-Path $sumsPath -PathType Leaf)) {
    Invoke-WebRequest -UseBasicParsing -Uri $sumsUrl -OutFile $sumsPath
  }

  $sumLine = Get-Content -LiteralPath $sumsPath | Where-Object {
    $_ -match ("\s" + [regex]::Escape($archiveName) + "$")
  } | Select-Object -First 1
  if (!$sumLine) { throw "SHASUMS256.txt does not contain $archiveName" }
  $expected = (($sumLine -split "\s+") | Where-Object { $_ })[0].ToLowerInvariant()
  $actual = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($expected -ne $actual) {
    throw "SHA-256 mismatch for $archiveName (expected $expected, got $actual)"
  }

  $extractDir = Join-Path $tmp "extract"
  if (Test-Path $extractDir) { Remove-Item -LiteralPath $extractDir -Recurse -Force }
  New-Item -ItemType Directory -Force -Path $extractDir | Out-Null
  Expand-Archive -LiteralPath $archivePath -DestinationPath $extractDir -Force
  $extractedRoot = Join-Path $extractDir "node-v$Version-$Architecture"
  if (!(Test-Path (Join-Path $extractedRoot "node.exe") -PathType Leaf)) {
    throw "Node archive did not contain the expected win-x64 node.exe"
  }
  if (Test-Path $targetDir) { Remove-Item -LiteralPath $targetDir -Recurse -Force }
  Move-Item -LiteralPath $extractedRoot -Destination $targetDir
  Copy-Item -LiteralPath $sumsPath -Destination (Join-Path $targetDir "SHASUMS256.txt") -Force
  Write-Output "NODE_RUNTIME_OK"
  Write-Output $targetNode
}
finally {
  if (Test-Path $tmp) { Remove-Item -LiteralPath $tmp -Recurse -Force }
}
