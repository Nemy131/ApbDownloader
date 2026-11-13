'use strict';
// Checks the GitHub "latest release" of this app on startup, asks the user, and replaces the portable folder in place.
// The data folder (session, history, bookmarks, settings) is never touched.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ASSET_PATTERN = /^AplayboxDownloader-Windows-x64\.zip$/i;

function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v || '').trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}
function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  if (!x || !y) return 0;
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i] ? 1 : -1;
  return 0;
}
// Pure: turns a GitHub release JSON into update info, or null when not newer / unusable.
function pickUpdate(release, currentVersion) {
  if (!release || release.draft || release.prerelease) return null;
  const version = String(release.tag_name || '').replace(/^v/i, '');
  if (!parseVersion(version) || compareVersions(version, currentVersion) <= 0) return null;
  const asset = (release.assets || []).find(a => ASSET_PATTERN.test(a.name || ''));
  if (!asset || !/^https:\/\/(github\.com|objects\.githubusercontent\.com|release-assets\.githubusercontent\.com)\//.test(asset.browser_download_url || '')) return null;
  const sha256 = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest || '')?.[1]?.toLowerCase() || null;
  return { version, notes: String(release.body || '').trim(), url: asset.browser_download_url, size: Number(asset.size) || 0, sha256, page: release.html_url || '' };
}

async function fetchLatest(repo, fetchImpl = fetch) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo || '')) return null;
  const ctrl = new AbortController(); const timer = setTimeout(() => ctrl.abort(), 10000);
  try {
    const res = await fetchImpl(`https://api.github.com/repos/${repo}/releases/latest`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'AplayboxDownloader-updater' }, signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } finally { clearTimeout(timer); }
}

async function download(info, target, onProgress) {
  const res = await fetch(info.url, { headers: { 'User-Agent': 'AplayboxDownloader-updater' }, redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`다운로드 실패 (HTTP ${res.status})`);
  const total = Number(res.headers.get('content-length')) || info.size || 0;
  const hash = crypto.createHash('sha256'); const out = fs.createWriteStream(target);
  let loaded = 0;
  try {
    for await (const chunk of res.body) {
      hash.update(chunk); loaded += chunk.length;
      if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
      if (total) onProgress?.(loaded / total);
    }
  } finally { await new Promise(r => out.end(r)); }
  if (info.size && loaded !== info.size) throw new Error('받은 파일 크기가 릴리스 정보와 다릅니다.');
  if (info.sha256 && hash.digest('hex') !== info.sha256) throw new Error('받은 파일의 SHA-256 값이 릴리스 정보와 다릅니다.');
}

// PowerShell script that waits for this process to exit, extracts the ZIP, copies it over the app folder
// (skipping data), and restarts the app. Paths are passed as arguments, never interpolated into code.
const SWAP_SCRIPT = String.raw`param([int]$ProcessId,[string]$Zip,[string]$AppDir,[string]$Exe,[string]$Log)
$ErrorActionPreference = 'Stop'
function Note($m){ Add-Content -LiteralPath $Log -Value ((Get-Date -Format s) + ' ' + $m) -Encoding UTF8 }
try {
  try { Wait-Process -Id $ProcessId -Timeout 60 -ErrorAction Stop } catch {}
  Start-Sleep -Milliseconds 500
  $work = Join-Path ([IO.Path]::GetDirectoryName($Zip)) 'extract'
  if (Test-Path -LiteralPath $work) { Remove-Item -LiteralPath $work -Recurse -Force }
  Expand-Archive -LiteralPath $Zip -DestinationPath $work -Force
  $src = Join-Path $work 'AplayboxDownloader'
  if (-not (Test-Path -LiteralPath (Join-Path $src 'AplayboxDownloader.exe'))) { throw 'ZIP 안에 AplayboxDownloader.exe가 없습니다.' }
  & robocopy $src $AppDir /E /XD data /R:5 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "파일 복사 실패 (robocopy $LASTEXITCODE)" }
  Note '업데이트 완료'
} catch { Note ('업데이트 실패: ' + $_.Exception.Message) }
Start-Process -FilePath $Exe
`;

function runSwap({ zip, appDir, exe, log }) {
  const script = path.join(path.dirname(zip), 'apply-update.ps1');
  fs.writeFileSync(script, '\ufeff' + SWAP_SCRIPT, 'utf8');
  const ps = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const child = spawn(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden', '-File', script, '-ProcessId', String(process.pid), '-Zip', zip, '-AppDir', appDir, '-Exe', exe, '-Log', log], { detached: true, stdio: 'ignore', windowsHide: true });
  child.unref();
}

// Called once after the main window has loaded. Never throws; failures only go to the log callback.
async function checkOnStartup({ app, dialog, win, repo, dataDir, onLog }) {
  try {
    if (!app.isPackaged || process.platform !== 'win32' || !repo) return;
    const appDir = path.dirname(process.execPath);
    const skipFile = path.join(dataDir, 'update-skip.json');
    let release = null; try { release = await fetchLatest(repo); } catch { return; } // offline or rate-limited: stay quiet
    const info = pickUpdate(release, app.getVersion());
    if (!info) return;
    let skipped = ''; try { skipped = JSON.parse(await fsp.readFile(skipFile, 'utf8')).version || ''; } catch {}
    if (skipped === info.version) return;
    if (!win || win.isDestroyed()) return;
    const notes = info.notes ? '\n\n변경 사항:\n' + info.notes.slice(0, 900) : '';
    const { response } = await dialog.showMessageBox(win, {
      type: 'info', title: '업데이트 확인', buttons: ['지금 업데이트', '나중에', '이 버전 건너뛰기'], defaultId: 0, cancelId: 1, noLink: true,
      message: `새 버전 ${info.version}이 있습니다. (현재 ${app.getVersion()})`,
      detail: '지금 업데이트하면 파일을 받은 뒤 앱을 다시 시작합니다. 로그인 정보·기록·북마크·설정이 있는 data 폴더는 그대로 유지됩니다.' + notes
    });
    if (response === 2) { await fsp.writeFile(skipFile, JSON.stringify({ version: info.version }), 'utf8'); return; }
    if (response !== 0) return;
    const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'aplaybox-update-'));
    const zip = path.join(temp, 'AplayboxDownloader-Windows-x64.zip');
    try { await download(info, zip, p => { if (!win.isDestroyed()) win.setProgressBar(p); }); }
    finally { if (!win.isDestroyed()) win.setProgressBar(-1); }
    runSwap({ zip, appDir, exe: process.execPath, log: path.join(dataDir, 'update.log') });
    onLog?.(`업데이트 ${info.version} 적용을 위해 앱을 다시 시작합니다.`);
    app.quit();
  } catch (e) {
    onLog?.('업데이트 확인 실패: ' + (e?.message || e));
    if (e?.name !== 'AbortError' && win && !win.isDestroyed() && /다운로드|크기|SHA-256/.test(String(e?.message))) dialog.showMessageBox(win, { type: 'warning', title: '업데이트 실패', message: '업데이트를 받지 못했습니다.', detail: String(e.message) }).catch(() => {});
  }
}

module.exports = { parseVersion, compareVersions, pickUpdate, fetchLatest, checkOnStartup };
