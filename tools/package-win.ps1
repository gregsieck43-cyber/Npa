param(
  [string]$Configuration = "Release",
  [switch]$SkipFrontendBuild,
  [switch]$FetchNodeRuntime,
  [switch]$DryRun
)

$ErrorActionPreference = "Stop"
$root = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$dist = Join-Path $root "dist"
$appDir = Join-Path $dist "ClaudeWorkbench"
$tempAppDir = Join-Path $dist "ClaudeWorkbench.new"
$publishDir = Join-Path $dist "launcher-publish"
$launcherProject = Join-Path $root "launcher\ClaudeWorkbenchLauncher.csproj"
$frontendDist = Join-Path $root "frontend\dist"
$runtimeDir = Join-Path $root ".tools\node-v24.18.0-win-x64"
$runtimeNode = Join-Path $runtimeDir "node.exe"
$existingExe = Join-Path $dist "ClaudeWorkbench.exe"
$packageTmp = Join-Path $root ".tmp\package-win"
$packageCache = Join-Path $root ".cache\package-win"

function Assert-UnderRoot([string]$path) {
  $full = [IO.Path]::GetFullPath($path)
  $rootFull = [IO.Path]::GetFullPath($root).TrimEnd('\') + '\'
  if (!$full.StartsWith($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to operate outside project root: $full"
  }
}

function Remove-DirectoryWithRetry([string]$path) {
  if (!(Test-Path $path)) { return }
  for ($attempt = 0; $attempt -lt 20; $attempt++) {
    try {
      Remove-Item -LiteralPath $path -Recurse -Force -ErrorAction Stop
      return
    }
    catch {
      if ($attempt -eq 19) { throw }
      Start-Sleep -Milliseconds 250
    }
  }
}

function Invoke-FrontendBuild {
  if ($SkipFrontendBuild) { return }
  $packageJson = Join-Path $root "package.json"
  $viteConfig = Get-ChildItem -LiteralPath $root -Filter "vite.config.*" -File -ErrorAction SilentlyContinue | Select-Object -First 1
  if (!(Test-Path $packageJson) -or !$viteConfig) {
    Write-Warning "No Vite frontend detected; skipping frontend build."
    return
  }
  Push-Location $root
  try {
    npm run build
    if ($LASTEXITCODE -ne 0) { throw "Frontend build failed (exit $LASTEXITCODE)." }
  }
  finally {
    Pop-Location
  }
  if (!(Test-Path $frontendDist)) {
    throw "Frontend build completed without producing frontend\dist."
  }
}

function Resolve-NodeRuntime {
  if ($FetchNodeRuntime) {
    & (Join-Path $root "tools\fetch-node-runtime.ps1")
    if ($LASTEXITCODE -ne 0) { throw "Node runtime fetch failed (exit $LASTEXITCODE)." }
  }
  $candidates = @(
    $runtimeNode,
    (Join-Path $root ".tools\node.exe")
  )
  foreach ($candidate in $candidates) {
    if (Test-Path $candidate -PathType Leaf) { return (Resolve-Path $candidate).Path }
  }
  throw "Bundled Node runtime not found. Run tools\fetch-node-runtime.ps1 first (or pass -FetchNodeRuntime)."
}

if ($DryRun) {
  Write-Output "PACKAGE_WIN_DRY_RUN_OK"
  Write-Output ("root=" + $root)
  Write-Output ("launcher=" + $launcherProject)
  Write-Output ("runtime=" + $runtimeNode)
  Write-Output ("frontend=" + $frontendDist)
  exit 0
}

Assert-UnderRoot $dist
New-Item -ItemType Directory -Force -Path $dist | Out-Null
New-Item -ItemType Directory -Force -Path $packageTmp, $packageCache | Out-Null
$env:TEMP = $packageTmp
$env:TMP = $packageTmp
$env:npm_config_cache = $packageCache
$env:XDG_CACHE_HOME = $packageCache
$env:NUGET_PACKAGES = Join-Path $packageCache "nuget"
$env:DOTNET_CLI_USE_MSBUILD_SERVER = "0"
if (Test-Path $tempAppDir) { Remove-DirectoryWithRetry $tempAppDir }
if (Test-Path $publishDir) { Remove-DirectoryWithRetry $publishDir }
New-Item -ItemType Directory -Force -Path $tempAppDir | Out-Null

Invoke-FrontendBuild
$nodeSource = Resolve-NodeRuntime

# Keep build products and credentials out of the staged app. Runtime caches
# are deliberately excluded; only the verified node.exe is copied below.
$excludeDirs = @(
  ".agents",
  ".claude",
  ".codex",
  ".public-mirror",
  ".worktrees",
  ".vscode",
  ".idea",
  "data",
  "dist",
  ".cache",
  ".tmp",
  ".tools",
  ".packages",
  ".playwright-cli",
  "logs",
  "output",
  "test",
  "test-results",
  "node_modules",
  "coverage",
  ".git",
  "docs",
  "launcher",
  "assets",
  "src",
  "frontend"
)
$excludeFiles = @(
  ".gitignore",
  "AGENTS.md",
  "CLAUDE.md",
  "CLAUDE.local.md",
  "security-report.json",
  "package-lock.json",
  "tsconfig.tsbuildinfo",
  "tsconfig.node.tsbuildinfo",
  "vite.config.js",
  "vite.config.d.ts",
  "vite.config.ts",
  "tsconfig.json",
  "tsconfig.node.json",
  ".npmrc",
  ".env",
  ".env.local",
  ".env.production",
  ".env.development"
)

Get-ChildItem -LiteralPath $root -Force | ForEach-Object {
  if ($excludeDirs -contains $_.Name) { return }
  if ($excludeFiles -contains $_.Name) { return }
  if ($_.Extension -ieq ".md") { return }
  if ($_.Name -like "*.log" -or $_.Name -like "*.tsbuildinfo" -or $_.Name -like "*.key" -or $_.Name -like "*.pem") { return }
  $target = Join-Path $tempAppDir $_.Name
  if ($_.PSIsContainer) {
    Copy-Item -LiteralPath $_.FullName -Destination $target -Recurse -Force
  } else {
    Copy-Item -LiteralPath $_.FullName -Destination $target -Force
  }
}

# The package serves the Vite output at runtime when present. Keep source
# frontend files out of the release while retaining the generated assets.
$packagedFrontend = Join-Path $tempAppDir "frontend\dist"
if (Test-Path $frontendDist) {
  New-Item -ItemType Directory -Force -Path (Split-Path $packagedFrontend) | Out-Null
  Copy-Item -LiteralPath $frontendDist -Destination $packagedFrontend -Recurse -Force
}
Copy-Item -LiteralPath $nodeSource -Destination (Join-Path $tempAppDir "node.exe") -Force
$nodeLicense = Join-Path (Split-Path $nodeSource -Parent) "LICENSE"
if (!(Test-Path $nodeLicense -PathType Leaf)) { throw "Bundled Node runtime is missing LICENSE" }
Copy-Item -LiteralPath $nodeLicense -Destination (Join-Path $tempAppDir "node-LICENSE.txt") -Force

$sdkList = (& dotnet --list-sdks 2>$null)
if ($LASTEXITCODE -eq 0 -and $sdkList) {
  dotnet publish $launcherProject -c $Configuration -r win-x64 --self-contained true --disable-build-servers -o $publishDir `
    -p:PublishSingleFile=true `
    -p:IncludeNativeLibrariesForSelfExtract=true `
    -p:IncludeAllContentForSelfExtract=true `
    -p:PublishTrimmed=false `
    -p:UseSharedCompilation=false `
    -p:BuildInParallel=false
  if ($LASTEXITCODE -ne 0) { throw "Launcher publish failed (exit $LASTEXITCODE)." }
  $exe = Join-Path $publishDir "ClaudeWorkbench.exe"
  if (!(Test-Path $exe)) {
    throw "Launcher publish did not produce ClaudeWorkbench.exe"
  }
  # A self-contained single-file launcher supersedes any framework-dependent
  # DLL/runtimeconfig files left by older package runs.
  Get-ChildItem -LiteralPath $dist -File -ErrorAction SilentlyContinue | Remove-Item -Force
  Copy-Item -LiteralPath $exe -Destination $existingExe -Force
} elseif (Test-Path $existingExe) {
  Write-Warning "No .NET SDK found; reusing existing launcher at $existingExe and refreshing packaged app files."
} else {
  throw "No .NET SDK found and no existing dist\ClaudeWorkbench.exe is available."
}

if (Test-Path $appDir) { Remove-DirectoryWithRetry $appDir }
Move-Item -LiteralPath $tempAppDir -Destination $appDir
if (Test-Path $publishDir) { Remove-DirectoryWithRetry $publishDir }

$zip = Join-Path $dist "ClaudeWorkbench.zip"
if (Test-Path $zip) { Remove-Item -LiteralPath $zip -Force }
$launcherFiles = Get-ChildItem -LiteralPath $dist -File | Where-Object { $_.Name -eq "ClaudeWorkbench.exe" }
$zipPaths = @($appDir) + @($launcherFiles.FullName)
Compress-Archive -Path $zipPaths -DestinationPath $zip -Force

$releaseGate = Join-Path $root "tools\release-gate.js"
if (Test-Path $releaseGate) {
  & $nodeSource $releaseGate
  if ($LASTEXITCODE -ne 0) { throw "Release gate failed (exit $LASTEXITCODE)." }
}

Write-Output "PACKAGE_WIN_OK"
Write-Output $existingExe
Write-Output $zip

Remove-DirectoryWithRetry $packageTmp
Remove-DirectoryWithRetry $packageCache
