'use strict';
const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

class Waiting extends Error { constructor(message) { super(message); this.name = 'Waiting'; } }
function check(signal) { signal?.throwIfAborted(); }
async function pause(ms, signal) { await delay(ms, undefined, { signal }); }
function authorId(value) {
  const u = new URL(value);
  const m = u.pathname.match(/^\/u\/(\d+)(?:\/(?:model|motion))?\/?$/);
  if (u.protocol !== 'https:' || u.hostname !== 'www.aplaybox.com' || u.port || u.username || u.password || !m) throw new Error('https://www.aplaybox.com/u/작가번호/model 형식의 주소를 입력해 주세요.');
  return m[1];
}
function modelFromUrl(value){
  const u=new URL(value),m=u.pathname.match(/^\/details\/model\/([A-Za-z0-9_-]+)\/?$/);
  if(u.protocol!=='https:'||!['www.aplaybox.com','aplaybox.com'].includes(u.hostname)||u.port||u.username||u.password||!m)throw new Error('개별 모델 페이지에서 눌러 주세요.');
  return {id:m[1],type:1};
}
function safeName(value, limit = 70) {
  let n = String(value || '이름 없음').normalize('NFC').replace(/[<>:"/\\|?*\x00-\x1f]/g, '_').replace(/[. ]+$/g, '').slice(0, limit).replace(/[. ]+$/g, '');
  if (!n || /^\.+$/.test(n)) n = '_';
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(n)) n = '_' + n;
  return n;
}
function workUrl(w) { return `https://www.aplaybox.com/details/${Number(w.type) === 2 ? 'motion' : 'model'}/${encodeURIComponent(w.id)}`; }
function requirements(d) {
  const r = d.work_download_rules || {};
  const out = [];
  if (r.follow_length != null && Number(r.follow_length) >= 0) out.push({ kind: 'follow', label: Number(r.follow_length) > 0 ? `팔로우 ${r.follow_length}일` : '팔로우', met: Number(d.follow_ship_status) > 0 });
  if (Number(r.like_status) > 0) out.push({ kind: 'like', label: '좋아요', met: Number(d.like_status) === 1 });
  if (Number(r.collect_status) > 0) out.push({ kind: 'collect', label: '즐겨찾기', met: Number(d.collect_status) === 1 });
  for (const [key, label] of [['point_status','포인트 조건'],['user_rank','계정 레벨'],['work_count','업로드 수'],['black_list','차단 목록 제한']]) if (Number(r[key]) > 0) out.push({ kind: key, label, met: null });
  if (Number(d.download_password_on) === 1) out.push({ kind: 'password', label: '다운로드 비밀번호', met: null });
  return out;
}
async function collectPages(getPage, onPage = () => {}, signal) {
  const seen = new Map(); let total = null, last = null;
  for (let page = 1; page <= 10000; page++) {
    check(signal);
    const p = await getPage(page);
    if (!p || !Array.isArray(p.data) || !Number.isInteger(Number(p.total)) || !Number.isInteger(Number(p.last_page))) throw new Error('사이트 목록 응답 구조가 변경되었습니다. 전체 조회를 확인할 수 없습니다.');
    if (Number(p.current_page) !== page) throw new Error('서버가 요청한 페이지와 다른 페이지를 반환했습니다. 다시 조회해 주세요.');
    if (total !== null && (Number(p.total) !== total || Number(p.last_page) !== last)) throw new Error('조회 중 게시물 수가 변경되었습니다. 목록을 다시 조회해 주세요.');
    total = Number(p.total); last = Number(p.last_page);
    let added = 0;
    for (const w of p.data) { if (!w.work_uuid) throw new Error('게시물 식별자가 없습니다.'); if (!seen.has(w.work_uuid)) { seen.set(w.work_uuid, w); added++; } }
    await onPage(p.data, { page, last, total, found: seen.size });
    if (page >= last) { if (seen.size !== total) throw new Error(`조회 불완전: ${seen.size}/${total}개. 중복 또는 누락으로 다시 조회해야 합니다.`); return [...seen.values()]; }
    if (!added) throw new Error('목록 페이지가 반복되거나 비어 있습니다. 전체 조회를 확인할 수 없습니다.');
  }
  throw new Error('조회 페이지 상한을 초과했습니다.');
}
async function fulfill({ detail, action, options, signal, event = () => {} }) {
  let d = await detail();
  for (const kind of ['follow','like','collect']) {
    check(signal);
    const r = requirements(d).find(x => x.kind === kind);
    if (!r || r.met) continue;
    if (!options[kind]) throw new Waiting(`${r.label} 자동 처리가 꺼져 있습니다. 설정을 변경하거나 게시물에서 직접 처리해 주세요.`);
    event(`조건 처리: ${r.label}`);
    await action(kind, d);
    let met = false;
    for (let attempt = 0; attempt < 3; attempt++) { check(signal); d = await detail(); if (requirements(d).find(x => x.kind === kind)?.met) { met = true; break; } await pause(600 * (attempt + 1), signal); }
    if (!met) throw new Waiting(`${r.label} 반영을 확인하지 못했습니다. 상태 확인 후 재시도해 주세요.`);
    event(`조건 충족 확인: ${r.label}`);
  }
  return d;
}
function fileIdentity(url, variant = 0) { const u = new URL(url); return crypto.createHash('sha256').update(`${variant}:${u.origin}${u.pathname}`).digest('hex').slice(0, 24); }
function attachment(url, variant = 0) {
  const u = new URL(url);
  if (u.protocol !== 'https:' || u.username || u.password || u.port || !(u.hostname === 'aplaybox.com' || u.hostname.endsWith('.aplaybox.com'))) throw new Waiting('외부 다운로드 링크입니다. 게시물에서 직접 확인해 주세요.');
  let name; try { name = decodeURIComponent(u.pathname.split('/').pop()); } catch { name = u.pathname.split('/').pop(); }
  if (!name) throw new Error('서버에서 유효한 파일명을 제공하지 않았습니다.');
  return { id: fileIdentity(url, variant), name, size: null, variant, url, selected: true, status: '대기' };
}
function dispositionName(value) {
  if (!value) return null;
  const extended = /filename\*=UTF-8''([^;]+)/i.exec(value);
  if (extended) { try { return decodeURIComponent(extended[1]); } catch {} }
  return /filename="([^"]+)"/i.exec(value)?.[1] || /filename=([^;]+)/i.exec(value)?.[1]?.trim() || null;
}
async function download({ fetcher, url, folder, filename, expectedSize, signal, progress = () => {}, rename = null }) {
  check(signal);
  const response = await fetcher(url, { signal, headers: { 'Accept-Encoding': 'identity' }, redirect: 'follow' });
  if (!response.ok) { const e = new Error(`파일 서버 HTTP ${response.status}`); e.status = response.status; e.retryAfter = response.headers.get('retry-after'); throw e; }
  const mime = response.headers.get('content-type') || '';
  if (/text\/html|application\/(?:json|problem\+json)|application\/xhtml/i.test(mime)) throw new Error('파일 대신 로그인 또는 오류 문서가 반환되었습니다.');
  if (!response.body) throw new Error('다운로드 응답 본문이 없습니다.');
  await fs.mkdir(folder, { recursive: true });
  const original = dispositionName(response.headers.get('content-disposition')) || filename;
  // rename(원래 이름) -> 확장자를 포함한 새 이름. 확장자가 같을 때만 쓰고, 실패하거나 빈 값이면 원래 이름.
  let given = original; if (rename) { try { const r = rename(original); if (typeof r === 'string' && r.trim() && path.extname(r.trim()).toLowerCase() === path.extname(original).toLowerCase()) given = r.trim(); } catch {} }
  const ext = path.extname(safeName(given, 160)).slice(0, 16);
  const base = safeName(path.basename(given, path.extname(given)), 80);
  const totalHeader = response.headers.get('content-length');
  const total = totalHeader ? Number(totalHeader) : Number(expectedSize) || null;
  const part = path.join(folder, `.${crypto.randomUUID()}.part`);
  if (path.resolve(part).length > 245) throw new Error('저장 경로가 너무 깁니다. 더 짧은 저장 폴더를 선택해 주세요.');
  let handle, loaded = 0, first = true; const hash = crypto.createHash('sha256'), start = Date.now();
  const reader = response.body.getReader();
  try {
    handle = await fs.open(part, 'wx');
    while (true) {
      check(signal); const { value, done } = await reader.read(); if (done) break;
      if (first) { first = false; const prefix = Buffer.from(value).subarray(0, 512).toString('utf8').trimStart(); if (/^(?:<!doctype html|<html|<\?xml|\{\s*"(?:error|message|status)")/i.test(prefix)) throw new Error('오류 문서를 파일로 저장하지 않았습니다.'); }
      hash.update(value); let offset = 0; while (offset < value.length) { const out = await handle.write(value, offset, value.length - offset); offset += out.bytesWritten; }
      loaded += value.length; progress({ loaded, total, speed: loaded / Math.max(0.1, (Date.now() - start) / 1000) });
    }
    check(signal);
    if (!loaded || (total != null && loaded !== total) || (expectedSize && loaded !== Number(expectedSize))) throw new Error('파일 크기 검증 실패: 불완전한 다운로드입니다.');
    await handle.sync(); await handle.close(); handle = null;
    for (let n = 0; n < 10000; n++) {
      const target = path.join(folder, `${base}${n ? ` (${n})` : ''}${ext}`);
      if (target.length > 245) throw new Error('저장 경로가 너무 깁니다.');
      try {
        try { await fs.link(part, target); }
        catch (e) { if (!['EPERM','ENOTSUP','EXDEV'].includes(e.code)) throw e; await fs.copyFile(part, target, require('node:fs').constants.COPYFILE_EXCL); }
        await fs.unlink(part); return { path: target, size: loaded, sha256: hash.digest('hex') };
      }
      catch (e) { if (e.code !== 'EEXIST') throw e; }
    }
    throw new Error('동일 이름 파일이 너무 많습니다.');
  } finally { await reader.cancel().catch(() => {}); if (handle) await handle.close(); await fs.unlink(part).catch(() => {}); }
}
async function validCompleted(record) {
  if (!record?.path || !record.sha256) return false;
  try { const s = await fs.stat(record.path); if (s.size !== record.size) return false; const hash = crypto.createHash('sha256'); const h = await fs.open(record.path); try { for await (const c of h.createReadStream()) hash.update(c); } finally { await h.close().catch(() => {}); } return hash.digest('hex') === record.sha256; } catch { return false; }
}
module.exports = { Waiting, check, pause, authorId, modelFromUrl, safeName, workUrl, requirements, collectPages, fulfill, attachment, dispositionName, download, validCompleted };
