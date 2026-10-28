import {confirmAction} from './confirm-dialog.mjs';
import {showView} from './hooks-view.mjs';
import {createReportGitlabView} from './report-gitlab-view.mjs';

export function createWorkReportsView(){
  const page=document.getElementById('reports-view'),content=document.getElementById('reports-content');if(!content)return;
  const $=id=>document.getElementById('report-'+id),el=(tag,className,text)=>{const node=document.createElement(tag);if(className)node.className=className;if(text!==undefined)node.textContent=text;return node;};
  const reportDate=(time=Date.now())=>new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(new Date(time));
  const today=()=>reportDate();
  const field=(name,label,type='text',extra='')=>`<label class="report-field">${label}<input name="${name}" type="${type}" ${extra}></label>`;
  const check=(name,label)=>`<label class="report-check"><input name="${name}" type="checkbox">${label}</label>`;
  content.innerHTML=`<div class="ui-tabs" role="tablist" aria-label="工作报告视图"><button id="report-daily-tab" role="tab" aria-selected="true" aria-controls="report-daily">每日工作</button><button id="report-weekly-tab" role="tab" aria-selected="false" aria-controls="report-weekly" tabindex="-1">周报</button></div>
    <p id="report-error" class="ui-alert" role="alert" hidden></p><p id="report-feedback" class="report-note" role="status" hidden></p>
    <section id="report-daily" role="tabpanel" aria-labelledby="report-daily-tab"><div id="report-recent-days" class="report-recent-days" role="group" aria-label="最近7天"></div><div class="report-toolbar"><label>工作日期<input id="report-date" type="date" min="2000-01-01" max="2099-12-31"></label><div class="report-actions"><button id="report-repair-day" class="outline" hidden>重试关联</button><button id="report-collect" class="outline">立即采集</button><button id="report-merge" class="outline" disabled>合并同一事项</button><button id="report-preview-day" class="outline">预览日报</button></div></div><p id="report-day-summary" class="report-note"></p><details id="report-source-status" class="report-source-status"><summary id="report-source-summary">采集状态</summary><p id="report-source-range" class="report-note"></p><div id="report-sources" class="report-note"></div></details><section id="report-matches" class="report-matches" aria-labelledby="report-matches-heading" hidden><h2 id="report-matches-heading"></h2><p id="report-matches-note" class="report-note"></p><div id="report-match-list" class="report-match-list"></div><p id="report-matches-limit" class="report-note" hidden>本次检查或展示的关联数量已达上限，仍可能有未发现的重复事项，可继续手动核对。</p><div id="report-matches-actions" class="report-actions"></div></section><div id="report-list" class="report-list"></div></section>
    <section id="report-weekly" role="tabpanel" aria-labelledby="report-weekly-tab" hidden><div class="report-toolbar"><label>选择周内任一天<input id="report-week-date" type="date" min="2000-01-01" max="2099-12-31"></label><div class="report-actions"><button id="report-generate" class="primary">生成周报</button><button id="report-save-week" class="outline">保存草稿</button><button id="report-archive-week" class="outline">归档到 Obsidian</button></div></div><div class="ui-card report-week-card"><p id="report-week-status" class="report-note">按配置模板汇总工作记录，可以在归档前编辑。</p><textarea id="report-week-content" class="report-preview" aria-label="周报内容" placeholder="选择日期后点击生成周报。生成内容以已记录事实为依据，可在这里补充总结。"></textarea></div></section>
    <dialog id="report-entry-dialog" class="ui-dialog" aria-labelledby="report-entry-heading"><form id="report-entry-form"><h2 id="report-entry-heading">记录工作</h2><div class="report-grid">${field('date','工作日期','date','required')}${field('project','所属项目','text','maxlength="100" placeholder="例如：用户中心"')}<label class="report-field report-wide">工作标题<input name="title" maxlength="200" required placeholder="例如：完成支付超时问题修复"></label><label class="report-field">状态<select name="status"><option value="done">已完成</option><option value="blocked">问题 / 阻塞</option><option value="planned">工作计划</option></select></label>${check('included','纳入日报与周报')}<label class="report-field report-wide">工作内容与成果<textarea name="details" maxlength="4000" rows="5" placeholder="粘贴处理结果、验证结论或需要跟进的问题。"></textarea></label><label class="report-field report-wide">来源 / 证据<input name="evidence" maxlength="2000" placeholder="提交编号、发版链接或相关说明"></label></div><p id="report-entry-error" class="ui-alert" role="alert" hidden></p><div class="report-dialog-actions"><button type="button" class="outline" data-close="entry-dialog">取消</button><button class="primary" type="submit">保存工作</button></div></form></dialog>
    <dialog id="report-work-dialog" class="ui-dialog" aria-labelledby="report-work-heading"><form id="report-work-form"><h2 id="report-work-heading">合并为同一事项</h2>
      <p class="report-note" id="report-work-hint">合并后日报只显示一项工作，原始来源保留，可随时解除合并。</p>
      <div class="report-grid"><label class="report-field report-wide" id="report-work-origin-field">选择第一项工作<select name="origin" required></select></label><label class="report-field report-wide" id="report-work-target-field">与哪件工作合并<select name="target" required></select></label>
      <label class="report-field report-wide" id="report-work-copy-field">采用哪条事项的内容<select name="copy"></select></label>
      <label class="report-field report-wide">事项标题<input name="title" required maxlength="200"></label>
      <label class="report-field report-wide">工作内容与结果<textarea name="description" maxlength="4000" rows="5"></textarea></label></div>
      <p id="report-work-error" class="ui-alert" role="alert" hidden></p><div class="report-dialog-actions"><button type="button" class="outline" data-close="work-dialog">取消</button><button type="submit" class="primary">确认合并</button></div>
    </form></dialog>
    <dialog id="report-preview-dialog" class="ui-dialog" aria-labelledby="report-preview-heading"><h2 id="report-preview-heading">日报预览</h2><p class="report-note">按工作事项整理当天内容，归档只更新本应用管理的内容块。</p><textarea id="report-day-content" class="report-preview" readonly aria-label="日报内容"></textarea><p id="report-preview-error" class="ui-alert" role="alert" hidden></p><div class="report-dialog-actions"><button class="outline" data-close="preview-dialog">关闭</button><button id="report-archive-day" class="primary">归档到 Obsidian</button></div></dialog>
    <dialog id="report-settings-dialog" class="ui-dialog" aria-labelledby="report-settings-heading"><form id="report-settings-form" novalidate>
      <div class="report-settings-header"><h2 id="report-settings-heading">工作报告配置</h2><div class="ui-tabs" role="tablist" aria-label="报告配置分类">${[['sources','数据来源'],['automation','自动整理'],['archive','归档'],['template','周报模板']].map(([id,label],index)=>`<button type="button" id="report-settings-tab-${id}" role="tab" aria-selected="${index===0}" aria-controls="report-settings-panel-${id}" tabindex="${index===0?0:-1}">${label}</button>`).join('')}</div></div>
      <div id="report-settings-body" class="report-settings-body">
        <section id="report-settings-panel-sources" role="tabpanel" aria-labelledby="report-settings-tab-sources">
          <section id="report-gitlab-settings" class="report-settings-section"></section>
          <details id="report-jenkins-source" class="report-settings-section report-settings-extra"><summary>Jenkins 来源 <span class="report-note">生产发布与 MR</span></summary><div class="report-toolbar"><p class="report-note">按发布阶段完成时间记录指定账号的生产发布，读取实际版本涉及的 MR 与提交。项目名需对应已选 GitLab 仓库。</p><button type="button" id="report-add-job" class="outline">＋ 添加任务</button></div><div id="report-jenkins-jobs"></div></details>
        </section>
        <section id="report-settings-panel-automation" role="tabpanel" aria-labelledby="report-settings-tab-automation" hidden><h3>记录与自动整理</h3><div class="report-grid">${check('syncPlanner','归入日程备忘中已完成的工作待办')}${check('autoCollect','自动采集已配置的数据来源')}${field('intervalMinutes','自动整理间隔（分钟）','number','min="5" max="1440" required')}${field('lookbackDays','每次采集回溯天数','number','min="1" max="90" required')}</div><p class="report-note">个人待办和周期性提醒不进入报告。休眠或退出时暂停采集，下次启动按回溯范围补查。</p></section>
        <section id="report-settings-panel-archive" role="tabpanel" aria-labelledby="report-settings-tab-archive" hidden><h3>Obsidian 归档</h3><label class="report-field">报告目录（笔记库内已有目录）<span class="report-inline-input"><input name="archiveDir" placeholder="/workspace/note/Dd work report"><button type="button" id="report-pick-archive" class="outline">选择</button></span></label><div class="report-grid">${field('dailyDir','日报子目录','text','required')}${field('weeklyDir','周报子目录','text','required')}${check('autoArchive','自动归档有变化的日报')}${check('autoWeekly','自动生成上一完整周的周报')}</div><p class="report-note">同时开启两项自动设置时，也会归档上一周周报。手工编辑的草稿不会自动重新生成；笔记中的报告内容被修改时会停止覆盖并提示。</p></section>
        <section id="report-settings-panel-template" role="tabpanel" aria-labelledby="report-settings-tab-template" hidden><h3>周报模板</h3><label class="report-field">Markdown 格式<textarea name="weeklyTemplate" rows="12" maxlength="20000" required></textarea></label><p class="report-note">占位符：{{week_start}} 周一 · {{week_end}} 周日 · {{summary}} 项目汇总 · {{releases}} 发布记录 · {{blockers}} 问题与风险 · {{next_week}} 下周计划 · {{details}} 工作明细 · {{count}} 工作事项数。</p></section>
      </div>
      <div class="report-settings-footer"><p id="report-settings-error" class="ui-alert" role="alert" hidden></p><div class="report-settings-footer-row"><p id="report-settings-state" class="report-note" role="status"></p><div class="report-actions"><button type="button" class="outline" data-close="settings-dialog">取消</button><button class="primary" type="submit">确定并保存</button></div></div></div>
    </form></dialog>`;
  $('date').value=$('week-date').value=today();let data,editing=null,workDialog=null,week=null,weekDate=today(),weekDirty=false,loading=false,working=false;
  async function request(name,value){const response=await window.whale.reports(name,value);if(response?.error)throw Error(response.error);return response.value;}
  function message(text,error=false,target){const node=target||$(error?'error':'feedback');node.textContent=text;node.hidden=!text;}
  async function run(button,work,target){if(working)return;working=true;button.disabled=true;message('',true,target);try{await work();}catch(error){message(error.message,true,target);}finally{working=false;button.disabled=false;$('collect').disabled=Boolean(data?.busy);}}
  let settingsBaseline='';
  const settingsTabs=['sources','automation','archive','template'];
  function showSettingsTab(name){for(const tab of settingsTabs){const active=tab===name;$('settings-panel-'+tab).hidden=!active;$('settings-tab-'+tab).setAttribute('aria-selected',String(active));$('settings-tab-'+tab).tabIndex=active?0:-1;}$('settings-body').scrollTop=0;}
  function settingsSignature(){return JSON.stringify({fields:[...new FormData($('settings-form'))],gitlab:gitlab.summary()});}
  function settingsState(){const state=$('settings-state'),count=gitlab.summary().count,dirty=settingsSignature()!==settingsBaseline;state.textContent=`已选 ${count} 个 GitLab 仓库 · ${dirty?'有未保存的修改':'配置未修改'}`;state.dataset.dirty=String(dirty);}
  const gitlab=createReportGitlabView({request,run,owner:page,onChange:settingsState});
  for(const name of settingsTabs){const tab=$('settings-tab-'+name);tab.addEventListener('click',()=>showSettingsTab(name));tab.addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();const index=settingsTabs.indexOf(name),next=event.key==='Home'?0:event.key==='End'?settingsTabs.length-1:(index+(event.key==='ArrowRight'?1:-1)+settingsTabs.length)%settingsTabs.length;showSettingsTab(settingsTabs[next]);$('settings-tab-'+settingsTabs[next]).focus();
  });}
  $('settings-form').addEventListener('input',settingsState);$('settings-form').addEventListener('change',settingsState);
  // 原生校验触发时先显示对应页签和折叠区，使无效字段可以定位与聚焦。
  $('settings-form').addEventListener('invalid',event=>{const target=event.target,panel=target.closest('[role="tabpanel"]');if(panel)showSettingsTab(panel.id.replace('report-settings-panel-',''));for(let parent=target.parentElement;parent&&parent!==$('settings-form');parent=parent.parentElement)if(parent.tagName==='DETAILS')parent.open=true;message('请检查“'+(target.closest('label')?.childNodes[0]?.textContent.trim()||'配置项')+'”：'+target.validationMessage,true,$('settings-error'));},true);
  for(const button of content.querySelectorAll('[data-close]'))button.addEventListener('click',()=>$(button.dataset.close).close());
  function button(label,action,className='outline'){const node=el('button',className,label);node.type='button';node.addEventListener('click',()=>run(node,action));return node;}
  let recentDaysAnchor='';
  function renderRecentDays(){
    const anchor=today(),group=$('recent-days');
    if(anchor!==recentDaysAnchor){
      recentDaysAnchor=anchor;group.replaceChildren();
      const noon=Date.parse(anchor+'T12:00:00+08:00'),weekday=new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',weekday:'short'});
      for(let offset=6;offset>=0;offset--){
        const time=noon-offset*86400000,date=reportDate(time),label=offset===0?'今天':offset===1?'昨天':weekday.format(new Date(time)),node=el('button','outline report-day-button');
        node.type='button';node.dataset.date=date;node.setAttribute('aria-label',label+'，'+date);node.title=date;
        node.append(el('span','',label),el('span','report-day-date',date.slice(5).replace('-','/')));
        node.addEventListener('click',()=>{$('date').value=date;void load();});group.append(node);
      }
    }
    for(const node of group.children)node.setAttribute('aria-pressed',String(node.dataset.date===$('date').value));
  }
  renderRecentDays();
  const releaseTime=time=>new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hour12:false}).format(time);
  function rawEntry(entry){
    const card=el('article','ui-card report-entry');card.dataset.included=String(entry.included&&entry.sourceActive);card.dataset.entryId=entry.id;
    const head=el('div','report-entry-head'),copy=el('div'),meta=el('div','report-meta');
    const labels={manual:'手工记录',planner:'日程备忘',git:'Git 提交',gitlab:entry.sourceMeta?.event==='merged'?'MR 合并':'GitLab 提交',jenkins:'Jenkins'};
    const state=entry.status==='blocked'?'待解决':entry.status==='planned'?'计划':entry.source==='jenkins'?'发布记录':entry.sourceMeta?.event==='merged'?'合并 '+(entry.sourceMeta.mergeRequests?.[0]?.targetBranch||'目标分支'):['git','gitlab'].includes(entry.source)?'代码提交':'已完成';
    for(const value of [entry.project,labels[entry.source],state])meta.append(el('span','',value));
    copy.append(meta,el('h3','',entry.title));if(entry.details)copy.append(el('p','report-note',entry.details));if(entry.evidence)copy.append(el('p','report-note',entry.evidence));
    const actions=el('div','report-actions');actions.append(button('编辑',async()=>openEntry(entry)),button(entry.included?'排除':'纳入',async()=>{await request('set-entry-included',{id:entry.id,included:!entry.included});await load();}),
      button('移除',async()=>{if(await confirmAction({owner:page,title:'移除工作记录？',message:'记录将不再纳入报告，自动采集也不会重新添加这条记录。',confirmLabel:'移除记录',danger:true})){await request('remove-entry',{id:entry.id});await load();}},'text-button ui-danger-action'));
    head.append(copy,actions);card.append(head);return card;
  }
  let renderedEntries='';
  function workDetails(label,key,expanded){
    const details=el('details','report-work-evidence');details.dataset.reportDetail=JSON.stringify([data.date,key]);details.open=expanded.has(details.dataset.reportDetail);details.append(el('summary','',label));return details;
  }
  function sourceReference(entry,compact=false){
    const name=entry.sourceMeta?.event==='merged'?'MR 合并':{planner:'日程备忘',gitlab:'GitLab 提交',git:'Git 提交',jenkins:'发布记录',manual:'手工记录'}[entry.source]||'来源记录';
    const reference=el('span','report-source-reference'),trigger=el('button','text-button report-source-trigger',compact?name:name+' · '+entry.title),popup=el('div','report-source-popup');
    if(entry.source==='planner'){reference.classList.add('report-planner-reference');trigger.classList.add('report-planner-trigger');popup.classList.add('report-planner-popup');}
    trigger.type='button';trigger.setAttribute('aria-haspopup','dialog');popup.setAttribute('role','dialog');popup.setAttribute('aria-label',name+'详情');
    popup.append(el('p','report-note',(entry.source==='planner'?'完成日期：':'记录日期：')+entry.date),rawEntry(entry));reference.append(trigger,popup);
    function position(){
      reference.classList.remove('is-dismissed');popup.style.transform='';popup.style.top='calc(100% + 8px)';popup.style.bottom='auto';
      const bounds=popup.getBoundingClientRect(),shift=bounds.left<16?16-bounds.left:bounds.right>innerWidth-16?innerWidth-16-bounds.right:0;
      popup.style.transform=`translateX(${shift}px)`;
      if(bounds.bottom>innerHeight-16&&trigger.getBoundingClientRect().top>bounds.height+16){popup.style.top='auto';popup.style.bottom='100%';}
    }
    reference.addEventListener('mouseenter',position);reference.addEventListener('focusin',position);
    reference.addEventListener('keydown',event=>{if(event.key==='Escape'){event.stopPropagation();trigger.focus();reference.classList.add('is-dismissed');}});
    reference.addEventListener('mouseleave',()=>{if(!reference.contains(document.activeElement))reference.classList.remove('is-dismissed');});
    return reference;
  }
  function sourceCard(entry,expanded){
    // 来源沿用日期和记录标识保存展开状态，刷新列表后仍停留在原来的核对位置。
    const card=workDetails(entry.title,'source:'+entry.id,expanded),body=el('div','report-source-card-content');card.className='ui-card report-source-card';
    card.firstElementChild.title=entry.title;
    // 仅在用户展开时滚动到正文，避免轮询恢复展开状态时跳动页面。
    card.addEventListener('toggle',()=>{if(card.open&&document.activeElement===card.firstElementChild)card.scrollIntoView({block:'nearest'});});
    body.append(el('p','report-note','记录日期：'+entry.date),rawEntry(entry));card.append(body);return card;
  }
  function workCard(item,entries,expanded,paired=false){
    const card=el('article','ui-card report-work-card'),heading=el('div','report-work-heading'),meta=el('div','report-work-meta');card.dataset.status=item.status;
    const own=entries.filter(entry=>item.entryIds.includes(entry.id)),planner=own.filter(entry=>entry.source==='planner'),sources=own.filter(entry=>entry.source!=='planner');
    heading.append(el('h3','',item.title),el('span','report-work-badge',item.badge));
    meta.append(el('span','report-work-project',[...new Set(own.map(entry=>entry.project).filter(Boolean))].join('、')||item.project));
    const mrUrls=new Set(item.memberKeys.filter(key=>key.startsWith('mr:')).map(key=>key.slice(3)));
    const mrs=item.mr?[item.mr]:[...new Map(own.flatMap(entry=>entry.sourceMeta?.mergeRequests||[]).filter(mr=>!mrUrls.size||mrUrls.has(mr.url)).map(mr=>[mr.url,mr])).values()];
    if(mrs.length)meta.append(el('span','report-work-mrs','MR '+mrs.map(mr=>'!'+mr.iid).join('、')));
    for(const [source,label] of [['gitlab','GitLab 提交'],['git','Git 提交'],['jenkins','发布记录'],['manual','手工记录']]){
      const count=own.filter(entry=>entry.source===source&&entry.sourceMeta?.event!=='merged').length;if(count)meta.append(el('span','',label+' '+count+' 条'));
    }
    const merges=own.filter(entry=>entry.sourceMeta?.event==='merged').length;if(merges)meta.append(el('span','','MR 合并 '+merges+' 条'));
    for(const entry of planner)meta.append(sourceReference(entry,true));
    card.append(heading,meta,el('p','report-work-description'+(item.description?'':' report-work-description-empty'),item.description||'暂无工作说明，可点击编辑图标补充处理结果。'));
    if(Number.isFinite(item.completedAt))card.append(el('p','report-note report-work-completed','功能完成：'+new Intl.DateTimeFormat('zh-CN',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false}).format(item.completedAt)));
    if(item.releases.length){
      const latest=item.releases.at(-1),targets=[...new Set(item.releases.map(release=>release.target))].join('、');
      card.append(el('p','report-work-release-summary',`${item.releases.length} 次发布 · ${targets} · 最近 ${releaseTime(latest.time)} ${latest.kind}成功 #${latest.buildNumber}`));
    }
    const details=workDetails(sources.length?'来源记录 · '+sources.length+' 条':'关联说明','work:'+item.key,expanded);
    if(item.mr)details.append(el('p','report-note',item.project+' · MR !'+item.mr.iid));
    if(item.releases.length){const releases=el('ul','report-release-list');for(const release of item.releases)releases.append(el('li','',`${releaseTime(release.time)} · ${release.target} · ${release.kind}成功 #${release.buildNumber}`));details.append(releases);}
    for(const warning of item.warnings)details.append(el('p','report-work-warning',warning));
    for(const group of item.conflictingGroups||[])details.append(button('解除“'+group.title+'”的合并',async()=>unmergeWork(item.date,group.id),'text-button'));
    // 短卡片只用于疑似合并的来源对比，普通工作列表继续使用原来的来源展示。
    if(paired&&sources.length){const list=el('div','report-match-source-list');for(const entry of sources)list.append(sourceCard(entry,expanded));details.append(list);}
    else for(const entry of sources)details.append(sourceReference(entry));
    if(sources.length||item.releases.length||item.warnings.length||item.conflictingGroups?.length)card.append(details);
    const actions=el('div','report-work-controls');
    // 单条记录可直接编辑；自动汇总和合并事项只修改报告层的标题、说明。
    const edit=button('',async()=>{
      if(!item.groupId&&!item.mr&&item.kind!=='branch'&&own.length===1)openEntry(own[0]);else openWork(item,true);
    },'ui-icon-button');
    edit.title='修改信息';edit.setAttribute('aria-label','修改信息');
    edit.innerHTML='<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 20h9M16.5 3.5a2.12 2.12 0 0 1 3 3L9 17l-4 1 1-4Z"/></svg>';
    actions.append(edit);
    const remove=button('移除',async()=>{
      if(await confirmAction({owner:page,title:'移除这项工作？',message:`将移除“${item.title}”及当前包含的 ${item.entryIds.length} 条来源记录。这些记录不会因重新采集恢复。`,confirmLabel:'移除工作',danger:true})){
        await request('remove-work',{date:item.date,key:item.key});await load();message('已移除这项工作。');
      }
    },'text-button ui-danger-action');
    remove.disabled=(data.work?.items||[]).some(other=>other.key!==item.key&&other.entryIds.some(id=>item.entryIds.includes(id)));
    if(remove.disabled)remove.title='这项工作与其他工作共用来源，请先在来源记录中核对';
    actions.append(remove);
    if(item.groupId)actions.append(button(item.editOnly?'还原修改':'解除合并',async()=>unmergeWork(item.date,item.groupId,null,item.editOnly),'text-button'));
    else if(item.legacyLinkIds?.length)actions.append(button('解除合并',async()=>unmergeWork(item.date,null,item.key),'text-button'));
    card.append(actions);return card;
  }
  function renderMatches(expanded){
    const matches=data.workMatches||{items:[],dismissedCount:0},date=data.date;
    $('matches').hidden=!matches.items.length&&!matches.dismissedCount&&!matches.limited;
    $('matches-heading').textContent=matches.items.length?`可能是同一件工作 · ${matches.items.length} 组`:'关联检查';
    $('matches-note').textContent=matches.items.length?'点击事项展开对比，再确认是否合并。':`已忽略 ${matches.dismissedCount} 组关联，不再重复提醒。`;
    $('matches-limit').hidden=!matches.limited;$('match-list').replaceChildren();$('matches-actions').replaceChildren();
    for(const match of matches.items){
      const card=el('details','ui-card report-match'),summary=el('summary','report-match-summary'),heading=el('span','report-match-heading'),title=el('span','report-match-title-row'),toggle=el('span','report-match-toggle'),body=el('div','report-match-content'),grid=el('div','report-match-grid');
      card.dataset.reportDetail=JSON.stringify([date,'match:'+match.id]);card.open=expanded.has(card.dataset.reportDetail);
      title.append(el('span','report-match-label','待确认关联'),el('span','report-match-title',match.title));heading.append(title,el('span','report-match-reason',match.reason));
      toggle.append(el('span','report-match-expand','展开对比'),el('span','report-match-collapse','收起对比'));summary.append(heading,toggle);
      const entries=data.entries.filter(entry=>entry.sourceActive!==false);
      for(const key of match.keys){const item=data.work.items.find(item=>item.key===key);if(item)grid.append(workCard(item,entries,expanded,true));}
      const footer=el('div','report-match-footer'),actions=el('div','report-actions');
      footer.append(actions);body.append(grid,footer);card.append(summary,body);
      actions.append(button('确认合并',async()=>{await request('accept-work-match',{date,id:match.id});await load();message('已合并为一项工作，可在事项卡片上编辑或解除合并。');},'primary'),
        button('不是同一件',async()=>{await request('dismiss-work-match',{date,id:match.id});await load();message('已记住，本组事项不再重复提醒。');}));
      $('match-list').append(card);
    }
    if(matches.dismissedCount)$('matches-actions').append(button('重新检查已忽略的关联',async()=>{await request('restore-work-matches',{date});await load();message('已重新检查当天忽略的关联。');},'text-button'));
  }
  function renderEntries(){
    // 轮询结果未变化时保留正在阅读的 DOM；来源更新时按日期和事项身份恢复展开状态。
    const signature=JSON.stringify([data.date,data.entries,data.work,data.workMatches,data.sources,data.settings.lookbackDays]);
    if(signature===renderedEntries)return;renderedEntries=signature;
    const expanded=new Set([...page.querySelectorAll('details[data-report-detail][open]')].map(node=>node.dataset.reportDetail));
    renderMatches(expanded);
    const list=$('list');list.replaceChildren();
    const entries=data.entries.filter(entry=>entry.sourceActive!==false),work=data.work||{items:[],releaseCount:0},done=work.items.filter(i=>i.status==='done');
    $('merge').disabled=done.length<2;
    $('day-summary').textContent=`${done.length} 项工作 · ${work.items.filter(i=>i.status==='blocked').length} 项待解决 · ${work.items.filter(i=>i.status==='planned').length} 项计划`;
    const failed=data.sources.filter(s=>s.error).length,warnings=data.sources.filter(s=>s.warning).length;
    $('source-status').hidden=!data.sources.length;$('source-summary').textContent=`采集状态 · ${data.sources.length} 个来源${failed?' · '+failed+' 个失败':''}${warnings?' · '+warnings+' 个提醒':''}`;
    $('source-range').textContent=`以下为最近一次采集的回溯结果（${data.settings.lookbackDays} 天），不代表所选日期的工作数量。`;
    $('sources').replaceChildren();
    for(const source of data.sources){const row=el('div','report-source-result');row.append(el('span','',source.key.startsWith('jenkins:')?'Jenkins':'GitLab'),el('span','',source.project),el('span','',source.error||source.warning||'读取 '+source.count+' 条'));$('sources').append(row);}
    if(!entries.length){const empty=el('div','ui-card report-empty');empty.append(el('h2','','这一天还没有工作记录'),el('p','report-note','记录完成的工作，或在配置中接入日程、GitLab 与 Jenkins。'));list.append(empty);return;}
    const matchedKeys=new Set((data.workMatches?.items||[]).flatMap(match=>match.keys));
    const sections=[['今日工作',i=>i.status==='done'],['问题与风险',i=>i.status==='blocked'],['工作计划',i=>i.status==='planned']];
    for(const [title,accept] of sections){
      const items=work.items.filter(item=>accept(item)&&!matchedKeys.has(item.key));if(!items.length)continue;
      const section=el('section','report-work-section');section.append(el('h2','report-section-heading',title));
      for(const item of items){
        section.append(workCard(item,entries,expanded));
      }
      list.append(section);
    }
    const excluded=entries.filter(e=>!e.included);if(excluded.length){const drawer=workDetails('未纳入报告 · '+excluded.length+' 条','excluded',expanded);drawer.classList.add('report-excluded');for(const entry of excluded)drawer.append(sourceReference(entry));list.append(drawer);}
  }
  const associationAttempts=new Set(),associationErrors=new Map();
  async function load(){
    renderRecentDays();if(loading||page.hidden)return;loading=true;const date=$('date').value||today();
    try{
      let snapshot=await request('snapshot',{date});
      if(date!==($('date').value||today()))return;
      data=snapshot;renderEntries();$('collect').disabled=data.busy||working;
      const legacy=()=>snapshot.needsMrRefresh;
      if(legacy()&&!snapshot.busy&&!associationAttempts.has(date)){
        associationAttempts.add(date);$('collect').disabled=true;
        message('正在整理历史提交与 MR 的关联…');
        try{
          snapshot=await request('prepare-day',{date});associationErrors.delete(date);
          if(date===($('date').value||today())){data=snapshot;renderEntries();}
        }catch(error){associationErrors.set(date,error.message);}
      }
      if(date===($('date').value||today())){
        if(associationAttempts.has(date))message('');
        $('collect').disabled=snapshot.busy||working;message(data.error||associationErrors.get(date)||'',true);
        $('repair-day').hidden=!legacy()||!associationErrors.has(date);
      }
    }
    catch(error){if(date===($('date').value||today()))message(error.message,true);}
    finally{loading=false;if(date!==($('date').value||today()))void load();}
  }
  async function unmergeWork(date,id,key,restore=false){
    if(await confirmAction({owner:page,title:restore?'还原事项修改？':'解除事项合并？',message:restore?'将恢复来源中的工作标题和说明，原始来源记录保留。':'将恢复为各自的工作事项，原始来源记录保留；合并后的标题和说明将不再使用。',confirmLabel:restore?'还原修改':'解除合并'})){
      await request('unmerge-work',{date,id,key});await load();message(restore?'已恢复来源中的工作标题和说明。':'已解除合并。可点击顶部“合并同一事项”重新合并，或“重新检查已忽略的关联”恢复提醒。');
    }
  }
  function workChoices(){return data.work.items.filter(item=>item.status==='done');}
  function copyWorkContent(){
    const form=$('work-form'),item=workChoices().find(item=>item.key===form.elements.copy.value);if(!item)return;
    form.elements.title.value=item.title;form.elements.description.value=item.description;
  }
  function selectWorkTarget(){
    const form=$('work-form'),choices=workChoices(),origin=choices.find(item=>item.key===form.elements.origin.value),target=choices.find(item=>item.key===form.elements.target.value);
    const selected=[origin,target].filter(Boolean);form.elements.copy.replaceChildren(...selected.map(item=>new Option(item.title,item.key)));
    const planner=selected.find(item=>data.entries.some(entry=>item.entryIds.includes(entry.id)&&entry.source==='planner'));
    form.elements.copy.value=(planner||origin).key;copyWorkContent();
  }
  function selectWorkOrigin(){
    const form=$('work-form'),previous=form.elements.target.value;workDialog.key=form.elements.origin.value;
    form.elements.target.replaceChildren(...workChoices().filter(item=>item.key!==workDialog.key).map(item=>new Option(item.project+' · '+item.title,item.key)));
    if([...form.elements.target.options].some(option=>option.value===previous))form.elements.target.value=previous;selectWorkTarget();
  }
  function openWork(item,edit=false){
    const choices=workChoices();if(!edit){if(choices.length<2)return;item=choices[0];}
    workDialog={date:item.date,key:item.key,id:edit?item.groupId:null,edit};const form=$('work-form');form.reset();
    $('work-heading').textContent=edit?'修改工作信息':'合并同一事项';form.querySelector('[type="submit"]').textContent=edit?'保存修改':'确认合并';
    $('work-hint').textContent=edit?'修改这项工作在日报、周报中的标题与说明，原始来源保留。':'选择两项工作，合并后的日报只显示一项，原始来源保留，可随时解除合并。';
    $('work-origin-field').hidden=$('work-target-field').hidden=$('work-copy-field').hidden=edit;form.elements.origin.disabled=form.elements.target.disabled=edit;
    if(edit){form.elements.title.value=item.title;form.elements.description.value=item.description;}
    else{form.elements.origin.replaceChildren(...choices.map(item=>new Option(item.project+' · '+item.title,item.key)));selectWorkOrigin();}
    message('',true,$('work-error'));$('work-dialog').showModal();
  }
  $('merge').addEventListener('click',()=>openWork());
  $('work-form').elements.origin.addEventListener('change',selectWorkOrigin);$('work-form').elements.target.addEventListener('change',selectWorkTarget);$('work-form').elements.copy.addEventListener('change',copyWorkContent);
  $('work-form').addEventListener('submit',event=>{event.preventDefault();const form=event.currentTarget;void run(form.querySelector('[type="submit"]'),async()=>{
    const value={date:workDialog.date,title:form.elements.title.value,description:form.elements.description.value};
    if(workDialog.edit)await request('save-work',{...value,...(workDialog.id?{id:workDialog.id}:{key:workDialog.key})});else await request('merge-work',{...value,keys:[workDialog.key,form.elements.target.value]});
    $('work-dialog').close();await load();message(workDialog.edit?'工作信息已保存。':'已合并为同一事项，原始来源已保留。');
  },$('work-error'));});
  function openEntry(entry){editing=entry||null;const form=$('entry-form');form.reset();for(const name of ['date','title','project','details','status','evidence'])form.elements[name].value=entry?.[name]??({date:$('date').value,status:'done'}[name]||'');form.elements.included.checked=entry?.included!==false;
    $('entry-heading').textContent=entry?'编辑工作记录':'记录工作';message('',true,$('entry-error'));$('entry-dialog').showModal();}
  $('add').addEventListener('click',()=>openEntry());
  $('entry-form').addEventListener('submit',event=>{event.preventDefault();const form=event.currentTarget;void run(form.querySelector('[type="submit"]'),async()=>{
    const value=Object.fromEntries(['date','title','project','details','status','evidence'].map(key=>[key,form.elements[key].value]));value.included=form.elements.included.checked;if(editing){value.id=editing.id;value.relatedMr=editing.relatedMr||'';}
    await request('save-entry',value);$('date').value=value.date;$('entry-dialog').close();await load();message('工作记录已保存。');
  },$('entry-error'));});
  $('date').addEventListener('change',()=>void load());
  $('repair-day').addEventListener('click',()=>{associationAttempts.delete($('date').value);associationErrors.delete($('date').value);void load();});
  $('collect').addEventListener('click',()=>run($('collect'),async()=>{await request('collect');await load();const failed=data.sources.filter(source=>source.error).length;message(failed?`采集结束，${failed} 个来源未成功，请展开采集状态查看。`:'采集完成，已有来源记录不会重复添加。');}));
  $('preview-day').addEventListener('click',()=>run($('preview-day'),async()=>{const result=await request('preview-day',{date:$('date').value});$('day-content').value=result.content;$('preview-heading').textContent='日报 · '+result.date;$('preview-dialog').dataset.date=result.date;message('',true,$('preview-error'));$('preview-dialog').showModal();}));
  $('archive-day').addEventListener('click',()=>run($('archive-day'),async()=>{const result=await request('archive-day',{date:$('preview-dialog').dataset.date});$('preview-dialog').close();message('日报已归档：'+result.path);},$('preview-error')));
  function showTab(name){for(const tab of ['daily','weekly']){const selected=tab===name;$(tab).hidden=!selected;$(tab+'-tab').setAttribute('aria-selected',String(selected));$(tab+'-tab').tabIndex=selected?0:-1;}if(name==='weekly'&&!weekDirty)void loadWeek();}
  for(const name of ['daily','weekly']){$(name+'-tab').addEventListener('click',()=>showTab(name));$(name+'-tab').addEventListener('keydown',event=>{if(['ArrowLeft','ArrowRight'].includes(event.key)){event.preventDefault();const next=name==='daily'?'weekly':'daily';showTab(next);$(next+'-tab').focus();}});}
  async function loadWeek(){try{weekDate=$('week-date').value||today();week=await request('get-week',{date:weekDate});$('week-content').value=week.content;weekDirty=false;$('week-status').textContent=`${week.start} ～ ${week.end} · ${week.edited?'已手工编辑':week.content?'按模板生成':'尚未生成'}`;}catch(error){message(error.message,true);}}
  $('week-content').addEventListener('input',()=>{weekDirty=true;$('week-status').textContent='有未保存的修改';});
  $('week-date').addEventListener('change',async()=>{if(weekDirty&&!(await confirmAction({owner:page,title:'切换周报？',message:'当前未保存的修改会丢失。请取消切换并先保存草稿，或确认放弃修改。',confirmLabel:'放弃并切换'}))){$('week-date').value=weekDate;return;}await loadWeek();});
  $('generate').addEventListener('click',()=>run($('generate'),async()=>{let force=false;if(weekDirty||week?.edited){force=await confirmAction({owner:page,title:'重新生成周报？',message:'将用当前工作记录和模板重新生成，覆盖这份草稿的手工修改。',confirmLabel:'重新生成'});if(!force)return;}await request('generate-week',{date:weekDate,force});await loadWeek();message('周报已生成，可编辑后保存或归档。');}));
  async function saveWeek(){await request('save-week',{date:weekDate,content:$('week-content').value});await loadWeek();}
  $('save-week').addEventListener('click',()=>run($('save-week'),async()=>{await saveWeek();message('周报草稿已保存。');}));
  $('archive-week').addEventListener('click',()=>run($('archive-week'),async()=>{if(weekDirty)await saveWeek();const result=await request('archive-week',{date:weekDate});message('周报已归档：'+result.path);}));
  function sourceRow(value={}){
    const row=el('div','report-source-row');row.dataset.kind='job';
    row.innerHTML=`<div class="report-grid">${field('project','GitLab 业务仓库路径','text','required maxlength="100" placeholder="例如：ossv/d-ossv-pay"')}${field('job','Jenkins 任务路径','text','required placeholder="文件夹/任务名"')}<label class="report-field">环境<select name="environment"><option value="prod">生产（prod）</option></select></label>${field('target','发布目标','text','placeholder="例如：EKS"')}<label class="report-field report-wide">只采集这些发布人账号<input name="userIds" required placeholder="Jenkins userId，逗号分隔"></label></div><p class="report-note">自动核验部署阶段；构建成功、代码提交时间和 MR 合并时间均不代替发布时间。</p>`;
    for(const input of row.querySelectorAll('[name]'))input.value=value[input.name]||(input.name==='environment'?'prod':'');
    const remove=el('button','text-button ui-danger-action','移除此来源');remove.type='button';remove.addEventListener('click',()=>{row.remove();settingsState();});row.append(remove);$('jenkins-jobs').append(row);
  }
  $('add-job').addEventListener('click',()=>{sourceRow();settingsState();});
  $('pick-archive').addEventListener('click',()=>run($('pick-archive'),async()=>{const result=await request('pick-directory');if(result.path){$('settings-form').elements.archiveDir.value=result.path;settingsState();}},$('settings-error')));
  $('open-settings').addEventListener('click',()=>run($('open-settings'),async()=>{
    await load();if(!data)return;const form=$('settings-form');
    for(const name of ['syncPlanner','autoCollect','autoArchive','autoWeekly'])form.elements[name].checked=data.settings[name];
    for(const name of ['intervalMinutes','lookbackDays','archiveDir','dailyDir','weeklyDir','weeklyTemplate'])form.elements[name].value=data.settings[name];
    gitlab.open(data);
    $('jenkins-jobs').replaceChildren();data.settings.jenkinsJobs.forEach(row=>sourceRow(row));$('jenkins-source').open=data.settings.jenkinsJobs.length>0;showSettingsTab('sources');settingsBaseline=settingsSignature();settingsState();message('',true,$('settings-error'));$('settings-dialog').showModal();
  }));
  $('settings-form').addEventListener('submit',event=>{event.preventDefault();const form=event.currentTarget,invalid=[...form.elements].find(input=>input.willValidate&&!input.validity.valid);if(invalid){invalid.reportValidity();return;}void run(form.querySelector('[type="submit"]'),async()=>{
    const value={};for(const name of ['syncPlanner','autoCollect','autoArchive','autoWeekly'])value[name]=form.elements[name].checked;
    for(const name of ['intervalMinutes','lookbackDays'])value[name]=Number(form.elements[name].value);
    for(const name of ['archiveDir','dailyDir','weeklyDir','weeklyTemplate'])value[name]=form.elements[name].value;
    const readRows=kind=>[...form.querySelectorAll(`[data-kind="${kind}"]`)].map(row=>Object.fromEntries([...row.querySelectorAll('[name]')].map(input=>[input.name,input.type==='checkbox'?input.checked:input.value])));
    value.repositories=[];value.jenkinsJobs=readRows('job');Object.assign(value,gitlab.settings());await request('settings',value);$('settings-dialog').close();await load();message('报告配置已保存。');
  },$('settings-error'));});
  document.addEventListener('whale-view-changed',()=>{if(page.hidden){for(const dialog of page.querySelectorAll('dialog[open]'))dialog.close();}else void load();});
  document.addEventListener('whale-show-report-day',event=>{
    const completedAt=event.detail?.completedAt;if(!Number.isFinite(completedAt))return;
    $('date').value=reportDate(completedAt);showTab('daily');showView('reports');
  });
  // 只在页面可见且没有正在编辑的弹窗时更新列表，避免后台广播覆盖输入草稿。
  setInterval(()=>{if(!page.hidden&&!working&&!page.querySelector('dialog[open]'))void load();},5000);
}
