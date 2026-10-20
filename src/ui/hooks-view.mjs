// Hooks 页面只渲染主进程确认的可用能力，不根据 checkbox 自行推断已授权。
const $ = id => document.getElementById(id);

export function showView(view) {
  if(!$('home-view'))return;
  for(const name of ['home','hooks','wechat','mail','shortcuts'])if($(name+'-view'))$(name+'-view').hidden=name!==view;
  for(const button of document.querySelectorAll('[data-view]')) {
    const selected=button.dataset.view===view;
    button.classList.toggle('selected',selected);
    if(selected)button.setAttribute('aria-current','page');else button.removeAttribute('aria-current');
  }
}
document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>showView(button.dataset.view)));

export function createHookSettingsView({render}) {
  let lastData;
  let hookSettingsBuilt=false;
  function renderHookSettings(data) {
    lastData=data;
    if(!$('hook-sources')||!data.hookAdapters)return;
    if(!hookSettingsBuilt) {
      hookSettingsBuilt=true;
      for(const adapter of data.hookAdapters) {
        const card=document.createElement('section');card.className='hook-source';
        const heading=document.createElement('div');heading.className='hook-source-heading';
        const name=document.createElement('h2');name.textContent=adapter.name;
        const toggle=document.createElement('label');toggle.className='source-switch';
        const caption=document.createElement('span');caption.id=`source-caption-${adapter.id}`;
        const input=document.createElement('input');input.type='checkbox';input.id=`source-enabled-${adapter.id}`;input.setAttribute('aria-label',`接收 ${adapter.name} 事件`);
        toggle.append(caption,input);heading.append(name,toggle);
        input.addEventListener('change',async()=>{
          const enabled=input.checked;input.dataset.saving='true';input.disabled=true;
          try {render(await window.whale.action('hook-source',{source:adapter.id,enabled}));$('hooks-feedback').textContent=`${adapter.name} 已${enabled?'开启':'暂停'}接收`;}
          catch {input.checked=Boolean(lastData?.settings.sources[adapter.id]);$('hooks-feedback').textContent='设置未保存，请重试。';}
          finally {delete input.dataset.saving;renderHookSettings(lastData);}
        });
        const status=document.createElement('p');status.className='source-status';status.id=`source-status-${adapter.id}`;
        const availability=document.createElement('p');availability.className='source-availability';availability.id=`source-availability-${adapter.id}`;
        const refresh=document.createElement('button');refresh.className='text-button hook-refresh';refresh.id=`refresh-hooks-${adapter.id}`;refresh.textContent='重新检测';
        refresh.addEventListener('click',async()=>{refresh.dataset.saving='true';refresh.disabled=true;try {render(await window.whale.action('refresh-hooks',adapter.id));}catch {$('hooks-feedback').textContent='检测失败，请重试。';}finally {delete refresh.dataset.saving;renderHookSettings(lastData);}});
        const capabilities=document.createElement('p');capabilities.className='source-capabilities';capabilities.textContent=adapter.capabilities;
        const config=document.createElement('details');config.className='hook-config-preview';
        const configTitle=document.createElement('summary');configTitle.textContent='查看接入配置';
        const target=document.createElement('p');target.textContent=adapter.id==='cursor'?`配置文件：${adapter.target}。开启总开关时自动补齐全部 5 项配置，保留其他内容；逐项开关仅控制桌宠是否接收。`:`合并到 ${adapter.target}，保留已有配置。`;
        const preview=document.createElement('textarea');preview.readOnly=true;preview.value=adapter.config;preview.setAttribute('aria-label',`${adapter.name} Hooks 配置预览`);preview.spellcheck=false;
        const copy=document.createElement('button');copy.className='outline';copy.textContent='复制配置';
        copy.addEventListener('click',async()=>{try {await window.whale.action('copy-hook-config',adapter.id);$('hooks-feedback').textContent=`已复制 ${adapter.name} 配置`;}catch {$('hooks-feedback').textContent='复制失败，可在预览中手动复制。';}});
        config.append(configTitle,target,preview,copy);
        card.append(heading,status,availability,refresh,capabilities,config);$('hook-sources').append(card);
      }
      const rows=data.hookAdapters.find(item=>item.id==='codex').mappings;
      for(const mapping of rows) {
        const row=document.createElement('tr');
        const title=document.createElement('td');const label=document.createElement('strong');label.textContent=mapping.label;
        const key=document.createElement('small');key.textContent=mapping.normalized;title.append(label,key);row.append(title);
        for(const adapter of data.hookAdapters) {
          const cell=document.createElement('td');
          const matches=adapter.mappings.filter(item=>item.normalized===mapping.normalized);
          if(!matches.length) {
            const note=document.createElement('span');note.className='event-unavailable';
            note.textContent=adapter.id==='cursor'&&mapping.normalized==='Interrupt'?'回复取消或失败（stop）\n与「本轮完成」共用开关':'未接入对应事件';cell.append(note);
          }
          for(const match of matches) {
            const toggle=document.createElement('label');toggle.className='source-switch event-switch';
            const name=document.createElement('span');name.className='event-description';
            const chinese=document.createElement('strong');
            chinese.textContent=({UserPromptSubmit:'提交提示词',PreToolUse:'工具调用前',PermissionRequest:'请求操作权限',PostToolUse:'工具调用后',Stop:'本轮回复结束',Interrupt:'中断回复',SessionEnd:'会话结束',beforeSubmitPrompt:'提交提示词前',postToolUse:'工具调用成功',postToolUseFailure:'工具调用失败',stop:'本轮回复结束',sessionEnd:'会话结束'})[match.event]||match.label;
            const raw=document.createElement('code');raw.textContent=match.event;name.append(chinese,raw);
            const input=document.createElement('input');input.type='checkbox';input.dataset.source=adapter.id;input.dataset.event=match.event;
            input.id=`event-enabled-${adapter.id}-${match.event}`;input.setAttribute('aria-label',`接收 ${adapter.name} ${match.event}`);
            if(match.note)toggle.title=match.note;
            input.addEventListener('change',async()=>{
              const enabled=input.checked;input.dataset.saving='true';input.disabled=true;
              try {render(await window.whale.action('hook-event',{source:adapter.id,event:match.event,enabled}));$('hooks-feedback').textContent=`${adapter.name} · ${match.event} 已${enabled?'开启':'关闭'}`;}
              catch {input.checked=lastData?.settings.events?.[adapter.id]?.[match.event]!==false;$('hooks-feedback').textContent='设置未保存，请重试。';}
              finally {delete input.dataset.saving;renderHookSettings(lastData);}
            });
            const availability=document.createElement('small');availability.className='event-availability';availability.id=`availability-${adapter.id}-${match.event}`;
            toggle.append(name,input);cell.append(toggle,availability);
          }
          row.append(cell);
        }
        document.querySelector('#hook-event-table tbody').append(row);
      }
    }
    for(const input of document.querySelectorAll('.event-switch input')) {
      const check=data.hookAvailability?.[input.dataset.source];
      const event=check?.events[input.dataset.event];
      const available=check?.state==='checked'&&event?.available;
      if(input.dataset.saving!=='true')input.checked=available&&data.settings.events?.[input.dataset.source]?.[input.dataset.event]!==false;
      const editable=available;
      input.disabled=!data.settings.sources[input.dataset.source]||!editable||input.dataset.saving==='true';
      input.title=check?.state==='checking'?'正在检测…':available?`${event.reason} · ${!data.settings.sources[input.dataset.source]?'来源已暂停':data.settings.events?.[input.dataset.source]?.[input.dataset.event]===false?'接收已关闭':'接收已开启'}`:event?.reason||'尚未检测';
      $(`availability-${input.dataset.source}-${input.dataset.event}`).textContent=input.title;
    }
    for(const adapter of data.hookAdapters) {
      const enabled=Boolean(data.settings.sources[adapter.id]);
      if($(`source-enabled-${adapter.id}`).dataset.saving!=='true')$(`source-enabled-${adapter.id}`).checked=enabled;
      $(`source-caption-${adapter.id}`).textContent=enabled?'接收事件':'已暂停';
      const check=data.hookAvailability?.[adapter.id];
      const count=Object.values(check?.events||{}).filter(event=>event.available).length;
      $(`source-availability-${adapter.id}`).textContent=check?.state==='checking'?'正在检测客户端配置…':`${adapter.id==='cursor'?'已配置':'可接收'} ${count} / ${adapter.mappings.length} 项 · ${check?.message||'尚未检测'}`;
      $(`refresh-hooks-${adapter.id}`).disabled=check?.state==='checking'||$(`refresh-hooks-${adapter.id}`).dataset.saving==='true';
      $(`source-enabled-${adapter.id}`).disabled=check?.state==='checking'||$(`source-enabled-${adapter.id}`).dataset.saving==='true';
      const status=data.sourceStatus[adapter.id];
      $(`source-status-${adapter.id}`).textContent=!enabled ? `已暂停 · 本次启动已忽略 ${status.ignored} 条事件` : status.lastAcceptedAt ? `最近接收：${new Date(status.lastAcceptedAt).toLocaleTimeString('zh-CN')}` : '等待事件 · 本次启动尚未收到有效事件';
    }
  }
  return {render:renderHookSettings};
}
