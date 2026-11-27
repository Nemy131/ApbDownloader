'use strict';
// Checks the company NAS share for a newer version on startup, asks the user, and replaces the portable folder in place.
// The share (package.json "updateSource", a UNC path such as \\server\share\folder) holds:
//   latest.json                                  {version, notes, files:[{format, path, size, sha256}]}
//   v<version>\AplayboxDownloader-Windows-x64.7z  (and .zip)
// The data folder (session, history, bookmarks, settings) is never touched.
// Flow: confirm dialog -> copy from the share (+size/SHA-256 check) -> extract while the app is still running ->
// hand off a small copy-and-restart script that outlives this process -> quit.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn, execFile } = require('node:child_process');

// A version carries the same files twice: a 7z (smaller, preferred) and a ZIP (fallback when the 7z cannot be
// extracted, e.g. on Windows 10 whose tar has no 7z support).
const FILE_NAME = /^AplayboxDownloader-Windows-x64\.(7z|zip)$/i;
const MANIFEST = 'latest.json';
const RESULT_FILE = 'update-result.json';
const READ_TIMEOUT = 10000;   // manifest read; an unreachable share can otherwise block for a long time
const STALL_TIMEOUT = 60000;  // no data from the share for this long while copying an archive

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
// Only absolute local paths or UNC paths (\\server\share\...) are accepted as the update source.
function validSource(source) {
  const s = String(source || '');
  return /^\\\\[^\\/]+\\[^\\/]+/.test(s) || /^[A-Za-z]:[\\/]/.test(s) || (process.platform !== 'win32' && path.isAbsolute(s));
}
// Pure: turns latest.json into update info, or null when not newer / unusable. Every file must sit in
// v<version>/ under the source, carry its size and SHA-256, and use the release file name.
function pickUpdate(manifest, currentVersion, source) {
  if (!manifest || typeof manifest !== 'object' || !validSource(source)) return null;
  const version = String(manifest.version || '').replace(/^v/i, '');
  if (!/^\d+\.\d+\.\d+$/.test(version) || compareVersions(version, currentVersion) <= 0) return null;
  const files = (Array.isArray(manifest.files) ? manifest.files : []).map(f => {
    const parts = String(f?.path || '').split(/[\\/]/);
    if (parts.length !== 2 || parts[0] !== 'v' + version || !FILE_NAME.test(parts[1])) return null;
    const sha256 = /^[0-9a-f]{64}$/i.test(String(f.sha256 || '')) ? String(f.sha256).toLowerCase() : null;
    const size = Number(f.size);
    if (!sha256 || !Number.isSafeInteger(size) || size <= 0) return null;
    return { format: /\.7z$/i.test(parts[1]) ? '7z' : 'zip', path: path.join(source, parts[0], parts[1]), size, sha256 };
  }).filter(Boolean).sort((a, b) => (a.format === '7z' ? 0 : 1) - (b.format === '7z' ? 0 : 1));
  if (!files.length) return null;
  // path/size/sha256 describe the preferred file; files lists every usable one in the order to try.
  return { version, notes: String(manifest.notes || '').trim(), ...files[0], files };
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); })]).finally(() => clearTimeout(timer));
}

async function readManifest(source, { readFile = fsp.readFile, timeout = READ_TIMEOUT } = {}) {
  if (!validSource(source)) return null;
  const text = await withTimeout(readFile(path.join(source, MANIFEST), 'utf8'), timeout, '업데이트 폴더에 연결하지 못했습니다.');
  return JSON.parse(String(text).replace(/^\ufeff/, ''));
}

// Copies the archive from the share into the temp folder while hashing it, so the file that is checked is the one extracted.
async function download(info, target, onProgress, { stallTimeout = STALL_TIMEOUT } = {}) {
  const input = fs.createReadStream(info.path, { highWaterMark: 1 << 20 });
  const total = info.size || 0;
  const hash = crypto.createHash('sha256'); const out = fs.createWriteStream(target);
  let loaded = 0, timer = null, stalled = false;
  const arm = () => { clearTimeout(timer); timer = setTimeout(() => { stalled = true; input.destroy(new Error('업데이트 폴더에서 파일을 읽는 중 응답이 없습니다.')); }, stallTimeout); };
  try {
    arm();
    for await (const chunk of input) {
      arm();
      hash.update(chunk); loaded += chunk.length;
      if (!out.write(chunk)) await new Promise(r => out.once('drain', r));
      onProgress?.(loaded, total);
    }
  } catch (e) {
    if (stalled) throw new Error('업데이트 폴더에서 파일을 읽는 중 응답이 없습니다.');
    throw new Error('업데이트 파일을 읽지 못했습니다: ' + (e?.code || e?.message || e));
  } finally { clearTimeout(timer); await new Promise(r => out.end(r)); }
  if (info.size && loaded !== info.size) throw new Error('복사한 파일 크기가 업데이트 정보와 다릅니다.');
  if (info.sha256 && hash.digest('hex') !== info.sha256) throw new Error('복사한 파일의 SHA-256 값이 업데이트 정보와 다릅니다.');
}

const powershell = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');

// Extracts while the app is still running so progress can be shown and failures reported in the UI.
// 7z goes through the tar that ships with Windows (libarchive; reads 7z on Windows 11 23H2 and later).
function extract(zip, dest, format = 'zip') {
  if (format === '7z') return new Promise((resolve, reject) => {
    fs.mkdirSync(dest, { recursive: true });
    execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', dest],
      { windowsHide: true, timeout: 300000 }, err => err ? reject(new Error('압축 해제 실패: ' + (err.message || err))) : resolve());
  });
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

// Release notes in their own dialog. Without notes, the update folder on the share opens instead.
const openSource = async (shell, source) => { try { await shell?.openPath(source); } catch {} };
async function showNotes({ dialog, shell, win, info, source }) {
  if (!info.notes) { await openSource(shell, source); return; }
  if (!win || win.isDestroyed()) return;
  const notes = info.notes.length > 3000 ? info.notes.slice(0, 3000) + '\n…' : info.notes;
  const { response } = await dialog.showMessageBox(win, {
    type: 'none', title: '업데이트 로그', buttons: ['돌아가기', '업데이트 폴더 열기'], defaultId: 0, cancelId: 0, noLink: true,
    message: `버전 ${info.version} 변경 사항`, detail: notes
  });
  if (response === 1) await openSource(shell, source);
}

// Called once after the main window has loaded. Never throws.
async function checkOnStartup({ app, dialog, shell, win, source, dataDir, onLog, platform = process.platform }) {
  const send = sender(win);
  let info = null;
  try {
    await reportPreviousResult({ win, dataDir, app });
    if (!app.isPackaged || platform !== 'win32' || !validSource(source)) return;
    const appDir = path.dirname(process.execPath);
    const skipFile = path.join(dataDir, 'update-skip.json');
    let manifest = null; try { manifest = await readManifest(source); } catch { return; } // off the company network or share unreachable: stay quiet
    info = pickUpdate(manifest, app.getVersion(), source);
    if (!info) return;
    let skipped = ''; try { skipped = JSON.parse(await fsp.readFile(skipFile, 'utf8')).version || ''; } catch {}
    if (skipped === info.version) return;
    if (!win || win.isDestroyed()) return;
    // "업데이트 로그 보기" shows this release's notes in a separate dialog, then asks again.
    let response = process.env.APLAYBOX_UPDATE_AUTOACCEPT === '1' ? 0 : 3;
    while (response === 3) {
      if (!win || win.isDestroyed()) return;
      response = (await dialog.showMessageBox(win, {
        type: 'info', title: '업데이트 확인', buttons: ['지금 업데이트', '나중에', '이 버전 건너뛰기', '업데이트 로그 보기'], defaultId: 0, cancelId: 1, noLink: true,
        message: `새 버전 ${info.version}이 있습니다. (현재 ${app.getVersion()})`,
        detail: '지금 업데이트하면 파일을 받은 뒤 앱을 다시 시작합니다. 로그인 정보·기록·북마크·설정이 있는 data 폴더는 그대로 유지됩니다.'
      })).response;
      if (response === 3) await showNotes({ dialog, shell, win, info, source });
    }
    if (response === 2) { await fsp.writeFile(skipFile, JSON.stringify({ version: info.version }), 'utf8'); return; }
    if (response !== 0) return;

    const temp = await fsp.mkdtemp(path.join(os.tmpdir(), 'aplaybox-update-'));
    // Try each file in turn (7z first); the next one is used only when this one fails.
    let src = '';
    for (const [i, file] of info.files.entries()) {
      const zip = path.join(temp, 'AplayboxDownloader-Windows-x64.' + file.format), dest = path.join(temp, 'extract-' + file.format);
      try {
        send({ phase: 'download', version: info.version, loaded: 0, total: file.size }, true);
        try {
          await download(file, zip, (loaded, total) => { send({ phase: 'download', version: info.version, loaded, total }); if (!win.isDestroyed() && total) win.setProgressBar(loaded / total); });
        } finally { if (!win.isDestroyed()) win.setProgressBar(-1); }
        send({ phase: 'extract', version: info.version }, true);
        await extract(zip, dest, file.format);
        if (!fs.existsSync(path.join(dest, 'AplayboxDownloader', 'AplayboxDownloader.exe'))) throw new Error('받은 파일 안에 AplayboxDownloader.exe가 없습니다.');
        src = path.join(dest, 'AplayboxDownloader');
        await fsp.unlink(zip).catch(() => {});
        break;
      } catch (e) {
        await fsp.unlink(zip).catch(() => {}); await fsp.rm(dest, { recursive: true, force: true }).catch(() => {});
        if (i === info.files.length - 1) throw e;
        onLog?.(`업데이트 파일(${file.format})을 쓰지 못해 다른 형식으로 다시 받습니다: ${e?.message || e}`);
      }
    }
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

module.exports = { parseVersion, compareVersions, validSource, pickUpdate, readManifest, download, extract, checkOnStartup };
