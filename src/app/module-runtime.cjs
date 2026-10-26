'use strict';

// 停用时释放轮询、连接和请求；重新开启从原存储恢复，账号内的暂停设置不变。
function createModuleRuntime({create,enabled=true,readers=['snapshot']}) {
  let current=create(),closed=false,started=false;
  const cached=new Map();
  function suspend(){
    if(!current)return;
    // close 可能清理内存，因此先保留只读快照；迟到请求只能访问已关闭的旧实例。
    for(const name of readers)cached.set(name,structuredClone(current[name]()));
    const old=current;current=null;old.close();
  }
  if(!enabled)suspend();
  const controls={
    start(){started=true;current?.start?.();},
    setModuleEnabled(value){
      if(closed)throw Error('模块已退出');
      if(!value)suspend();
      else if(!current){current=create();cached.clear();if(started)current.start?.();}
    },
    close(){if(closed)return;closed=true;suspend();}
  };
  // 调用始终转发到当前实例；停用时仅允许读取快照，旧入口不能重新启动后台操作。
  return new Proxy(controls,{get(target,name){
    if(Object.hasOwn(target,name))return target[name];
    if(readers.includes(name))return (...args)=>current?current[name](...args):structuredClone(cached.get(name));
    return (...args)=>{if(!current)throw Error('模块已关闭，请先开启');return current[name](...args);};
  }});
}
module.exports={createModuleRuntime};
