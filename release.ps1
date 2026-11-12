# Developer release: builds dist/ig-research-overlay.zip, tags vX.Y.Z, pushes, creates the GitHub release.
# Bump "version" in manifest.json and commit first. -DryRun only builds the zip and prints the steps.
param([switch]$DryRun, [string]$Notes)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
Set-Location $PSScriptRoot

function Invoke-Git { $o = & git.exe @args; if ($LASTEXITCODE) { throw "git $args failed" }; $o }

if (Invoke-Git status --porcelain) { throw 'Working tree is not clean. Commit or discard changes first.' }
$branch = Invoke-Git rev-parse --abbrev-ref HEAD
if ($branch -ne 'main' -and -not $DryRun) { throw "Release from main (you are on $branch)." }
$ver = (Get-Content -Raw manifest.json | ConvertFrom-Json).version
$tags = @(Invoke-Git tag --list 'v*' | Where-Object { $_ -match '^v\d+\.\d+\.\d+$' } | ForEach-Object { [version]($_ -replace '^v', '') } | Sort-Object)
if ($tags.Count -and [version]$ver -le $tags[-1]) { throw "manifest.json version $ver is not higher than the newest tag v$($tags[-1])." }
$tag = "v$ver"
if (-not $Notes) { $Notes = "IG Research Overlay $tag" }

# Only the runtime files. Entry names use forward slashes (Compress-Archive on 5.1 writes backslashes).
$files = @('manifest.json', 'inject.js', 'content.js', 'overlay.css', 'popup.html', 'popup.js', 'popup.css',
  'updater/host.ps1', 'updater/host.cmd', 'updater/extension-id.txt')
if (Test-Path icons) { $files += Get-ChildItem -File icons | ForEach-Object { "icons/$($_.Name)" } }
New-Item -ItemType Directory -Force dist | Out-Null
$zipPath = Join-Path $PSScriptRoot 'dist\ig-research-overlay.zip'
if (Test-Path $zipPath) { Remove-Item -Force $zipPath }
$zip = [IO.Compression.ZipFile]::Open($zipPath, 'Create')
try {
  foreach ($f in $files) {
    $e = $zip.CreateEntry($f)
    $e.LastWriteTime = [DateTimeOffset]::new(2000, 1, 1, 0, 0, 0, [TimeSpan]::Zero)  # fixed time: no builder clock or timezone in the zip
    $out = $e.Open()
    try { $in = [IO.File]::OpenRead((Join-Path $PSScriptRoot $f)); try { $in.CopyTo($out) } finally { $in.Dispose() } } finally { $out.Dispose() }
  }
} finally { $zip.Dispose() }
Write-Host "Built $zipPath ($($files.Count) files) for $tag"

$steps = @(
  @('git', 'tag', $tag),
  @('git', 'push', 'origin', 'main', '--tags'),
  @('gh', 'release', 'create', $tag, $zipPath, '--title', "IG Research Overlay $tag", '--notes', $Notes)
)
if (-not $DryRun) {
  & gh auth status *> $null
  if ($LASTEXITCODE) { throw 'gh is not signed in. Run: gh auth login' }
}
# If gh release create fails after the push, finish by hand: gh release create <tag> <zip> ...
foreach ($s in $steps) {
  if ($DryRun) { Write-Host "Would run: $($s -join ' ')"; continue }
  & $s[0] @($s | Select-Object -Skip 1)
  if ($LASTEXITCODE) { throw "$($s -join ' ') failed" }
}
if (-not $DryRun) { Write-Host "Released $tag." }
