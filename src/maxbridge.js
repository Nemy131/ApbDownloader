'use strict';
// Hands downloaded MMD models to 3ds Max through the bundled ImportMMD importer.
// Each running Max loads ApbMaxBridge.ms from its user startup folder; that script writes a heartbeat file
// (instances/<pid>.txt) and picks up request files (requests/<pid>-*.txt). Nothing here touches Max's UI directly.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { execFile, spawn } = require('node:child_process');

const MAX_DIR = path.join(__dirname, 'max');
const IMPORTER = path.join(MAX_DIR, 'ImportMMD.ms');
const BRIDGE_SCRIPT = path.join(MAX_DIR, 'ApbMaxBridge.ms');
const IMPORTABLE = /\.(pmx|zip|rar|7z)$/i;
const FRESH_MS = 6000;

const localAppData = () => process.env.LOCALAPPDATA || path.join(require('node:os').homedir(), 'AppData', 'Local');
const bridgeDir = () => path.join(localAppData(), 'ApbDownloader', 'max-bridge');

// %LOCALAPPDATA%\Autodesk\3dsMax\<year> - 64bit\<language>\scripts\startup, for every language folder that exists.
function startupDirs(root = path.join(localAppData(), 'Autodesk', '3dsMax')) {
  const out = [];
  let versions = [];
  try { versions = fs.readdirSync(root, { withFileTypes: true }); } catch { return out; }
  for (const v of versions) {
    const m = /^(\d{4}) - 64bit$/.exec(v.name);
    if (!v.isDirectory() || !m || Number(m[1]) < 2017) continue;
    let langs = [];
    try { langs = fs.readdirSync(path.join(root, v.name), { withFileTypes: true }); } catch { continue; }
    for (const l of langs) if (l.isDirectory() && /^[A-Z]{3}$/.test(l.name)) out.push({ year: Number(m[1]), dir: path.join(root, v.name, l.name, 'scripts', 'startup') });
  }
  return out;
}

function installState(dirs = startupDirs()) {
  const want = fs.readFileSync(BRIDGE_SCRIPT);
  return dirs.map(d => {
    const file = path.join(d.dir, 'ApbMaxBridge.ms');
    let have = null; try { have = fs.readFileSync(file); } catch {}
    return { ...d, file, installed: !!have, current: !!have && have.equals(want) };
  });
}

// Copies (or refreshes) the startup script. Returns the files written.
function install(dirs = startupDirs()) {
  const written = [];
  for (const s of installState(dirs)) {
    if (s.current) continue;
    fs.mkdirSync(s.dir, { recursive: true });
    fs.copyFileSync(BRIDGE_SCRIPT, s.file);
    written.push(s.file);
  }
  return written;
}

function maxProcesses() {
  return new Promise(resolve => {
    execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tasklist.exe'), ['/FI', 'IMAGENAME eq 3dsmax.exe', '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 15000 }, (err, out) => {
      if (err) return resolve([]);
      resolve(String(out).split(/\r?\n/).map(l => /^"3dsmax\.exe","(\d+)"/i.exec(l)?.[1]).filter(Boolean).map(Number));
    });
  });
}

// Pure: heartbeat lines -> live Max instances. lines: [{text, mtimeMs}], pids: running 3dsmax.exe PIDs.
function parseInstances(entries, pids, now = Date.now()) {
  const alive = new Set(pids);
  const out = [];
  for (const e of entries) {
    const [pid, year, state, ...scene] = String(e.text || '').replace(/^\ufeff/, '').split('\t');
    const n = Number(pid);
    if (!Number.isSafeInteger(n) || !alive.has(n)) continue;
    const busy = state === 'busy';
    if (!busy && now - e.mtimeMs > FRESH_MS) continue;
    out.push({ pid: n, year: Number(year) || 0, busy, scene: scene.join('\t').trim() });
  }
  return out.sort((a, b) => a.pid - b.pid);
}

async function instances() {
  const dir = path.join(bridgeDir(), 'instances');
  const pids = await maxProcesses();
  const entries = [];
  let names = [];
  try { names = await fsp.readdir(dir); } catch {}
  for (const name of names.filter(n => /^\d+\.txt$/.test(n))) {
    const file = path.join(dir, name);
    try {
      const [text, stat] = await Promise.all([fsp.readFile(file, 'utf8'), fsp.stat(file)]);
      if (!pids.includes(Number(name.slice(0, -4)))) { await fsp.unlink(file).catch(() => {}); continue; }
      entries.push({ text, mtimeMs: stat.mtimeMs });
    } catch {}
  }
  // Requests addressed to a Max that has exited would never be taken.
  try { for (const name of await fsp.readdir(path.join(bridgeDir(), 'requests'))) { const m = /^(\d+)-\d+\.txt$/.exec(name); if (m && !pids.includes(Number(m[1]))) await fsp.unlink(path.join(bridgeDir(), 'requests', name)).catch(() => {}); } } catch {}
  const live = parseInstances(entries, pids);
  return { live, unlinked: pids.filter(p => !live.some(i => i.pid === p)) };
}

const label = i => `3ds Max ${i.year || ''} · ${i.scene || '제목 없음'}${i.busy ? ' · 임포트 중' : ''} (PID ${i.pid})`.replace('Max  ·', 'Max ·');

// Installed 3ds Max executables, newest first: registry Installdir values, then Program Files.
function findMaxExes() {
  return new Promise(resolve => {
    const found = new Map();
    const add = (year, dir) => { const exe = path.join(dir, '3dsmax.exe'); if (year && fs.existsSync(exe) && !found.has(exe.toLowerCase())) found.set(exe.toLowerCase(), { year, exe }); };
    execFile(path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe'), ['query', 'HKLM\\SOFTWARE\\Autodesk\\3dsMax', '/s', '/v', 'Installdir'], { windowsHide: true, timeout: 15000 }, (err, out) => {
      let ver = 0;
      for (const line of String(out || '').split(/\r?\n/)) {
        const k = /\\3dsMax\\(\d+)\.\d+/i.exec(line); if (k) { ver = Number(k[1]); continue; }
        const v = /Installdir\s+REG_\w+\s+(.+)$/i.exec(line); if (v && ver) add(1998 + ver, v[1].trim());
      }
      const pf = process.env.ProgramFiles || 'C:\\Program Files';
      try { for (const d of fs.readdirSync(path.join(pf, 'Autodesk'))) { const m = /^3ds Max (\d{4})$/.exec(d); if (m) add(Number(m[1]), path.join(pf, 'Autodesk', d)); } } catch {}
      resolve([...found.values()].sort((a, b) => b.year - a.year));
    });
  });
}

async function writeRequest(pid, files) {
  const dir = path.join(bridgeDir(), 'requests');
  await fsp.mkdir(dir, { recursive: true });
  const file = path.join(dir, `${pid}-${Date.now()}.txt`);
  await fsp.writeFile(file + '.tmp', [IMPORTER, ...files].join('\r\n') + '\r\n', 'utf8');
  await fsp.rename(file + '.tmp', file);
  return file;
}

// Resolves true once Max has taken the request (file deleted), false on timeout.
async function waitTaken(file, ms) {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (!fs.existsSync(file)) return true;
    await new Promise(r => setTimeout(r, 300));
  }
  return !fs.existsSync(file);
}

// Import results written by ImportMMD.ms (one small file per imported source file): "ok|fail<TAB>source<TAB>pmx<TAB>message".
function parseResult(text) {
  const [state, source, pmx, ...message] = String(text || '').replace(/^\ufeff/, '').replace(/[\r\n]+$/, '').split('\t');
  if ((state !== 'ok' && state !== 'fail') || !source) return null;
  return { ok: state === 'ok', source, pmx: pmx || '', message: message.join(' ').replace(/\s+/g, ' ').trim().slice(0, 300) };
}
// Reads and removes the pending result files, oldest first.
async function takeResults(dir = path.join(bridgeDir(), 'results')) {
  let names = [];
  try { names = (await fsp.readdir(dir)).filter(n => /\.txt$/i.test(n)).sort(); } catch { return []; }
  const out = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try { const r = parseResult(await fsp.readFile(file, 'utf8')); await fsp.unlink(file); if (r) out.push(r); } catch {}
  }
  return out;
}
// Pure: folds results into the per-post import record. A post is done when any of its files imported;
// a later success replaces an earlier failure, a failure never replaces a success of the same request.
function applyResults(imports, pending, results, now = new Date().toISOString()) {
  let changed = false;
  for (const r of results) {
    const id = pending.get(path.resolve(r.source).toLowerCase());
    if (id == null) {
      // A failure that is not about one file (e.g. "(Blender)": no usable Blender) ends every waiting post of the request.
      if (!r.ok && /^\(.*\)$/.test(r.source)) for (const [k, v] of Object.entries(imports)) if (v?.state === 'sent') { imports[k] = { state: 'failed', time: now, message: r.message, batch: v.batch }; changed = true; }
      continue;
    }
    const old = imports[id];
    if (!r.ok && old?.state === 'done' && old.batch === pending.batch) continue;
    imports[id] = { state: r.ok ? 'done' : 'failed', time: now, message: r.ok ? '' : r.message, batch: pending.batch };
    changed = true;
  }
  return changed;
}

function launch(exe) {
  // -U MAXScript starts the bridge even when the startup folder copy is missing (a second start just restarts its timer).
  const child = spawn(exe, ['-U', 'MAXScript', BRIDGE_SCRIPT], { cwd: path.dirname(exe), detached: true, stdio: 'ignore' });
  child.unref();
  return child.pid;
}

// Local files of one work that the importer understands, from download history and the folder scan.
function importableFiles(work, history, presence) {
  const out = new Map();
  const add = p => { if (p && IMPORTABLE.test(p) && fs.existsSync(p)) out.set(path.resolve(p).toLowerCase(), path.resolve(p)); };
  const prefix = work.type + ':' + work.id + ':';
  for (const [key, rec] of Object.entries(history || {})) if (key.startsWith(prefix)) add(rec?.path);
  for (const f of work.files || []) add(f.path);
  add(work.existingPath);
  if (presence) { add(presence.existing); for (const f of presence.files || []) add(f.existing); }
  return [...out.values()];
}

function uninstall(dirs = startupDirs()) {
  const removed = [];
  for (const s of installState(dirs)) if (s.installed) { fs.unlinkSync(s.file); removed.push(s.file); }
  return removed;
}

// ImportMMD 재설치: 3ds Max 경로에 따로 설치된 ImportMMD 관련 파일(이전에 손으로 복사한 임포터, 매크로, 연동 스크립트)을
// 모두 지우고 앱에 내장된 연동 스크립트를 다시 설치한다. 임포터 본체는 항상 앱 폴더(src/max)의 것을 쓴다.
// 대상 폴더: 사용자 폴더 <버전>\<언어>\scripts·usermacros(하위 포함)·temp(바로 아래), 설치 폴더 scripts·MacroScripts·stdplugs\stdscripts.
// 판정: 파일 이름(ImportMMD*, pmx_to_fbx*.py, ApbMaxBridge.ms) 또는 내용에 "ImportMMD"가 들어 있는 .ms/.mse/.mcr.
// 사용자 설정(%LOCALAPPDATA%\ApbDownloader\max-bridge의 ImportMMD.ini·로그)은 지우지 않는다.
const RELATED_NAME = /^(importmmd[^\\/]*\.(ms|mse|mcr|ini|txt|py)|pmx_to_fbx[^\\/]*\.py|apbmaxbridge\.ms)$/i;
const SCRIPT_EXT = /\.(ms|mse|mcr)$/i;
function relatedFiles({ userRoot = path.join(localAppData(), 'Autodesk', '3dsMax'), installDirs = [] } = {}) {
  const roots = [];
  for (const s of startupDirs(userRoot)) {
    const lang = path.dirname(path.dirname(s.dir));
    roots.push([path.join(lang, 'scripts'), 6], [path.join(lang, 'usermacros'), 3], [path.join(lang, 'temp'), 0]);
  }
  for (const d of installDirs) roots.push([path.join(d, 'scripts'), 6], [path.join(d, 'MacroScripts'), 3], [path.join(d, 'stdplugs', 'stdscripts'), 3]);
  const out = new Map();
  const walk = (dir, depth) => {
    let items = []; try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const p = path.join(dir, it.name);
      if (it.isDirectory()) { if (depth > 0) walk(p, depth - 1); continue; }
      if (!it.isFile()) continue;
      let hit = RELATED_NAME.test(it.name);
      if (!hit && SCRIPT_EXT.test(it.name)) { try { const st = fs.statSync(p); if (st.size < 2 * 1024 * 1024) hit = /importmmd/i.test(fs.readFileSync(p, 'latin1')); } catch {} }
      if (hit) out.set(p.toLowerCase(), p);
    }
  };
  for (const [dir, depth] of roots) walk(dir, depth);
  return [...out.values()].sort();
}
// 지운 파일, 지우지 못한 파일(관리자 권한 필요 등), 새로 설치한 연동 스크립트를 돌려준다.
function reinstall(files, dirs = startupDirs()) {
  const removed = [], failed = [];
  for (const f of files) { try { fs.unlinkSync(f); removed.push(f); } catch (e) { if (e.code === 'ENOENT') removed.push(f); else failed.push({ file: f, perm: e.code === 'EPERM' || e.code === 'EACCES', error: e.code === 'EPERM' || e.code === 'EACCES' ? '권한 없음' : e.message }); } }
  return { removed, failed, installed: install(dirs) };
}

// 관리자 권한으로 파일 삭제(UAC 확인 창). 목록·스크립트·결과는 임시 폴더의 파일로 주고받는다(경로 인용 문제 방지).
// 삭제 대상은 호출하는 쪽이 relatedFiles()로 다시 찾은 목록만 넘긴다(렌더러가 경로를 지정하지 않음).
const REMOVE_PS1 = [
  'param([string]$List, [string]$Result)',
  '$out = foreach ($f in (Get-Content -LiteralPath $List -Encoding UTF8)) {',
  '  if (-not $f) { continue }',
  '  try { if (Test-Path -LiteralPath $f) { Remove-Item -LiteralPath $f -Force -ErrorAction Stop }; "OK`t$f" }',
  '  catch { "ERR`t$f`t$($_.Exception.Message)" }',
  '}',
  '[IO.File]::WriteAllLines($Result, [string[]]$out, (New-Object Text.UTF8Encoding $false))'
].join('\r\n');
const psExe = () => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
// runner(script, list, result) -> Promise<exitCode>. 기본은 Start-Process -Verb RunAs로 UAC를 띄워 관리자 PowerShell에서 실행. 1223 = 사용자가 취소.
function runElevated(script, list, result) {
  const q = s => "'" + String(s).replace(/'/g, "''") + "'";
  const inner = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', '"' + script + '"', '-List', '"' + list + '"', '-Result', '"' + result + '"'].map(q).join(',');
  const cmd = 'try { $p = Start-Process -FilePath ' + q(psExe()) + ' -Verb RunAs -WindowStyle Hidden -Wait -PassThru -ArgumentList ' + inner + '; exit $p.ExitCode } catch { exit 1223 }';
  return new Promise(resolve => execFile(psExe(), ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', cmd], { windowsHide: true, timeout: 10 * 60000 }, err => resolve(err ? (typeof err.code === 'number' ? err.code : 1) : 0)));
}
async function elevatedRemove(files, { runner = runElevated } = {}) {
  if (!files.length) return { removed: [], failed: [], canceled: false };
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'apb-elevate-'));
  const script = path.join(dir, 'remove.ps1'), list = path.join(dir, 'list.txt'), result = path.join(dir, 'result.txt');
  try {
    fs.writeFileSync(script, '\ufeff' + REMOVE_PS1, 'utf8');
    fs.writeFileSync(list, '\ufeff' + files.join('\r\n'), 'utf8');
    const code = await runner(script, list, result);
    let lines = []; try { lines = fs.readFileSync(result, 'utf8').replace(/^\ufeff/, '').split(/\r?\n/).filter(Boolean); } catch {}
    if (!lines.length) return { removed: [], failed: files.map(file => ({ file, error: code === 1223 ? '취소됨' : '실행 실패' })), canceled: code === 1223 };
    const removed = [], failed = [];
    for (const l of lines) { const [st, file, msg] = l.split('\t'); if (st === 'OK') removed.push(file); else failed.push({ file, error: msg || '삭제 실패' }); }
    return { removed, failed, canceled: false };
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
}

// ImportMMD.ini (in the bridge folder; ImportMMD.ms reads it through GetPrivateProfileString).
// Rewritten as UTF-16LE with BOM so non-ASCII paths survive regardless of the system code page.
const iniFile = () => path.join(bridgeDir(), 'ImportMMD.ini');
function decodeIni(buf) {
  if (buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le');
  if (buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf) return buf.subarray(3).toString('utf8');
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { return new TextDecoder('euc-kr').decode(buf); }
}
function parseIni(text, section = 'ImportMMD') {
  const v = {}; let sec = '';
  for (const line of String(text).split(/\r?\n/)) {
    const s = /^\s*\[(.+)\]\s*$/.exec(line); if (s) { sec = s[1]; continue; }
    const m = /^([^=;]+)=(.*)$/.exec(line); if (m && sec === section) v[m[1].trim()] = m[2];
  }
  return v;
}
// Pure: returns the INI text with the given keys of [section] replaced or added.
function updateIni(text, changes, section = 'ImportMMD') {
  const lines = String(text || '').split(/\r?\n/).filter((l, i, a) => l !== '' || i < a.length - 1);
  const left = new Map(Object.entries(changes));
  let sec = '', start = -1, end = lines.length;
  for (let i = 0; i < lines.length; i++) {
    const s = /^\s*\[(.+)\]\s*$/.exec(lines[i]);
    if (s) { if (sec === section) { end = i; break; } sec = s[1]; if (sec === section) start = i; continue; }
    const m = /^([^=;]+)=/.exec(lines[i]);
    if (sec === section && m && left.has(m[1].trim())) { lines[i] = m[1].trim() + '=' + left.get(m[1].trim()); left.delete(m[1].trim()); }
  }
  const add = [...left].map(([k, val]) => k + '=' + val);
  if (start < 0) lines.push('[' + section + ']', ...add); else lines.splice(end, 0, ...add);
  return lines.join('\r\n') + '\r\n';
}
function readIni() { try { return parseIni(decodeIni(fs.readFileSync(iniFile()))); } catch { return {}; } }
function writeIni(changes) {
  let text = ''; try { text = decodeIni(fs.readFileSync(iniFile())); } catch {}
  fs.mkdirSync(bridgeDir(), { recursive: true });
  fs.writeFileSync(iniFile(), Buffer.from('﻿' + updateIni(text, changes), 'utf16le'));
}

// Importer options of ImportMMD.ms that the downloader's import dialog can set (INI keys of [ImportMMD]).
const OPTION_DEFS = {
  keepMorphs: { key: 'KeepMorphs', type: 'bool', def: true },
  restoreNames: { key: 'RestoreNames', type: 'bool', def: true },
  splitMode: { key: 'SplitMode', type: 'choice', max: 2, def: 1 },
  matType: { key: 'MaterialType', type: 'choice', max: 2, def: 1 },
  alphaMode: { key: 'AlphaMode', type: 'choice', max: 3, def: 1 },
  scaleCm: { key: 'ScaleCm', type: 'number', min: 0.001, max: 10000, def: 8 },
  spacing: { key: 'Spacing', type: 'number', min: 0, max: 100000, def: 30 },
  codePage: { key: 'CodePage', type: 'choice', max: 5, def: 1 },
  forceExtract: { key: 'ForceExtract', type: 'bool', def: false },
  multiPmx: { key: 'MultiPmx', type: 'choice', max: 2, def: 1 },
  parallelBlender: { key: 'ParallelBlender', type: 'choice', max: 8, def: 3 },
  reuseFbx: { key: 'ReuseFbx', type: 'bool', def: true }
};
// Pure: INI values -> options object (missing or invalid values fall back to the importer's defaults).
function importOptions(ini = {}) {
  const out = {};
  for (const [name, d] of Object.entries(OPTION_DEFS)) {
    const raw = ini[d.key];
    if (d.type === 'bool') out[name] = raw == null || raw === '' ? d.def : String(raw).trim().toLowerCase() === 'true';
    else if (d.type === 'choice') { const n = Number(raw); out[name] = Number.isInteger(n) && n >= 1 && n <= d.max ? n : d.def; }
    else { const n = Number(raw); out[name] = raw != null && raw !== '' && Number.isFinite(n) && n >= d.min && n <= d.max ? n : d.def; }
  }
  // Settings saved before AlphaMode existed: UseAlpha=false meant "do not use".
  if ((ini.AlphaMode == null || ini.AlphaMode === '') && String(ini.UseAlpha || '').toLowerCase() === 'false') out.alphaMode = 3;
  return out;
}
// Pure: options object -> INI changes. Unknown names are ignored; an invalid value throws.
function optionsToIni(options = {}) {
  const changes = {};
  for (const [name, d] of Object.entries(OPTION_DEFS)) {
    if (!(name in options)) continue;
    const v = options[name];
    if (d.type === 'bool') { if (typeof v !== 'boolean') throw new Error('임포트 옵션 값이 올바르지 않습니다: ' + name); changes[d.key] = v ? 'true' : 'false'; }
    else if (d.type === 'choice') { if (!Number.isInteger(v) || v < 1 || v > d.max) throw new Error('임포트 옵션 값이 올바르지 않습니다: ' + name); changes[d.key] = String(v); }
    else { if (typeof v !== 'number' || !Number.isFinite(v) || v < d.min || v > d.max) throw new Error('임포트 옵션 값이 올바르지 않습니다: ' + name + ' (' + d.min + '~' + d.max + ')'); changes[d.key] = Number.isInteger(v) ? v.toFixed(1) : String(v); }
  }
  return changes;
}

// Everything the settings dialog shows.
async function configView(maxExe) {
  const detected = await findMaxExes();
  const custom = !!maxExe && fs.existsSync(maxExe);
  const ini = readIni();
  return {
    max: { path: custom ? maxExe : detected[0]?.exe || '', custom, detected },
    blender: { mode: Number(ini.BlenderMode) === 2 ? 2 : 1, path: ini.BlenderPath || '', verified: ini.BlenderVerified || '', info: ini.BlenderInfo || '' },
    bz: { mode: Number(ini.BandizipMode) === 2 ? 2 : 1, path: ini.BandizipPath || '' },
    bridge: installState().map(s => ({ year: s.year, lang: path.basename(path.dirname(path.dirname(s.dir))), dir: s.dir, installed: s.installed, current: s.current })),
    dataDir: bridgeDir()
  };
}

module.exports = { OPTION_DEFS, importOptions, optionsToIni, parseResult, takeResults, applyResults, IMPORTER, BRIDGE_SCRIPT, bridgeDir, startupDirs, installState, install, uninstall, maxProcesses, parseInstances, instances, label, findMaxExes, writeRequest, waitTaken, launch, importableFiles, relatedFiles, reinstall, elevatedRemove, REMOVE_PS1, parseIni, updateIni, readIni, writeIni, configView };
