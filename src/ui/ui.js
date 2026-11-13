'use strict';
const $=id=>document.getElementById(id);let state={works:[]},lastAccount=null,settingsDirty=false,toastTimer,renderTimer;
let activeTab='all',notificationSaving=false,loginNeeded=false;
const translatedNames=new Map(),translationQueue=new Set();let translationBusy=false,translationSave=false,translationRetry=0,translationEpoch=0;
function translated(value){value=String(value||'');if(!state.autoTranslate)return value;if(translatedNames.has(value))return translatedNames.get(value);if(/[\u3400-\u9fff]/u.test(value)&&!/[\u3040-\u30ff]/u.test(value)&&value.length<=1800){translationQueue.add(value);setTimeout(flushTranslations,0);}return value;}
async function flushTranslations(){
 if(translationBusy||translationSave||!state.autoTranslate||Date.now()<translationRetry||!translationQueue.size)return;
 translationBusy=true;const epoch=translationEpoch;const texts=[...translationQueue].slice(0,trState&&trState.engine!=='google'?16*(trState.parallel||3):40);for(const t of texts)translationQueue.delete(t);
 $('translationStatus').textContent='번역 중…';
 try{const r=await window.aplay.call('translateTexts',texts);if(!r.ok){translationRetry=Date.now()+60000;$('translationStatus').textContent=r.error;for(const t of texts)translationQueue.add(t);setTimeout(flushTranslations,61000);return;}
  if(state.autoTranslate&&epoch===translationEpoch){for(const item of r.value)translatedNames.set(item.original,item.text);$('translationStatus').textContent='';render();}
 }finally{translationBusy=false;if(state.autoTranslate&&translationQueue.size&&Date.now()>=translationRetry)setTimeout(flushTranslations,50);}
}
async function changeTranslation(enabled){translationEpoch++;translationSave=true;try{const r=await window.aplay.call('autoTranslate',enabled);if(!r.ok){toast(r.error);$('browserMessage').textContent=r.error;}else{state.autoTranslate=enabled;translationRetry=0;if(!enabled){translationQueue.clear();$('translationStatus').textContent='';}}}finally{translationSave=false;render();}}

function inProgress(w){return w.status!=='완료'&&(w.attempted||['조건 확인 중','조건 처리 중','파일 확인 중','다운로드 대기','다운로드 중','파일 선택 가능','사용자 조작 필요','실패','취소'].includes(w.status)||w.files.some(f=>['다운로드 중','실패','취소'].includes(f.status)));}
function catalog(){return [...new Map([...(state.bookmarks||[]),...state.works].map(w=>[w.id,w])).values()];}
function tabWorks(){if(activeTab==='bookmarks')return state.bookmarks||[];if(activeTab==='all')return state.works.filter(w=>Number(w.type)!==2);if(activeTab==='imported')return catalog().filter(w=>w.maxImport?.state==='done');return catalog().filter(w=>activeTab==='progress'?inProgress(w):w.status==='완료');}
const text=(tag,value,cls)=>{const e=document.createElement(tag);e.textContent=value;if(cls)e.className=cls;return e;};
function toast(value){$('toast').textContent=value;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,8000);}
async function call(method,...args){const r=await window.aplay.call(method,...args);if(!r.ok){toast(r.error);return;}return r.value;}
function bytes(n){if(n==null||!Number.isFinite(Number(n)))return '용량 확인 불가';let value=Number(n);for(const unit of ['B','KB','MB','GB','TB']){if(value<1024||unit==='TB')return `${value.toFixed(unit==='B'?0:1)} ${unit}`;value/=1024;}}
function exclusions(){return {history:$('excludeHistory').checked,folder:$('excludeFolder').checked};}
function filtered(){
 const q=$('search').value.toLocaleLowerCase(),filters=[...document.querySelectorAll('[data-filter]:checked')].map(e=>e.dataset.filter),ex=exclusions();
 let works=tabWorks().filter(w=>(w.title+' '+w.files.map(f=>f.name).join(' ')).toLocaleLowerCase().includes(q));
 works=works.filter(w=>!filters.length||filters.some(f=>f==='failed'&&['실패','조회 실패'].includes(w.status)));
 // 완료된 모델 제외 (완료 자료를 모아 보는 탭에서는 적용하지 않음)
 if($('excludeDone').checked&&!['done','imported'].includes(activeTab))works=works.filter(w=>w.status!=='완료');
 works=works.flatMap(w=>{if(!w.files.length)return ex.history&&w.hasHistory||ex.folder&&w.inFolder?[]:[w];const files=w.files.filter(f=>!(ex.history&&f.hasHistory)&&!(ex.folder&&f.inFolder));return files.length?[{...w,files}]:[];});
 const s=$('sort').value;return works.sort((a,b)=>s==='title'?a.title.localeCompare(b.title):s==='old'?String(a.date).localeCompare(String(b.date)):String(b.date).localeCompare(String(a.date)));
}
let scanPending=false,scanKey='';
async function refreshPresence(){if(scanPending)return;scanPending=true;$('scanStatus').textContent='저장 폴더 검사 중…';try{const r=await call('scanPresence');$('scanStatus').textContent=r?'파일 '+r.scanned+'개 검사 완료 · 첨부 미확인 자료는 기록과 ID 폴더로 판정합니다.':'검사 실패. 저장 폴더를 확인하고 다시 검사해 주세요.';if(!r)$('excludeFolder').checked=false;}finally{scanPending=false;render();}}

// 카드의 첨부 파일 목록은 접힌 상태가 기본. 펼친 게시물은 앱을 켜 둔 동안 기억한다.
const openFileLists=new Set();
function fileSummary(w){const on=w.files.filter(f=>f.selected),active=on.filter(f=>f.status==='다운로드 중');let s='첨부 파일 '+w.files.length+'개';if(on.length<w.files.length)s+=' · '+on.length+'개 받음';if(active.length){const total=active.reduce((n,f)=>n+(Number(f.total||f.size)||0),0),loaded=active.reduce((n,f)=>n+(Number(f.loaded)||0),0);s+=' · 다운로드 중'+(total?' '+Math.floor(loaded/total*100)+'%':'');}else{const failed=on.filter(f=>['실패','취소'].includes(f.status)).length;if(failed)s+=' · 실패 '+failed+'개';}return s;}
function render(){
 renderAuthorShortcuts();

  if(window.listDragActive)return;
 const filterCount=document.querySelectorAll('#filter input:checked').length;$('activeFilterCount').textContent=filterCount?String(filterCount):'';$('filterDetails').classList.toggle('active',!!filterCount);

  if(!translationSave)$('browserTranslate').checked=!!state.autoTranslate;
  if(document.activeElement!==$('browserPreview'))$('browserPreview').checked=state.browserPreview!==false;
  syncQuickValue();syncSearch();

  for(const [tab,label,count] of [['all','전체 목록',state.works.length],['progress','다운로드 진행',catalog().filter(inProgress).length],['done','다운로드 완료',catalog().filter(w=>w.status==='완료').length],['imported','임포트 완료',catalog().filter(w=>w.maxImport?.state==='done').length],['bookmarks','북마크',(state.bookmarks||[]).length]]){const button=$('tab-'+tab);button.textContent=label+' ('+count+')';button.classList.toggle('active',activeTab===tab);button.setAttribute('aria-selected',String(activeTab===tab));}
  $('selectNotImported').hidden=activeTab!=='done';
  renderClearRecords();
  if(!notificationSaving)$('notifyOnComplete').checked=state.notifyOnComplete!==false;
  $('defaultAuthorsGroup').hidden=!state.hiddenDefaultAuthors;$('hiddenAuthorsInfo').textContent='삭제한 기본 업로더 '+(state.hiddenDefaultAuthors||0)+'개';
  $('translateFileNames').checked=state.translateFileNames===true;
  if(state.version&&$('brand').dataset.version!==state.version){$('brand').dataset.version=state.version;$('brand').removeAttribute('title');$('brand').dataset.tip='Aplaybox Downloader v'+state.version;$('brand').setAttribute('aria-label','Aplaybox Downloader v'+state.version);}
  $('account').textContent=state.account?`계정 ${state.account}`:'로그인하지 않음';$('logout').hidden=!state.account;$('login').hidden=!!state.account&&!loginNeeded;$('folder').textContent=state.folder||'저장 폴더를 선택해 주세요.';$('folder').title=state.folder||'';$('message').textContent=state.message||'';$('count').textContent=`${state.works.length}개${state.complete?'':' · 전체 조회 미확인'}`;
  for(const id of ['refresh','folderBtn','save','all','none','missing','selectAbsent','logout','follow','like','collect','scope'])$(id).disabled=false;
  if(lastAccount!==state.account){lastAccount=state.account;settingsDirty=false;loginNeeded=false;$('login').hidden=!!state.account;}
  if(!settingsDirty){for(const k of ['follow','like','collect'])$(k).checked=!!state.settings?.[k];}
  if(!downloadOptionsSaving&&document.activeElement!==$('concurrency')&&document.activeElement!==$('checkConcurrency')){$('concurrency').value=String(state.concurrency||6);$('checkConcurrency').value=String(state.checkConcurrency||3);$('concurrencyUnlimited').checked=state.concurrencyUnlimited===true;}
  $('concurrency').disabled=$('concurrencyUnlimited').checked;
  $('consent').textContent=state.settings?.confirmed?'현재 계정에 저장된 범위로 자동 처리합니다. 설정 변경 후에는 다시 저장해 주세요.':'로그인 후 자동 처리 범위를 저장해 주세요. 모든 옵션을 꺼도 저장할 수 있습니다.';
  const selected=catalog().filter(w=>w.selected),files=selected.flatMap(w=>w.files.filter(f=>f.selected)),known=files.filter(f=>f.size!=null),unknown=selected.filter(w=>!w.files.length).length;
  $('summary').textContent=`게시물 ${selected.length}개 · 파일 ${files.length}개 · 확인된 용량 ${bytes(known.reduce((s,f)=>s+Number(f.size),0))}${unknown||known.length<files.length?' + 미확인':''}`;
  const list=$('list'),scroll=list.scrollTop,frag=document.createDocumentFragment();
  for(const w of filtered()){
    const row=text('article','','work'),cb=document.createElement('input');cb.type='checkbox';cb.checked=!!w.selected;cb.indeterminate=w.selected&&w.files.some(f=>!f.selected);cb.disabled=false;cb.setAttribute('aria-label',w.title+' 선택');cb.onchange=()=>call('selection',[{id:w.id,selected:cb.checked}]);row.dataset.workId=w.id;row.append(cb);row.classList.toggle('selected',!!w.selected);
    const img=document.createElement('img');img.className='cover';img.alt='';img.loading='lazy';try{const u=new URL(w.cover);if(u.protocol==='https:'&&u.hostname.endsWith('.aplaybox.com'))img.src=u.href;}catch{}const coverBox=text('div','','cover-box');coverBox.append(img);const play=text('button','','cover-play');play.type='button';play.title='3D로 미리 보기';play.setAttribute('aria-label',translated(w.title)+' 모델 디스플레이 보기');play.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 6.5v11l9-5.5z"/></svg>';play.onclick=()=>openViewer(w);coverBox.append(play);if(w.isNew){const nb=text('span','NEW','new-badge card-new');coverBox.append(nb);}row.append(coverBox);
    const info=text('div','','info');info.append(Object.assign(text('div',translated(w.title),'title'),{title:w.title}));if(w.date)info.append(text('div',w.date,'meta'));
    if(w.message&&w.message!=='다운로드 시작 시 조건·첨부 파일 확인')info.append(text('div',w.message,'message'));row.append(info);
    const status=text('div','','card-status'),actions=text('div','','actions');const stateEl=text('span',w.status,'state');stateEl.dataset.status=w.status||'';status.append(stateEl);const bookmark=iconButton(w.bookmarked?'star-fill':'star',w.bookmarked?'북마크에서 빼기':'북마크에 담기',w.title,'bookmark-btn'+(w.bookmarked?' on':''));bookmark.setAttribute('aria-pressed',String(!!w.bookmarked));bookmark.onclick=()=>call('bookmark',w.id);actions.append(bookmark);const open=iconButton('open','게시물 페이지 열기',w.title);open.onclick=()=>call('openPost',w.id);actions.append(open);if(w.hasHistory||w.inFolder||w.existingPath){const mx=iconButton('max','3ds Max로 임포트',w.title,'max-import');mx.onclick=()=>maxImport([w.id]);actions.append(mx);}if(w.existingPath){const present=text('span','폴더에 있음','badge met');present.title=w.existingPath;status.append(present);}if(w.maxImport){const m=w.maxImport,label=m.state==='done'?'임포트 완료':m.state==='failed'?'임포트 실패':'임포트 요청됨';const badge=text('span',label,'badge max-state '+m.state);badge.title=m.state==='failed'?(m.message||'3ds Max 임포트 창의 로그를 확인해 주세요.'):m.state==='sent'?'3ds Max가 임포트를 마치면 결과가 표시됩니다.':'3ds Max로 임포트를 마쳤습니다.';status.append(badge);}const again=!!(w.hasHistory||w.existingPath);const dl=iconButton('download',again?'다시 다운로드':'이 자료만 다운로드',w.title,'card-download');dl.disabled=!!state.busy;dl.onclick=()=>downloadOne(w);actions.append(dl);row.append(status,actions);
    if(w.files.length){const container=text('div','','files');const box=document.createElement('details');box.className='files-box';box.open=openFileLists.has(w.id);box.addEventListener('toggle',()=>{if(box.open)openFileLists.add(w.id);else openFileLists.delete(w.id);});box.append(text('summary',fileSummary(w)),container);for(const f of w.files){const item=text('div','','file'+(f.selected?'':' off')),fc=document.createElement('input');fc.type='checkbox';fc.className='file-toggle';fc.checked=!!f.selected;fc.disabled=false;fc.setAttribute('aria-label',f.name+' 받기');item.title=f.selected?'누르면 이 파일을 다운로드에서 뺍니다':'받지 않는 파일 · 누르면 다시 포함합니다';fc.onchange=()=>call('selection',[{id:w.id,fileId:f.id,selected:fc.checked}]);item.append(fc,text('span',f.name),text('small',`${bytes(f.size||f.total)} · ${f.status}`));if(f.status==='다운로드 중'){const p=document.createElement('progress');if(f.total){p.max=f.total;p.value=f.loaded||0;}item.append(p);item.append(text('small',`${bytes(f.loaded||0)} · ${bytes(f.speed||0)}/s`,'error'));}if(f.message)item.append(text('small',f.message,'error'));container.append(item);}status.append(box);}frag.append(row);
  }
  if(!frag.children.length)frag.append(text('div',state.works.length?'검색 조건에 맞는 자료가 없습니다.':'업로더 링크를 넣고 목록을 불러오세요. 목록 조회는 계정 행동을 실행하지 않습니다.','empty'));
  list.replaceChildren(frag);list.scrollTop=scroll;
  if(typeof renderActivity==='function')renderActivity();
}
function update(s){if(!s)return;state=s;const key=JSON.stringify([s.folder,s.busy,catalog().map(w=>[w.id,w.files.length,w.status])]);if($('excludeFolder').checked&&key!==scanKey&&!scanPending){scanKey=key;void refreshPresence();}if(!renderTimer)renderTimer=setTimeout(()=>{renderTimer=null;render();},100);}
window.aplay.onState(update);
window.aplay.onAuthor(url=>{$('embeddedPanel').hidden=true;$('url').value=url;activeTab='all';$('search').value='';render();});
for(const id of ['search','filter','sort'])$(id).addEventListener('input',render);
for(const id of ['follow','like','collect'])$(id).addEventListener('change',()=>settingsDirty=true);
// 동시 다운로드 · 무제한 · 동시 확인: 바꾸는 즉시 저장 (다음 다운로드부터 적용)
let downloadOptionsSaving=false;
async function saveDownloadOptions(){
  const n=Number($('concurrency').value),c=Number($('checkConcurrency').value);
  if(!Number.isSafeInteger(n)||n<1||n>64){toast('동시 다운로드 수는 1~64 사이의 정수로 입력해 주세요.');$('concurrency').value=String(state.concurrency||6);return;}
  if(!Number.isSafeInteger(c)||c<1||c>10){toast('동시 확인 수는 1~10 사이의 정수로 입력해 주세요.');$('checkConcurrency').value=String(state.checkConcurrency||3);return;}
  downloadOptionsSaving=true;try{const r=await window.aplay.call('downloadOptions',{concurrency:n,checkConcurrency:c,unlimited:$('concurrencyUnlimited').checked});if(!r.ok)toast(r.error);const s=await call('snapshot');if(s)update(s);}finally{downloadOptionsSaving=false;render();}
}
$('concurrency').addEventListener('change',saveDownloadOptions);$('checkConcurrency').addEventListener('change',saveDownloadOptions);
$('concurrencyUnlimited').addEventListener('change',async()=>{
  const box=$('concurrencyUnlimited');
  if(box.checked&&!await appConfirm('동시 다운로드 수를 제한하지 않으면 선택한 파일을 모두 한꺼번에 받습니다.\n\n· 사이트나 파일 서버가 요청을 제한(429)하거나 일시적으로 차단할 수 있습니다.\n· 짧은 시간에 요청이 몰려 계정 이용이 제한될 위험이 있습니다.\n· 회선과 디스크에 부하가 걸려 속도가 느려지고 실패가 늘 수 있습니다.',{title:'동시 다운로드 무제한',ok:'무제한으로 설정',cancel:'취소',danger:true,note:'문제가 생기면 이 설정을 끄고 동시 다운로드 수를 낮춰 주세요.'})){box.checked=false;return;}
  $('concurrency').disabled=box.checked;await saveDownloadOptions();
});
$('refresh').onclick=()=>{if(!$('url').value){toast('업로더를 먼저 선택해 주세요.');return;}call('refresh',$('url').value,$('scope').value);};

$('login').onclick=()=>call('login');$('logout').onclick=()=>call('logout');$('folderBtn').onclick=()=>call('folder');$('openFolder').onclick=()=>call('openFolder');
$('save').onclick=async()=>{await call('settings',{follow:$('follow').checked,like:$('like').checked,collect:$('collect').checked,concurrency:state.concurrency||6});settingsDirty=false;update(await call('snapshot'));};
$('all').onclick=()=>call('selection',tabWorks().map(w=>({id:w.id,selected:true})));$('none').onclick=()=>call('selection',tabWorks().map(w=>({id:w.id,selected:false})));
// 전체 기록 삭제 (다운로드 진행 · 다운로드 완료 · 임포트 완료 탭). 기록만 지우며 내려받은 파일과 3ds Max 씬은 그대로 둔다.
const CLEAR_RECORDS={
 progress:{what:'다운로드 진행 기록',method:'progressForget',busy:true,note:'진행·실패·인증 대기 상태가 지워져 다운로드 진행 탭에서 빠집니다. 이미 내려받은 파일과 완료 기록은 그대로입니다.'},
 done:{what:'다운로드 완료 기록',method:'downloadForget',busy:true,note:'다운로드 완료 탭이 비워지고 다운로드 기록(경로·SHA-256)이 지워집니다. 내려받은 파일은 그대로 남습니다.'},
 imported:{what:'임포트 완료 기록',method:'maxImportForget',busy:false,note:'임포트 완료 탭이 비워집니다. 다운로드한 파일과 3ds Max 씬은 그대로입니다.'}
};
function renderClearRecords(){const c=CLEAR_RECORDS[activeTab],b=$('clearRecords');b.hidden=!c;if(!c)return;const n=tabWorks().length;b.disabled=!n||(c.busy&&!!state.busy);b.title=!n?'삭제할 기록이 없습니다':b.disabled?'작업이 끝난 뒤 삭제할 수 있습니다':'이 탭의 '+c.what+' '+n+'개를 모두 삭제합니다 (파일은 그대로 남습니다)';}
$('clearRecords').onclick=async()=>{const c=CLEAR_RECORDS[activeTab];if(!c)return;const list=tabWorks();if(!list.length)return;
 if(!await appConfirm('이 탭의 '+c.what+' '+list.length+'개를 모두 삭제할까요?',{title:'전체 기록 삭제',ok:'모두 삭제',danger:true,note:c.note}))return;
 const r=await window.aplay.call(c.method,list.map(w=>w.id));if(!r.ok){toast(r.error);return;}toast(c.what+' '+r.value+'개를 삭제했습니다.');};
// 다운로드 완료 탭: 임포트 완료 기록이 없는 자료만 선택 (이미 임포트한 자료는 선택 해제)
$('selectNotImported').onclick=async()=>{const list=tabWorks();const n=list.filter(w=>w.maxImport?.state!=='done').length;await call('selection',list.map(w=>({id:w.id,selected:w.maxImport?.state!=='done'})));toast(n?'임포트하지 않은 자료 '+n+'개를 선택했습니다.':'임포트하지 않은 자료가 없습니다.');};
$('missing').onclick=()=>call('selectMissing',tabWorks().filter(w=>w.selected).map(w=>w.id),'exclude');
$('selectAbsent').onclick=()=>call('selectMissing',filtered().map(w=>w.id),'replace');
// Downloads every selected post, including ones hidden by the current tab, search or filter (the dock counts those too).
function start(mode){if(state.busy){toast('진행 중인 작업이 끝난 뒤 다운로드해 주세요.');return;}if(settingsDirty){toast('변경한 자동 처리 설정을 먼저 저장해 주세요.');return;}if(scanPending){toast('폴더 검사 완료 후 다운로드해 주세요.');return;}const ids=catalog().filter(w=>w.selected).map(w=>w.id);if(!ids.length){toast('다운로드할 게시물을 선택해 주세요.');return;}void call('start',mode,ids,exclusions());}
async function downloadOne(w){if(state.busy){toast('진행 중인 작업이 끝난 뒤 다운로드해 주세요.');return;}if(settingsDirty){toast('변경한 자동 처리 설정을 먼저 저장해 주세요.');return;}if((w.hasHistory||w.existingPath)&&!await appConfirm('이미 받은 자료입니다. 다시 다운로드할까요?',{title:'다시 다운로드',ok:'다시 받기'}))return;if(!w.selected){const r=await window.aplay.call('selection',[{id:w.id,selected:true}]);if(!r.ok){toast(r.error);return;}}call('start','download',[w.id],{history:false,folder:false});}
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
for(const tab of ['all','progress','done','imported','bookmarks'])$('tab-'+tab).onclick=()=>{activeTab=tab;render();$('list').scrollTop=0;};

$('excludeFolder').onchange=()=>{if($('excludeFolder').checked)void refreshPresence();else render();};
$('excludeHistory').onchange=render;
$('rescanFolder').onclick=()=>refreshPresence();

// 예전의 '상단 줄 접기' 설정이 남아 있어도 줄이 숨지 않게 정리한다.
try{localStorage.removeItem('setupCollapsed');}catch{}


if(!Number.isInteger(listColumns)||listColumns<1||listColumns>6)listColumns=4;
function applyColumns(){document.documentElement.style.setProperty('--list-columns',String(listColumns));document.documentElement.dataset.columns=String(listColumns);markDensity();if($('thumbnailSize'))$('thumbnailSize').textContent=listColumns+'열 · '+thumbnailPx+'px';}
applyColumns();

window.aplay.onFinished(result=>toast(result.title+' · '+result.body));
// A task that could not start or stopped with an error (not logged in, settings not saved, no folder, ...).
window.aplay.onTaskFailed?.(message=>{toast(message);if(/로그인/.test(message)){loginNeeded=true;$('login').hidden=false;}});

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
window.aplay.onBrowserDownload(()=>{$('embeddedPanel').hidden=true;activeTab='progress';$('search').value='';for(const e of document.querySelectorAll('[data-filter]'))e.checked=false;$('excludeHistory').checked=false;$('excludeFolder').checked=false;$('excludeDone').checked=false;render();});

// 정렬: 화살표 버튼 하나로 신작부터(아래 화살표, 값 new)와 초기작부터(위 화살표, 값 old)를 오간다. 값은 숨은 #sort 가 든다.
function syncSort(){const old=$('sort').value==='old',b=$('sortToggle');b.classList.toggle('asc',old);b.setAttribute('aria-pressed',String(old));b.setAttribute('aria-label','업로드 날짜 정렬: '+(old?'초기작부터':'신작부터'));b.removeAttribute('title');b.dataset.tip='업로드 날짜';}
$('sortToggle').onclick=()=>{$('sort').value=$('sort').value==='old'?'new':'old';try{localStorage.setItem('listSort',$('sort').value);}catch{}syncSort();render();};
try{if(localStorage.getItem('listSort')==='old')$('sort').value='old';}catch{}
syncSort();
// 검색: 돋보기 아이콘을 누르면 입력 칸이 펼쳐지고, 비어 있는 채로 벗어나면 다시 접힌다.
function syncSearch(){const box=document.querySelector('.list-search'),has=!!$('search').value;if(has)box.classList.add('open');const open=box.classList.contains('open');$('searchToggle').setAttribute('aria-expanded',String(open));$('searchToggle').classList.toggle('active',has);}
$('searchToggle').addEventListener('mousedown',e=>e.preventDefault());
$('searchToggle').onclick=()=>{const box=document.querySelector('.list-search');if(box.classList.contains('open')&&!$('search').value){box.classList.remove('open');$('searchToggle').focus();}else{box.classList.add('open');$('search').focus();}syncSearch();};
$('search').addEventListener('blur',()=>{if(!$('search').value){document.querySelector('.list-search').classList.remove('open');syncSearch();}});
$('search').addEventListener('keydown',e=>{if(e.key==='Escape'){e.preventDefault();$('search').value='';document.querySelector('.list-search').classList.remove('open');render();$('searchToggle').focus();}});
$('browserTranslate').onchange=()=>changeTranslation($('browserTranslate').checked);
$('browserPreview').onchange=async()=>{const r=await window.aplay.call('browserPreview',$('browserPreview').checked);if(!r.ok){toast(r.error);$('browserPreview').checked=!$('browserPreview').checked;}};

for(const id of ['filterDetails']){const panel=$(id);panel.open=localStorage.getItem('readability-'+id)==='true';panel.addEventListener('toggle',()=>localStorage.setItem('readability-'+id,String(panel.open)));}

function updateBackToTop(){
 const embedded=!$('embeddedPanel').hidden,button=$('backToTop'),dock=$('floatingDock');button.hidden=window.scrollY<240||embedded;
 // The floating dock stays wherever the page is scrolled; it hides only when it has nothing to show.
 if(dock)dock.hidden=embedded||dock.classList.contains('empty');
 const bottom=dock&&!dock.hidden?24+dock.offsetHeight+10:24;
 button.style.bottom=bottom+'px';
}
window.addEventListener('resize',updateBackToTop);
const backToTopLayout=new ResizeObserver(updateBackToTop);
backToTopLayout.observe(document.querySelector('main'));
if($('floatingDock'))backToTopLayout.observe($('floatingDock'));
window.addEventListener('scroll',updateBackToTop,{passive:true});
new MutationObserver(updateBackToTop).observe($('embeddedPanel'),{attributes:true,attributeFilter:['hidden']});
$('backToTop').onclick=()=>window.scrollTo({top:0,behavior:window.matchMedia('(prefers-reduced-motion: reduce)').matches?'instant':'smooth'});
updateBackToTop();
// 3ds Max import (bundled ImportMMD) and its settings dialog.
async function maxImport(ids){
 if(!ids.length){toast('임포트할 배포 자료를 선택해 주세요.');return;}
 const plan=await window.aplay.call('maxImportPlan',ids);if(!plan.ok){toast(plan.error);return;}
 const request=await maxImportDialog(plan.value);if(!request)return;
 const r=await window.aplay.call('maxImport',ids,request);if(!r.ok){toast(r.error);return;}
 if(r.value&&!r.value.canceled)toast(r.value.target==='new'?'3ds Max를 실행합니다. 시작이 끝나면 임포트합니다.':'3ds Max로 임포트 요청을 보냈습니다.');
}
const MX_FIELDS={keepMorphs:['mxKeepMorphs','bool'],restoreNames:['mxRestoreNames','bool'],splitMode:['mxSplit','choice'],matType:['mxMat','choice'],alphaMode:['mxAlpha','radio'],scaleCm:['mxScale','number'],spacing:['mxSpacing','number'],codePage:['mxCodePage','choice'],forceExtract:['mxForce','bool'],multiPmx:['mxMulti','choice'],parallelBlender:['mxParallel','number'],reuseFbx:['mxReuse','bool']};
let maxImportResolve=null;
function maxImportDialog(plan){
 const d=$('maxImportDialog');
 $('mxFiles').textContent='파일 '+plan.files.length+'개: '+plan.files.slice(0,6).join(', ')+(plan.files.length>6?' 외 '+(plan.files.length-6)+'개':'');
 const sel=$('mxTarget');sel.replaceChildren(...plan.targets.map(t=>{const o=document.createElement('option');o.value=t.id;o.textContent=t.label;return o;}));sel.value=plan.targets[0].id;
 const note=$('mxNote');note.hidden=!plan.unlinked.length;note.textContent=plan.unlinked.length?'연동 스크립트가 로드되지 않은 3ds Max '+plan.unlinked.length+'개(PID '+plan.unlinked.join(', ')+')는 선택할 수 없습니다. 연동 설치 전에 켠 Max는 다시 시작하거나, 그 Max에서 Scripting > Run Script로 '+plan.bridgeScript+' 를 한 번 실행하면 연결됩니다.':'';
 for(const [name,[id,type]] of Object.entries(MX_FIELDS)){const v=plan.options[name];if(type==='radio'){for(const r of document.querySelectorAll('input[name="'+id+'"]'))r.checked=r.value===String(v);continue;}const el=$(id);if(type==='bool')el.checked=!!v;else el.value=String(v);}
 return new Promise(resolve=>{maxImportResolve=resolve;d.showModal();$('mxOk').focus();});
}
function closeMaxImport(value){const done=maxImportResolve;maxImportResolve=null;if($('maxImportDialog').open)$('maxImportDialog').close();done?.(value);}
$('maxImportForm').onsubmit=e=>{e.preventDefault();
 const options={};for(const [name,[id,type]] of Object.entries(MX_FIELDS)){if(type==='radio'){options[name]=Number(document.querySelector('input[name="'+id+'"]:checked')?.value||1);continue;}const el=$(id);options[name]=type==='bool'?el.checked:Number(el.value);}
 if(!Number.isInteger(options.parallelBlender)||options.parallelBlender<1||options.parallelBlender>8){toast('동시 변환 수는 1~8 사이의 정수로 입력해 주세요.');$('mxParallel').focus();return;}
 if(!Number.isFinite(options.scaleCm)||options.scaleCm<0.001||options.scaleCm>10000){toast('스케일은 0.001~10000 사이의 숫자로 입력해 주세요.');$('mxScale').focus();return;}
 if(!Number.isFinite(options.spacing)||options.spacing<0||options.spacing>100000){toast('모델 간격은 0~100000 사이의 숫자로 입력해 주세요.');$('mxSpacing').focus();return;}
 closeMaxImport({target:$('mxTarget').value,options});};
$('mxCancel').onclick=()=>closeMaxImport(null);
$('maxImportDialog').addEventListener('cancel',e=>{e.preventDefault();closeMaxImport(null);});
// Questions the main process asks (3ds Max version, bridge install) as app-styled dialogs instead of OS message boxes.
window.aplay.onAsk?.(async q=>{const index=await appChoice(q);void window.aplay.call('appAnswer',q.id,index);});
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
// 번역 엔진 표. google 외에는 이 PC의 CLI(계정 로그인)로 번역하는 엔진이며 모델·계정·실행 파일을 같은 방식으로 다룬다.
const LLM={
 claude:{label:'Claude',plan:'Claude Pro 플랜 이상 계정 필요',product:'Claude Code',app:'Claude 데스크탑 앱',exeName:'claude.exe',account:'claudeAccount',code:true,
  usage:'Claude 번역은 본인 Claude 계정(Claude 데스크탑 앱에 로그인한 계정)의 사용량을 소모합니다.',
  // Claude Code가 계열별 최신 모델로 바꿔 주는 별칭. 상위 모델부터 (ChatGPT 목록과 같은 순서).
  models:()=>[['fable','Fable'],['opus','Opus'],['sonnet','Sonnet'],['haiku','Haiku']],model:s=>s.model||'haiku',path:s=>s.claudePath,detected:s=>s.detected,name:m=>'Claude '+m[0].toUpperCase()+m.slice(1),bucket:(s,m)=>'claude:'+m},
 codex:{label:'ChatGPT',plan:'ChatGPT Plus 이상 계정 필요',product:'Codex',app:'Codex 데스크탑 앱',exeName:'codex.exe',account:'codexAccount',code:false,
  usage:'ChatGPT 번역은 본인 ChatGPT 계정(Codex에 로그인한 계정)의 사용량을 소모합니다.',
  // 모델은 Codex가 제공하는 실제 모델 목록(예: GPT-6.1-Sol, GPT-6-Astra, GPT-6-Luna)에서 고른다.
  models:s=>(s.codexModels||[]).map(m=>[m.slug,m.name]),model:s=>s.codexModel||(s.codexModels?.[0]?.slug||''),path:s=>s.codexPath,detected:s=>s.codexDetected,name:(m,s)=>'ChatGPT '+((s?.codexModels||[]).find(x=>x.slug===m)?.name||m),bucket:(s,m)=>'codex:'+m}
};
function engineKey(s){return LLM[s.engine]?s.engine+':'+LLM[s.engine].model(s):'google';}
function engineName(engine,model){return LLM[engine]?LLM[engine].name(model,trState):'Google 번역';}
// 한국어 조사 (으)로: 받침 없는 글자·ㄹ 받침·모음이나 l 로 끝나는 영문은 '로'.
function withRo(label){const c=label.slice(-1),code=c.charCodeAt(0);if(code>=0xac00&&code<=0xd7a3){const j=(code-0xac00)%28;return label+(j===0||j===8?'로':'으로');}return label+(/[aeiouyl1245789]$/i.test(c)?'로':'으로');}
// 번역 엔진 빠른 선택. 값은 숨은 <select id="trQuick">('google' | '<엔진>:<모델>')이 들고, 화면에는 메뉴로 보여 준다.
// 모델이 여러 개인 엔진(Claude · ChatGPT)은 이름 위에 마우스를 올리면 옆으로 모델 목록이 펼쳐진다.
let quickModelsKey='';
function fillQuickModels(s){
 const groups=Object.keys(LLM).map(e=>[e,LLM[e].models(s)]);const key=JSON.stringify(groups);if(key===quickModelsKey)return;quickModelsKey=key;
 const sel=$('trQuick');for(const o of [...sel.options])if(o.value!=='google'&&o.value!=='off')o.remove();
 for(const [e,models] of groups)for(const [value] of models){const o=document.createElement('option');o.value=e+':'+value;o.textContent=LLM[e].name(value,s);sel.append(o);}
 buildEngineMenu(s);
}
function buildEngineMenu(s=trState||{}){
 const list=$('trMenuList');list.replaceChildren();
 const item=(label,value)=>{const b=text('button',label,'tr-item');b.type='button';b.setAttribute('role','menuitemradio');b.dataset.value=value;b.onclick=()=>pickEngine(value);return b;};
 list.append(item('Google 번역','google'));
 for(const e of Object.keys(LLM)){
  const models=LLM[e].models(s);if(!models.length)continue;
  if(models.length===1){const only=item(LLM[e].name(models[0][0],s),e+':'+models[0][0]);only.title=LLM[e].plan;only.dataset.tipNow='';list.append(only);continue;}
  const group=text('div','','tr-group'),parent=text('button',LLM[e].label,'tr-item tr-parent');parent.type='button';parent.setAttribute('role','menuitem');parent.setAttribute('aria-haspopup','menu');parent.setAttribute('aria-expanded','false');parent.dataset.engine=e;parent.title=LLM[e].plan;parent.dataset.tipNow='';
  const sub=text('div','','tr-sub');sub.setAttribute('role','menu');sub.setAttribute('aria-label',LLM[e].label+' 모델');
  for(const [value,label] of models)sub.append(item(label,e+':'+value));
  // hover opens the side list (CSS); a click or the arrow keys do the same for keyboard and touch
  const open=on=>{for(const g of list.querySelectorAll('.tr-group.open'))if(g!==group)g.classList.remove('open');group.classList.toggle('open',on);parent.setAttribute('aria-expanded',String(on));};
  parent.onclick=()=>open(!group.classList.contains('open'));
  parent.addEventListener('keydown',ev=>{if(ev.key==='ArrowRight'||ev.key==='Enter'||ev.key===' '){ev.preventDefault();open(true);sub.querySelector('.tr-item')?.focus();}});
  sub.addEventListener('keydown',ev=>{if(ev.key==='ArrowLeft'){ev.preventDefault();ev.stopPropagation();open(false);parent.focus();}});
  group.append(parent,sub);list.append(group);
 }
 // 번역을 끄는 항목 (자동 번역 체크박스를 대신한다)
 const off=item('번역 사용 안 함','off');off.classList.add('tr-off');list.append(off);
 syncEngineMenu();
}
// 숨은 선택 값: 번역이 꺼져 있으면 'off', 켜져 있으면 현재 엔진·모델.
function syncQuickValue(){const sel=$('trQuick');const v=state.autoTranslate===false?'off':trState?engineKey(trState):(sel.value==='off'?'google':sel.value);if(sel.value!==v)sel.value=v;syncEngineMenu();}
$('trMenuList').addEventListener('mouseover',e=>{const list=$('trMenuList');let top=e.target;while(top&&top.parentElement!==list)top=top.parentElement;if(!top)return;for(const g of list.querySelectorAll('.tr-group'))if(g!==top){g.classList.remove('open');g.querySelector('.tr-parent').setAttribute('aria-expanded','false');if(g.contains(document.activeElement))document.activeElement.blur();}});
function syncEngineMenu(){
 const sel=$('trQuick'),btn=$('trMenuBtn'),value=sel.value,engine=value.split(':')[0];
 btn.textContent=sel.selectedOptions[0]?.textContent||'Google 번역';btn.disabled=sel.disabled;if(sel.title)btn.title=sel.title;
 for(const b of $('trMenuList').querySelectorAll('.tr-item[data-value]')){const on=b.dataset.value===value;b.classList.toggle('current',on);b.setAttribute('aria-checked',String(on));}
 for(const p of $('trMenuList').querySelectorAll('.tr-parent'))p.classList.toggle('current',p.dataset.engine===engine);
}
function closeEngineMenu(){const list=$('trMenuList');if(list.hidden)return;list.hidden=true;for(const g of list.querySelectorAll('.tr-group.open'))g.classList.remove('open');$('trMenuBtn').setAttribute('aria-expanded','false');}
function pickEngine(value){closeEngineMenu();$('trMenuBtn').focus();const sel=$('trQuick');if(sel.value===value)return;sel.value=value;sel.dispatchEvent(new Event('change'));}
$('trMenuBtn').onclick=()=>{const list=$('trMenuList');if(!list.hidden){closeEngineMenu();return;}syncEngineMenu();list.hidden=false;$('trMenuBtn').setAttribute('aria-expanded','true');(list.querySelector(':scope > .tr-item.current, :scope > .tr-group > .tr-parent.current')||list.querySelector('.tr-item'))?.focus();};
$('trMenu').addEventListener('keydown',e=>{
 if(e.key==='Escape'&&!$('trMenuList').hidden){e.preventDefault();e.stopPropagation();closeEngineMenu();$('trMenuBtn').focus();return;}
 if(e.key!=='ArrowDown'&&e.key!=='ArrowUp')return;
 const scope=e.target.closest('.tr-sub')||$('trMenuList');const items=[...scope.querySelectorAll(':scope > .tr-item, :scope > .tr-group > .tr-parent')];const i=items.indexOf(e.target);if(i<0)return;
 e.preventDefault();items[(i+(e.key==='ArrowDown'?1:items.length-1))%items.length].focus();
});
document.addEventListener('mousedown',e=>{if(!$('trMenu').contains(e.target))closeEngineMenu();});
window.addEventListener('blur',closeEngineMenu);
fillQuickModels({});
function renderTranslationEngine(s){trState=s;
 // Google을 쓰는 동안 아래 칸(모델·실행 파일·연결 시험)은 Claude 기준으로 보여 준다.
 const llm=LLM[s.engine],shown=llm||LLM.claude;const name=engineName(s.engine,llm?llm.model(s):'');
 $('trSummary').textContent=llm?name+' ('+llm.product+')'+(s.error?' · '+s.error:''):'Google 번역 (기본)';
 fillQuickModels(s);$('trQuick').title=name+(s.error?' · '+s.error:'')+' · 세부 설정은 ⚙ 설정의 번역 설정';syncQuickValue();$('trEngine').value=s.engine;
 const sel=$('trModel');sel.replaceChildren(...shown.models(s).map(([v,t])=>{const o=document.createElement('option');o.value=v;o.textContent=t;return o;}));sel.value=shown.model(s);if(!engineSwitching)sel.disabled=!llm;
 $('trModelLabel').textContent=shown.label+' 모델';$('trCliLabel').textContent=shown.product;$('trTest').textContent=shown.label+' 연결 시험';
 $('trClaudePath').textContent=shown.path(s)?'직접 지정 · '+shown.path(s):shown.detected(s)?'자동 탐색 · '+shown.detected(s):shown.product+'를 찾지 못했습니다. '+shown.app+'을 설치하거나 '+shown.exeName+'를 지정해 주세요.';
 const wait=s.cooldownUntil?` · ${Math.max(1,Math.ceil((s.cooldownUntil-Date.now())/60000))}분 동안 Google로 대신 번역`:'';
 $('trState').textContent=s.test?(s.test.ok?`연결됨 · ${(s.test.ms/1000).toFixed(1)}초 · 예: ${s.test.text}`:s.test.error):s.error?s.error+wait:llm?'사용 중'+wait:'Google 번역 사용 중';
 $('trCached').textContent=`${s.cached.toLocaleString()}개 저장됨`+(s.builtin?` · 내장 번역 ${s.builtin.toLocaleString()}개(지워지지 않음)`:'');
 if(document.activeElement!==$('trParallel'))$('trParallel').value=String(s.parallel||3);$('trParallel').max=String(s.parallelMax||4);
}
async function translationEngine(op,value){const r=await window.aplay.call('translationEngine',op,value);if(!r.ok){toast(r.error);return null;}renderTranslationEngine(r.value);if(op!=='get'&&op!=='test'){translationRetry=0;}return r.value;}
$('trSettingsBtn').onclick=async()=>{if(await translationEngine('get'))$('trDialog').showModal();};
$('trEngine').onchange=()=>{const e=$('trEngine').value;void switchEngine(e,LLM[e]?LLM[e].model(trState||{}):undefined);};
$('trModel').onchange=()=>{const e=trState?.engine;if(LLM[e])void switchEngine(e,$('trModel').value);else void translationEngine('model',$('trModel').value);};
$('trBrowse').onclick=()=>translationEngine('browse',trState?.engine==='codex'?'codex':undefined);$('trAuto').onclick=()=>translationEngine('auto',trState?.engine==='codex'?'codex':undefined);
$('trTest').onclick=async()=>{const b=$('trTest');b.disabled=true;$('trState').textContent='시험 중… (최대 수십 초)';try{await translationEngine('test');}finally{b.disabled=false;}};
$('trParallel').onchange=async()=>{const n=Number($('trParallel').value);if(!Number.isInteger(n)||n<1||n>Number($('trParallel').max||4)){toast('동시 처리 수는 1~'+($('trParallel').max||4)+' 사이의 정수로 입력해 주세요.');if(trState)$('trParallel').value=String(trState.parallel||3);return;}await translationEngine('parallel',n);};
$('trGlossary').onclick=()=>translationEngine('glossary');
$('trClear').onclick=async()=>{if(!await appConfirm('저장된 번역을 모두 지우고 다시 번역할까요?',{title:'저장된 번역 지우기',ok:'지우기',danger:true}))return;if(await translationEngine('clear')){translatedNames.clear();translationEpoch++;render();}};
$('trDialogClose').onclick=()=>$('trDialog').close();
window.aplay.call('translationEngine','get').then(r=>{if(r.ok)renderTranslationEngine(r.value);}).catch(()=>{});

// 업로더 바로가기 줄: 기본 업로더 + 내 북마크(★) + 현재 업로더 북마크 추가 + 찾아보기
// 모든 북마크 버튼은 우클릭으로 이름 변경·삭제. 기본 업로더의 이름을 바꾸면 같은 ID의 북마크가 그 자리를 대신하고, 삭제하면 숨김(설정에서 복원).
const AUTHOR_FOLD=13;let authorShortcutKey='';
function authorExpanded(){try{return localStorage.getItem('authorShortcutsExpanded')==='true';}catch{return false;}}
async function loadAuthorShortcut(a){
 if(state.busy){toast('현재 작업이 끝난 뒤 업로더를 전환해 주세요.');return;}
 const result=await window.aplay.call('load',a.url,$('scope').value);if(!result.ok){toast(result.error);return;}
 $('url').value=a.url;activeTab='all';$('search').value='';render();
}
function currentAuthorName(){const w=(state.works||[]).find(w=>String(w.authorId)===String(state.author||''));return w?translated(w.author):'';}
// 북마크 버튼 목록: 기본 제공 업로더와 직접 추가한 업로더를 구분 없이 한 목록으로 다룬다(순서는 드래그로 바꾸고 저장).
function authorList(){
 if(Array.isArray(state.authorShortcuts))return state.authorShortcuts;
 const by=new Map();for(const a of state.defaultAuthors||[])by.set(String(a.id),{...a,id:String(a.id),builtin:true});
 for(const a of state.authorBookmarks||[])by.set(String(a.id),{...a,id:String(a.id),builtin:by.has(String(a.id))});return [...by.values()];
}
let authorDrag=null;
function authorKeyOf(authors,canAdd){return JSON.stringify([authors.map(a=>[a.id,translated(a.name),state.authorNew?.[a.id]||0]),canAdd,authorExpanded()]);}
function renderAuthorShortcuts(){
 const box=$('defaultAuthorButtons');const authors=authorList();
 const cur=String(state.author||'');const canAdd=!!cur&&!authors.some(a=>a.id===cur);
 const key=authorKeyOf(authors,canAdd);
 if(key!==authorShortcutKey&&!authorDrag&&(authors.length||canAdd)){
  authorShortcutKey=key;const frag=document.createDocumentFragment();
  const chipFor=a=>{
   const name=translated(a.name);const chip=text('span','','author-chip');chip.dataset.authorId=a.id;
   const b=text('button',name,'quiet');b.type='button';b.dataset.authorId=a.id;b.title=name+' 자료 불러오기 · 우클릭으로 이름 변경·삭제 · 끌어서 순서 변경';b.onclick=()=>loadAuthorShortcut(a);b.oncontextmenu=e=>{e.preventDefault();openAuthorDialog('edit',a);};chip.append(b);
   const n=state.authorNew?.[a.id];if(n){chip.classList.add('has-new');const nb=text('span','NEW','new-badge');nb.title='새 모델 '+n+'개';chip.append(nb);}
   const x=text('button','✕','author-remove');x.type='button';x.setAttribute('aria-label',name+' 북마크 버튼 삭제');x.onclick=()=>removeAuthorBookmark(a);chip.append(x);
   chip.addEventListener('pointerdown',e=>beginAuthorDrag(e,chip));
   return chip;
  };
  const expanded=authorExpanded(),shown=expanded?authors:authors.slice(0,AUTHOR_FOLD);
  for(const a of shown)frag.append(chipFor(a));
  if(authors.length>AUTHOR_FOLD){const t=text('button',expanded?'접기 ▴':'+'+(authors.length-AUTHOR_FOLD)+'개 더보기 ▾','quiet author-fold');t.type='button';t.onclick=()=>{try{localStorage.setItem('authorShortcutsExpanded',String(!expanded));}catch{}authorShortcutKey='';renderAuthorShortcuts();};frag.append(t);}
  if(canAdd){const add=text('button','＋ 현재 업로더 북마크','quiet add-author');add.type='button';add.title='지금 보고 있는 업로더를 북마크 버튼으로 추가';add.onclick=()=>openAuthorDialog('add',{id:cur,name:currentAuthorName()});frag.append(add);}
  const more=text('button','찾아보기 →','quiet more-authors');more.type='button';more.title='Aplaybox 업로더 목록에서 새 업로더 찾기';more.onclick=()=>openEmbedded('https://www.aplaybox.com/author');frag.append(more);const help=text('button','','help-btn');help.type='button';help.setAttribute('aria-label','사용 방법');help.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"/><path d="M9.6 9.2a2.5 2.5 0 1 1 3.6 2.3c-.8.4-1.2 1-1.2 1.8v.4"/><circle cx="12" cy="17" r=".6" fill="currentColor"/></svg>';let helpSeen=false;try{helpSeen=localStorage.getItem('helpSeen')==='1';}catch{}if(!helpSeen)help.classList.add('attention');help.onclick=()=>{try{localStorage.setItem('helpSeen','1');}catch{}help.classList.remove('attention');$('helpDialog').showModal();};frag.append(help);const site=text('button','Aplaybox 탐색','browse-site');site.id='browse';site.type='button';site.title='Aplaybox 사이트 둘러보기';site.onclick=()=>openEmbedded();frag.append(site);
  box.replaceChildren(frag);
 }
 for(const button of box.querySelectorAll('button[data-author-id]')){const active=cur===button.dataset.authorId;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));}
}
// 북마크 버튼의 현재 화면 순서
function authorOrderNow(){return [...$('defaultAuthorButtons').querySelectorAll('.author-chip')].map(c=>c.dataset.authorId);}
// ---- 버튼을 끌어 순서 바꾸기 ----
// 누른 버튼이 포인터를 따라 움직이고(들어 올린 모양), 그 중심이 다른 버튼 위를 지나면 나머지가 미끄러져 자리를 비켜 준다.
// 놓으면 빈자리로 부드럽게 내려앉는다. 6px 이상 움직여야 끌기로 보므로 그냥 누르면 평소처럼 목록을 불러온다.
const DRAG_EASE='cubic-bezier(.22,1,.36,1)';
function slideChips(chips,change){
 // FLIP: 지금 보이는 위치(진행 중인 이동 포함)에서 새 자리까지 이어서 움직인다.
 const from=new Map(chips.map(c=>[c,c.getBoundingClientRect()]));change();
 if(window.matchMedia('(prefers-reduced-motion: reduce)').matches){for(const c of chips){c.style.transition='';c.style.transform='';}return;}
 for(const c of chips){c.style.transition='none';c.style.transform='';}
 for(const c of chips){const a=from.get(c),b=c.getBoundingClientRect(),dx=a.left-b.left,dy=a.top-b.top;if(Math.abs(dx)<.5&&Math.abs(dy)<.5)continue;c.style.transform='translate('+dx+'px,'+dy+'px)';}
 void document.body.offsetWidth;
 for(const c of chips){if(!c.style.transform){c.style.transition='';continue;}c.style.transition='transform .32s '+DRAG_EASE;c.style.transform='';}
}
function beginAuthorDrag(e,chip){
 if(e.button!==0||e.target.closest('.author-remove')||authorDrag)return;
 const box=$('defaultAuthorButtons');
 const d={chip,id:chip.dataset.authorId,pointerId:e.pointerId,startX:e.clientX,startY:e.clientY,x:e.clientX,y:e.clientY,active:false,before:'',frame:0,grabX:0,grabY:0};
 const others=()=>[...box.querySelectorAll('.author-chip')].filter(c=>c!==chip);
 const place=()=>{ // keep the lifted button under the pointer whatever slot it currently occupies in the layout
  chip.style.transform='';const r=chip.getBoundingClientRect();chip.style.transform='translate('+(d.x-d.grabX-r.left)+'px,'+(d.y-d.grabY-r.top)+'px)';};
 const step=()=>{d.frame=0;if(!d.active)return;place();
  const r=chip.getBoundingClientRect(),cx=r.left+r.width/2,cy=r.top+r.height/2;
  for(const c of others()){
   // compare against each button's resting slot, not its in-flight position, so nothing flickers back and forth
   const v=c.getBoundingClientRect(),m=new DOMMatrixReadOnly(getComputedStyle(c).transform),b={left:v.left-m.m41,right:v.right-m.m41,top:v.top-m.m42,bottom:v.bottom-m.m42,width:v.width};
   if(cx<b.left||cx>b.right||cy<b.top-6||cy>b.bottom+6)continue;
   const after=cx>b.left+b.width/2;if(after?c.nextElementSibling===chip:c.previousElementSibling===chip)break;
   slideChips(others(),()=>{if(after)c.after(chip);else c.before(chip);});place();break;
  }};
 const move=ev=>{if(ev.pointerId!==d.pointerId)return;d.x=ev.clientX;d.y=ev.clientY;
  if(!d.active){if(Math.hypot(d.x-d.startX,d.y-d.startY)<6)return;
   d.active=true;authorDrag=d;d.before=authorOrderNow().join(',');const r=chip.getBoundingClientRect();d.grabX=d.startX-r.left;d.grabY=d.startY-r.top;
   chip.classList.add('lifted');box.classList.add('reordering');document.body.classList.add('author-dragging');}
  ev.preventDefault();if(!d.frame)d.frame=requestAnimationFrame(step);};
 const finish=cancelled=>{
  window.removeEventListener('pointermove',move,true);window.removeEventListener('pointerup',up,true);window.removeEventListener('pointercancel',cancel,true);window.removeEventListener('keydown',key,true);
  if(!d.active)return;cancelAnimationFrame(d.frame);
  if(cancelled){const ids=d.before.split(',');slideChips(others(),()=>{for(const id of ids){const c=box.querySelector('.author-chip[data-author-id="'+id+'"]');if(c)box.insertBefore(c,box.querySelector('.author-fold,.add-author,.more-authors'));}});}
  // settle into the slot
  const reduce=window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  chip.classList.add('settling');chip.classList.remove('lifted');chip.style.transition=reduce?'none':'transform .34s '+DRAG_EASE;chip.style.transform='';
  const done=()=>{chip.removeEventListener('transitionend',done);clearTimeout(timer);chip.classList.remove('settling');chip.style.transition='';box.classList.remove('reordering');document.body.classList.remove('author-dragging');authorDrag=null;
   if(!cancelled&&authorOrderNow().join(',')!==d.before)void saveAuthorOrder();else{authorShortcutKey='';renderAuthorShortcuts();}};
  const timer=setTimeout(done,reduce?0:380);chip.addEventListener('transitionend',done);
  // the release must not count as a click on the button
  const swallow=ev=>{ev.stopPropagation();ev.preventDefault();};window.addEventListener('click',swallow,{capture:true,once:true});setTimeout(()=>window.removeEventListener('click',swallow,true),80);
 };
 const up=ev=>{if(ev.pointerId===d.pointerId)finish(false);},cancel=ev=>{if(ev.pointerId===d.pointerId)finish(true);},key=ev=>{if(ev.key==='Escape'&&d.active){ev.preventDefault();ev.stopPropagation();finish(true);}};
 // listen on the window: moving the button in the DOM while it is dragged would drop a pointer capture on it
 window.addEventListener('pointermove',move,true);window.addEventListener('pointerup',up,true);window.addEventListener('pointercancel',cancel,true);window.addEventListener('keydown',key,true);
}
// 화면에 보이는 순서(접혀 숨은 업로더는 기존 순서로 뒤에)를 저장한다.
async function saveAuthorOrder(){const ids=authorOrderNow();for(const a of authorList())if(!ids.includes(a.id))ids.push(a.id);if(Array.isArray(state.authorShortcuts)){const all=authorList();state.authorShortcuts=ids.map(id=>all.find(a=>a.id===id)).filter(Boolean);const cur=String(state.author||'');authorShortcutKey=authorKeyOf(state.authorShortcuts,!!cur&&!state.authorShortcuts.some(a=>a.id===cur));}const r=await window.aplay.call('authorOrder',ids);if(!r.ok)toast(r.error);}
let authorDialogTarget=null;
function openAuthorDialog(mode,a){
 authorDialogTarget={mode,a};const d=$('authorDialog');
 $('authorDialogTitle').textContent=mode==='add'?'북마크 추가':mode==='view'?a.name:'북마크 버튼 편집';
 $('authorDialogName').value=mode==='view'?'':(mode==='add'?a.name:translated(a.name))||'';
 $('authorDialogNameRow').hidden=mode==='view';$('authorDialogSave').hidden=mode==='view';$('authorDialogSave').textContent=mode==='add'?'추가':'이름 저장';
 $('authorDialogRemove').hidden=mode!=='edit'&&mode!=='default';$('authorDialogRemove').textContent='북마크 버튼 삭제';$('authorDialogBrowse').hidden=mode==='add';
 d.showModal();if(mode!=='view'){$('authorDialogName').focus();$('authorDialogName').select();}
}
async function removeAuthorBookmark(a){const builtIn=(state.defaultAuthors||[]).some(d=>String(d.id)===String(a.id));if(!await appConfirm("'"+translated(a.name)+"' 북마크 버튼을 삭제할까요?",{title:'북마크 버튼 삭제',ok:'삭제',danger:true,note:builtIn?'기본 업로더는 ⚙ 설정의 "기본 업로더 다시 표시"로 되돌릴 수 있습니다.':''}))return false;const r=await window.aplay.call('authorRemove',a.id);if(!r.ok){toast(r.error);return false;}toast('북마크 버튼 삭제 완료');return true;}
$('authorDialogForm').onsubmit=async e=>{e.preventDefault();const t=authorDialogTarget;if(!t||t.mode==='view')return;
 const url=t.mode==='add'?($('url').value||null):t.a.url;const r=await window.aplay.call('authorBookmark',url,$('authorDialogName').value);if(!r.ok){toast(r.error);return;}
 $('authorDialog').close();toast(t.mode==='add'?'북마크 추가 완료':'이름 변경 완료');};
$('authorDialogBrowse').onclick=()=>{const t=authorDialogTarget;$('authorDialog').close();if(t)openEmbedded(t.a.url);};
$('authorDialogRemove').onclick=async()=>{const t=authorDialogTarget;if(t&&await removeAuthorBookmark(t.a))$('authorDialog').close();};
$('authorDialogCancel').onclick=()=>$('authorDialog').close();
$('restoreDefaultAuthors').onclick=async()=>{const r=await window.aplay.call('authorDefaultsRestore');if(!r.ok){toast(r.error);return;}toast('기본 업로더를 다시 표시했습니다.');};

// 카드 동작 아이콘 버튼 (이름은 툴팁·스크린리더용 aria-label)
const ICONS={
 star:'<path d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.6 9.7l5.8-.8z"/>',
 'star-fill':'<path class="fill" d="M12 3.6l2.6 5.3 5.8.8-4.2 4.1 1 5.8L12 16.9l-5.2 2.7 1-5.8L3.6 9.7l5.8-.8z"/>',
 open:'<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
 max:'<path d="M12 3l8 4.5v9L12 21l-8-4.5v-9z M12 12l8-4.5 M12 12v9 M12 12L4 7.5"/>',
 download:'<path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19h14"/>'
};
// label is always the accessible name; the tooltip is left out for icons that explain themselves (star, download arrow)
const PLAIN_ICONS=new Set(['star','star-fill','download']);
function iconButton(icon,label,title,cls=''){const b=text('button','','quiet icon-btn'+(cls?' '+cls:''));b.type='button';if(!PLAIN_ICONS.has(icon))b.title=label;b.setAttribute('aria-label',translated(title)+' '+label);b.innerHTML='<svg viewBox="0 0 24 24" aria-hidden="true">'+ICONS[icon]+'</svg>';return b;}

// 설정 창 (헤더 톱니 아이콘)
$('settingsBtn').onclick=()=>{$('settingsDialog').showModal();for(const e of Object.keys(LLM))void refreshAccount(e);};$('settingsDialogClose').onclick=()=>$('settingsDialog').close();
$('trQuick').onchange=async()=>{const v=$('trQuick').value;
 if(v==='off'){await changeTranslation(false);syncQuickValue();return;}
 if(state.autoTranslate===false)await changeTranslation(true);
 const i=v.indexOf(':');await switchEngine(i<0?v:v.slice(0,i),i<0?undefined:v.slice(i+1));syncQuickValue();};

// 메인 화면 안 모델 디스플레이 뷰어 (WebContentsView를 #viewerStage 위치에 겹쳐 표시)
let viewerWork=null;
function viewerRect(){const r=$('viewerStage').getBoundingClientRect();return {x:r.left,y:r.top,width:r.width,height:r.height};}
async function openViewer(w){
  viewerWork=w;$('viewerStatus').textContent='';
  $('viewerOverlay').hidden=false;$('viewerOverlay').dataset.status='loading';
  await new Promise(r=>requestAnimationFrame(()=>r()));
  const r=await window.aplay.call('viewerOpen',w.id,viewerRect());
  if(!r.ok){$('viewerStatus').textContent=r.error;$('viewerOverlay').dataset.status='error';}
}
function closeViewer(){if($('viewerOverlay').hidden)return;$('viewerOverlay').hidden=true;viewerWork=null;void window.aplay.call('viewerClose');}
window.aplay.onViewer(s=>{if(!viewerWork||s.id!==viewerWork.id)return;$('viewerOverlay').dataset.status=s.status;$('viewerStatus').textContent=s.status==='error'?(s.error||'오류'):'';});
// The same three buttons drawn inside the model display page (src/viewer-preload.js), which covers the ones in #viewerStage.
window.aplay.onViewerAction?.(action=>{({post:$('viewerPost'),download:$('viewerDownload'),close:$('viewerClose'),uploader:$('viewerUploader')})[action]?.click();});
// 업로더 페이지: 뷰어를 닫고 내장 탐색기에서 그 업로더의 페이지를 연다.
$('viewerUploader').onclick=async()=>{const w=viewerWork;if(!w)return;closeViewer();const r=await window.aplay.call('uploaderUrl',w.id);if(!r.ok){toast(r.error);return;}void openEmbedded(r.value);};
$('viewerClose').onclick=closeViewer;
$('viewerPost').onclick=()=>{const w=viewerWork;if(!w)return;closeViewer();call('openPost',w.id,true);};
$('viewerDownload').onclick=()=>{const w=viewerWork;if(!w)return;closeViewer();void downloadOne(w);};
$('viewerOverlay').addEventListener('mousedown',e=>{if(e.target===$('viewerOverlay'))closeViewer();});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('viewerOverlay').hidden){e.preventDefault();closeViewer();}});
new ResizeObserver(()=>{if(!$('viewerOverlay').hidden)void window.aplay.call('viewerBounds',viewerRect());}).observe($('viewerStage'));
$('helpClose').onclick=()=>$('helpDialog').close();
$('helpDialog').addEventListener('click',e=>{if(e.target===$('helpDialog'))$('helpDialog').close();});
document.addEventListener('mousedown',e=>{const d=$('filterDetails');if(d.open&&!d.contains(e.target))d.open=false;});

let engineSwitching=false;
async function switchEngine(engine,model){
  // One change at a time: the account check and the dialogs take a moment, and a second pick in between would race the first.
  if(engineSwitching){if(trState)renderTranslationEngine(trState);return;}
  engineSwitching=true;for(const id of ['trQuick','trEngine','trModel'])$(id).disabled=true;closeEngineMenu();syncEngineMenu();
  try{await switchEngineNow(engine,model);}finally{engineSwitching=false;for(const id of ['trQuick','trEngine'])$(id).disabled=false;$('trModel').disabled=trState?!LLM[trState.engine]:false;syncEngineMenu();}
}
async function switchEngineNow(engine,model){
  const llm=LLM[engine];
  model=llm?(model||llm.model(trState||{})):undefined;
  const key=llm?engine+':'+model:'google',now=trState?engineKey(trState):'';
  if(key===now){if(trState)renderTranslationEngine(trState);return;}
  const label=engineName(engine,model);const ro=({'Claude Sonnet':'Claude Sonnet으로','Claude Haiku':'Claude Haiku로'})[label]||withRo(label);
  // Claude / ChatGPT: make sure the CLI is installed and signed in before switching; otherwise walk the user through connecting.
  let accountNote='';
  if(llm){const acc=await ensureAccount(engine);if(!acc){if(trState)renderTranslationEngine(trState);return;}accountNote=acc.email?' 연결된 계정: '+acc.email:'';}
  const saved=trState?.saved?.[llm?llm.bucket(trState||{},model):'google']||0;
  const fresh=await appConfirm(ro+' 바꿉니다. 이미 번역된 항목도 '+ro+' 다시 번역할까요?'+(saved?'\n'+ro+' 저장된 번역 '+saved+'개는 바로 불러옵니다.':''),
    {title:'번역 엔진 변경',ok:'새로 번역',cancel:'기존 번역 유지',note:llm?llm.usage+accountNote:''});
  if(fresh===null){if(trState)renderTranslationEngine(trState);return;}
  const r=await translationEngine('switch',{engine,model,fresh});if(!r)return;
  translationEpoch++;translationQueue.clear();translatedNames.clear();translationRetry=0;
  const c=await window.aplay.call('translationCache').catch(()=>null);if(c?.ok&&c.value)for(const [k,v] of Object.entries(c.value))translatedNames.set(k,v);
  render();toast(ro+(fresh?' 다시 번역합니다.':' 바꿨습니다. 새 항목부터 적용됩니다.'));
}

// 계정 연결 확인(Claude · ChatGPT). 연결되어 있으면 계정 정보를, 사용자가 그만두면 null을 돌려준다.
async function accountStatus(engine){return window.aplay.call(LLM[engine].account,'status');}
async function claudeStatus(){return accountStatus('claude');}
async function ensureAccount(engine){
  const llm=LLM[engine];
  $('translationStatus').textContent=llm.label+' 계정 확인 중…';let r;
  try{r=await (engine==='claude'?claudeStatus():accountStatus(engine));}catch(e){r={ok:false,error:String(e?.message||e)};}finally{$('translationStatus').textContent='';}
  if(r.ok&&r.value?.loggedIn)return r.value;
  // 연결되어 있지 않으면 묻지 않고 바로 연결 창을 띄워 브라우저 로그인을 진행한다.
  if(r.ok)return accountLoginDialog(engine);
  if(/찾지 못했습니다/.test(r.error||'')){
    const open=await appConfirm(llm.product+'를 찾지 못했습니다.\n\n1. '+llm.app+'을 설치하고 한 번 실행합니다.\n2. 다시 번역 엔진을 '+llm.label+'로 바꾸면 계정 연결을 진행합니다.\n\n다른 위치에 설치했다면 번역 설정에서 '+llm.exeName+'를 직접 지정할 수 있습니다.',
      {title:llm.product+' 설치 필요',ok:'번역 설정 열기',cancel:'취소'});
    if(open&&await translationEngine('get')){if(trState)renderTranslationEngine({...trState,engine,test:null});$('trDialog').showModal();}
    return null;
  }
  const go=await appConfirm(llm.label+' 계정 상태를 확인하지 못했습니다.\n'+(r.error||'')+'\n\n그래도 '+llm.label+'로 바꿀까요? 로그인되어 있지 않으면 번역은 Google 번역으로 대체됩니다.',{title:llm.label+' 계정 확인 실패',ok:'계속',cancel:'취소'});
  return go?{loggedIn:false,email:''}:null;
}
// 계정 연결 창: 브라우저 로그인을 시작하고 끝날 때까지 기다린다. 연결되면 계정 정보, 그만두면 null.
let claudeLoginListener=null,loginProvider='';
window.aplay.onClaudeLogin?.(s=>{if(!s.provider||s.provider===loginProvider)claudeLoginListener?.(s);});
async function claudeLoginCall(op,value){return window.aplay.call(LLM[loginProvider||'claude'].account,op,value);}
function claudeLoginDialog(){return accountLoginDialog('claude');}
function accountLoginDialog(engine){
  const llm=LLM[engine];loginProvider=engine;
  return new Promise(resolve=>{
    const d=document.createElement('dialog');d.className='max-dialog app-confirm claude-login';
    const h=text('h2',llm.label+' 계정 연결'),p=text('p','브라우저에서 '+llm.label+' 로그인 페이지를 엽니다. 로그인하고 승인하면 자동으로 연결됩니다.'+(llm.code?'\n승인 뒤 화면에 코드가 표시되면 아래 칸에 붙여 넣어 주세요.':''));
    const status=text('p','로그인 페이지를 여는 중…','confirm-note claude-login-status');status.setAttribute('role','status');
    const row=text('div','','claude-login-code'),input=document.createElement('input');input.placeholder='브라우저에 표시된 코드 (표시될 때만)';input.setAttribute('aria-label',llm.label+' 로그인 코드');input.autocomplete='off';input.spellcheck=false;
    const send=text('button','코드 입력','quiet');send.type='button';row.append(input,send);row.hidden=!llm.code;
    const actions=text('div','','app-confirm-actions'),reopen=text('button','브라우저 다시 열기','quiet'),retry=text('button','다시 시도','primary'),cancel=text('button','취소','quiet');
    for(const b of [reopen,retry,cancel])b.type='button';reopen.disabled=true;retry.hidden=true;actions.append(reopen,cancel,retry);
    d.append(h,p,row,status,actions);document.body.append(d);
    let done=false;const finish=v=>{if(done)return;done=true;claudeLoginListener=null;if(!v)void claudeLoginCall('loginCancel').catch(()=>{});d.close();d.remove();resolve(v);};
    const fail=message=>{status.textContent=message;status.classList.add('error');retry.hidden=false;reopen.disabled=true;send.disabled=true;};
    const begin=async()=>{status.classList.remove('error');status.textContent='로그인 페이지를 여는 중…';retry.hidden=true;reopen.disabled=true;send.disabled=false;const r=await claudeLoginCall('login').catch(e=>({ok:false,error:String(e?.message||e)}));if(done)return;if(!r.ok)fail(r.error);};
    claudeLoginListener=s=>{if(done)return;
      if(s.state==='url'){status.textContent='브라우저에서 로그인과 승인을 기다리는 중…';reopen.disabled=!s.url;}
      else if(s.state==='done'){toast(llm.label+' 계정에 연결했습니다.'+(s.account?.email?' ('+s.account.email+')':''));finish(s.account);}
      else if(s.state==='error')fail(s.error||llm.label+' 로그인에 실패했습니다.');};
    reopen.onclick=async()=>{const r=await claudeLoginCall('loginOpen');if(!r.ok)toast(r.error);};
    const submit=async()=>{const code=input.value.trim();if(!code){input.focus();return;}const r=await claudeLoginCall('loginCode',code);if(!r.ok){toast(r.error);return;}input.value='';status.textContent='코드를 확인하는 중…';};
    send.onclick=submit;input.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();void submit();}});
    retry.onclick=()=>void begin();cancel.onclick=()=>finish(null);
    d.addEventListener('cancel',e=>{e.preventDefault();finish(null);});
    d.showModal();void begin();
  });
}
// 설정 창: 연결된 Claude · ChatGPT 계정 표시·로그아웃
function showAccount(engine,a){
  const llm=LLM[engine];const plan=a?.plan?' ('+a.plan[0].toUpperCase()+a.plan.slice(1)+')':'';
  $(engine+'Account').textContent=a?.loggedIn?llm.label+' 계정: '+(a.email||(a.method?'연결됨 · '+a.method+' 로그인':'로그인됨'))+plan:llm.label+' 계정: 연결되지 않음 (번역 엔진을 '+llm.label+'로 바꾸면 연결)';
  $(engine+'Logout').hidden=!a?.loggedIn;
}
async function refreshAccount(engine){
  const llm=LLM[engine];$(engine+'Account').textContent=llm.label+' 계정 확인 중…';$(engine+'Logout').hidden=true;
  const r=await (engine==='claude'?claudeStatus():accountStatus(engine)).catch(e=>({ok:false,error:String(e?.message||e)}));
  if(!r.ok){$(engine+'Account').textContent=llm.label+' 계정: '+(/찾지 못했습니다/.test(r.error||'')?llm.product+' 미설치':'확인할 수 없음 ('+r.error+')');return;}
  showAccount(engine,r.value);
}
for(const engine of Object.keys(LLM))$(engine+'Logout').onclick=async()=>{
  const llm=LLM[engine],b=$(engine+'Logout');
  if(!await appConfirm('이 PC의 '+llm.product+' 로그인을 해제합니다. '+llm.app+'도 함께 로그아웃되며, 다시 쓰려면 번역 엔진을 '+llm.label+'로 바꿔 다시 연결해야 합니다.',{title:llm.label+' 계정 로그아웃',ok:'로그아웃',danger:true}))return;
  b.disabled=true;
  try{const r=await window.aplay.call(llm.account,'logout');if(!r.ok){toast(r.error);return;}showAccount(engine,r.value);toast(llm.label+' 계정에서 로그아웃했습니다. '+llm.label+' 번역은 Google 번역으로 대체됩니다.');}
  finally{b.disabled=false;}
};
$('translateFileNames').onchange=async()=>{const r=await window.aplay.call('fileNameTranslation',$('translateFileNames').checked);if(!r.ok){toast(r.error);$('translateFileNames').checked=!$('translateFileNames').checked;}};
