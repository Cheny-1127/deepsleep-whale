// 只监听人物区域；气泡、菜单和操作栏不会参与连击计数。
// 包装浏览器定时器，避免作为 clock 的方法调用时 this 不再是 Window。
export function createPetGestures({element,action,drag,enabled,bindings=()=>({doubleClick:'none',tripleClick:'panel'}),clock={now:()=>Date.now(),setTimeout:(fn,ms)=>setTimeout(fn,ms),clearTimeout:id=>clearTimeout(id)}}) {
  const gap=400;
  let down=null,moved=false,count=0,timer=null,lastClick=-Infinity,sequenceKey='';
  function current() {
    const value=enabled()?bindings():{doubleClick:'none',tripleClick:'none'};
    return {doubleClick:value?.doubleClick??'none',tripleClick:value?.tripleClick??'panel'};
  }
  const key=value=>`${value.doubleClick}:${value.tripleClick}`;
  function clearTimer(){clock.clearTimeout(timer);timer=null;}
  function reset(){clearTimer();count=0;lastClick=-Infinity;sequenceKey='';}
  function flush(){
    const clicks=count,value=current(),valid=sequenceKey===key(value);reset();
    // 配置在等待期间变化时取消旧连击，避免执行刚绑定的新动作。
    if(!valid)return;
    if(clicks===2&&value.doubleClick!=='none')action('shortcut-double');
    else for(let i=0;i<clicks;i++)action('touch');
  }
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
    const value=current();
    if(sequenceKey&&sequenceKey!==key(value))reset();
    if(value.doubleClick==='none'&&value.tripleClick==='none'){reset();action('touch');return;}
    if(clock.now()-lastClick>gap)flush();
    count++;lastClick=clock.now();sequenceKey=key(value);
    // 同时启用时，第二击先等待第三击；只启用双击则第二击即可执行。
    const final=value.tripleClick!=='none'?3:2;
    if(count===final){reset();action(final===3?'shortcut-triple':'shortcut-double');}
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
