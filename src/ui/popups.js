'use strict';
// App-styled confirm dialog and tooltips (replace window.confirm and native title tooltips).

// appConfirm(message, {title, ok, cancel, danger, note}) -> Promise<true|false|null> (null: Esc or outside click)
function appConfirm(message,{title='확인',ok='확인',cancel='취소',danger=false,note=''}={}){
 return new Promise(resolve=>{
  const d=document.createElement('dialog');d.className='max-dialog app-confirm';
  const h=document.createElement('h2');h.textContent=title;
  const p=document.createElement('p');p.textContent=message;
  const actions=document.createElement('div');actions.className='app-confirm-actions';
  const no=document.createElement('button');no.type='button';no.className='quiet';no.textContent=cancel;
  const yes=document.createElement('button');yes.type='button';yes.className=danger?'danger-solid':'primary';yes.textContent=ok;
  actions.append(no,yes);d.append(h,p);if(note){const n=document.createElement('p');n.className='confirm-note';n.textContent=note;d.append(n);}d.append(actions);document.body.append(d);
  let done=false;const finish=v=>{if(done)return;done=true;d.close();d.remove();resolve(v);};
  no.onclick=()=>finish(false);yes.onclick=()=>finish(true);
  d.addEventListener('cancel',e=>{e.preventDefault();finish(null);});
  d.addEventListener('click',e=>{if(e.target===d)finish(null);});
  d.showModal();(danger?no:yes).focus();
 });
}

// Tooltips: any element with title="" shows a themed tooltip instead of the OS one.
(()=>{
 let tip=null,target=null,timer=null;
 const ensure=()=>{if(!tip){tip=document.createElement('div');tip.className='app-tooltip';tip.setAttribute('role','tooltip');tip.hidden=true;document.body.append(tip);}return tip;};
 const hide=()=>{clearTimeout(timer);timer=null;target=null;if(tip)tip.hidden=true;};
 const place=el=>{
  const t=ensure();t.textContent=el.dataset.tip;t.hidden=false;
  // A modal dialog renders in the top layer; keep the tooltip above it.
  const host=el.closest('dialog[open]')||document.body;if(t.parentNode!==host)host.append(t);
  const r=el.getBoundingClientRect(),w=t.offsetWidth,h=t.offsetHeight,m=8;
  let x=r.left+r.width/2-w/2,y=r.bottom+m;
  if(y+h>innerHeight-4)y=r.top-h-m;
  // data-tip-side="left": e.g. viewer buttons, where the area below is covered by the native model view.
  if(el.closest('[data-tip-side="left"]')){x=r.left-w-m;y=r.top+r.height/2-h/2;}
  x=Math.max(6,Math.min(innerWidth-w-6,x));
  t.style.left=x+'px';t.style.top=Math.max(4,y)+'px';
 };
 const adopt=el=>{const t=el.getAttribute('title');if(t){el.dataset.tip=t;el.removeAttribute('title');if(!el.hasAttribute('aria-label')&&!el.textContent.trim())el.setAttribute('aria-label',t);}return el.dataset.tip;};
 document.addEventListener('mouseover',e=>{
  const el=e.target instanceof Element?e.target.closest('[title],[data-tip]'):null;
  if(el===target)return;hide();if(!el||!adopt(el))return;
  target=el;timer=setTimeout(()=>{if(target===el&&el.isConnected)place(el);},350);
 });
 document.addEventListener('mouseout',e=>{if(target&&!target.contains(e.relatedTarget))hide();});
 for(const ev of ['mousedown','scroll','keydown','blur'])window.addEventListener(ev,hide,true);
 document.addEventListener('focusin',e=>{const el=e.target instanceof Element?e.target.closest('[title],[data-tip]'):null;if(el&&el.matches(':focus-visible')&&adopt(el)){hide();target=el;place(el);}});
 document.addEventListener('focusout',hide);
})();
