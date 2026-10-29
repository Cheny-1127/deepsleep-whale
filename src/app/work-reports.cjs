'use strict';
const fs=require('node:fs'),path=require('node:path'),{randomUUID,createHash}=require('node:crypto');
const {text,dateKey,requireDate,addDays,weekRange,defaultSettings,settingsInput,entryInput,workGroupsInput,workMatchTitlesInput,dismissedMatchesInput,active,weekContent,dailyContent}=require('../reports/model.cjs');
const {archiveReport}=require('../reports/archive.cjs');
const {readReportEnvironment}=require('../reports/environment.cjs');
const {workSummary,eventTime}=require('../reports/work-summary.cjs');
const {needsMrRefresh}=require('../reports/work-lifecycle.cjs');
const {authorFilter,isMergeCommit}=require('../reports/commit-authorship.cjs');
const {workMatches}=require('../reports/work-matches.cjs');
const {collectGit}=require('../reports/git.cjs');
const {collectJenkins}=require('../reports/jenkins.cjs');
const {gitlabUrl,createGitlabClient,collectGitlab}=require('../reports/gitlab.cjs');
const clone=value=>structuredClone(value),fingerprint=value=>createHash('sha256').update(value).digest('hex');

function createWorkReports({dataDir,now=()=>Date.now(),getTasks=()=>[],readEnvironment=readReportEnvironment,gitCollector=collectGit,jenkinsCollector=collectJenkins,gitlabCollector=collectGitlab,gitlabStore,
  onChange=()=>{},clock={setTimeout,clearTimeout},fetchImpl=fetch,gitlabFetchImpl=fetchImpl}={}) {
  const file=path.join(dataDir,'work-reports.json');let initial={},error='',writeError='',closed=false,enabled=true,started=false,timer,flight=null,collectingDate=null,controller,generation=0;
  try{initial=readEnvironment();}catch{error='工作报告环境配置无法读取，请检查项目 .env';}
  let state={version:1,revision:0,settings:defaultSettings(initial.archiveDir||''),entries:[],workGroups:[],workMatchTitles:[],dismissedMatches:[],weeks:{},sources:[],archives:{},dirtyDates:[]};
  let corrupt=false;
  let gitlabConnecting=false;const gitlabRequests=new Set(),preparations=new Map();
  try{
    if(fs.statSync(file).size>32*1024*1024)throw Error();
    const saved=JSON.parse(fs.readFileSync(file,'utf8'));
    if(saved.version!==1||!Array.isArray(saved.entries)||saved.entries.length>20000||!saved.weeks||typeof saved.weeks!=='object'||Array.isArray(saved.weeks)||!Array.isArray(saved.sources)||!saved.archives||typeof saved.archives!=='object'||!Array.isArray(saved.dirtyDates))throw Error();
    if(!Number.isSafeInteger(saved.revision)||saved.revision<0||Array.isArray(saved.archives)||saved.sources.some(source=>!source||typeof source.key!=='string'||typeof source.project!=='string'||typeof source.error!=='string'||!Number.isFinite(source.checkedAt)))throw Error();
    saved.settings=settingsInput(saved.settings);saved.workGroups=workGroupsInput(saved.workGroups);saved.workMatchTitles=workMatchTitlesInput(saved.workMatchTitles);saved.dismissedMatches=dismissedMatchesInput(saved.dismissedMatches);const ids=new Set(),keys=new Set();
    saved.entries=saved.entries.map(entry=>{
      if(typeof entry.id!=='string'||!entry.id||ids.has(entry.id)||typeof entry.sourceKey!=='string'||!entry.sourceKey||keys.has(entry.sourceKey)||!['manual','planner','git','gitlab','jenkins'].includes(entry.source))throw Error();
      ids.add(entry.id);keys.add(entry.sourceKey);
      return {...entryInput(entry),id:entry.id,source:entry.source,sourceKey:entry.sourceKey,sourceMeta:entry.sourceMeta&&typeof entry.sourceMeta==='object'?entry.sourceMeta:{},
        createdAt:entry.createdAt,updatedAt:entry.updatedAt,edited:entry.edited===true,removed:entry.removed===true,sourceActive:entry.sourceActive!==false};
    });
    for(const [date,week] of Object.entries(saved.weeks)){requireDate(date);if(weekRange(date).start!==date||typeof week.content!=='string'||week.content.length>200000)throw Error();}
    saved.dirtyDates.forEach(requireDate);state={...state,...saved};
  }catch(failure){if(failure.code!=='ENOENT'){corrupt=true;error='工作报告数据无法读取，已保留原文件并停止写入，请恢复备份后重启。';}}
  function save(next){
    if(corrupt)throw Error(error);if(closed)throw Error('工作报告已退出');
    if(next.entries.length>20000)throw Error('工作记录已达 20000 条，请先归档并整理历史记录');
    next.revision=state.revision+1;
    const serialized=JSON.stringify(next);
    if(Buffer.byteLength(serialized)>32*1024*1024)throw Error('工作报告数据超过 32 MiB，未保存本次修改');
    try{fs.writeFileSync(file+'.tmp',serialized,{mode:0o600});fs.renameSync(file+'.tmp',file);}
    catch{writeError='工作报告保存失败，已保留上次有效记录，请检查磁盘后重试。';throw Error(writeError);}
    state=next;writeError='';onChange();
  }
  function dirty(next,...dates){next.dirtyDates=[...new Set([...next.dirtyDates,...dates.filter(Boolean)])];}
  function dayWork(date,next=state){return workSummary(next.entries.filter(entry=>entry.date===date),next.workGroups,{context:next.entries});}
  function rememberSeparateWorks(next,date,members,id){
    const restored=dayWork(date,next).items.filter(item=>item.memberKeys.some(key=>members.includes(key)));
    if(restored.length<2)return;
    const decision={date,id:fingerprint('unmerge:'+date+':'+id),members:restored.map(item=>item.memberKeys)};
    next.dismissedMatches=dismissedMatchesInput([...next.dismissedMatches.filter(item=>item.id!==decision.id),decision]);
  }
  function summary(){return {revision:state.revision,busy:Boolean(flight||preparations.size),error:writeError||error};}
  function gitlabStatus(){try{const connection=gitlabStore?.load();return {connected:Boolean(connection),url:connection?.url||'',username:connection?.username||'',authors:connection?.authors||'',error:''};}catch(failure){return {connected:false,error:failure.message};}}
  async function gitlabRequest(work){
    const requestController=new AbortController(),epoch=generation;gitlabRequests.add(requestController);
    try{const result=await work(requestController.signal);if(closed||!enabled||epoch!==generation)throw Error('GitLab 操作已取消');return result;}
    finally{gitlabRequests.delete(requestController);}
  }
  function snapshot({date=dateKey(now())}={}){
    requireDate(date);
    const entries=state.entries.filter(e=>e.date===date),work=dayWork(date),dismissed=state.dismissedMatches.filter(item=>item.date===date);
    const matches=workMatches(work.items,entries,dismissed),titles=new Map(state.workMatchTitles.filter(item=>item.date===date).map(item=>[item.id,item.title]));
    return {...summary(),date,gitlab:gitlabStatus(),settings:clone(state.settings),entries:clone(entries.filter(e=>!e.removed).sort((a,b)=>eventTime(a)-eventTime(b)||a.sourceKey.localeCompare(b.sourceKey))),work,workMatches:{...matches,items:matches.items.map(item=>titles.has(item.id)?{...item,title:titles.get(item.id)}:item),dismissedCount:dismissed.length},
      sources:clone(state.sources),needsMrRefresh:entries.some(needsMrRefresh),weeks:Object.keys(state.weeks).sort().reverse().slice(0,104),total:state.entries.filter(e=>!e.removed).length,
      archiveReady:Boolean(state.settings.archiveDir&&fs.existsSync(state.settings.archiveDir)),templateTokens:['week_start','week_end','summary','releases','blockers','next_week','details','count']};
  }
  function ingest(next,items){
    for(const item of items){
      const fields=entryInput(item),old=next.entries.find(e=>e.sourceKey===item.sourceKey);
      // 同一事实只占一条记录；人工修改、排除或删除的结果不被下一次采集恢复。
      if(old){if(old.removed)continue;const metadata=item.sourceMeta?{...item.sourceMeta,...(!item.sourceMeta.featureBranch&&old.sourceMeta.featureBranch?{featureBranch:old.sourceMeta.featureBranch}:{})}:old.sourceMeta;
        const updated={...old,...(old.edited?{}:fields),included:old.included,sourceActive:item.sourceActive!==false,sourceMeta:metadata};
        if(JSON.stringify(updated)!==JSON.stringify(old)){dirty(next,old.date,updated.date);Object.assign(old,updated,{updatedAt:now()});}}
      else{next.entries.push({...fields,id:randomUUID(),source:item.source,sourceKey:item.sourceKey,sourceMeta:item.sourceMeta||{},sourceActive:item.sourceActive!==false,removed:false,edited:false,createdAt:now(),updatedAt:now()});dirty(next,fields.date);}
    }
  }
  function retireGitlabMerges(next,source,options,items){
    // 仅在成功重采集的项目和时间窗内停用旧合并噪声，保留原记录及其他日期。
    const prefix=`gitlab:${gitlabUrl(source.host)}:${source.projectId}:`,keys=new Set(items.map(item=>item.sourceKey)),matches=authorFilter(options).matches;
    const scoped=next.entries.filter(entry=>entry.source==='gitlab'&&entry.sourceKey.startsWith(prefix)&&!entry.removed&&entry.sourceActive!==false),owned=new Set();
    for(const entry of scoped)if(entry.included!==false&&entry.sourceMeta.sha&&!isMergeCommit(entry)&&matches({author_name:entry.sourceMeta.author,author_email:entry.sourceMeta.email}))for(const mr of entry.sourceMeta.mergeRequests||[])owned.add(mr.url);
    for(const entry of scoped){
      const meta=entry.sourceMeta;
      if(keys.has(entry.sourceKey)||!Number.isFinite(meta.committedAt)||meta.committedAt<options.since||meta.committedAt>options.until)continue;
      if(!isMergeCommit(entry)&&(meta.event!=='merged'||(meta.mergeRequests||[]).some(mr=>owned.has(mr.url))))continue;
      entry.sourceActive=false;entry.updatedAt=now();dirty(next,entry.date);
    }
  }
  function syncPlanner(date){
    if(closed||!enabled||!state.settings.syncPlanner||corrupt)return;
    try{
      const next=clone(state),tasks=getTasks();
      for(const task of tasks){
        const key='planner:'+task.id,old=next.entries.find(e=>e.sourceKey===key),completed=task.category!=='personal'&&Number.isFinite(task.completedAt);
        if(date&&(completed?dateKey(task.completedAt):old?.date)!==date)continue;
        if(completed){
          const completedDate=dateKey(task.completedAt);
          // 明确更正实际完成日期时，人工整理过的工作也随之换日，保留其标题、说明和排除状态。
          if(old&&!old.removed&&old.edited&&old.sourceMeta.completedAt!==task.completedAt&&old.date!==completedDate){dirty(next,old.date,completedDate);old.date=completedDate;old.updatedAt=now();}
          ingest(next,[{title:task.title,project:old?.project||'日程工作',details:task.notes,date:completedDate,status:'done',evidence:'日程备忘 · '+task.title,source:'planner',sourceKey:key,sourceMeta:{taskId:task.id,completedAt:task.completedAt}}]);
        }
        else if(old&&old.sourceActive!==false){old.sourceActive=false;old.updatedAt=now();dirty(next,old.date);}
      }
      // 删除日程并不抹掉已经发生的工作事实；明确撤销完成或改为个人分类才停用来源。
      if(JSON.stringify(next.entries)!==JSON.stringify(state.entries))save(next);
    }catch(failure){writeError=failure.message;onChange();}
  }
  function schedule(){clock.clearTimeout(timer);if(started&&!closed&&enabled){timer=clock.setTimeout(()=>void runScheduled(),state.settings.intervalMinutes*60000);timer?.unref?.();}}
  function collect(date){
    // 同日期请求可复用采集；切换日期不能借用另一日期请求的结果。
    if(flight)return !date||date===collectingDate?flight:Promise.reject(Error('正在采集其他时间范围，请等待完成后再更新当天'));if(closed||!enabled)return Promise.reject(Error('工作报告已关闭，请先开启'));if(corrupt)return Promise.reject(Error(error));
    if(preparations.size)return Promise.allSettled([...preparations.values()]).then(()=>collect(date));
    if(gitlabConnecting)return Promise.reject(Error('正在连接 GitLab，请稍后采集'));
    const currentTime=now();if(date&&date>dateKey(currentTime))return Promise.reject(Error('未来日期尚无采集数据，请选择今天或之前的日期'));
    const settings=clone(state.settings),epoch=generation;controller=new AbortController();const signal=controller.signal;
    // 手动更新按选中日的上海时间划界，自动采集才使用配置的回溯窗口。
    const until=date?Math.min(currentTime,Date.parse(date+'T23:59:59.999+08:00')):currentTime,since=date?Date.parse(date+'T00:00:00+08:00'):until-settings.lookbackDays*86400000;
    collectingDate=date||null;
    flight=Promise.resolve().then(async()=>{
      syncPlanner(date);const results=[];let environment;
      try{environment=readEnvironment();error='';}catch{environment={};error='工作报告环境配置无法读取，请检查项目 .env';}
      for(const [kind,sources,collector] of [['git',settings.repositories,gitCollector],['gitlab',settings.gitlabProjects,gitlabCollector],['jenkins',settings.jenkinsJobs,jenkinsCollector]])for(const source of sources){
        if(signal.aborted||closed||epoch!==generation)return;
        const key=kind+':'+(source.path||source.job||source.host+':'+source.projectId);
        try{const options={since,until,signal,environment,fetchImpl};if(kind==='jenkins'){options.connection=gitlabStore?.load();options.gitlabProjects=settings.gitlabProjects;options.gitlabFetchImpl=gitlabFetchImpl;}if(kind==='gitlab'||kind==='jenkins'){options.authors=settings.gitlabAuthors;options.authorMode=settings.gitlabAuthorMode;options.authorNames=settings.gitlabAuthorNames;}if(kind==='gitlab'){options.connection=gitlabStore?.load();options.trackedEntries=clone(state.entries.filter(entry=>!date||!Number.isFinite(entry.sourceMeta.committedAt)||entry.sourceMeta.committedAt<=until));options.fetchImpl=gitlabFetchImpl;}
          let entries=await collector(source,options);
          if(signal.aborted||closed||epoch!==generation)return;
          if(!Array.isArray(entries)||entries.length>2000)throw Error('采集返回的记录过多，请缩小回溯范围');
          // GitLab 可返回用于跟踪 MR 的历史提交；手动更新只落盘选中日期的来源。
          if(date)entries=entries.filter(entry=>entry.date===date);
          // 采集期间允许编辑已有工作；每次落盘都合并最新状态，不使用过期快照覆盖编辑。
          const next=clone(state);
          if(kind==='jenkins'){
            const keys=new Set(entries.map(item=>item.sourceKey)),jobPath='/'+source.job.split('/').map(name=>'job/'+encodeURIComponent(name)).join('/')+'/';
            for(const old of next.entries){
              if(old.source!=='jenkins'||old.removed||old.sourceActive===false||keys.has(old.sourceKey)||old.sourceMeta.completedAt<since||old.sourceMeta.completedAt>until||!Number.isFinite(old.sourceMeta.completedAt))continue;
              let matches=false;try{const base=new URL(environment.jenkinsUrl),jobUrl=base.href.replace(/\/+$/,'')+jobPath;matches=old.sourceKey===`jenkins:${jobUrl}:${old.sourceMeta.buildNumber}`;}catch{}
              if(matches){old.sourceActive=false;old.updatedAt=now();dirty(next,old.date);}
            }
          }
          ingest(next,entries);if(kind==='gitlab')retireGitlabMerges(next,source,options,entries);save(next);results.push({key,project:source.project,date:date||'',since,until,checkedAt:now(),count:entries.length,error:'',warning:entries.some(e=>e.source==='jenkins'&&e.sourceMeta.rangeVerified===false)?'部分发布缺少前次版本，仅展示目标版本关联 MR，完整范围待核对':''});
        }catch(failure){if(signal.aborted||closed||epoch!==generation)return;results.push({key,project:source.project,date:date||'',since,until,checkedAt:now(),count:0,error:failure.reportSafe?failure.message:'采集失败，请检查来源配置、权限或回溯范围后重试。'});}
      }
      if(!signal.aborted&&!closed&&epoch===generation){const next=clone(state);next.sources=results;save(next);}
    }).finally(()=>{flight=null;collectingDate=null;controller=null;onChange();}).then(()=>snapshot(date?{date}:{}));onChange();return flight;
  }
  function prepareDay(date){
    if(preparations.has(date))return preparations.get(date);
    if(flight)return flight.then(()=>prepareDay(date));
    const legacy=state.entries.filter(e=>e.date===date&&needsMrRefresh(e));
    if(!legacy.length)return Promise.resolve(snapshot({date}));
    const fail=message=>Object.assign(Error(message),{reportSafe:true});
    if(legacy.length>200)return Promise.reject(fail('当天待关联的历史提交超过 200 条，请分批核对'));
    if(gitlabConnecting)return Promise.reject(fail('正在连接 GitLab，请稍后重试关联'));
    const settings=clone(state.settings),epoch=generation;
    const pending=Promise.resolve().then(()=>gitlabRequest(async signal=>{
      if(closed||!enabled||epoch!==generation)throw fail('历史提交关联已取消');
      const connection=gitlabStore?.load();if(!connection)throw fail('请先连接 GitLab，以核对历史提交关联');
      const groups=new Map();
      for(const entry of legacy){
        const source=settings.gitlabProjects.find(s=>s.projectId===entry.sourceMeta.projectId&&s.project===entry.project&&gitlabUrl(s.host)===gitlabUrl(connection.url));
        if(!source)throw fail('历史提交所属 GitLab 仓库未选中，请先核对项目配置');
        if(!groups.has(source.projectId))groups.set(source.projectId,{source,entries:[]});groups.get(source.projectId).entries.push(entry);
      }
      const metadata=new Map();
      for(const {source,entries} of groups.values()){
        if(signal.aborted||closed||!enabled||epoch!==generation)throw fail('历史提交关联已取消');
        const items=await gitlabCollector(source,{since:Date.parse(date+'T00:00:00+08:00'),until:Date.parse(addDays(date,1)+'T00:00:00+08:00')-1,signal,connection,authors:settings.gitlabAuthors,authorMode:settings.gitlabAuthorMode,authorNames:settings.gitlabAuthorNames,fetchImpl:gitlabFetchImpl});
        if(!Array.isArray(items)||items.length>2000)throw fail('历史提交核对返回的数据不完整');
        for(const old of entries){
          const fresh=items.find(item=>item.sourceKey===old.sourceKey&&item.sourceMeta?.sha===old.sourceMeta.sha&&item.sourceMeta.mrChecked===true);
          if(!fresh)throw fail('部分历史提交未在当前账号筛选中找到，请核对作者或仓库配置');
          metadata.set(old.id,{mergeRequests:fresh.sourceMeta.mergeRequests||[],mrChecked:true,mrLifecycleChecked:true,parentShas:fresh.sourceMeta.parentShas||[],...(fresh.sourceMeta.repositoryUrl?{repositoryUrl:fresh.sourceMeta.repositoryUrl}:{}),...(fresh.sourceMeta.featureBranch?{featureBranch:fresh.sourceMeta.featureBranch}:{}),...(fresh.sourceMeta.mrAssociation?{mrAssociation:fresh.sourceMeta.mrAssociation}:{})});
        }
      }
      if(signal.aborted||closed||!enabled||epoch!==generation)throw fail('历史提交关联已取消');
      // 只给当前仍存在的同一来源补充元数据，保留采集期间的正文、日期、纳入开关及删除操作。
      const next=clone(state);let changed=false;
      for(const original of legacy){
        const entry=next.entries.find(e=>e.id===original.id&&e.sourceKey===original.sourceKey&&!e.removed&&e.sourceMeta.sha===original.sourceMeta.sha);
        if(!entry||!needsMrRefresh(entry))continue;
        Object.assign(entry.sourceMeta,metadata.get(original.id));dirty(next,entry.date);changed=true;
      }
      if(changed)save(next);return snapshot({date});
    })).catch(failure=>{if(failure.reportSafe)throw failure;throw fail('历史 MR 关联未完成，请检查 GitLab 连接后重试');})
      .finally(()=>{preparations.delete(date);onChange();}).then(()=>snapshot({date}));
    preparations.set(date,pending);onChange();return pending;
  }
  function reportFor(date){const {start}=weekRange(date);return clone(state.weeks[start]||{start,end:addDays(start,6),content:'',edited:false});}
  function generateWeek(date,{force=false,automatic=false}={}){
    const generated=weekContent(state.entries,date,state.settings.weeklyTemplate,state.workGroups),old=state.weeks[generated.start];
    if(old?.edited&&!force){if(automatic)return clone(old);throw Error('周报已手动编辑，重新生成前请确认覆盖草稿');}
    if(generated.content.length>200000)throw Error('生成的周报超过 200000 字，请精简模板或排除不需要的工作记录');
    if(old&&old.content===generated.content)return clone(old);
    const next=clone(state);next.weeks[generated.start]={...generated,edited:false,generatedAt:now(),updatedAt:now()};save(next);return reportFor(date);
  }
  function archive(kind,date){
    const settings=state.settings,weekly=kind==='weekly',range=weekly?weekRange(date):null,key=weekly?range.start:requireDate(date);
    const content=weekly?state.weeks[key]?.content:dailyContent(state.entries,key,state.workGroups);if(!content)throw Error('请先生成或保存周报');
    const relative=path.join(weekly?settings.weeklyDir:settings.dailyDir,key+'.md');
    const archiveKey=fingerprint(JSON.stringify([settings.archiveDir,relative]));
    const result=archiveReport({root:settings.archiveDir,relative,id:`${weekly?'weekly':'daily'}:${key}`,content,previousHash:state.archives[archiveKey]?.hash});
    const next=clone(state);next.archives[archiveKey]={hash:result.hash,at:now()};if(!weekly)next.dirtyDates=next.dirtyDates.filter(day=>day!==key);save(next);return {path:result.path};
  }
  let scheduled=null;
  function runScheduled(){
    if(scheduled)return scheduled;if(closed||!enabled)return Promise.resolve();
    const epoch=generation;
    scheduled=Promise.resolve().then(async()=>{
      if(closed||!enabled||epoch!==generation)return;
      if(state.settings.autoCollect)await collect();else syncPlanner();
      if(closed||!enabled||epoch!==generation)return;
      const lastWeek=weekRange(addDays(dateKey(now()),-7)).start;
      // 撤销最后一条工作后也要更新已有自动周报，避免旧成果残留；人工草稿仍受保护。
      if(state.settings.autoWeekly&&(state.weeks[lastWeek]||state.entries.some(e=>active(e)&&e.date>=lastWeek&&e.date<=addDays(lastWeek,6))))generateWeek(lastWeek,{automatic:true});
      if(state.settings.autoArchive){
        for(const date of [...state.dirtyDates].slice(0,30)){if(closed||!enabled)return;archive('daily',date);}
        if(state.settings.autoWeekly&&state.weeks[lastWeek])archive('weekly',lastWeek);
      }
    }).catch(failure=>{if(closed||!enabled||epoch!==generation)return;error=failure.reportSafe||/目录|归档|覆盖|手动修改|保存失败/.test(failure.message)?failure.message:'自动整理未完成，请检查工作报告配置后重试。';onChange();})
      .finally(()=>{scheduled=null;schedule();});return scheduled;
  }
  async function action(name,value={}){
    if(name==='snapshot')return snapshot(value);if(name==='get-week')return reportFor(requireDate(value.date));
    if(closed||!enabled)throw Error('工作报告已关闭，请先开启');if(corrupt)throw Error(error);
    if(name==='gitlab-connect'){
      if(flight||scheduled||gitlabConnecting||preparations.size)throw Error('正在采集或连接，请稍后连接 GitLab');
      if(!gitlabStore)throw Error('GitLab 安全存储尚未初始化');gitlabConnecting=true;
      try{return await gitlabRequest(async signal=>{
        const url=gitlabUrl(value.url);let token=value.token;
        if(token===undefined||(typeof token==='string'&&!token.trim())){
          const saved=gitlabStore.load();
          if(saved&&gitlabUrl(saved.url)!==url)throw Error('GitLab 实例地址已变化，请填写新地址对应的 Token');
          token=saved?.token;
        }
        const client=createGitlabClient({url,token,fetchImpl:gitlabFetchImpl,signal}),user=await client.currentUser();
        await client.groups();
        if(signal.aborted)throw Error('GitLab 操作已取消');
        gitlabStore.save({url,token,...user});return {connected:true,url,...user};
      });}finally{gitlabConnecting=false;}
    }
    if(name==='gitlab-groups'||name==='gitlab-projects')return gitlabRequest(async signal=>{
      const connection=gitlabStore?.load();if(!connection)throw Error('请先连接 GitLab');
      const client=createGitlabClient({...connection,fetchImpl:gitlabFetchImpl,signal});return name==='gitlab-groups'?client.groups(value):client.projects(value);
    });
    if(name==='dismiss-work-match'||name==='accept-work-match'||name==='restore-work-matches'||name==='save-work-match-title'){
      const date=requireDate(value.date),next=clone(state);
      if(name==='restore-work-matches'){next.dismissedMatches=next.dismissedMatches.filter(item=>item.date!==date);save(next);return snapshot({date});}
      const current=snapshot({date}),match=current.workMatches.items.find(item=>item.id===value.id);
      if(!match)throw Error('关联提醒已变化，请刷新后重新确认');
      if(name==='save-work-match-title'){
        // 待确认组标题与合并关系分开保存，修改标题不代表接受关联。
        next.workMatchTitles=workMatchTitlesInput([...next.workMatchTitles.filter(item=>item.date!==date||item.id!==match.id),{date,id:match.id,title:value.title}]);save(next);return snapshot({date});
      }
      if(name==='accept-work-match')return action('merge-work',{date,keys:match.keys,title:match.title,description:match.description});
      next.dismissedMatches=dismissedMatchesInput([...next.dismissedMatches,{date,id:match.id,members:match.keys.map(key=>current.work.items.find(item=>item.key===key).memberKeys)}]);save(next);return snapshot({date});
    }
    if(name==='merge-work'){
      const date=requireDate(value.date),keys=value.keys;
      if(!Array.isArray(keys)||keys.length<2||keys.length>50||keys.some(key=>typeof key!=='string')||new Set(keys).size!==keys.length)throw Error('请至少选择两项不同工作，最多合并 50 项');
      const current=dayWork(date).items,selected=keys.map(key=>current.find(item=>item.key===key));
      if(selected.some(item=>!item))throw Error('事项已变化，请关闭窗口刷新后重新选择');
      if(selected.some(item=>item.status!=='done'))throw Error('工作计划或待解决事项不能直接合并为已完成工作');
      const members=[...new Set(selected.flatMap(item=>item.memberKeys))],existing=new Set(selected.map(item=>item.groupId).filter(Boolean));
      const group={id:[...existing][0]||randomUUID(),date,title:value.title,description:value.description,members};
      const next=clone(state);next.workGroups=workGroupsInput([...next.workGroups.filter(group=>!existing.has(group.id)),group]);dirty(next,date);save(next);return snapshot({date});
    }
    if(name==='save-work'||name==='unmerge-work'){
      const date=requireDate(value.date),next=clone(state);
      if(name==='unmerge-work'&&!value.id&&typeof value.key==='string'){
        const item=dayWork(date).items.find(item=>item.key===value.key);
        if(!item?.legacyLinkIds?.length)throw Error('合并事项不存在，请刷新后重试');
        for(const entry of next.entries)if(item.legacyLinkIds.includes(entry.id))entry.relatedMr='';
        rememberSeparateWorks(next,date,item.memberKeys,item.key);
        dirty(next,date);save(next);return snapshot({date});
      }
      let group=next.workGroups.find(group=>group.id===value.id&&group.date===date);
      // 未分组的自动事项也通过独立覆盖层保存修改，保留采集事实并接住后续同 MR 来源。
      if(name==='save-work'&&!value.id&&typeof value.key==='string'){
        const item=dayWork(date).items.find(item=>item.key===value.key);
        if(!item||item.groupId||item.conflictingGroups?.length)throw Error('事项已变化，请关闭窗口刷新后重新选择');
        if(item.status!=='done')throw Error('请在原始工作记录中修改计划或待解决事项');
        group={id:randomUUID(),date,title:value.title,description:value.description,members:[...item.memberKeys],editOnly:true};next.workGroups.push(group);
      }
      if(!group)throw Error('合并事项不存在，请刷新后重试');
      if(name==='unmerge-work'){
        next.workGroups=next.workGroups.filter(item=>item.id!==group.id);
        rememberSeparateWorks(next,date,group.members,group.id);
      }
      else{group.title=value.title;group.description=value.description;next.workGroups=workGroupsInput(next.workGroups);}
      dirty(next,date);save(next);return snapshot({date});
    }
    if(name==='save-entry'){
      const fields=entryInput(value),next=clone(state),old=value.id?next.entries.find(e=>e.id===value.id&&!e.removed):null;
      if(value.id&&!old)throw Error('工作记录不存在');
      if(old){dirty(next,old.date,fields.date);Object.assign(old,fields,{edited:true,updatedAt:now()});}
      else{const id=randomUUID();next.entries.push({...fields,id,source:'manual',sourceKey:'manual:'+id,sourceMeta:{},sourceActive:true,removed:false,edited:true,createdAt:now(),updatedAt:now()});dirty(next,fields.date);}
      save(next);return snapshot({date:fields.date});
    }
    if(name==='set-entry-included'){
      if(typeof value.included!=='boolean')throw Error('请选择是否纳入报告');
      const next=clone(state),entry=next.entries.find(e=>e.id===value.id&&!e.removed);if(!entry)throw Error('工作记录不存在');
      entry.included=value.included;entry.updatedAt=now();dirty(next,entry.date);save(next);return snapshot({date:entry.date});
    }
    if(name==='remove-work'){
      const date=requireDate(value.date),items=dayWork(date).items,item=items.find(item=>item.key===value.key);
      if(!item)throw Error('事项已变化，请刷新后重新操作');
      const ids=new Set(item.entryIds);
      if(items.some(other=>other.key!==item.key&&other.entryIds.some(id=>ids.has(id))))throw Error('这项工作与其他工作共用来源，请先在来源记录中核对');
      const next=clone(state);for(const entry of next.entries)if(ids.has(entry.id))entry.removed=true;
      dirty(next,date);save(next);return snapshot({date});
    }
    if(name==='remove-entry'){
      const next=clone(state),entry=next.entries.find(e=>e.id===value.id);if(!entry)throw Error('工作记录不存在');entry.removed=true;dirty(next,entry.date);save(next);return snapshot({date:entry.date});
    }
    if(name==='settings'){
      if(flight||scheduled||gitlabConnecting||preparations.size)throw Error('正在采集、连接或归档，请稍后保存配置');
      const next=clone(state);next.settings=settingsInput(value,state.settings);save(next);error='';syncPlanner();schedule();return snapshot();
    }
    if(name==='collect')return collect(requireDate(value.date??dateKey(now())));
    if(name==='prepare-day')return prepareDay(requireDate(value.date));
    if(name==='sync-planner'){syncPlanner();return snapshot();}
    if(name==='preview-day')return {date:requireDate(value.date),content:dailyContent(state.entries,value.date,state.workGroups)};
    if(name==='generate-week')return generateWeek(requireDate(value.date),{force:value.force===true});
    if(name==='save-week'){
      const {start,end}=weekRange(requireDate(value.date));if(typeof value.content!=='string'||!value.content.trim()||value.content.length>200000)throw Error('周报内容需为 1–200000 字');
      const next=clone(state);next.weeks[start]={start,end,content:value.content,edited:true,updatedAt:now()};save(next);return reportFor(start);
    }
    if(name==='archive-day'||name==='archive-week')return archive(name==='archive-week'?'weekly':'daily',requireDate(value.date));
    throw Error('不支持的工作报告操作');
  }
  return {action,snapshot,summary,syncPlanner,runScheduled,start(){started=true;void runScheduled();},setModuleEnabled(value){enabled=value;generation++;if(!value){clock.clearTimeout(timer);controller?.abort();for(const request of gitlabRequests)request.abort();}else if(started)void runScheduled();},close(){closed=true;generation++;clock.clearTimeout(timer);controller?.abort();for(const request of gitlabRequests)request.abort();}};
}
module.exports={createWorkReports};
