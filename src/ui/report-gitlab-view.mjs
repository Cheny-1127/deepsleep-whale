import {confirmAction} from './confirm-dialog.mjs';

export function createReportGitlabView({request,run,owner,onChange}){
  const root=document.getElementById('report-gitlab-settings'),$=id=>document.getElementById('report-gitlab-'+id);
  root.innerHTML=`<div class="report-toolbar"><h3>GitLab 仓库</h3><button id="report-gitlab-connect" type="button" class="outline">连接并读取分组</button></div>
    <details id="report-gitlab-connection" class="report-gitlab-connection"><summary><span id="report-gitlab-status" role="status">尚未连接</span><span class="report-note">连接设置</span></summary>
      <div class="report-grid"><label class="report-field">GitLab 地址<input id="report-gitlab-url" type="url" placeholder="https://gitlab.com" autocomplete="off"></label><label class="report-field">个人访问 Token<input id="report-gitlab-token" type="password" autocomplete="new-password" placeholder="填写 Token 以连接" maxlength="8192"></label></div>
      <p class="report-note">Token 需要 read_api 权限，使用系统安全存储加密保存。连接验证后单独保存；仓库勾选需“确定并保存”才生效。</p>
    </details>
    <p id="report-gitlab-error" class="ui-alert" role="alert" hidden></p>
    <div class="report-gitlab-browser" id="report-gitlab-browser" hidden>
      <p class="report-note">按项目组勾选仓库，整组选取包含子组。选好后点击底部“确定并保存”。</p>
      <label class="report-field">搜索项目组或仓库<input id="report-gitlab-search" placeholder="输入名称或完整路径" maxlength="200"></label>
      <div class="report-actions"><button id="report-gitlab-expand" type="button" class="outline">全部展开</button><button id="report-gitlab-collapse" type="button" class="outline">全部收起</button><span id="report-gitlab-tree-note" class="report-note" role="status"></span></div>
      <div id="report-gitlab-projects" class="report-gitlab-tree" aria-label="GitLab 项目组和仓库"></div>
    </div>
    <details id="report-gitlab-selection" class="report-settings-extra"><summary id="report-gitlab-selected-heading">已选项目（0 / 200）</summary><div id="report-gitlab-selected" class="report-gitlab-projects"></div></details>
    <details id="report-gitlab-filters" class="report-settings-extra"><summary>提交作者筛选 <span id="report-gitlab-filter-label" class="report-note">按邮箱</span></summary>
      <label class="report-field">筛选方式<select id="report-gitlab-author-mode"><option value="email">作者邮箱（email）</option><option value="name">作者名（username / 姓名）</option></select></label>
      <label id="report-gitlab-email-field" class="report-field">只采集这些作者邮箱<input id="report-gitlab-authors" placeholder="多个邮箱用逗号分隔" maxlength="1000"></label>
      <label id="report-gitlab-name-field" class="report-field" hidden>只采集这些作者名<input id="report-gitlab-author-names" placeholder="例如：zhangsan, 张三；多个名字用逗号分隔" maxlength="1000"></label>
      <p id="report-gitlab-filter-note" class="report-note">按提交中的作者邮箱精确匹配。</p></details>`;
  const node=(tag,className,text)=>{const result=document.createElement(tag);result.className=className||'';if(text!==undefined)result.textContent=text;return result;};
  const key=project=>project.host+':'+project.projectId;
  let selected=new Map(),connection={},tree=[],treeHost='',loading=false,revision=0;
  const error=value=>{const target=$('error');target.textContent=value;target.hidden=!value;};
  const on=(id,action)=>$(id).addEventListener('click',async()=>{await run($(id),async()=>{error('');await action();},$('error'));updateButtons();});
  function updateButtons(){
    $('connect').textContent=loading?'正在读取项目…':connection.connected?($('token').value.trim()?'更新连接':'刷新项目'):'连接并读取分组';
    $('connect').disabled=loading;$('expand').disabled=$('collapse').disabled=loading||!tree.length;
  }
  function status(){const mismatch=[...selected.values()].some(item=>item.host!==connection.url);
    $('status').textContent=connection.connected?`已连接：${connection.username} · ${connection.url} · 连接已保存`:'尚未连接';
    $('token').placeholder=connection.connected?'已保存 Token，留空即可复用；填写可更新':'填写 Token 以连接';updateButtons();
    $('connection').open=!connection.connected;$('browser').hidden=!connection.connected;if(connection.error)error(connection.error);else if(mismatch)error('部分已选项目属于旧 GitLab 实例，请移除后重新选择。');}
  function setSelected(projects,checked){
    const next=new Map(selected);for(const project of projects)if(checked)next.set(key(project),project);else next.delete(key(project));
    if(next.size>200){error('最多选择 200 个 GitLab 项目；本次勾选未应用。');syncChecks();return;}
    selected=next;error('');renderSelected();syncChecks();
  }
  function renderSelected(){const list=$('selected');list.replaceChildren();$('selected-heading').textContent=`已选项目（${selected.size} / 200）`;
    for(const project of selected.values()){
      const label=node('label','report-check'),check=node('input');check.type='checkbox';check.checked=true;check.setAttribute('aria-label','移除 '+project.project);
      check.addEventListener('change',()=>setSelected([project],false));label.append(check,node('span','',project.project+(project.host!==connection.url?' · '+project.host:'')));list.append(label);
    }
    if(!selected.size)list.append(node('p','report-note','尚未选择项目，可在上方逐个或整组勾选。'));
    updateFilter();onChange?.();
  }
  function updateFilter(){const byName=$('author-mode').value==='name',active=byName?$('author-names'):$('authors');
    $('email-field').hidden=byName;$('name-field').hidden=!byName;$('authors').disabled=byName;$('author-names').disabled=!byName;
    $('authors').required=selected.size>0&&!byName;$('author-names').required=selected.size>0&&byName;
    $('filter-label').textContent=byName?'按作者名':'按邮箱';
    $('filter-note').textContent=byName?'匹配提交时记录的作者名，可填写用户名或姓名别名，多个值用逗号分隔。不会按 GitLab 登录账号归属推断。':'按提交中的作者邮箱精确匹配，多个邮箱用逗号分隔。';
    if(selected.size&&!active.value.trim())$('filters').open=true;
  }
  function syncChecks(){for(const check of $('projects').querySelectorAll('input')){
    const projects=check.projects,count=projects.filter(project=>selected.has(key(project))).length;
    check.checked=projects.length>0&&count===projects.length;check.indeterminate=count>0&&count<projects.length;
  }}
  function renderTree(){const list=$('projects');list.replaceChildren();const query=$('search').value.trim().toLowerCase();
    function branch(group,parentMatches=false){
      const matches=parentMatches||group.path.toLowerCase().includes(query),children=group.children.map(child=>branch(child,matches)).filter(Boolean);
      const projects=group.projects.filter(project=>matches||project.path.toLowerCase().includes(query));
      if(query&&!matches&&!children.length&&!projects.length)return null;
      const details=node('details','report-gitlab-group');details.open=true;details.dataset.groupPath=group.path;
      const summary=node('summary'),label=node('label','report-check'),check=node('input');check.type='checkbox';check.projects=group.allProjects;
      check.disabled=loading||!group.allProjects.length;check.dataset.groupPath=group.path;check.setAttribute('aria-label','整组选取 '+group.path);
      // 点击复选框或标签只改变选择，不同时折叠分组。
      label.addEventListener('click',event=>event.stopPropagation());check.addEventListener('click',event=>event.stopPropagation());
      check.addEventListener('change',()=>setSelected(group.allProjects,check.checked));
      label.append(check,node('span','report-gitlab-name',group.name),node('span','report-note',`${group.allProjects.length} 个仓库`));summary.append(label);details.append(summary);
      const contents=node('div','report-gitlab-children');
      for(const child of children)contents.append(child);
      for(const project of projects){const item=node('label','report-check report-gitlab-project'),input=node('input');input.type='checkbox';input.projects=[project];input.disabled=loading;
        input.dataset.projectId=String(project.projectId);input.setAttribute('aria-label',project.project);input.addEventListener('change',()=>setSelected([project],input.checked));
        const title=node('span','report-gitlab-name',project.path.split('/').at(-1));title.title=project.path;item.append(input,title);contents.append(item);}
      if(!group.allProjects.length)contents.append(node('p','report-note','此组暂无可读取的仓库。'));
      details.append(contents);return details;
    }
    for(const group of tree){const item=branch(group);if(item)list.append(item);}
    if(!list.childElementCount)list.append(node('p','report-note',loading?'正在读取项目组和仓库…':query?'没有匹配的项目组或仓库。':'暂无可读取的项目组。'));
    syncChecks();updateButtons();
  }
  async function loadTree(){
    const current=++revision;loading=true;updateButtons();$('projects').inert=true;$('projects').setAttribute('aria-busy','true');
    $('tree-note').textContent='正在读取全部项目组…';
    const active=()=>current===revision;
    async function pages(action,value){const items=[];for(let page=1;page<=1000;page++){
      if(!active())return null;const result=await request(action,{...value,page});if(!active())return null;
      items.push(...result.items);if(items.length>10000)throw Error('项目组或仓库超过 10000 项，请缩小账号可访问范围后重试。');
      if(!result.hasMore)return items;
    }throw Error('GitLab 分页过多，请稍后重试。');}
    try{
      const groups=await pages('gitlab-groups',{});if(!groups)return;
      // 父组接口已包含子组仓库，避免重复读取同一棵子树。
      const paths=new Set(groups.map(group=>group.fullPath)),roots=groups.filter(group=>!group.fullPath.split('/').slice(0,-1).some((_,i,parts)=>paths.has(parts.slice(0,i+1).join('/'))));
      const projects=new Map();
      for(let index=0;index<roots.length;index++){
        $('tree-note').textContent=`正在读取 ${roots[index].fullPath}（${index+1} / ${roots.length}）…`;
        const items=await pages('gitlab-projects',{groupId:roots[index].id});if(!items)return;
        for(const project of items)projects.set(key(project),project);
        if(projects.size>10000)throw Error('仓库超过 10000 项，请缩小账号可访问范围后重试。');
      }
      const nodes=new Map(),result=[];
      function ensure(path){if(nodes.has(path))return nodes.get(path);const split=path.lastIndexOf('/'),group={path,name:path.slice(split+1),children:[],projects:[],allProjects:[]};nodes.set(path,group);
        (split<0?result:ensure(path.slice(0,split)).children).push(group);return group;}
      for(const group of groups)ensure(group.fullPath);
      for(const project of projects.values())ensure(project.path.slice(0,project.path.lastIndexOf('/'))).projects.push(project);
      function collect(group){group.children.sort((a,b)=>a.name.localeCompare(b.name));group.projects.sort((a,b)=>a.path.localeCompare(b.path));
        group.allProjects=[...group.projects,...group.children.flatMap(collect)];return group.allProjects;}
      result.sort((a,b)=>a.name.localeCompare(b.name));result.forEach(collect);tree=result;treeHost=connection.url;renderTree();
      $('tree-note').textContent=`${groups.length} 个项目组 · ${projects.size} 个仓库`;
    }catch(cause){if(active()){$('tree-note').textContent=tree.length?'读取失败，保留上次列表。':'读取失败，请点击刷新重试。';throw cause;}}
    finally{if(active()){loading=false;$('projects').inert=false;$('projects').setAttribute('aria-busy','false');renderTree();}}
  }
  on('connect',async()=>{
    if(loading)return;
    if(connection.connected&&$('url').value.replace(/\/+$/,'')!==connection.url&&selected.size){
      if(!await confirmAction({owner,title:'切换 GitLab 实例？',message:'切换后清空本次项目勾选，已记录的工作保留。重新选择仓库并保存配置后更新来源。',confirmLabel:'切换实例'}))return;
    }
    const token=$('token').value;$('token').value='';const previousUrl=connection.url;
    connection=await request('gitlab-connect',{url:$('url').value,token});$('url').value=connection.url;
    if(previousUrl&&connection.url!==previousUrl){selected.clear();tree=[];treeHost='';}if(!$('authors').value)$('authors').value=connection.authors;if(!$('author-names').value)$('author-names').value=connection.username;
    status();renderSelected();await loadTree();
  });
  $('expand').addEventListener('click',()=>{for(const item of $('projects').querySelectorAll('details'))item.open=true;});
  $('collapse').addEventListener('click',()=>{for(const item of $('projects').querySelectorAll('details'))item.open=false;});
  $('search').addEventListener('input',renderTree);
  $('search').addEventListener('keydown',event=>{if(event.key==='Enter')event.preventDefault();});
  $('author-mode').addEventListener('change',()=>{if($('author-mode').value==='name'&&!$('author-names').value)$('author-names').value=connection.username||'';updateFilter();onChange?.();});
  $('token').addEventListener('input',updateButtons);
  document.getElementById('report-settings-dialog').addEventListener('close',()=>{revision++;loading=false;$('token').value='';});
  return {
    open(data){revision++;loading=false;connection=data.gitlab||{};selected=new Map((data.settings.gitlabProjects||[]).map(project=>[key(project),project]));
      $('url').value=connection.url||'https://gitlab.com';$('token').value='';$('authors').value=data.settings.gitlabAuthors||connection.authors||'';$('author-mode').value=data.settings.gitlabAuthorMode||'email';$('author-names').value=data.settings.gitlabAuthorNames||connection.username||'';$('search').value='';
      $('selection').open=false;$('filters').open=false;if(treeHost!==connection.url)tree=[];error('');renderSelected();renderTree();status();
      if(connection.connected)void loadTree().catch(cause=>error(cause.message));
    },
    summary(){return {count:selected.size,projects:[...selected.keys()].sort(),authors:$('authors').value,authorMode:$('author-mode').value,authorNames:$('author-names').value};},
    settings(){if([...selected.values()].some(project=>project.host!==connection.url))throw Error('所选项目与当前 GitLab 实例不一致，请重新勾选项目');
      return {gitlabProjects:[...selected.values()],gitlabAuthors:$('authors').value,gitlabAuthorMode:$('author-mode').value,gitlabAuthorNames:$('author-names').value};}
  };
}
