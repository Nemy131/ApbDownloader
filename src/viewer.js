'use strict';
// 메인 창 안의 모델 디스플레이 뷰어: 게시물 페이지 대신 모델 디스플레이 iframe 주소(details.aplaybox.com/modelDetails)만 직접 불러온다.
const {WebContentsView}=require('electron');
const path=require('node:path');
const HOST='details.aplaybox.com';
const CLICK=`(async()=>{for(let n=0;n<60;n++){const i=document.querySelector('.icon-ziyuan');if(i&&i.offsetParent!==null){i.click();return true;}await new Promise(r=>setTimeout(r,250));}return false;})()`;
const PROGRESS=`(()=>{const s=[...document.querySelectorAll('section.p_three_canvas')];const done=s.length>0&&s.every(e=>getComputedStyle(e).display==='none');const m=(document.body.innerText||'').match(/(\\d{1,3})%/);return {done,percent:m?m[1]+'%':''};})()`;
function allowed(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&u.hostname===HOST;}catch{return false;}}
function viewerUrl(w){
 const id=String(w?.id||'');if(!/^[A-Za-z0-9_-]{4,64}$/.test(id))throw new Error('작품 ID를 확인할 수 없습니다.');
 const type=Number(w.type)===2?2:1;
 return `https://${HOST}/modelDetails?work_uuid=${encodeURIComponent(id)}&work_type=${type}&user_uuid=&isLogin=0&Api_url=1`;
}
class ModelViewer{
 constructor(win,session,onState){this.win=win;this.session=session;this.onState=onState;this.view=null;this.visible=false;this.token=0;
  win.on('closed',()=>this.destroy());}
 ensure(){
  if(this.view&&!this.view.webContents.isDestroyed())return this.view;
  // viewer-preload.js draws the open-post / download / close buttons over the model and reports clicks ('viewer-action').
  this.view=new WebContentsView({webPreferences:{session:this.session,preload:path.join(__dirname,'viewer-preload.js'),contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}});
  const wc=this.view.webContents;this.view.setBackgroundColor('#00000000');
  // 렌더러의 .viewer-stage(border-radius:14px)와 같은 둥근 모서리.
  if(typeof this.view.setBorderRadius==='function')this.view.setBorderRadius(14);
  wc.on('will-navigate',(e,url)=>{if(!allowed(url))e.preventDefault();});wc.on('will-redirect',(e,url)=>{if(!allowed(url))e.preventDefault();});
  wc.setWindowOpenHandler(()=>({action:'deny'}));
  wc.on('render-process-gone',()=>this.fail('모델 디스플레이 화면이 종료되었습니다.'));
  return this.view;
 }
 send(s){if(!this.win.isDestroyed())this.onState({id:this.id,...s});}
 // On an error the native view is taken off the window so the app page below it can show the message and its own buttons.
 fail(error){if(this.visible&&this.view){try{this.win.contentView.removeChildView(this.view);}catch{}this.visible=false;}this.send({status:'error',error});}
 owns(webContents){return !!this.view&&this.view.webContents===webContents;}
 bounds(rect){
  if(!this.visible||!rect)return;const [cw,ch]=this.win.getContentSize();
  const n=v=>Math.max(0,Math.round(Number(v)||0));const x=Math.min(n(rect.x),cw),y=Math.min(n(rect.y),ch);
  this.view.setBounds({x,y,width:Math.min(n(rect.width),cw-x),height:Math.min(n(rect.height),ch-y)});
 }
 async open(w,rect){
  const url=viewerUrl(w);const view=this.ensure();const token=++this.token;this.id=w.id;
  if(!this.visible){this.win.contentView.addChildView(view);this.visible=true;}
  this.bounds(rect);this.send({status:'loading'});
  try{
   await view.webContents.loadURL(url);if(token!==this.token||!this.visible)return {ok:true};
   const ok=await view.webContents.executeJavaScript(CLICK).catch(()=>false);
   if(token!==this.token)return {ok:true};
   if(!ok){this.fail('모델 디스플레이를 시작하지 못했습니다. 게시물 열기로 확인해 주세요.');return {ok:true};}
   // 재생 클릭 후 모델 파일을 받는 동안 진행률(%)을 전달하고, 로딩 화면이 사라지면 완료로 본다.
   const deadline=Date.now()+180000;let last='';
   while(token===this.token&&Date.now()<deadline&&!view.webContents.isDestroyed()){
    const p=await view.webContents.executeJavaScript(PROGRESS).catch(()=>null);if(token!==this.token)break;
    if(p?.done){this.send({status:'ready'});break;}
    const pct=p?.percent||'';if(pct!==last){last=pct;this.send({status:'loading',percent:pct});}
    await new Promise(r=>setTimeout(r,400));
   }
  }catch(e){if(token===this.token)this.fail('모델 디스플레이를 불러오지 못했습니다.');}
  return {ok:true};
 }
 close(){this.token++;if(this.visible){this.win.contentView.removeChildView(this.view);this.visible=false;}
  // 3D 렌더링을 멈추도록 페이지를 비운다.
  if(this.view&&!this.view.webContents.isDestroyed())void this.view.webContents.loadURL('about:blank').catch(()=>{});}
 destroy(){this.token++;if(this.view&&!this.view.webContents.isDestroyed())this.view.webContents.close();this.view=null;this.visible=false;}
}
module.exports={ModelViewer,viewerUrl,allowed};
