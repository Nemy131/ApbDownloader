# Build, verify and (optionally) publish Aplaybox Downloader.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\release.ps1                 # build + smoke test + ZIP
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\release.ps1 -InstallDir D:\Apps\AplayboxDownloader
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\release.ps1 -Publish        # + copy to the NAS share + latest.json + git tag
#   powershell -NoProfile -ExecutionPolicy Bypass -File scripts\release.ps1 -Publish -GitHub # + also a GitHub release (bridge for builds
#                                                                                       that still update from GitHub, i.e. v2.1.4 and older)
#
# Rules (see AGENTS.md): the version comes from package.json; docs/handoff/v<version>.md must exist before -Publish
# and its "## 릴리스 노트" section becomes the update notes. data folders are never copied or zipped.
# -Publish copies both archives to <updateSource>\v<version>\, checks their SHA-256 on the share, and replaces
# <updateSource>\latest.json last, so running apps never see a version whose files are not complete.
param(
  [switch]$Publish,
  [switch]$GitHub,
  [string]$GitHubRepo = 'Nemy131/ApbDownloader',
  [string]$InstallDir = '',
  [switch]$SkipSmoke
)
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
$pkg = Get-Content (Join-Path $root 'package.json') -Raw -Encoding UTF8 | ConvertFrom-Json
$version = $pkg.version
$share = $pkg.updateSource
$handoff = Join-Path $root "docs\handoff\v$version.md"
"version $version  share $share"
if (-not (Test-Path $handoff)) {
  if ($Publish) { throw "Missing $handoff. Write the handoff note for this version first (copy docs\handoff\TEMPLATE.md)." }
  Write-Warning "Missing $handoff (required before -Publish)."
}

if ($GitHub -and -not $Publish) { throw '-GitHub needs -Publish.' }
# Runs a native command only for its exit code. Windows PowerShell 5.1 turns redirected stderr into a terminating
# error while $ErrorActionPreference is 'Stop', so it is relaxed here; the output is discarded.
function Succeeds([scriptblock]$command) {
  $old = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  try { & $command 2>&1 | Out-Null; return ($LASTEXITCODE -eq 0) } finally { $ErrorActionPreference = $old }
}
if ($GitHub) {
  $gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
  if (-not $gh) { $gh = 'C:\Program Files\GitHub CLI\gh.exe' }
  if (-not (Test-Path $gh)) { throw 'gh CLI not found (needed for -GitHub). Install it and run gh auth login.' }
  if (-not (Succeeds { & $gh auth status })) { throw 'gh CLI is not logged in. Run gh auth login first.' }
  if (Succeeds { & $gh release view "v$version" --repo $GitHubRepo }) { throw "GitHub release v$version already exists in $GitHubRepo." }
  $head = (& git rev-parse HEAD).Trim()
  if (-not (Succeeds { & $gh api "repos/$GitHubRepo/commits/$head" --silent })) { throw "Commit $head is not on GitHub ($GitHubRepo). Push it first." }
}
if ($Publish) {
  $dirty = & git status --porcelain
  if ($dirty) { throw "Working tree is not clean. Commit first:`n$dirty" }
  if (& git tag --list "v$version") { throw "Tag v$version already exists. Bump the version in package.json." }
  if (-not $share -or -not (Test-Path -LiteralPath $share)) { throw "Update share not reachable: $share (package.json updateSource)" }
  if (Test-Path -LiteralPath (Join-Path $share "v$version")) { throw "v$version already exists on the share. Bump the version in package.json." }
}

# 1. Build (Build.ps1 downloads and verifies the Electron runtime into vendor/ on first use)
$out = Join-Path $root ("build\package-" + [guid]::NewGuid().ToString('N') + "\AplayboxDownloader")
& powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $root 'Build.ps1') -OutputDirectory $out | Out-Host
if (-not (Test-Path (Join-Path $out 'AplayboxDownloader.exe'))) { throw 'build failed' }

# 1b. Slim down: Chromium ships 55 UI language packs (~50 MB); the app only needs Korean and the English fallback.
$keepLocales = @('ko.pak', 'en-US.pak')
$locales = Join-Path $out 'locales'
foreach ($k in $keepLocales) { if (-not (Test-Path (Join-Path $locales $k))) { throw "missing locale $k" } }
Get-ChildItem -File $locales | Where-Object { $keepLocales -notcontains $_.Name } | Remove-Item -Force
"locales kept: $((Get-ChildItem -File $locales).Name -join ', ')"

# 2. Smoke test: reads public Aplaybox data only (no account actions). Needs network.
if (-not $SkipSmoke) {
  $p = Start-Process -FilePath (Join-Path $out 'AplayboxDownloader.exe') -ArgumentList '--smoke-test' -PassThru -Wait
  $v = Get-Content (Join-Path $out 'data\live-verification.json') -Raw -Encoding UTF8 | ConvertFrom-Json
  "smoke exit=$($p.ExitCode) models=$($v.models)"
  if ($p.ExitCode -ne 0 -or -not $v.models) { throw 'smoke test failed' }
}
if (Test-Path (Join-Path $out 'data')) { Remove-Item -Recurse -Force (Join-Path $out 'data') }

function HashMap($dir) { $h = @{}; Get-ChildItem -Recurse -File (Join-Path $dir 'resources\app') | ForEach-Object { $h[$_.FullName.Substring($dir.Length)] = (Get-FileHash $_.FullName).Hash }; $h }
$src = HashMap $out
function Verify($dir) { $d = HashMap $dir; $bad = @($src.Keys | Where-Object { $d[$_] -ne $src[$_] }); "$dir mismatch=$($bad.Count) files=$($src.Count)"; if ($bad.Count) { throw "copy mismatch in $dir" } }

# 3. dist/ and an optional portable install (its data folder is kept)
$dist = Join-Path $root 'dist\AplayboxDownloader'
robocopy $out $dist /E /XD data /NFL /NDL /NJH /NJS /NP | Out-Null
Verify $dist
# robocopy /E never deletes, so language packs left by an older build are removed here.
Get-ChildItem -File (Join-Path $dist 'locales') | Where-Object { $keepLocales -notcontains $_.Name } | Remove-Item -Force
if ($InstallDir) {
  $full = [IO.Path]::GetFullPath($InstallDir)
  $running = Get-Process AplayboxDownloader -ErrorAction SilentlyContinue | Where-Object { $_.Path -and $_.Path.StartsWith($full, [StringComparison]::OrdinalIgnoreCase) }
  if ($running) { Write-Warning "Install skipped: the app is running from $full" }
  else { robocopy $out $full /E /XD data /NFL /NDL /NJH /NJS /NP | Out-Null; Verify $full }
}

# 4. Release ZIP (top folder AplayboxDownloader/, no data/)
Add-Type -AssemblyName System.IO.Compression, System.IO.Compression.FileSystem
$relDir = Join-Path $root "release\v$version"
New-Item -ItemType Directory -Force $relDir | Out-Null
$zip = Join-Path $relDir 'AplayboxDownloader-Windows-x64.zip'
if (Test-Path $zip) { Remove-Item -Force $zip }
$za = [System.IO.Compression.ZipFile]::Open($zip, 'Create')
try {
  Get-ChildItem -Recurse -File $out | ForEach-Object {
    $rp = $_.FullName.Substring($out.Length + 1).Replace('\', '/')
    if ($rp -notmatch '^data/') { [void][System.IO.Compression.ZipFileExtensions]::CreateEntryFromFile($za, $_.FullName, 'AplayboxDownloader/' + $rp, 'Optimal') }
  }
} finally { $za.Dispose() }
$check = [System.IO.Compression.ZipFile]::OpenRead($zip)
try { $dataEntries = @($check.Entries | Where-Object { $_.FullName -match '/data/' }).Count; $count = $check.Entries.Count } finally { $check.Dispose() }
if ($dataEntries) { throw 'ZIP contains data entries' }
$sha = (Get-FileHash $zip -Algorithm SHA256).Hash.ToLower()
"zip $zip entries=$count size=$((Get-Item $zip).Length) sha256=$sha"

# 4b. Release 7z (same contents, about a third smaller). Made with Bandizip's console tool (bz.exe).
# The ZIP stays as well: versions up to 2.0.0 only know the ZIP, and newer ones fall back to it when 7z cannot be extracted.
$seven = Join-Path $relDir 'AplayboxDownloader-Windows-x64.7z'
$sevenSha = ''
if (Test-Path $seven) { Remove-Item -Force $seven }
$bz = @((Get-Command bz.exe -ErrorAction SilentlyContinue).Source, (Join-Path $env:ProgramFiles 'Bandizip\bz.exe'), (Join-Path ${env:ProgramFiles(x86)} 'Bandizip\bz.exe')) | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $bz) {
  if ($Publish) { throw 'Bandizip (bz.exe) not found: the 7z asset cannot be made.' }
  Write-Warning 'Bandizip (bz.exe) not found: 7z skipped.'
} else {
  Push-Location (Split-Path -Parent $out)
  try { & $bz c -fmt:7z -l:9 -r -y $seven 'AplayboxDownloader' | Out-Null; if ($LASTEXITCODE) { throw "bz failed ($LASTEXITCODE)" } } finally { Pop-Location }
  & $bz t $seven | Out-Null; if ($LASTEXITCODE) { throw '7z integrity test failed' }
  # Extract it the way the updater does (Windows tar) and compare the app files with the build.
  $probe = Join-Path $env:TEMP ("apb-7z-" + [guid]::NewGuid().ToString('N'))
  New-Item -ItemType Directory -Force $probe | Out-Null
  try {
    & (Join-Path $env:SystemRoot 'System32\tar.exe') -xf $seven -C $probe; if ($LASTEXITCODE) { throw 'Windows tar could not extract the 7z' }
    if (Test-Path (Join-Path $probe 'AplayboxDownloader\data')) { throw '7z contains data entries' }
    Verify (Join-Path $probe 'AplayboxDownloader')
    if ((Get-FileHash (Join-Path $probe 'AplayboxDownloader\AplayboxDownloader.exe')).Hash -ne (Get-FileHash (Join-Path $out 'AplayboxDownloader.exe')).Hash) { throw '7z exe mismatch' }
  } finally { Remove-Item -Recurse -Force $probe -ErrorAction SilentlyContinue }
  $sevenSha = (Get-FileHash $seven -Algorithm SHA256).Hash.ToLower()
  "7z  $seven size=$((Get-Item $seven).Length) sha256=$sevenSha"
}

# 5. Publish to the NAS share
if ($Publish) {
  $text = [IO.File]::ReadAllText($handoff, [Text.Encoding]::UTF8)
  $m = [regex]::Match($text, '(?ms)^## 릴리스 노트\s*\r?\n(.*?)(?=^## |\z)')
  if (-not $m.Success -or -not $m.Groups[1].Value.Trim()) { throw "No '## 릴리스 노트' section in $handoff" }
  $verDir = Join-Path $share "v$version"
  New-Item -ItemType Directory -Force $verDir | Out-Null
  $files = @()
  foreach ($pair in @(@($seven, $sevenSha, '7z'), @($zip, $sha, 'zip'))) {
    $name = Split-Path -Leaf $pair[0]
    $dest = Join-Path $verDir $name
    Copy-Item -LiteralPath $pair[0] -Destination $dest -Force
    $copied = (Get-FileHash -LiteralPath $dest -Algorithm SHA256).Hash.ToLower()
    "share $dest sha256=$copied"
    if ($copied -ne $pair[1]) { throw "copied file on the share does not match the local file: $name" }
    $files += [ordered]@{ format = $pair[2]; path = "v$version/$name"; size = (Get-Item -LiteralPath $dest).Length; sha256 = $copied }
  }
  $manifest = [ordered]@{ version = $version; notes = $m.Groups[1].Value.Trim(); published = (Get-Date).ToUniversalTime().ToString('s') + 'Z'; files = $files }
  $latest = Join-Path $share 'latest.json'
  $tmp = Join-Path $share 'latest.json.tmp'
  [IO.File]::WriteAllText($tmp, ($manifest | ConvertTo-Json -Depth 5), (New-Object Text.UTF8Encoding $false))
  Move-Item -LiteralPath $tmp -Destination $latest -Force
  $check = [IO.File]::ReadAllText($latest, [Text.Encoding]::UTF8) | ConvertFrom-Json
  if ($check.version -ne $version -or @($check.files).Count -ne 2) { throw 'latest.json on the share was not written correctly' }
  "latest.json -> $version"
  & git tag "v$version"; if ($LASTEXITCODE) { throw 'git tag failed' }
}

# 6. Optional GitHub release: builds up to v2.1.4 only check GitHub, so one release there moves them onto this version,
# which from then on updates from the NAS share. The tag is created on GitHub at the pushed commit.
if ($GitHub) {
  $notes = Join-Path $relDir 'release-notes.md'
  [IO.File]::WriteAllText($notes, $m.Groups[1].Value.Trim() + "`n", (New-Object Text.UTF8Encoding $false))
  & $gh release create "v$version" $seven $zip --repo $GitHubRepo --target $head --title "v$version" --notes-file $notes; if ($LASTEXITCODE) { throw 'gh release create failed' }
  $assets = (& $gh release view "v$version" --repo $GitHubRepo --json assets | ConvertFrom-Json).assets
  foreach ($pair in @(@('AplayboxDownloader-Windows-x64.zip', $sha), @('AplayboxDownloader-Windows-x64.7z', $sevenSha))) {
    $digest = ($assets | Where-Object { $_.name -eq $pair[0] }).digest
    "github digest $($pair[0]) $digest"
    if ($digest -ne "sha256:$($pair[1])") { throw "uploaded asset digest does not match the local file: $($pair[0])" }
  }
}
exit 0
