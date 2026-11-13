'use strict';
const {WebContentsView}=require('electron');
const path=require('node:path');
function allowed(value){try{const u=new URL(value);return u.protocol==='https:'&&!u.username&&!u.password&&!u.port&&['www.aplaybox.com','aplaybox.com'].includes(u.hostname);}catch{return false;}}
class EmbeddedBrowser{
 constructor(win,session,onState,translator){this.translator=translator;this.onState=onState;this.win=win;this.visible=false;this.view=new WebContentsView({webPreferences:{session,preload:path.join(__dirname,'site-preload.js'),nodeIntegration:false,contextIsolation:true,sandbox:true}});const wc=this.view.webContents;
 const send=()=>{if(!wc.isDestroyed())onState({url:wc.getURL(),title:wc.getTitle(),loading:wc.isLoading()});};
 for(const event of ['did-navigate','did-navigate-in-page','page-title-updated','did-stop-loading'])wc.on(event,send);
 wc.on('will-navigate',(e,url)=>{if(!allowed(url))e.preventDefault();});wc.on('will-redirect',(e,url)=>{if(!allowed(url))e.preventDefault();});
 wc.setWindowOpenHandler(({url})=>{if(allowed(url))void this.open(url).catch(()=>{});return {action:'deny'};});
 this.translationTimer=setInterval(()=>void this.translatePage(),1200);this.translationTimer.unref();
 win.on('resize',()=>this.layout());win.on('closed',()=>{clearInterval(this.translationTimer);if(!wc.isDestroyed())wc.close();});
 }
 layout(){if(this.visible){const [width,height]=this.win.getContentSize();this.view.setBounds({x:0,y:150,width,height:Math.max(0,height-150)});}}
 async open(url){if(url&&!allowed(url))throw new Error('Aplaybox 주소만 열 수 있습니다.');if(!this.visible){this.win.contentView.addChildView(this.view);this.visible=true;}this.layout();if(url||!this.view.webContents.getURL())await this.view.webContents.loadURL(url||'https://www.aplaybox.com/');}
 hide(){if(this.visible){this.win.contentView.removeChildView(this.view);this.visible=false;}}
 async setTranslation(enabled){this.translationEpoch=(this.translationEpoch||0)+1;if(!enabled&&!this.view.webContents.isDestroyed())await this.view.webContents.executeJavaScript('('+require('./page-translation').restore.toString()+')()').catch(()=>{});}
 async translatePage(){
  const wc=this.view.webContents;if(!this.visible||!this.translator?.enabled||this.translating||wc.isDestroyed()||wc.isLoading()||!allowed(wc.getURL()))return;
  this.translating=true;const url=wc.getURL(),epoch=this.translationEpoch;const script=require('./page-translation');
  try{// Already-translated text (memory or data/translations.json) is applied at once; new texts are requested together (Claude sends them as one batch; Google still goes one by one).
   const rows=await wc.executeJavaScript('('+script.collect.toString()+')(120)');if(!Array.isArray(rows))return;const items=[],fresh=[];const limit=this.translator.engine==='claude'?40:12;for(const r of rows){if(typeof r.text!=='string'||!Number.isSafeInteger(r.id))continue;const known=this.translator.peek(r.text);if(known!==undefined){items.push({id:r.id,original:r.text,text:known});continue;}if(fresh.length<limit)fresh.push(r);}
   const done=await Promise.allSettled(fresh.map(r=>this.translator.translate(r.text)));if(!this.translator.enabled||epoch!==this.translationEpoch)return;let failed=null;done.forEach((d,n)=>{if(d.status==='fulfilled')items.push({id:fresh[n].id,original:fresh[n].text,text:d.value});else failed||=d.reason;});
   if(failed&&!items.length)throw failed;
   if(items.length&&!wc.isDestroyed()&&url===wc.getURL()&&epoch===this.translationEpoch&&this.translator.enabled)await wc.executeJavaScript('('+script.apply.toString()+')('+JSON.stringify(items)+')');
  }catch(e){if(!wc.isDestroyed())this.onState({url:wc.getURL(),title:wc.getTitle(),translationError:'번역 연결 실패 · 원문 표시 중'});}finally{this.translating=false;}
 }
 current(){return this.view.webContents.getURL();}
 action(action){const wc=this.view.webContents,h=wc.navigationHistory;if(action==='back'&&h.canGoBack())h.goBack();if(action==='forward'&&h.canGoForward())h.goForward();if(action==='reload')wc.reload();}
}
module.exports={EmbeddedBrowser,allowed};
