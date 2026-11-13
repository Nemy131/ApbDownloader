'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pipeline } = require('../src/core');

const sleep = ms => new Promise(r => setTimeout(r, ms));

test('pipeline starts a job as soon as its item is prepared, not after every item', async () => {
  const events = [];
  await pipeline({
    items: ['a', 'b', 'c'],
    prepare: async item => { events.push('prepare ' + item); await sleep(item === 'a' ? 5 : 40); events.push('prepared ' + item); return [item + '1']; },
    process: async job => { events.push('start ' + job); await sleep(5); events.push('done ' + job); },
    prepareLimit: 1, processLimit: 2
  });
  assert.ok(events.indexOf('start a1') < events.indexOf('prepared b'), 'a1 must start while b is still being prepared: ' + events.join(', '));
  assert.deepEqual(events.filter(e => e.startsWith('done')).sort(), ['done a1', 'done b1', 'done c1']);
});

test('pipeline keeps to the prepare and process limits', async () => {
  let preparing = 0, processing = 0, maxPreparing = 0, maxProcessing = 0;
  await pipeline({
    items: [1, 2, 3, 4, 5, 6, 7],
    prepare: async n => { maxPreparing = Math.max(maxPreparing, ++preparing); await sleep(10); preparing--; return [n * 10, n * 10 + 1]; },
    process: async () => { maxProcessing = Math.max(maxProcessing, ++processing); await sleep(15); processing--; },
    prepareLimit: 3, processLimit: 2
  });
  assert.equal(maxPreparing, 3);
  assert.equal(maxProcessing, 2);
});

test('pipeline with processLimit Infinity runs every available job at once', async () => {
  let processing = 0, maxProcessing = 0, done = 0;
  await pipeline({
    items: [1, 2, 3, 4, 5, 6],
    prepare: async n => [n],
    process: async () => { maxProcessing = Math.max(maxProcessing, ++processing); await sleep(30); processing--; done++; },
    prepareLimit: 6, processLimit: Infinity
  });
  assert.equal(maxProcessing, 6);
  assert.equal(done, 6);
});

test('pipeline finishes when items produce no jobs or there are no items', async () => {
  await pipeline({ items: [], prepare: async () => [1], process: async () => {} });
  let processed = 0;
  await pipeline({ items: [1, 2], prepare: async () => [], process: async () => { processed++; }, prepareLimit: 2 });
  assert.equal(processed, 0);
});

test('pipeline stops starting work after an abort, waits for running calls, then rejects', async () => {
  const controller = new AbortController();
  const started = [], finished = [];
  const run = pipeline({
    items: [1, 2, 3, 4],
    prepare: async n => { started.push('p' + n); await sleep(20); if (n === 1) controller.abort(); finished.push('p' + n); return [n]; },
    process: async n => { started.push('j' + n); },
    prepareLimit: 1, processLimit: 1, signal: controller.signal
  });
  await assert.rejects(run);
  assert.deepEqual(started, ['p1']);
  assert.deepEqual(finished, ['p1']);
});

test('pipeline rejects with the first thrown error and starts nothing new', async () => {
  const started = [];
  await assert.rejects(pipeline({
    items: [1, 2, 3],
    prepare: async n => { started.push(n); if (n === 1) throw new Error('boom'); return [n]; },
    process: async () => {},
    prepareLimit: 1
  }), /boom/);
  assert.deepEqual(started, [1]);
});
