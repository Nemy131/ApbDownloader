'use strict';
// Checks the GitHub "latest release" of this app on startup, asks the user, and replaces the portable folder in place.
// The data folder (session, history, bookmarks, settings) is never touched.
// Flow: confirm dialog -> download (+size/SHA-256 check) -> extract while the app is still running ->
// hand off a small copy-and-restart script that outlives this process -> quit.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');

const ASSET_PATTERN = /^AplayboxDownloader-Windows-x64\.zip$/i;
const RESULT_FILE = 'update-result.json';

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
      onProgress?.(loaded, total);
    }
  } finally { await new Promise(r => out.end(r)); }
  if (info.size && loaded !== info.size) throw new Error('받은 파일 크기가 릴리스 정보와 다릅니다.');
  if (info.sha256 && hash.digest('hex') !== info.sha256) throw new Error('받은 파일의 SHA-256 값이 릴리스 정보와 다릅니다.');
}

const powershell = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// Extracts while the app is still running so progress can be shown and failures reported in the UI.
function extract(zip, dest) {
  return new Promise((resolve, reject) => {
    execFile(powershell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', 'Expand-Archive -LiteralPath $env:APB_ZIP -DestinationPath $env:APB_DEST -Force'],
      { env: { ...process.env, APB_ZIP: zip, APB_DEST: dest }, windowsHide: true, timeout: 300000 },
      err => err ? reject(new Error('압축 해제 실패: ' + (err.message || err))) : resolve());
  });
}

// Runs after the app exits: copies the extracted files over the app folder (skipping data), records the result,
// restarts the app, and removes the temporary folder. All paths come from environment variables.
const SWAP_SCRIPT = String.raw`$ErrorActionPreference = 'Stop'
$log = $env:APB_LOG; $result = $env:APB_RESULT
function Note($m){ try { Add-Content -LiteralPath $log -Value ((Get-Date -Format s) + ' ' + $m) -Encoding UTF8 } catch {} }
$ok = $false; $msg = ''
try {
  Note ('업데이트 ' + $env:APB_VERSION + ' 적용 시작')
  try { Wait-Process -Id ([int]$env:APB_PID) -Timeout 120 -ErrorAction Stop } catch {}
  Start-Sleep -Milliseconds 700
  & robocopy $env:APB_SRC $env:APB_APPDIR /E /XD data /R:10 /W:1 /NFL /NDL /NJH /NJS /NP | Out-Null
  if ($LASTEXITCODE -ge 8) { throw "파일 복사 실패 (robocopy $LASTEXITCODE)" }
  $ok = $true; Note '업데이트 완료'
} catch { $msg = $_.Exception.Message; Note ('업데이트 실패: ' + $msg) }
try { (@{ ok = $ok; version = $env:APB_VERSION; message = $msg; time = (Get-Date -Format s) } | ConvertTo-Json -Compress) | Set-Content -LiteralPath $result -Encoding UTF8 } catch {}
try { Start-Process -FilePath $env:APB_EXE -WorkingDirectory $env:APB_APPDIR } catch { Note ('재시작 실패: ' + $_.Exception.Message) }
Start-Sleep -Seconds 2
try { Remove-Item -LiteralPath $env:APB_TEMP -Recurse -Force } catch {}
`;

// Electron terminates its own child processes on exit, so the swap script is started through "cmd /c start",
// which leaves a process that is not our child. Only quoted file paths are on the command line.
function launchSwap(env) {
  const script = path.join(env.APB_TEMP, 'apply-update.ps1');
  fs.writeFileSync(script, '\ufeff' + SWAP_SCRIPT, 'utf8');
  const q = s => '"' + String(s).replace(/"/g, '') + '"';
  const line = `/d /c start "" /min ${q(powershell())} -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File ${q(script)}`;
  const child = spawn(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'cmd.exe'), [line], { env: { ...process.env, ...env }, detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true });
  child.unref();
}

function sender(win) {
  let last = 0;
  return (state, force) => {
    const now = Date.now();
    if (!force && state.phase === 'download' && now - last < 150) return;
    last = now;
    if (win && !win.isDestroyed()) win.webContents.send('update-state', state);
  };
}

// Shows the outcome of an update that was applied while the app was closed. Called once after the window loads.
async function reportPreviousResult({ win, dataDir, app }) {
  const file = path.join(dataDir, RESULT_FILE);
  let r; try { r = JSON.parse((await fsp.readFile(file, 'utf8')).replace(/^\ufeff/, '')); } catch { return; }
  await fsp.unlink(file).catch(() => {});
  const send = sender(win);
  if (r.ok && compareVersions(app.getVersion(), r.version) >= 0) send({ phase: 'done', version: app.getVersion() }, true);
  else send({ phase: 'error', version: r.version, message: r.message || '새 파일이 적용되지 않았습니다. data/update.log를 확인해 주세요.' }, true);
}

// Called once after the main window has loaded. Never throws.
async function checkOnStartup({ app, dialog, win, repo, dataDir, onLog }) {
  const send = sender(win);
  let info = null;
  try {
    await reportPreviousResult({ win, dataDir, app });
    if (!app.isPackaged || process.platform !== 'win32' || !repo) return;
    const appDir = path.dirname(process.execPath);
    const skipFile = path.join(dataDir, 'update-skip.json');
    let release = null; try { release = await fetchLatest(repo); } catch { return; } // offline or rate-limited: stay quiet
    info = pickUpdate(release, app.getVersion());
    if (!info) return;
    let skipped = ''; try { skipped = JSON.parse(await fsp.readFile(skipFile, 'utf8')).version || ''; } catch {}
    if (skipped === info.version) return;
    if (!win || win.isDestroyed()) return;
    const notes = info.notes ? '\n\n변경 사항:\n' + info.notes.slice(0, 900) : '';
    const response = process.env.APLAYBOX_UPDATE_AUTOACCEPT === '1' ? 0 : (await dialog.showMessageBox(win, {
      type: 'info', title: '업데이트 확인', buttons: ['지금 업데이트', '나중에', '이 버전 건너뛰기'], defaultId: 0, cancelId: 1, noLink: true,
      message: `새 버전 ${info.version}이 있습니다. (현재 ${app.getVersion()})`,
      detail: '지금 업데이트하면 파일을 받은 뒤 앱을 다시 시작합니다. 로그인 정보·기록·북마크·설정이 있는 data 폴더는 그대로 유지됩니다.' + notes
    })).response;
    if (response === 2) { await fsp.writeFile(skipFile, JSON.stringify({ version: info.version }), 'utf8'); return; }
    if (response !== 0) return;

    const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'aplaybox-update-'));
    const zip = path.join(temp, 'AplayboxDownloader-Windows-x64.zip');
    send({ phase: 'download', version: info.version, loaded: 0, total: info.size }, true);
    try {
      await download(info, zip, (loaded, total) => { send({ phase: 'download', version: info.version, loaded, total }); if (!win.isDestroyed() && total) win.setProgressBar(loaded / total); });
    } finally { if (!win.isDestroyed()) win.setProgressBar(-1); }
    send({ phase: 'extract', version: info.version }, true);
    const dest = path.join(temp, 'extract');
    await extract(zip, dest);
    const src = path.join(dest, 'AplayboxDownloader');
    if (!fs.existsSync(path.join(src, 'AplayboxDownloader.exe'))) throw new Error('받은 파일 안에 AplayboxDownloader.exe가 없습니다.');
    await fsp.unlink(zip).catch(() => {});
    send({ phase: 'restart', version: info.version }, true);
    launchSwap({ APB_PID: String(process.pid), APB_SRC: src, APB_APPDIR: appDir, APB_EXE: process.execPath, APB_TEMP: temp, APB_VERSION: info.version, APB_LOG: path.join(dataDir, 'update.log'), APB_RESULT: path.join(dataDir, RESULT_FILE) });
    onLog?.(`업데이트 ${info.version} 적용을 위해 앱을 다시 시작합니다.`);
    await new Promise(r => setTimeout(r, 1500));
    app.quit();
  } catch (e) {
    onLog?.('업데이트 실패: ' + (e?.message || e));
    send({ phase: 'error', version: info?.version || '', message: String(e?.message || e) }, true);
  }
}

module.exports = { parseVersion, compareVersions, pickUpdate, fetchLatest, download, checkOnStartup };
