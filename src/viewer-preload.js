'use strict';
// Preload of the in-window model display view (details.aplaybox.com only).
// The view is a native layer above the app page, so the app's own buttons cannot be drawn over it.
// This script draws the three viewer buttons (open post, download, close) inside the page instead and reports clicks to the main process.
// Listeners run in the isolated world and accept only real user input (isTrusted), so the site's scripts cannot trigger them.
const {ipcRenderer}=require('electron');
(()=>{
 if(location.hostname!=='details.aplaybox.com')return;
 const ICONS={
  uploader:['업로더 페이지','M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4.5 20a7.5 7.5 0 0 1 15 0'],
  post:['게시물을 새 창으로 열기','M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5'],
  download:['이 자료 다운로드','M12 4v11M7 10l5 5 5-5M5 20h14'],
  close:['닫기 (Esc)','M6 6l12 12M18 6 6 18']
 };
 const SVG='http://www.w3.org/2000/svg';
 let box=null;
 function build(){
  box=document.createElement('div');box.setAttribute('data-apb-viewer-actions','');
  box.style.cssText='position:fixed;top:14px;right:14px;z-index:2147483647;display:flex;gap:8px;margin:0;padding:0;pointer-events:auto';
  for(const [action,[label,path]] of Object.entries(ICONS)){
   const b=document.createElement('button');b.type='button';if(action==='post'||action==='uploader')b.title=label;b.setAttribute('aria-label',label);
   const rest='all:initial;display:grid;place-items:center;width:38px;height:36px;box-sizing:border-box;border-radius:10px;border:1px solid rgba(255,255,255,.28);background:rgba(20,22,28,.62);color:#fff;cursor:pointer';
   b.style.cssText=rest;
   b.addEventListener('mouseenter',()=>{b.style.background='rgba(70,74,86,.9)';});b.addEventListener('mouseleave',()=>{b.style.background='rgba(20,22,28,.62)';});
   const svg=document.createElementNS(SVG,'svg');svg.setAttribute('viewBox','0 0 24 24');svg.setAttribute('aria-hidden','true');
   svg.style.cssText='width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:2.2;stroke-linecap:round;stroke-linejoin:round;pointer-events:none';
   const p=document.createElementNS(SVG,'path');p.setAttribute('d',path);svg.append(p);b.append(svg);
   b.addEventListener('click',e=>{if(!e.isTrusted)return;e.preventDefault();e.stopPropagation();ipcRenderer.send('viewer-action',action);},true);
   for(const type of ['mousedown','mouseup','pointerdown','pointerup','dblclick','wheel'])b.addEventListener(type,e=>e.stopPropagation(),true);
   box.append(b);
  }
 }
 function attach(){if(!box)build();if(!box.isConnected&&document.documentElement)document.documentElement.append(box);}
 function start(){attach();new MutationObserver(attach).observe(document.documentElement,{childList:true});}
 if(document.documentElement&&document.readyState!=='loading')start();else document.addEventListener('DOMContentLoaded',start,{once:true});
 window.addEventListener('keydown',e=>{if(e.isTrusted&&e.key==='Escape')ipcRenderer.send('viewer-action','close');},true);
})();
