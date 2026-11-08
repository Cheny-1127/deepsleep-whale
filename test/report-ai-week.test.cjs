'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createWorkReports}=require('../src/app/work-reports.cjs');
const {defaultSettings,settingsInput}=require('../src/reports/model.cjs');
const {DEFAULT_AI_WEEK_TEMPLATE,aiWeekContent}=require('../src/reports/ai-week.cjs');
const period={start:'2026-11-02',end:'2026-11-08'};
const output=()=>DEFAULT_AI_WEEK_TEMPLATE.replaceAll('{{week_start}}',period.start).replaceAll('{{week_end}}',period.end)
  .replace('### 功能交付','### 功能交付\n\n- 完成支付校验，补齐超时处理。')
  .replace('### 迭代完善','### 迭代完善\n\n- 退款用例仍在完善。')
  .replace('## 本周工作思考','## 本周工作思考\n\n- 可以提前梳理超时边界。')
  .replace('## 需要支持的工作事项','## 需要支持的工作事项\n\n- 待补充。')
  .replace('## 下周工作计划','## 下周工作计划\n\n- 建议继续补齐退款回归。')
  .replace('## 来源记录','## 来源记录\n\n- 2026-11-02 日报');
function fixture(t){
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'whale-ai-week-')),vault=path.join(dir,'vault');fs.mkdirSync(vault);
  const instances=[],calls=[];let configured=true,generate=async()=>output();
  const ai={snapshot:()=>({configured}),generate:async input=>{calls.push(input);return generate(input);}};
  const create=(options={})=>{const reports=createWorkReports({dataDir:dir,now:()=>Date.parse('2026-11-09T12:00:00+08:00'),readEnvironment:()=>({archiveDir:vault}),ai,...options});instances.push(reports);return reports;};
  t.after(()=>{instances.forEach(r=>r.close());fs.rmSync(dir,{recursive:true,force:true});});
  return {dir,vault,create,calls,setConfigured:value=>{configured=value;},setGenerate:value=>{generate=value;}};
}
async function base(reports){
  await reports.action('save-entry',{date:'2026-11-02',title:'完成支付校验',details:'补齐超时处理',status:'done'});
  await reports.action('save-entry',{date:'2026-11-03',title:'等待结算规则确认',status:'blocked'});
  await reports.action('save-entry',{date:'2026-11-09',title:'补齐退款回归',status:'planned'});
  await reports.action('save-entry',{date:'2026-11-04',title:'排除事项',included:false,status:'done'});
  return reports.action('generate-week',period);
}
test('explicit AI generation uses the saved base and configured template, preserving separate drafts across restart and archive',async t=>{
  const f=fixture(t),reports=f.create();await base(reports);
  await reports.action('settings',{autoWeekly:true});await reports.runScheduled();const basic=await reports.action('get-week',period);assert.equal(f.calls.length,0,'自动周报不调用 AI');
  const generated=await reports.action('generate-ai-week',period),input=JSON.parse(f.calls[0].prompt);
  assert.equal(input.baseReport,basic.content);assert.deepEqual(input.period,period);assert.deepEqual(input.dailyReports,['2026-11-02','2026-11-03']);
  assert.match(input.template,/# 2026-11-02至2026-11-08-周报/);assert.match(f.calls[0].system,/不虚构/);
  assert.equal(generated.content,basic.content);assert.equal(generated.aiStale,false);
  for(const heading of ['本周工作思考','下周工作计划'])assert.match(generated.aiDraft.content,new RegExp('## '+heading+'\\n\\n> 建议稿，待确认。'));
  const edited=await reports.action('save-week',{...period,variant:'ai',content:generated.aiDraft.content+'\n本人确认后的补充。'});
  assert.equal(edited.aiDraft.edited,true);assert.equal(edited.content,basic.content);
  await assert.rejects(reports.action('generate-ai-week',period),/手工编辑/);assert.equal(f.calls.length,1);
  const archivedBase=await reports.action('archive-week',period),archivedAi=await reports.action('archive-week',{...period,variant:'ai'});
  assert.notEqual(archivedBase.path,archivedAi.path);assert.equal(path.dirname(archivedAi.path),fs.realpathSync(path.join(f.vault,'周报','AI')));
  assert.match(fs.readFileSync(archivedAi.path,'utf8'),/本人确认后的补充/);assert.doesNotMatch(fs.readFileSync(archivedBase.path,'utf8'),/本人确认后的补充/);
  const history=await reports.action('list-weeks'),aiDraft=history.items.find(item=>item.source==='draft'&&item.variant==='ai');assert.ok(aiDraft);
  assert.equal((await reports.action('read-week',{id:aiDraft.id})).content,edited.aiDraft.content);
  assert.equal(history.items.filter(item=>item.source==='obsidian').length,2);
  reports.close();const restarted=f.create();assert.deepEqual(await restarted.action('get-week',period),edited);
  const refreshed=await restarted.action('generate-ai-week',{...period,force:true});assert.equal(refreshed.aiDraft.edited,false);assert.equal(refreshed.content,basic.content);
});
test('missing base or AI configuration fails without requests; legacy settings receive the AI template',async t=>{
  const f=fixture(t),reports=f.create();await assert.rejects(reports.action('generate-ai-week',period),/先生成/);
  await base(reports);f.setConfigured(false);await assert.rejects(reports.action('generate-ai-week',period),/AI 功能/);assert.equal(f.calls.length,0);
  reports.close();const file=path.join(f.dir,'work-reports.json'),saved=JSON.parse(fs.readFileSync(file,'utf8'));delete saved.settings.aiWeeklyTemplate;fs.writeFileSync(file,JSON.stringify(saved));
  const before=fs.readFileSync(file,'utf8'),restarted=f.create();assert.equal(restarted.snapshot().settings.aiWeeklyTemplate,DEFAULT_AI_WEEK_TEMPLATE.trim());assert.equal(fs.readFileSync(file,'utf8'),before,'只读旧配置不重写原文件');
  assert.throws(()=>settingsInput({aiWeeklyTemplate:'## 下周工作计划'}),/本周工作思考/);
  assert.throws(()=>settingsInput({aiWeeklyTemplate:DEFAULT_AI_WEEK_TEMPLATE+'{{summary}}'}),/占位符/);
  assert.ok(defaultSettings().aiWeeklyTemplate.includes('### 迭代完善'));
});
test('failed or malformed AI replies preserve both saved versions',async t=>{
  const f=fixture(t),reports=f.create();await base(reports);const original=await reports.action('generate-ai-week',period);
  for(const answer of [null,'','# 标题\n## 不匹配的栏目','```markdown\n'+output().replace('## 本周工作思考','### 本周工作思考')+'\n```',output()+'<!-- deepsleep:weekly:test -->']){
    f.setGenerate(async()=>answer);await assert.rejects(reports.action('generate-ai-week',period),/AI|模板/);assert.deepEqual(await reports.action('get-week',period),original);
  }
  f.setGenerate(async()=>output());fs.mkdirSync(path.join(f.dir,'work-reports.json.tmp'));await assert.rejects(reports.action('generate-ai-week',period),/保存失败/);assert.deepEqual(await reports.action('get-week',period),original);fs.rmdirSync(path.join(f.dir,'work-reports.json.tmp'));
  f.setGenerate(async()=>{throw Error('模型连接失败');});await assert.rejects(reports.action('generate-ai-week',period),/连接失败/);assert.deepEqual(await reports.action('get-week',period),original);
});
test('changes to the base or template mark the AI draft stale without discarding it',async t=>{
  const f=fixture(t),reports=f.create();await base(reports);const old=await reports.action('generate-ai-week',period);
  const edited=await reports.action('save-week',{...period,content:old.content+'\n补充验证结果。'});assert.equal(edited.aiStale,true);assert.deepEqual(edited.aiDraft,old.aiDraft);
  const regenerated=await reports.action('generate-ai-week',period);assert.equal(regenerated.aiStale,false);
  await reports.action('settings',{aiWeeklyTemplate:DEFAULT_AI_WEEK_TEMPLATE+'\n请保留具体结果。'});assert.equal((await reports.action('get-week',period)).aiStale,true);
  const basic=await reports.action('generate-week',{...period,force:true});assert.deepEqual(basic.aiDraft,regenerated.aiDraft);assert.equal(basic.aiStale,true);
});
test('an in-flight request cannot overwrite a changed base, template or AI draft, and duplicate requests are rejected',async t=>{
  for(const change of ['base','template','ai']){
    const f=fixture(t),reports=f.create();await base(reports);await reports.action('generate-ai-week',period);
    let resolve;f.setGenerate(()=>new Promise(done=>{resolve=done;}));const pending=reports.action('generate-ai-week',period);
    await assert.rejects(reports.action('generate-ai-week',period),/正在整理/);
    if(change==='template')await reports.action('settings',{aiWeeklyTemplate:DEFAULT_AI_WEEK_TEMPLATE+'\n新要求。'});
    else await reports.action('save-week',{...period,variant:change==='ai'?'ai':'base',content:'# 人工修改，必须保留。'});
    const saved=await reports.action('get-week',period);resolve(output());await assert.rejects(pending,/已变化/);assert.deepEqual(await reports.action('get-week',period),saved);
  }
});
test('closing or disabling reports aborts AI and never saves a late reply',async t=>{
  for(const mode of ['close','disable']){
    const f=fixture(t),reports=f.create();await base(reports);let resolve;f.setGenerate(()=>new Promise(done=>{resolve=done;}));
    const pending=reports.action('generate-ai-week',period),input=f.calls.at(-1),before=fs.readFileSync(path.join(f.dir,'work-reports.json'),'utf8');
    if(mode==='close')reports.close();else reports.setModuleEnabled(false);
    assert.equal(input.signal.aborted,true);resolve(output());await assert.rejects(pending,/取消/);assert.equal(fs.readFileSync(path.join(f.dir,'work-reports.json'),'utf8'),before);
  }
});
test('AI normalization accepts a Markdown fence and keeps review labels and HTML literal',()=>{
  const content=aiWeekContent('```markdown\n'+output()+'\n```',DEFAULT_AI_WEEK_TEMPLATE);
  assert.doesNotMatch(content,/```/);assert.equal((content.match(/> 建议稿，待确认。/g)||[]).length,2);
  assert.equal(aiWeekContent(content,DEFAULT_AI_WEEK_TEMPLATE),content,'重复归一化不添加重复提示');
});

test('weekly generation uses the shared service with either saved API protocol and never writes its key into report data',async t=>{
  const {createAiService}=require('../src/ai/service.cjs');
  for(const protocol of ['chat','responses']){
    const f=fixture(t),calls=[],connection={baseUrl:'https://ai.example.test/v1',apiKey:'fixture-ai-secret',model:'fixture-model',protocol,reasoningEffort:'high'};
    const ai=createAiService({store:{load:()=>connection},fetchImpl:async(url,options)=>{calls.push({url,options});return Response.json(protocol==='chat'?{choices:[{finish_reason:'stop',message:{role:'assistant',content:output()}}]}:{status:'completed',output:[{type:'message',role:'assistant',content:[{type:'output_text',text:output()}]}]});}});t.after(()=>ai.close());
    const reports=f.create({ai});await base(reports);const result=await reports.action('generate-ai-week',period);assert.ok(result.aiDraft.content.includes('本周工作思考'));
    assert.equal(calls.length,1);assert.equal(calls[0].url,connection.baseUrl+(protocol==='chat'?'/chat/completions':'/responses'));assert.equal(calls[0].options.headers.Authorization,'Bearer '+connection.apiKey);
    const body=JSON.parse(calls[0].options.body);assert.equal(body.model,connection.model);assert.equal(body.store,false);
    const input=JSON.parse(protocol==='chat'?body.messages[1].content:body.input);assert.match(input.baseReport,/完成支付校验/);
    assert.equal(protocol==='chat'?body.reasoning_effort:body.reasoning.effort,'high');assert.doesNotMatch(fs.readFileSync(path.join(f.dir,'work-reports.json'),'utf8'),/fixture-ai-secret/);
  }
});
test('oversized requests and invalid version selectors fail before requesting AI or changing saved reports',async t=>{
  const f=fixture(t),reports=f.create();await reports.action('save-week',{...period,content:'# '+ '工作'.repeat(60000)});
  const before=fs.readFileSync(path.join(f.dir,'work-reports.json'),'utf8');await assert.rejects(reports.action('generate-ai-week',period),/长度限制/);assert.equal(f.calls.length,0);
  for(const action of ['save-week','archive-week'])await assert.rejects(reports.action(action,{...period,variant:'other',content:'不可覆盖'}),/请选择/);
  assert.equal(fs.readFileSync(path.join(f.dir,'work-reports.json'),'utf8'),before);
  const lastHeading='# 周报\n\n## 本周工作思考\n思考内容\n\n## 下周工作计划';assert.equal((aiWeekContent(lastHeading,lastHeading).match(/> 建议稿，待确认。/g)||[]).length,2);
});
