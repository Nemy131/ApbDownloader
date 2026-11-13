const {contextBridge}=require('electron');
const st=['다운로드 중','다운로드 중','조건 처리 중','다운로드 대기','다운로드 대기','완료','완료','완료','사용자 조작 필요','실패'];
const works=Array.from({length:18},(_,i)=>{const s=st[i];const w={id:'w'+i,title:'【鸣潮】모델 '+i,author:'作者九',authorId:'9',type:1,date:'2026-11-13',rules:[],status:s||'대기',selected:i<10,detailLoaded:i<10,permission:true,attempted:i<10,files:[]};
 if(i<10&&s!=='조건 처리 중'&&s!=='다운로드 대기')w.files=[{id:'f'+i,name:'model'+i+'.zip',selected:true,size:50e6,status:s==='다운로드 중'?'다운로드 중':s==='완료'?'완료':s==='실패'?'실패':'대기',loaded:s==='다운로드 중'?20e6:0,total:50e6,speed:s==='다운로드 중'?3.2e6:0}];return w;});
const mode=process.env.PREV_MODE||'download';
const state={works,bookmarks:[],authorBookmarks:[{id:'5',name:'가람',url:'https://www.aplaybox.com/u/5/model'},{id:'6',name:'流萤专门',url:'https://www.aplaybox.com/u/6/model'}],author:'9',complete:mode!=='list',busy:mode!=='idle',job:mode==='idle'?null:mode,message:mode==='list'?'모델 2/4페이지 · 40/77개 조회':'다운로드 처리 5/8개',account:'1',folder:'D:/Models',settings:{follow:true,like:true,collect:true,confirmed:true},concurrency:2,notifyOnComplete:true};
state.defaultAuthors=[{id:'1',name:'원신',url:'https://www.aplaybox.com/u/1'},{id:'2',name:'스타레일',url:'https://www.aplaybox.com/u/2'},{id:'3',name:'명조',url:'https://www.aplaybox.com/u/3'}];
if(mode==='empty'){works.length=0;state.busy=false;state.job=null;state.message='';}
if(mode==='idle')for(const w of works)if(w.status.includes('중')||w.status==='다운로드 대기')w.status='완료';
contextBridge.exposeInMainWorld('aplay',{call:async m=>({ok:true,value:m==='snapshot'?state:undefined}),onState:cb=>setTimeout(()=>cb(state),50),onFinished:()=>{},onAuthor:()=>{},onBrowser:()=>{},onViewer:()=>{},onBrowserDownload:()=>{},onUpdate:cb=>require('electron').ipcRenderer.on('update-state',(_e,s)=>cb(s))});
