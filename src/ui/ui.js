'use strict';
const $=id=>document.getElementById(id);let state={works:[]},lastAccount=null,settingsDirty=false,toastTimer,renderTimer;
let activeTab='all',notificationSaving=false;
const translatedNames=new Map(),translationQueue=new Set();let translationBusy=false,translationSave=false,translationRetry=0,translationEpoch=0;
function translated(value){value=String(value||'');if(!state.autoTranslate)return value;if(translatedNames.has(value))return translatedNames.get(value);if(/[\u3400-\u9fff]/u.test(value)&&!/[\u3040-\u30ff]/u.test(value)&&value.length<=1800){translationQueue.add(value);setTimeout(flushTranslations,0);}return value;}
async function flushTranslations(){
 if(translationBusy||translationSave||!state.autoTranslate||Date.now()<translationRetry||!translationQueue.size)return;
 translationBusy=true;const epoch=translationEpoch;const texts=[...translationQueue].slice(0,12);for(const t of texts)translationQueue.delete(t);
 $('translationStatus').textContent='번역 중…';
 try{const r=await window.aplay.call('translateTexts',texts);if(!r.ok){translationRetry=Date.now()+60000;$('translationStatus').textContent=r.error;for(const t of texts)translationQueue.add(t);setTimeout(flushTranslations,61000);return;}
  if(state.autoTranslate&&epoch===translationEpoch){for(const item of r.value)translatedNames.set(item.original,item.text);$('translationStatus').textContent='';render();}
 }finally{translationBusy=false;if(state.autoTranslate&&translationQueue.size&&Date.now()>=translationRetry)setTimeout(flushTranslations,50);}
}
async function changeTranslation(enabled){translationEpoch++;translationSave=true;try{const r=await window.aplay.call('autoTranslate',enabled);if(!r.ok){toast(r.error);$('browserMessage').textContent=r.error;}else{state.autoTranslate=enabled;translationRetry=0;if(!enabled){translationQueue.clear();$('translationStatus').textContent='';}}}finally{translationSave=false;render();}}

function inProgress(w){return w.status!=='완료'&&(w.attempted||['조건 확인 중','조건 처리 중','파일 확인 중','다운로드 대기','다운로드 중','파일 선택 가능','사용자 조작 필요','실패','취소'].includes(w.status)||w.files.some(f=>['다운로드 중','실패','취소'].includes(f.status)));}
function catalog(){return [...new Map([...(state.bookmarks||[]),...state.works].map(w=>[w.id,w])).values()];}
function tabWorks(){if(activeTab==='bookmarks')return state.bookmarks||[];if(activeTab==='all')return state.works;return catalog().filter(w=>activeTab==='progress'?inProgress(w):w.status==='완료');}
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
 const shortcuts=$('defaultAuthorButtons');
 if(!shortcuts.children.length&&(state.defaultAuthors||[]).length){for(const a of state.defaultAuthors){const button=text('button',a.name,'quiet');button.type='button';button.dataset.authorId=a.id;button.title=a.name+' 자료 목록 불러오기';button.onclick=async()=>{
  if(state.busy){toast('현재 작업이 끝난 뒤 작가를 전환해 주세요.');return;}
  const result=await window.aplay.call('load',a.url,$('scope').value);if(!result.ok){toast(result.error);return;}
  $('url').value=a.url;activeTab='all';$('search').value='';render();
 };shortcuts.append(button);}}
 for(const button of shortcuts.children){const active=String(state.author||'')===button.dataset.authorId;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));}

  if(window.listDragActive)return;
 const filterCount=document.querySelectorAll('#filter input:checked').length;$('activeFilterCount').textContent=filterCount?filterCount+'개 적용':'전체 표시';

  if(!translationSave){$('autoTranslate').checked=!!state.autoTranslate;$('browserTranslate').checked=!!state.autoTranslate;}
  const authorSelect=$('authorBookmarks'),previousAuthor=authorSelect.value;authorSelect.replaceChildren(new Option('작가 선택',''));
  for(const [label,prefix,authors] of [['기본 제공 작가','default:',state.defaultAuthors||[]],['내 작가 북마크','saved:',state.authorBookmarks||[]]]){if(!authors.length)continue;const group=document.createElement('optgroup');group.label=label;for(const a of authors)group.append(new Option(translated(a.name),prefix+a.id));authorSelect.append(group);}authorSelect.value=previousAuthor;
  $('removeAuthor').disabled=!authorSelect.value.startsWith('saved:');

  for(const [tab,label,count] of [['all','전체 목록',state.works.length],['progress','다운로드 진행',catalog().filter(inProgress).length],['done','완료',catalog().filter(w=>w.status==='완료').length],['bookmarks','북마크',(state.bookmarks||[]).length]]){const button=$('tab-'+tab);button.textContent=label+' ('+count+')';button.classList.toggle('active',activeTab===tab);button.setAttribute('aria-selected',String(activeTab===tab));}
  if(!notificationSaving)$('notifyOnComplete').checked=state.notifyOnComplete!==false;
  $('account').textContent=state.account?`계정 ${state.account}`:'로그인하지 않음';$('folder').textContent=state.folder||'저장 폴더를 선택해 주세요.';$('folder').title=state.folder||'';$('message').textContent=state.message||'준비됨';$('count').textContent=`${state.works.length}개${state.complete?'':' · 전체 조회 미확인'}`;$('busy').classList.toggle('active',!!state.busy);
  for(const id of ['load','refresh','folderBtn','save','start','retry','all','none','filtered','missing','selectAbsent','logout','follow','like','collect','concurrency','scope'])$(id).disabled=false;$('cancel').disabled=!state.busy;
  if(lastAccount!==state.account){lastAccount=state.account;settingsDirty=false;}
  if(!settingsDirty){for(const k of ['follow','like','collect'])$(k).checked=!!state.settings?.[k];$('concurrency').value=String(state.concurrency||2);}
  $('consent').textContent=state.settings?.confirmed?'현재 계정에 저장된 범위로 자동 처리합니다. 설정 변경 후에는 다시 저장해 주세요.':'로그인 후 자동 처리 범위를 저장해 주세요. 모든 옵션을 꺼도 저장할 수 있습니다.';
  const selected=tabWorks().filter(w=>w.selected),files=selected.flatMap(w=>w.files.filter(f=>f.selected)),known=files.filter(f=>f.size!=null),unknown=selected.filter(w=>!w.files.length).length;
  $('summary').textContent=`게시물 ${selected.length}개 · 파일 ${files.length}개 · 확인된 용량 ${bytes(known.reduce((s,f)=>s+Number(f.size),0))}${unknown||known.length<files.length?' + 미확인':''}`;
  const list=$('list'),scroll=list.scrollTop,frag=document.createDocumentFragment();
  for(const w of filtered()){
    const row=text('article','','work'),cb=document.createElement('input');cb.type='checkbox';cb.checked=!!w.selected;cb.indeterminate=w.selected&&w.files.some(f=>!f.selected);cb.disabled=false;cb.setAttribute('aria-label',w.title+' 선택');cb.onchange=()=>call('selection',[{id:w.id,selected:cb.checked}]);row.dataset.workId=w.id;row.append(cb);row.classList.toggle('selected',!!w.selected);
    const img=document.createElement('img');img.className='cover';img.alt='';img.loading='lazy';try{const u=new URL(w.cover);if(u.protocol==='https:'&&u.hostname.endsWith('.aplaybox.com'))img.src=u.href;}catch{}row.append(img);
    const info=text('div','','info');info.append(Object.assign(text('div',translated(w.title),'title'),{title:w.title}));info.append(text('div',`${w.type===1?'모델':'모션'} · ${translated(w.author)} · ${w.date||'날짜 확인 불가'}`,'meta'));
    const badges=text('div','','badges');if(!w.detailLoaded)badges.append(text('span',w.status==='조건 확인 중'?'조건 확인 중':'다운로드 시 조건 확인','badge'));else if(!w.rules.length)badges.append(text('span','추가 조건 없음','badge met'));for(const r of w.rules)badges.append(text('span',r.label+(r.met?' ✓':''),'badge'+(r.met?' met':'')));info.append(badges);info.append(text('div',w.message||'','message'));row.append(info);
    const actions=text('div','','actions');const stateEl=text('span',w.status,'state');stateEl.dataset.status=w.status||'';actions.append(stateEl);const bookmark=text('button',w.bookmarked?'★ 북마크 해제':'☆ 북마크','quiet');bookmark.setAttribute('aria-pressed',String(!!w.bookmarked));bookmark.onclick=()=>call('bookmark',w.id);actions.append(bookmark);if(w.existingPath){const present=text('span','폴더에 있음','badge met');present.title=w.existingPath;actions.append(present);}const open=text('button','게시물 열기','quiet');open.onclick=()=>call('openPost',w.id);actions.append(open);row.append(actions);
    if(w.files.length){const container=text('div','','files');for(const f of w.files){const item=text('div','','file'),fc=document.createElement('input');fc.type='checkbox';fc.checked=!!f.selected;fc.disabled=false;fc.setAttribute('aria-label',f.name+' 선택');fc.onchange=()=>call('selection',[{id:w.id,fileId:f.id,selected:fc.checked}]);item.append(fc,text('span',f.name),text('small',`${bytes(f.size||f.total)} · ${f.status}`));if(f.status==='다운로드 중'){const p=document.createElement('progress');if(f.total){p.max=f.total;p.value=f.loaded||0;}item.append(p);item.append(text('small',`${bytes(f.loaded||0)} · ${bytes(f.speed||0)}/s`,'error'));}if(f.message)item.append(text('small',f.message,'error'));container.append(item);}row.append(container);}frag.append(row);
  }
  if(!frag.children.length)frag.append(text('div',state.works.length?'검색 조건에 맞는 자료가 없습니다.':'작가 링크를 넣고 목록을 불러오세요. 목록 조회는 계정 행동을 실행하지 않습니다.','empty'));
  list.replaceChildren(frag);list.scrollTop=scroll;
  if(typeof renderActivity==='function')renderActivity();
}
function update(s){if(!s)return;state=s;const key=JSON.stringify([s.folder,s.busy,catalog().map(w=>[w.id,w.files.length,w.status])]);if($('excludeFolder').checked&&key!==scanKey&&!scanPending){scanKey=key;void refreshPresence();}if(!renderTimer)renderTimer=setTimeout(()=>{renderTimer=null;render();},100);}
window.aplay.onState(update);
window.aplay.onAuthor(url=>{$('embeddedPanel').hidden=true;$('url').value=url;$('scope').value='all';activeTab='all';$('search').value='';render();});
$('browse').onclick=()=>openEmbedded();
for(const id of ['search','filter','sort'])$(id).addEventListener('input',render);
for(const id of ['follow','like','collect','concurrency'])$(id).addEventListener('change',()=>settingsDirty=true);
$('concurrency').addEventListener('input',()=>settingsDirty=true);
$('load').onclick=()=>call('load',$('url').value,$('scope').value);
$('refresh').onclick=()=>call('refresh',$('url').value,$('scope').value);
$('login').onclick=()=>call('login');$('refreshAccount').onclick=()=>call('refreshAccount');$('logout').onclick=()=>call('logout');$('folderBtn').onclick=()=>call('folder');$('openFolder').onclick=()=>call('openFolder');
$('save').onclick=async()=>{const n=Number($('concurrency').value);if(!Number.isSafeInteger(n)||n<1){toast('동시 다운로드 수는 1 이상의 정수로 입력해 주세요.');return;}await call('settings',{follow:$('follow').checked,like:$('like').checked,collect:$('collect').checked,concurrency:Number($('concurrency').value)});settingsDirty=false;update(await call('snapshot'));};
$('all').onclick=()=>call('selection',tabWorks().map(w=>({id:w.id,selected:true})));$('filtered').onclick=()=>call('selection',filtered().map(w=>({id:w.id,selected:true})));$('none').onclick=()=>call('selection',tabWorks().map(w=>({id:w.id,selected:false})));
$('missing').onclick=()=>call('selectMissing',tabWorks().filter(w=>w.selected).map(w=>w.id),'exclude');
$('selectAbsent').onclick=()=>call('selectMissing',filtered().map(w=>w.id),'replace');
function start(mode){if(settingsDirty){toast('변경한 자동 처리 설정을 먼저 저장해 주세요.');return;}if(scanPending){toast('폴더 검사 완료 후 다운로드해 주세요.');return;}call('start',mode,filtered().filter(w=>w.selected).map(w=>w.id),exclusions());}
$('start').onclick=()=>start('download');$('retry').onclick=()=>start('download');$('cancel').onclick=()=>call('cancel');
call('snapshot').then(s=>{if(s?.sourceUrl)$('url').value=s.sourceUrl;else if(s?.author)$('url').value=`https://www.aplaybox.com/u/${s.author}/model`;if(s?.scope)$('scope').value=s.scope;update(s);});window.addEventListener('focus',()=>call('refreshAccount'));

const thumbnailSizes=[72,120,180,260,360];
let thumbnailIndex=Number(localStorage.getItem('thumbnailSizeIndex')||2);
if(!Number.isInteger(thumbnailIndex)||thumbnailIndex<0||thumbnailIndex>=thumbnailSizes.length)thumbnailIndex=2;
function resizeThumbnails(){
  const size=thumbnailSizes[thumbnailIndex];
  document.documentElement.style.setProperty('--thumbnail-size',size+'px');
  $('thumbnailSize').textContent=size+'px';
  localStorage.setItem('thumbnailSizeIndex',String(thumbnailIndex));
}
$('thumbnailSmaller').onclick=()=>{thumbnailIndex=Math.max(0,thumbnailIndex-1);resizeThumbnails();};
$('thumbnailLarger').onclick=()=>{thumbnailIndex=Math.min(thumbnailSizes.length-1,thumbnailIndex+1);resizeThumbnails();};
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
setupCollapse('toggleSetup',['appHeader','authorSection','sourcePanel','settingsPanel'],'setupCollapsed','상단 설정');
setupCollapse('toggleTools',['listTools'],'listToolsCollapsed','목록 도구');

let listColumns=Number(localStorage.getItem('listColumns')||4);
if(!Number.isInteger(listColumns)||listColumns<1||listColumns>6)listColumns=4;
function applyColumns(){document.documentElement.style.setProperty('--list-columns',String(listColumns));document.documentElement.dataset.columns=String(listColumns);$('columnCount').value=String(listColumns);}
$('columnCount').onchange=()=>{const value=Number($('columnCount').value);if(!Number.isInteger(value)||value<1||value>6)return;listColumns=value;localStorage.setItem('listColumns',String(listColumns));applyColumns();};
applyColumns();

window.aplay.onFinished(result=>toast(result.title+' · '+result.body));

$('notifyOnComplete').onchange=async()=>{
 notificationSaving=true;
 try{await call('completionNotification',$('notifyOnComplete').checked);const s=await call('snapshot');if(s)update(s);}
 finally{notificationSaving=false;render();}
};

async function openEmbedded(url){$('embeddedPanel').hidden=false;$('browserMessage').textContent='페이지 여는 중…';const r=await window.aplay.call('browse',url);if(!r.ok)$('browserMessage').textContent=r.error;else $('browserMessage').textContent='';}
function chosenAuthor(){const [kind,id]=$('authorBookmarks').value.split(':');return (kind==='default'?state.defaultAuthors||[]:state.authorBookmarks||[]).find(a=>a.id===id);}
$('saveAuthor').onclick=async()=>{const r=await call('authorBookmark',$('url').value,$('authorBookmarkName').value);if(r)toast('작가 북마크 저장 완료');};
$('loadAuthor').onclick=()=>{const a=chosenAuthor();if(!a){toast('작가를 선택해 주세요.');return;}$('url').value=a.url;activeTab='all';call('load',a.url,$('scope').value);};
$('browseAuthor').onclick=()=>{const a=chosenAuthor();if(a)openEmbedded(a.url);else toast('작가를 선택해 주세요.');};
$('removeAuthor').onclick=()=>{const a=chosenAuthor();if(a&&$('authorBookmarks').value.startsWith('saved:'))call('authorRemove',a.id);};
$('authorBookmarks').onchange=()=>{$('removeAuthor').disabled=!$('authorBookmarks').value.startsWith('saved:');};
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

for(const id of ['authorSection','downloadSettings','filterDetails']){const panel=$(id);panel.open=localStorage.getItem('readability-'+id)==='true';panel.addEventListener('toggle',()=>localStorage.setItem('readability-'+id,String(panel.open)));}

function updateBackToTop(){
 const embedded=!$('embeddedPanel').hidden,button=$('backToTop'),dock=$('floatingDock');button.hidden=window.scrollY<240||embedded;
 const footer=document.querySelector('footer'),rect=footer.getBoundingClientRect();
 // The floating dock replaces the footer controls while the footer's buttons are scrolled out of view.
 const footerVisible=rect.top<innerHeight&&rect.bottom>0,rowRect=footer.querySelector('.row').getBoundingClientRect();
 if(dock)dock.hidden=embedded||(rowRect.bottom<=innerHeight&&rowRect.top>=0);
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
