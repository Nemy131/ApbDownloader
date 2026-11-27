'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { compareVersions, validSource, pickUpdate, readManifest, reachableFiles, download, checkOnStartup } = require('../src/updater');

const SHARE = '\\\\nas\\share\\apb';
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const file = (name, extra = {}) => ({ format: /7z$/.test(name) ? '7z' : 'zip', path: 'v1.2.0/' + name, size: 10, sha256: 'a'.repeat(64), ...extra });
const zip = file('AplayboxDownloader-Windows-x64.zip');
const seven = file('AplayboxDownloader-Windows-x64.7z', { size: 7, sha256: 'b'.repeat(64) });

test('compareVersions orders semantic versions and tolerates a v prefix', () => {
  assert.equal(compareVersions('1.2.0', '1.1.9'), 1);
  assert.equal(compareVersions('v1.10.0', '1.9.0'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('0.9.9', '1.0.0'), -1);
  assert.equal(compareVersions('bad', '1.0.0'), 0);
});

test('validSource accepts UNC and drive paths only', () => {
  assert.equal(validSource('\\\\10.10.0.252\\ShareFile\\모델링팀\\다운로더'), true);
  assert.equal(validSource('D:\\Updates'), true);
  assert.equal(validSource(''), false);
  assert.equal(validSource('relative\\folder'), false);
  assert.equal(validSource('https://example.com/x'), false);
});

test('pickUpdate returns info only for a newer version with checked files under v<version>', () => {
  const info = pickUpdate({ version: '1.2.0', notes: 'notes', files: [zip] }, '1.1.0', SHARE);
  assert.equal(info.version, '1.2.0');
  assert.equal(info.notes, 'notes');
  assert.equal(info.path, path.join(SHARE, 'v1.2.0', 'AplayboxDownloader-Windows-x64.zip'));
  assert.equal(info.sha256, 'a'.repeat(64));
  assert.equal(pickUpdate({ version: '1.1.0', files: [zip] }, '1.1.0', SHARE), null, 'same version');
  assert.equal(pickUpdate({ version: '1.2.0', files: [zip] }, '1.1.0', ''), null, 'no source');
  assert.equal(pickUpdate({ version: '1.2.0', files: [{ ...zip, path: 'v1.2.0/other.zip' }] }, '1.1.0', SHARE), null, 'unknown name');
  assert.equal(pickUpdate({ version: '1.2.0', files: [{ ...zip, path: '../evil/AplayboxDownloader-Windows-x64.zip' }] }, '1.1.0', SHARE), null, 'outside the share');
  assert.equal(pickUpdate({ version: '1.2.0', files: [{ ...zip, path: 'v1.1.0/AplayboxDownloader-Windows-x64.zip' }] }, '1.1.0', SHARE), null, 'other version folder');
  assert.equal(pickUpdate({ version: '1.2.0', files: [{ ...zip, path: 'C:\\x\\AplayboxDownloader-Windows-x64.zip' }] }, '1.1.0', SHARE), null, 'absolute path');
  assert.equal(pickUpdate({ version: '1.2.0', files: [{ ...zip, sha256: '' }] }, '1.1.0', SHARE), null, 'hash is required');
  assert.equal(pickUpdate({ version: '1.2.0', files: [{ ...zip, size: 0 }] }, '1.1.0', SHARE), null, 'size is required');
  assert.equal(pickUpdate(null, '1.1.0', SHARE), null);
});

test('pickUpdate prefers the 7z file and keeps the ZIP as the fallback', () => {
  const info = pickUpdate({ version: '1.2.0', files: [zip, seven] }, '1.1.0', SHARE);
  assert.deepEqual(info.files.map(f => f.format), ['7z', 'zip']);
  assert.equal(info.size, 7);
  assert.equal(info.files[1].sha256, 'a'.repeat(64));
  assert.deepEqual(pickUpdate({ version: '1.2.0', files: [seven, { ...zip, sha256: 'x' }] }, '1.1.0', SHARE).files.map(f => f.format), ['7z']);
});

test('readManifest reads latest.json (BOM tolerated) and gives up on a share that does not answer', async () => {
  const read = [];
  const json = await readManifest(SHARE, { readFile: async p => { read.push(p); return '\ufeff{"version":"2.0.0"}'; } });
  assert.equal(json.version, '2.0.0');
  assert.deepEqual(read, [path.join(SHARE, 'latest.json')]);
  assert.equal(await readManifest('relative', { readFile: async () => { throw new Error('must not read'); } }), null);
  await assert.rejects(readManifest(SHARE, { readFile: () => new Promise(() => {}), timeout: 50 }), /연결하지 못했습니다/);
});

test('download copies the archive and checks its size and SHA-256', async t => {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'apb-update-test-'));
  t.after(() => fsp.rm(dir, { recursive: true, force: true }));
  const src = path.join(dir, 'src.7z'); await fsp.writeFile(src, 'archive!');
  const progress = [];
  await download({ path: src, size: 8, sha256: sha('archive!') }, path.join(dir, 'a'), (l, total) => progress.push([l, total]));
  assert.equal(await fsp.readFile(path.join(dir, 'a'), 'utf8'), 'archive!');
  assert.deepEqual(progress.at(-1), [8, 8]);
  await assert.rejects(download({ path: src, size: 8, sha256: 'c'.repeat(64) }, path.join(dir, 'b')), /SHA-256/);
  await assert.rejects(download({ path: src, size: 9, sha256: sha('archive!') }, path.join(dir, 'c')), /크기/);
  await assert.rejects(download({ path: path.join(dir, 'missing.7z'), size: 1, sha256: 'a'.repeat(64) }, path.join(dir, 'd')), /읽지 못했습니다/);
});

test('update prompt omits release notes; "업데이트 로그 보기" shows them in a separate dialog', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apb-upd-test-'));
  const share = path.join(dataDir, 'share'); fs.mkdirSync(share);
  fs.mkdirSync(path.join(share, 'v9.0.0')); fs.writeFileSync(path.join(share, 'v9.0.0', 'AplayboxDownloader-Windows-x64.zip'), '0123456789');
  fs.writeFileSync(path.join(share, 'latest.json'), JSON.stringify({ version: '9.0.0', notes: '- 새 기능 설명', files: [{ ...zip, path: 'v9.0.0/AplayboxDownloader-Windows-x64.zip' }] }));
  const shown = [], opened = [], answers = [3, 0, 3, 1, 1];
  try {
    await checkOnStartup({
      app: { isPackaged: true, getVersion: () => '1.0.0', quit() {} },
      dialog: { showMessageBox: async (_w, o) => { shown.push(o); return { response: answers.shift() }; } },
      shell: { openPath: async p => { opened.push(p); return ''; } },
      win: { isDestroyed: () => false, webContents: { send() {} }, setProgressBar() {} },
      source: share, dataDir, platform: 'win32'
    });
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
  assert.equal(shown.length, 5);
  assert.equal(shown[0].title, '업데이트 확인');
  assert.doesNotMatch(shown[0].detail, /새 기능 설명/);
  assert.equal(shown[1].title, '업데이트 로그');
  assert.match(shown[1].detail, /새 기능 설명/);
  assert.equal(shown[2].title, '업데이트 확인');
  assert.equal(shown[3].title, '업데이트 로그');
  assert.deepEqual(opened, [share]);
  assert.equal(shown[4].title, '업데이트 확인');
});

test('no prompt when the share is unreachable', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apb-upd-test-'));
  let asked = false;
  try {
    await checkOnStartup({
      app: { isPackaged: true, getVersion: () => '1.0.0', quit() {} },
      dialog: { showMessageBox: async () => { asked = true; return { response: 1 }; } },
      win: { isDestroyed: () => false, webContents: { send() {} }, setProgressBar() {} },
      source: path.join(dataDir, 'missing'), dataDir, platform: 'win32'
    });
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
  assert.equal(asked, false);
});

test('no prompt when latest.json is there but the version folder or its files are missing', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apb-upd-test-'));
  const share = path.join(dataDir, 'share'); fs.mkdirSync(share);
  fs.writeFileSync(path.join(share, 'latest.json'), JSON.stringify({ version: '9.0.0', notes: 'x', files: [{ ...zip, path: 'v9.0.0/AplayboxDownloader-Windows-x64.zip' }] }));
  let asked = false;
  try {
    await checkOnStartup({
      app: { isPackaged: true, getVersion: () => '1.0.0', quit() {} },
      dialog: { showMessageBox: async () => { asked = true; return { response: 1 }; } },
      win: { isDestroyed: () => false, webContents: { send() {} }, setProgressBar() {} },
      source: share, dataDir, platform: 'win32'
    });
  } finally { fs.rmSync(dataDir, { recursive: true, force: true }); }
  assert.equal(asked, false);
});

test('reachableFiles drops missing or partly copied files and keeps the 7z-first order', async () => {
  const sizes = { a: 7, b: 3 };
  const stat = async p => { if (!(p in sizes)) throw new Error('ENOENT'); return { isFile: () => true, size: sizes[p] }; };
  const info = { version: '1.2.0', files: [{ format: '7z', path: 'a', size: 7 }, { format: 'zip', path: 'b', size: 10 }] };
  assert.deepEqual((await reachableFiles(info, { stat })).files.map(f => f.format), ['7z']);
  assert.equal(await reachableFiles({ ...info, files: [{ format: 'zip', path: 'missing', size: 1 }] }, { stat }), null);
  assert.equal(await reachableFiles(info, { stat: () => new Promise(() => {}), timeout: 30 }), null);
});
