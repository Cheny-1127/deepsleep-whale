import {createSelectView} from './select-view.mjs';
import {showView} from './hooks-view.mjs';
import {confirmAction} from './confirm-dialog.mjs';
const $=id=>document.getElementById('planner-'+id);
const el=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
const button=(text,run,className='outline')=>{const node=el('button',className,text);node.type='button';node.addEventListener('click',run);return node;};
const dateTime=value=>new Date(value).toLocaleString('zh-CN',{month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit',hour12:false});
const dateOnly=value=>new Date(value).toLocaleDateString('zh-CN',{year:'numeric',month:'numeric',day:'numeric'});
const calendarDate=value=>new Intl.DateTimeFormat('sv-SE',{year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(value));
const remaining=value=>{const seconds=Math.max(0,Math.ceil((value-Date.now())/1000));return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;};
const taskStatuses=[{value:'pending',label:'待处理'},{value:'processing',label:'处理中'},{value:'done',label:'处理完成'}];
const taskPlanLabel=task=>task.startDate?(task.dueDate?`计划：${task.startDate} 至 ${task.dueDate}`:`计划开始：${task.startDate} · 结束未定`):task.dueDate?'计划结束：'+task.dueDate:'未排期';
const dayNames=['周日','周一','周二','周三','周四','周五','周六'];
const isAllDay=schedule=>schedule.periods.length===1&&schedule.periods[0].start==='00:00'&&schedule.periods[0].end==='24:00';
const scheduleLabel=schedule=>`${schedule.days.length===7?'每天':schedule.days.map(day=>dayNames[day]).join('、')} · ${isAllDay(schedule)?'全天':schedule.periods.map(p=>p.start+'–'+(p.end==='24:00'?'当天结束':p.end)).join(' / ')}`;
function pickerHtml(id,label) {
  return `<div class="planner-field"><span id="planner-${id}-label">${label}</span><details class="ui-select" id="planner-${id}-picker"><summary class="ui-select-trigger" id="planner-${id}-trigger" aria-labelledby="planner-${id}-label planner-${id}-selected"><span id="planner-${id}-selected"></span><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3 6 5 5 5-5" stroke="currentColor" stroke-width="1.5"/></svg></summary><div class="ui-select-menu"><div class="ui-select-options" id="planner-${id}-options" role="listbox" aria-labelledby="planner-${id}-label"></div></div></details></div>`;
}
function select(id,items,onChange) {
  const view=createSelectView({picker:$(id+'-picker'),trigger:$(id+'-trigger'),options:$(id+'-options'),label:$(id+'-selected'),onChange});
  return {set(value){view.render({items,value});},close(){view.close();}};
}
function workEditor(root,prefix) {
  root.innerHTML=`<fieldset class="planner-days"><legend>允许提醒的日期</legend><button type="button" class="outline planner-everyday" aria-pressed="false">每天</button>${[1,2,3,4,5,6,0].map(day=>`<label><input type="checkbox" value="${day}">${dayNames[day]}</label>`).join('')}</fieldset><label class="planner-follow"><input type="checkbox" class="planner-all-day"> 全天允许</label><div class="planner-time-fields"><div class="planner-periods"></div></div>`;
  const periods=root.querySelector('.planner-periods'),days=[...root.querySelectorAll('.planner-days input')],everyday=root.querySelector('.planner-everyday'),allDay=root.querySelector('.planner-all-day'),timeFields=root.querySelector('.planner-time-fields');
  function update() {
    everyday.setAttribute('aria-pressed',String(days.every(input=>input.checked)));
    timeFields.hidden=allDay.checked;
    for(const input of periods.querySelectorAll('input'))input.disabled=allDay.checked;
  }
  everyday.addEventListener('click',()=>{for(const input of days)input.checked=true;update();root.dispatchEvent(new Event('input',{bubbles:true}));});
  root.addEventListener('change',update);
  function row(value={start:'10:00',end:'19:00'}) {
    const wrapper=el('div','planner-period'),start=el('input'),end=el('input');
    // end 使用文本输入以支持 24:00；原生 time 控件不能表达当日结束边界。
    start.type='time';end.type='text';end.inputMode='numeric';end.pattern='(?:[01][0-9]|2[0-3]):[0-5][0-9]|24:00';end.placeholder='19:00';
    start.required=end.required=true;start.value=value.start;end.value=value.end;end.maxLength=5;
    start.setAttribute('aria-label',prefix+'开始时间');end.setAttribute('aria-label',prefix+'结束时间');
    const remove=button('移除',()=>{wrapper.remove();root.dispatchEvent(new Event('input',{bubbles:true}));});
    remove.setAttribute('aria-label',prefix+'移除此时段');wrapper.append(start,el('span','','至'),end,remove);periods.append(wrapper);
  }
  timeFields.append(button('＋ 添加时段',()=>{if(periods.children.length<6){row();root.dispatchEvent(new Event('input',{bubbles:true}));}}));
  // 全天沿用已有存储格式；切换时只隐藏输入，保留本次编辑的自定义时段供取消全天时恢复。
  return {set(value){for(const input of days)input.checked=value.days.includes(Number(input.value));allDay.checked=isAllDay(value);periods.replaceChildren();(allDay.checked?[{start:'10:00',end:'19:00'}]:value.periods).forEach(row);update();},
    get(){return {days:days.filter(input=>input.checked).map(input=>Number(input.value)),periods:allDay.checked?[{start:'00:00',end:'24:00'}]:[...periods.children].map(row=>({start:row.children[0].value,end:row.children[2].value}))};}};
}
export function createPlannerView({floating=false}={}) {
  const container=$('content'),bubble=$('bubble');
  if(!container&&!bubble)return {render(){}};
  let data,lastRevision=-1,requestedRevision=-1,loading=false,filter='all',category='all',section='current',historyDate='',historyKey='',historyRequest=0,lastCompleted=null,itemKind='task',itemId=null,mode='interval',deadline='none',taskState='pending',settingsDirty=false,petKey='',listKey='',saving=false;
  async function request(name,value) {
    const response=await window.whale.planner(name,value);
    if(response.error)throw Error(response.error);
    return response.value;
  }
  function report(error,target=$('error')){if(target){target.textContent=error.message;target.hidden=false;}}
  async function act(name,value) {
    if(saving)return;saving=true;
    const previous=data?.tasks.find(item=>item.id===value?.id);
    if(container&&['toggle-task','set-task-status'].includes(name)){lastCompleted=null;$('completed-feedback').hidden=true;}
    try {
      const next=await request(name,value);
      if(container){const task=next.tasks.find(item=>item.id===value?.id);if(task?.status==='done'&&previous?.status!=='done')rememberCompletion(task);apply(next);}
      if($('error'))$('error').hidden=Boolean(!next.error);return next;
    }
    catch(error){report(error);}
    finally {saving=false;}
  }
  function renderPet(summary) {
    if(!bubble)return;
    const active=summary?.active||[],key=JSON.stringify(active.map(item=>[item.id,item.token,item.state]));
    bubble.hidden=!active.length;document.body.classList.toggle('planner-active',active.length>0);
    if(key!==petKey) {
      petKey=key;bubble.replaceChildren();
      const rows=el('div','planner-pet-rows');
      for(const item of active) {
        const row=el('div','planner-pet-row');row.append(el('strong','',item.title));
        if(item.state==='processing'){const clock=el('span','planner-clock');clock.dataset.ends=String(item.processingEndsAt);row.append(clock);}
        else row.append(button(item.processMinutes?'开始处理':'完成',()=>act(item.processMinutes?'start':'complete',{id:item.id,token:item.token}),'soft'));
        rows.append(row);
      }
      bubble.append(rows,button('打开日程备忘',()=>window.whale.action('planner'),'planner-pet-open'));
      const error=el('p','planner-pet-error');error.id='planner-error';error.setAttribute('role','alert');error.hidden=true;bubble.append(error);
    }
    for(const clock of bubble.querySelectorAll('[data-ends]'))clock.textContent='处理中 · '+remaining(Number(clock.dataset.ends));
  }
  if(container) {
    // 这里的 HTML 全为固定结构；用户填写的名称和备注只通过 textContent/value 展示。
    container.innerHTML=`<div class="ui-tabs planner-tabs" role="tablist" aria-label="日程视图"><button id="planner-current-tab" type="button" role="tab" aria-selected="true" aria-controls="planner-current">事项安排</button><button id="planner-history-tab" type="button" role="tab" aria-selected="false" aria-controls="planner-history" tabindex="-1">完成历史</button></div><div class="planner-overview"><div class="planner-filters planner-category-filter" role="group" aria-label="事项分类"><button type="button" data-category="all" aria-pressed="true">全部事项</button><button type="button" data-category="work" aria-pressed="false">工作</button><button type="button" data-category="personal" aria-pressed="false">个人</button></div><p id="planner-overview-summary" class="planner-muted" role="status"></p></div>
      <p class="ui-alert" id="planner-error" role="alert" hidden></p>
      <div id="planner-completed-feedback" class="planner-completed-feedback" role="status" hidden><span id="planner-completed-message"></span><button id="planner-view-completed" type="button" class="outline">查看完成历史</button></div>
      <p id="planner-settings-feedback" class="planner-muted" role="status"></p>
      <div class="planner-modules" id="planner-current" role="tabpanel" aria-labelledby="planner-current-tab">
      <section id="planner-reminders" class="planner-module" aria-labelledby="planner-reminders-heading"><div class="planner-toolbar"><h2 id="planner-reminders-heading">定时提醒 <span id="planner-reminder-count" class="planner-count"></span></h2><p id="planner-work-summary" class="planner-muted"></p></div><div id="planner-reminder-list" class="planner-list"></div>
      <p class="planner-footnote">电脑休眠或应用退出时不能即时提醒；恢复后只提示当前时段内的一轮，不积压过期提醒。</p></section>
      <section id="planner-tasks" class="planner-module" aria-labelledby="planner-tasks-heading"><div class="planner-toolbar"><h2 id="planner-tasks-heading">待办事项 <span id="planner-task-count" class="planner-count"></span></h2><div class="planner-filters" role="group" aria-label="筛选待办"><button type="button" data-filter="all" aria-pressed="true">全部</button><button type="button" data-filter="today" aria-pressed="false">今天</button><button type="button" data-filter="upcoming" aria-pressed="false">接下来</button><button type="button" data-filter="none" aria-pressed="false">未排期</button><button type="button" data-filter="pending" aria-pressed="false">待处理</button><button type="button" data-filter="processing" aria-pressed="false">处理中</button><button type="button" data-filter="done" aria-pressed="false">处理完成</button></div></div><div id="planner-task-list" class="planner-list"></div></section></div>
      <section id="planner-history" role="tabpanel" aria-labelledby="planner-history-tab" hidden><div class="planner-toolbar"><h2>完成历史 <span id="planner-history-count" class="planner-count"></span></h2><div class="planner-history-controls"><label>完成日期<input id="planner-history-date" type="date" min="2000-01-01" max="2100-12-31"></label><button id="planner-history-today" type="button" class="outline">今天</button></div></div><p class="planner-muted">同一条待办只展示一条最新完成记录，删除原任务后仍保留。工作待办按实际完成日期自动归入日报，需开启报告同步；个人事项不纳入。</p><div id="planner-history-list" class="planner-list" aria-live="polite"></div></section>
      <dialog class="ui-dialog planner-dialog" id="planner-settings-dialog" aria-labelledby="planner-settings-heading"><form id="planner-settings-form"><div class="planner-dialog-heading"><h2 id="planner-settings-heading">默认配置</h2><button type="button" class="ui-icon-button" id="planner-close-settings" aria-label="关闭默认配置">×</button></div><p class="planner-muted">工作与个人共用此默认时间和通知设置，每条提醒也可单独设置。允许时段外停止提示，下个允许时段重新计时。日期按星期选择，不自动识别法定节假日。</p><div id="planner-work-editor"></div><div class="planner-notifications"><label><input type="checkbox" id="planner-notifications"> 系统通知</label><label><input type="checkbox" id="planner-sound"> 提示音</label></div><p id="planner-settings-error" class="ui-alert" role="alert" hidden></p><div class="planner-dialog-actions"><button type="button" class="outline" id="planner-cancel-settings">取消</button><button type="submit" class="primary">保存配置</button></div></form></dialog>
      <dialog class="ui-dialog planner-dialog" id="planner-item-dialog" aria-labelledby="planner-item-heading"><form id="planner-item-form">
        <div class="planner-dialog-heading"><h2 id="planner-item-heading">新建事项</h2><button type="button" class="ui-icon-button" id="planner-close-item" aria-label="关闭事项设置">×</button></div>
        <fieldset class="planner-type-choice" id="planner-item-types"><legend>事项类型</legend><label><input type="radio" name="planner-kind" value="task" checked><span><strong>待办事项</strong><small>记下要做的事，安排完成期限</small></span></label><label><input type="radio" name="planner-kind" value="reminder"><span><strong>定时提醒</strong><small>按间隔或固定时间，循环提醒</small></span></label></fieldset>
        <label class="planner-field">事项名称<input id="planner-item-title" maxlength="200" placeholder="例如：整理周报、买牛奶" required></label>
        <fieldset class="planner-category-choice"><legend>所属分类</legend><label><input type="radio" name="planner-category" value="work" checked>工作</label><label><input type="radio" name="planner-category" value="personal">个人</label></fieldset>
        <fieldset class="planner-item-fields" id="planner-reminder-fields" hidden disabled>${pickerHtml('mode','计时方式')}<label class="planner-field" id="planner-interval-field">完成后间隔（分钟）<input type="number" id="planner-interval" min="1" max="1440" value="40" required></label><label class="planner-field" id="planner-fixed-field" hidden>每天固定时间<input id="planner-fixed" placeholder="例如：10:30, 15:00, 18:00"><small>用逗号分隔，必须位于允许提醒的时段内。</small></label><label class="planner-field">处理时长（分钟）<input type="number" id="planner-process" min="0" max="180" value="0" required><small>0：点击完成后开始下一轮；大于 0：点击开始处理，倒计时结束后自动完成。</small></label><label class="planner-follow"><input type="checkbox" id="planner-use-default" checked> 沿用默认提醒时间</label><div id="planner-custom-work" hidden></div></fieldset>
        <fieldset class="planner-item-fields" id="planner-task-fields">${pickerHtml('task-status','处理状态')}<div class="planner-field" id="planner-task-completed-date-field" hidden><label for="planner-task-completed-date">实际完成日期</label><input type="date" id="planner-task-completed-date" min="2000-01-01" aria-describedby="planner-task-completed-date-note" disabled><small id="planner-task-completed-date-note">默认今天。补记以前完成的任务时，请选择实际完成的那一天。</small></div><div class="planner-task-schedule"><label class="planner-field">计划开始日期（可选）<input type="date" id="planner-task-start-date" min="2000-01-01" max="2100-12-31"></label><div class="planner-field" id="planner-date-field"><div class="planner-date-heading"><label id="planner-deadline-label" for="planner-task-date">计划结束日期（可选）</label><details class="ui-select planner-date-shortcuts" id="planner-deadline-picker"><summary class="ui-select-trigger" id="planner-deadline-trigger" aria-label="快捷设置计划结束日期" aria-describedby="planner-deadline-selected">快捷设置<span id="planner-deadline-selected" hidden></span><svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3 6 5 5 5-5" stroke="currentColor" stroke-width="1.5"/></svg></summary><div class="ui-select-menu"><div class="ui-select-options" id="planner-deadline-options" role="listbox" aria-labelledby="planner-deadline-trigger"></div></div></details></div><input type="date" id="planner-task-date" min="2000-01-01" max="2100-12-31"></div></div><p class="planner-muted planner-task-schedule-note">计划开始和结束日期可分别留空，之后也可补填。在“处理完成”状态下可单独填写实际完成日期。</p><label class="planner-field">备注<textarea id="planner-task-notes" maxlength="4000" rows="3" placeholder="补充说明、处理步骤……"></textarea></label></fieldset>
        <p id="planner-item-error" class="ui-alert" role="alert" hidden></p><div class="planner-dialog-actions"><button type="button" class="outline" id="planner-cancel-item">取消</button><button class="primary" type="submit">保存事项</button></div></form></dialog>`;
  }
  let defaultWork,customWork,modePicker,deadlinePicker,taskStatusPicker;
  if(container) {
    defaultWork=workEditor($('work-editor'),'默认时段');customWork=workEditor($('custom-work'),'独立时段');
    modePicker=select('mode',[{value:'interval',label:'完成后计时'},{value:'fixed',label:'固定时间'}],value=>{mode=value;renderMode();});
    deadlinePicker=select('deadline',[{value:'none',label:'不设结束日期'},{value:'today',label:'今天完成'},{value:'tomorrow',label:'明天完成'},{value:'week',label:'一周内完成'},{value:'date',label:'指定日期'}],value=>{
      if(value==='none')$('task-date').value='';
      else if(value!=='date') {
        const date=new Date(data.today+'T12:00:00');date.setDate(date.getDate()+({today:0,tomorrow:1,week:7}[value]));
        $('task-date').value=`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,'0')}-${String(date.getDate()).padStart(2,'0')}`;
      }
      deadline=value;renderDeadline();if(value==='date')$('task-date').focus();
    });
    $('task-date').addEventListener('input',()=>{deadline=$('task-date').value?'date':'none';renderDeadline();});
    taskStatusPicker=select('task-status',taskStatuses,value=>{taskState=value;renderTaskStatus();});
    for(const node of container.querySelectorAll('[data-category]'))node.addEventListener('click',()=>{category=node.dataset.category;filter='all';renderLists();});
    for(const node of container.querySelectorAll('[name="planner-kind"]'))node.addEventListener('change',()=>{if(!itemId&&!saving){itemKind=node.value;renderItemType();}});
    for(const name of ['current','history']) {
      const tab=$(name+'-tab');
      tab.addEventListener('click',()=>{section=name;historyKey='';renderLists();});
      tab.addEventListener('keydown',event=>{if(!['ArrowLeft','ArrowRight'].includes(event.key))return;event.preventDefault();const next=name==='current'?'history':'current';$(next+'-tab').click();$(next+'-tab').focus();});
    }
    $('view-completed').addEventListener('click',()=>openCompletionHistory(lastCompleted));
    $('history-date').addEventListener('change',()=>{historyDate=$('history-date').value||data.today;$('history-date').value=historyDate;renderLists();});
    $('history-today').addEventListener('click',()=>{historyDate=data.today;$('history-date').value=historyDate;renderLists();});
    $('settings-form').addEventListener('input',()=>{settingsDirty=true;});
    $('open-settings').addEventListener('click',()=>{
      if(!data||saving)return;
      settingsDirty=false;defaultWork.set(data.workTime);$('notifications').checked=data.notifications;$('sound').checked=data.sound;
      $('settings-error').hidden=true;$('settings-dialog').showModal();
    });
    for(const name of ['close','cancel'])$(name+'-settings').addEventListener('click',()=>{if(!saving)$('settings-dialog').close();});
    $('settings-dialog').addEventListener('cancel',event=>{if(saving)event.preventDefault();});
    $('settings-dialog').addEventListener('close',()=>{settingsDirty=false;});
    $('settings-form').addEventListener('submit',async event=>{
      event.preventDefault();if(saving)return;saving=true;
      const submit=event.target.querySelector('[type="submit"]');submit.disabled=true;$('settings-error').hidden=true;
      try {const next=await request('settings',{workTime:defaultWork.get(),notifications:$('notifications').checked,sound:$('sound').checked});settingsDirty=false;apply(next);$('settings-dialog').close();$('settings-feedback').textContent='默认配置已保存。';$('error').hidden=true;}
      catch(error){report(error,$('settings-error'));}finally{saving=false;submit.disabled=false;}
    });
    $('use-default').addEventListener('change',()=>{$('custom-work').hidden=$('use-default').checked;});
    $('add-item').addEventListener('click',()=>openItem());
    for(const name of ['close','cancel'])$(name+'-item').addEventListener('click',()=>{if(!saving)$('item-dialog').close();});
    $('item-dialog').addEventListener('cancel',event=>{if(saving)event.preventDefault();});
    $('item-dialog').addEventListener('close',()=>{modePicker.close();deadlinePicker.close();taskStatusPicker.close();});
    $('item-form').addEventListener('submit',saveItem);
    for(const node of container.querySelectorAll('[data-filter]'))node.addEventListener('click',()=>{filter=node.dataset.filter;listKey='';renderLists();});
  }
  function renderMode(){modePicker.set(mode);$('interval-field').hidden=mode!=='interval';$('interval').disabled=mode!=='interval';$('fixed-field').hidden=mode!=='fixed';$('fixed').required=mode==='fixed';}
  function renderDeadline(){deadlinePicker.set(deadline);}
  // 切回未完成后禁用实际日期，隐藏的必填或超范围值不应阻止保存。
  function renderTaskStatus(){taskStatusPicker.set(taskState);$('task-completed-date-field').hidden=taskState!=='done';$('task-completed-date').disabled=taskState!=='done';$('task-completed-date').required=taskState==='done';}
  function renderItemType() {
    const reminder=itemKind==='reminder';
    for(const node of container.querySelectorAll('[name="planner-kind"]'))node.checked=node.value===itemKind;
    // 隐藏字段仍可能参与原生表单校验，必须同时禁用；不重建表单以保留两种类型的草稿。
    $('reminder-fields').hidden=!reminder;$('reminder-fields').disabled=!reminder;
    $('task-fields').hidden=reminder;$('task-fields').disabled=reminder;
    $('item-title').maxLength=reminder?100:200;$('item-title').placeholder=reminder?'例如：喝水、闭眼休息':'例如：整理周报、买牛奶';
    $('item-error').hidden=true;modePicker.close();deadlinePicker.close();taskStatusPicker.close();renderMode();renderDeadline();renderTaskStatus();
  }
  function openItem(kind='task',item=null,preset=null) {
    if(!data||saving)return;
    itemKind=kind;itemId=item?.id||null;mode=item?.mode||'interval';deadline=item?.dueDate?'date':'none';taskState=item?.status||'pending';
    $('item-title').value=item?.title||preset?.title||'';
    const selectedCategory=item?.category||(category==='personal'?'personal':'work');
    for(const node of container.querySelectorAll('[name="planner-category"]'))node.checked=node.value===selectedCategory;
    $('interval').value=item?.intervalMinutes??40;$('process').value=item?.processMinutes??preset?.processMinutes??0;$('fixed').value=item?.fixedTimes?.join(', ')||'';
    $('use-default').checked=!item?.customWorkTime;$('custom-work').hidden=$('use-default').checked;customWork.set(item?.customWorkTime||data.workTime);
    $('task-notes').value=item?.notes||'';$('task-start-date').value=item?.startDate||'';$('task-date').value=item?.dueDate||'';
    $('task-completed-date').value=Number.isFinite(item?.completedAt)?calendarDate(item.completedAt):data.today;$('task-completed-date').max=data.today;
    // 已有事项不在待办与提醒间直接转换，避免丢失期限、完成状态或正在运行的计时。
    $('item-types').hidden=Boolean(item);$('item-types').disabled=Boolean(item);
    $('item-heading').textContent=item?(kind==='reminder'?'编辑提醒':'编辑待办'):'新建事项';
    renderItemType();$('item-dialog').showModal();
  }
  function openReminder(item=null,preset=null){openItem('reminder',item,preset);}
  function openTask(item=null){openItem('task',item);}
  async function saveItem(event) {
    event.preventDefault();if(saving)return;saving=true;
    const kind=itemKind;
    const submit=event.target.querySelector('[type="submit"]');submit.disabled=true;$('item-error').hidden=true;
    const value={id:itemId||undefined,title:$('item-title').value,category:container.querySelector('[name="planner-category"]:checked').value};
    if(kind==='reminder')Object.assign(value,{mode,intervalMinutes:Number($('interval').value),processMinutes:Number($('process').value),fixedTimes:mode==='fixed'?$('fixed').value.split(/[,，\s]+/).filter(Boolean):[],customWorkTime:$('use-default').checked?null:customWork.get(),enabled:data.reminders.find(item=>item.id===itemId)?.enabled??true});
    else Object.assign(value,{notes:$('task-notes').value,status:taskState,startDate:$('task-start-date').value||null,deadline:$('task-date').value?'date':'none',dueDate:$('task-date').value,...(taskState==='done'?{completedDate:$('task-completed-date').value}:{})});
    try {
      const next=await request('save-'+kind,value);
      // 新记录应立即可见，避免被当前分类或已完成筛选藏起来。
      if(category!=='all'&&category!==value.category)category=value.category;
      lastCompleted=null;section='current';
      if(kind==='task') {
        const saved=itemId?next.tasks.find(item=>item.id===itemId):next.tasks.at(-1);
        filter='all';
        if(saved.status==='done'){setHistoryDate(saved);section='history';historyKey='';}
      }
      apply(next);$('item-dialog').close();$('error').hidden=true;
    } catch(error){report(error,$('item-error'));}finally{saving=false;submit.disabled=false;}
  }
  function categoryBadge(item){const badge=el('span','planner-category-badge',item.category==='personal'?'个人':'工作');badge.dataset.categoryLabel=item.category;return badge;}
  function statusText(item) {
    if(!item.enabled)return '已暂停';
    const run=item.run;
    if(run?.state==='waiting')return '到时间了 · 等待处理';
    if(run?.state==='processing')return '处理中';
    return run?'下次 '+dateTime(run.dueAt):'等待安排';
  }
  function openReportDay(item){document.dispatchEvent(new CustomEvent('whale-show-report-day',{detail:{completedAt:item.completedAt}}));}
  function setHistoryDate(item){historyDate=calendarDate(item.completedAt);$('history-date').value=historyDate;}
  function rememberCompletion(item){lastCompleted=item;$('completed-message').textContent=`「${item.title}」已完成，已保存到完成历史。`;}
  function openCompletionHistory(item){if(item)setHistoryDate(item);section='history';historyKey='';renderLists();}
  async function renderHistory() {
    const key=JSON.stringify([data.revision,historyDate,category]);if(key===historyKey)return;historyKey=key;
    const serial=++historyRequest,list=$('history-list');list.replaceChildren(el('p','planner-muted','正在读取完成历史……'));$('history-count').textContent='';
    try {
      const result=await request('history',{date:historyDate,category});
      if(serial!==historyRequest||section!=='history')return;
      list.replaceChildren();$('history-count').textContent=result.items.length;
      if(!result.items.length){const empty=el('div','ui-card planner-empty');empty.append(el('h2','','这一天没有完成记录'),el('p','planner-muted','可以选择其他日期；完成任务后会自动保留记录。'));list.append(empty);}
      for(const item of result.items) {
        const card=el('article','ui-card planner-history-card'),copy=el('div','planner-task-copy'),heading=el('div','planner-item-heading');
        const status=el('span','planner-task-status','处理完成');status.dataset.status='done';
        card.dataset.historyId=item.id;heading.append(el('h3','',item.title),categoryBadge(item),status);copy.append(heading,el('span','planner-muted','实际完成于 '+dateOnly(item.completedAt)));
        if(item.startDate||item.dueDate)copy.append(el('span','planner-muted planner-task-plan',taskPlanLabel(item)));
        if(item.notes)copy.append(el('p','planner-task-notes',item.notes));
        if(!data.tasks.some(task=>task.id===item.taskId))copy.append(el('p','planner-muted','原任务已删除 · 完成记录已保留'));
        card.append(copy);
        const current=data.tasks.find(task=>task.id===item.taskId&&task.status==='done'&&task.completedAt===item.completedAt),actions=el('div','planner-row-actions');
        if(current)actions.append(button('修改完成日期',()=>{openTask(current);$('task-completed-date').focus();}));
        if(item.category==='work')actions.append(button('查看当日日报',()=>openReportDay(item)));
        if(actions.children.length)card.append(actions);
        list.append(card);
      }
    } catch(error){if(serial!==historyRequest||section!=='history')return;historyKey='';list.replaceChildren(el('p','ui-alert',error.message));}
  }
  function renderLists() {
    if(!data)return;
    $('completed-feedback').hidden=section!=='current'||!lastCompleted;
    // 主进程每秒广播，只有记录、日期或筛选变化时重建列表，避免打断焦点与操作。
    const key=JSON.stringify([data.revision,data.today,filter,category,section,historyDate]);if(key===listKey)return;listKey=key;
    for(const name of ['current','history']){const selected=section===name;$(name).hidden=!selected;$(name+'-tab').setAttribute('aria-selected',String(selected));$(name+'-tab').tabIndex=selected?0:-1;}
    for(const node of container.querySelectorAll('[data-category]'))node.setAttribute('aria-pressed',String(node.dataset.category===category));
    if(section==='history'){$('overview-summary').textContent=`共保留 ${data.historyCount} 条完成记录`;void renderHistory();return;}
    const reminders=$('reminder-list');reminders.replaceChildren();
    const matchesCategory=item=>category==='all'||item.category===category;
    const priority=item=>!item.enabled?3:item.run?.state==='waiting'?0:item.run?.state==='processing'?1:2;
    const categoryReminders=data.reminders.filter(matchesCategory).sort((a,b)=>priority(a)-priority(b)||(a.run?.dueAt??Infinity)-(b.run?.dueAt??Infinity)),categoryTasks=data.tasks.filter(matchesCategory);
    $('reminder-count').textContent=categoryReminders.length;
    const waiting=categoryReminders.filter(item=>item.enabled&&['waiting','processing'].includes(item.run?.state)).length;
    $('overview-summary').textContent=`${waiting} 项提醒待处理 · ${categoryTasks.filter(item=>item.completedAt===null).length} 项待办未完成`;
    if(!categoryReminders.length) {
      const empty=el('div','ui-card planner-empty');empty.append(el('h2','','忙起来，也记得照顾自己。'),el('p','planner-muted','喝水完成再计时，休息从你点击开始的那一刻算起。'));
      const actions=el('div','planner-row-actions');actions.append(button('添加喝水提醒',()=>openReminder(null,{title:'喝水',processMinutes:0}),'soft'),button('添加闭眼休息',()=>openReminder(null,{title:'闭眼休息',processMinutes:3}),'outline'));empty.append(actions);reminders.append(empty);
    }
    for(const item of categoryReminders) {
      const card=el('article','ui-card planner-reminder'),top=el('div','planner-card-heading'),body=el('div','planner-card-copy'),status=el('span','ui-status',statusText(item));
      status.dataset.state=item.enabled?'connected':'paused';const title=el('div','planner-item-heading');title.append(el('h3','',item.title),categoryBadge(item));body.append(title,status);top.append(body);
      const actions=el('div','planner-row-actions'),run=item.run;
      if(item.enabled&&run?.state==='waiting')actions.append(button(item.processMinutes?'开始处理':'完成',()=>act(item.processMinutes?'start':'complete',{id:item.id,token:run.token}),'primary'));
      if(item.enabled&&run?.state==='processing'){const clock=el('span','planner-clock');clock.dataset.ends=String(run.processingEndsAt);actions.append(clock);}
      actions.append(button('编辑',()=>openReminder(item)),button(item.enabled?'暂停':'启用',()=>act('toggle-reminder',{id:item.id,enabled:!item.enabled})));
      top.append(actions);card.append(top);
      const schedule=item.customWorkTime||data.workTime;
      card.append(el('p','planner-muted',`${item.mode==='interval'?`完成后间隔 ${item.intervalMinutes} 分钟`:item.fixedTimes.join('、')} · ${item.processMinutes?`处理 ${item.processMinutes} 分钟`:'点击完成'} · ${item.customWorkTime?'独立时段':'默认提醒时间'}`));
      const footer=el('div','planner-card-footer');footer.append(el('span','planner-muted',scheduleLabel(schedule)),button('删除',async()=>{if(await confirmAction({owner:container,title:'删除提醒？',message:`将删除提醒「${item.title}」。`,confirmLabel:'删除提醒',danger:true}))void act('remove-reminder',{id:item.id});},'planner-delete'));card.append(footer);reminders.append(card);
    }
    for(const node of container.querySelectorAll('[data-filter]'))node.setAttribute('aria-pressed',String(node.dataset.filter===filter));
    const selectedStatus=taskStatuses.find(status=>status.value===filter);
    const tasks=categoryTasks.filter(item=>{
      if(filter==='all')return item.status!=='done';
      if(selectedStatus)return item.status===filter;
      const planDate=item.startDate||item.dueDate;
      return item.status!=='done'&&(filter==='today'&&planDate&&planDate<=data.today||filter==='upcoming'&&planDate>data.today||filter==='none'&&!planDate);
    }).sort((a,b)=>(a.startDate||a.dueDate||'9999').localeCompare(b.startDate||b.dueDate||'9999')||b.createdAt-a.createdAt);
    $('task-count').textContent=tasks.length;
    const list=$('task-list');list.replaceChildren();
    if(!tasks.length){const empty=el('div','ui-card planner-empty');empty.append(el('h2','',selectedStatus?`没有${selectedStatus.label}的待办`:'这里暂时没有待办'),el('p','planner-muted','可分别设置计划开始、结束日期，也可先记录，之后再安排。'));list.append(empty);}
    for(const task of tasks) {
      const row=el('article','ui-card planner-task');
      const content=el('div','planner-task-copy');const title=el('div','planner-item-heading');const status=el('span','planner-task-status',taskStatuses.find(status=>status.value===task.status).label);status.dataset.status=task.status;title.append(el('h3','',task.title),categoryBadge(task),status);content.append(title);
      const overdue=task.completedAt===null&&task.dueDate&&task.dueDate<data.today;
      const due=el('span','planner-muted',task.completedAt!==null?'实际完成于 '+dateOnly(task.completedAt):(overdue?'已逾期 · ':'')+taskPlanLabel(task));if(overdue)due.classList.add('planner-overdue');content.append(due);
      if(task.completedAt!==null&&(task.startDate||task.dueDate))content.append(el('span','planner-muted planner-task-plan',taskPlanLabel(task)));
      if(task.notes)content.append(el('p','planner-task-notes',task.notes));
      const actions=el('div','planner-row-actions');
      if(task.status==='pending')actions.append(button('开始处理',()=>act('set-task-status',{id:task.id,status:'processing'}),'soft'));
      else actions.append(button(task.status==='done'?'重新处理':'处理完成',()=>act('set-task-status',{id:task.id,status:task.status==='done'?'processing':'done'}),'soft'));
      if(task.status==='done'&&task.category==='work')actions.append(button('查看当日日报',()=>openReportDay(task)));
      actions.append(button('编辑',()=>openTask(task)),button('删除',async()=>{if(await confirmAction({owner:container,title:'删除待办？',message:`将删除待办「${task.title}」。`,confirmLabel:'删除待办',danger:true}))void act('remove-task',{id:task.id});},'planner-delete'));
      row.append(content,actions);list.append(row);
    }
  }
  function apply(next) {
    data=next;lastRevision=next.revision;
    if(!historyDate){historyDate=data.today;$('history-date').value=historyDate;}
    if(!settingsDirty){defaultWork.set(data.workTime);$('notifications').checked=data.notifications;$('sound').checked=data.sound;}
    $('work-summary').textContent='默认：'+scheduleLabel(data.workTime);
    if(data.error)report(Error(data.error));
    renderLists();
  }
  async function refresh() {
    if(loading)return;loading=true;
    let succeeded=false;
    try{apply(await request('snapshot'));succeeded=true;}catch(error){report(error);}finally{loading=false;}
    // IPC 请求期间可能收到更新版本；补拉一次最新快照，避免并发广播留下旧列表。
    if(succeeded&&lastRevision<requestedRevision)void refresh();
  }
  function render(summary) {
    renderPet(summary);
    if(!container||!summary)return;
    requestedRevision=summary.revision;
    if(!data||lastRevision!==requestedRevision)void refresh();
    if(summary.error)report(Error(summary.error));
    if(data&&summary.today!==data.today){data.today=summary.today;renderLists();}
    for(const clock of container.querySelectorAll('[data-ends]'))clock.textContent='剩余 '+remaining(Number(clock.dataset.ends));
  }
  if(container)window.whale.showPlanner(()=>{showView('planner');$('view').scrollIntoView({block:'start'});});
  return {render};
}
