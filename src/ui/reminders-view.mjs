// 只负责提醒展示和用户操作；已读、持久化和跳转结果均由主进程决定。
const $ = id => document.getElementById(id);

export function createReminderView({render,action,floating}) {
  let lastData;
  let reminderKey='';
  function renderCompletionRows(notices,isBusy=false) {
    const key=JSON.stringify([isBusy,notices]);
    if(key===reminderKey)return;
    reminderKey=key;
    $('completion-error').hidden=true;
    const rows=$('completion-rows');
    const focused=document.activeElement?.dataset.noticeId;
    rows.replaceChildren(...notices.map(item=>{
      const wrapper=document.createElement('div');wrapper.setAttribute('role','listitem');
      const button=document.createElement('button');button.className='completion-row';
      const isTask=Boolean(item.state);
      button.classList.toggle('pending-row',item.state==='approval');
      button.dataset.noticeId=isTask?item.session_id:item.id;button.textContent=item.title;button.title=button.textContent;
      button.addEventListener('click',async()=>{
        const error=$('completion-error');error.hidden=true;button.disabled=true;
        try { render(await window.whale.action('open-chat',{sessionId:item.session_id,noticeId:isTask?undefined:item.id})); }
        catch(failure) { error.textContent=failure.message||'没打开，再点一次试试？';error.hidden=false; }
        finally { button.disabled=false; }
      });
      wrapper.append(button);return wrapper;
    }));
    if(focused) ([...rows.querySelectorAll('button')].find(button=>button.dataset.noticeId===focused)||rows.querySelector('button'))?.focus();
  }
  function renderReminders(data) {
    lastData=data;
    // 待处理按首次收到顺序；1～3 条完成直接显示，超过 3 条才折叠。
    const tasks=data.activity;
    const unread=tasks.unread||0;
    const summary=`${tasks.working} 个进行中 · ${tasks.pending} 个权限检查`;
    if(floating) {
      const view=data.reminderView||(data.busyExpanded?'busy':tasks.pending?'pending':'completed');
      const isBusy=view==='busy';
      const pending=(tasks.sessions||[]).filter(item=>item.state==='approval').sort((a,b)=>(a.approvalSince??a.time)-(b.approvalSince??b.time));
      const count=view==='pending'?pending.length:isBusy?tasks.working:unread;
      const single=count===1;
      const autoExpanded=view==='completed'&&unread>0&&unread<=3;
      const expanded=view==='pending'?pending.length>0:isBusy?Boolean(data.busyExpanded):Boolean(data.completionExpanded||autoExpanded);
      document.body.classList.toggle('single-completion',single&&expanded);
      document.body.classList.toggle('busy-expanded',isBusy);
      document.body.classList.toggle('completions-expanded',expanded);
      const busy=tasks.working;
      const singleCategory=[pending.length,unread,busy].filter(Boolean).length===1;
      $('completion-shell').classList.toggle('single-category',singleCategory);
      $('completion-shell').hidden=!unread&&!pending.length&&busy<=1;
      $('pending-alert').hidden=!pending.length;
      $('pending-alert').textContent=`待处理：${pending.length}`;
      $('pending-alert').title='查看待处理任务，按收到顺序排列';
      $('completion-alert').hidden=!unread;
      $('completion-bubble').hidden=!expanded;
      $('completion-alert').setAttribute('aria-expanded',String(expanded&&view==='completed'));
      $('busy-alert').setAttribute('aria-expanded',String(expanded&&isBusy));
      $('busy-alert').setAttribute('aria-controls','completion-bubble');
      $('unread-label').textContent=`已完成：${unread}`;
      $('busy-alert').hidden=!busy;
      $('busy-alert').textContent=`执行中：${busy}`;
      const latest=tasks.notices?.[0];
      $('completion-alert').title=unread>3 ? `${unread} 个任务完成，点击${expanded?'收起':'展开'}` : unread>1 ? `${unread} 个任务完成，点击下方任务打开对话` : latest ? `${latest.title} · 点击打开对话` : '';
      $('completion-alert').setAttribute('aria-controls','completion-bubble');
      $('completion-alert').dataset.action='open-completion';
      $('pending-alert').setAttribute('aria-expanded',String(expanded&&view==='pending'));
      for(const [id,category] of [['pending-alert','pending'],['completion-alert','completed'],['busy-alert','busy']])$(id).classList.toggle('selected-category',view===category&&expanded);
      const rows=view==='pending'?pending:isBusy?(tasks.sessions||[]).filter(item=>['thinking','working'].includes(item.state)):tasks.notices||[];
      renderCompletionRows(rows,isBusy);
      return;
    }
    $('chat-summary').textContent=tasks.count ? summary : '尚未收到聊天事件';
    $('reminder-count').textContent=unread?`已完成：${unread}`:'暂无未读';
    $('reminder-error').hidden=!data.reminderError;
    $('reminder-error').textContent=data.reminderError||'';
    const key=JSON.stringify([tasks.notices,tasks.sessions]);
    if(key===reminderKey)return;
    reminderKey=key;
    const states={thinking:'思考中',working:'进行中',approval:'权限检查',completed:'本轮已结束',idle:'已停止'};
    function row(item,unread) {
      const element=document.createElement('div');element.className='chat-row';
      const text=document.createElement('div');text.className='chat-description';
      const title=document.createElement('strong');title.textContent=item.title;
      const detail=document.createElement('span');
      detail.textContent=`${unread?'本轮已结束':states[item.state]||'已停止'} · ${new Date(item.time).toLocaleTimeString('zh-CN')} · ${item.session_id.slice(-8)}`;
      text.append(title,detail);element.append(text);
      const open=document.createElement('button');open.textContent='打开聊天';
      open.disabled=!/^(cursor:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(item.session_id);
      open.addEventListener('click',()=>action('open-chat',{sessionId:item.session_id,noticeId:unread?item.id:undefined}));
      element.append(open);
      if(unread) {
        const read=document.createElement('button');read.textContent='标为已读';
        read.dataset.noticeId=item.id;
        read.addEventListener('click',()=>action('read-notice',item.id));element.append(read);
      }
      return element;
    }
    // 标题只作为文本插入，不能把聊天标题当作 HTML 或命令执行。
    $('unread-list').replaceChildren(...(tasks.notices||[]).map(item=>row(item,true)));
    $('chat-list').replaceChildren(...(tasks.sessions||[]).map(item=>row(item,false)));
  }
  if(floating) {
    document.addEventListener('pointerdown',event=>{
      if((lastData?.completionExpanded||lastData?.busyExpanded)&&!event.target.closest('#completion-shell'))action('close-completions');
    });
    document.addEventListener('keydown',event=>{
      if(!lastData?.completionExpanded&&!lastData?.busyExpanded&&!lastData?.activity.pending&&!(lastData?.activity.unread>0&&lastData.activity.unread<=3))return;
      if(event.key==='Escape') { action('close-completions');return; }
      if(!['ArrowDown','ArrowUp'].includes(event.key))return;
      const buttons=[...$('completion-rows').querySelectorAll('button')];
      if(!buttons.length)return;
      event.preventDefault();
      const index=buttons.indexOf(document.activeElement);
      buttons[(index+(event.key==='ArrowDown'?1:-1)+buttons.length)%buttons.length].focus();
    });
  }
  return {render:renderReminders};
}
