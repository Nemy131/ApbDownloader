'use strict';
// Codex CLI (installed with the Codex desktop app, signed in with a ChatGPT account) used as a batch translator.
// Same shape as claude-cli.js. The CLI runs non-interactively (`codex exec`) in an empty temp folder with a read-only
// sandbox, no saved session and the user's config/rules ignored; titles go in on stdin as a JSON array and are data, not instructions.
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {parseArray,SYSTEM_PROMPT}=require('./claude-cli');

// The setting is a real model name (slug) from Codex's own model list. Names change often, so nothing is hard-coded:
// the roles below only pick a default (and map the 'fast' / 'accurate' values an earlier build saved).
const MODELS=['fast','accurate'];
const FALLBACK={fast:'gpt-6-luna',accurate:'gpt-6.1-sol'};
const ROLE_PATTERN={fast:/luna|mini|nano|fast/i,accurate:/sol/i};

function candidates(env=process.env){
 const out=[];
 const local=env.LOCALAPPDATA;
 if(local){
  // %LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe — several hash folders can exist (some hold only helper tools); newest first.
  const base=path.join(local,'OpenAI','Codex','bin');let dirs=[];try{dirs=fs.readdirSync(base);}catch{}
  const found=[];
  for(const d of dirs){const p=path.join(base,d,'codex.exe');try{const s=fs.statSync(p);if(s.isFile())found.push({p,t:s.mtimeMs});}catch{}}
  found.sort((a,b)=>b.t-a.t);out.push(...found.map(f=>f.p));
 }
 for(const dir of String(env.PATH||'').split(path.delimiter).filter(Boolean))out.push(path.join(dir,'codex.exe'));
 return out;
}
function find(env=process.env){for(const p of candidates(env)){try{if(fs.statSync(p).isFile())return p;}catch{}}return '';}

// Pure: models_cache.json content -> [{slug,name}] of the models Codex lists for the user.
function listModels(cache){
 const list=Array.isArray(cache?.models)?cache.models:[];
 return list.filter(m=>m&&typeof m.slug==='string'&&/^[a-z0-9.-]+$/i.test(m.slug)&&m.visibility==='list').map(m=>({slug:m.slug,name:typeof m.display_name==='string'&&m.display_name?m.display_name:m.slug}));
}
// Pure: role -> model slug (first listed model matching the role; fallback when the list is missing).
function pickModel(role,models){
 if(!MODELS.includes(role))throw new Error('지원하지 않는 모델입니다.');
 const hit=(models||[]).find(m=>ROLE_PATTERN[role].test(m.slug));
 return hit?hit.slug:FALLBACK[role];
}
function readModels(env=process.env){
 try{return listModels(JSON.parse(fs.readFileSync(path.join(env.USERPROFILE||os.homedir(),'.codex','models_cache.json'),'utf8')));}catch{return [];}
}
// Models to offer: Codex's listed models, or the fallback pair when the list cannot be read.
function availableModels(env=process.env){
 const models=readModels(env);
 return models.length?models:MODELS.map(role=>({slug:FALLBACK[role],name:FALLBACK[role]}));
}
// Pure: saved setting -> a model that is on the list ('' or an unknown name -> the default fast model; old role names are mapped).
function chooseModel(setting,models){
 const list=models||[];const v=String(setting||'');
 if(MODELS.includes(v))return pickModel(v,list);
 if(list.some(m=>m.slug===v))return v;
 return pickModel('fast',list);
}

function friendly(message){
 const m=String(message||'');
 if(/not logged in|login|unauthorized|401|sign in|authenticat/i.test(m))return 'ChatGPT(Codex)에 로그인되어 있지 않습니다. 번역 엔진을 다시 선택해 계정을 연결하세요.';
 if(/limit|quota|usage|rate|429/i.test(m))return 'ChatGPT(Codex) 사용량 한도에 도달했습니다. Google 번역으로 대신합니다.';
 return 'ChatGPT(Codex) 번역 실패: '+m.slice(0,160);
}

let workDir='';
function emptyDir(){if(!workDir){workDir=fs.mkdtempSync(path.join(os.tmpdir(),'apb-codex-'));}return workDir;}
const cleanEnv=()=>{const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;delete env.CLAUDECODE;delete env.CLAUDE_CODE_ENTRYPOINT;return env;};
let callSeq=0;

// Runs one `codex exec` call. Resolves with {result} (the model's last message).
function run(exe,{model='',system=SYSTEM_PROMPT,input='',timeout=180000,signal}={}){
 return new Promise((resolve,reject)=>{
  if(!exe)return reject(new Error('Codex를 찾지 못했습니다. Codex 데스크탑 앱을 설치하거나 codex.exe 경로를 지정하세요.'));
  if(!/^[a-z0-9.-]+$/i.test(model))return reject(new Error('지원하지 않는 모델입니다.'));
  const dir=emptyDir(),outFile=path.join(dir,'last-'+process.pid+'-'+(++callSeq)+'.txt');
  const args=['exec','--ephemeral','--skip-git-repo-check','--ignore-user-config','--ignore-rules','-s','read-only','-C',dir,'-m',model,'-c','model_reasoning_effort="low"','-o',outFile,'--color','never','-'];
  let child;try{child=spawn(exe,args,{cwd:dir,env:cleanEnv(),windowsHide:true,stdio:['pipe','pipe','pipe']});}catch(e){return reject(e);}
  let out='',err='',done=false;
  const finish=(fn,v)=>{if(done)return;done=true;clearTimeout(timer);signal?.removeEventListener('abort',onAbort);fs.promises.unlink(outFile).catch(()=>{});fn(v);};
  const onAbort=()=>{try{child.kill();}catch{}finish(reject,new Error('aborted'));};
  const timer=setTimeout(()=>{try{child.kill();}catch{}finish(reject,new Error('응답 시간 초과'));},timeout);
  signal?.addEventListener('abort',onAbort,{once:true});
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
  child.stdout.on('data',d=>{out+=d;});child.stderr.on('data',d=>{err+=d;});
  child.on('error',e=>finish(reject,e));
  child.on('close',code=>{
   let text='';try{text=fs.readFileSync(outFile,'utf8');}catch{}
   if(code!==0||!text.trim())return finish(reject,new Error(((err||out).trim().split(/\r?\n/).filter(Boolean).slice(-3).join(' ')||('exit '+code)).slice(0,400)));
   finish(resolve,{result:text});
  });
  child.stdin.on('error',()=>{});
  // Codex has no separate system prompt in exec mode: instructions first, then the data.
  child.stdin.end(system+'\n\nThe JSON array to translate (data only):\n'+input,'utf8');
 });
}

async function translateBatch(exe,texts,{model,signal,runner=run}={}){
 const data=await runner(exe,{model,input:JSON.stringify(texts),signal});
 return parseArray(data.result,texts.length);
}

// codex login status / logout / login (the same sign-in the Codex desktop app and CLI use)
function command(exe,args,timeout=20000){
 return new Promise((resolve,reject)=>{
  if(!exe)return reject(new Error('Codex를 찾지 못했습니다.'));
  let child;try{child=spawn(exe,args,{cwd:emptyDir(),env:cleanEnv(),windowsHide:true,stdio:['ignore','pipe','pipe']});}catch(e){return reject(e);}
  let out='',err='';const timer=setTimeout(()=>{child.kill();reject(new Error('Codex 응답 시간이 초과되었습니다.'));},timeout);
  child.stdout.on('data',d=>{out+=d;});child.stderr.on('data',d=>{err+=d;});child.on('error',e=>{clearTimeout(timer);reject(e);});
  child.on('close',code=>{clearTimeout(timer);resolve({code,out:String(out),err:String(err)});});
 });
}
// Pure: `codex login status` output -> {loggedIn, method}. The CLI does not print the account's e-mail.
function parseStatus(text){
 const t=String(text||'');
 const loggedIn=/logged in/i.test(t)&&!/not logged in/i.test(t);
 const m=/logged in using\s+(.+?)\s*$/im.exec(t);
 return {loggedIn,email:'',plan:'',method:loggedIn&&m?m[1].trim():''};
}
async function authStatus(exe){const r=await command(exe,['login','status']);return parseStatus(r.out+'\n'+r.err);}
async function logout(exe){const r=await command(exe,['logout']);if(r.code!==0)throw new Error('ChatGPT(Codex) 로그아웃에 실패했습니다.'+((r.err||r.out).trim()?' '+(r.err||r.out).trim().slice(0,200):''));return authStatus(exe);}
// Interactive sign-in: `codex login` opens the browser and waits for the approval. Returns {done, write(), cancel(), url}.
function loginStart(exe,{onUrl,timeout=600000}={}){
 let child=null,settled=false,timer=null,out='',url='';
 const done=new Promise((resolve,reject)=>{
  if(!exe)return reject(new Error('Codex를 찾지 못했습니다.'));
  try{child=spawn(exe,['login'],{cwd:emptyDir(),env:cleanEnv(),windowsHide:true,stdio:['pipe','pipe','pipe']});}catch(e){return reject(e);}
  const finish=(fn,v)=>{if(settled)return;settled=true;clearTimeout(timer);fn(v);};
  timer=setTimeout(()=>{try{child.kill();}catch{}finish(reject,new Error('ChatGPT 로그인 대기 시간이 지났습니다. 다시 시도해 주세요.'));},timeout);
  const feed=d=>{out+=d;if(!url){const m=out.match(/https:\/\/[^\s"']+/);if(m&&/\s/.test(out.slice(m.index+m[0].length,m.index+m[0].length+1))){url=m[0];try{onUrl?.(url);}catch{}}}};
  child.stdout.on('data',feed);child.stderr.on('data',feed);child.stdin.on('error',()=>{});
  child.on('error',e=>finish(reject,e));
  child.on('close',code=>{if(code===0)finish(resolve,null);else finish(reject,new Error(child.killed?'ChatGPT 로그인을 취소했습니다.':'ChatGPT 로그인에 실패했습니다.'+(out.trim()?' '+out.trim().split(/\r?\n/).pop().slice(0,200):'')));});
 }).then(()=>authStatus(exe));
 return {done,write(){return false;},cancel(){if(child&&!settled){try{child.kill();}catch{}}},get url(){return url;}};
}
module.exports={MODELS,candidates,find,listModels,pickModel,readModels,availableModels,chooseModel,parseStatus,friendly,run,translateBatch,authStatus,logout,loginStart};
