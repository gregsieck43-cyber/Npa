param([string]$PackageRoot)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# Offline known-good restore. Mutable data and recovery sources never become swap units.
if ([string]::IsNullOrWhiteSpace($PackageRoot)) {
    $PackageRoot = Split-Path -Path (Split-Path -Path $PSScriptRoot -Parent) -Parent
}
$PackageRoot = [System.IO.Path]::GetFullPath($PackageRoot)
$packagePrefix = $PackageRoot.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar

function Get-PayloadPath([string]$Root, [string]$Relative) {
    if ([string]::IsNullOrWhiteSpace($Relative) -or $Relative -match '[\\:]' -or $Relative.StartsWith('/') -or
        @($Relative.Split('/') | Where-Object { $_ -eq '' -or $_ -match '[<>"|?*\x00-\x1f]|[. ]$|^(con|nul|prn|aux|com[1-9]|lpt[1-9])(\.|$)' }).Count -gt 0) {
        throw 'Manifest contains an unsafe relative path.'
    }
    foreach ($part in $Relative.Split('/')) {
        if ($part -match '^(api\.txt|\.env(\..*)?|\.git|\.cache|\.tmp|\.tools|data|credentials(\..*)?|secrets(\..*)?)$' -or $part -match '\.(pem|key)$') {
            throw "Credentials, mutable data and build caches are forbidden in recovery payload: $Relative"
        }
    }
    if ($Relative -eq 'resources/recovery' -or $Relative.StartsWith('resources/recovery/', [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Recovery sources cannot be a restore target.' }
    $rootPrefix = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    $path = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($Root, $Relative.Replace('/', [System.IO.Path]::DirectorySeparatorChar)))
    if (-not $path.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Recovery path escaped its payload root.' }
    return $path
}
function Assert-NoLinks([string]$Root) {
    $items = @((Get-Item -LiteralPath $Root))
    if ($items[0].PSIsContainer) { $items += @(Get-ChildItem -LiteralPath $Root -Recurse -Force) }
    foreach ($item in $items) {
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Recovery does not follow links: $($item.FullName)" }
    }
}
function Get-PayloadHash([string]$Path) {
    $stream = [System.IO.File]::OpenRead($Path)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { return [System.BitConverter]::ToString($sha.ComputeHash($stream)).Replace('-', '').ToLowerInvariant() }
    finally { $sha.Dispose(); $stream.Dispose() }
}
function Assert-Payload([string]$Root, $Manifest) {
    Assert-NoLinks $Root
    $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($file in $Manifest.files) {
        $path = Get-PayloadPath $Root ([string]$file.path)
        if (-not $seen.Add([string]$file.path)) { throw "Duplicate manifest path: $($file.path)" }
        if ([string]$file.sha256 -notmatch '^[a-f0-9]{64}$' -or [long]$file.size -lt 0) { throw 'Manifest contains an invalid file identity.' }
        $item = Get-Item -LiteralPath $path
        if ($item.PSIsContainer -or $item.Length -ne [long]$file.size -or (Get-PayloadHash $path) -ne [string]$file.sha256) {
            throw "Recovery hash or size mismatch: $($file.path)"
        }
    }
    $prefix = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    foreach ($item in Get-ChildItem -LiteralPath $Root -Recurse -File -Force) {
        $relative = $item.FullName.Substring($prefix.Length).Replace('\', '/')
        if (-not $seen.Contains($relative)) { throw "Unexpected recovery file: $relative" }
    }
}

function Expand-RecoveryArchive([string]$ArchivePath, [string]$Root, $Manifest) {
    Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
    $expected = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::Ordinal)
    $names = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    [long]$total = 0
    if (@($Manifest.files).Count -gt 10000) { throw 'Recovery archive exceeds the 10000-file limit.' }
    foreach ($file in $Manifest.files) {
        Get-PayloadPath $Root ([string]$file.path) | Out-Null
        if (-not $names.Add([string]$file.path)) { throw 'Duplicate manifest path.' }
        if ([string]$file.sha256 -notmatch '^[a-f0-9]{64}$' -or [string]$file.size -notmatch '^\d+$' -or [decimal]$file.size -gt 8589934592) { throw 'Invalid archive file identity or size.' }
        $total += [long]$file.size
        if ($total -gt 8589934592) { throw 'Recovery archive exceeds the 8 GiB expanded limit.' }
        $expected.Add([string]$file.path, $file)
    }
    $inputFile = [System.IO.File]::OpenRead($ArchivePath)
    try {
        $zip = [System.IO.Compression.ZipArchive]::new($inputFile, [System.IO.Compression.ZipArchiveMode]::Read, $true)
        try {
            if ($zip.Entries.Count -ne $expected.Count) { throw 'Archive entries do not match the manifest.' }
            $seen = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
            # Check all names and advertised sizes before writing any entry. Directory/link entries are unsupported.
            foreach ($entry in $zip.Entries) {
                Get-PayloadPath $Root $entry.FullName | Out-Null
                if (-not $expected.ContainsKey($entry.FullName) -or -not $seen.Add($entry.FullName)) { throw 'Unexpected or duplicate archive entry.' }
                if ($entry.Length -ne [long]$expected[$entry.FullName].size) { throw 'Archive entry size differs from manifest.' }
                if ((($entry.ExternalAttributes -shr 16) -band 61440) -eq 40960 -or ($entry.ExternalAttributes -band 1024) -ne 0) { throw 'Archive links are forbidden.' }
            }
            $buffer = New-Object byte[] 65536
            foreach ($entry in $zip.Entries) {
                $destination = Get-PayloadPath $Root $entry.FullName
                New-Item -ItemType Directory -Path (Split-Path -Path $destination -Parent) -Force | Out-Null
                $inputStream = $entry.Open()
                try {
                    $outputStream = [System.IO.File]::Open($destination, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::Write, [System.IO.FileShare]::None)
                    try {
                        [long]$remaining = $expected[$entry.FullName].size
                        while ($remaining -gt 0) {
                            $read = $inputStream.Read($buffer, 0, [int][Math]::Min($buffer.Length, $remaining))
                            if ($read -eq 0) { throw 'Archive entry ended before its manifest size.' }
                            $outputStream.Write($buffer, 0, $read)
                            $remaining -= $read
                        }
                        if ($inputStream.ReadByte() -ne -1) { throw 'Archive entry expands beyond its manifest size.' }
                    } finally { $outputStream.Dispose() }
                } finally { $inputStream.Dispose() }
            }
        } finally { $zip.Dispose() }
    } finally { $inputFile.Dispose() }
}

$resources = Join-Path $PackageRoot 'resources'
$recovery = Join-Path $resources 'recovery'
$manifestPath = Join-Path $recovery 'manifest.json'
foreach ($path in @($resources, $recovery, $manifestPath)) {
    if (-not ([System.IO.Path]::GetFullPath($path).StartsWith($packagePrefix, [System.StringComparison]::OrdinalIgnoreCase))) { throw 'Recovery target escaped package root.' }
}
foreach ($item in @((Get-Item -LiteralPath $PackageRoot), (Get-Item -LiteralPath $resources), (Get-Item -LiteralPath $recovery), (Get-Item -LiteralPath $manifestPath))) {
    if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Package root and recovery resources cannot be links.' }
}
foreach ($process in @(Get-Process -Name 'NPN-Gamma', 'node', 'VSCodium' -ErrorAction SilentlyContinue)) {
    if ($process.Path -and [System.IO.Path]::GetFullPath($process.Path).StartsWith($packagePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Stop NPN-Gamma, its IDE and bundled backend/CLI before offline recovery.'
    }
}
$manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
if (@(1, 2) -notcontains $manifest.schemaVersion -or @('resources/app', 'package') -notcontains $manifest.target -or
    [string]::IsNullOrWhiteSpace([string]$manifest.releaseVersion) -or @($manifest.files).Count -eq 0) {
    throw 'Unsupported or empty recovery manifest.'
}
if ($manifest.target -eq 'package') {
    $source = Join-Path $recovery 'bundle'
    $units = @($manifest.units)
    if ($units.Count -eq 0) { throw 'Package recovery requires static swap units.' }
} else {
    $source = Join-Path $recovery 'app'
    $units = @('resources/app')
}
$unitSet = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($unit in $units) {
    Get-PayloadPath $PackageRoot ([string]$unit) | Out-Null
    if ($unit -eq 'resources' -or -not $unitSet.Add([string]$unit)) { throw 'Restore units overlap protected resources or duplicate a target.' }
    foreach ($other in $units) {
        if ($unit -ne $other -and ([string]$unit).StartsWith(([string]$other + '/'), [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Restore units overlap.' }
    }
}
if ($manifest.target -eq 'package') {
    if (@($manifest.files | Where-Object { $_.path -eq 'NPN-Gamma.exe' }).Count -ne 1 -or
        @($manifest.files | Where-Object { $_.path -eq 'resources/runtime/node.exe' }).Count -ne 1 -or
        @($manifest.files | Where-Object { $_.path -like 'resources/app/*' }).Count -eq 0) { throw 'Package recovery must include the executable, bundled runtime and application.' }
    foreach ($unit in $units) {
        if (@($manifest.files | Where-Object { $_.path -eq $unit -or ([string]$_.path).StartsWith(([string]$unit + '/'), [System.StringComparison]::OrdinalIgnoreCase) }).Count -eq 0) { throw 'Restore unit has no known-good source files.' }
    }
    foreach ($file in $manifest.files) {
        $matching = @($units | Where-Object { $file.path -eq $_ -or ([string]$file.path).StartsWith(([string]$_ + '/'), [System.StringComparison]::OrdinalIgnoreCase) })
        if ($matching.Count -ne 1) { throw 'Each manifest file must belong to exactly one static restore unit.' }
    }
}
$archive = $null
if ($manifest.schemaVersion -eq 2) {
    if ($manifest.PSObject.Properties.Name -notcontains 'archive' -or $manifest.archive.format -ne 'zip' -or $manifest.archive.path -cne 'bundle.zip' -or
        [string]$manifest.archive.sha256 -notmatch '^[a-f0-9]{64}$' -or [string]$manifest.archive.size -notmatch '^\d+$' -or
        [decimal]$manifest.archive.size -le 0 -or [decimal]$manifest.archive.size -gt 8589934592) { throw 'Unsupported recovery archive identity.' }
    $archive = Join-Path $recovery 'bundle.zip'
    Assert-NoLinks $archive
    $archiveFile = Get-Item -LiteralPath $archive
    if ($archiveFile.PSIsContainer -or $archiveFile.Length -ne [long]$manifest.archive.size -or (Get-PayloadHash $archive) -ne $manifest.archive.sha256) { throw 'Recovery archive hash or size mismatch.' }
} else {
    Assert-Payload $source $manifest
}
foreach ($unit in $units) {
    $current = Get-PayloadPath $PackageRoot ([string]$unit)
    if (Test-Path -LiteralPath $current) { Assert-NoLinks $current }
}

$stage = Join-Path $PackageRoot ('.recovery-stage-' + [guid]::NewGuid().ToString('N'))
$backupRoot = Join-Path $recovery 'backups'
if (Test-Path -LiteralPath $backupRoot) { Assert-NoLinks $backupRoot }
$backup = Join-Path $backupRoot ('release-' + (Get-Date -Format 'yyyyMMddTHHmmss') + '-' + [guid]::NewGuid().ToString('N'))
$swaps = [System.Collections.Generic.List[object]]::new()
try {
    New-Item -ItemType Directory -Path $stage | Out-Null
    $stagedPayload = if ($manifest.target -eq 'package') { $stage } else { Get-PayloadPath $stage 'resources/app' }
    New-Item -ItemType Directory -Path $stagedPayload -Force | Out-Null
    if ($archive) {
        Expand-RecoveryArchive $archive $stagedPayload $manifest
    } else {
        foreach ($file in $manifest.files) {
            $destination = Get-PayloadPath $stagedPayload ([string]$file.path)
            New-Item -ItemType Directory -Path (Split-Path -Path $destination -Parent) -Force | Out-Null
            Copy-Item -LiteralPath (Get-PayloadPath $source ([string]$file.path)) -Destination $destination
        }
    }
    Assert-Payload $stagedPayload $manifest
    foreach ($unit in $units) {
        $target = Get-PayloadPath $PackageRoot ([string]$unit)
        $old = Get-PayloadPath $backup ([string]$unit)
        $swap = [pscustomobject]@{ target = $target; backup = $old; originalMoved = $false; activated = $false }
        $swaps.Add($swap)
        New-Item -ItemType Directory -Path (Split-Path -Path $old -Parent) -Force | Out-Null
        if (Test-Path -LiteralPath $target) { Move-Item -LiteralPath $target -Destination $old; $swap.originalMoved = $true }
        New-Item -ItemType Directory -Path (Split-Path -Path $target -Parent) -Force | Out-Null
        Move-Item -LiteralPath (Get-PayloadPath $stage ([string]$unit)) -Destination $target
        $swap.activated = $true
    }
    Write-Output "Recovered known-good release $($manifest.releaseVersion), $($manifest.files.Count) files. Data retained. Previous payload: $backup"
} catch {
    $failure = $_
    for ($index = $swaps.Count - 1; $index -ge 0; $index--) {
        $swap = $swaps[$index]
        if ($swap.activated) {
            if (-not ([System.IO.Path]::GetFullPath($swap.target).StartsWith($packagePrefix, [System.StringComparison]::OrdinalIgnoreCase))) { throw 'Rollback cleanup target escaped package root.' }
            Remove-Item -LiteralPath $swap.target -Recurse -Force
        }
        if ($swap.originalMoved) { Move-Item -LiteralPath $swap.backup -Destination $swap.target }
    }
    throw $failure
} finally {
    if (Test-Path -LiteralPath $stage) {
        if (-not ([System.IO.Path]::GetFullPath($stage).StartsWith($packagePrefix, [System.StringComparison]::OrdinalIgnoreCase))) { throw 'Staging cleanup target escaped package root.' }
        Remove-Item -LiteralPath $stage -Recurse -Force
    }
}
