[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
$root = Split-Path $PSScriptRoot -Parent
Push-Location -LiteralPath $root
try {
    $node = (Get-Command node.exe -CommandType Application | Select-Object -First 1).Source
    if ((& $node -p 'process.platform + "/" + process.arch + "/" + process.version') -ne 'win32/x64/v24.16.0') {
        throw 'Install Windows x64 Node.js 24.16.0 with npm, then run setup again.'
    }
    if (!(Test-Path -LiteralPath "$env:SystemRoot\Microsoft.NET\Framework64\v4.0.30319\csc.exe")) {
        throw 'The Windows .NET Framework 4.x x64 C# compiler is required.'
    }
    $expected = 'b3094d0b49f9ad602262a9921551737bb97637c05dd357a06ae98188d7290aa3'
    if ((Get-FileHash -LiteralPath $node).Hash -ne $expected) {
        throw 'The Node executable differs from the official Windows x64 v24.16.0 runtime.'
    }
    $env:TEMP = Join-Path $root '.tmp'
    $env:TMP = $env:TEMP
    $env:npm_config_cache = Join-Path $root '.cache\npm'
    $env:electron_config_cache = Join-Path $root '.cache\electron'
    $directory = Join-Path $root '.deps\runtime'
    foreach ($path in @($env:TEMP, $env:npm_config_cache, $env:electron_config_cache, $directory)) {
        [IO.Directory]::CreateDirectory($path) | Out-Null
    }
    $runtime = Join-Path $directory 'node.exe'
    if (!(Test-Path -LiteralPath $runtime)) { [IO.File]::Copy($node, $runtime) }
    if ((Get-FileHash -LiteralPath $runtime).Hash -ne $expected) { throw 'Unexpected project Node runtime.' }
    & npm.cmd ci --no-audit --no-fund
    if ($LASTEXITCODE) { throw 'npm ci failed.' }
    & $runtime node_modules/electron/install.js
    if ($LASTEXITCODE) { throw 'Electron installation failed.' }
    & $runtime scripts/build.mjs
    if ($LASTEXITCODE) { throw 'Build failed.' }
} finally { Pop-Location }
