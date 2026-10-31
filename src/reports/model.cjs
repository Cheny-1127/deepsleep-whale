'use strict';
const path=require('node:path');
const {workSummary,withoutMergeNotices}=require('./work-summary.cjs');
const LEGACY_DEFAULT_TEMPLATE='# 工作周报（{{week_start}} ～ {{week_end}}）\n\n## 本周工作\n{{summary}}\n\n## 发布记录\n{{releases}}\n\n## 问题与风险\n{{blockers}}\n\n## 下周计划\n{{next_week}}\n\n## 工作明细\n{{details}}\n';
const DEFAULT_TEMPLATE='# 工作周报（{{week_start}} ～ {{week_end}}）\n\n## 本周工作\n{{summary}}\n\n## 问题与风险\n{{blockers}}\n\n## 下周计划\n{{next_week}}\n';
const TOKENS=['week_start','week_end','summary','releases','blockers','next_week','details','count'];
const text=(value,max=4000)=>typeof value==='string'?value.trim().slice(0,max):'';
function dateKey(time=Date.now()) {return new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(time));}
function validDate(value){return typeof value==='string'&&/^20\d{2}-\d{2}-\d{2}$/.test(value)&&!Number.isNaN(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;}
function requireDate(value){if(!validDate(value))throw Error('请选择有效日期（2000–2099）');return value;}
function addDays(date,days){requireDate(date);const value=new Date(date+'T00:00:00Z');value.setUTCDate(value.getUTCDate()+days);return value.toISOString().slice(0,10);}
function weekRange(date){requireDate(date);const weekday=new Date(date+'T00:00:00Z').getUTCDay();const start=addDays(date,-((weekday+6)%7));return {start,end:addDays(start,6)};}
function relativeDirectory(value,fallback){const dir=text(value,200)||fallback;if(path.isAbsolute(dir)||dir.split(/[\\/]/).some(part=>!part||part==='.'||part==='..')||/[\0\r\n]/.test(dir))throw Error('日报和周报子目录须为报告目录内的相对路径');return dir;}
function gitlabUrl(value){
  try{const url=new URL(value);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||typeof value!=='string'||value.length>2000)throw Error();return url.href.replace(/\/+$/,'');}
  catch{throw Object.assign(Error('GitLab 地址须为 HTTPS 站点地址，可包含部署子路径，不能包含账号、查询参数或片段'),{reportSafe:true});}
}
function defaultSettings(archiveDir=''){return {syncPlanner:true,autoCollect:false,intervalMinutes:15,lookbackDays:14,repositories:[],gitlabProjects:[],gitlabAuthorMode:'email',gitlabAuthors:'',gitlabAuthorNames:'',jenkinsJobs:[],archiveDir,dailyDir:'日报',weeklyDir:'周报',autoArchive:false,autoWeekly:false,weeklyTemplate:DEFAULT_TEMPLATE};}
function settingsInput(value,previous=defaultSettings()) {
  const next={...previous,...value};
  for(const key of ['syncPlanner','autoCollect','autoArchive','autoWeekly'])if(typeof next[key]!=='boolean')throw Error('无效的自动处理开关');
  if(!Number.isInteger(next.intervalMinutes)||next.intervalMinutes<5||next.intervalMinutes>1440)throw Error('采集间隔须为 5–1440 分钟');
  if(!Number.isInteger(next.lookbackDays)||next.lookbackDays<1||next.lookbackDays>90)throw Error('回溯范围须为 1–90 天');
  const archiveDir=text(next.archiveDir,2000);if(archiveDir&&(!path.isAbsolute(archiveDir)||/[\0\r\n]/.test(archiveDir)))throw Error('报告目录须为绝对路径');
  const rawTemplate=text(next.weeklyTemplate,20000),template=rawTemplate===LEGACY_DEFAULT_TEMPLATE.trim()?DEFAULT_TEMPLATE.trim():rawTemplate;if(!template)throw Error('请填写周报模板');
  for(const match of template.matchAll(/\{\{([^{}]+)\}\}/g))if(!TOKENS.includes(match[1]))throw Error('周报模板含不支持的占位符：'+match[1].slice(0,50));
  if(!Array.isArray(next.repositories)||next.repositories.length>20||!Array.isArray(next.jenkinsJobs)||next.jenkinsJobs.length>20)throw Error('Git 仓库和 Jenkins 任务各最多 20 项');
  const unique=new Set();
  const repositories=next.repositories.map(item=>{
    const directory=text(item.path,2000),project=text(item.project,100),authors=text(item.authors,1000).split(/[,，\n]/).map(v=>v.trim().toLowerCase()).filter(Boolean);
    if(!path.isAbsolute(directory)||/[\0\r\n]/.test(directory)||!project||!authors.length||authors.some(v=>!v.includes('@')))throw Error('Git 来源需填写项目名、绝对路径和作者邮箱');
    if(unique.has(directory))throw Error('Git 仓库路径不能重复');unique.add(directory);
    return {path:directory,project,authors:[...new Set(authors)].join(',')};
  });
  if(!Array.isArray(next.gitlabProjects)||next.gitlabProjects.length>200)throw Error('GitLab 最多选择 200 个项目');
  unique.clear();
  const gitlabProjects=next.gitlabProjects.map(item=>{
    const host=gitlabUrl(item.host),projectId=item.projectId,project=text(item.project,100),key=host+':'+projectId;
    if(!Number.isSafeInteger(projectId)||projectId<1||!project)throw Error('GitLab 项目配置无效，请重新勾选项目');
    if(unique.has(key))throw Error('GitLab 项目不能重复');unique.add(key);return {host,projectId,project,path:text(item.path,2000)||project};
  });
  const gitlabAuthorMode=next.gitlabAuthorMode;if(!['email','name'].includes(gitlabAuthorMode))throw Error('请选择 GitLab 作者筛选方式');
  const gitlabAuthorNames=[...new Set(text(next.gitlabAuthorNames,1000).split(/[,，\n]/).map(v=>v.trim().toLowerCase()).filter(Boolean))].join(',');
  if(gitlabAuthorMode==='name'&&((gitlabProjects.length&&!gitlabAuthorNames)||/[\0\r]/.test(gitlabAuthorNames)))throw Error('请填写要采集的 GitLab 作者名，多项用逗号分隔');
  const gitlabAuthors=[...new Set(text(next.gitlabAuthors,1000).split(/[,，\n]/).map(v=>v.trim().toLowerCase()).filter(Boolean))].join(',');
  if(gitlabAuthorMode==='email'&&((gitlabProjects.length&&!gitlabAuthors)||gitlabAuthors.split(',').filter(Boolean).some(v=>!/^[^\s@]+@[^\s@]+$/.test(v))))throw Error('请填写要采集的 GitLab 作者邮箱，多项用逗号分隔');
  unique.clear();
  const jenkinsJobs=next.jenkinsJobs.map(item=>{
    const job=text(item.job,500),project=text(item.project,100),environment=text(item.environment,50),target=text(item.target,100),userIds=text(item.userIds,1000);
    if(!job||job.split('/').some(v=>!v||v==='.'||v==='..')||/[\0\r\n?#\\]/.test(job)||!project||!userIds)throw Error('Jenkins 来源需填写任务路径、项目名和发布人账号');
    if(unique.has(job))throw Error('Jenkins 任务不能重复');unique.add(job);
    const aliases=[...new Set(text(item.repositoryAliases,2000).split(/[,，\n]/).map(v=>v.trim()).filter(Boolean))];
    if(aliases.length>10||aliases.some(v=>!/^[\w.-]+(?:\/[\w.-]+)+$/.test(v)||v.split('/').some(part=>part==='.'||part==='..')))throw Error('历史仓库路径须为 group/repository，多项用逗号分隔，最多 10 项');
    return {job,project,environment,target,userIds,deploySuccess:item.deploySuccess===true,...(aliases.length?{repositoryAliases:aliases.join(',')}:{})};
  });
  return {syncPlanner:next.syncPlanner,autoCollect:next.autoCollect,intervalMinutes:next.intervalMinutes,lookbackDays:next.lookbackDays,repositories,gitlabProjects,gitlabAuthorMode,gitlabAuthors,gitlabAuthorNames,jenkinsJobs,
    archiveDir,dailyDir:relativeDirectory(next.dailyDir,'日报'),weeklyDir:relativeDirectory(next.weeklyDir,'周报'),autoArchive:next.autoArchive,autoWeekly:next.autoWeekly,weeklyTemplate:template};
}
function entryInput(value){
  const title=text(value?.title,200);if(!title)throw Error('请填写工作标题');
  if(!['done','blocked','planned'].includes(value.status))throw Error('请选择完成、阻塞或计划状态');
  const relatedMr=text(value.relatedMr,2000);
  if(relatedMr){try{const url=new URL(relatedMr);if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash||!/\/-\/merge_requests\/[1-9]\d*$/.test(url.pathname))throw Error();}catch{throw Error('请选择有效的关联 MR');}}
  return {title,project:text(value.project,100)||'未分类',details:text(value.details),date:requireDate(value.date),status:value.status,evidence:text(value.evidence,2000),included:value.included!==false,relatedMr};
}
function workGroupsInput(value=[]){
  if(!Array.isArray(value)||value.length>2000)throw Error('工作事项合并关系过多或格式无效');
  const ids=new Set(),members=new Set();let count=0;
  return value.map(group=>{
    if(!group||typeof group.id!=='string'||!/^[\w-]{1,200}$/.test(group.id)||ids.has(group.id))throw Error('工作事项标识无效或重复');ids.add(group.id);
    const date=requireDate(group.date),title=text(group.title,200),description=text(group.description,4000);
    if(!title||typeof group.title!=='string'||group.title.length>200||typeof group.description!=='string'||group.description.length>4000)throw Error('请填写有效的事项标题和说明');
    if(!Array.isArray(group.members)||group.members.length<1||group.members.length>2000||(count+=group.members.length)>20000)throw Error('工作事项合并来源数量无效');
    for(const member of group.members){
      const key=date+'|'+member;
      if(typeof member!=='string'||member.length>2400||!/^(?:source|mr):.+/.test(member)||members.has(key))throw Error('工作事项来源无效或被重复合并');members.add(key);
    }
    // 标记操作意图，不能根据剩余来源数推断；旧记录未带标记时仍按真实合并处理。
    if(group.editOnly!==undefined&&typeof group.editOnly!=='boolean')throw Error('工作事项修改标识无效');
    return {id:group.id,date,title,description,members:[...group.members],...(group.editOnly?{editOnly:true}:{})};
  });
}
function workMatchTitlesInput(value=[]){
  if(!Array.isArray(value)||value.length>5000)throw Error('事项组标题记录过多或格式无效');
  const seen=new Set();return value.map(item=>{
    if(!item||typeof item.id!=='string'||!/^[a-f0-9]{64}$/.test(item.id))throw Error('事项组标题标识无效');
    const date=requireDate(item.date),key=date+'|'+item.id,title=text(item.title,200);
    if(seen.has(key))throw Error('事项组标题记录重复');seen.add(key);
    if(!title||typeof item.title!=='string'||item.title.length>200)throw Error('请填写有效的组标题（最多 200 字）');
    return {date,id:item.id,title};
  });
}
function dismissedMatchesInput(value=[]){
  if(!Array.isArray(value)||value.length>5000)throw Error('已忽略的事项关联过多，请重新检查部分日期的已忽略项');
  const seen=new Set();let memberCount=0;return value.map(item=>{
    if(!item||typeof item.id!=='string'||!/^[a-f0-9]{64}$/.test(item.id))throw Error('已忽略的事项关联格式无效');
    const date=requireDate(item.date),key=date+'|'+item.id;if(seen.has(key))throw Error('已忽略的事项关联重复');seen.add(key);
    const result={date,id:item.id};
    if(item.members!==undefined){
      if(!Array.isArray(item.members)||item.members.length<2||item.members.length>2000)throw Error('已忽略的事项来源格式无效');
      const sources=new Set();result.members=item.members.map(part=>{
        if(!Array.isArray(part)||!part.length||part.length>2000||(memberCount+=part.length)>20000)throw Error('已忽略的事项来源过多，请重新检查部分已忽略项');
        for(const member of part){if(typeof member!=='string'||member.length>2400||!/^(?:source|mr):.+/.test(member)||sources.has(member))throw Error('已忽略的事项来源无效或重复');sources.add(member);}
        return [...part];
      });
    }
    return result;
  });
}
const active=entry=>!entry.removed&&entry.sourceActive!==false&&entry.included!==false;
const md=value=>String(value||'').replace(/[\\`*_\[\]<>#]/g,'\\$&').replace(/\r?\n/g,' / ');
function workLine(item){
  const lines=[`- **${md(item.title)}**（${md(item.badge)}）`];
  if(item.description)lines.push(...withoutMergeNotices(item.description).split('\n').filter(Boolean).map(line=>'  - '+md(line)));
  return lines.join('\n');
}
function grouped(items){return items.length?items.map(workLine).join('\n'):'暂无记录。';}
function weekContent(entries,date,template=DEFAULT_TEMPLATE,workGroups=[]){
  const {start,end}=weekRange(date),nextEnd=addDays(end,7),records=entries.filter(e=>e.date>=start&&e.date<=end),current=workSummary(records,workGroups,{context:entries,periodEnd:end}).items,daily=workSummary(records,workGroups,{context:entries}).items;
  const values={week_start:start,week_end:end,count:String(current.filter(e=>e.status==='done').length),
    summary:grouped(current.filter(e=>e.status==='done')),releases:grouped(current.filter(e=>e.releases.length)),
    blockers:grouped(current.filter(e=>e.status==='blocked')),next_week:grouped(workSummary(entries.filter(e=>e.status==='planned'&&e.date>end&&e.date<=nextEnd),workGroups).items),
    details:daily.map(item=>`${item.date}\n${workLine(item)}`).join('\n\n')||'暂无记录。'};
  return {start,end,content:template.replace(/\{\{([a-z_]+)\}\}/g,(match,key)=>values[key]??match)};
}
function dailyContent(entries,date,workGroups=[]){
  requireDate(date);const summary=workSummary(entries.filter(e=>e.date===date),workGroups,{context:entries}),items=summary.items,done=items.filter(e=>e.status==='done');
  const sections=[['今日工作',done],['问题与风险',items.filter(e=>e.status==='blocked')],['工作计划',items.filter(e=>e.status==='planned')]];
  return `# 工作日报 · ${date}\n\n今日工作 ${done.length} 项\n\n`+(sections.filter(([,items])=>items.length).map(([title,items])=>'## '+title+'\n'+grouped(items)).join('\n\n')||'暂无工作记录。')+'\n';
}
module.exports={DEFAULT_TEMPLATE,TOKENS,text,dateKey,validDate,requireDate,addDays,weekRange,defaultSettings,settingsInput,entryInput,workGroupsInput,workMatchTitlesInput,dismissedMatchesInput,gitlabUrl,active,weekContent,dailyContent};
