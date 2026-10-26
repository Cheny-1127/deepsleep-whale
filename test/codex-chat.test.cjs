'use strict';
const test=require('node:test'),assert=require('node:assert/strict');
const {createCodexChatOpener}=require('../src/clients/codex-chat.cjs');
const id='11111111-1111-4111-8111-111111111110';

test('opening a Codex chat only opens its deep link without native scrolling',async()=>{
  const calls=[];const opener=createCodexChatOpener({openExternal:async url=>calls.push(url),locateLatest:()=>assert.fail('must not automate scrolling')});
  await opener.open(id);assert.deepEqual(calls,[`codex://threads/${id}`]);
});
test('invalid chat targets never reach the external opener',async()=>{
  const opener=createCodexChatOpener({openExternal:()=>assert.fail('invalid URL')});
  await assert.rejects(opener.open(id+'?prompt=send'),/无法定位/);
});
test('concurrent opens are blocked and external failures unlock retry',async()=>{
  let release,count=0;
  const opener=createCodexChatOpener({openExternal:()=>{if(count++===0)return new Promise((_,reject)=>{release=()=>reject(Error('open failed'));});}});
  const first=opener.open(id);
  await assert.rejects(opener.open(id),/正在打开/);
  release();await assert.rejects(first,/open failed/);await opener.open(id);assert.equal(count,2);
});
