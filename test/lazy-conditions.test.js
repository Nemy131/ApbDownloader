const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm'),C=require('../src/core');
const source=fs.readFileSync(require.resolve('../src/main'),'utf8');
test('loading and refreshing author lists never request conditions',async()=>{let detailCalls=0,persisted=0;const ctx={C,state:{works:[],author:''},site:{closePending(){},page:async()=>({data:[{work_uuid:'model1',work_name:'Model',nick_name:'Author'}],total:1,last_page:1,current_page:1}),detail:async()=>{detailCalls++;throw Error('Unexpected condition request');}},log(){},emit(){},rememberList(){},cachedList:()=>null,stamp:()=>'',persist:async()=>persisted++};vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('async function load('),source.indexOf('async function resolveWork(')),ctx);await ctx.load('https://www.aplaybox.com/u/123/model','model');assert.equal(ctx.state.works.length,1);assert.equal(ctx.state.works[0].detailLoaded,false);assert.equal(ctx.state.works[0].author,'Author');ctx.state.works[0].selected=true;await ctx.load('https://www.aplaybox.com/u/123/model','model',undefined,true);assert.equal(detailCalls,0);assert.equal(ctx.state.works[0].selected,true);assert.equal(persisted,2);});
test('switching back to an author shows the saved list without requesting pages; refresh still requests',async()=>{
 let pages=0;const saved=[{id:'m1',type:1,title:'Saved',status:'완료',files:[],selected:true}];const logs=[];
 const ctx={C,state:{works:[],author:''},site:{closePending(){},page:async()=>{pages++;return {data:[{work_uuid:'m1',work_name:'Fresh',nick_name:'A'}],total:1,last_page:1,current_page:1};},detail:async()=>{throw Error('no');}},log:m=>logs.push(m),emit(){},rememberList(){},stamp:()=>'11-13 10:00',
  cachedList:(uid,scope)=>uid==='123'&&scope==='all'?{entry:{fetchedAt:'2026-11-13T01:00:00Z'},works:saved}:null,persist:async()=>{}};
 vm.createContext(ctx);vm.runInContext(source.slice(source.indexOf('async function load('),source.indexOf('async function resolveWork(')),ctx);
 await ctx.load('https://www.aplaybox.com/u/123/model','all');
 assert.equal(pages,0);assert.equal(ctx.state.complete,true);assert.equal(ctx.state.works[0].title,'Saved');assert.equal(ctx.state.works[0].selected,true);assert.notEqual(ctx.state.works[0],saved[0]);assert.match(logs.at(-1),/저장된 목록 1개/);
 await ctx.load('https://www.aplaybox.com/u/123/model','all',undefined,true);
 assert.ok(pages>0);assert.equal(ctx.state.works[0].title,'Fresh');
});
