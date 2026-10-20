// 只监听人物区域；气泡、菜单和操作栏不会参与连击计数。
// 包装浏览器定时器，避免作为 clock 的方法调用时 this 不再是 Window。
export function createPetGestures({element,action,drag,enabled,clock={now:()=>Date.now(),setTimeout:(fn,ms)=>setTimeout(fn,ms),clearTimeout:id=>clearTimeout(id)}}) {
  const gap=400;
  let down=null,moved=false,count=0,timer=null,lastClick=-Infinity;
  function clearTimer(){clock.clearTimeout(timer);timer=null;}
  function reset(){clearTimer();count=0;lastClick=-Infinity;}
  function flush(){const touches=count;reset();for(let i=0;i<touches;i++)action('touch');}
  function cancel(){down=null;reset();drag('end');}
  element.addEventListener('pointerdown',event=>{
    if(event.button!==0){cancel();return;}
    if(down){cancel();return;}
    clearTimer();
    down={x:event.screenX,y:event.screenY,id:event.pointerId};moved=false;
    element.setPointerCapture(event.pointerId);
    drag('start',{x:down.x,y:down.y});
  });
  element.addEventListener('pointermove',event=>{
    if(!down||event.pointerId!==down.id)return;
    const point={x:event.screenX,y:event.screenY};
    if(Math.hypot(point.x-down.x,point.y-down.y)>5){moved=true;reset();}
    if(moved)drag('move',point);
  });
  element.addEventListener('pointerup',event=>{
    if(!down||event.pointerId!==down.id||event.button!==0)return;
    const dragged=moved||Math.hypot(event.screenX-down.x,event.screenY-down.y)>5;
    down=null;drag('end');
    if(dragged){reset();return;}
    if(!enabled()){flush();action('touch');return;}
    if(clock.now()-lastClick>gap)flush();
    count++;lastClick=clock.now();
    if(count===3){reset();action('shortcut-triple');}
    else timer=clock.setTimeout(flush,gap);
  });
  element.addEventListener('pointercancel',cancel);
  // 正常松手也会释放捕获，此时不能误清除刚记下的一次点击。
  element.addEventListener('lostpointercapture',()=>{if(down)cancel();});
  element.addEventListener('keydown',event=>{
    if(event.key==='Enter'||event.key===' '){event.preventDefault();reset();action('touch');}
  });
  window.addEventListener('blur',cancel);
  window.addEventListener('pointerdown',event=>{if(!element.contains(event.target))reset();});
}
