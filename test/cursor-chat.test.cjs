'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createCursorChatOpener,agentUrl}=require('../src/clients/cursor-chat.cjs');
const id='cursor:201bf1ad-befa-4941-ae00-efa48265ce2f';
test('Cursor jump opens the built-in agent link and waits until that chat is selected',async()=>{
  const opened=[];let selected='other';
  const opener=createCursorChatOpener({openExternal:url=>{opened.push(url);selected=id.slice(7);},readSelected:()=>selected});
  await opener.open(id);
  assert.deepEqual(opened,[agentUrl(id.slice(7))]);
});
test('an already selected Cursor chat still focuses the Agents window',async()=>{
  let opened=0;
  const opener=createCursorChatOpener({openExternal(){opened++;},readSelected:()=>id.slice(7)});
  await opener.open(id);
  assert.equal(opened,1);
});
test('the selected Cursor chat is exposed only as a valid session id',()=>{
  assert.equal(createCursorChatOpener({openExternal(){},readSelected:()=>id.slice(7)}).selectedSession(),id);
  assert.equal(createCursorChatOpener({openExternal(){},readSelected:()=>null}).selectedSession(),null);
  assert.equal(createCursorChatOpener({openExternal(){},readSelected:()=>'not-a-uuid'}).selectedSession(),null);
});
test('failed Cursor selection keeps the reminder and invalid ids never launch',async()=>{
  await assert.rejects(createCursorChatOpener({timeout:30,openExternal(){},readSelected:()=>'other'}).open(id),/没有回到/);
  let launched=false;
  await assert.rejects(createCursorChatOpener({openExternal(){launched=true;},readSelected:()=>null}).open('cursor:bad'),/无法定位/);
  assert.equal(launched,false);
  await assert.rejects(createCursorChatOpener({openExternal(){return Promise.reject(new Error('OS failed'));},readSelected:()=>id.slice(7)}).open(id),/OS failed/);
});
