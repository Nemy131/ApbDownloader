'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {check,safeName}=require('./core');
const modelFile=/\.(zip|7z|rar|pmx|pmd|fbx|obj|blend|vmd|vpd|vrm|glb|gltf)$/i;
const key=s=>s.normalize('NFC').toLocaleLowerCase();
// Presence selection only: no network requests, mutations, deletes, or archive extraction.
async function selectMissing(root,works,history={},signal,progress=()=>{}) {
  const absolute=await fs.realpath(root),byName=new Map(),byPath=new Map(),byWork=new Map();
  const ids=new Map(works.map(w=>[key('_'+safeName(w.id,24)),w.id]));
  const stack=[{dir:absolute,work:null}];let scanned=0;
  while(stack.length){
    check(signal);const {dir,work}=stack.pop();
    for(const entry of await fs.readdir(dir,{withFileTypes:true})){
      check(signal);if(entry.isSymbolicLink())continue;
      const full=path.join(dir,entry.name);
      if(entry.isDirectory()){
        const found=[...ids].find(([suffix])=>key(entry.name).endsWith(suffix));
        stack.push({dir:full,work:found?.[1]||work});continue;
      }
      if(!entry.isFile()||!modelFile.test(entry.name))continue;
      const stat=await fs.stat(full);if(!stat.size)continue;
      const item={path:full,size:stat.size,work};byPath.set(key(full),item);
      const names=byName.get(key(entry.name))||[];names.push(item);byName.set(key(entry.name),names);
      if(work){const list=byWork.get(work)||[];list.push(item);byWork.set(work,list);}
      scanned++;if(scanned%100===0)progress(scanned);
    }
  }
  const result=[];
  for(const w of works){
    check(signal);const prefix=`${w.type}:${w.id}:`;
    const records=Object.entries(history).filter(([id])=>id.startsWith(prefix));
    const recorded=id=>{const r=history[prefix+id];if(!r?.path)return null;const f=byPath.get(key(path.resolve(r.path)));return f&&f.size===r.size?f:null;};
    const files=w.files.map(f=>{
      let found=recorded(f.id);
      if(!found){const candidates=byName.get(key(f.name))||[];found=candidates.find(c=>(c.work===w.id||/_by_.+_[a-f\d]{16,}\.[^.]+$/i.test(f.name))&&(!f.size||c.size===Number(f.size)));}
      return {id:f.id,selected:!found,existing:found?.path||null};
    });
    let existing=null;
    if(!files.length){
      existing=byWork.get(w.id)?.[0]?.path||records.map(([id])=>recorded(id.slice(prefix.length))?.path).find(Boolean)||null;
    }
    result.push({id:w.id,selected:files.length?files.some(f=>f.selected):!existing,existing:existing||(files.length&&files.every(f=>f.existing)?files[0].existing:null),files});
  }
  return {works:result,scanned};
}
module.exports={selectMissing};
