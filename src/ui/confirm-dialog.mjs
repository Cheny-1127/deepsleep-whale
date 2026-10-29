let sequence=0;

// 确认框挂在所属模块内，模块关闭时可统一取消；不使用会唤起系统窗口的 window.confirm。
export function confirmAction({owner,title,message,confirmLabel='确认',danger=false,content=null,validate=null}) {
  // 隐藏、停用模块不能发起操作，同一时刻也只允许一个确认框占用焦点。
  if(owner.closest('[hidden],[inert]')||document.querySelector('.ui-confirm-dialog[open]'))return Promise.resolve(false);
  const opener=document.activeElement,dialog=document.createElement('dialog'),id='ui-confirm-'+(++sequence);
  dialog.className='ui-dialog ui-confirm-dialog';dialog.setAttribute('role','alertdialog');
  dialog.setAttribute('aria-labelledby',id+'-title');dialog.setAttribute('aria-describedby',id+'-message');
  const heading=document.createElement('h2'),description=document.createElement('p'),actions=document.createElement('div');
  heading.id=id+'-title';heading.textContent=title;description.id=id+'-message';description.textContent=message;actions.className='ui-confirm-actions';
  const cancel=document.createElement('button'),confirm=document.createElement('button');
  // 默认聚焦取消，直接按 Enter 不会触发删除等不可撤销操作。
  cancel.type=confirm.type='button';cancel.className='outline';cancel.textContent='取消';cancel.autofocus=true;
  confirm.className=danger?'primary ui-confirm-danger':'primary';confirm.textContent=confirmLabel;
  // 有附加必填内容时先校验，失败保留弹窗与草稿；取消始终不受表单校验阻拦。
  cancel.addEventListener('click',()=>dialog.close());confirm.addEventListener('click',()=>{if(!validate||validate())dialog.close('confirmed');});
  // 额外详情由调用方创建 DOM 节点后传入，不接收 HTML 字符串，沿用相同的取消与焦点管理。
  actions.append(cancel,confirm);dialog.append(heading,description);if(content)dialog.append(content);dialog.append(actions);owner.append(dialog);
  return new Promise(resolve=>{
    const cancelOnNavigation=()=>{if(owner.closest('[hidden],[inert]'))dialog.close();};
    document.addEventListener('whale-view-changed',cancelOnNavigation);
    dialog.addEventListener('close',()=>{
      document.removeEventListener('whale-view-changed',cancelOnNavigation);dialog.remove();
      if(opener?.isConnected&&!opener.closest('[hidden],[inert]'))opener.focus({preventScroll:true});
      // 只有明确点击确认才执行；Esc、切页或模块关闭一律按取消处理。
      resolve(dialog.returnValue==='confirmed');
    },{once:true});
    dialog.showModal();
  });
}
