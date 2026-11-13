'use strict';
const { BrowserWindow } = require('electron');
const path = require('node:path');
const { Waiting, pause, check, attachment, workUrl } = require('./core');
// Starts the post's 3D model display: the viewer is an iframe from details.aplaybox.com whose play icon (.icon-ziyuan)
// sits over a blurred preview. Same action as the user clicking it; waits up to ~20 s for the iframe to appear.
const PLAY_SCRIPT = `(async()=>{const tab=[...document.querySelectorAll('.hover_mouse')].find(e=>/모델 디스플레이|模型展示|Model display/i.test(e.textContent||''));if(tab&&!tab.classList.contains('showTypeActive'))tab.click();return true;})()`;
const CLICK_SCRIPT = `(async()=>{for(let n=0;n<40;n++){const i=document.querySelector('.icon-ziyuan');if(i&&i.offsetParent!==null){i.click();return true;}await new Promise(r=>setTimeout(r,250));}return false;})()`;
async function playModel(win){
  const deadline=Date.now()+20000;
  try{
    while(!win.isDestroyed()&&Date.now()<deadline){
      const wc=win.webContents;if(wc.isLoading()){await new Promise(r=>setTimeout(r,300));continue;}
      await wc.executeJavaScript(PLAY_SCRIPT).catch(()=>{});
      const frame=wc.mainFrame.framesInSubtree.find(f=>{try{return new URL(f.url).hostname==='details.aplaybox.com';}catch{return false;}});
      if(frame&&await frame.executeJavaScript(CLICK_SCRIPT).catch(()=>false))return true;
      await new Promise(r=>setTimeout(r,500));
    }
  }catch{/* The post stays open even if the viewer cannot be started. */}
  return false;
}
const API = 'https://api.aplaybox.com/api/web/v1/';
const ENDPOINTS = new Set(['user/getTargetUserWorks','user/getMyBasicInfo','work/getWorkDetails','user/followUser','work/likeWork','work/collectWork']);

// These fields and methods were verified in the public client build 1793871316231.
// Download authorization stays in the original website flow (ads/password/CAPTCHA).
const FIND_COMPONENT = `(() => { const root = document.querySelector('#app')?.__vue__; const walk = v => { if (!v) return null; if (typeof v.downloadAdvertCheck === 'function' && typeof v.doDownloadWork === 'function') return v; for (const c of v.$children || []) { const found = walk(c); if(found) return found; } return null; }; return walk(root); })()`;
const INSTALL_CAPTURE = `(() => {
  const c = ${FIND_COMPONENT}; if (!c || !c.data) return false;
  window.__aplayResult = null;
  if (!window.__aplayHook) {
    window.__aplayHook = true; const open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method,url,...rest) {
      if (String(url).split('?')[0] === 'https://api.aplaybox.com/api/web/v1/work/downloadWorkNewV2') this.addEventListener('load', () => { try { const body = this.responseType === 'json' ? this.response : JSON.parse(this.responseText); window.__aplayResult = body; } catch {} });
      return open.call(this,method,url,...rest);
    };
  }
  c.handleBatchDownload = function() { this.loadingDownLoad = false; };
  return true;
})()`;

class Site {
  constructor(session, log) { this.session = session; this.log = log; this.pending = new Map(); this.previewWindows = new Map(); this.loginWindow = null; this.nextRequest = 0; }
  async identity() {
    const cookies = await this.session.cookies.get({ url: 'https://www.aplaybox.com' });
    return { uid: cookies.find(c => c.name === 'user_uuid_cookie')?.value || '', token: cookies.find(c => c.name === 'access_token_cookie')?.value || '' };
  }
  async assertAccount(uid) { const a = await this.identity(); if (!a.token || !a.uid) throw new Waiting('로그인이 필요합니다. 로그인 버튼을 눌러 직접 로그인한 뒤 재시도해 주세요.'); if (uid && a.uid !== uid) throw new Waiting('계정이 변경되었습니다. 새 계정의 자동 처리 설정을 저장한 뒤 재시도해 주세요.'); return a; }
  async api(endpoint, body, signal, expectedUid) {
    if (!ENDPOINTS.has(endpoint)) throw new Error('허용되지 않은 사이트 요청입니다.');
    const mutation = /followUser|likeWork|collectWork/.test(endpoint);
    for (let attempt = 0; attempt < 3; attempt++) {
      check(signal); await pause(Math.max(0, this.nextRequest - Date.now()), signal); this.nextRequest = Date.now() + 650;
      const a = expectedUid ? await this.assertAccount(expectedUid) : await this.identity();
      const headers = { 'Content-Type': 'application/json', language: 'kr', Origin: 'https://www.aplaybox.com', Referer: 'https://www.aplaybox.com/' };
      if (a.token) { headers.Authorization = `Bearer ${a.token}`; headers.provider = 'users'; }
      let response;
      try { response = await this.session.fetch(API + endpoint, { method: 'POST', headers, body: JSON.stringify(body), signal: AbortSignal.any([signal || new AbortController().signal, AbortSignal.timeout(60000)]) }); }
      catch(e) { if (signal?.aborted) throw e; if (!mutation && attempt < 2) { await pause(1500 * 2 ** attempt, signal); continue; } throw new Error(mutation ? '계정 행동의 응답을 확인하지 못했습니다. 상태를 새로 확인한 뒤 재시도해 주세요.' : '사이트 연결 실패: 네트워크를 확인한 뒤 재시도해 주세요.'); }
      if (response.status === 401) throw new Waiting('로그인이 만료되었습니다. 다시 로그인해 주세요.');
      if (response.status === 429 || response.status >= 500) { if (attempt < 2 && !mutation) { const value = response.headers.get('retry-after'); const ms = value ? (/^\d+$/.test(value) ? Number(value) * 1000 : Date.parse(value) - Date.now()) : 1500 * 2 ** attempt; if (ms > 300000) throw new Waiting('서버가 장시간 대기를 요청했습니다. 나중에 다시 시도해 주세요.'); await pause(Math.max(1000, ms || 1000), signal); continue; } throw new Waiting(`사이트 요청 제한 또는 장애(HTTP ${response.status}). 잠시 후 재시도해 주세요.`); }
      if (!response.ok) throw new Error(`사이트 응답 오류: HTTP ${response.status}`);
      let json; try { json = await response.json(); } catch { throw new Error('사이트가 JSON 대신 다른 응답을 반환했습니다.'); }
      const envelope = json.data;
      if (!envelope || Number(envelope.status) !== 1) throw new Waiting(`사이트에서 요청을 거절했습니다: ${String(envelope?.message || '알 수 없는 응답').replace(/https?:\/\/\S+/g, '[주소 생략]').slice(0, 250)}`);
      return envelope.result;
    }
  }
  async page(uid, type, page, signal) { return (await this.api('user/getTargetUserWorks', { target_user_uid: uid, work_type_id: type, per_page: 20, current_page: page, keyword: '' }, signal)).data; }
  async detail(w, signal, uid) { const a = await this.identity(); return (await this.api('work/getWorkDetails', { work_uuid: w.id, work_type_id: w.type, user_uid: a.uid, is_login: a.token ? 1 : 0 }, signal, uid)).data; }
  async action(kind, w, d, signal, uid) {
    check(signal); await this.assertAccount(uid);
    const endpoint = { follow: 'user/followUser', like: 'work/likeWork', collect: 'work/collectWork' }[kind];
    await this.api(endpoint, kind === 'follow' ? { target_user_uid: d.user_uid } : { work_uuid: w.id, work_type_id: w.type }, signal, uid);
  }
  newWindow(title) {
    const win = new BrowserWindow({ width: 1180, height: 860, title, show: false, autoHideMenuBar: true, webPreferences: { session: this.session, preload:path.join(__dirname,'site-preload.js'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
    const allow = url => { try { const u = new URL(url); return u.protocol === 'https:' && ['www.aplaybox.com','aplaybox.com'].includes(u.hostname); } catch { return false; } };
    win.webContents.setWindowOpenHandler(({ url }) => { if (allow(url)) win.loadURL(url).catch(() => {}); return { action: 'deny' }; });
    win.webContents.on('will-navigate', (e, url) => { if (!allow(url)) e.preventDefault(); });
    return win;
  }
  // The window is shown at once and the page loads inside it; waiting for the whole page first made the button look dead for seconds.
  async login() { const fresh = !this.loginWindow || this.loginWindow.isDestroyed(); if (fresh) this.loginWindow = this.newWindow('Aplaybox · 직접 로그인 (불러오는 중…)'); const w = this.loginWindow; w.show(); w.focus(); if (fresh) w.loadURL('https://www.aplaybox.com/login').catch(e => { if (!w.isDestroyed()) this.log('로그인 페이지를 열지 못했습니다: ' + (e?.message || e)); }); }
  async open(w, {play=false}={}) {
    const old = this.pending.get(w.id); if (old && !old.win.isDestroyed()) { old.win.show(); old.win.focus(); if(play) void playModel(old.win); return; }
    const existing=this.previewWindows.get(w.id);if(existing&&!existing.isDestroyed()){existing.show();existing.focus();if(play) void playModel(existing);return;}
    const win = this.newWindow('Aplaybox · 게시물');this.previewWindows.set(w.id,win); await win.loadURL(workUrl(w)); win.show(); if(play) void playModel(win);
  }
  closePending() { for (const p of this.pending.values()) if (!p.win.isDestroyed()) p.win.destroy(); this.pending.clear(); }
  async resolve(w, d, signal, uid) {
    await this.assertAccount(uid); check(signal);
    let p = this.pending.get(w.id);
    if (p && p.uid !== uid) { if (!p.win.isDestroyed()) p.win.destroy(); this.pending.delete(w.id); p = null; }
    if (p && p.win.isDestroyed()) { this.pending.delete(w.id); p = null; }
    if (!p) {
      const win = this.newWindow('Aplaybox · 다운로드 인증'); p = { win, uid, variant: 0, files: [], started: false }; this.pending.set(w.id, p);
      await win.loadURL(workUrl(w));
    }
    const variants = Number(w.type) === 2 && Number(d.is_zip) === 0 ? [d.content ? 0 : null, d.camera_content ? 1 : null].filter(x => x != null) : [0];
    if (!variants.length) throw new Waiting('게시물에서 다운로드 가능한 파일을 확인하지 못했습니다.');
    for (let index = p.variant; index < variants.length; index++) {
      const variant = variants[index];
      if (!p.started) {
        let ready = false;
        for (let i = 0; i < 80; i++) { check(signal); if (p.win.isDestroyed()) throw new Waiting('인증 창이 닫혔습니다. 재시도해 주세요.'); ready = await p.win.webContents.executeJavaScript(INSTALL_CAPTURE); if (ready) break; await pause(500, signal); }
        if (!ready) { p.win.show(); throw new Waiting('사이트 화면을 읽지 못했습니다. 로그인 또는 사이트 상태를 확인해 주세요.'); }
        // Wait for the site's own ad/account reads; component data can arrive first.
        await p.win.webContents.executeJavaScript(`(async () => { const c = ${FIND_COMPONENT}; await c.getDownloadAdvertisements(); await c.getUserBasicInfo(); return true; })()`);
        await this.assertAccount(uid); check(signal);
        const type = Number(w.type) === 1 ? 1 : Number(d.is_zip) === 1 ? 4 : variant === 1 ? 3 : 2;
        await p.win.webContents.executeJavaScript(`(() => { const c = ${FIND_COMPONENT}; c.downloadAdvertCheck(${type}); return true; })()`);
        p.started = true;
      }
      let result, authWaiting=false, deadline=Date.now()+40000;
      while (Date.now()<deadline) {
        check(signal); await this.assertAccount(uid);
        if (p.win.isDestroyed()) throw new Waiting('인증 창이 닫혔습니다. 재시도해 주세요.');
        const state = await p.win.webContents.executeJavaScript(`(() => { const c = ${FIND_COMPONENT}; return { result: window.__aplayResult, advert: !!c?.showDownloadAdvert, seconds: c?.downloadAdvertTime, password: !!c?.downloadDialog, captcha: !!c?.downloadNeedCapthca, messages: [...document.querySelectorAll('.el-message__content')].map(e=>e.textContent) }; })()`);
        if (state.result) { result = state.result; break; }
        if (state.advert) { p.win.show(); if (Number(state.seconds) <= 0) { check(signal); await p.win.webContents.executeJavaScript(`(() => { const c = ${FIND_COMPONENT}; if (c?.showDownloadAdvert && c.downloadAdvertTime <= 0) c.showDownloadAdvertConfirm(); })()`); } }
        if (state.password || state.captcha) {
          if(!authWaiting){authWaiting=true;deadline=Date.now()+10*60*1000;p.win.show();this.log('사이트 창에서 인증을 완료해 주세요. 완료되면 창을 닫고 다운로드를 자동으로 계속합니다.',w);}
          await pause(500,signal);continue;
        }
        if (state.messages?.length) { p.win.show(); throw new Waiting('사이트 안내를 확인해 주세요: ' + state.messages.join(' / ').slice(0, 200)); }
        await pause(500, signal);
      }
      if (!result) { p.win.show(); throw new Waiting('사이트의 다운로드 응답을 기다리고 있습니다. 열린 창을 확인하고 재개해 주세요.'); }
      const envelope = result.data;
      if (Number(envelope?.status) !== 1) { p.started = false; throw new Waiting('사이트 다운로드 거절: ' + String(envelope?.message || '인증을 다시 확인해 주세요.').slice(0, 200)); }
      const payload = envelope.result;
      if (payload?.work_download_rules_required?.length) { p.started = false; throw new Waiting('아직 충족되지 않은 조건: ' + payload.work_download_rules_required.map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(', ').slice(0, 250)); }
      if (!Array.isArray(payload?.data) || !payload.data.length) { p.started = false; throw new Waiting('첨부 파일 응답을 확인할 수 없습니다. 게시물을 직접 확인해 주세요.'); }
      p.files.push(...payload.data.map(f => attachment(f.url, variant))); p.variant = index + 1; p.started = false;
    }
    const files = [...new Map(p.files.map(f => [f.id, f])).values()];
    p.win.destroy(); this.pending.delete(w.id);
    const preview=this.previewWindows.get(w.id);if(preview&&!preview.isDestroyed())preview.destroy();this.previewWindows.delete(w.id);
    if(this.loginWindow&&!this.loginWindow.isDestroyed())this.loginWindow.destroy();this.loginWindow=null;
    return files;
  }
}
module.exports = { Site, FIND_COMPONENT, INSTALL_CAPTURE };
