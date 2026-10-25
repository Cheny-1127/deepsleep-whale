'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');

function fixture(result) {
  const elements=new Map(),spoken=[],calls=[];
  function element(id) {
    if(!elements.has(id))elements.set(id,{handlers:new Map(),setAttribute(){},addEventListener(name,handler){this.handlers.set(name,handler);}});
    return elements.get(id);
  }
  const document={hidden:true,getElementById:element,addEventListener(){}};
  const window={whale:{petQuota:async(...args)=>{calls.push(args);return result;}}};
  const source=fs.readFileSync(path.join(__dirname,'../src/ui/pet-quota-view.mjs'),'utf8').replace('export function','function');
  vm.runInNewContext(source+'\ncreatePetQuotaView({say:text=>spoken.push(text)});',{document,window,spoken,setInterval(){}});
  return {spoken,calls,elements,doubleClick:()=>element('pet-quota-controls').handlers.get('dblclick')({target:{closest:()=>null}})};
}

test('account selection feedback uses Whale speech and leaves switching available',async()=>{
  const f=fixture({value:{tracking:null},message:'哎呀，其他账号都在展示啦，暂时没得换咯～'});
  await f.doubleClick();
  assert.deepEqual(f.spoken,['哎呀，其他账号都在展示啦，暂时没得换咯～']);
  assert.deepEqual(f.calls,[['choose-account','primary']]);
  await f.doubleClick();
  assert.equal(f.spoken.length,2);
});

test('normal account picker completion does not add speech',async()=>{
  const f=fixture({value:{tracking:null}});
  await f.doubleClick();
  assert.deepEqual(f.spoken,[]);
});
