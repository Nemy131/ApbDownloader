'use strict';
const TITLE_BAR=34; // 테마 색 타이틀 바 높이(px). ui/readability.css의 --titlebar-h, browser.js와 같은 값
const { app, BrowserWindow, ipcMain, dialog, shell, session, safeStorage, Notification } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');
const { Site } = require('./site');
const C = require('./core');
const defaultAuthors=require('./default-authors');
const translator=new (require('./translation').Translator)();
// GUI launches may inherit a pipe that disappears when their launcher exits.
for (const stream of [process.stdout,process.stderr]) stream?.on('error', e => { if(e.code !== 'EPIPE') { /* Runtime diagnostics must not interrupt the GUI. */ } });
const dataDir = process.env.APLAYBOX_DATA || path.join(app.isPackaged ? path.dirname(process.execPath) : path.resolve(__dirname, '..'), 'data');
app.setPath('userData', dataDir);
app.setName('Aplaybox Downloader');
if(process.platform==='win32')app.setAppUserModelId('Aplaybox.Downloader');
let completionNotification;
let win, site, ses, controller, busy = false, job = null, saving = Promise.resolve(), sessionSave = Promise.resolve();
let state = { works: [], author: '', message: '업로더 주소를 입력해 목록을 불러오세요.', complete: false };
let authorLists = {}; // `${uid}|${scope}` -> { uid, scope, sourceUrl, fetchedAt, works } — lists already loaded once
const AUTHOR_LIST_LIMIT = 30;
let config = { folder: '', concurrency: 6, concurrencyUnlimited: false, notifyOnComplete: true, autoTranslate:true, accounts: {} }, history = {};
let activeUid = '', refreshTail = Promise.resolve();
let bookmarks=[],authorBookmarks=[],embeddedBrowser;
// 3ds Max import state per post id: {state:'sent'|'done'|'failed', time, message} (data/max-imports.json)
let maxImports={};const maxPending=new Map();
let authorUpdates={}; // uid -> { seen, newIds, checkedAt } (author-updates.json)
function allWorks(){return [...new Map([...bookmarks,...state.works].map(w=>[w.id,w])).values()];}
let presence=new Map(),presenceFolder='';
function publicWork(w){const prefix=w.type+':'+w.id+':',found=presenceFolder===config.folder?presence.get(w.id):null;return {...w,maxImport:maxImports[w.id]||null,hasHistory:Object.keys(history).some(k=>k.startsWith(prefix)),inFolder:!!found?.existing,bookmarked:bookmarks.some(b=>b.id===w.id),files:w.files.map(({url,...f})=>({...f,message:f.message==='크기 및 SHA-256 기록 완료'?'':f.message,hasHistory:!!history[prefix+f.id],inFolder:!!found?.files.find(x=>x.id===f.id)?.existing}))};}
async function scanPresence(){if(!config.folder)throw new Error('저장 폴더를 먼저 선택해 주세요.');const folder=config.folder;const result=await require('./existing').selectMissing(folder,allWorks(),history);if(folder===config.folder){presence=new Map(result.works.map(w=>[w.id,w]));presenceFolder=folder;emit();}return {scanned:result.scanned};}
// An account without saved settings starts with all three conditions ticked; nothing is acted on until the user saves them (confirmed).
const settingsFor = uid => config.accounts[uid] || { follow: true, like: true, collect: true, confirmed: false };
function cleanError(e) { return String(e?.message || e).replace(/https?:\/\/\S+/g, '[주소 생략]').replace(/Bearer\s+\S+/gi, '[인증 정보 생략]').slice(0, 400); }
function hiddenAuthors() { return Array.isArray(config.hiddenAuthors) ? config.hiddenAuthors.map(String) : []; }
function snapshot() { const hidden = hiddenAuthors(); return { ...state, version: app.getVersion(), authorShortcuts: shortcutAuthors(), defaultAuthors: defaultAuthors.filter(a => !hidden.includes(a.id)), hiddenDefaultAuthors: defaultAuthors.filter(a => hidden.includes(a.id)).length, autoTranslate:config.autoTranslate===true, authorBookmarks, authorNew: newCounts(), busy, job, account: activeUid, settings: settingsFor(activeUid), folder: config.folder, concurrency: config.concurrency, concurrencyUnlimited: config.concurrencyUnlimited === true, notifyOnComplete: config.notifyOnComplete !== false, browserPreview: config.browserPreview !== false, translateFileNames: config.translateFileNames === true, maxExe: config.maxExe || '', dataDir, works:state.works.map(publicWork),bookmarks:bookmarks.map(b=>publicWork(state.works.find(w=>w.id===b.id)||b)) }; }
// The author buttons: built-in authors (unless removed) and the user's own, as one list. A user entry with a built-in
// author's id replaces it (renamed). Order follows settings.json authorOrder; authors not in it keep their natural place at the end.
function shortcutAuthors(){
  const hidden=hiddenAuthors(),by=new Map();
  for(const a of defaultAuthors)if(!hidden.includes(a.id))by.set(String(a.id),{id:String(a.id),name:a.name,url:a.url,builtin:true});
  for(const a of authorBookmarks){const id=String(a.id);by.set(id,{id,name:a.name,url:a.url,builtin:by.has(id)});}
  const order=Array.isArray(config.authorOrder)?config.authorOrder.map(String):[];const pos=id=>{const i=order.indexOf(id);return i<0?Infinity:i;};
  return [...by.values()].map((a,i)=>[a,i]).sort((x,y)=>{const p=pos(x[0].id),q=pos(y[0].id);return p===q?x[1]-y[1]:p-q;}).map(x=>x[0]);
}
function newCounts(){const out={};for(const a of shortcutAuthors()){const n=(authorUpdates[a.id]?.newIds||[]).length;if(n)out[a.id]=n;}return out;}
// 앱 시작 시 1회: 북마크 버튼에 있는 업로더(기본 제공 포함)의 새 모델을 확인해 저장된 목록에 새 모델만 추가한다.
async function checkBookmarkUpdates(){
  const AU=require('./author-updates');let changed=false,total=0;
  for(const a of shortcutAuthors()){
    const uid=String(a.id);
    try{
      let entry=authorLists[uid+'|model']||authorLists[uid+'|all'];
      // A built-in author never opened yet: start from the list shipped with the app so models newer than it are found.
      if(!entry){const b=builtinList(uid);if(b)entry=authorLists[uid+'|model']={uid,scope:'model',sourceUrl:a.url,fetchedAt:b.entry.fetchedAt,usedAt:new Date(0).toISOString(),works:b.works};}
      const {record,added}=await AU.checkAuthor(uid,{fetchPage:p=>site.page(uid,1,p),entry,record:authorUpdates[uid]||{}});
      authorUpdates[uid]=record;changed=true;total+=added.length;
      if(added.length&&state.author===uid&&!busy){for(const w of [...added].reverse())if(!state.works.some(x=>x.id===w.id))state.works.unshift({...w,files:[]});}
      if(added.length)log(`${a.name}: 새 모델 ${added.length}개`);
    }catch(e){/* 확인 실패는 다음 실행에서 다시 시도 */}
  }
  if(changed){await atomic('author-updates.json',authorUpdates);await atomic('author-lists.json',authorLists);}
  emit();return total;
}
function emit() { if (win && !win.isDestroyed()) win.webContents.send('state', snapshot()); }
async function jsonRead(name, fallback) { try { return JSON.parse(await fs.readFile(path.join(dataDir, name), 'utf8')); } catch { return fallback; } }
function atomic(name, value) { saving = saving.catch(() => {}).then(async () => { const target = path.join(dataDir, name); await fs.writeFile(target + '.tmp', JSON.stringify(value, null, 2), 'utf8'); await fs.rename(target + '.tmp', target); }); return saving; }
function rememberList() {
  if (!state.complete || !state.author || !state.works?.length) return;
  const key = state.author + '|' + (state.scope || 'all'); const prev = authorLists[key];
  authorLists[key] = { uid: state.author, scope: state.scope || 'all', sourceUrl: state.sourceUrl || '', fetchedAt: state.fetchedAt || prev?.fetchedAt || new Date().toISOString(), usedAt: new Date().toISOString(), works: state.works.map(w => ({ ...w, files: (w.files || []).map(({ url, ...f }) => f) })) };
  const keys = Object.keys(authorLists).sort((a, b) => String(authorLists[b].usedAt).localeCompare(String(authorLists[a].usedAt)));
  for (const k of keys.slice(AUTHOR_LIST_LIMIT)) delete authorLists[k];
  return atomic('author-lists.json', authorLists);
}
// Post lists shipped with the app for the built-in authors (src/builtin/author-lists.json): shown until the user's own copy exists.
let builtinLists = null;
function builtinList(uid) {
  if (builtinLists === null) { try { builtinLists = require('./builtin/author-lists.json'); } catch { builtinLists = {}; } }
  const e = builtinLists[uid]; if (!e || !Array.isArray(e.works) || !e.works.length) return null;
  return { entry: { fetchedAt: e.fetchedAt, builtin: true }, works: e.works.map(w => ({ ...w, selected: false, files: [], rules: [], status: '대기', message: '다운로드 시작 시 조건·첨부 파일 확인', detailLoaded: false, permission: null })) };
}
function cachedList(uid, scope) {
  const exact = authorLists[uid + '|' + scope]; if (exact) return { entry: exact, works: exact.works };
  const all = authorLists[uid + '|all']; if (!all && scope === 'model') return builtinList(uid);
  if (!all || scope === 'all') return null;
  const type = scope === 'model' ? 1 : 2; return { entry: all, works: all.works.filter(w => w.type === type) };
}
const stamp = iso => { const d = new Date(iso); return isNaN(d) ? '' : `${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; };
async function persist() { rememberList(); const saved = snapshot();bookmarks=bookmarks.map(b=>state.works.find(w=>w.id===b.id)||b);await atomic('bookmarks.json',saved.bookmarks);delete saved.bookmarks; delete saved.settings; delete saved.account; delete saved.dataDir; return atomic('queue.json', saved); }
function log(message, work) { const line = { time: new Date().toISOString(), work: work?.id || null, message: cleanError(message) }; state.message = line.message; emit(); saving = saving.catch(() => {}).then(() => fs.appendFile(path.join(dataDir, 'events.jsonl'), JSON.stringify(line) + '\n')); }
async function account() { const a = await site.identity(); if (activeUid !== a.uid) { activeUid = a.uid; emit(); } return a; }
async function saveSession() {
  sessionSave = sessionSave.catch(() => {}).then(async () => { if (!await safeStorage.isAsyncEncryptionAvailable()) return; const cookies = (await ses.cookies.get({})).filter(c => c.domain === 'aplaybox.com' || c.domain.endsWith('.aplaybox.com')); const encrypted = await safeStorage.encryptStringAsync(JSON.stringify(cookies)); const target = path.join(dataDir, 'session.enc'); await fs.writeFile(target + '.tmp', encrypted); await fs.rename(target + '.tmp', target); });
  return sessionSave;
}
async function restoreSession() {
  try { const bytes = await fs.readFile(path.join(dataDir, 'session.enc')); const cookies = JSON.parse((await safeStorage.decryptStringAsync(bytes)).result); for (const c of cookies) { if (c.expirationDate && c.expirationDate < Date.now()/1000) continue; const domain = c.domain.replace(/^\./, ''); if (domain !== 'aplaybox.com' && !domain.endsWith('.aplaybox.com')) continue; const args = { url: `https://${domain}${c.path || '/'}`, name: c.name, value: c.value, path: c.path || '/', secure: c.secure, httpOnly: c.httpOnly, sameSite: c.sameSite }; if (!c.hostOnly) args.domain = c.domain; if (c.expirationDate) args.expirationDate = c.expirationDate; await ses.cookies.set(args); } } catch (e) { if (e.code !== 'ENOENT') state.message = '저장된 세션을 복원하지 못했습니다. 다시 로그인해 주세요.'; }
}
async function run(task, kind = 'task') { if (busy) throw new Error('작업 중입니다. 완료하거나 취소한 뒤 진행해 주세요.'); busy = true; job = kind; controller = new AbortController(); emit(); try { await task(controller.signal); } catch(e) { const aborted = controller.signal.aborted, message = aborted ? '작업을 취소했습니다. 완료된 계정 행동은 유지됩니다.' : cleanError(e); log(message); if (!aborted && win && !win.isDestroyed()) win.webContents.send('task-failed', message); } finally { busy = false; job = null; controller = null; await persist(); emit(); } }
function mergeDetail(w, d) { w.author = d.nick_name || w.author; w.authorId = d.user_uid; w.title = d.work_name || w.title; w.cover = d.cover || w.cover; w.date = d.audited_at || w.date; w.rules = C.requirements(d); w.permission = Number(d.download_permission) === 1; w.reason = w.permission ? '' : Number(d.download_type) === 2 ? '업로더에게 문의 필요' : Number(d.download_type) === 3 ? '다운로드 미제공' : '배포 기간 또는 접근 제한'; w.detailLoaded = true; }
function markSeen(uid){const u=authorUpdates[uid];if(!u?.newIds?.length)return;const ids=new Set(u.newIds);for(const w of state.works)if(ids.has(w.id))w.isNew=true;u.newIds=[];void atomic('author-updates.json',authorUpdates);}
async function load(url, scope, signal, refresh=false) {
  scope = 'model'; // 조회 범위는 모델만 (모션 목록은 조회하지 않음)
  const uid = C.authorId(url);
  rememberList();
  const cached = refresh ? null : cachedList(uid, scope);
  if (cached) {
    site.closePending(); state = { works: cached.works.map(w => ({ ...w })), author: uid, sourceUrl: url, scope, fetchedAt: cached.entry.fetchedAt, message: '', complete: true };
    markSeen(uid);
    log(cached.entry.builtin ? `내장 목록 ${state.works.length}개 표시 · ${stamp(cached.entry.fetchedAt)} 기준 · 최신 목록은 새로고침` : `저장된 목록 ${state.works.length}개 표시 · ${stamp(cached.entry.fetchedAt)} 조회 · 최신 목록은 새로고침`); await persist(); return;
  }
  const previous=new Map(refresh&&state.author===uid?state.works.map(w=>[w.id,w]):[]);
  site.closePending(); state = { works: [], author: uid, sourceUrl:url, scope, message: refresh?'목록 새로고침 중':'목록 조회 중', complete: false }; emit();
  const types = scope === 'model' ? [1] : scope === 'motion' ? [2] : [1,2];
  for (const type of types) await C.collectPages(p => site.page(uid, type, p, signal), (rows, pg) => {
    for (const r of rows) if (!state.works.some(w => w.id === r.work_uuid)) {
      const old=previous.get(r.work_uuid);
      state.works.push({ id: r.work_uuid, type, title: r.work_name, cover: r.cover, date: r.audited_at, authorId: uid, author: r.nick_name||old?.author||uid, selected:old?.selected||false, files:old?.files||[], rules: [], status:old?.status==='완료'?'완료':'대기', message: '다운로드 시작 시 조건·첨부 파일 확인', detailLoaded: false, permission: null });
    }
    log(`${type === 1 ? '모델' : '모션'} ${pg.page}/${pg.last}페이지 · ${pg.found}/${pg.total}개 조회`);
  }, signal);
  markSeen(uid);
  state.complete = true; state.fetchedAt = new Date().toISOString(); log(`목록 ${state.works.length}개 조회 완료 · 조건은 다운로드 시작 시 확인합니다.`); await persist();

}
// Account conditions (follow / like / favourite) are checked and acted on one post at a time even when posts are
// resolved concurrently: two posts of one author must not both toggle the same follow.
let conditionTail = Promise.resolve();
function serialCondition(fn) { const run = conditionTail.catch(() => {}).then(fn); conditionTail = run; return run; }
async function resolveWork(w, uid, options, signal) {
  C.check(signal); w.attempted=true; for(const f of w.files)f.message=''; emit();
  const d = await serialCondition(() => { C.check(signal); w.status = '조건 확인 중'; emit(); return C.fulfill({ detail: async () => { const d = await site.detail(w, signal, uid); mergeDetail(w,d); if (!w.permission) throw new C.Waiting(w.reason); return d; }, action: (kind, d) => site.action(kind,w,d,signal,uid), options, signal, event: m => { w.status = '조건 처리 중'; log(m,w); } }); });
  C.check(signal); w.status = '파일 확인 중'; emit();
  const files = await site.resolve(w,d,signal,uid);
  const old = new Map(w.files.map(f => [f.id,f]));
  w.files = files.map(f => ({ ...f, selected: old.get(f.id)?.selected ?? true, status: old.get(f.id)?.status === '완료' ? '완료' : '대기' }));
  w.status = '파일 선택 가능'; w.message = `${w.files.length}개 첨부 파일 확인`; log(w.message,w);
}
async function start(mode, signal, ids=null, exclusions={}) {
  const a = await site.assertAccount(); activeUid = a.uid;
  const options = { ...settingsFor(a.uid) };
  if (!options.confirmed) throw new Error('현재 계정의 자동 처리 설정을 저장해 주세요. 모든 옵션을 끈 상태로 저장해도 됩니다.');
  if (!config.folder) throw new Error('저장 폴더를 선택해 주세요.');
  const selected = allWorks().filter(w => w.selected&&(!ids||ids.includes(w.id))); if (!selected.length) throw new Error('다운로드할 게시물을 선택해 주세요.');
  for(const w of selected){w.attempted=true;w.picked=false;if(w.status!=='완료')w.status='다운로드 대기';}emit();
  // One procedure per post: its conditions and attachments are checked and its files are downloaded right away, in the
  // same slot. config.concurrency is the number of posts handled at once (there is no separate checking stage or setting).
  // Site checks are still held to CHECK_MAX at a time so that "unlimited" does not flood the site with requests.
  const CHECK_MAX = 10; let checking = 0; const checkQueue = [];
  const checkSlot = async fn => { if (checking >= CHECK_MAX) await new Promise(r => checkQueue.push(r)); else checking++; try { return await fn(); } finally { const n = checkQueue.shift(); if (n) n(); else checking--; } };
  const jobs = [];
  let completed = 0;
  const prepare = async w => {
    try {
      // Re-resolve even known files: signed URLs and account conditions can expire.
      await checkSlot(()=>{C.check(signal);return resolveWork(w,a.uid,options,signal);});
      let present;if(exclusions.folder)present=(await require('./existing').selectMissing(config.folder,[w],history,signal)).works[0];
      const mine = [];
      for (const file of w.files.filter(f => f.selected)){if(exclusions.history&&history[w.type+':'+w.id+':'+file.id]||exclusions.folder&&present?.files.find(f=>f.id===file.id)?.existing)continue;mine.push({w,file});}
      jobs.push(...mine); await persist(); emit();
      for (const job of mine) { C.check(signal); await transfer(job); }
      return [];
    } catch(e) { if (signal.aborted) throw e; w.status = e instanceof C.Waiting ? '사용자 조작 필요' : '실패'; w.message = cleanError(e); log(w.message,w); await persist(); emit(); return []; }
  };
  const transfer = async ({w,file}) => {
    const key = `${w.type}:${w.id}:${file.id}`;
    try {
      await site.assertAccount(a.uid); C.check(signal);
      if (await C.validCompleted(history[key])) { file.status = '완료'; file.path = history[key].path; file.size = history[key].size; file.message = '기존 파일 SHA-256 검증 완료 · 건너뜀'; }
      else {
        file.status = '다운로드 중'; w.status = '다운로드 중'; emit();
        const folder = path.resolve(config.folder);
        let result;
        for (let attempt = 0; attempt < 3; attempt++) {
          C.check(signal);
          try { result = await C.download({ fetcher: (u,opts) => fetch(u, { ...opts, headers:{...opts.headers,Referer:C.workUrl(w),'User-Agent':ses.getUserAgent()}, signal: AbortSignal.any([signal,AbortSignal.timeout(30*60*1000)]) }), url: file.url, folder, filename: file.name, expectedSize: file.size, signal, progress: p => { Object.assign(file,p); emit(); }, rename: config.translateFileNames === true ? n => require('./translation').translatedFileName(n, { title: w.title, cached: t => translator.cached(t), glossary: translator.glossary }) : null }); break; }
          catch(e) {
            if (signal.aborted) throw e;
            if ((e.status === 401 || e.status === 403) && attempt === 0) {
              log('다운로드 주소 갱신을 위해 사이트 인증을 다시 확인합니다.', w);
              const refresh = refreshTail.catch(()=>{}).then(async()=>{
                C.check(signal); const d=await site.detail(w,signal,a.uid); const fresh=await site.resolve(w,d,signal,a.uid);
                const match=fresh.find(f=>f.id===file.id); if(!match) throw new C.Waiting('첨부 파일이 변경되었습니다. 파일 목록을 다시 확인해 주세요.'); file.url=match.url;
              }); refreshTail=refresh; await refresh; continue;
            }
            if ((e.status === 429 || e.status >= 500) && attempt < 2) { const raw = e.retryAfter; const ms = raw ? (/^\d+$/.test(raw) ? Number(raw)*1000 : Date.parse(raw)-Date.now()) : 2000*2**attempt; if (ms > 300000) throw new C.Waiting('파일 서버의 대기 시간이 깁니다. 나중에 재시도해 주세요.'); await C.pause(Math.max(1000,ms || 1000),signal); continue; }
            throw e;
          }
        }
        history[key] = result; await atomic('history.json',history); Object.assign(file, { status:'완료', path:result.path, size:result.size, message:'' }); log(`다운로드 완료: ${file.name}`,w);
      }
    } catch(e) { file.status = signal.aborted ? '취소' : e instanceof C.Waiting ? '사용자 조작 필요' : '실패'; file.message = cleanError(e); }
    completed++; w.status = w.files.filter(f=>f.selected).every(f=>f.status==='완료') ? '완료' : w.files.some(f=>f.status==='실패') ? '실패' : w.files.some(f=>f.status==='사용자 조작 필요') ? '사용자 조작 필요' : '대기';
    state.message = `다운로드 처리 ${completed}/${jobs.length}개`; await persist(); emit();
  };
  await C.pipeline({ items: selected, prepare, process: async () => {}, prepareLimit: config.concurrencyUnlimited === true ? Infinity : config.concurrency, signal });
  C.check(signal);
  const waiting=selected.filter(w=>w.status==='사용자 조작 필요').length;
  if(config.notifyOnComplete !== false){
    const done=jobs.filter(j=>j.file.status==='완료').length;
    const failed=selected.filter(w=>w.status==='실패'||w.files.some(f=>f.selected&&f.status==='실패')).length;
    const title=failed||waiting?'다운로드 작업 종료':'다운로드 완료';
    const body='파일 완료 '+done+'/'+jobs.length+'개 · 실패 '+failed+'개 게시물 · 인증 대기 '+waiting+'개 게시물';
    if(win&&!win.isDestroyed()){win.webContents.send('download-finished',{title,body});if(!win.isFocused())win.flashFrame(true);}
    try{if(Notification.isSupported()){
      completionNotification=new Notification({title,body,silent:false});
      completionNotification.on('click',()=>{if(win&&!win.isDestroyed()){if(win.isMinimized())win.restore();win.show();win.focus();win.flashFrame(false);}});
      completionNotification.on('failed',()=>{if(win&&!win.isDestroyed())win.flashFrame(true);});
      completionNotification.show();
    }}catch{/* The in-app result remains available if system notifications are unavailable. */}
  }
  log(`파일 완료 ${jobs.filter(j=>j.file.status==='완료').length}/${jobs.length}개 · 사용자 조작 대기 ${waiting}개 게시물${waiting?' · 인증 후 재개하세요.':''}`);
}
function handle(name, fn) { ipcMain.handle(name, async (event, ...args) => { if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame) return {ok:false,error:'허용되지 않은 요청'}; try { return {ok:true,value:await fn(...args)}; } catch(e) { return {ok:false,error:cleanError(e)}; } }); }
async function loadGlossary(){translator.glossary.set(require('./glossary').parse(await fs.readFile(path.join(dataDir,'glossary.txt'),'utf8').catch(()=>'')));}
async function bootstrap() {
  await fs.mkdir(dataDir,{recursive:true});
  config = {...config,...await jsonRead('settings.json',{})};if(!config.autoTranslateChosen)config.autoTranslate=true;translator.setEnabled(config.autoTranslate===true); history = await jsonRead('history.json',{}); authorLists = await jsonRead('author-lists.json',{}); translator.load(await jsonRead('translations.json',{}));try{translator.loadBuiltin(require('./builtin/translations.json').entries);}catch{/* optional */}try{translator.configure({engine:config.translateEngine||'google',model:config.translateModel||'haiku',claudePath:config.claudePath||'',fresh:config.translateFresh===true,codexPath:config.codexPath||''});try{if(config.translateParallel!==undefined)translator.configure({parallel:config.translateParallel});}catch{}try{translator.configure({codexModel:config.codexModel||''});}catch{/* a model Codex no longer lists: fall back to the default */};}catch{} await loadGlossary(); let translationSaveTimer=null; translator.onChange=()=>{if(translationSaveTimer)return;translationSaveTimer=setTimeout(()=>{translationSaveTimer=null;void atomic('translations.json',translator.entries()).catch(()=>{});},2000);};
  if(!Number.isSafeInteger(config.concurrency)||config.concurrency<1)config.concurrency=6;config.concurrencyUnlimited=config.concurrencyUnlimited===true;delete config.checkConcurrency;
  state = {...state,...await jsonRead('queue.json',{})}; state.works ||= [];
  authorBookmarks=await jsonRead('authors.json',[]);if(!Array.isArray(authorBookmarks))authorBookmarks=[];maxImports=await jsonRead('max-imports.json',{});if(!maxImports||typeof maxImports!=='object'||Array.isArray(maxImports))maxImports={};
  // A request that was still waiting when the app closed can no longer be matched to its result.
  for(const [id,v] of Object.entries(maxImports))if(v?.state==='sent')delete maxImports[id];
  authorUpdates=await jsonRead('author-updates.json',{});if(!authorUpdates||typeof authorUpdates!=='object'||Array.isArray(authorUpdates))authorUpdates={};
  bookmarks=await jsonRead('bookmarks.json',[]);if(!Array.isArray(bookmarks))bookmarks=[];
  for(const w of bookmarks){w.selected=false;w.files||=[];w.rules||=[];}
  const verificationTarget=process.argv.includes('--verify-download')?state.works.find(w=>w.selected):null;
  for (const w of state.works) { w.selected = false; w.files ||= []; for (const f of w.files) if (f.status !== '완료') f.status = '대기'; if (!['완료','조회 실패'].includes(w.status)) w.status='대기'; }
  ses = session.fromPartition('aplaybox-private'); ses.setPermissionRequestHandler((wc,permission,cb)=>cb(false)); ses.setPermissionCheckHandler(()=>false);
  session.defaultSession.webRequest.onBeforeSendHeaders({urls:['https://*.aplaybox.com/*']},(details,callback)=>{callback({requestHeaders:{...details.requestHeaders,Referer:'https://www.aplaybox.com/'}});});
  ses.on('will-download',(e)=>e.preventDefault()); // Only the validated application download pipeline writes files.
  await restoreSession(); site = new Site(ses,log); await account();
  let timer; ses.cookies.on('changed',()=>{ clearTimeout(timer); timer=setTimeout(()=>{ account().then(saveSession).catch(()=>{}); },500); });
  if(process.argv.includes('--verify-download')) {
    if(!verificationTarget)throw new Error('검증할 기존 선택 항목이 없습니다.');
    verificationTarget.selected=true; await run(s=>start('download',s),'download');
    await fs.writeFile(path.join(dataDir,'download-verification.json'),JSON.stringify({date:new Date().toISOString(),work:verificationTarget.id,status:verificationTarget.status,files:verificationTarget.files.map(f=>({name:f.name,status:f.status,size:f.size,message:f.message}))},null,2));
    await saveSession();if(verificationTarget.status!=='사용자 조작 필요'){site.closePending();app.quit();return;}
  }
  if (process.argv.includes('--verify-login')) {
    const a=await site.assertAccount(); await site.api('user/getMyBasicInfo',{},undefined,a.uid);
    const {FIND_COMPONENT}=require('./site'); const probe=site.newWindow('로그인 복원 확인');await probe.loadURL('https://www.aplaybox.com/details/model/oZQiRK0WxZTV');
    let result=null;for(let i=0;i<80;i++){result=await probe.webContents.executeJavaScript(`(() => {const c=${FIND_COMPONENT};return c?.data?{hasSiteToken:!!localStorage.getItem('access_token'),hasSiteUid:!!localStorage.getItem('user_uuid'),componentReady:true}:null;})()`);if(result)break;await C.pause(500);}
    await fs.writeFile(path.join(dataDir,'login-verification.json'),JSON.stringify({authenticatedApi:true,...result},null,2));probe.destroy();app.quit();return;
  }
  if (process.argv.includes('--smoke-test')) {
    const report = {date:new Date().toISOString(),models:0,motions:0,detail:null};
    for (const type of [1,2]) { const list=await C.collectPages(p=>site.page('352588796',type,p)); report[type===1?'models':'motions']=list.length; if(type===1 && list.length) { const d=await site.detail({id:list[0].work_uuid,type}); report.detail={id:d.work_uuid,author:d.nick_name,rules:C.requirements(d),permission:d.download_permission}; } }
    await fs.writeFile(path.join(dataDir,'live-verification.json'),JSON.stringify(report,null,2)); app.quit(); return;
  }
  if (process.argv.includes('--probe-site')) {
    const {FIND_COMPONENT,INSTALL_CAPTURE}=require('./site'); const probe=site.newWindow('읽기 전용 사이트 구조 검증');
    await probe.loadURL('https://www.aplaybox.com/details/model/oZQiRK0WxZTV');
    let result=null; for(let i=0;i<100;i++){result=await probe.webContents.executeJavaScript(`(() => {const c=${FIND_COMPONENT};return c?.data?{id:c.data.work_uuid,hasDownloadFlow:typeof c.downloadAdvertCheck==='function',hasAdRead:typeof c.getDownloadAdvertisements==='function',hasAccountRead:typeof c.getUserBasicInfo==='function'}:null;})()`);if(result)break;await C.pause(500);}
    if(!result)throw new Error('실제 사이트 컴포넌트 조회 실패');result.captureReady=await probe.webContents.executeJavaScript(INSTALL_CAPTURE);await fs.writeFile(path.join(dataDir,'site-probe.json'),JSON.stringify(result,null,2));probe.destroy();app.quit();return;
  }
  win = new BrowserWindow({width:1320,height:900,minWidth:980,minHeight:680,title:'Aplaybox Downloader',backgroundColor:'#e7e7e9',autoHideMenuBar:true,titleBarStyle:'hidden',titleBarOverlay:{color:'#e7e7e9',symbolColor:'#111114',height:TITLE_BAR},webPreferences:{preload:path.join(__dirname,'preload.js'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'})); win.webContents.on('will-navigate',e=>e.preventDefault());
  handle('snapshot',()=>snapshot());
  handle('fileNameTranslation',async enabled=>{if(typeof enabled!=='boolean')throw new Error('설정 값이 올바르지 않습니다.');config.translateFileNames=enabled;await atomic('settings.json',config);emit();return enabled;});
  handle('completionNotification',async enabled=>{
    if(typeof enabled!=='boolean')throw new Error('알림 설정 값이 올바르지 않습니다.');
    config.notifyOnComplete=enabled;
    if(!enabled){completionNotification?.close();if(win&&!win.isDestroyed())win.flashFrame(false);}
    await atomic('settings.json',config);emit();return enabled;
  });
  handle('autoTranslate',async enabled=>{
    if(typeof enabled!=='boolean')throw new Error('번역 설정 값이 올바르지 않습니다.');
    config.autoTranslate=enabled;config.autoTranslateChosen=true;translator.setEnabled(enabled);await embeddedBrowser?.setTranslation(enabled);await atomic('settings.json',config);emit();return enabled;
  });
  handle('translateTexts',async texts=>{
    if(!Array.isArray(texts)||texts.length>64||texts.some(t=>typeof t!=='string'||t.length>1800))throw new Error('번역 요청이 너무 큽니다.');
    return Promise.all(texts.map(async t=>({original:t,text:await translator.translate(t)})));
  });
  handle('translationCache',()=>translator.enabled?translator.view():{});
  handle('titleBar',async v=>{const hex=/^#[0-9a-f]{6}$/i;if(!v||!hex.test(v.color)||!hex.test(v.symbol))throw new Error('색 값이 올바르지 않습니다.');if(win&&!win.isDestroyed())win.setTitleBarOverlay({color:v.color,symbolColor:v.symbol,height:TITLE_BAR});return true;});
  // CLI 계정(Claude / ChatGPT-Codex): status / logout / login (브라우저 로그인 진행, 결과는 'claude-login' 이벤트에 provider 와 함께) / loginCode / loginOpen / loginCancel
  const signInUrl=u=>{try{const x=new URL(u);return x.protocol==='https:'&&/(^|\.)(claude\.com|claude\.ai|anthropic\.com|openai\.com|chatgpt\.com)$/.test(x.hostname);}catch{return false;}};
  const accountHandler=(provider,cli,exeOf,label)=>{
    let job=null;const send=state=>{if(win&&!win.isDestroyed())win.webContents.send('claude-login',{provider,...state});};
    return async(op,value)=>{const exe=exeOf();
      if(op==='logout')return cli.logout(exe);
      if(op==='login'){
        if(!exe)throw new Error(label+'를 찾지 못했습니다.');
        if(job)job.cancel();
        const mine=cli.loginStart(exe,{onUrl:url=>{if(job===mine)send({state:'url',url:signInUrl(url)});}});job=mine;
        mine.done.then(account=>{if(job!==mine)return;job=null;send(account.loggedIn?{state:'done',account}:{state:'error',error:'로그인이 확인되지 않았습니다. 다시 시도해 주세요.'});},e=>{if(job!==mine)return;job=null;send({state:'error',error:cleanError(e)});});
        return {started:true};
      }
      if(op==='loginCode'){if(!job||!job.write(value))throw new Error('진행 중인 로그인이 없거나 코드 입력이 필요하지 않습니다.');return true;}
      if(op==='loginOpen'){const url=job?.url;if(!url||!signInUrl(url))throw new Error('로그인 주소를 아직 받지 못했습니다.');await shell.openExternal(url);return true;}
      if(op==='loginCancel'){const j=job;job=null;j?.cancel();return true;}
      return cli.authStatus(exe);};
  };
  handle('claudeAccount',accountHandler('claude',require('./claude-cli'),()=>translator.claudeExe(),'Claude Code'));
  handle('codexAccount',accountHandler('codex',require('./codex-cli'),()=>translator.codexExe(),'Codex'));
  handle('translationEngine',async(op,value)=>{
    const save=async()=>{config.translateEngine=translator.engine;config.translateModel=translator.model;config.translateFresh=translator.fresh;if(translator.claudePath)config.claudePath=translator.claudePath;else delete config.claudePath;config.codexModel=translator.codexSlug();config.translateParallel=translator.parallel;if(translator.codexPath)config.codexPath=translator.codexPath;else delete config.codexPath;await atomic('settings.json',config);};
    if(op==='switch'){const v=value||{};translator.configure(v.engine==='codex'?{engine:'codex',codexModel:v.model,fresh:v.fresh===true}:{engine:v.engine,model:v.model,fresh:v.fresh===true});await save();if(embeddedBrowser&&translator.enabled){await embeddedBrowser.setTranslation(false).catch(()=>{});await embeddedBrowser.setTranslation(true).catch(()=>{});}}
    else if(op==='engine'){translator.configure({engine:value});await save();}
    else if(op==='model'){translator.configure({model:value});await save();}
    else if(op==='parallel'){translator.configure({parallel:value});await save();}
    else if(op==='browse'&&value==='codex'){const r=await dialog.showOpenDialog(win,{title:'codex.exe 선택',defaultPath:translator.codexExe()||undefined,filters:[{name:'Codex',extensions:['exe']}],properties:['openFile']});if(!r.canceled){if(!/codex\.exe$/i.test(r.filePaths[0]))throw new Error('codex.exe를 선택해 주세요.');translator.configure({codexPath:r.filePaths[0]});await save();}}
    else if(op==='auto'&&value==='codex'){translator.configure({codexPath:''});await save();}
    else if(op==='browse'){const r=await dialog.showOpenDialog(win,{title:'claude.exe 선택',defaultPath:translator.claudeExe()||undefined,filters:[{name:'Claude Code',extensions:['exe']}],properties:['openFile']});if(!r.canceled){if(!/claude\.exe$/i.test(r.filePaths[0]))throw new Error('claude.exe를 선택해 주세요.');translator.configure({claudePath:r.filePaths[0]});await save();}}
    else if(op==='auto'){translator.configure({claudePath:''});await save();}
    else if(op==='test'){const llm=translator.llm();const t0=Date.now();try{const out=await llm.cli.translateBatch(llm.exe(),[translator.glossary.apply('原神 芙宁娜 夏日泳装 MMD模型')],{model:llm.model()});if(!/[가-힣]/u.test(out[0]))throw new Error('번역 결과에 한국어가 없습니다: '+out[0]);translator.configure({});return {...translator.status(),test:{ok:true,ms:Date.now()-t0,text:out[0]}};}catch(e){return {...translator.status(),test:{ok:false,error:llm.cli.friendly(e.message)}};}}
    else if(op==='clear'){translator.clear();}
    else if(op==='glossary'){const file=path.join(dataDir,'glossary.txt');try{await fs.access(file);}catch{await fs.writeFile(file,'﻿# 번역 용어집: 한 줄에 "원문=번역" (예: 流萤=반디). 저장 후 앱을 다시 시작하면 적용됩니다. 이미 번역된 제목은 "저장된 번역 지우기" 후 다시 번역됩니다.\r\n','utf8');}await shell.openPath(file);}
    else if(op!=='get')throw new Error('알 수 없는 요청');
    return translator.status();
  });
  handle('scanPresence',()=>scanPresence());
  // 3ds Max import: files go to the bundled ImportMMD.ms through ApbMaxBridge.ms running inside Max (see maxbridge.js).
  const MB=require('./maxbridge');
  // Questions shown as app-styled dialogs in the window instead of OS message boxes. Resolves the chosen button index, -1 when dismissed.
  let askSeq=0;const asks=new Map();
  const askRenderer=opts=>new Promise(resolve=>{if(!win||win.isDestroyed())return resolve(-1);const id=++askSeq;asks.set(id,resolve);win.webContents.send('app-ask',{id,...opts});});
  handle('appAnswer',(id,index)=>{const done=asks.get(id);if(done){asks.delete(id);done(Number.isInteger(index)?index:-1);}});
  const saveMaxExe=async exe=>{config.maxExe=exe;await atomic('settings.json',config);emit();return exe;};
  async function chooseMaxExe(){const r=await dialog.showOpenDialog(win,{title:'3dsmax.exe 선택',defaultPath:config.maxExe||undefined,filters:[{name:'3ds Max',extensions:['exe']}],properties:['openFile']});if(r.canceled)return null;if(!/3dsmax\.exe$/i.test(r.filePaths[0]))throw new Error('3dsmax.exe를 선택해 주세요.');return saveMaxExe(r.filePaths[0]);}
  async function pickMaxExe(){
    if(config.maxExe&&require('node:fs').existsSync(config.maxExe))return config.maxExe;
    const list=await MB.findMaxExes();
    if(!list.length)return chooseMaxExe();
    if(list.length===1)return list[0].exe;
    const response=await askRenderer({title:'3ds Max 버전 선택',message:'실행할 3ds Max 버전을 선택해 주세요.',detail:'선택한 버전은 3ds Max 임포트 설정에 저장됩니다.',buttons:list.map(x=>'3ds Max '+x.year)});
    return response>=0&&response<list.length?saveMaxExe(list[response].exe):null;
  }
  // Startup script install needs the user's OK once; later calls only refresh an outdated copy.
  async function ensureBridge(){
    const st=MB.installState();
    if(!st.length)return true;
    if(st.some(s=>s.installed)){MB.install();return true;}
    const response=await askRenderer({title:'3ds Max 연동 설치',message:'3ds Max 시작 스크립트에 연동 스크립트를 설치할까요?',
      detail:'ApbMaxBridge.ms를 아래 폴더에 복사합니다. 이후 켜는 3ds Max는 다운로더의 임포트 요청을 자동으로 받습니다. 제거하려면 이 파일을 지우면 됩니다.\n\n'+st.map(s=>s.dir).join('\n'),buttons:['설치']});
    if(response!==0)return false;
    MB.install();return true;
  }
  // 3ds Max import settings dialog: Max exe (app setting), Blender / Bandizip (ImportMMD.ini), startup script.
  handle('maxConfig',async(op,key)=>{
    if(op==='browse'||op==='auto'){
      if(key==='max'){if(op==='auto'){delete config.maxExe;await atomic('settings.json',config);emit();}else await chooseMaxExe();}
      else if(key==='blender'||key==='bz'){
        const exeName=key==='blender'?'blender.exe':'bz.exe';
        if(op==='auto')MB.writeIni(key==='blender'?{BlenderMode:'1',BlenderVerified:'',BlenderInfo:''}:{BandizipMode:'1'});
        else{
          const r=await dialog.showOpenDialog(win,{title:exeName+' 선택',filters:[{name:exeName,extensions:['exe']}],properties:['openFile']});
          if(!r.canceled){
            if(path.basename(r.filePaths[0]).toLowerCase()!==exeName)throw new Error(exeName+' 파일을 선택해 주세요.');
            MB.writeIni(key==='blender'?{BlenderMode:'2',BlenderPath:r.filePaths[0],BlenderVerified:'',BlenderInfo:''}:{BandizipMode:'2',BandizipPath:r.filePaths[0]});
          }
        }
      }else throw new Error('알 수 없는 설정 항목입니다.');
    }else if(op==='install')MB.install();
    else if(op==='remove')MB.uninstall();
    else if(op==='open'){await fs.mkdir(MB.bridgeDir(),{recursive:true});const e=await shell.openPath(MB.bridgeDir());if(e)throw new Error('폴더를 열지 못했습니다: '+e);}
    else if(op!=='get')throw new Error('알 수 없는 요청입니다.');
    return MB.configView(config.maxExe);
  });
  const maxFiles=ids=>{
    if(!Array.isArray(ids)||!ids.length)throw new Error('임포트할 배포 자료를 선택해 주세요.');
    const wanted=new Set(ids.map(String)),files=[],owners=[];
    for(const w of allWorks().filter(w=>wanted.has(String(w.id))))for(const f of MB.importableFiles(w,history,presenceFolder===config.folder?presence.get(w.id):null))if(!files.includes(f)){files.push(f);owners.push([f,w.id]);}
    if(!files.length)throw new Error('선택한 자료에서 임포트할 수 있는 파일(.pmx/.zip/.rar/.7z)을 찾지 못했습니다. 먼저 다운로드해 주세요.');
    return {files,owners};
  };
  // What the import dialog shows: the files, where they can go, and the importer options currently saved.
  handle('maxImportPlan',async ids=>{
    const {files}=maxFiles(ids);const {live,unlinked}=await MB.instances();
    return {files:files.map(f=>path.basename(f)),targets:[...live.map(i=>({id:String(i.pid),label:MB.label(i)})),{id:'new',label:'새 3ds Max 실행'}],unlinked,bridgeScript:MB.BRIDGE_SCRIPT,options:MB.importOptions(MB.readIni())};
  });
  handle('maxImport',async(ids,request={})=>{
    const {files,owners}=maxFiles(ids);
    if(!await ensureBridge())return {canceled:true};
    // Options chosen in the import dialog go to ImportMMD.ini; the importer re-reads it when it takes the request.
    if(request&&request.options)MB.writeIni(MB.optionsToIni(request.options));
    // Remember which post each file belongs to; ImportMMD.ms reports every file's result into max-bridge\results.
    const sent=()=>{maxPending.batch=Date.now();for(const [f,id] of owners){maxPending.set(path.resolve(f).toLowerCase(),id);maxImports[id]={state:'sent',time:new Date().toISOString(),message:'',batch:maxPending.batch};}void atomic('max-imports.json',maxImports);emit();};
    const {live}=await MB.instances();
    const target=String(request?.target||(live.length===1?live[0].pid:'new'));
    const choice=target==='new'?'new':live.find(i=>String(i.pid)===target);
    if(!choice)throw new Error('선택한 3ds Max를 찾을 수 없습니다. 다시 시도해 주세요.');
    if(choice==='new'){
      const exe=await pickMaxExe();if(!exe)return {canceled:true};
      const pid=MB.launch(exe);await MB.writeRequest(pid,files);sent();
      log(`3ds Max를 실행했습니다. 시작이 끝나면 파일 ${files.length}개를 임포트합니다.`);
      return {target:'new',count:files.length};
    }
    const requestFile=await MB.writeRequest(choice.pid,files);sent();
    const taken=await MB.waitTaken(requestFile,choice.busy?1500:8000);
    log(taken?`${MB.label(choice)}에 파일 ${files.length}개 임포트 요청을 보냈습니다.`:`${MB.label(choice)}이 작업 중입니다. 현재 작업이 끝나면 파일 ${files.length}개를 임포트합니다.`);
    return {target:MB.label(choice),count:files.length,taken};
  });
  handle('bookmark',async id=>{const index=bookmarks.findIndex(w=>w.id===id);if(index>=0)bookmarks.splice(index,1);else{const w=allWorks().find(w=>w.id===id);if(!w)throw new Error('모델을 찾을 수 없습니다.');bookmarks.push(w);}await persist();emit();});
  handle('login',()=>site.login());
  const browser=()=>embeddedBrowser||=(new (require('./browser').EmbeddedBrowser)(win,ses,s=>{if(!win.isDestroyed())win.webContents.send('browser-state',s);},translator,url=>previewFromBrowser(url)));
  const currentAuthor=()=>{try{return C.authorId(browser().current());}catch{throw new Error('사이트에서 업로더 이름을 눌러 업로더 페이지로 이동해 주세요.');}};
  // The model display runs in two places: over the list (the renderer owns the frame and the buttons' actions) and
  // over the built-in browser when a model link is clicked there (viewerOver==='browser': handled here, the list is hidden).
  let viewerOver='list',viewerModel=null;
  const notify=message=>{if(win&&!win.isDestroyed())win.webContents.send('task-failed',message);};
  const viewer=new (require('./viewer').ModelViewer)(win,ses,s=>{if(win.isDestroyed())return;if(viewerOver==='browser'){if(s.status==='error'){viewerModel=null;notify(s.error||'모델 디스플레이를 불러오지 못했습니다.');}return;}win.webContents.send('viewer-state',s);});
  const browserStage=()=>{const a=browser().area(),m=18;return {x:a.x+m,y:a.y+m,width:Math.max(0,a.width-m*2),height:Math.max(0,a.height-m*2)};};
  function previewFromBrowser(url){
    if(config.browserPreview===false)return false;
    let model;try{model=C.modelFromUrl(url);}catch{return false;}
    viewerOver='browser';viewerModel=model;void viewer.open(model,browserStage()).catch(()=>{});return true;
  }
  const closeBrowserPreview=()=>{if(viewerOver==='browser'){viewerModel=null;viewerOver='list';viewer.close();}};
  win.on('resize',()=>{if(viewerOver==='browser'&&viewerModel)viewer.bounds(browserStage());});
  // Uploader page of a post: known for listed posts, otherwise read from the post's public details.
  async function uploaderUrl(id){const w=allWorks().find(w=>w.id===id);let uid=w?.authorId;if(!uid){const d=await site.detail({id,type:1});uid=d?.user_uid;}if(!/^[A-Za-z0-9_-]{1,40}$/.test(String(uid||'')))throw new Error('업로더 정보를 확인하지 못했습니다.');return 'https://www.aplaybox.com/u/'+uid+'/model';}
  handle('uploaderUrl',id=>uploaderUrl(String(id)));
  handle('browserPreview',async enabled=>{if(typeof enabled!=='boolean')throw new Error('설정 값이 올바르지 않습니다.');config.browserPreview=enabled;await atomic('settings.json',config);emit();return enabled;});
  handle('viewerOpen',(id,rect)=>{const w=allWorks().find(w=>w.id===id);if(!w)throw new Error('작품 정보를 찾을 수 없습니다.');embeddedBrowser?.hide();viewerOver='list';viewerModel=null;return viewer.open(w,rect);});
  handle('viewerBounds',rect=>{if(viewerOver==='list')viewer.bounds(rect);});
  handle('viewerClose',()=>{viewerOver='list';viewerModel=null;viewer.close();});
  // Removes the 3ds Max import record of the given posts (the '임포트 완료' tab). Files and Max scenes are not touched.
  // Removes the download record of the given posts (the '다운로드 완료' tab): history entries and the finished state. Files on disk stay.
  handle('downloadForget',async ids=>{
    if(busy)throw new Error('작업이 끝난 뒤 다운로드 기록을 삭제해 주세요.');
    if(!Array.isArray(ids))throw new Error('삭제할 다운로드 기록을 선택해 주세요.');
    const wanted=new Set(ids.map(String));let n=0;
    for(const w of allWorks().filter(w=>wanted.has(String(w.id)))){
      const prefix=w.type+':'+w.id+':';let had=w.status==='완료';
      for(const key of Object.keys(history))if(key.startsWith(prefix)){delete history[key];had=true;}
      if(!had)continue;
      w.status='대기';w.attempted=false;w.picked=false;w.message='';
      for(const f of w.files){if(f.status==='완료')f.status='대기';f.message='';delete f.path;}
      n++;
    }
    if(n){await atomic('history.json',history);await persist();emit();}
    return n;
  });
  // Clears the in-progress / failed state of the given posts (the '다운로드 진행' tab). Finished posts, history and files are not touched.
  handle('progressForget',async ids=>{
    if(busy)throw new Error('작업이 끝난 뒤 진행 기록을 삭제해 주세요.');
    if(!Array.isArray(ids))throw new Error('삭제할 기록을 선택해 주세요.');
    const wanted=new Set(ids.map(String));let n=0;site.closePending();
    for(const w of allWorks().filter(w=>wanted.has(String(w.id))&&w.status!=='완료')){
      w.status='대기';w.attempted=false;w.picked=false;w.message='다운로드 시작 시 조건·첨부 파일 확인';
      for(const f of w.files){if(f.status!=='완료')f.status='대기';f.message='';}
      n++;
    }
    if(n){await persist();emit();}
    return n;
  });
  handle('maxImportForget',async ids=>{if(!Array.isArray(ids))throw new Error('삭제할 임포트 기록을 선택해 주세요.');let n=0;for(const id of ids.map(String))if(maxImports[id]){delete maxImports[id];n++;}if(n){await atomic('max-imports.json',maxImports);emit();}return n;});
  // 3ds Max import results (written by ImportMMD.ms) -> maxImports; checked only while a request is waiting.
  let maxPolling=false;const maxResultTimer=setInterval(async()=>{if(maxPolling||!maxPending.size)return;maxPolling=true;try{const results=await MB.takeResults();if(results.length&&MB.applyResults(maxImports,maxPending,results)){await atomic('max-imports.json',maxImports);for(const r of results)log((r.ok?'3ds Max 임포트 완료: ':'3ds Max 임포트 실패: ')+path.basename(r.source)+(r.ok||!r.message?'':' · '+r.message));emit();}if(!Object.values(maxImports).some(v=>v?.state==='sent'))maxPending.clear();}catch{}finally{maxPolling=false;}},2000);maxResultTimer.unref();
  // Buttons drawn inside the model display page (viewer-preload.js). Only the viewer's own view may send this.
  ipcMain.on('viewer-action',(e,action)=>{
    if(!viewer.owns(e.sender)||!['post','download','close','uploader'].includes(action)||win.isDestroyed())return;
    if(viewerOver!=='browser'){win.webContents.send('viewer-action',action);return;}
    const model=viewerModel;closeBrowserPreview();if(!model||action==='close')return;
    if(action==='post')void browser().open(C.workUrl(model)).catch(e=>notify(cleanError(e)));
    else if(action==='uploader')void uploaderUrl(model.id).then(url=>browser().open(url)).catch(e=>notify(cleanError(e)));
    else if(action==='download')void downloadModel(model).catch(e=>notify(cleanError(e)));
  });
  handle('browse',url=>{viewerOver='list';viewerModel=null;viewer.close();return browser().open(url);});
  handle('browserHide',()=>{closeBrowserPreview();embeddedBrowser?.hide();});
  handle('browserAction',action=>browser().action(action));
  handle('browserDownload',()=>downloadModel(C.modelFromUrl(browser().current())));
  // Downloads one model post found in the built-in browser (the page being viewed, or the one in the 3D preview).
  async function downloadModel(model){
    if(busy)throw new Error('현재 다운로드 작업이 끝난 뒤 다시 눌러 주세요.');
    const account=await site.assertAccount();
    if(!settingsFor(account.uid).confirmed)throw new Error('목록으로 돌아가 이 계정의 자동 처리 설정을 먼저 저장해 주세요.');
    if(!config.folder)throw new Error('목록으로 돌아가 저장 폴더를 먼저 선택해 주세요.');
    if(busy)throw new Error('현재 작업이 끝난 뒤 다시 눌러 주세요.');
    let w=allWorks().find(w=>w.id===model.id&&Number(w.type)===1);
    if(!w)w={...model,title:'모델 '+model.id,author:'',cover:'',date:'',files:[],rules:[],status:'대기',message:'',detailLoaded:false,permission:null};
    if(!state.works.some(x=>x.id===w.id))state.works.push(w);
    w.selected=true;for(const f of w.files)f.selected=true;
    closeBrowserPreview();embeddedBrowser.hide();win.webContents.send('browser-download-started');
    void run(s=>start('download',s,[model.id]),'download');
  }
  handle('browserImport',()=>{
    if(busy)throw new Error('현재 작업이 끝난 뒤 목록을 불러와 주세요.');
    const url='https://www.aplaybox.com/u/'+currentAuthor()+'/model';
    embeddedBrowser.hide();win.webContents.send('author-selected',url);void run(s=>load(url,'model',s),'list');
  });
  handle('authorBookmark',async(url,name)=>{
    const id=url?C.authorId(url):currentAuthor();const canonical='https://www.aplaybox.com/u/'+id+'/model';
    const label=String(name||'').trim().slice(0,100)||state.works.find(w=>String(w.authorId)===id)?.author||('업로더 '+id);
    const entry={id,url:canonical,name:label};const i=authorBookmarks.findIndex(a=>a.id===id);if(i<0)authorBookmarks.push(entry);else authorBookmarks[i]=entry;
    if(hiddenAuthors().includes(id)){config.hiddenAuthors=hiddenAuthors().filter(x=>x!==id);await atomic('settings.json',config);}
    await atomic('authors.json',authorBookmarks);emit();return entry;
  });
  handle('authorRemove',async id=>{id=String(id);authorBookmarks=authorBookmarks.filter(a=>String(a.id)!==id);await atomic('authors.json',authorBookmarks);if(defaultAuthors.some(a=>a.id===id)&&!hiddenAuthors().includes(id)){config.hiddenAuthors=[...hiddenAuthors(),id];await atomic('settings.json',config);}emit();});
  // Order of the author buttons (drag to reorder).
  handle('authorOrder',async ids=>{if(!Array.isArray(ids)||ids.length>500||ids.some(x=>typeof x!=='string'||!/^[A-Za-z0-9_-]{1,40}$/.test(x)))throw new Error('업로더 순서 값이 올바르지 않습니다.');config.authorOrder=[...new Set(ids)];await atomic('settings.json',config);emit();});
  handle('authorDefaultsRestore',async()=>{config.hiddenAuthors=[];await atomic('settings.json',config);emit();});
  handle('refreshAccount',async()=>{await account(); await saveSession(); emit();});
  handle('logout',async()=>{ if(busy) throw new Error('작업을 취소한 뒤 로그아웃해 주세요.'); site.closePending(); if(site.loginWindow&&!site.loginWindow.isDestroyed()) site.loginWindow.destroy(); for(const w of BrowserWindow.getAllWindows()) if(w!==win) w.destroy(); await ses.clearStorageData(); await sessionSave.catch(()=>{}); await fs.unlink(path.join(dataDir,'session.enc')).catch(()=>{}); activeUid=''; emit(); });
  handle('downloadOptions',async o=>{
    const n=Number(o?.concurrency);
    if(!Number.isSafeInteger(n)||n<1||n>64)throw new Error('동시 다운로드 수는 1~64 사이의 정수로 입력해 주세요.');
    config.concurrency=n;config.concurrencyUnlimited=o.unlimited===true;await atomic('settings.json',config);emit();
  });
  handle('settings',async options=>{ if(busy) throw new Error('작업 완료 후 설정을 변경해 주세요.'); const concurrency=Number(options.concurrency);if(!Number.isSafeInteger(concurrency)||concurrency<1)throw new Error('동시 다운로드 수는 1 이상의 정수로 입력해 주세요.');const a=await site.assertAccount(); config.accounts[a.uid]={follow:options.follow===true,like:options.like===true,collect:options.collect===true,confirmed:true}; config.concurrency=concurrency; await atomic('settings.json',config); activeUid=a.uid; emit(); });
  handle('folder',async()=>{if(busy) throw new Error('작업 완료 후 폴더를 변경해 주세요.'); const r=await dialog.showOpenDialog(win,{defaultPath:config.folder||undefined,properties:['openDirectory','createDirectory']}); if(!r.canceled){config.folder=r.filePaths[0];await atomic('settings.json',config);emit();}});
  handle('openFolder',async()=>{
    if(!config.folder)throw new Error('저장 폴더를 먼저 선택해 주세요.');
    const folder=path.resolve(config.folder);
    let stat;try{stat=await fs.stat(folder);}catch{throw new Error('저장 폴더가 없거나 접근할 수 없습니다. 저장 폴더를 다시 선택해 주세요.');}
    if(!stat.isDirectory())throw new Error('저장 경로가 폴더가 아닙니다. 저장 폴더를 다시 선택해 주세요.');
    let error;try{error=await shell.openPath(folder);}catch(e){error=cleanError(e);}
    if(error){
      if(process.platform!=='win32')throw new Error('폴더를 열지 못했습니다: '+error);
      await new Promise((resolve,reject)=>{
        const child=require('node:child_process').spawn(path.join(process.env.SystemRoot||'C:\\Windows','explorer.exe'),[folder],{shell:false,detached:true,stdio:'ignore'});
        child.once('error',()=>reject(new Error('탐색기를 실행하지 못했습니다. 저장 폴더 경로와 Windows 탐색기 상태를 확인해 주세요.')));
        child.once('spawn',()=>{child.unref();resolve();});
      });
    }
  });
  handle('load',(url,scope)=>{if(busy)throw new Error('작업 중입니다.');void run(s=>load(url,scope,s),'list');});
  handle('refresh',(url,scope)=>{if(busy)throw new Error('작업 중입니다.');void run(s=>load(url,scope,s,true),'list');});
  handle('selection',changes=>{if(!Array.isArray(changes))return;
    // During a job only finished posts can be (de)selected, as whole posts; `picked` marks what the user chose meanwhile so
    // the 3ds Max button can tell it from the posts the running download was started with.
    if(busy){const allowed=changes.filter(c=>!c.fileId&&allWorks().find(w=>w.id===c.id)?.status==='완료');for(const c of allowed){const w=allWorks().find(w=>w.id===c.id);w.selected=!!c.selected;for(const f of w.files)f.selected=!!c.selected;w.picked=!!c.selected;}emit();if(allowed.length<changes.length)throw new Error('작업 중에는 다운로드가 끝난 자료만 선택할 수 있습니다.');return;}
    for(const c of changes){const w=allWorks().find(w=>w.id===c.id);if(!w)continue;if(c.fileId){const f=w.files.find(f=>f.id===c.fileId);if(f)f.selected=!!c.selected;w.selected=w.files.some(f=>f.selected);}else {w.selected=!!c.selected;for(const f of w.files)f.selected=!!c.selected;}}emit();});
  handle('selectMissing',(ids,mode='replace')=>{
    if(busy)throw new Error('작업 중입니다.');if(!config.folder)throw new Error('검사할 저장 폴더를 먼저 선택해 주세요.');
    const excludeOnly=mode==='exclude';
    const wanted=new Set(ids);const targets=allWorks().filter(w=>wanted.has(w.id));if(!targets.length)throw new Error(excludeOnly?'먼저 제외 여부를 검사할 모델을 선택해 주세요.':'현재 검색·필터 결과에 게시물이 없습니다.');
    void run(async signal=>{
      log('저장 폴더와 하위 폴더의 기존 모델을 검사합니다.');
      const result=await require('./existing').selectMissing(config.folder,targets,history,signal,n=>log(`기존 파일 ${n}개 검사 중`));
      C.check(signal);
      if(!excludeOnly)for(const w of allWorks()){w.selected=false;for(const f of w.files)f.selected=false;}
      for(const match of result.works){
        const w=targets.find(w=>w.id===match.id);const wasSelected=w.selected;w.existingPath=match.existing;
        for(const f of match.files){const original=w.files.find(x=>x.id===f.id);original.selected=excludeOnly?original.selected&&f.selected:f.selected;original.existingPath=f.existing;}
        w.selected=excludeOnly?wasSelected&&(w.files.length?w.files.some(f=>f.selected):match.selected):match.selected;
      }
      const excluded=result.works.filter(w=>!w.selected).length;
      log(`파일 ${result.scanned}개 검사 · 기존 게시물 ${excluded}개 제외 · 총 ${state.works.filter(w=>w.selected).length}개 선택. 첨부 파일명 미확인 자료는 게시물 ID 폴더·기록으로만 판정합니다.`);
    },'scan');
  });
  handle('start',(mode,ids,exclusions={})=>{if(mode!=='download')throw new Error('조건 확인은 다운로드 시작 시 진행합니다.');if(busy)throw new Error('작업 중입니다.');void run(s=>start('download',s,Array.isArray(ids)?ids:null,{history:exclusions.history===true,folder:exclusions.folder===true}),'download');});
  handle('cancel',()=>{controller?.abort();site.closePending();emit();});
  handle('openPost',(id,play)=>{const w=allWorks().find(w=>w.id===id);if(w)return site.open(w,{play:play===true});});
  await win.loadFile(path.join(__dirname,'ui/index.html'));
  setTimeout(()=>{void checkBookmarkUpdates().catch(()=>{});},1500);
  setTimeout(()=>require('./updater').checkOnStartup({app,dialog,shell,win,repo:require('../package.json').updateRepo,dataDir,onLog:m=>log(m)}),3000);
  win.on('closed',()=>{controller?.abort();site.closePending();app.quit();});
}
app.whenReady().then(bootstrap).catch(async e=>{await fs.mkdir(dataDir,{recursive:true});await fs.writeFile(path.join(dataDir,'startup-error.txt'),cleanError(e));app.quit();});
app.on('window-all-closed',()=>app.quit());
let flushingQuit=false;
app.on('before-quit',event=>{
  if(flushingQuit||!ses)return;
  event.preventDefault();flushingQuit=true;controller?.abort();
  Promise.allSettled([saveSession(),saving]).then(()=>app.quit());
});
