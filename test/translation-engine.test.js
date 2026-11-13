'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {Translator}=require('../src/translation');
const cli=require('../src/claude-cli');
const {Glossary,parse}=require('../src/glossary');

function fakeClaude(impl){const calls=[];return {calls,MODELS:cli.MODELS,find:()=>'claude.exe',friendly:cli.friendly,translateBatch:async(exe,texts,opts)=>{calls.push({exe,texts,opts});return impl(texts);}};}
const googleFetch=(prefix='G:')=>async url=>({ok:true,json:async()=>[[[prefix+new URL(url).searchParams.get('q')]]]});

test('claude engine batches texts into one call and caches them',async()=>{
 const claude=fakeClaude(texts=>texts.map(t=>'한:'+t));
 const t=new Translator(googleFetch(),{claude});t.setEnabled(true);t.configure({engine:'claude',model:'sonnet'});
 const r=await Promise.all(['模型一','模型二','模型三'].map(x=>t.translate(x)));
 assert.deepEqual(r,['한:模型一','한:模型二','한:模型三']);
 assert.equal(claude.calls.length,1);assert.equal(claude.calls[0].opts.model,'sonnet');
 assert.equal(await t.translate('模型二'),'한:模型二');assert.equal(claude.calls.length,1);
});

test('glossary terms are replaced before sending; fully replaced titles skip the CLI',async()=>{
 const claude=fakeClaude(texts=>texts.map(t=>'['+t+']'));
 const t=new Translator(googleFetch(),{claude});t.setEnabled(true);t.configure({engine:'claude'});
 assert.equal(await t.translate('流萤'),'반디');assert.equal(claude.calls.length,0);
 assert.equal(await t.translate('原神 芙宁娜 泳装'),'[원신 푸리나 泳装]');
});

test('claude failure falls back to Google and pauses claude',async()=>{
 const claude=fakeClaude(()=>{throw new Error('Not logged in · Please run /login');});
 const t=new Translator(googleFetch(),{claude});t.setEnabled(true);t.configure({engine:'claude'});
 assert.equal(await t.translate('模型'),'G:模型');
 assert.match(t.status().error,/로그인/);assert.ok(t.status().cooldownUntil>Date.now());
 await t.translate('另一个');assert.equal(claude.calls.length,1);
});

test('empty items in claude reply fall back to Google individually',async()=>{
 const claude=fakeClaude(texts=>texts.map((x,i)=>i===0?'':'한'));
 const t=new Translator(googleFetch(),{claude});t.setEnabled(true);t.configure({engine:'claude'});
 assert.deepEqual(await Promise.all([t.translate('一'),t.translate('二')]),['G:一','한']);
});

test('disabling translation resolves queued claude texts with the original',async()=>{
 const claude=fakeClaude(texts=>texts);
 const t=new Translator(googleFetch(),{claude});t.setEnabled(true);t.configure({engine:'claude'});
 const p=t.translate('模型');t.setEnabled(false);assert.equal(await p,'模型');assert.equal(claude.calls.length,0);
});

test('configure rejects unknown engines and models',()=>{
 const t=new Translator(googleFetch(),{claude:fakeClaude(x=>x)});
 assert.throws(()=>t.configure({engine:'other'}));assert.throws(()=>t.configure({model:'opus-x'}));
});

test('parseArray strips fences and checks length',()=>{
 assert.deepEqual(cli.parseArray('```json\n["가","나"]\n```',2),['가','나']);
 assert.deepEqual(cli.parseArray('결과: ["가"]',1),['가']);
 assert.throws(()=>cli.parseArray('["가"]',2));assert.throws(()=>cli.parseArray('없음',1));
});

test('glossary file parsing and longest-first replacement',()=>{
 assert.deepEqual(parse('﻿# 주석\n甲=가\n 乙 = 나 \n잘못된줄\n'),{'甲':'가','乙':'나'});
 const g=new Glossary({'星穹':'X'});assert.equal(g.apply('崩坏：星穹铁道'),'붕괴: 스타레일');
});

test('friendly messages',()=>{
 assert.match(cli.friendly('Not logged in'),/로그인/);assert.match(cli.friendly('usage limit reached'),/한도/);
});

test('a claude reply without Hangul (echoed source) goes to Google',async()=>{
 const claude=fakeClaude(texts=>texts);
 const t=new Translator(googleFetch('구글:'),{claude});t.setEnabled(true);t.configure({engine:'claude'});
 assert.equal(await t.translate('模型'),'구글:模型');
});
