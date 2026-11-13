'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { Translator, translatedFileName } = require('../src/translation');
const { Glossary } = require('../src/glossary');

test('archive names use only saved translations: whole name, then title part, then glossary', () => {
  const saved = { '莉莉模型包': '릴리 모델 팩', '【鸣潮】莉莉': '【명조】릴리' };
  const cached = t => saved[t];
  const g = new Glossary(); g.set({ '原神': '원신' });
  assert.equal(translatedFileName('莉莉模型包.zip', { cached }), '릴리 모델 팩.zip');
  assert.equal(translatedFileName('【鸣潮】莉莉_v1.2.7z', { title: '【鸣潮】莉莉', cached }), '【명조】릴리_v1.2.7z');
  assert.equal(translatedFileName('原神模型.rar', { cached, glossary: g }), '원신模型.rar');
  assert.equal(translatedFileName('没有翻译.zip', { cached }), null);
  assert.equal(translatedFileName('莉莉模型包.pmx', { cached }), null);
  assert.equal(translatedFileName('model.zip', { cached }), null);
});

test('cached() never requests a translation and ignores the enabled/fresh switches', async () => {
  let calls = 0;
  const t = new Translator(async () => { calls++; return { ok: true, json: async () => [[['x', 'y']]] }; });
  t.load({ version: 2, buckets: { 'claude:haiku': { '标题': '제목' } } });
  t.configure({ engine: 'google', fresh: true });
  assert.equal(t.enabled, false);
  assert.equal(t.cached('标题'), '제목');
  assert.equal(t.cached('未知'), undefined);
  assert.equal(calls, 0);
});
