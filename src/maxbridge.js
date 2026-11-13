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

module.exports = { IMPORTER, BRIDGE_SCRIPT, bridgeDir, startupDirs, installState, install, uninstall, maxProcesses, parseInstances, instances, label, findMaxExes, writeRequest, waitTaken, launch, importableFiles, parseIni, updateIni, readIni, writeIni, configView };
