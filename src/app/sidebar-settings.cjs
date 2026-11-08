'use strict';
const fs=require('node:fs'),path=require('node:path');
const MENU_IDS=['home','subscriptions','archery','hooks','wechat','mail','quota','shortcuts','planner','reports','ai-sessions'];

function normalize(saved) {
  const seen=new Set();
  // 退出插件试用后，将旧入口归回内置 Archery，保留原来的常用/更多位置并统一去重。
  const take=items=>(Array.isArray(items)?items:[]).map(id=>id==='plugin:archery'?'archery':id).filter(id=>{
    if(!MENU_IDS.includes(id)||seen.has(id))return false;
    seen.add(id);return true;
  });
  const visible=take(saved?.visible),more=take(saved?.more);
  // 旧版 AI 入口统一收进更多；新布局保存后保留用户主动整理的位置。
  if(saved?.version!==1&&visible.includes('ai-sessions')){visible.splice(visible.indexOf('ai-sessions'),1);more.push('ai-sessions');}
  // 普通新增入口沿用常用区，AI 功能默认放在更多，其他顺序不变。
  visible.push(...MENU_IDS.filter(id=>id!=='ai-sessions'&&!seen.has(id)));
  if(!seen.has('ai-sessions'))more.push('ai-sessions');
  return {visible,more};
}
function createSidebarSettings({dataDir}) {
  const file=path.join(dataDir,'sidebar.json');
  let state=normalize();
  try {state=normalize(JSON.parse(fs.readFileSync(file,'utf8')));}catch {} // 首次启动或文件损坏时使用默认布局，不覆盖原文件。
  const snapshot=()=>({visible:[...state.visible],more:[...state.more]});
  return {snapshot,update(value) {
    // 写入必须完整且不重复地覆盖所有入口；读取旧配置时才允许补齐和清理。
    const ids=[...(Array.isArray(value?.visible)?value.visible:[]),...(Array.isArray(value?.more)?value.more:[])];
    if(!Array.isArray(value?.visible)||!Array.isArray(value?.more)||ids.length!==MENU_IDS.length||new Set(ids).size!==MENU_IDS.length||ids.some(id=>!MENU_IDS.includes(id)))throw new Error('无效的菜单布局');
    const next=normalize({...value,version:1});
    // 落盘成功才更新运行态，写入失败时界面可以恢复上一份有效布局。
    fs.writeFileSync(file+'.tmp',JSON.stringify({version:1,...next}),{mode:0o600});
    fs.renameSync(file+'.tmp',file);state=next;return snapshot();
  }};
}
module.exports={createSidebarSettings};
