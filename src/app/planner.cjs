'use strict';
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const MINUTE=60000;
const DEFAULT_WORK_TIME={days:[1,2,3,4,5],periods:[{start:'10:00',end:'19:00'}]};
const clone=value=>structuredClone(value);
// 旧记录没有分类时归入工作；只在内存补默认值，不为升级单独覆盖原文件。
function categoryOf(value='work') {
  if(!['work','personal'].includes(value))throw Error('请选择工作或个人分类');
  return value;
}
const isAllDay=schedule=>schedule.periods.length===1&&schedule.periods[0].start==='00:00'&&schedule.periods[0].end==='24:00';
function dateKey(time) {
  const date=new Date(time),pad=n=>String(n).padStart(2,'0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())}`;
}
function minutes(value,end=false) {
  if(typeof value!=='string'||!/^\d{2}:\d{2}$/.test(value))throw Error('请填写有效时间');
  const [h,m]=value.split(':').map(Number);
  if(m>59||h>23&&!(end&&h===24&&m===0))throw Error('请填写有效时间');
  return h*60+m;
}
function workTime(value) {
  if(!value||!Array.isArray(value.days)||!value.days.length||value.days.length>7||new Set(value.days).size!==value.days.length||value.days.some(day=>!Number.isInteger(day)||day<0||day>6))throw Error('请至少选择一个提醒日');
  if(!Array.isArray(value.periods)||!value.periods.length||value.periods.length>6)throw Error('请设置 1–6 个允许提醒时段');
  const periods=value.periods.map(p=>{
    if(!p||minutes(p.start)>=minutes(p.end,true))throw Error('时段结束时间必须晚于开始时间，跨午夜请拆成两个时段');
    return {start:p.start,end:p.end};
  }).sort((a,b)=>a.start.localeCompare(b.start));
  for(let i=1;i<periods.length;i++)if(minutes(periods[i].start)<minutes(periods[i-1].end,true))throw Error('提醒时段不能重叠');
  return {days:[...value.days].sort((a,b)=>a-b),periods};
}
// 按本地日历构造边界，周末、月末及夏令时不使用固定 24 小时相加。
function windows(schedule,now,continuous=true) {
  const result=[],day=new Date(now);day.setHours(0,0,0,0);
  const allDay=continuous&&isAllDay(schedule);
  // 全天按连续的允许日期合并；本周一到周五是一个时段，周末仍会切断。
  if(allDay&&schedule.days.length<7&&schedule.days.includes(day.getDay()))for(let i=0;i<6;i++) {
    const previous=new Date(day);previous.setDate(previous.getDate()-1);
    if(!schedule.days.includes(previous.getDay()))break;
    day.setTime(+previous);
  }
  for(let i=0;i<(allDay?15:9);i++) {
    const date=new Date(day);date.setDate(day.getDate()+i);
    if(!schedule.days.includes(date.getDay()))continue;
    for(const period of schedule.periods) {
      const start=new Date(date),end=new Date(date),a=minutes(period.start),b=minutes(period.end,true);
      start.setHours(Math.floor(a/60),a%60,0,0);end.setHours(Math.floor(b/60),b%60,0,0);
      const last=result.at(-1);
      if(allDay&&last?.end===+start)last.end=+end;
      else result.push({start:+start,end:+end});
    }
  }
  return result.filter(window=>window.end>now);
}
function scheduleOf(reminder,state){return reminder.customWorkTime||state.workTime;}
function validateReminder(value,state) {
  const title=typeof value?.title==='string'?value.title.trim():'';
  if(!title||title.length>100)throw Error('提醒名称需为 1–100 字');
  if(!['interval','fixed'].includes(value.mode))throw Error('请选择计时方式');
  const intervalMinutes=value.intervalMinutes??40,processMinutes=value.processMinutes??0;
  if(!Number.isInteger(intervalMinutes)||intervalMinutes<1||intervalMinutes>1440)throw Error('提醒间隔需为 1–1440 分钟');
  if(!Number.isInteger(processMinutes)||processMinutes<0||processMinutes>180)throw Error('处理时长需为 0–180 分钟，0 表示点击完成');
  const customWorkTime=value.customWorkTime==null?null:workTime(value.customWorkTime);
  const schedule=customWorkTime||state.workTime;
  const fixedTimes=[...new Set(Array.isArray(value.fixedTimes)?value.fixedTimes:[])].sort();
  if(fixedTimes.length>24)throw Error('最多设置 24 个固定时间');
  fixedTimes.forEach(time=>minutes(time));
  if(value.mode==='fixed'&&(!fixedTimes.length||fixedTimes.some(time=>!schedule.periods.some(p=>minutes(time)>=minutes(p.start)&&minutes(time)<minutes(p.end,true)))))throw Error('固定时间必须位于允许提醒的时段内');
  if(value.mode==='interval'&&!schedule.periods.some(p=>minutes(p.end,true)-minutes(p.start)>intervalMinutes)&&!(isAllDay(schedule)&&schedule.days.some(day=>schedule.days.includes((day+1)%7))))throw Error('至少一个提醒时段需长于提醒间隔');
  return {title,category:categoryOf(value.category),mode:value.mode,intervalMinutes,processMinutes,fixedTimes,customWorkTime,enabled:value.enabled!==false};
}
function nextRun(reminder,state,now,anchor=now) {
  const schedule=scheduleOf(reminder,state),allowed=windows(schedule,now);
  // 间隔计时使用连续时段；固定时间仍逐日枚举，避免全天合并后漏掉后续日期。
  for(const window of reminder.mode==='fixed'?windows(schedule,now,false):allowed) {
    if(reminder.mode==='interval') {
      const dueAt=Math.max(window.start,anchor)+reminder.intervalMinutes*MINUTE;
      if(dueAt<window.end)return {state:'scheduled',dueAt,windowStart:window.start,windowEnd:window.end,token:randomUUID()};
    } else {
      for(const time of reminder.fixedTimes) {
        const date=new Date(window.start),n=minutes(time);date.setHours(Math.floor(n/60),n%60,0,0);
        if(+date>anchor&&+date>=window.start&&+date<window.end) {
          const bounds=allowed.find(w=>+date>=w.start&&+date<w.end);
          return {state:'scheduled',dueAt:+date,windowStart:bounds.start,windowEnd:bounds.end,token:randomUUID()};
        }
      }
    }
  }
  throw Error('无法安排下一次提醒，请检查允许时段');
}
function validDate(value) {
  if(typeof value!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(value))return false;
  const [y,m,d]=value.split('-').map(Number),date=new Date(y,m-1,d);
  return y>=2000&&y<=2100&&dateKey(date)===value;
}
function taskInput(value,now) {
  const title=typeof value?.title==='string'?value.title.trim():'',notes=value?.notes??'';
  if(!title||title.length>200)throw Error('待办名称需为 1–200 字');
  if(typeof notes!=='string'||notes.length>4000)throw Error('备注最多 4000 字');
  if(!['none','today','tomorrow','week','date'].includes(value.deadline))throw Error('请选择完成期限');
  let dueDate=null;
  if(value.deadline!=='none') {
    if(value.deadline==='date') {if(!validDate(value.dueDate))throw Error('请选择有效的截止日期');dueDate=value.dueDate;}
    // 相对期限只在保存时换算一次，之后读取和重启均使用固定日期。
    else {const day=new Date(now);day.setDate(day.getDate()+({today:0,tomorrow:1,week:7}[value.deadline]));dueDate=dateKey(day);}
  }
  return {title,category:categoryOf(value.category),notes,dueDate};
}
function createPlanner({dataDir,now=()=>Date.now(),onChange=()=>{},onDue=()=>{},onFinished=()=>{}}) {
  const file=path.join(dataDir,'planner.json');
  let state={version:1,workTime:clone(DEFAULT_WORK_TIME),notifications:true,sound:false,reminders:[],tasks:[]},error='',revision=0;
  try {
    const saved=JSON.parse(fs.readFileSync(file,'utf8'));
    if(saved.version!==1||!Array.isArray(saved.reminders)||saved.reminders.length>100||!Array.isArray(saved.tasks)||saved.tasks.length>500||typeof saved.notifications!=='boolean'||typeof saved.sound!=='boolean')throw Error('invalid');
    saved.workTime=workTime(saved.workTime);
    const ids=new Set();
    for(const item of [...saved.reminders,...saved.tasks]) {
      if(typeof item?.id!=='string'||!item.id||ids.has(item.id))throw Error('invalid');ids.add(item.id);
    }
    for(const item of saved.reminders) {
      Object.assign(item,validateReminder(item,saved));
      const run=item.run;
      if(run!==null&&(!run||!['scheduled','waiting','processing'].includes(run.state)||typeof run.token!=='string'||!run.token||![run.dueAt,run.windowStart,run.windowEnd].every(Number.isFinite)||run.windowStart>run.dueAt||run.dueAt>=run.windowEnd||run.state==='processing'&&!Number.isFinite(run.processingEndsAt)))throw Error('invalid');
    }
    for(const item of saved.tasks) {
      if(!item.title||typeof item.title!=='string'||item.title.length>200||typeof item.notes!=='string'||item.notes.length>4000||item.dueDate!==null&&!validDate(item.dueDate)||item.completedAt!==null&&!Number.isFinite(item.completedAt))throw Error('invalid');
      item.category=categoryOf(item.category);
    }
    state=saved;
  } catch(failure) {if(failure.code!=='ENOENT')error='日程数据无法读取，已保留原文件并停止写入，请恢复有效备份后重启。';}
  let writeError='';
  function save(next) {
    if(error)throw Error(error);
    // 先写临时文件并替换成功，再发布内存状态；落盘失败不能消费本轮 token 或进度。
    try {fs.writeFileSync(file+'.tmp',JSON.stringify(next),{mode:0o600});fs.renameSync(file+'.tmp',file);}
    catch {writeError='日程保存失败，已保留上次有效记录，请检查磁盘后重试。';throw Error(writeError);}
    state=next;writeError='';revision++;onChange();
  }
  function tick() {
    if(error)return;
    const time=now(),next=clone(state),due=[],finished=[];let changed=false;
    for(const reminder of next.reminders) {
      if(!reminder.enabled)continue;
      let run=reminder.run;
      const schedule=scheduleOf(reminder,next);
      if(run&&isAllDay(schedule)) {
        const current=windows(schedule,time).find(w=>time>=w.start&&time<w.end);
        // 全周全天没有中断，延长内部日历范围即可，不能重置本轮或重复提示。
        if(current&&(schedule.days.length===7||current.start<=run.windowEnd)&&current.end>run.windowEnd) {run.windowEnd=current.end;changed=true;}
      }
      if(!run||time>=run.windowEnd||time<run.windowStart&&run.state!=='scheduled') {
        // 跨时段休眠后仍从本时段开工时间计算，不把开工时间推迟到唤醒时。
        const anchor=run&&time>=run.windowEnd?windows(scheduleOf(reminder,next),time)[0].start-1:time;
        reminder.run=run=nextRun(reminder,next,time,anchor);changed=true;
      }
      if(run.state==='processing'&&time>=run.processingEndsAt) {
        const completed=clone(reminder);
        reminder.lastCompletedAt=run.processingEndsAt;
        reminder.run=run=nextRun(reminder,next,time,run.processingEndsAt);changed=true;
        // 唤醒时下一轮也已到期，只发到期提醒，避免同时补发过期的休息结束提示。
        if(run.dueAt>time)finished.push(completed);
      }
      if(run.state==='scheduled'&&time>=run.dueAt&&time>=run.windowStart&&time<run.windowEnd) {
        run.state='waiting';changed=true;due.push(reminder.id);
      }
    }
    // 通知只能在状态保存后发出；重启恢复 waiting/processing 时不会重放到期通知。
    if(changed){save(next);const preferences={notifications:state.notifications,sound:state.sound};for(const item of finished)onFinished(item,preferences);for(const id of due)onDue(clone(state.reminders.find(item=>item.id===id)),preferences);}
  }
  // 广播给桌宠的摘要不含待办、备注或完整设置；小屋通过受限 IPC 单独读取快照。
  function summary() {
    const time=now();
    return {revision,now:time,today:dateKey(time),notifications:state.notifications,error:error||writeError,active:error?[]:state.reminders.filter(item=>item.enabled&&item.run&&time>=item.run.windowStart&&time<item.run.windowEnd&&['waiting','processing'].includes(item.run.state)).map(({id,title,processMinutes,run})=>({id,title,processMinutes,...clone(run)}))};
  }
  function snapshot(){return {...clone(state),...summary(),today:dateKey(now())};}
  function action(name,value) {
    if(name==='snapshot')return snapshot();
    if(error)throw Error(error);
    tick();
    const time=now(),next=clone(state);
    if(name==='settings') {
      next.workTime=workTime(value?.workTime);
      if(typeof value.notifications!=='boolean'||typeof value.sound!=='boolean')throw Error('请设置通知和提示音');
      next.notifications=value.notifications;next.sound=value.sound;
      const changed=JSON.stringify(next.workTime)!==JSON.stringify(state.workTime);
      for(const item of next.reminders)if(!item.customWorkTime) {
        validateReminder(item,next);
        if(changed)item.run=item.enabled?nextRun(item,next,time):null;
      }
    } else if(name==='save-reminder') {
      const old=value?.id?next.reminders.find(item=>item.id===value.id):null;
      if(value?.id&&!old)throw Error('提醒不存在');
      if(!old&&next.reminders.length>=100)throw Error('最多保存 100 个提醒');
      const fields=validateReminder({...value,category:value?.category??old?.category},next);
      // 仅移动分类或原样保存时保留本轮；修改其他提醒设置才重新安排计时。
      const categoryOnly=old&&Object.keys(fields).every(key=>key==='category'||JSON.stringify(fields[key])===JSON.stringify(old[key]));
      const item={...fields,id:old?.id||randomUUID(),lastCompletedAt:old?.lastCompletedAt??null};
      item.run=categoryOnly?old.run:item.enabled?nextRun(item,next,time):null;
      if(old)next.reminders[next.reminders.indexOf(old)]=item;else next.reminders.push(item);
    } else if(name==='toggle-reminder'||name==='remove-reminder'||name==='start'||name==='complete') {
      const item=next.reminders.find(item=>item.id===value?.id);
      if(!item)throw Error('提醒不存在');
      if(name==='remove-reminder')next.reminders=next.reminders.filter(r=>r!==item);
      else if(name==='toggle-reminder') {
        if(typeof value.enabled!=='boolean')throw Error('无效的启用状态');
        item.enabled=value.enabled;item.run=item.enabled?nextRun(item,next,time):null;
      } else {
        // token 标识当前一轮，拒绝旧窗口按钮、重复点击和过期时段的处理动作。
        if(!item.enabled||!item.run||item.run.token!==value.token||item.run.state!=='waiting'||time<item.run.windowStart||time>=item.run.windowEnd)throw Error('这轮提醒已结束，请查看最新状态');
        if(name==='start') {
          if(!item.processMinutes)throw Error('此提醒无需处理倒计时');
          item.run.state='processing';item.run.processingEndsAt=time+item.processMinutes*MINUTE;
        } else {
          if(item.processMinutes)throw Error('请先开始处理，计时结束后自动完成');
          item.lastCompletedAt=time;item.run=nextRun(item,next,time);
        }
      }
    } else if(name==='save-task') {
      const old=value?.id?next.tasks.find(item=>item.id===value.id):null;
      if(value?.id&&!old)throw Error('待办不存在');
      if(!old&&next.tasks.length>=500)throw Error('最多保存 500 条待办，请清理已完成记录');
      const item={...taskInput({...value,category:value?.category??old?.category},time),id:old?.id||randomUUID(),createdAt:old?.createdAt??time,completedAt:old?.completedAt??null};
      if(old)next.tasks[next.tasks.indexOf(old)]=item;else next.tasks.push(item);
    } else if(name==='toggle-task'||name==='remove-task') {
      const item=next.tasks.find(item=>item.id===value?.id);if(!item)throw Error('待办不存在');
      if(name==='remove-task')next.tasks=next.tasks.filter(task=>task!==item);
      else {if(typeof value.completed!=='boolean')throw Error('无效的完成状态');item.completedAt=value.completed?time:null;}
    } else throw Error('不支持的日程操作');
    save(next);return snapshot();
  }
  return {snapshot,summary,tick,action,isAllowed(id){const item=state.reminders.find(item=>item.id===id),time=now();return Boolean(item?.enabled&&windows(scheduleOf(item,state),time).some(w=>time>=w.start&&time<w.end));}};
}
module.exports={createPlanner,DEFAULT_WORK_TIME,dateKey};
