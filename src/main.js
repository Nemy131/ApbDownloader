'use strict';
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
let state = { works: [], author: '', message: '작가 주소를 입력해 목록을 불러오세요.', complete: false };
let authorLists = {}; // `${uid}|${scope}` -> { uid, scope, sourceUrl, fetchedAt, works } — lists already loaded once
const AUTHOR_LIST_LIMIT = 30;
let config = { folder: '', concurrency: 2, notifyOnComplete: true, autoTranslate:true, accounts: {} }, history = {};
let activeUid = '', refreshTail = Promise.resolve();
let bookmarks=[],authorBookmarks=[],embeddedBrowser;
function allWorks(){return [...new Map([...bookmarks,...state.works].map(w=>[w.id,w])).values()];}
let presence=new Map(),presenceFolder='';
function publicWork(w){const prefix=w.type+':'+w.id+':',found=presenceFolder===config.folder?presence.get(w.id):null;return {...w,hasHistory:Object.keys(history).some(k=>k.startsWith(prefix)),inFolder:!!found?.existing,bookmarked:bookmarks.some(b=>b.id===w.id),files:w.files.map(({url,...f})=>({...f,hasHistory:!!history[prefix+f.id],inFolder:!!found?.files.find(x=>x.id===f.id)?.existing}))};}
async function scanPresence(){if(!config.folder)throw new Error('저장 폴더를 먼저 선택해 주세요.');const folder=config.folder;const result=await require('./existing').selectMissing(folder,allWorks(),history);if(folder===config.folder){presence=new Map(result.works.map(w=>[w.id,w]));presenceFolder=folder;emit();}return {scanned:result.scanned};}
const settingsFor = uid => config.accounts[uid] || { follow: false, like: false, collect: false, confirmed: false };
function cleanError(e) { return String(e?.message || e).replace(/https?:\/\/\S+/g, '[주소 생략]').replace(/Bearer\s+\S+/gi, '[인증 정보 생략]').slice(0, 400); }
function snapshot() { return { ...state, defaultAuthors, autoTranslate:config.autoTranslate===true, authorBookmarks, busy, job, account: activeUid, settings: settingsFor(activeUid), folder: config.folder, concurrency: config.concurrency, notifyOnComplete: config.notifyOnComplete !== false, dataDir, works:state.works.map(publicWork),bookmarks:bookmarks.map(b=>publicWork(state.works.find(w=>w.id===b.id)||b)) }; }
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
function cachedList(uid, scope) {
  const exact = authorLists[uid + '|' + scope]; if (exact) return { entry: exact, works: exact.works };
  const all = authorLists[uid + '|all']; if (!all || scope === 'all') return null;
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
async function run(task, kind = 'task') { if (busy) throw new Error('작업 중입니다. 완료하거나 취소한 뒤 진행해 주세요.'); busy = true; job = kind; controller = new AbortController(); emit(); try { await task(controller.signal); } catch(e) { log(controller.signal.aborted ? '작업을 취소했습니다. 완료된 계정 행동은 유지됩니다.' : cleanError(e)); } finally { busy = false; job = null; controller = null; await persist(); emit(); } }
function mergeDetail(w, d) { w.author = d.nick_name || w.author; w.authorId = d.user_uid; w.title = d.work_name || w.title; w.cover = d.cover || w.cover; w.date = d.audited_at || w.date; w.rules = C.requirements(d); w.permission = Number(d.download_permission) === 1; w.reason = w.permission ? '' : Number(d.download_type) === 2 ? '작가에게 문의 필요' : Number(d.download_type) === 3 ? '다운로드 미제공' : '배포 기간 또는 접근 제한'; w.detailLoaded = true; }
async function load(url, scope, signal, refresh=false) {
  const uid = C.authorId(url);
  rememberList();
  const cached = refresh ? null : cachedList(uid, scope);
  if (cached) {
    site.closePending(); state = { works: cached.works.map(w => ({ ...w })), author: uid, sourceUrl: url, scope, fetchedAt: cached.entry.fetchedAt, message: '', complete: true };
    log(`저장된 목록 ${state.works.length}개 표시 · ${stamp(cached.entry.fetchedAt)} 조회 · 최신 목록은 새로고침`); await persist(); return;
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
  state.complete = true; state.fetchedAt = new Date().toISOString(); log(`목록 ${state.works.length}개 조회 완료 · 조건은 다운로드 시작 시 확인합니다.`); await persist();

}
async function resolveWork(w, uid, options, signal) {
  C.check(signal); w.attempted=true;w.status = '조건 확인 중'; for(const f of w.files)f.message=''; emit();
  const d = await C.fulfill({ detail: async () => { const d = await site.detail(w, signal, uid); mergeDetail(w,d); if (!w.permission) throw new C.Waiting(w.reason); return d; }, action: (kind, d) => site.action(kind,w,d,signal,uid), options, signal, event: m => { w.status = '조건 처리 중'; log(m,w); } });
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
  for(const w of selected){w.attempted=true;if(w.status!=='완료')w.status='다운로드 대기';}emit();
  const jobs = [];
  for (const w of selected) {
    C.check(signal);
    try {
      // Re-resolve even known files: signed URLs and account conditions can expire.
      await resolveWork(w,a.uid,options,signal);
      let present;if(exclusions.folder)present=(await require('./existing').selectMissing(config.folder,[w],history,signal)).works[0];
      for (const file of w.files.filter(f => f.selected)){if(exclusions.history&&history[w.type+':'+w.id+':'+file.id]||exclusions.folder&&present?.files.find(f=>f.id===file.id)?.existing)continue;jobs.push({w,file});}
    } catch(e) { if (signal.aborted) throw e; w.status = e instanceof C.Waiting ? '사용자 조작 필요' : '실패'; w.message = cleanError(e); log(w.message,w); }
    await persist(); emit();
  }
  let cursor = 0, completed = 0;
  async function worker() {
    while (cursor < jobs.length) {
      C.check(signal); const {w,file} = jobs[cursor++]; const key = `${w.type}:${w.id}:${file.id}`;
      try {
        await site.assertAccount(a.uid); C.check(signal);
        if (await C.validCompleted(history[key])) { file.status = '완료'; file.path = history[key].path; file.size = history[key].size; file.message = '기존 파일 SHA-256 검증 완료 · 건너뜀'; }
        else {
          file.status = '다운로드 중'; w.status = '다운로드 중'; emit();
          const folder = path.resolve(config.folder);
          let result;
          for (let attempt = 0; attempt < 3; attempt++) {
            C.check(signal);
            try { result = await C.download({ fetcher: (u,opts) => fetch(u, { ...opts, headers:{...opts.headers,Referer:C.workUrl(w),'User-Agent':ses.getUserAgent()}, signal: AbortSignal.any([signal,AbortSignal.timeout(30*60*1000)]) }), url: file.url, folder, filename: file.name, expectedSize: file.size, signal, progress: p => { Object.assign(file,p); emit(); } }); break; }
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
          history[key] = result; await atomic('history.json',history); Object.assign(file, { status:'완료', path:result.path, size:result.size, message:'크기 및 SHA-256 기록 완료' }); log(`다운로드 완료: ${file.name}`,w);
        }
      } catch(e) { file.status = signal.aborted ? '취소' : e instanceof C.Waiting ? '사용자 조작 필요' : '실패'; file.message = cleanError(e); }
      completed++; w.status = w.files.filter(f=>f.selected).every(f=>f.status==='완료') ? '완료' : w.files.some(f=>f.status==='실패') ? '실패' : w.files.some(f=>f.status==='사용자 조작 필요') ? '사용자 조작 필요' : '대기';
      state.message = `다운로드 처리 ${completed}/${jobs.length}개`; await persist(); emit();
    }
  }
  const results = await Promise.allSettled(Array.from({length:Math.min(config.concurrency,jobs.length)},worker));
  C.check(signal); for (const r of results) if (r.status === 'rejected') throw r.reason;
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
async function bootstrap() {
  await fs.mkdir(dataDir,{recursive:true});
  config = {...config,...await jsonRead('settings.json',{})};if(!config.autoTranslateChosen)config.autoTranslate=true;translator.setEnabled(config.autoTranslate===true); history = await jsonRead('history.json',{}); authorLists = await jsonRead('author-lists.json',{});
  if(!Number.isSafeInteger(config.concurrency)||config.concurrency<1)config.concurrency=2;
  state = {...state,...await jsonRead('queue.json',{})}; state.works ||= [];
  authorBookmarks=await jsonRead('authors.json',[]);if(!Array.isArray(authorBookmarks))authorBookmarks=[];
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
  win = new BrowserWindow({width:1320,height:900,minWidth:980,minHeight:680,title:'Aplaybox Downloader',backgroundColor:'#e7e7e9',autoHideMenuBar:true,webPreferences:{preload:path.join(__dirname,'preload.js'),nodeIntegration:false,contextIsolation:true,sandbox:true}});
  win.webContents.setWindowOpenHandler(()=>({action:'deny'})); win.webContents.on('will-navigate',e=>e.preventDefault());
  handle('snapshot',()=>snapshot());
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
    if(!Array.isArray(texts)||texts.length>24||texts.some(t=>typeof t!=='string'||t.length>1800))throw new Error('번역 요청이 너무 큽니다.');
    return Promise.all(texts.map(async t=>({original:t,text:await translator.translate(t)})));
  });
  handle('scanPresence',()=>scanPresence());
  handle('bookmark',async id=>{const index=bookmarks.findIndex(w=>w.id===id);if(index>=0)bookmarks.splice(index,1);else{const w=allWorks().find(w=>w.id===id);if(!w)throw new Error('모델을 찾을 수 없습니다.');bookmarks.push(w);}await persist();emit();});
  handle('login',()=>site.login());
  const browser=()=>embeddedBrowser||=(new (require('./browser').EmbeddedBrowser)(win,ses,s=>{if(!win.isDestroyed())win.webContents.send('browser-state',s);},translator));
  const currentAuthor=()=>{try{return C.authorId(browser().current());}catch{throw new Error('사이트에서 작가 이름을 눌러 작가 페이지로 이동해 주세요.');}};
  handle('browse',url=>browser().open(url));
  handle('browserHide',()=>embeddedBrowser?.hide());
  handle('browserAction',action=>browser().action(action));
  handle('browserDownload',async()=>{
    if(busy)throw new Error('현재 다운로드 작업이 끝난 뒤 다시 눌러 주세요.');
    const model=C.modelFromUrl(browser().current());
    const account=await site.assertAccount();
    if(!settingsFor(account.uid).confirmed)throw new Error('목록으로 돌아가 이 계정의 자동 처리 설정을 먼저 저장해 주세요.');
    if(!config.folder)throw new Error('목록으로 돌아가 저장 폴더를 먼저 선택해 주세요.');
    if(busy)throw new Error('현재 작업이 끝난 뒤 다시 눌러 주세요.');
    let w=allWorks().find(w=>w.id===model.id&&Number(w.type)===1);
    if(!w)w={...model,title:'모델 '+model.id,author:'',cover:'',date:'',files:[],rules:[],status:'대기',message:'',detailLoaded:false,permission:null};
    if(!state.works.some(x=>x.id===w.id))state.works.push(w);
    w.selected=true;for(const f of w.files)f.selected=true;
    embeddedBrowser.hide();win.webContents.send('browser-download-started');
    void run(s=>start('download',s,[model.id]),'download');
  });
  handle('browserImport',()=>{
    if(busy)throw new Error('현재 작업이 끝난 뒤 목록을 불러와 주세요.');
    const url='https://www.aplaybox.com/u/'+currentAuthor()+'/model';
    embeddedBrowser.hide();win.webContents.send('author-selected',url);void run(s=>load(url,'all',s),'list');
  });
  handle('authorBookmark',async(url,name)=>{
    const id=url?C.authorId(url):currentAuthor();const canonical='https://www.aplaybox.com/u/'+id+'/model';
    const label=String(name||'').trim().slice(0,100)||state.works.find(w=>String(w.authorId)===id)?.author||('작가 '+id);
    const entry={id,url:canonical,name:label};const i=authorBookmarks.findIndex(a=>a.id===id);if(i<0)authorBookmarks.push(entry);else authorBookmarks[i]=entry;
    await atomic('authors.json',authorBookmarks);emit();return entry;
  });
  handle('authorRemove',async id=>{authorBookmarks=authorBookmarks.filter(a=>a.id!==id);await atomic('authors.json',authorBookmarks);emit();});
  handle('refreshAccount',async()=>{await account(); await saveSession(); emit();});
  handle('logout',async()=>{ if(busy) throw new Error('작업을 취소한 뒤 로그아웃해 주세요.'); site.closePending(); if(site.loginWindow&&!site.loginWindow.isDestroyed()) site.loginWindow.destroy(); for(const w of BrowserWindow.getAllWindows()) if(w!==win) w.destroy(); await ses.clearStorageData(); await sessionSave.catch(()=>{}); await fs.unlink(path.join(dataDir,'session.enc')).catch(()=>{}); activeUid=''; emit(); });
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
  handle('selection',changes=>{if(busy)throw new Error('작업 중에는 선택을 변경할 수 없습니다.');for(const c of changes){const w=allWorks().find(w=>w.id===c.id);if(!w)continue;if(c.fileId){const f=w.files.find(f=>f.id===c.fileId);if(f)f.selected=!!c.selected;w.selected=w.files.some(f=>f.selected);}else {w.selected=!!c.selected;for(const f of w.files)f.selected=!!c.selected;}}emit();});
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
  handle('openPost',id=>{const w=allWorks().find(w=>w.id===id);if(w)return site.open(w);});
  await win.loadFile(path.join(__dirname,'ui/index.html'));
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
