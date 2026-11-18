param([Parameter(Mandatory = $true)][string]$PackageRoot)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem

$PackageRoot = [System.IO.Path]::GetFullPath($PackageRoot)
$prefix = $PackageRoot.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
$recovery = Join-Path $PackageRoot 'resources/recovery'
$manifest = Get-Content -LiteralPath (Join-Path $recovery 'manifest.json') -Raw -Encoding UTF8 | ConvertFrom-Json
if ($manifest.schemaVersion -ne 1 -or $manifest.target -ne 'package' -or @($manifest.files).Count -eq 0) { throw 'Expected a complete static package manifest.' }
$archivePath = Join-Path $recovery 'bundle.zip'
$entries = [System.Collections.Generic.Dictionary[string, object]]::new([System.StringComparer]::OrdinalIgnoreCase)
foreach ($file in $manifest.files) {
    $name = [string]$file.path
    if ($name -match '[\\:]' -or $name.StartsWith('/') -or @($name.Split('/') | Where-Object { $_ -eq '' -or $_ -match '[. ]$|[<>"|?*\x00-\x1f]' }).Count -gt 0 -or
        $name -match '^(data/|resources/recovery/)') { throw 'Unsafe archive entry path.' }
    if ($entries.ContainsKey($name)) { throw 'Duplicate archive entry.' }
    $entries.Add($name, $file)
    $source = [System.IO.Path]::GetFullPath((Join-Path $PackageRoot $name))
    if (-not $source.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Source escaped package root.' }
    $cursor = $source
    while ($cursor -ne $PackageRoot) {
        if (((Get-Item -LiteralPath $cursor).Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Archive does not follow links.' }
        $cursor = Split-Path -Path $cursor -Parent
    }
}
if (((Get-Item -LiteralPath $PackageRoot).Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Package root cannot be a link.' }
foreach ($directory in @((Join-Path $PackageRoot 'resources'), $recovery)) {
    if (((Get-Item -LiteralPath $directory).Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Archive output cannot follow links.' }
}

# Stream directly from the static payload; there is no second expanded copy while packaging.
$stream = [System.IO.File]::Open($archivePath, [System.IO.FileMode]::CreateNew, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)
try {
    $zip = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Create, $true)
    try {
        foreach ($file in $manifest.files) {
            [System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($zip, (Join-Path $PackageRoot $file.path), [string]$file.path, [System.IO.Compression.CompressionLevel]::Optimal) | Out-Null
        }
    } finally { $zip.Dispose() }
    $stream.Position = 0
    $zip = [System.IO.Compression.ZipArchive]::new($stream, [System.IO.Compression.ZipArchiveMode]::Read, $true)
    try {
        foreach ($entry in $zip.Entries) {
            $expected = $entries[$entry.FullName]
            if ($entry.Length -ne [long]$expected.size) { throw "Compressed payload size mismatch: $($entry.FullName)" }
            $inputStream = $entry.Open()
            $sha = [System.Security.Cryptography.SHA256]::Create()
            try { $actual = [System.BitConverter]::ToString($sha.ComputeHash($inputStream)).Replace('-', '').ToLowerInvariant() }
            finally { $sha.Dispose(); $inputStream.Dispose() }
            if ($actual -ne [string]$expected.sha256) { throw "Compressed payload hash mismatch: $($entry.FullName)" }
        }
    } finally { $zip.Dispose() }
} finally { $stream.Dispose() }
Write-Output "Validated compressed recovery: $($manifest.files.Count) files, $((Get-Item -LiteralPath $archivePath).Length) bytes."
