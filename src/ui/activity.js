'use strict';
// Job status and actions in the floating dock (bottom-right). It is the only place for them: the page has no footer.
const ACTIVITY_GROUPS=[
 ['check','조건 확인',w=>['조건 확인 중','조건 처리 중','파일 확인 중'].includes(w.status)],
 ['queued','대기',w=>['다운로드 대기','대기','파일 선택 가능'].includes(w.status)],
 ['active','다운로드 중',w=>w.status==='다운로드 중'],
 ['waiting','인증 필요',w=>w.status==='사용자 조작 필요'],
 ['done','완료',w=>w.status==='완료'],
 ['failed','실패',w=>['실패','취소','조회 실패'].includes(w.status)]
];
function activityModel(s=state){
 const works=[...new Map([...(s.bookmarks||[]),...(s.works||[])].map(w=>[w.id,w])).values()];
 const batch=works.filter(w=>w.attempted);
 const counts=Object.fromEntries(ACTIVITY_GROUPS.map(([key,,test])=>[key,batch.filter(test).length]));
 const files=batch.flatMap(w=>(w.files||[]).filter(f=>f.selected));
 const doneFiles=files.filter(f=>f.status==='완료').length;
 const active=files.filter(f=>f.status==='다운로드 중');
 const loaded=active.reduce((n,f)=>n+(Number(f.loaded)||0),0),total=active.reduce((n,f)=>n+(Number(f.total||f.size)||0),0),speed=active.reduce((n,f)=>n+(Number(f.speed)||0),0);
 let phase,tone,progress=null;
 if(s.busy){
  tone='busy';
  if(s.job==='list'){phase='목록 조회 중';}
  else if(s.job==='scan'){phase='폴더 검사 중';}
  else if(active.length){phase='다운로드 중';}
  else if(counts.check){phase='조건·첨부 확인 중';}
  else if(s.job==='download'){phase='다운로드 준비 중';}
  else phase='작업 진행 중';
  if(s.job==='download'&&files.length)progress=(doneFiles+(total?loaded/total*active.length:0))/files.length;
 }
 else if(counts.waiting){phase='사용자 조작 필요';tone='warn';}
 else if(counts.failed){phase='일부 실패';tone='error';}
 else if(batch.length&&counts.done===batch.length){phase='완료';tone='done';progress=1;}
 else{phase='준비됨';tone='idle';}
 // A finished result stays until the user acknowledges it; the key changes whenever any status changes again.
 const key=activityKey(batch);let acked=false;
 if(!s.busy&&tone!=='idle'&&key===readAck()){phase='준비됨';tone='idle';progress=null;acked=true;}
 return {phase,tone,progress,counts,batch:batch.length,files:files.length,doneFiles,active:active.length,loaded,total,speed,listed:(s.works||[]).length,job:s.busy?s.job:null,key,acked};
}
function activityKey(batch){
 const text=batch.map(w=>w.id+':'+w.status+':'+(w.files||[]).filter(f=>f.selected).map(f=>f.status).join(',')).sort().join('|');
 let h=5381;for(let i=0;i<text.length;i++)h=((h<<5)+h+text.charCodeAt(i))>>>0;
 return batch.length+'-'+h.toString(36);
}
function readAck(){try{return localStorage.getItem('activity-ack')||'';}catch{return '';}}
function acknowledgeActivity(key){try{localStorage.setItem('activity-ack',key);}catch{}renderActivity();}
function activityDetail(m){
 if(m.acked)return '진행 중인 작업 없음';
 if(m.job==='list')return `게시물 ${m.listed}개 조회됨`;
 if(m.job==='scan')return '저장 폴더의 기존 파일 확인';
 const parts=[];
 if(m.files)parts.push(`파일 ${m.doneFiles}/${m.files}개 완료`);else if(m.batch)parts.push(`게시물 ${m.batch}개`);
 if(m.active)parts.push(`${m.active}개 전송 중`+(m.total?` · ${bytes(m.loaded)} / ${bytes(m.total)}`:''));
 if(m.speed)parts.push(`${bytes(m.speed)}/s`);
 return parts.join(' · ')||'진행 중인 작업 없음';
}
function buildActivity(el,m,compact){
 el.dataset.tone=m.tone;el.replaceChildren();
 const head=document.createElement('div');head.className='activity-head';
 const dot=document.createElement('span');dot.className='activity-dot';
 head.append(dot,text('span',m.phase,'activity-phase'),text('span',activityDetail(m),'activity-detail'));
 if(!m.job&&['done','warn','error'].includes(m.tone)){const ack=text('button','확인','quiet activity-ack');ack.type='button';ack.title='결과 알림을 닫습니다. 탭의 기록은 그대로 남습니다.';ack.onclick=()=>acknowledgeActivity(m.key);head.append(ack);}
 el.append(head);
 const chips=document.createElement('div');chips.className='activity-chips';
 if(!m.acked)for(const [key,label] of ACTIVITY_GROUPS){const n=m.counts[key];if(compact&&!n)continue;const chip=text('span',label,'chip'+(n?'':' zero'));chip.dataset.key=key;chip.append(text('b',String(n)));chips.append(chip);}
 if(chips.children.length)el.append(chips);
 if(m.tone==='busy'||m.progress!=null){
  const bar=document.createElement('progress');bar.className='activity-bar';
  if(m.progress!=null){bar.max=1;bar.value=Math.min(1,Math.max(0,m.progress));}
  bar.setAttribute('aria-label','작업 진행률');el.append(bar);
 }
}
function renderActivity(){
 const m=activityModel();
 buildActivity($('dockActivity'),m,true);
 $('dockSummary').textContent=$('summary').textContent;
 // 필요할 때만 표시: 선택 다운로드(선택 있음), 재시도(실패·인증 필요 있음), 취소(작업 중)
 const busy=!!state.busy;$('dockCancel').disabled=!busy;$('dockCancel').hidden=!busy;
 $('dockStart').hidden=busy||!selectedWorks().length;
 $('dockRetry').hidden=busy||!((m.counts.failed||0)+(m.counts.waiting||0));
 $('dockMaxImport').hidden=!maxImportTargets().length;
 // 아무 작업도 없으면 상태 줄을 숨기고, 버튼도 없으면 독 전체를 숨긴다.
 const idle=!busy&&m.tone==='idle';$('floatingDock').classList.toggle('idle',idle);
 $('floatingDock').classList.toggle('empty',idle&&$('dockStart').hidden&&$('dockRetry').hidden&&$('dockCancel').hidden&&$('dockMaxImport').hidden);
 $('floatingDock').classList.toggle('busy',!!state.busy);
 renderFloatingClear();renderFloatingForget();
 document.documentElement.classList.toggle('no-list',!(state.works||[]).length&&!state.busy);
 updateBackToTop();
}
// Floating 'clear selection' button (bottom-left) while any post is selected.
function selectedWorks(){return [...new Map([...(state.bookmarks||[]),...(state.works||[])].map(w=>[w.id,w])).values()].filter(w=>w.selected);}
function renderFloatingClear(){const n=selectedWorks().length,b=$('floatingClear');b.hidden=!n;b.disabled=!!state.busy;$('floatingClearCount').textContent=n?String(n):'';b.removeAttribute('title');if(state.busy)b.dataset.tip='작업 중에는 선택을 바꿀 수 없습니다';else delete b.dataset.tip;}
// Record-delete button (bottom-left, above the clear button): on the 다운로드 완료 tab it removes download records,
// on the 임포트 완료 tab 3ds Max import records. Files on disk and Max scenes are never touched.
const FORGET={
 done:{label:'다운로드 기록 삭제',method:'downloadForget',pick:w=>w.selected&&w.status==='완료',note:'다운로드 완료 탭에서 빠지고 다운로드 기록(경로·SHA-256)이 지워집니다. 내려받은 파일은 그대로 남습니다.'},
 imported:{label:'임포트 기록 삭제',method:'maxImportForget',pick:w=>w.selected&&w.maxImport,note:'임포트 완료 탭에서만 빠집니다. 다운로드한 파일과 3ds Max 씬은 그대로입니다.'}
};
function forgetTargets(){const f=FORGET[activeTab];return f?tabWorks().filter(f.pick):[];}
function renderFloatingForget(){const f=FORGET[activeTab],n=forgetTargets().length,b=$('floatingForget');b.hidden=!n;if(!f)return;$('floatingForgetLabel').textContent=f.label;$('floatingForgetCount').textContent=n?String(n):'';b.disabled=activeTab==='done'&&!!state.busy;b.title=b.disabled?'작업이 끝난 뒤 삭제할 수 있습니다':'선택한 자료 '+n+'개의 '+f.label.replace(' 삭제','')+'을 삭제합니다 (파일은 그대로 남습니다)';}
$('floatingForget').onclick=async()=>{const f=FORGET[activeTab],list=forgetTargets();if(!f||!list.length)return;
 if(!await appConfirm('선택한 자료 '+list.length+'개의 '+f.label.replace(' 삭제','')+'을 삭제할까요?',{title:f.label,ok:'삭제',danger:true,note:f.note}))return;
 const r=await window.aplay.call(f.method,list.map(w=>w.id));if(!r.ok){toast(r.error);return;}toast(f.label.replace(' 삭제','')+' '+r.value+'개를 삭제했습니다.');};
$('floatingClear').onclick=()=>{const list=selectedWorks();if(list.length)call('selection',list.map(w=>({id:w.id,selected:false})));};
$('dockStart').onclick=()=>start('download');$('dockRetry').onclick=()=>start('download');$('dockCancel').onclick=()=>call('cancel');
// While a job runs, only finished posts the user selected meanwhile (not the posts being downloaded) go to 3ds Max.
function maxImportTargets(){return state.busy?selectedWorks().filter(w=>w.picked&&w.status==='완료'):selectedWorks();}
$('dockMaxImport').onclick=()=>maxImport(maxImportTargets().map(w=>w.id));
(()=>{const dock=$('floatingDock'),toggle=$('dockToggle');
 const apply=collapsed=>{dock.classList.toggle('collapsed',collapsed);toggle.textContent=collapsed?'▴':'▾';toggle.setAttribute('aria-expanded',String(!collapsed));toggle.title=collapsed?'현황 펼치기':'현황 접기';};
 let collapsed=false;try{collapsed=localStorage.getItem('dock-collapsed')==='true';}catch{}
 apply(collapsed);
 toggle.onclick=()=>{collapsed=!collapsed;apply(collapsed);try{localStorage.setItem('dock-collapsed',String(collapsed));}catch{}};
})();
renderActivity();updateBackToTop();
