'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { findNew, checkAuthor } = require('../src/author-updates');

const row = id => ({ work_uuid: id, work_name: '模型' + id, cover: '', audited_at: '2026-11-13', nick_name: '作者' });
const pager = (ids, per = 3) => { const calls = []; const fetch = async page => { calls.push(page); const data = ids.slice((page - 1) * per, page * per).map(row); return { data, total: ids.length, last_page: Math.max(1, Math.ceil(ids.length / per)), current_page: page }; }; fetch.calls = calls; return fetch; };

test('findNew stops at the first page that contains a known work', async () => {
  const fetch = pager(['n1', 'n2', 'n3', 'n4', 'o1', 'o2', 'o3', 'o4']);
  const { fresh } = await findNew(fetch, new Set(['o1', 'o2', 'o3', 'o4']));
  assert.deepEqual(fresh.map(r => r.work_uuid), ['n1', 'n2', 'n3', 'n4']);
  assert.deepEqual(fetch.calls, [1, 2]);
});

test('first check of an author only records a baseline without NEW', async () => {
  const fetch = pager(['a', 'b', 'c', 'd']);
  const r = await checkAuthor('9', { fetchPage: fetch, entry: null, record: {}, now: 't' });
  assert.deepEqual(r.added, []);
  assert.deepEqual(r.record, { seen: ['a', 'b', 'c'], newIds: [], checkedAt: 't' });
  assert.deepEqual(fetch.calls, [1]);
});

test('new models are added to the saved list only, marked NEW, and old NEW marks are cleared after viewing', async () => {
  const entry = { works: [{ id: 'o1', isNew: true }, { id: 'o2' }] };
  const r = await checkAuthor('9', { fetchPage: pager(['n1', 'o1', 'o2']), entry, record: { seen: ['o1', 'o2'], newIds: [] } });
  assert.deepEqual(r.added.map(w => [w.id, w.type, w.authorId, w.isNew, w.status]), [['n1', 1, '9', true, '대기']]);
  assert.deepEqual(entry.works.map(w => w.id), ['n1', 'o1', 'o2']);
  assert.equal(entry.works[1].isNew, undefined);
  assert.deepEqual(r.record.newIds, ['n1']);
  assert.ok(r.record.seen.includes('n1'));
  // 사용자가 아직 열어 보지 않은 상태에서 다시 실행: 이전 NEW 유지 + 새 것 누적
  const again = await checkAuthor('9', { fetchPage: pager(['n2', 'n1', 'o1', 'o2']), entry, record: r.record });
  assert.deepEqual(again.record.newIds, ['n1', 'n2']);
  assert.equal(entry.works.find(w => w.id === 'n1').isNew, true);
  assert.deepEqual(entry.works.map(w => w.id), ['n2', 'n1', 'o1', 'o2']);
});

test('nothing new leaves the list untouched', async () => {
  const entry = { works: [{ id: 'o1' }, { id: 'o2' }] };
  const r = await checkAuthor('9', { fetchPage: pager(['o1', 'o2']), entry, record: { seen: ['o1'], newIds: [] } });
  assert.deepEqual(r.added, []);
  assert.deepEqual(entry.works.map(w => w.id), ['o1', 'o2']);
});
