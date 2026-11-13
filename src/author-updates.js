'use strict';
// 북마크 업로더의 새 모델 확인 (앱 시작 시 1회). 읽기 전용 목록 API만 사용한다.
// updates.json 구조: { [uid]: { seen: [workId...], newIds: [workId...], checkedAt } }
const MAX_PAGES = 5, SEEN_LIMIT = 400;

// 첫 페이지부터 읽으며 모르는 게시물을 모은다. 한 페이지가 모두 아는 게시물이면 멈춘다.
async function findNew(fetchPage, known, { maxPages = MAX_PAGES } = {}) {
  const fresh = [], firstIds = [];
  for (let page = 1; page <= maxPages; page++) {
    const p = await fetchPage(page);
    const rows = Array.isArray(p?.data) ? p.data.filter(r => r && typeof r.work_uuid === 'string') : [];
    if (page === 1) firstIds.push(...rows.map(r => r.work_uuid));
    const unknown = rows.filter(r => !known.has(r.work_uuid) && !fresh.some(f => f.work_uuid === r.work_uuid));
    fresh.push(...unknown);
    if (!rows.length || unknown.length < rows.length || page >= Number(p?.last_page || 1)) break;
  }
  return { fresh, firstIds };
}

// 사이트 행 → 목록 항목 (main.js load()와 같은 모양)
function toWork(r, uid) {
  return { id: r.work_uuid, type: 1, title: r.work_name, cover: r.cover, date: r.audited_at, authorId: uid, author: r.nick_name || uid, selected: false, files: [], rules: [], status: '대기', message: '다운로드 시작 시 조건·첨부 파일 확인', isNew: true };
}

// 한 업로더 확인: 저장된 목록(entry)에 새 모델만 앞에 추가하고, updates 기록을 갱신한다.
async function checkAuthor(uid, { fetchPage, entry, record = {}, now = new Date().toISOString() }) {
  const listed = (entry?.works || []).map(w => w.id);
  const known = new Set([...(record.seen || []), ...listed]);
  if (!known.size) { // 처음 확인하는 업로더: 현재 상태를 기준으로 저장만 한다.
    const { firstIds } = await findNew(fetchPage, known, { maxPages: 1 });
    return { record: { seen: firstIds, newIds: [], checkedAt: now }, added: [] };
  }
  // 사용자가 이미 열어 본 업로더(newIds 없음)는 이전 실행의 NEW 표시를 정리한다.
  if (entry && !(record.newIds || []).length) for (const w of entry.works) delete w.isNew;
  const { fresh } = await findNew(fetchPage, known);
  const added = fresh.map(r => toWork(r, uid));
  if (entry && added.length) entry.works.unshift(...added);
  const newIds = [...new Set([...(record.newIds || []), ...added.map(w => w.id)])];
  const seen = [...new Set([...added.map(w => w.id), ...(record.seen || []), ...listed])].slice(0, SEEN_LIMIT);
  return { record: { seen, newIds, checkedAt: now }, added };
}

module.exports = { findNew, toWork, checkAuthor, MAX_PAGES };
