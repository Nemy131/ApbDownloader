@echo off
setlocal
set "ELECTRON_RUN_AS_NODE="
set "APLAYBOX_DATA=%~dp0data"
if exist "%~dp0dist\AplayboxDownloader\AplayboxDownloader.exe" (
  start "" "%~dp0dist\AplayboxDownloader\AplayboxDownloader.exe"
) else if exist "%~dp0vendor\electron\electron.exe" (
  start "" "%~dp0vendor\electron\electron.exe" "%~dp0."
) else (
  echo Run Build.ps1 first, or use the dist\AplayboxDownloader\AplayboxDownloader.exe package.
  pause
)
