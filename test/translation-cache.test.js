'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Translator } = require('../src/translation');

test('saved translations are reused without a network request and new ones notify for saving', async () => {
  let calls = 0, changes = 0;
  const t = new Translator(async () => { calls++; return { ok: true, json: async () => [[['새 번역', '新']]] }; });
  t.load({ '原神模型': '원신 모델', 'ascii': 'x', '空': '' });
  t.setEnabled(true);
  t.onChange = () => changes++;
  assert.equal(t.peek('原神模型'), '원신 모델');
  assert.equal(t.peek('ascii'), undefined);
  assert.equal(await t.translate('原神模型'), '원신 모델');
  assert.equal(calls, 0);
  assert.equal(await t.translate('新的'), '새 번역');
  assert.equal(calls, 1);
  assert.equal(changes, 1);
  assert.deepEqual(t.entries(), { version: 2, buckets: { legacy: { '原神模型': '원신 모델' }, google: { '新的': '새 번역' } } });
  t.setEnabled(false);
  assert.equal(t.peek('原神模型'), undefined);
});

test('translations are saved per engine/model and reused or refreshed by choice', async () => {
  let calls = 0;
  const t = new Translator(async () => { calls++; return { ok: true, json: async () => [[['구글 번역', '中']]] }; }, { claude: { MODELS: ['haiku', 'sonnet'], find: () => 'claude.exe', friendly: m => m, translateBatch: async (_e, texts, { model }) => texts.map(() => model + ' 번역') } });
  t.load({ version: 2, buckets: { google: { '中文标题': '구글 번역' }, 'claude:haiku': { '另一个': 'haiku 번역' }, bad: { '中': 'x' } } });
  t.setEnabled(true);
  assert.deepEqual(Object.keys(t.entries().buckets).sort(), ['claude:haiku', 'google']);
  t.configure({ engine: 'claude', model: 'sonnet', fresh: false });
  assert.equal(await t.translate('中文标题'), '구글 번역');
  t.configure({ fresh: true });
  assert.equal(t.peek('中文标题'), undefined);
  assert.equal(await t.translate('中文标题'), 'sonnet 번역');
  assert.equal(t.entries().buckets['claude:sonnet']['中文标题'], 'sonnet 번역');
  t.configure({ engine: 'google' });
  assert.equal(t.peek('中文标题'), '구글 번역');
  t.configure({ engine: 'claude', model: 'haiku', fresh: true });
  assert.equal(t.peek('另一个'), 'haiku 번역');
  assert.deepEqual(t.view(), { '另一个': 'haiku 번역' });
  assert.equal(calls, 0);
});

test('built-in translations are used last, are not saved or cleared, and are skipped when translating afresh', async () => {
  let calls = 0;
  const t = new Translator(async () => { calls++; return { ok: true, json: async () => [[['구글 번역', '中']]] }; });
  t.loadBuiltin({ '内置': '내장 번역', '两者': '내장 쪽', 'english only': 'x', '空': '' });
  t.load({ version: 2, buckets: { google: { '两者': '저장된 쪽' } } });
  t.setEnabled(true);
  assert.equal(await t.translate('内置'), '내장 번역');
  assert.equal(await t.translate('两者'), '저장된 쪽', 'a saved translation wins over the built-in one');
  assert.equal(calls, 0);
  assert.equal(t.cached('内置'), '내장 번역');
  assert.equal(t.view()['内置'], '내장 번역'); assert.equal(t.view()['两者'], '저장된 쪽');
  assert.equal(t.status().builtin, 2); assert.equal(t.status().cached, 1);
  assert.deepEqual(t.entries().buckets, { google: { '两者': '저장된 쪽' } }, 'built-in entries are not written to the saved file');
  t.clear();
  assert.equal(await t.translate('内置'), '내장 번역', 'clearing saved translations keeps the built-in ones');
  t.configure({ fresh: true });
  assert.equal(t.view()['内置'], undefined);
  assert.equal(await t.translate('内置'), '구글 번역', 'translating afresh ignores the built-in result');
  assert.equal(calls, 1);
});

test('shipped built-in data is well formed', () => {
  const lists = require('../src/builtin/author-lists.json'), tr = require('../src/builtin/translations.json'), defaults = require('../src/default-authors');
  for (const a of defaults) {
    const e = lists[a.id]; assert.ok(e && e.works.length > 0, 'list for ' + a.name);
    for (const w of e.works) { assert.match(w.id, /^[A-Za-z0-9_-]{4,64}$/); assert.equal(w.type, 1); assert.deepEqual(Object.keys(w).sort(), ['author', 'authorId', 'cover', 'date', 'id', 'title', 'type']); assert.ok(!w.cover || /^https:\/\/[a-z0-9.-]+\.aplaybox\.com\//.test(w.cover)); }
  }
  assert.ok(Object.keys(tr.entries).length > 0);
  for (const [k, v] of Object.entries(tr.entries)) { assert.equal(typeof v, 'string'); assert.ok(v && v !== k); }
});
