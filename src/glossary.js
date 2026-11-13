'use strict';
// Game terms the translators often get wrong. Applied to the Chinese text before it is sent to Claude,
// so the official Korean name is kept as-is. Users can add lines "원문=번역" in data/glossary.txt.
const BUILTIN={
 '崩坏：星穹铁道':'붕괴: 스타레일','崩坏星穹铁道':'붕괴: 스타레일','星穹铁道':'스타레일','崩坏3':'붕괴3rd','原神':'원신','绝区零':'젠레스 존 제로','鸣潮':'명조',
 '芙宁娜':'푸리나','纳西妲':'나히다','胡桃':'호두','钟离':'종려','雷电将军':'라이덴 쇼군','神里绫华':'카미사토 아야카','八重神子':'야에 미코','甘雨':'감우','刻晴':'각청',
 '流萤':'반디','砂金':'어벤츄린','知更鸟':'로빈','姬子':'히메코','黄泉':'아케론','卡芙卡':'카프카','银狼':'은랑','黑天鹅':'블랙 스완',
 '今汐':'금희','长离':'장리','星见雅':'호시미 미야비','艾莲':'엘렌',
};
function parse(text){
 const out={};
 for(const line of String(text||'').replace(/^﻿/,'').split(/\r?\n/)){
  const t=line.trim();if(!t||t.startsWith('#'))continue;const i=t.indexOf('=');if(i<1)continue;
  const k=t.slice(0,i).trim(),v=t.slice(i+1).trim();if(k&&v&&k.length<=60&&v.length<=60)out[k]=v;
 }
 return out;
}
class Glossary{
 constructor(extra={}){this.set(extra);}
 set(extra){this.terms={...BUILTIN,...extra};this.keys=Object.keys(this.terms).sort((a,b)=>b.length-a.length);}
 apply(text){let s=String(text);for(const k of this.keys)if(s.includes(k))s=s.split(k).join(this.terms[k]);return s;}
}
module.exports={BUILTIN,parse,Glossary};
