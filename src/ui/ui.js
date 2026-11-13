'use strict';
const $=id=>document.getElementById(id);let state={works:[]},lastAccount=null,settingsDirty=false,toastTimer,renderTimer;
let activeTab='all',notificationSaving=false;
const translatedNames=new Map(),translationQueue=new Set();let translationBusy=false,translationSave=false,translationRetry=0,translationEpoch=0;
function translated(value){value=String(value||'');if(!state.autoTranslate)return value;if(translatedNames.has(value))return translatedNames.get(value);if(/[\u3400-\u9fff]/u.test(value)&&!/[\u3040-\u30ff]/u.test(value)&&value.length<=1800){translationQueue.add(value);setTimeout(flushTranslations,0);}return value;}
async function flushTranslations(){
 if(translationBusy||translationSave||!state.autoTranslate||Date.now()<translationRetry||!translationQueue.size)return;
 translationBusy=true;const epoch=translationEpoch;const texts=[...translationQueue].slice(0,40);for(const t of texts)translationQueue.delete(t);
 $('translationStatus').textContent='번역 중…';
 try{const r=await window.aplay.call('translateTexts',texts);if(!r.ok){translationRetry=Date.now()+60000;$('translationStatus').textContent=r.error;for(const t of texts)translationQueue.add(t);setTimeout(flushTranslations,61000);return;}
  if(state.autoTranslate&&epoch===translationEpoch){for(const item of r.value)translatedNames.set(item.original,item.text);$('translationStatus').textContent='';render();}
 }finally{translationBusy=false;if(state.autoTranslate&&translationQueue.size&&Date.now()>=translationRetry)setTimeout(flushTranslations,50);}
}
async function changeTranslation(enabled){translationEpoch++;translationSave=true;try{const r=await window.aplay.call('autoTranslate',enabled);if(!r.ok){toast(r.error);$('browserMessage').textContent=r.error;}else{state.autoTranslate=enabled;translationRetry=0;if(!enabled){translationQueue.clear();$('translationStatus').textContent='';}}}finally{translationSave=false;render();}}

function inProgress(w){return w.status!=='완료'&&(w.attempted||['조건 확인 중','조건 처리 중','파일 확인 중','다운로드 대기','다운로드 중','파일 선택 가능','사용자 조작 필요','실패','취소'].includes(w.status)||w.files.some(f=>['다운로드 중','실패','취소'].includes(f.status)));}
function catalog(){return [...new Map([...(state.bookmarks||[]),...state.works].map(w=>[w.id,w])).values()];}
function tabWorks(){if(activeTab==='bookmarks')return state.bookmarks||[];if(activeTab==='all')return state.works.filter(w=>Number(w.type)!==2);return catalog().filter(w=>activeTab==='progress'?inProgress(w):w.status==='완료');}
const text=(tag,value,cls)=>{const e=document.createElement(tag);e.textContent=value;if(cls)e.className=cls;return e;};
function toast(value){$('toast').textContent=value;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,8000);}
async function call(method,...args){const r=await window.aplay.call(method,...args);if(!r.ok){toast(r.error);return;}return r.value;}
function bytes(n){if(n==null||!Number.isFinite(Number(n)))return '용량 확인 불가';let value=Number(n);for(const unit of ['B','KB','MB','GB','TB']){if(value<1024||unit==='TB')return `${value.toFixed(unit==='B'?0:1)} ${unit}`;value/=1024;}}
function exclusions(){return {history:$('excludeHistory').checked,folder:$('excludeFolder').checked};}
function filtered(){
 const q=$('search').value.toLocaleLowerCase(),filters=[...document.querySelectorAll('[data-filter]:checked')].map(e=>e.dataset.filter),ex=exclusions();
 let works=tabWorks().filter(w=>(w.title+' '+w.files.map(f=>f.name).join(' ')).toLocaleLowerCase().includes(q));
 works=works.filter(w=>!filters.length||filters.some(f=>f==='available'&&w.permission||['follow','like','collect'].includes(f)&&w.rules.some(r=>r.kind===f)||f==='waiting'&&w.status==='사용자 조작 필요'||f==='failed'&&['실패','조회 실패'].includes(w.status)||f==='done'&&w.status==='완료'));
 works=works.flatMap(w=>{if(!w.files.length)return ex.history&&w.hasHistory||ex.folder&&w.inFolder?[]:[w];const files=w.files.filter(f=>!(ex.history&&f.hasHistory)&&!(ex.folder&&f.inFolder));return files.length?[{...w,files}]:[];});
 const s=$('sort').value;return works.sort((a,b)=>s==='title'?a.title.localeCompare(b.title):s==='old'?String(a.date).localeCompare(String(b.date)):String(b.date).localeCompare(String(a.date)));
}
let scanPending=false,scanKey='';
async function refreshPresence(){if(scanPending)return;scanPending=true;$('scanStatus').textContent='저장 폴더 검사 중…';try{const r=await call('scanPresence');$('scanStatus').textContent=r?'파일 '+r.scanned+'개 검사 완료 · 첨부 미확인 자료는 기록과 ID 폴더로 판정합니다.':'검사 실패. 저장 폴더를 확인하고 다시 검사해 주세요.';if(!r)$('excludeFolder').checked=false;}finally{scanPending=false;render();}}

function render(){
 renderAuthorShortcuts();

  if(window.listDragActive)return;
 const filterCount=document.querySelectorAll('#filter input:checked').length;$('activeFilterCount').textContent=filterCount?filterCount+'개 적용':'전체 표시';

  if(!translationSave){$('autoTranslate').checked=!!state.autoTranslate;$('browserTranslate').checked=!!state.autoTranslate;}

  for(const [tab,label,count] of [['all','전체 목록',state.works.length],['progress','다운로드 진행',catalog().filter(inProgress).length],['done','완료',catalog().filter(w=>w.status==='완료').length],['bookmarks','북마크',(state.bookmarks||[]).length]]){const button=$('tab-'+tab);button.textContent=label+' ('+count+')';button.classList.toggle('active',activeTab===tab);button.setAttribute('aria-selected',String(activeTab===tab));}
  if(!notificationSaving)$('notifyOnComplete').checked=state.notifyOnComplete!==false;
  $('translateFileNames').checked=state.translateFileNames===true;
  $('account').textContent=state.account?`계정 ${state.account}`:'로그인하지 않음';$('folder').textContent=state.folder||'저장 폴더를 선택해 주세요.';$('folder').title=state.folder||'';$('message').textContent=state.message||'준비됨';$('count').textContent=`${state.works.length}개${state.complete?'':' · 전체 조회 미확인'}`;$('busy').classList.toggle('active',!!state.busy);
  for(const id of ['refresh','folderBtn','save','start','retry','all','none','filtered','missing','selectAbsent','logout','follow','like','collect','concurrency','scope'])$(id).disabled=false;$('cancel').disabled=!state.busy;
  if(lastAccount!==state.account){lastAccount=state.account;settingsDirty=false;}
  if(!settingsDirty){for(const k of ['follow','like','collect'])$(k).checked=!!state.settings?.[k];$('concurrency').value=String(state.concurrency||2);}
  $('consent').textContent=state.settings?.confirmed?'현재 계정에 저장된 범위로 자동 처리합니다. 설정 변경 후에는 다시 저장해 주세요.':'로그인 후 자동 처리 범위를 저장해 주세요. 모든 옵션을 꺼도 저장할 수 있습니다.';
  const selected=tabWorks().filter(w=>w.selected),files=selected.flatMap(w=>w.files.filter(f=>f.selected)),known=files.filter(f=>f.size!=null),unknown=selected.filter(w=>!w.files.length).length;
  $('summary').textContent=`게시물 ${selected.length}개 · 파일 ${files.length}개 · 확인된 용량 ${bytes(known.reduce((s,f)=>s+Number(f.size),0))}${unknown||known.length<files.length?' + 미확인':''}`;
  const list=$('list'),scroll=list.scrollTop,frag=document.createDocumentFragment();
  for(const w of filtered()){
    const row=text('article','','work'),cb=document.createElement('input');cb.type='checkbox';cb.checked=!!w.selected;cb.indeterminate=w.selected&&w.files.some(f=>!f.selected);cb.disabled=false;cb.setAttribute('aria-label',w.title+' 선택');cb.onchange=()=>call('selection',[{id:w.id,selected:cb.checked}]);row.dataset.workId=w.id;row.append(cb);row.classList.toggle('selected',!!w.selected);
    const img=document.createElement('img');img.className='cover';img.alt='';img.loading='lazy';try{const u=new URL(w.cover);if(u.protocol==='https:'&&u.hostname.endsWith('.aplaybox.com'))img.src=u.href;}catch{}const coverBox=text('div','','cover-box');coverBox.append(img);const play=text('button','','cover-play');play.type='button';play.title='모델 디스플레이 보기';play.setAttribute('aria-label',translated(w.title)+' 모델 디스플레이 보기');play.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6.5v11l9-5.5z"/></svg>';play.onclick=()=>openViewer(w);coverBox.append(play);if(w.isNew){const nb=text('span','NEW','new-badge card-new');coverBox.append(nb);}row.append(coverBox);
    const info=text('div','','info');info.append(Object.assign(text('div',translated(w.title),'title'),{title:w.title}));if(w.date)info.append(text('div',w.date,'meta'));
    if(w.message&&w.message!=='다운로드 시작 시 조건·첨부 파일 확인')info.append(text('div',w.message,'message'));row.append(info);
    const actions=text('div','','actions');const stateEl=text('span',w.status,'state');stateEl.dataset.status=w.status||'';actions.append(stateEl);const bookmark=iconButton(w.bookmarked?'star-fill':'star',w.bookmarked?'북마크 해제':'북마크',w.title,'bookmark-btn'+(w.bookmarked?' on':''));bookmark.setAttribute('aria-pressed',String(!!w.bookmarked));bookmark.onclick=()=>call('bookmark',w.id);actions.append(bookmark);const open=iconButton('open','게시물 열기',w.title);open.onclick=()=>call('openPost',w.id);actions.append(open);if(w.hasHistory||w.inFolder||w.existingPath){const mx=iconButton('max','3ds Max로 임포트',w.title,'max-import');mx.onclick=()=>maxImport([w.id]);actions.append(mx);}if(w.existingPath){const present=text('span','폴더에 있음','badge met');present.title=w.existingPath;actions.append(present);}const again=!!(w.hasHistory||w.existingPath);const dl=iconButton('download',again?'다시 다운로드':'이 자료 다운로드',w.title,'card-download');dl.disabled=!!state.busy;dl.onclick=()=>downloadOne(w);actions.append(dl);row.append(actions);
    if(w.files.length){const container=text('div','','files');for(const f of w.files){const item=text('div','','file'),fc=document.createElement('input');fc.type='checkbox';fc.checked=!!f.selected;fc.disabled=false;fc.setAttribute('aria-label',f.name+' 선택');fc.onchange=()=>call('selection',[{id:w.id,fileId:f.id,selected:fc.checked}]);item.append(fc,text('span',f.name),text('small',`${bytes(f.size||f.total)} · ${f.status}`));if(f.status==='다운로드 중'){const p=document.createElement('progress');if(f.total){p.max=f.total;p.value=f.loaded||0;}item.append(p);item.append(text('small',`${bytes(f.loaded||0)} · ${bytes(f.speed||0)}/s`,'error'));}if(f.message)item.append(text('small',f.message,'error'));container.append(item);}row.append(container);}frag.append(row);
  }
  if(!frag.children.length)frag.append(text('div',state.works.length?'검색 조건에 맞는 자료가 없습니다.':'작가 링크를 넣고 목록을 불러오세요. 목록 조회는 계정 행동을 실행하지 않습니다.','empty'));
  list.replaceChildren(frag);list.scrollTop=scroll;
  if(typeof renderActivity==='function')renderActivity();
}
function update(s){if(!s)return;state=s;const key=JSON.stringify([s.folder,s.busy,catalog().map(w=>[w.id,w.files.length,w.status])]);if($('excludeFolder').checked&&key!==scanKey&&!scanPending){scanKey=key;void refreshPresence();}if(!renderTimer)renderTimer=setTimeout(()=>{renderTimer=null;render();},100);}
window.aplay.onState(update);
window.aplay.onAuthor(url=>{$('embeddedPanel').hidden=true;$('url').value=url;activeTab='all';$('search').value='';render();});
for(const id of ['search','filter','sort'])$(id).addEventListener('input',render);
for(const id of ['follow','like','collect','concurrency'])$(id).addEventListener('change',()=>settingsDirty=true);
$('concurrency').addEventListener('input',()=>settingsDirty=true);
$('refresh').onclick=()=>{if(!$('url').value){toast('작가를 먼저 선택해 주세요.');return;}call('refresh',$('url').value,$('scope').value);};

$('login').onclick=()=>call('login');$('refreshAccount').onclick=()=>call('refreshAccount');$('logout').onclick=()=>call('logout');$('folderBtn').onclick=()=>call('folder');$('openFolder').onclick=()=>call('openFolder');
$('save').onclick=async()=>{const n=Number($('concurrency').value);if(!Number.isSafeInteger(n)||n<1){toast('동시 다운로드 수는 1 이상의 정수로 입력해 주세요.');return;}await call('settings',{follow:$('follow').checked,like:$('like').checked,collect:$('collect').checked,concurrency:Number($('concurrency').value)});settingsDirty=false;update(await call('snapshot'));};
$('all').onclick=()=>call('selection',tabWorks().map(w=>({id:w.id,selected:true})));$('filtered').onclick=()=>call('selection',filtered().map(w=>({id:w.id,selected:true})));$('none').onclick=()=>call('selection',tabWorks().map(w=>({id:w.id,selected:false})));
$('missing').onclick=()=>call('selectMissing',tabWorks().filter(w=>w.selected).map(w=>w.id),'exclude');
$('selectAbsent').onclick=()=>call('selectMissing',filtered().map(w=>w.id),'replace');
function start(mode){if(settingsDirty){toast('변경한 자동 처리 설정을 먼저 저장해 주세요.');return;}if(scanPending){toast('폴더 검사 완료 후 다운로드해 주세요.');return;}call('start',mode,filtered().filter(w=>w.selected).map(w=>w.id),exclusions());}
async function downloadOne(w){if(state.busy){toast('진행 중인 작업이 끝난 뒤 다운로드해 주세요.');return;}if(settingsDirty){toast('변경한 자동 처리 설정을 먼저 저장해 주세요.');return;}if((w.hasHistory||w.existingPath)&&!await appConfirm('이미 받은 자료입니다. 다시 다운로드할까요?',{title:'다시 다운로드',ok:'다시 받기'}))return;if(!w.selected){const r=await window.aplay.call('selection',[{id:w.id,selected:true}]);if(!r.ok){toast(r.error);return;}}call('start','download',[w.id],{history:false,folder:false});}
$('start').onclick=()=>start('download');$('retry').onclick=()=>start('download');$('cancel').onclick=()=>call('cancel');
call('snapshot').then(s=>{if(s?.sourceUrl)$('url').value=s.sourceUrl;else if(s?.author)$('url').value=`https://www.aplaybox.com/u/${s.author}/model`;update(s);});window.addEventListener('focus',()=>call('refreshAccount'));

// 썸네일 보기: 3단계(열 수 + 높이) 아이콘, … 에서 높이 세부 조절
let listColumns=Number(localStorage.getItem('listColumns')||4);
const DENSITY={large:{columns:3,size:340},medium:{columns:4,size:260},small:{columns:6,size:180}};
let thumbnailPx=Number(localStorage.getItem('thumbnailPx'));
if(!Number.isFinite(thumbnailPx)||thumbnailPx<160||thumbnailPx>480){const i=localStorage.getItem('thumbnailSizeIndex');thumbnailPx=(i!==null&&[72,120,180,260,360][Number(i)])||260;}
function markDensity(){for(const b of document.querySelectorAll('.thumbnail-controls [data-density]')){const p=DENSITY[b.dataset.density];const on=!!p&&p.columns===listColumns&&p.size===thumbnailPx;b.classList.toggle('active',on);b.setAttribute('aria-pressed',String(on));}}
let thumbnailRatio=Number(localStorage.getItem('thumbnailRatio'));if(!Number.isFinite(thumbnailRatio)||thumbnailRatio<50||thumbnailRatio>160)thumbnailRatio=100;
function resizeThumbnails(){
  document.documentElement.style.setProperty('--thumbnail-size',thumbnailPx+'px');
  document.documentElement.style.setProperty('--thumbnail-height',Math.round(thumbnailPx*thumbnailRatio/100)+'px');
  $('thumbnailRatio').value=String(thumbnailRatio);$('thumbnailRatioLabel').textContent=thumbnailRatio+'%';
  try{localStorage.setItem('thumbnailRatio',String(thumbnailRatio));}catch{}
  $('thumbnailSize').textContent=listColumns+'열 · '+thumbnailPx+'px';$('thumbnailRange').value=String(thumbnailPx);
  try{localStorage.setItem('thumbnailPx',String(thumbnailPx));}catch{}
  markDensity();
}
$('thumbnailRatio').oninput=()=>{thumbnailRatio=Number($('thumbnailRatio').value);resizeThumbnails();};
function columnsFor(px){return Math.max(2,Math.min(6,Math.round(1060/px)));}
$('thumbnailRange').oninput=()=>{thumbnailPx=Number($('thumbnailRange').value);const c=columnsFor(thumbnailPx);if(c!==listColumns){listColumns=c;try{localStorage.setItem('listColumns',String(c));}catch{}applyColumns();}resizeThumbnails();};
for(const b of document.querySelectorAll('.thumbnail-controls [data-density]'))b.onclick=()=>{const p=DENSITY[b.dataset.density];listColumns=p.columns;try{localStorage.setItem('listColumns',String(listColumns));}catch{}applyColumns();thumbnailPx=p.size;resizeThumbnails();};
$('densityMore').onclick=e=>{e.stopPropagation();const p=$('densityPanel');p.hidden=!p.hidden;$('densityMore').setAttribute('aria-expanded',String(!p.hidden));};
document.addEventListener('mousedown',e=>{if(!$('densityPanel').hidden&&!e.target.closest('.density-more')){$('densityPanel').hidden=true;$('densityMore').setAttribute('aria-expanded','false');}});
resizeThumbnails();
for(const tab of ['all','progress','done','bookmarks'])$('tab-'+tab).onclick=()=>{activeTab=tab;render();$('list').scrollTop=0;};

$('excludeFolder').onchange=()=>{if($('excludeFolder').checked)void refreshPresence();else render();};
$('excludeHistory').onchange=render;
$('rescanFolder').onclick=()=>refreshPresence();

function setupCollapse(buttonId, panelIds, key, label){
 const button=$(buttonId);let collapsed=localStorage.getItem(key)==='true';
 function apply(){for(const id of panelIds)$(id).hidden=collapsed;button.setAttribute('aria-expanded',String(!collapsed));button.textContent=label+(collapsed?' 펼치기 ▾':' 접기 ▴');}
 button.onclick=()=>{collapsed=!collapsed;localStorage.setItem(key,String(collapsed));apply();};apply();
}
setupCollapse('toggleSetup',['appHeader','defaultAuthorButtons'],'setupCollapsed','상단 설정');


if(!Number.isInteger(listColumns)||listColumns<1||listColumns>6)listColumns=4;
function applyColumns(){document.documentElement.style.setProperty('--list-columns',String(listColumns));document.documentElement.dataset.columns=String(listColumns);markDensity();if($('thumbnailSize'))$('thumbnailSize').textContent=listColumns+'열 · '+thumbnailPx+'px';}
applyColumns();

window.aplay.onFinished(result=>toast(result.title+' · '+result.body));

$('notifyOnComplete').onchange=async()=>{
 notificationSaving=true;
 try{await call('completionNotification',$('notifyOnComplete').checked);const s=await call('snapshot');if(s)update(s);}
 finally{notificationSaving=false;render();}
};

async function openEmbedded(url){$('embeddedPanel').hidden=false;$('browserMessage').textContent='페이지 여는 중…';const r=await window.aplay.call('browse',url);if(!r.ok)$('browserMessage').textContent=r.error;else $('browserMessage').textContent='';}
$('browserClose').onclick=async()=>{await call('browserHide');$('embeddedPanel').hidden=true;};
for(const [id,action] of [['browserBack','back'],['browserForward','forward'],['browserReload','reload']])$(id).onclick=()=>call('browserAction',action);
$('browserHome').onclick=()=>openEmbedded('https://www.aplaybox.com/');
async function browserCall(method,...args){const r=await window.aplay.call(method,...args);$('browserMessage').textContent=r.ok?'완료':r.error;}
$('browserImport').onclick=()=>browserCall('browserImport');
$('browserBookmark').onclick=()=>browserCall('authorBookmark',null,$('browserBookmarkName').value);
window.aplay.onBrowser(s=>{
 $('browserUrl').textContent=s.url;$('browserUrl').title=s.title;if(s.translationError)$('browserMessage').textContent=s.translationError;
 let model=false;try{const u=new URL(s.url);model=/^\/details\/model\/[A-Za-z0-9_-]+\/?$/.test(u.pathname)&&['www.aplaybox.com','aplaybox.com'].includes(u.hostname);}catch{}
 $('browserDownload').hidden=!model;
});
$('browserDownload').onclick=()=>{if(settingsDirty){$('browserMessage').textContent='목록으로 돌아가 변경한 자동 처리 설정을 먼저 저장해 주세요.';return;}browserCall('browserDownload');};
window.aplay.onBrowserDownload(()=>{$('embeddedPanel').hidden=true;activeTab='progress';$('search').value='';for(const e of document.querySelectorAll('[data-filter]'))e.checked=false;$('excludeHistory').checked=false;$('excludeFolder').checked=false;render();});

$('autoTranslate').onchange=()=>changeTranslation($('autoTranslate').checked);
$('browserTranslate').onchange=()=>changeTranslation($('browserTranslate').checked);

for(const id of ['filterDetails']){const panel=$(id);panel.open=localStorage.getItem('readability-'+id)==='true';panel.addEventListener('toggle',()=>localStorage.setItem('readability-'+id,String(panel.open)));}

function updateBackToTop(){
 const embedded=!$('embeddedPanel').hidden,button=$('backToTop'),dock=$('floatingDock');button.hidden=window.scrollY<240||embedded;
 const footer=document.querySelector('footer'),rect=footer.getBoundingClientRect();
 // The floating dock replaces the footer controls while the footer's buttons are scrolled out of view.
 const footerVisible=rect.top<innerHeight&&rect.bottom>0,rowRect=footer.querySelector('.row').getBoundingClientRect();
 if(dock)dock.hidden=embedded||dock.classList.contains('empty')||(rowRect.bottom<=innerHeight&&rowRect.top>=0);
 const bottom=dock&&!dock.hidden?24+dock.offsetHeight+10:footerVisible?Math.max(24,innerHeight-rect.top+12):24;
 button.style.bottom=bottom+'px';
}
window.addEventListener('resize',updateBackToTop);
const backToTopLayout=new ResizeObserver(updateBackToTop);
backToTopLayout.observe(document.querySelector('main'));
backToTopLayout.observe(document.querySelector('footer'));
if($('floatingDock'))backToTopLayout.observe($('floatingDock'));
window.addEventListener('scroll',updateBackToTop,{passive:true});
new MutationObserver(updateBackToTop).observe($('embeddedPanel'),{attributes:true,attributeFilter:['hidden']});
$('backToTop').onclick=()=>window.scrollTo({top:0,behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
updateBackToTop();
// 3ds Max import (bundled ImportMMD) and its settings dialog.
async function maxImport(ids){if(!ids.length){toast('임포트할 배포 자료를 선택해 주세요.');return;}const r=await window.aplay.call('maxImport',ids);if(!r.ok)toast(r.error);}
$('maxImport').onclick=()=>maxImport(selectedWorks().map(w=>w.id));
function maxPathText(mode,p,auto){return mode===2&&p?'직접 지정 · '+p:auto;}
function renderMaxConfig(c){
 $('maxPathMax').textContent=c.max.custom?'직접 지정 · '+c.max.path:c.max.path?'자동 탐색 · '+c.max.path:'설치된 3ds Max를 찾지 못했습니다. 찾아보기로 지정해 주세요.';
 $('maxPathBlender').textContent=maxPathText(c.blender.mode,c.blender.path,'자동 탐색'+(c.blender.verified?' · 확인됨 '+c.blender.verified:' · 첫 임포트 때 확인'));
 $('maxPathBz').textContent=maxPathText(c.bz.mode,c.bz.path,'자동 탐색'+(c.bz.path?' · '+c.bz.path:''));
 $('maxBridgeState').textContent=c.bridge.length?c.bridge.map(b=>`${b.year} ${b.lang}: ${b.current?'설치됨':b.installed?'이전 버전 (설치 / 갱신 필요)':'미설치'}`).join(' · '):'3ds Max 사용자 폴더가 없습니다. Max를 한 번 실행한 뒤 다시 확인해 주세요.';
 $('maxBridgeRemove').disabled=!c.bridge.some(b=>b.installed);
}
async function maxConfig(op,key){const r=await window.aplay.call('maxConfig',op,key);if(!r.ok){toast(r.error);return null;}renderMaxConfig(r.value);return r.value;}
$('maxSettingsBtn').onclick=async()=>{if(await maxConfig('get'))$('maxDialog').showModal();};
for(const b of document.querySelectorAll('#maxDialog [data-max]'))b.onclick=()=>maxConfig(b.dataset.op,b.dataset.max);
$('maxBridgeInstall').onclick=()=>maxConfig('install');$('maxBridgeRemove').onclick=()=>maxConfig('remove');$('maxOpenData').onclick=()=>maxConfig('open');$('maxDialogClose').onclick=()=>$('maxDialog').close();
// Translations saved by earlier runs: show them immediately instead of translating the same titles again.
window.aplay.call('translationCache').then(r=>{if(!r.ok||!r.value)return;for(const [k,v] of Object.entries(r.value))if(!translatedNames.has(k))translatedNames.set(k,v);render();}).catch(()=>{});
// 번역 엔진 설정 (Google / Claude Code)
let trState=null;
function renderTranslationEngine(s){trState=s;
 const claude=s.engine==='claude';const model=s.model==='sonnet'?'Sonnet':'Haiku';
 $('trSummary').textContent=claude?`Claude ${model} (Claude Code)`+(s.error?' · '+s.error:''):'Google 번역 (기본)';
 $('trQuick').value=claude?'claude:'+s.model:'google';$('trQuick').title=(claude?'Claude '+model+' (Claude Code)':'Google 번역')+(s.error?' · '+s.error:'')+' · 자세한 설정은 ⚙ 설정 → 번역 설정'; $('trEngine').value=s.engine;$('trModel').value=s.model;$('trModel').disabled=!claude;
 $('trClaudePath').textContent=s.claudePath?'직접 지정 · '+s.claudePath:s.detected?'자동 탐색 · '+s.detected:'Claude Code를 찾지 못했습니다. Claude 데스크탑 앱을 설치하거나 claude.exe를 지정해 주세요.';
 const wait=s.cooldownUntil?` · ${Math.max(1,Math.ceil((s.cooldownUntil-Date.now())/60000))}분 동안 Google로 대신 번역`:'';
 $('trState').textContent=s.test?(s.test.ok?`연결됨 · ${(s.test.ms/1000).toFixed(1)}초 · 예: ${s.test.text}`:s.test.error):s.error?s.error+wait:claude?'사용 중'+wait:'Google 번역 사용 중';
 $('trCached').textContent=`${s.cached.toLocaleString()}개 저장됨`;
}
async function translationEngine(op,value){const r=await window.aplay.call('translationEngine',op,value);if(!r.ok){toast(r.error);return null;}renderTranslationEngine(r.value);if(op!=='get'&&op!=='test'){translationRetry=0;}return r.value;}
$('trSettingsBtn').onclick=async()=>{if(await translationEngine('get'))$('trDialog').showModal();};
$('trEngine').onchange=()=>void switchEngine($('trEngine').value,trState?.model);
$('trModel').onchange=()=>{if(trState?.engine==='claude')void switchEngine('claude',$('trModel').value);else void translationEngine('model',$('trModel').value);};
$('trBrowse').onclick=()=>translationEngine('browse');$('trAuto').onclick=()=>translationEngine('auto');
$('trTest').onclick=async()=>{const b=$('trTest');b.disabled=true;$('trState').textContent='시험 중… (최대 수십 초)';try{await translationEngine('test');}finally{b.disabled=false;}};
$('trGlossary').onclick=()=>translationEngine('glossary');
$('trClear').onclick=async()=>{if(!await appConfirm('저장된 번역을 모두 지우고 다시 번역할까요?',{title:'저장된 번역 지우기',ok:'지우기',danger:true}))return;if(await translationEngine('clear')){translatedNames.clear();translationEpoch++;render();}};
$('trDialogClose').onclick=()=>$('trDialog').close();
window.aplay.call('translationEngine','get').then(r=>{if(r.ok)renderTranslationEngine(r.value);}).catch(()=>{});

// 작가 바로가기 줄: 기본 작가 + 내 북마크(★) + 현재 작가 북마크 추가 + 더 찾아보기
const AUTHOR_FOLD=8;let authorShortcutKey='';
function authorExpanded(){try{return localStorage.getItem('authorShortcutsExpanded')==='true';}catch{return false;}}
async function loadAuthorShortcut(a){
 if(state.busy){toast('현재 작업이 끝난 뒤 작가를 전환해 주세요.');return;}
 const result=await window.aplay.call('load',a.url,$('scope').value);if(!result.ok){toast(result.error);return;}
 $('url').value=a.url;activeTab='all';$('search').value='';render();
}
function currentAuthorName(){const w=(state.works||[]).find(w=>String(w.authorId)===String(state.author||''));return w?translated(w.author):'';}
function renderAuthorShortcuts(){
 const box=$('defaultAuthorButtons');const defaults=state.defaultAuthors||[],saved=state.authorBookmarks||[];
 const known=new Set([...defaults,...saved].map(a=>String(a.id)));const cur=String(state.author||'');const canAdd=!!cur&&!known.has(cur);
 const key=JSON.stringify([defaults.map(a=>a.id),saved.map(a=>[a.id,translated(a.name),state.authorNew?.[a.id]||0]),canAdd,authorExpanded()]);
 if(key!==authorShortcutKey&&(defaults.length||saved.length||canAdd)){
  authorShortcutKey=key;const frag=document.createDocumentFragment();
  const mk=(a,isSaved)=>{const name=isSaved?translated(a.name):a.name;const b=text('button',(isSaved?'★ ':'')+name,'quiet'+(isSaved?' saved-author':''));b.type='button';b.dataset.authorId=a.id;b.title=name+' 자료 목록 불러오기'+(isSaved?' · 우클릭: 이름 변경·탐색기에서 열기·삭제':' · 우클릭: 탐색기에서 열기');b.onclick=()=>loadAuthorShortcut(a);b.oncontextmenu=e=>{e.preventDefault();openAuthorDialog(isSaved?'edit':'view',a);};return b;};
  for(const a of defaults)frag.append(mk(a,false));
  const expanded=authorExpanded(),shown=expanded?saved:saved.slice(0,AUTHOR_FOLD);
  for(const a of shown){const chip=text('span','','author-chip');chip.append(mk(a,true));const n=state.authorNew?.[a.id];if(n){chip.classList.add('has-new');const nb=text('span','NEW','new-badge');nb.title='새 모델 '+n+'개';chip.append(nb);}const x=text('button','✕','author-remove');x.type='button';x.title='북마크 삭제';x.setAttribute('aria-label',translated(a.name)+' 북마크 삭제');x.onclick=()=>removeAuthorBookmark(a);chip.append(x);frag.append(chip);}
  if(saved.length>AUTHOR_FOLD){const t=text('button',expanded?'접기 ▴':'+'+(saved.length-AUTHOR_FOLD)+'개 더보기 ▾','quiet author-fold');t.type='button';t.onclick=()=>{try{localStorage.setItem('authorShortcutsExpanded',String(!expanded));}catch{}authorShortcutKey='';renderAuthorShortcuts();};frag.append(t);}
  if(canAdd){const add=text('button','＋ 현재 작가 북마크','quiet add-author');add.type='button';add.title='지금 불러온 작가를 바로가기에 추가';add.onclick=()=>openAuthorDialog('add',{id:cur,name:currentAuthorName()});frag.append(add);}
  const more=text('button','더 찾아보기 →','quiet more-authors');more.type='button';more.title='내장 Aplaybox 탐색기에서 작가 목록 페이지 열기';more.onclick=()=>openEmbedded('https://www.aplaybox.com/author');frag.append(more);const help=text('button','','help-btn');help.type='button';help.title='사용 방법';help.setAttribute('aria-label','사용 방법');help.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 1 1 3.6 2.3c-.8.4-1.2 1-1.2 1.8v.4"/><circle cx="12" cy="17" r=".6" fill="currentColor"/></svg>';let helpSeen=false;try{helpSeen=localStorage.getItem('helpSeen')==='1';}catch{}if(!helpSeen)help.classList.add('attention');help.onclick=()=>{try{localStorage.setItem('helpSeen','1');}catch{}help.classList.remove('attention');$('helpDialog').showModal();};frag.append(help);const site=text('button','Aplaybox 탐색','browse-site');site.id='browse';site.type='button';site.title='내장 Aplaybox 탐색기 열기';site.onclick=()=>openEmbedded();frag.append(site);
  box.replaceChildren(frag);
 }
 for(const button of box.querySelectorAll('button[data-author-id]')){const active=cur===button.dataset.authorId;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));}
}
let authorDialogTarget=null;
function openAuthorDialog(mode,a){
 authorDialogTarget={mode,a};const d=$('authorDialog');
 $('authorDialogTitle').textContent=mode==='add'?'작가 북마크 추가':mode==='edit'?'작가 북마크 편집':a.name;
 $('authorDialogName').value=mode==='view'?'':(mode==='add'?a.name:translated(a.name))||'';
 $('authorDialogNameRow').hidden=mode==='view';$('authorDialogSave').hidden=mode==='view';$('authorDialogSave').textContent=mode==='add'?'추가':'이름 저장';
 $('authorDialogRemove').hidden=mode!=='edit';$('authorDialogBrowse').hidden=mode==='add';
 d.showModal();if(mode!=='view'){$('authorDialogName').focus();$('authorDialogName').select();}
}
async function removeAuthorBookmark(a){if(!await appConfirm("'"+translated(a.name)+"' 작가 북마크를 삭제할까요?",{title:'북마크 삭제',ok:'삭제',danger:true}))return false;const r=await window.aplay.call('authorRemove',a.id);if(!r.ok){toast(r.error);return false;}toast('작가 북마크 삭제 완료');return true;}
$('authorDialogForm').onsubmit=async e=>{e.preventDefault();const t=authorDialogTarget;if(!t||t.mode==='view')return;
 const url=t.mode==='add'?($('url').value||null):t.a.url;const r=await window.aplay.call('authorBookmark',url,$('authorDialogName').value);if(!r.ok){toast(r.error);return;}
 $('authorDialog').close();toast(t.mode==='add'?'작가 북마크 추가 완료':'이름 변경 완료');};
$('authorDialogBrowse').onclick=()=>{const t=authorDialogTarget;$('authorDialog').close();if(t)openEmbedded(t.a.url);};
$('authorDialogRemove').onclick=async()=>{const t=authorDialogTarget;if(t&&await removeAuthorBookmark(t.a))$('authorDialog').close();};
$('authorDialogCancel').onclick=()=>$('authorDialog').close();

// 카드 동작 아이콘 버튼 (이름은 툴팁·스크린리더용 aria-label)
const ICONS={
 star:'<path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.6 9.7l5.8-.8z"/>',
 'star-fill':'<path class="fill" d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.6 9.7l5.8-.8z"/>',
 open:'<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
 max:'<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z M12 12l8-4.5 M12 12v9 M12 12L4 7.5"/>',
 download:'<path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14"/>'
};
function iconButton(icon,label,title,cls=''){const b=text('button','','quiet icon-btn'+(cls?' '+cls:''));b.type='button';b.title=label;b.setAttribute('aria-label',translated(title)+' '+label);b.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true">'+ICONS[icon]+'</svg>';return b;}

// 설정 창 (헤더 톱니 아이콘)
$('settingsBtn').onclick=()=>{$('settingsDialog').showModal();void refreshClaudeAccount();};$('settingsDialogClose').onclick=()=>$('settingsDialog').close();
$('trQuick').onchange=()=>{const [engine,model]=$('trQuick').value.split(':');void switchEngine(engine,model);};

// 메인 화면 안 모델 디스플레이 뷰어 (WebContentsView를 #viewerStage 위치에 겹쳐 표시)
let viewerWork=null;
function viewerRect(){const r=$('viewerStage').getBoundingClientRect();return {x:r.left,y:r.top,width:r.width,height:r.height};}
async function openViewer(w){
  viewerWork=w;$('viewerTitle').textContent=translated(w.title)||'모델 디스플레이';$('viewerStatus').textContent='불러오는 중…';
  $('viewerOverlay').hidden=false;$('viewerOverlay').dataset.status='loading';
  await new Promise(r=>requestAnimationFrame(()=>r()));
  const r=await window.aplay.call('viewerOpen',w.id,viewerRect());
  if(!r.ok){$('viewerStatus').textContent=r.error;$('viewerOverlay').dataset.status='error';}
}
function closeViewer(){if($('viewerOverlay').hidden)return;$('viewerOverlay').hidden=true;viewerWork=null;void window.aplay.call('viewerClose');}
window.aplay.onViewer(s=>{if(!viewerWork||s.id!==viewerWork.id)return;$('viewerOverlay').dataset.status=s.status;$('viewerStatus').textContent=s.status==='ready'?'':s.status==='loading'?('모델 불러오는 중'+(s.percent?' '+s.percent:'')+'…'):(s.error||'오류');});
$('viewerClose').onclick=closeViewer;
$('viewerPost').onclick=()=>{const w=viewerWork;if(!w)return;closeViewer();call('openPost',w.id,true);};
$('viewerDownload').onclick=()=>{const w=viewerWork;if(!w)return;closeViewer();void downloadOne(w);};
$('viewerOverlay').addEventListener('mousedown',e=>{if(e.target===$('viewerOverlay'))closeViewer();});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('viewerOverlay').hidden){e.preventDefault();closeViewer();}});
new ResizeObserver(()=>{if(!$('viewerOverlay').hidden)void window.aplay.call('viewerBounds',viewerRect());}).observe($('viewerStage'));
$('helpClose').onclick=()=>$('helpDialog').close();
$('helpDialog').addEventListener('click',e=>{if(e.target===$('helpDialog'))$('helpDialog').close();});
document.addEventListener('mousedown',e=>{const d=$('filterDetails');if(d.open&&!d.contains(e.target))d.open=false;});

async function switchEngine(engine,model){
  model=model||trState?.model||'haiku';
  const key=engine==='claude'?'claude:'+model:'google',now=trState?(trState.engine==='claude'?'claude:'+trState.model:'google'):'';
  if(key===now){if(trState)renderTranslationEngine(trState);return;}
  const label=engine==='claude'?'Claude '+model[0].toUpperCase()+model.slice(1):'Google 번역';const ro=label+({'Google 번역':'으로','Claude Sonnet':'으로'}[label]||'로');
  const saved=trState?.saved?.[key]||0;
  const fresh=await appConfirm(ro+' 바꿉니다. 이미 번역된 항목도 '+ro+' 다시 번역할까요?'+(saved?'\n'+ro+' 저장된 번역 '+saved+'개는 바로 불러옵니다.':''),
    {title:'번역 엔진 변경',ok:'새로 번역',cancel:'기존 번역 유지',note:engine==='claude'?'Claude 번역은 본인 Claude 계정(Claude 데스크탑 앱에 로그인한 계정)의 사용량을 소모합니다.':''});
  if(fresh===null){if(trState)renderTranslationEngine(trState);return;}
  const r=await translationEngine('switch',{engine,model,fresh});if(!r)return;
  translationEpoch++;translationQueue.clear();translatedNames.clear();translationRetry=0;
  const c=await window.aplay.call('translationCache').catch(()=>null);if(c?.ok&&c.value)for(const [k,v] of Object.entries(c.value))translatedNames.set(k,v);
  render();toast(ro+(fresh?' 다시 번역합니다.':' 바꿨습니다. 새 항목부터 적용됩니다.'));
}

// 설정 창: 연결된 Claude 계정 표시·로그아웃
function showClaudeAccount(a){
  const plan=a?.plan?' ('+a.plan[0].toUpperCase()+a.plan.slice(1)+')':'';
  $('claudeAccount').textContent=a?.loggedIn?'Claude 계정: '+(a.email||'로그인됨')+plan:'Claude 계정: 로그인하지 않음 (Claude 데스크탑 앱에서 로그인)';
  $('claudeLogout').hidden=!a?.loggedIn;
}
async function refreshClaudeAccount(){
  $('claudeAccount').textContent='Claude 계정 확인 중…';$('claudeLogout').hidden=true;
  const r=await window.aplay.call('claudeAccount','status');
  if(!r.ok){$('claudeAccount').textContent='Claude 계정: 확인할 수 없음 ('+r.error+')';return;}
  showClaudeAccount(r.value);
}
$('claudeLogout').onclick=async()=>{
  if(!await appConfirm('이 PC의 Claude Code 로그인을 해제합니다. Claude 데스크탑 앱의 Code 탭도 함께 로그아웃되며, 다시 쓰려면 Claude 데스크탑 앱에서 로그인해야 합니다.',{title:'Claude 계정 로그아웃',ok:'로그아웃',danger:true}))return;
  $('claudeLogout').disabled=true;
  try{const r=await window.aplay.call('claudeAccount','logout');if(!r.ok){toast(r.error);return;}showClaudeAccount(r.value);toast('Claude 계정에서 로그아웃했습니다. Claude 번역은 Google 번역으로 대체됩니다.');}
  finally{$('claudeLogout').disabled=false;}
};
$('translateFileNames').onchange=async()=>{const r=await window.aplay.call('fileNameTranslation',$('translateFileNames').checked);if(!r.ok){toast(r.error);$('translateFileNames').checked=!$('translateFileNames').checked;}};
