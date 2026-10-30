const tab=document.getElementById('pet-storage-tab');
let press=null,received=false;
function render(data) {
  document.body.dataset.side=data.side;
  tab.classList.toggle('stored',data.stored);
  document.getElementById('attention').hidden=!data.attention;
  const hint=data.attention?'有待处理或未读消息。':'';
  tab.title=hint+'点击恢复鲸鱼娘；拖动可沿屏幕四边停靠';
  tab.setAttribute('aria-label',hint+'恢复鲸鱼娘');
}
function finish(restore=false) {
  if(!press)return;
  const previous=press;press=null;tab.classList.remove('dragging');
  window.whale.petStorageDrag('end');
  if(tab.hasPointerCapture(previous.id))tab.releasePointerCapture(previous.id);
  if(restore&&!previous.dragged)void window.whale.petStorage('restore');
}
tab.addEventListener('pointerdown',event=>{
  if(event.button!==0||press)return;
  press={id:event.pointerId,x:event.screenX,y:event.screenY,dragged:false};
  tab.setPointerCapture(event.pointerId);
  window.whale.petStorageDrag('start',{x:event.screenX,y:event.screenY});
});
tab.addEventListener('pointermove',event=>{
  if(!press||event.pointerId!==press.id)return;
  // 小幅手抖仍按点击处理；真正拖动后松手只吸边，不恢复人物。
  if(!press.dragged&&Math.hypot(event.screenX-press.x,event.screenY-press.y)<5)return;
  press.dragged=true;tab.classList.add('dragging');
  window.whale.petStorageDrag('move',{x:event.screenX,y:event.screenY});
});
tab.addEventListener('pointerup',event=>{if(event.pointerId===press?.id)finish(true);});
for(const name of ['pointercancel','lostpointercapture'])tab.addEventListener(name,()=>finish());
window.addEventListener('blur',()=>finish());
// 原生按钮的键盘点击没有 pointerup，单独保留 Enter / 空格恢复。
tab.addEventListener('click',event=>{if(event.detail===0)void window.whale.petStorage('restore');});
// 先订阅再读初始快照；已有实时推送时，不能让较晚返回的旧快照覆盖新状态。
window.whale.petStorageChanged(data=>{received=true;render(data);});
window.whale.petStorage('snapshot').then(data=>{if(!received)render(data);});
