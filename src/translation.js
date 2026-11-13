'use strict';
const claudeCli=require('./claude-cli');
const codexCli=require('./codex-cli');
const {Glossary}=require('./glossary');
const chinese=s=>typeof s==='string'&&/[㐀-鿿]/u.test(s)&&!/[぀-ヿ]/u.test(s);
const CACHE_LIMIT=20000;
const ENGINES=['google','claude','codex'];
// One CLI call costs ~3s before the first title and ~0.3s per title, so titles go out in small batches and several batches
// run at the same time (this.parallel, 1..4) instead of one batch of 40 after another.
const BATCH=16,BATCH_DELAY=300,CLAUDE_COOLDOWN=5*60000,PARALLEL_DEFAULT=3,PARALLEL_MAX=4;
class Translator{
 constructor(fetcher=fetch,{claude=claudeCli,codex=codexCli,glossary=new Glossary()}={}){
  this.fetcher=fetcher;this.claude=claude;this.codex=codex;this.glossary=glossary;
  this.enabled=false;this.buckets=new Map();this.builtin=new Map();this.fresh=false;this.pending=new Map();this.tail=Promise.resolve();this.controller=new AbortController();this.cooldown=0;this.onChange=null;
  this.engine='google';this.model='haiku';this.claudePath='';this.foundClaude=null;this.claudeCooldown=0;this.lastError='';this.lastOk=0;
  // Codex (ChatGPT account): codexModel is a model name from Codex's own list ('' = the default fast model).
  this.codexModel='';this.codexPath='';this.foundCodex=null;this.codexModels=null;
  this.queue=[];this.flushTimer=null;this.active=0;this.parallel=PARALLEL_DEFAULT;
 }
 // Saved translations (data/translations.json) are kept per engine/model ('google', 'claude:haiku', ...) and survive restarts.
 // The pre-1.3 flat format { text: result } is loaded as the 'legacy' bucket.
 key(){return this.engine==='claude'?'claude:'+this.model:this.engine==='codex'?'codex:'+this.codexSlug():'google';}
 // CLI-backed engines ('claude', 'codex') share the batching queue, the Google fallback and the cooldown (claudeCooldown).
 llm(engine=this.engine){return engine==='codex'?{name:'codex',cli:this.codex,exe:()=>this.codexExe(),model:()=>this.codexSlug(),key:()=>'codex:'+this.codexSlug()}:{name:'claude',cli:this.claude,exe:()=>this.claudeExe(),model:()=>this.model,key:()=>'claude:'+this.model};}
 codexList(){if(!this.codexModels)this.codexModels=this.codex.availableModels();return this.codexModels;}
 codexSlug(){return this.codex.chooseModel(this.codexModel,this.codexList());}
 codexExe(){if(this.codexPath)return this.codexPath;if(this.foundCodex===null)this.foundCodex=this.codex.find();return this.foundCodex;}
 bucket(key){let b=this.buckets.get(key);if(!b){b=new Map();this.buckets.set(key,b);}return b;}
 load(data){
  const fill=(key,entries)=>{const b=this.bucket(key);for(const [k,v] of Object.entries(entries||{}))if(chinese(k)&&typeof v==='string'&&v)b.set(k,v);while(b.size>CACHE_LIMIT)b.delete(b.keys().next().value);if(!b.size)this.buckets.delete(key);};
  if(data&&data.version===2&&data.buckets&&typeof data.buckets==='object'){for(const [key,entries] of Object.entries(data.buckets))if(/^(google|legacy|claude:[a-z0-9-]+|codex:[a-z0-9.-]+)$/.test(key))fill(key,entries);}
  else fill('legacy',data);
 }
 // Translations shipped with the app (src/builtin/translations.json). Lowest priority, never written to translations.json,
 // not removed by clear(), and skipped like any other engine's result when the user chose to translate afresh.
 loadBuiltin(entries){this.builtin=new Map();for(const [k,v] of Object.entries(entries||{}))if(chinese(k)&&typeof v==='string'&&v)this.builtin.set(k,v);}
 entries(){return {version:2,buckets:Object.fromEntries([...this.buckets].map(([k,b])=>[k,Object.fromEntries(b)]))};}
 // Current engine first; unless "fresh" was chosen, any other engine's saved result is reused instead of translating again.
 lookup(text){const own=this.buckets.get(this.key())?.get(text);if(own!==undefined||this.fresh)return own;for(const b of this.buckets.values())if(b.has(text))return b.get(text);return this.builtin.get(text);}
 view(){const out={};if(!this.fresh){for(const [k,v] of this.builtin)out[k]=v;for(const b of this.buckets.values())for(const [k,v] of b)out[k]=v;}Object.assign(out,Object.fromEntries(this.buckets.get(this.key())||[]));return out;}
 // Saved result only (any engine, current first). Never requests a translation; works even when auto-translate is off.
 cached(text){const own=this.buckets.get(this.key())?.get(text);if(own!==undefined)return own;for(const b of this.buckets.values())if(b.has(text))return b.get(text);return this.builtin.get(text);}
 size(){let n=0;for(const b of this.buckets.values())n+=b.size;return n;}
 clear(){this.buckets.clear();this.onChange?.();}
 peek(text){return this.enabled?this.lookup(text):undefined;}
 setEnabled(value){this.enabled=value;if(!value){this.controller.abort();this.controller=new AbortController();this.pending.clear();this.dropQueue();}}
 configure({engine,model,claudePath,fresh,codexModel,codexPath,parallel}={}){
  if(parallel!==undefined){const n=Number(parallel);if(!Number.isInteger(n)||n<1||n>PARALLEL_MAX)throw new Error('동시 처리 수는 1~'+PARALLEL_MAX+' 사이의 정수로 입력해 주세요.');this.parallel=n;}
  if(fresh!==undefined)this.fresh=fresh===true;
  if(engine!==undefined){if(!ENGINES.includes(engine))throw new Error('지원하지 않는 번역 엔진입니다.');this.engine=engine;}
  if(model!==undefined){if(!this.claude.MODELS.includes(model))throw new Error('지원하지 않는 모델입니다.');this.model=model;}
  if(claudePath!==undefined){this.claudePath=String(claudePath||'');this.foundClaude=null;}
  if(codexModel!==undefined){const v=String(codexModel||'');if(v&&!this.codex.MODELS.includes(v)&&!this.codexList().some(m=>m.slug===v))throw new Error('지원하지 않는 모델입니다.');this.codexModel=v?this.codex.chooseModel(v,this.codexList()):'';}
  if(codexPath!==undefined){this.codexPath=String(codexPath||'');this.foundCodex=null;}
  this.claudeCooldown=0;this.lastError='';
 }
 claudeExe(){if(this.claudePath)return this.claudePath;if(this.foundClaude===null)this.foundClaude=this.claude.find();return this.foundClaude;}
 status(){return {engine:this.engine,model:this.model,models:this.claude.MODELS,claudePath:this.claudePath,detected:this.claudePath?'':this.claudeExe(),key:this.key(),parallel:this.parallel,parallelMax:PARALLEL_MAX,codexModel:this.codexSlug(),codexModels:this.codexList(),codexPath:this.codexPath,codexDetected:this.codexPath?'':this.codexExe(),error:this.lastError,cooldownUntil:this.claudeCooldown>Date.now()?this.claudeCooldown:0,cached:this.size(),builtin:this.builtin.size,fresh:this.fresh,saved:Object.fromEntries([...this.buckets].map(([k,b])=>[k,b.size]))};}
 store(text,result,key=this.key()){const b=this.bucket(key);if(!b.has(text)&&b.size>=CACHE_LIMIT)b.delete(b.keys().next().value);b.set(text,result);this.onChange?.();return result;}
 async translate(text){
  if(!this.enabled||!chinese(text)||text.length>1800)return text;
  const hit=this.lookup(text);if(hit!==undefined)return hit;
  if(this.pending.has(text))return this.pending.get(text);
  const job=this.engine!=='google'&&Date.now()>=this.claudeCooldown?this.viaClaude(text):this.viaGoogle(text);
  this.pending.set(text,job);try{return await job;}finally{if(this.pending.get(text)===job)this.pending.delete(text);}
 }
 viaGoogle(text){
  const signal=this.controller.signal;
  const job=this.tail.catch(()=>{}).then(async()=>{
   if(signal.aborted||!this.enabled)return text;
   const hit=this.buckets.get('google')?.get(text)??this.lookup(text);if(hit!==undefined)return hit;
   if(Date.now()<this.cooldown)throw new Error('번역 서비스 연결 대기 중입니다. 원문을 표시합니다.');
   try{
    const url=new URL('https://translate.googleapis.com/translate_a/single');for(const [k,v] of Object.entries({client:'gtx',sl:'zh-CN',tl:'ko',dt:'t',q:text}))url.searchParams.set(k,v);
    const r=await this.fetcher(url,{signal:AbortSignal.any([signal,AbortSignal.timeout(12000)]),credentials:'omit',redirect:'error'});
    if(!r.ok)throw new Error('translation '+r.status);
    const data=await r.json();if(!Array.isArray(data[0]))throw new Error('translation response');
    const result=data[0].map(x=>typeof x[0]==='string'?x[0]:'').join('');if(!result)throw new Error('empty translation');
    if(signal.aborted)return text;
    return this.store(text,result,'google');
   }catch(e){if(signal.aborted)return text;this.cooldown=Date.now()+60000;throw new Error('번역 서비스에 연결하지 못했습니다. 원문을 표시하며 잠시 후 재시도합니다.');}
   finally{if(!signal.aborted)await new Promise(r=>setTimeout(r,250));}
  });
  this.tail=job;return job;
 }
 // Claude / Codex: texts arriving within BATCH_DELAY are sent as JSON arrays of up to BATCH titles (one CLI process per batch,
 // up to this.parallel batches at a time).
 viaClaude(text){
  return new Promise((resolve,reject)=>{this.queue.push({text,resolve,reject});this.schedule();});
 }
 schedule(){
  if(this.active>=this.parallel||!this.queue.length)return;
  // A full batch goes out at once; a partial one waits BATCH_DELAY for more titles. When the timer fires everything queued goes out.
  if(this.queue.length>=BATCH){while(this.active<this.parallel&&this.queue.length>=BATCH)void this.flush();if(!this.queue.length){clearTimeout(this.flushTimer);this.flushTimer=null;}}
  if(this.queue.length&&this.active<this.parallel&&!this.flushTimer)this.flushTimer=setTimeout(()=>{this.flushTimer=null;while(this.active<this.parallel&&this.queue.length)void this.flush();},BATCH_DELAY);
 }
 dropQueue(){clearTimeout(this.flushTimer);this.flushTimer=null;const q=this.queue;this.queue=[];for(const i of q)i.resolve(i.text);}
 async flush(){
  if(this.active>=this.parallel||!this.queue.length)return;
  this.active++;const items=this.queue.splice(0,BATCH);const signal=this.controller.signal;const llm=this.llm();const key=llm.key();
  try{
   // Another batch just failed (not signed in, usage limit): do not start more CLI calls, hand these to Google.
   if(Date.now()<this.claudeCooldown){for(const i of items){const hit=this.lookup(i.text);if(hit!==undefined)i.resolve(hit);else this.viaGoogle(i.text).then(i.resolve,i.reject);}return;}
   const send=[];
   for(const i of items){const hit=this.lookup(i.text);if(hit!==undefined){i.resolve(hit);continue;}const g=this.glossary.apply(i.text);if(!chinese(g)){i.resolve(this.store(i.text,g,key));continue;}send.push({...i,prepared:g});}
   if(!send.length)return;
   let results;
   try{results=await llm.cli.translateBatch(llm.exe(),send.map(i=>i.prepared),{model:llm.model(),signal});this.lastError='';this.lastOk=Date.now();}
   catch(e){
    if(signal.aborted){for(const i of send)i.resolve(i.text);return;}
    this.lastError=llm.cli.friendly(e.message);this.claudeCooldown=Date.now()+CLAUDE_COOLDOWN;
    for(const i of send)this.viaGoogle(i.text).then(i.resolve,i.reject);return;
   }
   if(signal.aborted){for(const i of send)i.resolve(i.text);return;}
   // A reply without any Hangul means the model echoed the source; let Google handle that title.
   send.forEach((i,n)=>{const r=results[n];if(r&&/[가-힣]/u.test(r))i.resolve(this.store(i.text,r,key));else this.viaGoogle(i.text).then(i.resolve,i.reject);});
  }finally{this.active--;this.schedule();}
 }
}
// 압축 파일 이름을 저장된 번역으로 바꾼다(새 번역 요청 없음). 바꿀 수 없으면 null.
// 순서: 파일 이름 전체 번역 → 이름 속 게시물 제목을 제목 번역으로 교체 → 남은 용어는 내장 용어집으로 교체.
const ARCHIVE=/\.(zip|7z|rar)$/i;
function translatedFileName(name,{title='',cached=()=>undefined,glossary=null}={}){
 name=String(name||'');const m=name.match(ARCHIVE);if(!m||!chinese(name))return null;
 const ext=m[0],stem=name.slice(0,-ext.length);
 const clean=s=>typeof s==='string'&&s.trim()?s.trim():'';
 let out=clean(cached(stem))||clean(cached(name)).replace(ARCHIVE,'');
 if(!out){
  out=stem;const tt=title&&chinese(title)?clean(cached(title)):'';
  if(tt&&stem.includes(title))out=out.split(title).join(tt);
  if(glossary&&chinese(out))out=glossary.apply(out);
 }
 return out&&out!==stem?out+ext:null;
}
module.exports={Translator,chinese,ENGINES,translatedFileName};
