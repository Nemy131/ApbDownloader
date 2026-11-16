'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const MB = require('../src/maxbridge');

test('parseInstances keeps fresh or busy heartbeats of running Max processes only', () => {
  const now = 100000;
  const live = MB.parseInstances([
    { text: '10\t2020\tready\tscene A.max', mtimeMs: now - 1000 },
    { text: '\ufeff20\t2022\tbusy\t', mtimeMs: now - 60000 },
    { text: '30\t2020\tready\told.max', mtimeMs: now - 60000 },
    { text: '40\t2020\tready\tdead.max', mtimeMs: now },
    { text: 'garbage', mtimeMs: now }
  ], [10, 20, 30], now);
  assert.deepEqual(live.map(i => [i.pid, i.year, i.busy, i.scene]), [[10, 2020, false, 'scene A.max'], [20, 2022, true, '']]);
  assert.match(MB.label(live[0]), /3ds Max 2020 · scene A\.max \(PID 10\)/);
  assert.match(MB.label(live[1]), /제목 없음 · 임포트 중/);
});

test('updateIni replaces and adds keys inside [ImportMMD] without touching other sections', () => {
  const src = '[Other]\r\nBlenderPath=keep\r\n[ImportMMD]\r\nBlenderMode=1\r\nScaleCm=8.0\r\n[Tail]\r\nX=1\r\n';
  const out = MB.updateIni(src, { BlenderMode: '2', BlenderPath: 'C:\블렌더\blender.exe' });
  assert.deepEqual(MB.parseIni(out), { BlenderMode: '2', ScaleCm: '8.0', BlenderPath: 'C:\블렌더\blender.exe' });
  assert.equal(MB.parseIni(out, 'Other').BlenderPath, 'keep');
  assert.equal(MB.parseIni(out, 'Tail').X, '1');
  assert.deepEqual(MB.parseIni(MB.updateIni('', { BandizipMode: '1' })), { BandizipMode: '1' });
});

test('startupDirs lists language folders of 64-bit Max user folders', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apb-max-'));
  try {
    for (const d of ['2020 - 64bit/ENU', '2022 - 64bit/KOR', '2022 - 64bit/cache', '2020/ENU', '2016 - 64bit/ENU']) fs.mkdirSync(path.join(root, d), { recursive: true });
    const dirs = MB.startupDirs(root).map(d => [d.year, path.relative(root, d.dir)]).sort();
    assert.deepEqual(dirs, [[2020, path.join('2020 - 64bit', 'ENU', 'scripts', 'startup')], [2022, path.join('2022 - 64bit', 'KOR', 'scripts', 'startup')]]);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('importableFiles collects existing model archives from history, files and folder scan', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apb-files-'));
  try {
    const f = n => { const p = path.join(dir, n); fs.writeFileSync(p, 'x'); return p; };
    const a = f('a.zip'), b = f('b.pmx'), c = f('c.7z'), motion = f('m.vmd');
    const work = { type: 1, id: 'w1', files: [{ path: b }], existingPath: null };
    const history = { '1:w1:f1': { path: a }, '1:w1:f2': { path: motion }, '1:w1:f3': { path: path.join(dir, 'missing.zip') }, '1:other:f1': { path: c } };
    const got = MB.importableFiles(work, history, { existing: null, files: [{ existing: c }, { existing: a }] });
    assert.deepEqual(got.map(p => path.basename(p)).sort(), ['a.zip', 'b.pmx', 'c.7z']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('reinstall finds ImportMMD files in Max user/install folders, removes them and installs the bridge again', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apb-reinst-'));
  const lang = path.join(root, 'user', '2020 - 64bit', 'ENU');
  const w = (p, t = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, t); return p; };
  const want = [
    w(path.join(lang, 'scripts', 'startup', 'ApbMaxBridge.ms'), 'old'),
    w(path.join(lang, 'scripts', 'MMD', 'ImportMMD.ms')),
    w(path.join(lang, 'scripts', 'MMD', 'pmx_to_fbx.py')),
    w(path.join(lang, 'usermacros', 'Tools-RunMMD.mcr'), 'macroScript RunMMD ( fileIn "C:/x/ImportMMD.ms" )'),
    w(path.join(lang, 'temp', 'ImportMMD_probe.txt')),
    w(path.join(root, 'install', 'scripts', 'Startup', 'importmmd_loader.ms'))
  ];
  const keep = [
    w(path.join(lang, 'scripts', 'other.ms'), 'print 1'),
    w(path.join(lang, 'scripts', 'deep', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'ImportMMD.ms')),
    w(path.join(lang, 'temp', 'sub', 'ImportMMD_probe.txt'))
  ];
  const found = MB.relatedFiles({ userRoot: path.join(root, 'user'), installDirs: [path.join(root, 'install')] });
  assert.deepEqual(found.map(f => f.toLowerCase()).sort(), want.map(f => f.toLowerCase()).sort());
  const r = MB.reinstall(found, MB.startupDirs(path.join(root, 'user')));
  assert.equal(r.removed.length, want.length);
  assert.deepEqual(r.failed, []);
  assert.equal(r.installed.length, 1);
  assert.ok(fs.readFileSync(path.join(lang, 'scripts', 'startup', 'ApbMaxBridge.ms')).equals(fs.readFileSync(MB.BRIDGE_SCRIPT)));
  for (const f of want.slice(1)) assert.equal(fs.existsSync(f), false);
  for (const f of keep) assert.equal(fs.existsSync(f), true);
  fs.rmSync(root, { recursive: true, force: true });
});

test('elevated removal script deletes only the listed files and reports each result', async () => {
  const { execFile } = require('node:child_process');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apb-elev-test-'));
  const a = path.join(dir, '한글 폴더', 'ImportMMD.ms'), b = path.join(dir, "it's", 'pmx_to_fbx.py'), keep = path.join(dir, 'keep.ms'), gone = path.join(dir, 'missing.ms');
  for (const f of [a, b, keep]) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, 'x'); }
  const plain = (script, list, result) => new Promise(r => execFile('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-List', list, '-Result', result], { windowsHide: true }, e => r(e ? 1 : 0)));
  const r = await MB.elevatedRemove([a, b, gone], { runner: plain });
  assert.deepEqual(r.removed.sort(), [a, b, gone].sort());
  assert.deepEqual(r.failed, []);
  assert.equal(fs.existsSync(a) || fs.existsSync(b), false);
  assert.equal(fs.existsSync(keep), true);
  const c = await MB.elevatedRemove([keep], { runner: async () => 1223 });
  assert.equal(c.canceled, true);
  assert.equal(fs.existsSync(keep), true);
  fs.rmSync(dir, { recursive: true, force: true });
});
