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
