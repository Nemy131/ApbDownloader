'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { compareVersions, pickUpdate, fetchLatest } = require('../src/updater');

const asset = { name: 'AplayboxDownloader-Windows-x64.zip', size: 10, browser_download_url: 'https://github.com/o/r/releases/download/v1.2.0/AplayboxDownloader-Windows-x64.zip', digest: 'sha256:' + 'a'.repeat(64) };

test('compareVersions orders semantic versions and tolerates a v prefix', () => {
  assert.equal(compareVersions('1.2.0', '1.1.9'), 1);
  assert.equal(compareVersions('v1.10.0', '1.9.0'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('0.9.9', '1.0.0'), -1);
  assert.equal(compareVersions('bad', '1.0.0'), 0);
});

test('pickUpdate returns info only for a newer, published release with the Windows ZIP', () => {
  const info = pickUpdate({ tag_name: 'v1.2.0', body: 'notes', assets: [asset] }, '1.1.0');
  assert.equal(info.version, '1.2.0');
  assert.equal(info.url, asset.browser_download_url);
  assert.equal(info.sha256, 'a'.repeat(64));
  assert.equal(pickUpdate({ tag_name: 'v1.1.0', assets: [asset] }, '1.1.0'), null);
  assert.equal(pickUpdate({ tag_name: 'v1.2.0', prerelease: true, assets: [asset] }, '1.1.0'), null);
  assert.equal(pickUpdate({ tag_name: 'v1.2.0', draft: true, assets: [asset] }, '1.1.0'), null);
  assert.equal(pickUpdate({ tag_name: 'v1.2.0', assets: [{ ...asset, name: 'other.zip' }] }, '1.1.0'), null);
  assert.equal(pickUpdate({ tag_name: 'v1.2.0', assets: [{ ...asset, browser_download_url: 'https://evil.example/x.zip' }] }, '1.1.0'), null);
  assert.equal(pickUpdate(null, '1.1.0'), null);
});

test('fetchLatest rejects malformed repo names without a request', async () => {
  let called = false;
  assert.equal(await fetchLatest('bad name', async () => { called = true; }), null);
  assert.equal(called, false);
  const json = await fetchLatest('o/r', async url => { assert.equal(url, 'https://api.github.com/repos/o/r/releases/latest'); return { ok: true, json: async () => ({ tag_name: 'v2.0.0' }) }; });
  assert.equal(json.tag_name, 'v2.0.0');
});

test('update prompt omits release notes; "업데이트 로그 보기" shows them in a separate dialog', async () => {
  const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
  const { checkOnStartup } = require('../src/updater');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'apb-upd-test-'));
  const realFetch = global.fetch;
  global.fetch = async () => ({ ok: true, json: async () => ({ tag_name: 'v9.0.0', body: '- 새 기능 설명', assets: [asset] }) });
  const shown = [], opened = [], answers = [3, 0, 3, 1, 1];
  try {
    await checkOnStartup({
      app: { isPackaged: true, getVersion: () => '1.0.0', quit() {} },
      dialog: { showMessageBox: async (_w, o) => { shown.push(o); return { response: answers.shift() }; } },
      shell: { openExternal: async u => { opened.push(u); } },
      win: { isDestroyed: () => false, webContents: { send() {} }, setProgressBar() {} },
      repo: 'o/r', dataDir
    });
  } finally { global.fetch = realFetch; fs.rmSync(dataDir, { recursive: true, force: true }); }
  assert.equal(shown.length, 5);
  assert.equal(shown[0].title, '업데이트 확인');
  assert.doesNotMatch(shown[0].detail, /새 기능 설명/);
  assert.equal(shown[1].title, '업데이트 로그');
  assert.match(shown[1].detail, /새 기능 설명/);
  assert.equal(shown[2].title, '업데이트 확인');
  assert.equal(shown[3].title, '업데이트 로그');
  assert.deepEqual(opened, ['https://github.com/o/r/releases']);
  assert.equal(shown[4].title, '업데이트 확인');
});
