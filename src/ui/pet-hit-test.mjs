// 透明窗口仍是矩形；只在鼠标命中人物、角标、气泡或可见操作栏时接收点击。
export function createPetHitTest() {
  if(!document.body.classList.contains('floating'))return;
  const targets='#pet-art, #pet-store-button, #pet-subscriptions-badge, .speech, .pet-controls';
  const pressed=new Set();
  let point=null,interactive=null,version=0,queued=false,forcedCursor=false,cursorVersion=0;
  // 根节点手掌只用于补偿跨应用移入；收到真实移动后立即交还给命中元素自身的 cursor。
  function releaseForcedCursor() {
    cursorVersion++;
    if(forcedCursor){document.documentElement.style.cursor='';forcedCursor=false;}
  }
  function apply() {
    // 使用浏览器的实际命中结果，自动避开 hidden、quiet 和不可点击的透明容器。
    const element=point&&document.elementFromPoint(point.x,point.y);
    const hit=Boolean(pressed.size||element?.closest(targets));
    if(hit!==interactive){
      interactive=hit;
      if(!hit)releaseForcedCursor();
      window.whale.petInteractive(hit);
      if(hit&&element) {
        const stamp=++cursorVersion,cursor=getComputedStyle(element).cursor;
        // 穿透解除后未必补发 mousemove；下一帧主动刷新一次系统指针。
        requestAnimationFrame(()=>{
          if(stamp!==cursorVersion||!interactive||!point||!document.elementFromPoint(point.x,point.y)?.closest(targets))return;
          document.documentElement.style.cursor=cursor;forcedCursor=true;
        });
      }
    }
  }
  function move(event) {
    releaseForcedCursor();
    version++;point={x:event.clientX,y:event.clientY};apply();
  }
  async function refresh() {
    const stamp=++version;
    try {
      const next=await window.whale.petPointer();
      // 异步坐标不能覆盖之后到达的鼠标移动事件。
      if(stamp!==version)return;
      point=next;apply();
    }catch {/* 坐标暂时不可读时保留最近的命中状态。 */}
  }
  function queueRefresh() {
    if(queued)return;queued=true;
    requestAnimationFrame(()=>{queued=false;void refresh();});
  }
  document.addEventListener('mousemove',move);
  document.addEventListener('pointerdown',event=>{
    move(event);
    if(event.target.closest(targets)){pressed.add(event.pointerId);apply();}
  },true);
  document.addEventListener('pointerup',event=>{pressed.delete(event.pointerId);move(event);},true);
  document.addEventListener('pointercancel',event=>{pressed.delete(event.pointerId);apply();queueRefresh();},true);
  document.addEventListener('lostpointercapture',event=>{pressed.delete(event.pointerId);apply();queueRefresh();},true);
  document.addEventListener('mouseleave',()=>{version++;point=null;apply();});
  window.addEventListener('blur',()=>{pressed.clear();apply();queueRefresh();});
  window.addEventListener('resize',queueRefresh);
  window.addEventListener('focus',queueRefresh);
  window.whale.petPointerChanged(queueRefresh);
  // 气泡出现/消失、文字变化或列表展开时，即使鼠标静止也重新判断。
  new MutationObserver(queueRefresh).observe(document.body,{subtree:true,childList:true,characterData:true,attributes:true,
    attributeFilter:['hidden','class','style','data-state']});
  const sizes=new ResizeObserver(queueRefresh);
  for(const element of document.querySelectorAll(targets+', .speech-stack'))sizes.observe(element);
  apply();void refresh();
  // 从其他应用移入时，系统偶尔不会转发首次移动；穿透期间低频复查，避免第一击落到后方窗口。
  setInterval(()=>{if(interactive===false)void refresh();},100);
}
