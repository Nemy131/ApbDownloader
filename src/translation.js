'use strict';
const chinese=s=>typeof s==='string'&&/[\u3400-\u9fff]/u.test(s)&&!/[\u3040-\u30ff]/u.test(s);
class Translator{
 constructor(fetcher=fetch){this.fetcher=fetcher;this.enabled=false;this.cache=new Map();this.pending=new Map();this.tail=Promise.resolve();this.controller=new AbortController();this.cooldown=0;}
 setEnabled(value){this.enabled=value;if(!value){this.controller.abort();this.controller=new AbortController();this.pending.clear();}}
 async translate(text){
  if(!this.enabled||!chinese(text)||text.length>1800)return text;
  if(this.cache.has(text))return this.cache.get(text);
  if(this.pending.has(text))return this.pending.get(text);
  const signal=this.controller.signal;
  const job=this.tail.catch(()=>{}).then(async()=>{
   if(signal.aborted||!this.enabled)return text;
   if(Date.now()<this.cooldown)throw new Error('번역 서비스 연결 대기 중입니다. 원문을 표시합니다.');
   try{
    const url=new URL('https://translate.googleapis.com/translate_a/single');for(const [k,v] of Object.entries({client:'gtx',sl:'zh-CN',tl:'ko',dt:'t',q:text}))url.searchParams.set(k,v);
    const r=await this.fetcher(url,{signal:AbortSignal.any([signal,AbortSignal.timeout(12000)]),credentials:'omit',redirect:'error'});
    if(!r.ok)throw new Error('translation '+r.status);
    const data=await r.json();if(!Array.isArray(data[0]))throw new Error('translation response');
    const result=data[0].map(x=>typeof x[0]==='string'?x[0]:'').join('');if(!result)throw new Error('empty translation');
    if(signal.aborted)return text;
    if(this.cache.size>=5000)this.cache.delete(this.cache.keys().next().value);this.cache.set(text,result);return result;
   }catch(e){if(signal.aborted)return text;this.cooldown=Date.now()+60000;throw new Error('번역 서비스에 연결하지 못했습니다. 원문을 표시하며 잠시 후 재시도합니다.');}
   finally{if(!signal.aborted)await new Promise(r=>setTimeout(r,250));}
  });
  this.tail=job;this.pending.set(text,job);try{return await job;}finally{if(this.pending.get(text)===job)this.pending.delete(text);}
 }
}
module.exports={Translator,chinese};
