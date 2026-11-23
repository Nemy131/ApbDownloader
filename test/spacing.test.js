'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const C = require('../src/core');

test('spaced runs calls one at a time with the gap measured from the end of the previous call', async () => {
  const run = C.spaced(120);
  const log = [];
  const job = (name, ms) => () => new Promise(r => { log.push([name, 'start', Date.now()]); setTimeout(() => { log.push([name, 'end', Date.now()]); r(name); }, ms); });
  const results = await Promise.all([run(job('a', 40)), run(job('b', 10)), run(job('c', 10))]);
  assert.deepEqual(results, ['a', 'b', 'c']);
  assert.deepEqual(log.map(x => x[0] + x[1]), ['astart', 'aend', 'bstart', 'bend', 'cstart', 'cend']);
  const t = n => log.find(x => x[0] + x[1] === n)[2];
  assert.ok(t('bstart') - t('aend') >= 110, 'b waited for the gap after a');
  assert.ok(t('cstart') - t('bend') >= 110, 'c waited for the gap after b');
});

test('spaced keeps the gap after a failed call and skips a call cancelled while waiting', async () => {
  const run = C.spaced(100);
  const failed = await run(async () => { throw new Error('x'); }).catch(e => e.message);
  assert.equal(failed, 'x');
  const after = Date.now();
  const ac = new AbortController();
  let called = false;
  const cancelled = run(async () => { called = true; }, ac.signal);
  ac.abort();
  await assert.rejects(cancelled);
  assert.equal(called, false);
  await run(async () => {});
  assert.ok(Date.now() - after >= 90, 'gap still applied after the failure');
});

test('automatic account actions use a 1 second gap and the default concurrency is 1', () => {
  const fs = require('node:fs'), path = require('node:path');
  const site = fs.readFileSync(path.join(__dirname, '..', 'src', 'site.js'), 'utf8');
  assert.match(site, /const ACTION_GAP_MS = 1000;/);
  assert.match(site, /this\.actionQueue\(\(\) => this\.api\(endpoint/);
  const main = fs.readFileSync(path.join(__dirname, '..', 'src', 'main.js'), 'utf8');
  assert.match(main, /concurrency: 1, notifyOnComplete/);
  assert.doesNotMatch(main, /concurrencyUnlimited\s*[=:]\s*(true|o\.)|Infinity : config\.concurrency/);
  assert.match(main, /await gate\.wait\(signal\);/);
  assert.doesNotMatch(fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'index.html'), 'utf8'), /concurrencyUnlimited/);
  assert.match(main, /config\.concurrency<1\)config\.concurrency=1;/);
  assert.match(main, /config\.accounts\[uid\] \|\| \{ follow: false, like: false, collect: false, confirmed: false \}/);
  for (const k of ['follow', 'like', 'collect']) assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'index.html'), 'utf8'), new RegExp('<input id="' + k + '" type="checkbox">'));
  assert.match(fs.readFileSync(path.join(__dirname, '..', 'src', 'ui', 'index.html'), 'utf8'), /id="concurrency"[^>]*value="1"/);
});

test('postGate starts the first post at once and waits 5-15 s (random) after the previous post', async () => {
  const waits = [];
  // random 0 → min, random 0.999… → max
  let r = 0;
  const gate = C.postGate({ min: 50, max: 150, random: () => r });
  const t0 = Date.now(); await gate.wait(); waits.push(Date.now() - t0);
  gate.done();
  const t1 = Date.now(); await gate.wait(); waits.push(Date.now() - t1);
  gate.done(); r = 0.9999;
  const t2 = Date.now(); await gate.wait(); waits.push(Date.now() - t2);
  assert.ok(waits[0] < 30, 'first post starts at once');
  assert.ok(waits[1] >= 45 && waits[1] < 120, 'min gap ' + waits[1]);
  assert.ok(waits[2] >= 140, 'max gap ' + waits[2]);
  const ac = new AbortController(); gate.done();
  const p = gate.wait(ac.signal); ac.abort(); await assert.rejects(p);
});

test('two posts waiting at the same time pass the gate one after another', async () => {
  const gate = C.postGate({ min: 60, max: 60 });
  await gate.wait(); gate.done();
  const at = [];
  await Promise.all([gate.wait().then(() => at.push(Date.now())), gate.wait().then(() => at.push(Date.now()))]);
  assert.ok(at[1] - at[0] >= 55, 'second waits a full gap after the first ' + (at[1] - at[0]));
});
