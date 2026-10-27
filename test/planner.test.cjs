'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createPlanner,DEFAULT_WORK_TIME}=require('../src/app/planner.cjs');
const at=text=>+new Date(text); // 使用本地日历，与应用的本机工作时段一致。
function fixture(t,time='2026-10-26T10:00:00') {
  const dataDir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-planner-')),notices=[],finished=[];
  let current=at(time);
  const create=()=>createPlanner({dataDir,now:()=>current,onDue:item=>notices.push(item),onFinished:item=>finished.push(item)});
  let planner=create();
  t.after(()=>fs.rmSync(dataDir,{recursive:true,force:true}));
  return {dataDir,notices,finished,get p(){return planner;},time(text){current=at(text);planner.tick();},restart(){planner=create();planner.tick();},
    add(patch={}){planner.action('save-reminder',{title:'喝水',mode:'interval',intervalMinutes:2,processMinutes:0,fixedTimes:[],...patch});return planner.snapshot().reminders.at(-1);}};
}
test('工作与个人分类可保存和调整，移动分类保留处理进度及待办完成状态',t=>{
  const f=fixture(t),item=f.add({processMinutes:3});
  assert.equal(item.category,'work');
  f.time('2026-10-26T10:02:00');f.p.action('start',{id:item.id,token:f.p.summary().active[0].token});
  const processing=f.p.snapshot().reminders[0];
  f.p.action('save-reminder',{...processing,category:'personal'});
  assert.deepEqual(f.p.snapshot().reminders[0].run,processing.run);
  f.p.action('save-task',{title:'买牛奶',category:'personal',deadline:'tomorrow',notes:'下班后'});
  const task=f.p.snapshot().tasks[0];f.p.action('toggle-task',{id:task.id,completed:true});
  const completed=f.p.snapshot().tasks[0];
  f.p.action('save-task',{...completed,category:'work',deadline:'date'});
  assert.deepEqual(f.p.snapshot().tasks[0],{...completed,category:'work'});
  f.restart();assert.equal(f.p.snapshot().reminders[0].category,'personal');
  assert.deepEqual(f.p.snapshot().reminders[0].run,processing.run);
  f.time('2026-10-26T10:05:00');assert.equal(f.finished.length,1);
});
test('旧记录缺少分类时归为工作，读取时不重写文件或重置进度',t=>{
  const f=fixture(t);f.add();f.time('2026-10-26T10:02:00');
  f.p.action('save-task',{title:'原来的工作',deadline:'none'});
  const file=path.join(f.dataDir,'planner.json'),saved=JSON.parse(fs.readFileSync(file,'utf8'));
  for(const item of [...saved.reminders,...saved.tasks])delete item.category;
  const original=JSON.stringify(saved);fs.writeFileSync(file,original);f.restart();
  assert.equal(f.p.snapshot().error,'');assert.equal(fs.readFileSync(file,'utf8'),original);
  assert.deepEqual(f.p.snapshot().reminders[0],{...saved.reminders[0],category:'work'});
  assert.deepEqual(f.p.snapshot().tasks[0],{...saved.tasks[0],category:'work'});
});
test('拒绝无效分类；不带分类的旧调用编辑个人记录时保留原分类',t=>{
  const f=fixture(t),item=f.add({category:'personal'}),before=f.p.snapshot();
  assert.throws(()=>f.add({category:'other'}),/分类/);
  assert.throws(()=>f.p.action('save-task',{title:'无效',deadline:'none',category:'other'}),/分类/);
  assert.deepEqual(f.p.snapshot(),before);
  const {category,...legacy}=item;f.p.action('save-reminder',legacy);
  assert.equal(f.p.snapshot().reminders[0].category,'personal');
  f.p.action('save-task',{title:'个人待办',category:'personal',deadline:'none'});
  f.p.action('save-task',{id:f.p.snapshot().tasks[0].id,title:'改名',deadline:'none'});
  assert.equal(f.p.snapshot().tasks[0].category,'personal');
});
test('完成后才重新计时，等待期间不会生成新一轮，旧按钮不能重复完成',t=>{
  const f=fixture(t),item=f.add();f.time('2026-10-26T10:02:00');
  const run=f.p.snapshot().active[0];assert.equal(run.state,'waiting');
  f.time('2026-10-26T10:06:00');assert.equal(f.notices.length,1);
  f.p.action('complete',{id:item.id,token:run.token});
  assert.equal(f.p.snapshot().reminders[0].run.dueAt,at('2026-10-26T10:08:00'));
  assert.throws(()=>f.p.action('complete',{id:item.id,token:run.token}),/这轮/);
});
test('02 分提醒、06 分开始处理、09 分结束，再计算下一轮间隔',t=>{
  const f=fixture(t),item=f.add({processMinutes:3});f.time('2026-10-26T10:02:00');
  f.time('2026-10-26T10:06:00');f.p.action('start',{id:item.id,token:f.p.snapshot().active[0].token});
  assert.equal(f.p.snapshot().active[0].processingEndsAt,at('2026-10-26T10:09:00'));
  f.time('2026-10-26T10:08:59');assert.equal(f.p.snapshot().active[0].state,'processing');
  f.time('2026-10-26T10:09:00');assert.equal(f.p.snapshot().active.length,0);
  assert.equal(f.finished.length,1);f.restart();assert.equal(f.finished.length,1,'重启不重放处理结束提示');
  assert.equal(f.p.snapshot().reminders[0].run.dueAt,at('2026-10-26T10:11:00'));
});
test('下班及周末完全不提醒，下一工作日从开工时间重新计时',t=>{
  const f=fixture(t,'2026-10-30T18:50:00');f.add({intervalMinutes:40});
  assert.equal(f.p.snapshot().reminders[0].run.dueAt,at('2026-11-02T10:40:00'));
  for(const time of ['2026-10-30T19:30:00','2026-10-31T12:00:00','2026-11-01T12:00:00','2026-11-02T09:59:59','2026-11-02T10:39:59']){f.time(time);assert.equal(f.p.summary().active.length,0);}
  f.time('2026-11-02T10:40:00');assert.equal(f.notices.length,1);
});
test('下班收起未处理项，跨下班的处理倒计时不补发完成通知',t=>{
  for(const processMinutes of [0,3]) {
    const f=fixture(t,'2026-10-26T18:56:00'),item=f.add({processMinutes});f.time('2026-10-26T18:58:00');
    if(processMinutes)f.p.action('start',{id:item.id,token:f.p.snapshot().active[0].token});
    f.time('2026-10-26T19:00:00');assert.equal(f.p.summary().active.length,0);
    assert.equal(f.p.snapshot().reminders[0].run.dueAt,at('2026-10-27T10:02:00'));
    assert.equal(f.notices.length,1);
    assert.equal(f.finished.length,0);
  }
});
test('从周五休眠到周一，仍从周一 10 点开工计算，不推迟到唤醒时',t=>{
  const f=fixture(t,'2026-10-30T18:10:00');f.add({intervalMinutes:40});f.time('2026-10-30T18:50:00');
  assert.equal(f.p.summary().active.length,1);
  f.time('2026-11-02T10:30:00');
  assert.equal(f.p.summary().active.length,0);assert.equal(f.p.snapshot().reminders[0].run.dueAt,at('2026-11-02T10:40:00'));
  f.time('2026-11-02T10:40:00');assert.equal(f.notices.length,2);
});
test('午休分段限制、独立提醒日和时段，以及无重叠校验',t=>{
  const f=fixture(t,'2026-10-26T11:50:00');
  f.p.action('settings',{workTime:{days:[1,2,3,4,5],periods:[{start:'10:00',end:'12:00'},{start:'14:00',end:'19:00'}]},notifications:true,sound:false});
  f.add({intervalMinutes:40});assert.equal(f.p.snapshot().reminders[0].run.dueAt,at('2026-10-26T14:40:00'));
  f.time('2026-10-26T12:00:00');assert.equal(f.notices.length,0);
  const weekend=f.add({customWorkTime:{days:[0,6],periods:[{start:'09:00',end:'21:00'}]}});
  assert.equal(weekend.run.dueAt,at('2026-10-31T09:02:00'));
  assert.throws(()=>f.p.action('settings',{workTime:{days:[1],periods:[{start:'10:00',end:'12:00'},{start:'11:00',end:'14:00'}]},notifications:true,sound:false}),/重叠/);
});
test('固定时间不被处理时间推移，同一等待项不积压多个提醒',t=>{
  const f=fixture(t),item=f.add({mode:'fixed',fixedTimes:['10:02','10:05','10:10']});
  f.time('2026-10-26T10:02:00');f.time('2026-10-26T10:06:00');assert.equal(f.notices.length,1);
  f.p.action('complete',{id:item.id,token:f.p.snapshot().active[0].token});
  assert.equal(f.p.snapshot().reminders[0].run.dueAt,at('2026-10-26T10:10:00'));
  assert.throws(()=>f.add({mode:'fixed',fixedTimes:['19:00']}),/允许提醒/);
});
test('每天全天的休息跨零点不中断，处理结束后再开始下一轮',t=>{
  const f=fixture(t,'2026-10-26T23:54:00'),item=f.add({processMinutes:3,customWorkTime:{days:[0,1,2,3,4,5,6],periods:[{start:'00:00',end:'24:00'}]}});
  f.time('2026-10-26T23:56:00');f.time('2026-10-26T23:58:00');
  const token=f.p.summary().active[0].token;f.p.action('start',{id:item.id,token});
  f.time('2026-10-27T00:00:00');assert.equal(f.p.summary().active[0]?.state,'processing');assert.equal(f.p.summary().active[0]?.token,token);
  f.restart();f.time('2026-10-27T00:01:00');assert.equal(f.finished.length,1);
  assert.equal(f.p.snapshot().reminders[0].run.dueAt,at('2026-10-27T00:03:00'));
});
test('每天全天跨零点保留待处理项，长时间休眠后也不重复提醒',t=>{
  const f=fixture(t,'2026-10-26T23:55:00'),item=f.add({customWorkTime:{days:[0,1,2,3,4,5,6],periods:[{start:'00:00',end:'24:00'}]}});
  f.time('2026-10-26T23:57:00');const token=f.p.summary().active[0].token;
  f.time('2026-11-20T10:00:00');assert.equal(f.p.summary().active[0]?.token,token);assert.equal(f.notices.length,1);
  f.p.action('complete',{id:item.id,token});assert.equal(f.p.snapshot().reminders[0].run.dueAt,at('2026-11-20T10:02:00'));
});
test('所选日期全天跨相邻日期连续，遇到未选中的日期仍停止',t=>{
  const f=fixture(t,'2026-10-26T23:58:00');f.add({intervalMinutes:5,customWorkTime:{days:[1,2,3,4,5],periods:[{start:'00:00',end:'24:00'}]}});
  assert.equal(f.p.snapshot().reminders[0].run.dueAt,at('2026-10-27T00:03:00'));
  f.time('2026-10-27T00:03:00');const token=f.p.summary().active[0].token;
  f.time('2026-10-30T23:59:00');assert.equal(f.p.summary().active[0]?.token,token);
  f.time('2026-10-31T00:00:00');assert.equal(f.p.summary().active.length,0);
  assert.equal(f.p.snapshot().reminders[0].run.dueAt,at('2026-11-02T00:05:00'));
});
test('每天全天可安排跨日的固定时间及 24 小时间隔',t=>{
  const f=fixture(t,'2026-10-26T23:58:00'),customWorkTime={days:[0,1,2,3,4,5,6],periods:[{start:'00:00',end:'24:00'}]};
  const fixed=f.add({mode:'fixed',fixedTimes:['00:00','12:00'],customWorkTime});
  assert.equal(fixed.run.dueAt,at('2026-10-27T00:00:00'));
  const interval=f.add({intervalMinutes:1440,customWorkTime});assert.equal(interval.run.dueAt,at('2026-10-27T23:58:00'));
});
test('重启保留等待及处理进度，不重放通知；唤醒只补一轮有效提醒',t=>{
  const f=fixture(t),item=f.add({processMinutes:3});f.time('2026-10-26T10:02:00');f.restart();assert.equal(f.notices.length,1);
  f.time('2026-10-26T10:06:00');f.p.action('start',{id:item.id,token:f.p.summary().active[0].token});
  f.restart();assert.equal(f.p.summary().active[0].state,'processing');
  f.time('2026-10-26T11:00:00');assert.equal(f.p.summary().active[0].state,'waiting');assert.equal(f.notices.length,2);
  assert.equal(f.finished.length,0,'不同时补发过期的处理结束提示');
  f.time('2026-10-28T09:00:00');assert.equal(f.p.summary().active.length,0);assert.equal(f.notices.length,2);
});
test('暂停后停止提醒，重新开启按当前时间安排；设置错误不改变已有记录',t=>{
  const f=fixture(t),item=f.add();f.p.action('toggle-reminder',{id:item.id,enabled:false});
  f.time('2026-10-26T11:00:00');assert.equal(f.notices.length,0);
  f.p.action('toggle-reminder',{id:item.id,enabled:true});assert.equal(f.p.snapshot().reminders[0].run.dueAt,at('2026-10-26T11:02:00'));
  const before=f.p.snapshot();
  for(const patch of [{title:''},{intervalMinutes:0},{intervalMinutes:600},{processMinutes:-1},{mode:'cron'}])assert.throws(()=>f.add(patch));
  assert.deepEqual(f.p.snapshot(),before);
});
test('工作支持今天、明天、一周内、指定日期和未排期，期限不会随重启滚动',t=>{
  const f=fixture(t,'2026-10-31T23:00:00');
  for(const deadline of ['today','tomorrow','week','date','none'])f.p.action('save-task',{title:deadline,notes:'工作备注',deadline,dueDate:'2026-11-20'});
  assert.deepEqual(f.p.snapshot().tasks.map(task=>task.dueDate),['2026-10-31','2026-11-01','2026-11-07','2026-11-20',null]);
  const task=f.p.snapshot().tasks[0];f.p.action('toggle-task',{id:task.id,completed:true});f.time('2026-11-02T10:00:00');f.restart();
  assert.equal(f.p.snapshot().tasks[0].dueDate,'2026-10-31');assert.ok(f.p.snapshot().tasks[0].completedAt);
  f.p.action('toggle-task',{id:task.id,completed:false});assert.equal(f.p.snapshot().tasks[0].completedAt,null);
  assert.throws(()=>f.p.action('save-task',{title:'日期错误',deadline:'date',dueDate:'2026-02-30'}),/有效/);
});
test('待办支持三种状态，编辑和重启保留进度，重复完成不改写完成时间',t=>{
  const f=fixture(t);
  f.p.action('save-task',{title:'整理周报',deadline:'tomorrow'});
  const original=f.p.snapshot().tasks[0];assert.equal(original.status,'pending');
  f.p.action('set-task-status',{id:original.id,status:'processing'});
  f.p.action('save-task',{id:original.id,title:'整理月报',deadline:'date',dueDate:original.dueDate});
  f.restart();let task=f.p.snapshot().tasks[0];
  assert.equal(task.status,'processing');assert.equal(task.completedAt,null);assert.equal(task.dueDate,original.dueDate);
  f.p.action('set-task-status',{id:task.id,status:'done'});
  const completedAt=f.p.snapshot().tasks[0].completedAt;assert.equal(completedAt,at('2026-10-26T10:00:00'));
  f.time('2026-10-26T11:00:00');f.p.action('toggle-task',{id:task.id,completed:true});
  f.p.action('save-task',{id:task.id,title:task.title,deadline:'none',status:'done'});
  f.restart();assert.equal(f.p.snapshot().tasks[0].completedAt,completedAt);
  f.p.action('save-task',{id:task.id,title:task.title,deadline:'none',status:'processing'});
  assert.equal(f.p.snapshot().tasks[0].completedAt,null);
  f.p.action('toggle-task',{id:task.id,completed:false});assert.equal(f.p.snapshot().tasks[0].status,'pending');
});
test('旧待办按完成时间补状态且不重写文件；状态与完成时间冲突时保护原文件',t=>{
  const f=fixture(t);
  for(const title of ['未完成','已完成'])f.p.action('save-task',{title,deadline:'none'});
  f.p.action('toggle-task',{id:f.p.snapshot().tasks[1].id,completed:true});
  const file=path.join(f.dataDir,'planner.json'),saved=JSON.parse(fs.readFileSync(file,'utf8'));
  saved.tasks.forEach(item=>delete item.status);
  const original=JSON.stringify(saved);fs.writeFileSync(file,original);f.restart();
  assert.equal(f.p.snapshot().error,'');assert.deepEqual(f.p.snapshot().tasks.map(item=>item.status),['pending','done']);
  assert.equal(fs.readFileSync(file,'utf8'),original);
  saved.tasks[1].status='processing';const conflict=JSON.stringify(saved);fs.writeFileSync(file,conflict);f.restart();
  assert.match(f.p.snapshot().error,/停止写入/);assert.equal(fs.readFileSync(file,'utf8'),conflict);
});
test('无效状态和保存失败不改变待办进度，可恢复重试',t=>{
  const f=fixture(t);f.p.action('save-task',{title:'工作',deadline:'none',status:'processing'});
  const task=f.p.snapshot().tasks[0],before=f.p.snapshot();
  for(const status of ['other',null]) {
    assert.throws(()=>f.p.action('set-task-status',{id:task.id,status}),/状态/);
    assert.throws(()=>f.p.action('save-task',{id:task.id,title:task.title,deadline:'none',status}),/状态/);
  }
  assert.deepEqual(f.p.snapshot(),before);
  fs.mkdirSync(path.join(f.dataDir,'planner.json.tmp'));
  assert.throws(()=>f.p.action('set-task-status',{id:task.id,status:'done'}),/保存失败/);
  assert.deepEqual(f.p.snapshot().tasks,[task]);
  fs.rmdirSync(path.join(f.dataDir,'planner.json.tmp'));f.p.action('set-task-status',{id:task.id,status:'done'});
  assert.equal(f.p.snapshot().tasks[0].status,'done');f.restart();assert.equal(f.p.snapshot().tasks[0].status,'done');
});
test('损坏文件不覆盖；保存失败不消费本轮提醒且可恢复重试',t=>{
  const f=fixture(t),item=f.add();f.time('2026-10-26T10:02:00');const token=f.p.summary().active[0].token;
  fs.mkdirSync(path.join(f.dataDir,'planner.json.tmp'));
  assert.throws(()=>f.p.action('complete',{id:item.id,token}),/保存失败/);assert.equal(f.p.summary().active[0].token,token);
  fs.rmdirSync(path.join(f.dataDir,'planner.json.tmp'));f.p.action('complete',{id:item.id,token});assert.equal(f.p.summary().active.length,0);
  fs.writeFileSync(path.join(f.dataDir,'planner.json'),'broken');f.restart();assert.match(f.p.snapshot().error,/停止写入/);
  assert.throws(()=>f.add(),/停止写入/);assert.equal(fs.readFileSync(path.join(f.dataDir,'planner.json'),'utf8'),'broken');
});
test('完成历史按完成日期和分类查询，重复完成不新增，删除与编辑不抹去快照',t=>{
  const f=fixture(t);f.p.action('save-task',{title:'原工作',notes:'完成时的内容',deadline:'tomorrow'});
  const task=f.p.snapshot().tasks[0];f.p.action('set-task-status',{id:task.id,status:'done'});
  const original=f.p.action('history',{date:'2026-10-26'}).items;
  assert.equal(original.length,1);assert.equal(original[0].taskId,task.id);assert.equal(original[0].dueDate,'2026-10-27');
  f.p.action('toggle-task',{id:task.id,completed:true});
  f.p.action('save-task',{id:task.id,title:'修改后的工作',notes:'修改后的内容',deadline:'none',status:'done'});
  assert.deepEqual(f.p.action('history',{date:'2026-10-26'}).items,original);
  f.p.action('set-task-status',{id:task.id,status:'processing'});f.time('2026-10-27T10:00:00');
  f.p.action('set-task-status',{id:task.id,status:'done'});f.p.action('remove-task',{id:task.id});
  f.p.action('save-task',{title:'个人事项',category:'personal',deadline:'none',status:'done'});f.restart();
  assert.deepEqual(f.p.action('history',{date:'2026-10-26'}).items,original);
  assert.equal(f.p.action('history',{date:'2026-10-27',category:'work'}).items[0].title,'修改后的工作');
  assert.equal(f.p.action('history',{date:'2026-10-27',category:'personal'}).items[0].title,'个人事项');
  assert.equal(f.p.action('history',{date:'2026-10-28'}).items.length,0);
  assert.throws(()=>f.p.action('history',{date:'2026-02-30'}),/日期/);
  assert.throws(()=>f.p.action('history',{date:'2026-10-27',category:'invalid'}),/分类/);
  assert.equal(f.p.summary().completedTasks,undefined);assert.equal(f.p.snapshot().completedTasks,undefined);
  assert.equal(f.p.snapshot().historyCount,3);
});
test('历史与任务同时落盘，失败不新增；旧文件补入已完成任务且读取不重写',t=>{
  const f=fixture(t);f.p.action('save-task',{title:'旧任务',deadline:'none'});const task=f.p.snapshot().tasks[0];
  const file=path.join(f.dataDir,'planner.json');fs.mkdirSync(file+'.tmp');
  assert.throws(()=>f.p.action('toggle-task',{id:task.id,completed:true}),/保存失败/);
  assert.equal(f.p.action('history',{date:'2026-10-26'}).items.length,0);f.restart();
  assert.equal(f.p.snapshot().tasks[0].status,'pending');fs.rmdirSync(file+'.tmp');
  f.p.action('toggle-task',{id:task.id,completed:true});
  const legacy=JSON.parse(fs.readFileSync(file,'utf8'));delete legacy.completedTasks;
  const original=JSON.stringify(legacy);fs.writeFileSync(file,original);f.restart();
  const history=f.p.action('history',{date:'2026-10-26'}).items;
  assert.equal(history.length,1);assert.equal(history[0].title,'旧任务');assert.equal(fs.readFileSync(file,'utf8'),original);
  f.restart();assert.deepEqual(f.p.action('history',{date:'2026-10-26'}).items,history);
  f.p.action('remove-task',{id:task.id});f.restart();assert.deepEqual(f.p.action('history',{date:'2026-10-26'}).items,history);
  const invalid=JSON.parse(fs.readFileSync(file,'utf8'));invalid.completedTasks[0].completedAt=null;
  const corrupt=JSON.stringify(invalid);fs.writeFileSync(file,corrupt);f.restart();
  assert.match(f.p.snapshot().error,/停止写入/);assert.equal(fs.readFileSync(file,'utf8'),corrupt);
});
