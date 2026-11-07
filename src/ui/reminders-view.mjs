// 只负责提醒展示和用户操作；已读、持久化和跳转结果均由主进程决定。
const $ = id => document.getElementById(id);

export function createReminderView({render,action,floating}) {
  let lastData;
  let reminderKey='';
  const runningReminders=new Set();
  async function processReminder(item) {
    const id=`${item.id}:${item.token}`;
    if(runningReminders.has(id))return;
    runningReminders.add(id);if(lastData)renderReminders(lastData);
    let failure='';
    try {
      const result=await window.whale.planner(item.processMinutes?'start':'complete',{id:item.id,token:item.token});
      if(result.error)throw Error(result.error);
      render(await window.whale.snapshot());
    }catch(error){failure=error.message||'未能处理提醒，请重试。';}
    finally {
      runningReminders.delete(id);if(lastData)renderReminders(lastData);
      if(failure){$('completion-error').textContent=failure;$('completion-error').hidden=false;}
    }
  }
  // 小屋和桌宠共用跳转反馈，失败时保留提醒，并恢复按钮以便重试。
  async function openReminder(value,button){
    const error=$(floating?'completion-error':'reminder-error');error.hidden=true;button.disabled=true;
    try {
      const result=await window.whale.openChat(value);
      if(result.error)throw Error(result.error);render(result.value);
    }catch(failure){error.textContent=failure.message||'没打开，再点一次试试？';error.hidden=false;}
    finally{button.disabled=false;}
  }
  function renderCompletionRows(notices,isBusy=false) {
    const key=JSON.stringify([isBusy,notices,[...runningReminders]]);
    if(key===reminderKey)return;
    reminderKey=key;
    $('completion-error').hidden=true;
    const rows=$('completion-rows');
    const focused=document.activeElement?.dataset.noticeId;
    rows.replaceChildren(...notices.map(item=>{
      const wrapper=document.createElement('div');wrapper.setAttribute('role','listitem');
      const button=document.createElement('button');button.className='completion-row';
      if(item.kind==='reminder') {
        wrapper.className='completion-reminder-row';wrapper.dataset.reminderId=item.id;wrapper.dataset.state=item.state;
        button.classList.add('completion-reminder-title');button.dataset.noticeId=`reminder:${item.id}:${item.token}`;button.textContent=item.title;button.title=item.title;
        const disabled=runningReminders.has(`${item.id}:${item.token}`);button.disabled=disabled;
        let clickTimer;
        function handleClick(event) {
          clearTimeout(clickTimer);if(event.detail>1)return;
          const run=()=>{if(wrapper.isConnected&&item.state==='waiting')void processReminder(item);};
          if(event.detail===0)run();else clickTimer=setTimeout(run,400);
        }
        button.addEventListener('click',handleClick);wrapper.addEventListener('dblclick',()=>{clearTimeout(clickTimer);void action('planner');});wrapper.append(button);
        if(item.state==='processing') {
          const clock=document.createElement('span');clock.className='completion-reminder-clock';clock.dataset.ends=String(item.processingEndsAt);wrapper.append(clock);
        } else {
          const start=document.createElement('button');start.type='button';start.className='soft completion-reminder-action';start.textContent=item.processMinutes?'开始处理':'完成';
          start.dataset.noticeId=button.dataset.noticeId+':action';start.disabled=disabled;start.addEventListener('click',handleClick);wrapper.append(start);
        }
        return wrapper;
      }
      const isTask=Boolean(item.state);
      button.classList.toggle('pending-row',item.state==='approval');
      button.dataset.noticeId=isTask?item.session_id:item.id;button.textContent=item.title;button.title=button.textContent;
      button.addEventListener('click',()=>void openReminder({sessionId:item.session_id,noticeId:isTask?undefined:item.id},button));
      wrapper.append(button);return wrapper;
    }));
    if(focused) ([...rows.querySelectorAll('button')].find(button=>button.dataset.noticeId===focused)||rows.querySelector('button'))?.focus();
  }
  function renderReminders(data) {
    lastData=data;
    // 各分类分别按同一阈值合并；定时提醒不混入聊天的待处理或执行中。
    const tasks=data.activity;
    const unread=tasks.unread||0;
    const summary=`${tasks.working} 个进行中 · ${tasks.pending} 个权限检查`;
    if(floating) {
      const busy=data.execution?.count??tasks.working;
      const pending=data.execution?.pendingItems||(tasks.sessions||[]).filter(item=>item.state==='approval').sort((a,b)=>(a.approvalSince??a.time)-(b.approvalSince??b.time));
      const reminders=data.execution?.reminderItems||[];
      const view=data.reminderView||(data.busyExpanded?'busy':pending.length?'pending':unread?'completed':busy?'busy':reminders.length?'reminders':'completed');
      const isBusy=view==='busy';
      const count=view==='pending'?pending.length:view==='reminders'?reminders.length:isBusy?busy:unread;
      const single=count===1;
      const autoExpanded=count>0&&count<=(data.shortcuts?.reminderCollapseThreshold??3);
      const expanded=Boolean((view==='pending'?data.pendingExpanded:view==='reminders'?data.remindersExpanded:isBusy?data.busyExpanded:data.completionExpanded)||autoExpanded);
      document.body.classList.toggle('single-completion',single&&expanded);
      document.body.classList.toggle('busy-expanded',isBusy);
      document.body.classList.toggle('completions-expanded',expanded);
      const singleCategory=[pending.length,reminders.length,unread,busy].filter(Boolean).length===1;
      $('completion-shell').classList.toggle('single-category',singleCategory);
      $('completion-shell').hidden=!unread&&!pending.length&&!busy&&!reminders.length;
      $('pending-alert').hidden=!pending.length;
      $('pending-alert').textContent=`待处理：${pending.length}`;
      $('pending-alert').title=`查看待处理任务，按收到顺序排列${pending.length>(data.shortcuts?.reminderCollapseThreshold??3)?`，点击${expanded&&view==='pending'?'收起':'展开'}`:''}`;
      $('pending-alert').setAttribute('aria-controls','completion-bubble');
      $('planner-reminder-alert').hidden=!reminders.length;
      $('planner-reminder-alert').textContent=`提醒：${reminders.length}`;
      $('planner-reminder-alert').title=`查看定时提醒${reminders.length>(data.shortcuts?.reminderCollapseThreshold??3)?`，点击${expanded&&view==='reminders'?'收起':'展开'}`:''}`;
      $('planner-reminder-alert').setAttribute('aria-controls','completion-bubble');
      $('planner-reminder-alert').setAttribute('aria-expanded',String(expanded&&view==='reminders'));
      $('completion-alert').hidden=!unread;
      $('completion-bubble').hidden=!expanded;
      $('completion-alert').setAttribute('aria-expanded',String(expanded&&view==='completed'));
      $('busy-alert').setAttribute('aria-expanded',String(expanded&&isBusy));
      $('busy-alert').setAttribute('aria-controls','completion-bubble');
      $('unread-label').textContent=`已完成：${unread}`;
      $('busy-alert').hidden=!busy;
      $('busy-alert').textContent=`执行中：${busy}`;
      const latest=tasks.notices?.[0];
      $('completion-alert').title=unread>(data.shortcuts?.reminderCollapseThreshold??3) ? `${unread} 个任务完成，点击${expanded?'收起':'展开'}` : unread>1 ? `${unread} 个任务完成，点击下方任务打开对话` : latest ? `${latest.title} · 点击打开对话` : '';
      $('completion-alert').setAttribute('aria-controls','completion-bubble');
      $('completion-alert').dataset.action='open-completion';
      $('pending-alert').setAttribute('aria-expanded',String(expanded&&view==='pending'));
      for(const [id,category] of [['pending-alert','pending'],['completion-alert','completed'],['busy-alert','busy'],['planner-reminder-alert','reminders']])$(id).classList.toggle('selected-category',view===category&&expanded);
      const rows=view==='pending'?pending:view==='reminders'?reminders:isBusy?data.execution?.items||(tasks.sessions||[]).filter(item=>['thinking','working'].includes(item.state)):tasks.notices||[];
      renderCompletionRows(rows,isBusy);
      for(const clock of $('completion-rows').querySelectorAll('[data-ends]')) {
        const seconds=Math.max(0,Math.ceil((Number(clock.dataset.ends)-Date.now())/1000));
        clock.textContent=`处理中 · ${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;
      }
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
      open.addEventListener('click',()=>void openReminder({sessionId:item.session_id,noticeId:unread?item.id:undefined},open));
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
      if((lastData?.completionExpanded||lastData?.busyExpanded||lastData?.pendingExpanded||lastData?.remindersExpanded)&&!event.target.closest('#completion-shell'))action('close-completions');
    });
    document.addEventListener('keydown',event=>{
      // 按实际展示状态响应键盘，自动展开的三条以内列表也支持方向键选择。
      if(!document.body.classList.contains('completions-expanded'))return;
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
