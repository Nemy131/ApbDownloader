'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const MB = require('../src/maxbridge');

test('parseResult reads the line ImportMMD.ms writes and rejects anything else', () => {
  assert.deepEqual(MB.parseResult('ok\tC:\\dl\\a.zip\tC:\\dl\\a\\a.pmx\t임포트 완료'), { ok: true, source: 'C:\\dl\\a.zip', pmx: 'C:\\dl\\a\\a.pmx', message: '임포트 완료' });
  assert.deepEqual(MB.parseResult('\ufefffail\tC:\\dl\\b.zip\t\t압축 파일 안에 .pmx 가 없음\r\n'), { ok: false, source: 'C:\\dl\\b.zip', pmx: '', message: '압축 파일 안에 .pmx 가 없음' });
  assert.equal(MB.parseResult('done\tC:\\dl\\a.zip'), null);
  assert.equal(MB.parseResult('ok'), null);
  assert.equal(MB.parseResult(''), null);
});

test('takeResults returns the result files oldest first and removes them', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'apb-results-'));
  try {
    fs.writeFileSync(path.join(dir, '20261113000002-1.txt'), 'fail\tC:\\dl\\b.zip\t\t실패');
    fs.writeFileSync(path.join(dir, '20261113000001-1.txt'), 'ok\tC:\\dl\\a.zip\t\t');
    fs.writeFileSync(path.join(dir, 'note.log'), 'ignored');
    const results = await MB.takeResults(dir);
    assert.deepEqual(results.map(r => [r.ok, r.source]), [[true, 'C:\\dl\\a.zip'], [false, 'C:\\dl\\b.zip']]);
    assert.deepEqual(fs.readdirSync(dir), ['note.log']);
    assert.deepEqual(await MB.takeResults(path.join(dir, 'missing')), []);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('applyResults marks posts done or failed by the file that was sent', () => {
  const pending = new Map([[path.resolve('C:\\dl\\a.zip').toLowerCase(), 'A'], [path.resolve('C:\\dl\\b.zip').toLowerCase(), 'B']]);
  pending.batch = 1;
  const imports = { A: { state: 'sent', batch: 1 }, B: { state: 'sent', batch: 1 }, C: { state: 'done', batch: 0 } };
  const changed = MB.applyResults(imports, pending, [
    { ok: true, source: 'C:\\DL\\A.zip', pmx: '', message: '' },
    { ok: false, source: 'C:\\dl\\b.zip', pmx: '', message: 'Blender 변환 실패' },
    { ok: true, source: 'C:\\dl\\unknown.zip', pmx: '', message: '' }
  ], 'T');
  assert.equal(changed, true);
  assert.deepEqual(imports.A, { state: 'done', time: 'T', message: '', batch: 1 });
  assert.deepEqual(imports.B, { state: 'failed', time: 'T', message: 'Blender 변환 실패', batch: 1 });
  assert.equal(imports.C.state, 'done');
});

test('applyResults: one imported model of an archive is enough, and a retry can turn a failure into done', () => {
  const pending = new Map([[path.resolve('C:\\dl\\multi.zip').toLowerCase(), 'M']]);
  pending.batch = 5;
  const imports = { M: { state: 'sent', batch: 5 } };
  MB.applyResults(imports, pending, [{ ok: true, source: 'C:\\dl\\multi.zip', pmx: 'one.pmx', message: '' }, { ok: false, source: 'C:\\dl\\multi.zip', pmx: 'two.pmx', message: '실패' }], 'T1');
  assert.equal(imports.M.state, 'done');
  imports.M = { state: 'failed', time: 'T0', message: '이전 실패', batch: 4 };
  MB.applyResults(imports, pending, [{ ok: true, source: 'C:\\dl\\multi.zip', pmx: '', message: '' }], 'T2');
  assert.deepEqual(imports.M, { state: 'done', time: 'T2', message: '', batch: 5 });
});

test('applyResults: a failure that is not about one file ends every waiting post', () => {
  const pending = new Map([[path.resolve('C:\\dl\\a.zip').toLowerCase(), 'A']]);
  pending.batch = 2;
  const imports = { A: { state: 'sent', batch: 2 }, B: { state: 'sent', batch: 2 }, C: { state: 'done', batch: 1 } };
  assert.equal(MB.applyResults(imports, pending, [{ ok: false, source: '(Blender)', pmx: '', message: 'Blender 를 찾지 못함' }], 'T'), true);
  assert.equal(imports.A.state, 'failed');
  assert.equal(imports.B.state, 'failed');
  assert.equal(imports.B.message, 'Blender 를 찾지 못함');
  assert.equal(imports.C.state, 'done');
});

test('importOptions reads ImportMMD.ini values and falls back to the importer defaults', () => {
  assert.deepEqual(MB.importOptions({}), { keepMorphs: true, restoreNames: true, splitMode: 1, matType: 1, alphaMode: 1, scaleCm: 8, spacing: 30, codePage: 1, forceExtract: false, multiPmx: 1, parallelBlender: 3, reuseFbx: true });
  const o = MB.importOptions({ KeepMorphs: 'false', RestoreNames: 'true', SplitMode: '2', MaterialType: '2', AlphaMode: '3', ScaleCm: '10.5', Spacing: '0.0', CodePage: '5', ForceExtract: 'true', MultiPmx: '2' });
  assert.deepEqual(o, { keepMorphs: false, restoreNames: true, splitMode: 2, matType: 2, alphaMode: 3, scaleCm: 10.5, spacing: 0, codePage: 5, forceExtract: true, multiPmx: 2, parallelBlender: 3, reuseFbx: true });
  assert.equal(MB.importOptions({ ParallelBlender: '6', ReuseFbx: 'false' }).parallelBlender, 6);
  assert.equal(MB.importOptions({ ParallelBlender: '6', ReuseFbx: 'false' }).reuseFbx, false);
  assert.equal(MB.importOptions({ ParallelBlender: '99' }).parallelBlender, 3);
  assert.equal(MB.importOptions({ SplitMode: '9', ScaleCm: 'abc', CodePage: '0' }).splitMode, 1);
  assert.equal(MB.importOptions({ ScaleCm: '-1' }).scaleCm, 8);
  assert.equal(MB.importOptions({ UseAlpha: 'false' }).alphaMode, 3);
  assert.equal(MB.importOptions({ UseAlpha: 'false', AlphaMode: '2' }).alphaMode, 2);
});

test('optionsToIni writes the values ImportMMD.ms expects and rejects invalid ones', () => {
  assert.deepEqual(MB.optionsToIni({ keepMorphs: false, restoreNames: true, splitMode: 2, matType: 1, alphaMode: 3, scaleCm: 8, spacing: 12.5, codePage: 4, forceExtract: true, multiPmx: 2, other: 1 }),
    { KeepMorphs: 'false', RestoreNames: 'true', SplitMode: '2', MaterialType: '1', AlphaMode: '3', ScaleCm: '8.0', Spacing: '12.5', CodePage: '4', ForceExtract: 'true', MultiPmx: '2' });
  assert.deepEqual(MB.optionsToIni({ scaleCm: 1 }), { ScaleCm: '1.0' });
  assert.throws(() => MB.optionsToIni({ splitMode: 3 }));
  assert.deepEqual(MB.optionsToIni({ parallelBlender: 8, reuseFbx: false }), { ParallelBlender: '8', ReuseFbx: 'false' });
  assert.throws(() => MB.optionsToIni({ parallelBlender: 9 }));
  assert.throws(() => MB.optionsToIni({ parallelBlender: 2.5 }));
  assert.throws(() => MB.optionsToIni({ scaleCm: 0 }));
  assert.throws(() => MB.optionsToIni({ scaleCm: '8' }));
  assert.throws(() => MB.optionsToIni({ keepMorphs: 'true' }));
  // a round trip through the INI text keeps the options
  const text = MB.updateIni('', MB.optionsToIni({ scaleCm: 2.5, alphaMode: 2, forceExtract: true }));
  const back = MB.importOptions(MB.parseIni(text));
  assert.equal(back.scaleCm, 2.5); assert.equal(back.alphaMode, 2); assert.equal(back.forceExtract, true);
});
