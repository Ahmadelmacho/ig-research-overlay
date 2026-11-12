# Self-test for the updater (host.ps1 + get.ps1). No network: the fake release lives in a temp
# folder and is served through file:// URLs (IGRO_API_BASE). Run with Windows PowerShell 5.1:
#   powershell -NoProfile -ExecutionPolicy Bypass -File updater\test.ps1
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$Root = Split-Path -Parent $PSScriptRoot
$Runtime = @('manifest.json', 'inject.js', 'content.js', 'overlay.css', 'popup.html', 'popup.js', 'popup.css',
  'updater/host.ps1', 'updater/host.cmd', 'updater/extension-id.txt')
$T = Join-Path ([IO.Path]::GetTempPath()) ('igro-test-' + [guid]::NewGuid())
$Api = Join-Path $T 'api'
$LatestFile = Join-Path $Api 'repos\Ahmadelmacho\ig-research-overlay\releases\latest'
$TestHost = 'com.igro.updater.selftest'
$TestReg = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$TestHost"
$env:IGRO_API_BASE = ([Uri]$Api).AbsoluteUri
$script:fail = 0

function Check($name, $cond) { if (-not $cond -and $r) { Write-Host ($r | ConvertTo-Json -Compress) }
  if ($cond) { Write-Host "PASS  $name" } else { Write-Host "FAIL  $name" -ForegroundColor Red; $script:fail++ }
}
function Get-Sha($p) { $s = [IO.File]::OpenRead($p); try { [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($s)).Replace('-', '') } finally { $s.Dispose() } }
function Read-Manifest($dir) { Get-Content -Raw (Join-Path $dir 'manifest.json') | ConvertFrom-Json }
function Snapshot($dir) {
  (Get-ChildItem -Recurse -File $dir | Sort-Object FullName | ForEach-Object { $_.FullName + (Get-Sha $_.FullName) }) -join "`n"
}
function New-Install($name) {
  $d = Join-Path $T $name
  foreach ($f in $Runtime) {
    $dst = Join-Path $d $f
    New-Item -ItemType Directory -Force (Split-Path -Parent $dst) | Out-Null
    Copy-Item (Join-Path $Root $f) $dst
  }
  Set-Content (Join-Path $d 'user-notes.txt') 'not part of the extension'
  $d
}
# Write a fake "latest release" with a zip built from the repo files.
function Set-Release($version, [string]$key, [switch]$BadDigest, [string]$Marker) {
  $stage = Join-Path $T ('stage-' + [guid]::NewGuid())
  New-Item -ItemType Directory -Force $stage, (Split-Path -Parent $LatestFile) | Out-Null
  $m = Read-Manifest $Root
  $m.version = $version
  if ($key) { $m.key = $key }
  $zipPath = Join-Path $Api ('rel-' + [guid]::NewGuid() + '.zip')
  $z = [IO.Compression.ZipFile]::Open($zipPath, 'Create')
  try {
    foreach ($f in $Runtime) {
      $src = Join-Path $Root $f
      if ($f -eq 'manifest.json') { $src = Join-Path $stage 'manifest.json'; [IO.File]::WriteAllText($src, ($m | ConvertTo-Json -Depth 10)) }
      if ($f -eq 'content.js' -and $Marker) { $src = Join-Path $stage 'content.js'; [IO.File]::WriteAllText($src, "// $Marker`n" + [IO.File]::ReadAllText((Join-Path $Root $f))) }
      [IO.Compression.ZipFileExtensions]::CreateEntryFromFile($z, $src, $f) | Out-Null
    }
  } finally { $z.Dispose() }
  $hash = (Get-Sha $zipPath).ToLower()
  if ($BadDigest) { $hash = '0' * 64 }
  $rel = @{ tag_name = "v$version"; body = 'test notes'
    assets = @(@{ name = 'ig-research-overlay.zip'; digest = "sha256:$hash"; browser_download_url = ([Uri]$zipPath).AbsoluteUri }) }
  [IO.File]::WriteAllText($LatestFile, ($rel | ConvertTo-Json -Depth 5))
}
# Spawn host.cmd like Chrome does, send one framed message, read the framed reply.
function Invoke-Host($dir, $msg) {
  $psi = New-Object Diagnostics.ProcessStartInfo 'cmd.exe', ('/c "' + (Join-Path $dir 'updater\host.cmd') + '" chrome-extension://test/')
  $psi.UseShellExecute = $false; $psi.RedirectStandardInput = $true; $psi.RedirectStandardOutput = $true; $psi.RedirectStandardError = $true
  $p = [Diagnostics.Process]::Start($psi)
  $errTask = $p.StandardError.ReadToEndAsync()
  $body = [Text.Encoding]::UTF8.GetBytes(($msg | ConvertTo-Json -Compress))
  $in = $p.StandardInput.BaseStream
  $in.Write([BitConverter]::GetBytes([int]$body.Length), 0, 4); $in.Write($body, 0, $body.Length); $in.Flush()
  $p.StandardInput.Close()
  $ms = New-Object IO.MemoryStream
  $p.StandardOutput.BaseStream.CopyTo($ms)
  $p.WaitForExit()
  $raw = $ms.ToArray()
  if ($raw.Length -lt 4) { throw "host gave no reply. stderr: $($errTask.Result)" }
  $len = [BitConverter]::ToInt32($raw, 0)
  $script:lastExtraBytes = $raw.Length - 4 - $len
  [Text.Encoding]::UTF8.GetString($raw, 4, $len) | ConvertFrom-Json
}
function Get-ExtensionId($key) {
  $h = [Security.Cryptography.SHA256]::Create().ComputeHash([Convert]::FromBase64String($key))
  -join ($h[0..15] | ForEach-Object { [char](97 + ($_ -shr 4)); [char](97 + ($_ -band 15)) })
}

New-Item -ItemType Directory -Force $T | Out-Null
try {
  $cur = (Read-Manifest $Root).version
  $key = (Read-Manifest $Root).key
  Check 'extension-id.txt matches the manifest key' ((Get-Content (Join-Path $Root 'updater\extension-id.txt')).Trim() -eq (Get-ExtensionId $key))

  $inst = New-Install 'inst'
  Set-Release '99.0.0'
  $r = Invoke-Host $inst @{ cmd = 'check' }
  Check 'framing round-trip: one framed reply, nothing else on stdout' ($script:lastExtraBytes -eq 0 -and $r.current -eq $cur)
  Check 'check: update available' ($r.updateAvailable -eq $true -and $r.latest -eq '99.0.0' -and $r.notes -eq 'test notes')

  Set-Release $cur
  $r = Invoke-Host $inst @{ cmd = 'check' }
  Check 'check: up to date' ($r.updateAvailable -eq $false -and $r.latest -eq $cur)

  Set-Release '99.0.0' -BadDigest
  $before = Snapshot $inst
  $r = Invoke-Host $inst @{ cmd = 'update' }
  Check 'update: bad digest refused, nothing changed' ($r.ok -eq $false -and $r.error -match 'digest' -and (Snapshot $inst) -eq $before)

  $otherKey = [Convert]::ToBase64String((1..294 | ForEach-Object { [byte]($_ % 256) }))
  Set-Release '99.0.0' -key $otherKey
  $r = Invoke-Host $inst @{ cmd = 'update' }
  Check 'update: different key refused, nothing changed' ($r.ok -eq $false -and $r.error -match 'key' -and (Snapshot $inst) -eq $before)

  Set-Release $cur
  $r = Invoke-Host $inst @{ cmd = 'update' }
  Check 'update: same version refused, nothing changed' ($r.ok -eq $false -and $r.error -match 'not newer' -and (Snapshot $inst) -eq $before)

  $dev = New-Install 'dev'
  New-Item -ItemType Directory (Join-Path $dev '.git') | Out-Null
  Set-Release '99.0.0' -Marker 'v99'
  $devBefore = Snapshot $dev
  $r = Invoke-Host $dev @{ cmd = 'check' }
  Check 'dev copy: check still works and says devCopy' ($r.devCopy -eq $true -and $r.updateAvailable -eq $true)
  $r = Invoke-Host $dev @{ cmd = 'update' }
  Check 'dev copy: update refused, nothing changed' ($r.ok -eq $false -and $r.devCopy -eq $true -and (Snapshot $dev) -eq $devBefore)

  # A file that cannot be replaced (held open) part-way through: everything rolls back.
  $lock = [IO.File]::Open((Join-Path $inst 'manifest.json'), 'Open', 'Read', 'Read')
  try { $r = Invoke-Host $inst @{ cmd = 'update' } } finally { $lock.Dispose() }
  Check 'update: failure mid-copy rolls back, nothing changed' ($r.ok -eq $false -and $r.error -match 'rolled back' -and (Snapshot $inst) -eq $before)

  $r = Invoke-Host $inst @{ cmd = 'update' }
  Check 'update: replaces files and the version changes' ($r.ok -eq $true -and $r.version -eq '99.0.0' -and
    (Read-Manifest $inst).version -eq '99.0.0' -and (Get-Content (Join-Path $inst 'content.js') -TotalCount 1) -eq '// v99')
  Check 'update: keeps files that are not part of the extension' (Test-Path (Join-Path $inst 'user-notes.txt'))
  Check 'update: no temp files left behind' (-not (Get-ChildItem -Recurse -File $inst -Filter '*.igro-new'))
  $r = Invoke-Host $inst @{ cmd = 'check' }
  Check 'update: check afterwards says up to date' ($r.current -eq '99.0.0' -and $r.updateAvailable -eq $false)

  # get.ps1: fresh install, re-run updates in place, -Uninstall removes it all.
  $home2 = Join-Path $T 'get-home'
  $env:IGRO_HOME = $home2; $env:IGRO_HOST_NAME = $TestHost
  $get = Join-Path $Root 'get.ps1'
  Set-Release '98.0.0'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $get | Out-Null
  Check 'get.ps1: exits cleanly' ($LASTEXITCODE -eq 0)
  $hj = Join-Path $home2 "updater\$TestHost.json"
  $hm = if (Test-Path $hj) { Get-Content -Raw $hj | ConvertFrom-Json }
  Check 'get.ps1: installs the release' ((Read-Manifest $home2).version -eq '98.0.0')
  Check 'get.ps1: host manifest has host.cmd path and the fixed origin' ($hm.name -eq $TestHost -and
    $hm.path -eq (Join-Path $home2 'updater\host.cmd') -and $hm.allowed_origins[0] -eq "chrome-extension://$(Get-ExtensionId $key)/")
  Check 'get.ps1: registers the host in HKCU' ((Get-ItemProperty $TestReg).'(default)' -eq $hj)
  $r = Invoke-Host $home2 @{ cmd = 'check' }
  $iid = [IO.File]::ReadAllText((Join-Path $home2 'updater\install-id.txt')).Trim()
  Check 'get.ps1: installed host answers with the install marker' ($r.current -eq '98.0.0' -and $iid -and $r.installId -eq $iid)

  Set-Release '98.1.0'
  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $get | Out-Null
  Check 'get.ps1: running again updates in place, keeps the marker' ($LASTEXITCODE -eq 0 -and (Read-Manifest $home2).version -eq '98.1.0' -and
    [IO.File]::ReadAllText((Join-Path $home2 'updater\install-id.txt')).Trim() -eq $iid)

  & powershell.exe -NoProfile -ExecutionPolicy Bypass -File $get -Uninstall | Out-Null
  Check 'get.ps1 -Uninstall: removes the folder and the registry key' ($LASTEXITCODE -eq 0 -and -not (Test-Path $home2) -and -not (Test-Path $TestReg))
} catch {
  Write-Host "FAIL  test crashed: $($_.Exception.Message)" -ForegroundColor Red; $script:fail++
} finally {
  if (Test-Path $TestReg) { Remove-Item -Recurse -Force $TestReg }
  Remove-Item -Recurse -Force $T -ErrorAction SilentlyContinue
  Remove-Item Env:IGRO_API_BASE, Env:IGRO_HOME, Env:IGRO_HOST_NAME -ErrorAction SilentlyContinue
}
if ($script:fail) { Write-Host "$script:fail check(s) failed" -ForegroundColor Red; exit 1 }
Write-Host 'All checks passed'
