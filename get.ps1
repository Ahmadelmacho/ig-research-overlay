# IG Research Overlay: install, update or remove (Windows, no admin needed).
#   Install / update:  irm https://raw.githubusercontent.com/Ahmadelmacho/ig-research-overlay/main/get.ps1 | iex
#   Remove:            & ([scriptblock]::Create((irm https://raw.githubusercontent.com/Ahmadelmacho/ig-research-overlay/main/get.ps1))) -Uninstall
# Test overrides: IGRO_HOME (install folder), IGRO_API_BASE (release API), IGRO_HOST_NAME (registry name).
param([switch]$Uninstall)
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
Add-Type -AssemblyName System.IO.Compression.FileSystem

$Repo = 'Ahmadelmacho/ig-research-overlay'
$AssetName = 'ig-research-overlay.zip'
$Dir = if ($env:IGRO_HOME) { $env:IGRO_HOME } else { Join-Path $env:LOCALAPPDATA 'IG-Research-Overlay' }
$ApiBase = if ($env:IGRO_API_BASE) { $env:IGRO_API_BASE.TrimEnd('/') } else { 'https://api.github.com' }
$HostName = if ($env:IGRO_HOST_NAME) { $env:IGRO_HOST_NAME } else { 'com.igro.updater' }
# .NET hash, no module needed (5.1 started from pwsh 7 cannot load Get-FileHash)
function Get-Sha($p) { $s = [IO.File]::OpenRead($p); try { [BitConverter]::ToString([Security.Cryptography.SHA256]::Create().ComputeHash($s)).Replace('-', '') } finally { $s.Dispose() } }
$RegKey = "HKCU:\Software\Google\Chrome\NativeMessagingHosts\$HostName"

if (Test-Path -LiteralPath (Join-Path $Dir '.git')) { throw "$Dir is a developer copy (it has .git). Use git there instead." }

# Same lock as the updater helper, so an update from the popup and this script never overlap.
$mx = New-Object Threading.Mutex($false, 'Local\igro-updater')
try { $got = $mx.WaitOne(120000) } catch [Threading.AbandonedMutexException] { $got = $true }  # a crashed run still hands over the lock
if (-not $got) { throw 'An update is already running. Try again in a minute.' }
try {
if ($Uninstall) {
  if (Test-Path -LiteralPath $RegKey) { Remove-Item -Recurse -Force -LiteralPath $RegKey }
  if (Test-Path -LiteralPath $Dir) { Remove-Item -Recurse -Force -LiteralPath $Dir }
  Write-Host "Removed $Dir and the updater registration."
  Write-Host "Last step: in chrome://extensions, click Remove on the IG Research Overlay card."
  return
}

$h = @{ 'User-Agent' = 'igro-get'; 'Accept' = 'application/vnd.github+json' }
$rel = Invoke-RestMethod -Uri "$ApiBase/repos/$Repo/releases/latest" -Headers $h
$a = @($rel.assets | Where-Object { $_.name -eq $AssetName })[0]
if (-not $a) { throw "The latest release has no $AssetName." }
if ($a.digest -notmatch '^sha256:([0-9a-fA-F]{64})$') { throw 'The release file has no sha256 digest; refusing to install.' }
$want = $Matches[1]

$tmp = Join-Path ([IO.Path]::GetTempPath()) ('igro-get-' + [guid]::NewGuid())
New-Item -ItemType Directory $tmp | Out-Null
try {
  $zip = Join-Path $tmp $AssetName
  Write-Host "Downloading IG Research Overlay $($rel.tag_name)..."
  Invoke-WebRequest -UseBasicParsing -Uri $a.browser_download_url -OutFile $zip -Headers @{ 'User-Agent' = 'igro-get' }
  if ((Get-Sha $zip) -ne $want.ToUpper()) { throw 'The download does not match the release digest; nothing was installed.' }
  $src = Join-Path $tmp 'x'
  [IO.Compression.ZipFile]::ExtractToDirectory($zip, $src)
  [IO.Directory]::CreateDirectory($Dir) | Out-Null
  # shortcut: a copy error part-way leaves a mixed folder; running this command again repairs it.
  Get-ChildItem -LiteralPath $src | Copy-Item -Recurse -Force -Destination $Dir
} finally { Remove-Item -Recurse -Force -LiteralPath $tmp -ErrorAction SilentlyContinue }

$id = [IO.File]::ReadAllText((Join-Path $Dir 'updater\extension-id.txt')).Trim()
# Random marker the popup compares with the updater's, so it knows they are the same folder. Kept on re-runs.
$idFile = Join-Path $Dir 'updater\install-id.txt'
if (-not [IO.File]::Exists($idFile)) { [IO.File]::WriteAllText($idFile, [guid]::NewGuid().ToString()) }
$hostJson = Join-Path $Dir "updater\$HostName.json"
$m = [ordered]@{
  name = $HostName
  description = 'IG Research Overlay updater'
  path = (Join-Path $Dir 'updater\host.cmd')
  type = 'stdio'
  allowed_origins = @("chrome-extension://$id/")
}
[IO.File]::WriteAllText($hostJson, ($m | ConvertTo-Json), (New-Object Text.UTF8Encoding $false))
New-Item -Force $RegKey | Out-Null
Set-Item -Path $RegKey -Value $hostJson
} finally { $mx.ReleaseMutex(); $mx.Dispose() }

Write-Host ""
Write-Host "Installed IG Research Overlay $($rel.tag_name) in:"
Write-Host "  $Dir"
Write-Host ""
Write-Host "First time only, load it in Chrome:"
Write-Host "  1. Open chrome://extensions"
Write-Host "  2. Turn on Developer mode (top right)"
Write-Host "  3. Click Load unpacked"
Write-Host "  4. Pick the folder: $Dir"
Write-Host ""
Write-Host "Already loaded? Click the reload icon on its card in chrome://extensions, then refresh Instagram."
