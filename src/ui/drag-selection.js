'use strict';
(()=>{
 const list=document.getElementById('list');let gesture=null,frame=0;
 const intersects=(a,b)=>a.left<=b.right&&a.right>=b.left&&a.top<=b.bottom&&a.bottom>=b.top;
 function paint(){
  if(!gesture?.active)return;const g=gesture,rect={left:Math.min(g.startX,g.clientX+scrollX),right:Math.max(g.startX,g.clientX+scrollX),top:Math.min(g.startY,g.clientY+scrollY),bottom:Math.max(g.startY,g.clientY+scrollY)};
  Object.assign(g.box.style,{left:rect.left-scrollX+'px',top:rect.top-scrollY+'px',width:rect.right-rect.left+'px',height:rect.bottom-rect.top+'px'});
  g.hits.clear();for(const row of g.rows){const r=row.getBoundingClientRect();const hit=intersects(rect,{left:r.left+scrollX,right:r.right+scrollX,top:r.top+scrollY,bottom:r.bottom+scrollY});if(hit)g.hits.add(row.dataset.workId);const selected=hit||(g.add&&g.initial.has(row.dataset.workId));row.classList.toggle('drag-selected',selected);row.classList.toggle('drag-unselected',!selected);const cb=row.querySelector(':scope > input');cb.checked=selected;cb.indeterminate=false;}
 }
 function tick(){if(!gesture?.active)return;const y=gesture.clientY,speed=y<60?-Math.ceil((60-y)/4):y>innerHeight-60?Math.ceil((y-innerHeight+60)/4):0;if(speed)window.scrollBy(0,Math.max(-24,Math.min(24,speed)));paint();frame=requestAnimationFrame(tick);}
 function finish(commit){const g=gesture;if(!g)return;gesture=null;cancelAnimationFrame(frame);if(list.hasPointerCapture(g.pointerId))list.releasePointerCapture(g.pointerId);g.box?.remove();document.body.classList.remove('drag-selecting');window.listDragActive=false;for(const row of g.rows)row.classList.remove('drag-selected','drag-unselected');
  if(commit&&g.active){const changes=g.rows.map(row=>{const id=row.dataset.workId;return {id,selected:g.hits.has(id)||(g.add&&g.initial.has(id))};});void call('selection',changes);}
  if(commit&&!g.active&&g.card){const hit=document.elementFromPoint(g.clientX,g.clientY);if(hit?.closest('.work')===g.card)void call('selection',[{id:g.card.dataset.workId,selected:!g.initial.has(g.card.dataset.workId)}]);}
  if(g.active)render();
 }
 list.addEventListener('pointerdown',e=>{
  if(e.button!==0||e.pointerType==='touch'||e.target.closest('button,input,a,select,textarea,.files,.files-box'))return;
  if(state.busy&&!['done','imported'].includes(activeTab)){toast('작업 중에는 다운로드 완료 탭의 자료만 선택할 수 있습니다.');return;}
  const rows=[...list.querySelectorAll('.work')];if(!rows.length)return;
  gesture={card:e.target.closest('.work'),pointerId:e.pointerId,startX:e.pageX,startY:e.pageY,clientX:e.clientX,clientY:e.clientY,rows,initial:new Set(rows.filter(r=>r.querySelector(':scope > input').checked).map(r=>r.dataset.workId)),hits:new Set(),add:true,active:false};
  list.setPointerCapture(e.pointerId);e.preventDefault();
 });
 list.addEventListener('pointermove',e=>{const g=gesture;if(!g||e.pointerId!==g.pointerId)return;g.clientX=e.clientX;g.clientY=e.clientY;if(!g.active&&Math.hypot(e.pageX-g.startX,e.pageY-g.startY)>=6){g.active=true;window.listDragActive=true;document.body.classList.add('drag-selecting');g.box=document.createElement('div');g.box.className='selection-marquee';g.box.setAttribute('aria-hidden','true');document.body.append(g.box);tick();}if(g.active){e.preventDefault();paint();}});
 list.addEventListener('pointerup',e=>{if(gesture?.pointerId===e.pointerId){gesture.clientX=e.clientX;gesture.clientY=e.clientY;if(gesture.active)paint();finish(true);}});
 list.addEventListener('pointercancel',()=>finish(false));list.addEventListener('lostpointercapture',()=>finish(false));
 window.addEventListener('blur',()=>finish(false));window.addEventListener('keydown',e=>{if(e.key==='Escape'&&gesture){e.preventDefault();finish(false);}});
 list.addEventListener('click',e=>{
  if(e.target.closest('button,input,a,select,textarea,summary'))return;
  const file=e.target.closest('.file');if(file){file.querySelector('input[type=checkbox]')?.click();return;}
  if(e.pointerType==='touch'||e.detail===0){const row=e.target.closest('.work');if(row)void call('selection',[{id:row.dataset.workId,selected:!row.querySelector(':scope > input').checked}]);}
 });
 list.addEventListener('dragstart',e=>e.preventDefault());
})();

// Clear only deliberate background clicks, never the click following a drag.
(()=>{
 let backgroundPress=null;
 function isBackground(target){
  return target instanceof Element&&!target.closest('.work,button,input,select,textarea,a,label,summary,[contenteditable],#embeddedPanel,[role="tab"],#toast')&&target.matches('html,body,main,header,section,.row,.toolbar,.list,.library,.selection,.author-bookmarks,.collapse-bar,.thumbnail-controls,.filter-checklist,.default-author-buttons,#listTools');
 }
 document.addEventListener('pointerdown',e=>{backgroundPress=e.button===0&&isBackground(e.target)?{id:e.pointerId,x:e.clientX,y:e.clientY,moved:false}:null;},true);
 document.addEventListener('pointermove',e=>{const p=backgroundPress;if(p&&p.id===e.pointerId&&Math.hypot(e.clientX-p.x,e.clientY-p.y)>=6)p.moved=true;},true);
 document.addEventListener('pointerup',e=>{
  const p=backgroundPress;backgroundPress=null;
  if(!p||p.id!==e.pointerId||p.moved||state.busy||window.listDragActive||Math.hypot(e.clientX-p.x,e.clientY-p.y)>=6||!isBackground(document.elementFromPoint(e.clientX,e.clientY)))return;
  const changes=tabWorks().filter(w=>w.selected||w.files.some(f=>f.selected)).map(w=>({id:w.id,selected:false}));if(changes.length)void call('selection',changes);
 });
 document.addEventListener('pointercancel',()=>backgroundPress=null,true);
 window.addEventListener('blur',()=>backgroundPress=null);
 window.addEventListener('keydown',e=>{if(e.key==='Escape')backgroundPress=null;});
})();
