# IG Research Overlay updater: Chrome native messaging host (com.igro.updater).
# Chrome starts it only when the popup asks. It talks only to the GitHub releases
# of Ahmadelmacho/ig-research-overlay. Nothing but framed replies may reach stdout.
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.IO.Compression.FileSystem

$Repo = 'Ahmadelmacho/ig-research-overlay'
$Asset = 'ig-research-overlay.zip'
$ApiBase = if ($env:IGRO_API_BASE) { $env:IGRO_API_BASE.TrimEnd('/') } else { 'https://api.github.com' }
$InstallDir = Split-Path -Parent $PSScriptRoot
# Runtime files a release may carry. Anything else in the zip refuses the update.
$AllowedEntry = '^(manifest\.json|[A-Za-z0-9_-]+\.(js|css|html)|(updater|icons)/[A-Za-z0-9_.-]+)$'

function Read-Manifest($dir) { [IO.File]::ReadAllText((Join-Path $dir 'manifest.json')) | ConvertFrom-Json }
function Get-Ver($s) { [version]($s -replace '^v', '') }
function Test-DevCopy { Test-Path -LiteralPath (Join-Path $InstallDir '.git') }
function Get-Sha($p) { $s = [IO.File]::OpenRead($p); try { [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($s)).Replace('-', '') } finally { $s.Dispose() } }  # no module needed (5.1 started from pwsh 7 cannot load Get-FileHash)

function Get-Latest {
  $h = @{ 'User-Agent' = 'igro-updater'; 'Accept' = 'application/vnd.github+json' }
  try { Invoke-RestMethod -Uri "$ApiBase/repos/$Repo/releases/latest" -Headers $h }
  catch [Net.WebException] {
    $r = $_.Exception.Response
    # GitHub allows 60 unauthenticated API calls an hour per network; say so plainly.
    if ($r -and ([int]$r.StatusCode -in @(403, 429)) -and ($r.Headers['X-RateLimit-Remaining'] -eq '0')) {
      throw 'GitHub is limiting update checks from this network right now (60 an hour). Try again in an hour.'
    }
    throw
  }
}

function Invoke-Check {
  $rel = Get-Latest
  $cur = (Read-Manifest $InstallDir).version
  $r = @{ current = $cur; latest = ($rel.tag_name -replace '^v', ''); updateAvailable = ((Get-Ver $rel.tag_name) -gt (Get-Ver $cur)) }
  if ($rel.body) { $r.notes = ([string]$rel.body).Substring(0, [Math]::Min(2000, ([string]$rel.body).Length)) }
  if (Test-DevCopy) { $r.devCopy = $true }
  # get.ps1 writes this random marker; the popup compares it with its own copy to know it is the same folder.
  $idFile = Join-Path $PSScriptRoot 'install-id.txt'
  if ([IO.File]::Exists($idFile)) { $r.installId = [IO.File]::ReadAllText($idFile).Trim() }
  $r
}

function Invoke-Update {
  if (Test-DevCopy) { return @{ ok = $false; devCopy = $true; error = 'Developer copy: update with git pull' } }
  # Chrome starts one host per message; never let two updates write the same folder.
  $mx = New-Object Threading.Mutex($false, 'Local\igro-updater')
  try { $got = $mx.WaitOne(0) } catch [Threading.AbandonedMutexException] { $got = $true }  # a crashed run still hands over the lock
  if (-not $got) { throw 'another update is already running' }
  $tmp = Join-Path ([IO.Path]::GetTempPath()) ('igro-' + [guid]::NewGuid())
  [IO.Directory]::CreateDirectory($tmp) | Out-Null
  try {
    $rel = Get-Latest
    $a = @($rel.assets | Where-Object { $_.name -eq $Asset })[0]
    if (-not $a) { throw "release has no $Asset" }
    if ($a.digest -notmatch '^sha256:([0-9a-fA-F]{64})$') { throw 'release asset has no sha256 digest' }
    $want = $Matches[1]
    $zip = Join-Path $tmp $Asset
    Invoke-WebRequest -UseBasicParsing -Uri $a.browser_download_url -OutFile $zip -Headers @{ 'User-Agent' = 'igro-updater' }
    if ((Get-Sha $zip) -ne $want.ToUpper()) { throw 'download does not match the release digest' }
    $z = [IO.Compression.ZipFile]::OpenRead($zip)
    try {
      foreach ($e in $z.Entries) {
        $n = $e.FullName.Replace([char]92, [char]47)  # backslash to slash
        if ($n.EndsWith('/')) { continue }
        if ($n -notmatch $AllowedEntry) { throw "unexpected file in release: $n" }
      }
    } finally { $z.Dispose() }
    $src = Join-Path $tmp 'x'
    [IO.Compression.ZipFile]::ExtractToDirectory($zip, $src)  # .NET refuses entries that escape $src
    $new = Read-Manifest $src
    $old = Read-Manifest $InstallDir
    if (-not $new.key -or $new.key -ne $old.key) { throw 'release is signed for a different extension (key mismatch)' }
    if ((Get-Ver $new.version) -le (Get-Ver $old.version)) { throw "release $($new.version) is not newer than $($old.version)" }
    # manifest.json last. Every replaced file is backed up first, so a failure part-way rolls back.
    $files = Get-ChildItem -Recurse -File -LiteralPath $src | Sort-Object { $_.Name -eq 'manifest.json' }
    $bak = Join-Path $tmp 'bak'
    $done = @()
    try {
      foreach ($f in $files) {
        $relPath = $f.FullName.Substring($src.Length + 1)
        $dst = Join-Path $InstallDir $relPath
        $had = [IO.File]::Exists($dst)
        # Skip identical files: host.cmd is still being read by cmd.exe while this runs.
        if ($had -and (Get-Sha $dst) -eq (Get-Sha $f.FullName)) { continue }
        if ($had) {
          $b = Join-Path $bak $relPath
          [IO.Directory]::CreateDirectory((Split-Path -Parent $b)) | Out-Null
          [IO.File]::Copy($dst, $b, $true)
        } else { $b = $null }
        [IO.Directory]::CreateDirectory((Split-Path -Parent $dst)) | Out-Null
        $done += , @($dst, $b)  # before the move: a failed move may already have deleted $dst
        [IO.File]::Copy($f.FullName, "$dst.igro-new", $true)
        Move-Item -Force -LiteralPath "$dst.igro-new" -Destination $dst
      }
    } catch {
      $why = $_.Exception.Message
      $undone = $true
      try { [IO.File]::Delete("$dst.igro-new") } catch { }
      foreach ($d in $done) {
        try {
          if (-not $d[1]) { [IO.File]::Delete($d[0]) }
          elseif (-not [IO.File]::Exists($d[0]) -or (Get-Sha $d[0]) -ne (Get-Sha $d[1])) { [IO.File]::Copy($d[1], $d[0], $true) }
        } catch { $undone = $false }
      }
      if ($undone) { throw "update failed and was rolled back: $why" }
      throw "update failed and could not be fully rolled back; run the install command again: $why"
    }
    @{ ok = $true; version = $new.version }
  } finally {
    Remove-Item -Recurse -Force -LiteralPath $tmp -ErrorAction SilentlyContinue
    $mx.ReleaseMutex(); $mx.Dispose()
  }
}

function Read-Exactly($s, $n) {
  $buf = New-Object byte[] $n; $got = 0
  while ($got -lt $n) { $r = $s.Read($buf, $got, $n - $got); if ($r -le 0) { return $null }; $got += $r }
  ,$buf
}

$in = [Console]::OpenStandardInput()
$out = [Console]::OpenStandardOutput()
while ($true) {
  $len = Read-Exactly $in 4
  if ($null -eq $len) { break }
  $body = Read-Exactly $in ([BitConverter]::ToInt32($len, 0))
  if ($null -eq $body) { break }
  try {
    $msg = [Text.Encoding]::UTF8.GetString($body) | ConvertFrom-Json
    $reply = switch ($msg.cmd) {
      'check' { Invoke-Check }
      'update' { Invoke-Update }
      default { @{ ok = $false; error = "unknown cmd: $($msg.cmd)" } }
    }
  } catch { $reply = @{ ok = $false; error = $_.Exception.Message } }
  $bytes = [Text.Encoding]::UTF8.GetBytes(($reply | ConvertTo-Json -Compress))
  $out.Write([BitConverter]::GetBytes([int]$bytes.Length), 0, 4)
  $out.Write($bytes, 0, $bytes.Length)
  $out.Flush()
}
