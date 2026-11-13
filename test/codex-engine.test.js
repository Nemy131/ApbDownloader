'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const codex = require('../src/codex-cli');
const { Translator } = require('../src/translation');

const cache = { models: [
  { slug: 'gpt-6.1-sol', display_name: 'GPT-6.1-Sol', visibility: 'list' },
  { slug: 'gpt-6-astra', display_name: 'GPT-6-Astra', visibility: 'list' },
  { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide' },
  { slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', visibility: 'list' },
  { slug: 'gpt-5.6-luna', display_name: 'GPT-5.6-Luna', visibility: 'list' },
  { slug: 'bad slug!', visibility: 'list' }
] };

test('codex: model roles are resolved against the listed models, with a fallback', () => {
  const models = codex.listModels(cache);
  assert.deepEqual(models.map(m => m.slug), ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna', 'gpt-5.6-luna']);
  assert.equal(codex.pickModel('fast', models), 'gpt-6-luna');
  assert.equal(codex.pickModel('accurate', models), 'gpt-6.1-sol');
  assert.equal(codex.pickModel('fast', []), 'gpt-6-luna');
  assert.equal(codex.pickModel('accurate', undefined), 'gpt-6.1-sol');
  assert.throws(() => codex.pickModel('haiku', models));
  assert.deepEqual(codex.listModels(null), []);
  // the saved setting is a real model name; unknown names and old role values fall back or are mapped
  assert.equal(codex.chooseModel('gpt-6-astra', models), 'gpt-6-astra');
  assert.equal(codex.chooseModel('', models), 'gpt-6-luna');
  assert.equal(codex.chooseModel('gpt-9-gone', models), 'gpt-6-luna');
  assert.equal(codex.chooseModel('accurate', models), 'gpt-6.1-sol');
  assert.equal(codex.chooseModel('gpt-reserve', models), 'gpt-6-luna');
});

test('codex: the newest codex.exe under the Codex bin folder is found; helper-only folders are skipped', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'apb-codex-find-'));
  try {
    const bin = path.join(root, 'OpenAI', 'Codex', 'bin');
    fs.mkdirSync(path.join(bin, 'aaa'), { recursive: true }); fs.mkdirSync(path.join(bin, 'bbb'), { recursive: true }); fs.mkdirSync(path.join(bin, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(bin, 'aaa', 'codex.exe'), 'old'); fs.writeFileSync(path.join(bin, 'bbb', 'codex.exe'), 'new'); fs.writeFileSync(path.join(bin, 'tools', 'rg.exe'), 'x');
    fs.utimesSync(path.join(bin, 'aaa', 'codex.exe'), new Date(2026, 0, 1), new Date(2026, 0, 1));
    fs.utimesSync(path.join(bin, 'bbb', 'codex.exe'), new Date(2026, 5, 1), new Date(2026, 5, 1));
    assert.equal(codex.find({ LOCALAPPDATA: root, PATH: '' }), path.join(bin, 'bbb', 'codex.exe'));
    assert.equal(codex.find({ LOCALAPPDATA: path.join(root, 'none'), PATH: '' }), '');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('codex: login status text and error messages', () => {
  assert.deepEqual(codex.parseStatus('Logged in using ChatGPT\n'), { loggedIn: true, email: '', plan: '', method: 'ChatGPT' });
  assert.equal(codex.parseStatus('Not logged in').loggedIn, false);
  assert.equal(codex.parseStatus('').loggedIn, false);
  assert.match(codex.friendly('401 Unauthorized'), /로그인/);
  assert.match(codex.friendly('usage limit reached'), /한도/);
  assert.match(codex.friendly('boom'), /번역 실패/);
});

test('codex: translateBatch sends the titles as JSON and parses the reply array', async () => {
  let seen;
  const out = await codex.translateBatch('codex.exe', ['一', '二'], { model: 'gpt-6-luna', runner: async (exe, o) => { seen = { exe, ...o }; return { result: '```json\n["하나","둘"]\n```' }; } });
  assert.deepEqual(out, ['하나', '둘']);
  assert.equal(seen.model, 'gpt-6-luna'); assert.equal(seen.input, '["一","二"]');
  await assert.rejects(codex.translateBatch('codex.exe', ['一', '二'], { model: 'm', runner: async () => ({ result: '["하나"]' }) }));
});

const fakeCodex = (reply, calls = []) => ({
  MODELS: ['fast', 'accurate'], find: () => 'codex.exe', friendly: m => 'ChatGPT 실패: ' + m,
  availableModels: () => [{ slug: 'gpt-6.1-sol', name: 'GPT-6.1-Sol' }, { slug: 'gpt-6-astra', name: 'GPT-6-Astra' }, { slug: 'gpt-6-luna', name: 'GPT-6-Luna' }],
  chooseModel: codex.chooseModel,
  translateBatch: async (exe, texts, o) => { calls.push({ exe, texts, model: o.model }); return reply(texts); }
});
const googleFetch = (calls = []) => async url => { calls.push(String(url)); return { ok: true, json: async () => [[['구글 번역', '']]] }; };

test('translator: the codex engine batches titles, uses the resolved model and stores under codex:<model>', async () => {
  const calls = [];
  const t = new Translator(googleFetch(), { codex: fakeCodex(texts => texts.map((x, i) => '번역' + i), calls) });
  t.setEnabled(true); t.configure({ engine: 'codex' });
  assert.equal(t.key(), 'codex:gpt-6-luna', 'default is the fast model');
  t.configure({ codexModel: 'gpt-6-astra' });
  assert.equal(t.key(), 'codex:gpt-6-astra');
  t.configure({ codexModel: 'accurate' });
  assert.equal(t.key(), 'codex:gpt-6.1-sol', 'a role value saved by an earlier build is mapped to a model');
  const out = await Promise.all([t.translate('模型一'), t.translate('模型二')]);
  assert.deepEqual(out, ['번역0', '번역1']);
  assert.equal(calls.length, 1); assert.equal(calls[0].model, 'gpt-6.1-sol'); assert.equal(calls[0].exe, 'codex.exe');
  assert.deepEqual(Object.keys(t.entries().buckets), ['codex:gpt-6.1-sol']);
  // saved results come back after a reload, including the dotted model name in the bucket key
  const t2 = new Translator(googleFetch(), { codex: fakeCodex(() => { throw new Error('must not be called'); }) });
  t2.load(t.entries()); t2.setEnabled(true); t2.configure({ engine: 'codex', codexModel: 'gpt-6.1-sol' });
  assert.equal(await t2.translate('模型一'), '번역0');
  assert.equal(t2.status().saved['codex:gpt-6.1-sol'], 2);
  assert.equal(t2.status().codexModel, 'gpt-6.1-sol'); assert.deepEqual(t2.status().codexModels.map(m => m.slug), ['gpt-6.1-sol', 'gpt-6-astra', 'gpt-6-luna']);
});

test('translator: a failing codex call falls back to Google and rests the engine', async () => {
  const google = [];
  const t = new Translator(googleFetch(google), { codex: fakeCodex(() => { throw new Error('not logged in'); }) });
  t.setEnabled(true); t.configure({ engine: 'codex' });
  assert.equal(await t.translate('模型'), '구글 번역');
  assert.equal(google.length, 1);
  assert.match(t.status().error, /ChatGPT 실패/);
  assert.ok(t.status().cooldownUntil > Date.now());
  assert.deepEqual(Object.keys(t.entries().buckets), ['google']);
  assert.throws(() => t.configure({ codexModel: 'haiku' }));
  assert.throws(() => t.configure({ codexModel: 'gpt-9-gone' }));
  assert.throws(() => t.configure({ engine: 'gemini' }));
});

test('translator: titles go out in batches of 16, several batches at a time, limited by the parallel setting', async () => {
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  for (const parallel of [1, 3]) {
    let running = 0, peak = 0; const sizes = [];
    const slow = { ...fakeCodex(() => []), translateBatch: async (exe, texts) => { sizes.push(texts.length); peak = Math.max(peak, ++running); await sleep(40); running--; return texts.map(t => '번역:' + t); } };
    const t = new Translator(googleFetch(), { codex: slow });
    t.setEnabled(true); t.configure({ engine: 'codex', parallel });
    const titles = Array.from({ length: 50 }, (_, i) => '模型' + i);
    const out = await Promise.all(titles.map(x => t.translate(x)));
    assert.deepEqual(out, titles.map(x => '번역:' + x), 'every title gets its own translation back');
    assert.equal(peak, parallel);
    assert.deepEqual(sizes.slice().sort((a, b) => b - a), [16, 16, 16, 2]);
    assert.equal(t.status().parallel, parallel);
  }
  const t = new Translator(googleFetch(), { codex: fakeCodex(x => x) });
  assert.equal(t.status().parallel, 3);
  assert.throws(() => t.configure({ parallel: 5 })); assert.throws(() => t.configure({ parallel: 0 })); assert.throws(() => t.configure({ parallel: 1.5 }));
});

test('translator: after one batch fails, queued batches skip the CLI and go to Google', async () => {
  let calls = 0; const google = [];
  const failing = { ...fakeCodex(() => []), translateBatch: async () => { calls++; await new Promise(r => setTimeout(r, 10)); throw new Error('usage limit reached'); } };
  const t = new Translator(googleFetch(google), { codex: failing });
  t.setEnabled(true); t.configure({ engine: 'codex', parallel: 1 });
  const titles = Array.from({ length: 40 }, (_, i) => '模型' + i);
  const out = await Promise.all(titles.map(x => t.translate(x)));
  assert.equal(calls, 1, 'only the first batch reaches the CLI');
  assert.ok(out.every(x => x === '구글 번역'));
  assert.equal(google.length, 40);
});
