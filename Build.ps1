param([string]$OutputDirectory = '')
$ErrorActionPreference = 'Stop'
$projectDir = $PSScriptRoot
$runtimeDir = Join-Path $projectDir 'vendor/electron'
$archive = Join-Path $projectDir 'vendor/electron.zip'
$releaseUrl = 'https://github.com/electron/electron/releases/download/v45.3.1'
$expectedSha256 = 'd92d1aa4700e3a7e7f174731f5086ebd9c21f9773e642b260160fe0a6ebe12d2'
New-Item -ItemType Directory -Force (Join-Path $projectDir 'vendor') | Out-Null
if (-not (Test-Path -LiteralPath $archive)) {
    Invoke-WebRequest "$releaseUrl/electron-v45.3.1-win32-x64.zip" -OutFile $archive
}
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expectedSha256) { throw 'Electron archive checksum mismatch.' }
if (-not (Test-Path -LiteralPath (Join-Path $runtimeDir 'electron.exe'))) {
    Expand-Archive -LiteralPath $archive -DestinationPath $runtimeDir
}
$packageDir = if ($OutputDirectory) { [IO.Path]::GetFullPath($OutputDirectory) } else { Join-Path $projectDir 'dist/AplayboxDownloader' }
New-Item -ItemType Directory -Force $packageDir | Out-Null
Get-ChildItem -LiteralPath $runtimeDir | Where-Object { $_.Name -ne 'electron.exe' } | Copy-Item -Destination $packageDir -Recurse -Force
Copy-Item -LiteralPath (Join-Path $runtimeDir 'electron.exe') -Destination (Join-Path $packageDir 'AplayboxDownloader.exe') -Force
$appDir = Join-Path $packageDir 'resources/app'
New-Item -ItemType Directory -Force $appDir | Out-Null
Copy-Item -LiteralPath (Join-Path $projectDir 'package.json') -Destination $appDir -Force
Copy-Item -LiteralPath (Join-Path $projectDir 'src') -Destination $appDir -Recurse -Force
# ImportMMD.ini is written next to the script when it is run from the source tree; it holds this PC's settings and is not shipped.
Remove-Item -LiteralPath (Join-Path $appDir 'src\max\ImportMMD.ini') -Force -ErrorAction SilentlyContinue
Copy-Item -LiteralPath (Join-Path $projectDir 'README.md') -Destination $packageDir -Force
Copy-Item -LiteralPath (Join-Path $projectDir 'VERIFICATION.md') -Destination $packageDir -Force
Write-Output "Built: $packageDir/AplayboxDownloader.exe"
Write-Output 'Distribute the complete folder. Do not include a data folder containing personal sessions.'
