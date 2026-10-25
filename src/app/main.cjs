'use strict';
const { app, ipcMain, Notification, shell, clipboard, net, safeStorage, dialog, powerMonitor, Menu, BrowserWindow, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { Activity } = require('../domain/activity.cjs');
const { Behavior } = require('../domain/behavior.cjs');
const SPECIAL_ACTIONS = require('../shared/special-actions.js');
const { createTitleReader, createCursorTitleReader } = require('../clients/chat-metadata.cjs');
const { startBridge, dataDirectory } = require('../hooks/bridge.cjs');
const nurture = require('../../vendor/nurture.cjs');
const {SOURCES,sourceOf,eventName}=require('../shared/hook-events.cjs');
const {createHookSettings}=require('./hook-settings.cjs');
const {createWindows}=require('./windows.cjs');
const {createCursorChatOpener}=require('../clients/cursor-chat.cjs');
const {createCodexChatOpener}=require('../clients/codex-chat.cjs');
const {readClientPresence}=require('../clients/presence.cjs');
const {createCodexRuntime}=require('../clients/codex-runtime.cjs');
const {createWechatApi}=require('../channels/wechat-api.cjs');
const {createWechatStore}=require('../channels/wechat-store.cjs');
const {createWechatManager}=require('../channels/wechat-manager.cjs');
const {avatarFromImage}=require('../channels/wechat-profile.cjs');
const {createMailReceiver}=require('../channels/imap-mail.cjs');
const {createMailStore}=require('../channels/mail-store.cjs');
const {createArcheryPending}=require('../channels/archery-pending.cjs');
const {createQuotaPanel}=require('../channels/quota-accounts.cjs');
const {createGroupUsage}=require('../channels/quota-group-usage.cjs');
const {createKeyUsage}=require('../channels/quota-key-usage.cjs');
const {createShortcutSettings}=require('./shortcut-settings.cjs');
const {createSidebarSettings}=require('./sidebar-settings.cjs');
const {createPlanner}=require('./planner.cjs');
const {createPetQuotaSettings}=require('./pet-quota-settings.cjs');
const {createPetQuota}=require('../channels/pet-quota.cjs');
const {createMessageSubscriptions}=require('../channels/message-subscriptions.cjs');
const {createSubscriptionTranslator}=require('../channels/subscription-translation.cjs');
const {createXSubscriptionReader}=require('./x-subscription-reader.cjs');
const QRCode=require('qrcode');

const dataDir = dataDirectory();
fs.mkdirSync(dataDir, { recursive: true });
app.setPath('userData', dataDir);
app.setName('鲸鱼娘');
if (!app.requestSingleInstanceLock()) { app.quit(); } else {
  let bridge,wechat,mail,archery,quota,groupUsage,keyUsage,petQuota,subscriptions;
  let planner,plannerTimer;
  const plannerNotifications=new Map();
  let eventQueue=Promise.resolve();
  const cursorState=process.env.WHALE_CURSOR_STATE_DB||path.join(os.homedir(),'Library','Application Support','Cursor','User','globalStorage','state.vscdb');
  const cursorChats=createCursorChatOpener({stateFile:cursorState,openExternal:url=>shell.openExternal(url)});
  const codexChats=createCodexChatOpener({openExternal:url=>shell.openExternal(url)});
  let completionExpanded=false,busyExpanded=false,reminderView=null;
  let bridgeError = '';
  const behavior = new Behavior();
  const hooks=createHookSettings({dataDir,cwd:path.resolve(__dirname,'../../..'),onChange:broadcast});
  const shortcuts=createShortcutSettings({dataDir});
  const sidebarSettings=createSidebarSettings({dataDir});
  const petQuotaSettings=createPetQuotaSettings({dataDir});
  const sourceStatus=Object.fromEntries(SOURCES.map(id=>[id,{lastReceivedAt:null,lastAcceptedAt:null,ignored:0}]));
  const titles=createTitleReader();
  const cursorTitles=createCursorTitleReader();
  const remindersFile=path.join(dataDir,'reminders.json');
  let savedReminders,reminderError='';
  try { savedReminders=JSON.parse(fs.readFileSync(remindersFile,'utf8')); } catch {}
  const clientRunning={codex:null,cursor:null};
  let clientCheck;
  const activity = new Activity({sourceRunning:clientRunning,saved:savedReminders,resolveChat:id=>id.startsWith('cursor:')?cursorTitles.lookup(id):titles.lookup(id)});
  const codexRuntime=createCodexRuntime({
    onState:state=>{
      // 和 Hook 使用同一队列；避免跨进程回调把旧审批状态写到新一轮。
      eventQueue=eventQueue.then(()=>{
        if(!canObserveCodexApproval())return;
        if(activity.syncCodexApproval(state)){behavior.task(activity.snapshot());broadcast();}
      }).catch(()=>{});
    },
    onReset:()=>{eventQueue=eventQueue.then(()=>activity.resetCodexApprovalObservations()).catch(()=>{});}
  });
  function saveReminders() {
    try {
      fs.writeFileSync(remindersFile+'.tmp',JSON.stringify(activity.exportState()),{mode:0o600});
      fs.renameSync(remindersFile+'.tmp',remindersFile);
      reminderError='';
    } catch { reminderError='提醒暂时无法保存，退出桌宠后可能丢失。'; }
  }
  nurture.setSaveDir(dataDir);
  nurture.load();

  const windows=createWindows({snapshot,performAction,rankingSnapshot:id=>petQuota.rankingSnapshot(id),rankingRefresh:id=>petQuota.refreshRanking(id),rankingSelect:(groupId,id)=>petQuota.selectRankingGroup(groupId,id),collapseReminders:()=>{
    if(completionExpanded||busyExpanded) { completionExpanded=false;busyExpanded=false;broadcast(); }
  }});
  const {showPanel,showReminders,showPlanner}=windows;

  function syncPlannerNotifications() {
    const summary=planner?.summary();
    // 时段结束、开始处理或本轮 token 改变后主动撤回旧通知，避免系统通知中心留下失效入口。
    for(const [id,entry] of plannerNotifications)if(!summary?.notifications||(entry.finished?summary.now>=entry.windowEnd||!planner.isAllowed(entry.reminderId):!summary.active.some(item=>item.id===id&&item.token===entry.token&&item.state==='waiting'))) {
      entry.notice.close();plannerNotifications.delete(id);
    }
  }
  function tickPlanner() {
    try{planner?.tick();}catch{/* 保存失败由快照显示，保留上次已落盘状态以便重试。 */}
    syncPlannerNotifications();broadcast();
  }

  // 客户端退出只隐藏提醒并清理实时任务，重新打开不会重放通知或成长。
  function refreshClients() {
    if(clientCheck)return clientCheck;
    clientCheck=readClientPresence().then(result=>{
      if(!result)return null; // 检测失败不是退出，保留上次有效状态。
      let changed=false,closed=false;
      for(const source of SOURCES) {
        clientRunning[source]=result[source];
        const update=activity.setSourceRunning(source,result[source]);
        changed=update||changed;closed=(update&&!result[source])||closed;
      }
      if(changed) {
        if(closed) {const tasks=activity.snapshot();behavior.task({...tasks,state:tasks.pending||tasks.working?tasks.state:'idle'});}
        broadcast();
      }
      return result;
    }).finally(()=>{clientCheck=null;});
    return clientCheck;
  }

  function snapshot() {
    // 两个窗口共享同一份主进程状态，避免小屋和悬浮桌宠各自计时、各自累计成长。
    const tasks = activity.snapshot();
    return { planner:planner?.summary()||null,subscriptions:subscriptions?.summary()||null,trackingRows:petQuotaSettings.snapshot().trackingConfigs.length, petVisible:windows.isPetVisible(),shortcuts:shortcuts.snapshot(),wechat:wechat?.snapshot()||null,hookAdapters:hooks.adapters,hookAvailability:hooks.availability,sourceStatus,codexApprovalSync:codexRuntime.snapshot(),clientRunning:{...clientRunning},completionExpanded, busyExpanded, reminderView, settings:hooks.settings, nurture: nurture.snapshot(), activity: tasks, ...behavior.snapshot(), bridge: Boolean(bridge), bridgeError, reminderError };
  }
  function canObserveCodexApproval() {
    return hooks.settings.sources.codex&&hooks.settings.events.codex?.PermissionRequest!==false&&clientRunning.codex===true&&
      hooks.availability.codex.state==='checked'&&hooks.availability.codex.events.PermissionRequest?.available;
  }
  function broadcast() {
    // 三条以内由界面自动展示；清除手动展开标记，避免再次增到四条时沿用旧的展开状态。
    if (activity.snapshot().unread<=3) completionExpanded=false;
    if (activity.snapshot().working<=3) busyExpanded=false;
    const tasks=activity.snapshot();
    codexRuntime.setSessions(canObserveCodexApproval()
      ?tasks.sessions.filter(s=>!s.session_id.startsWith('cursor:')&&['working','thinking','approval'].includes(s.state)):[]);
    if((reminderView==='pending'&&!tasks.pending)||(reminderView==='completed'&&!tasks.unread)||(reminderView==='busy'&&!tasks.working))reminderView=null;
    windows.broadcast(snapshot());
  }
  async function openChat(sessionId,noticeId) {
    // 跳转前重新确认客户端，避免点击旧提醒时把已经退出的应用重新唤起。
    const known=activity.sessions.has(sessionId)||activity.notices.some(item=>item.session_id===sessionId);
    const source=typeof sessionId==='string'&&sessionId.startsWith('cursor:')?'cursor':'codex';
    if(!known)throw new Error('无法定位这个聊天');
    const running=await refreshClients();
    if(!running)throw new Error('暂时无法确认客户端是否运行，请稍后重试；提醒已保留。');
    if(!running[source])throw new Error(`${source==='cursor'?'Cursor':'Codex'} 已退出，提醒暂时隐藏，重新打开后恢复。`);
    if(sessionId?.startsWith('cursor:')) {
      if(!known||cursorTitles.lookup(sessionId).kind!=='chat')throw new Error('无法定位这个 Cursor 聊天，可能已被删除。');
      await cursorChats.open(sessionId);
      if(activity.acknowledgeCursor(sessionId))saveReminders();
    } else {
      // 桌宠任务入口统一查看最新内容；不能只在待审批时定位，否则执行中和完成通知仍可能回到开头。
      await codexChats.open(sessionId,{title:titles.title(sessionId)||''});
      if(activity.notices.some(item=>item.id===noticeId&&item.session_id===sessionId)) {
        activity.markRead(noticeId);saveReminders();
      }
    }
    broadcast();
  }
  ipcMain.handle('snapshot', () => snapshot());
  // 小屋按钮和右键菜单共用入口，统一动作锁定、成长和窗口同步。
  async function performAction(action, value) {
    // 连击只提交手势，实际动作以主进程已保存的白名单配置为准。
    if(action==='shortcut-triple') {
      const target=shortcuts.snapshot().tripleClick;
      return target==='none'?snapshot():performAction(target);
    }
    if (['feed','pat','touch','happy','angry'].includes(action) || Object.hasOwn(SPECIAL_ACTIONS, action)) {
      if (behavior.interact(action)) {
        if (action === 'feed') nurture.feed(); else if (!Object.hasOwn(SPECIAL_ACTIONS, action)) nurture.pat();
      }
    } else if (action === 'demo') {
      // 演示只操作动画状态，不经过真实事件统计，也不增加工作成长值。
      behavior.setCycle(false); behavior.showDemo(value);
    } else if (action === 'cycle' && typeof value === 'boolean') {
      behavior.setCycle(value);
    } else if (action==='copy-hook-config') {
      const adapter=hooks.adapters.find(item=>item.id===value);
      if(!adapter)throw new Error('未知来源');
      clipboard.writeText(adapter.config);
    } else if (action==='refresh-hooks') {
      if(!SOURCES.includes(value))throw new Error('未知来源');
      await hooks.refresh(value);
    } else if (action==='hook-source'||action==='hook-event') {
      await hooks.update(value,action==='hook-event');
      if(!value.enabled&&action==='hook-source') {
        activity.pauseSource(value.source);
        const tasks=activity.snapshot();
        behavior.task({...tasks,state:tasks.pending||tasks.working?tasks.state:'idle'});
      }
    } else if (['sound', 'notifications', 'showPanelOnStartup'].includes(action) && typeof value === 'boolean') {
      hooks.setPreference(action,value);
    } else if (action === 'open-completion') {
      const tasks=activity.snapshot();
      const switching=(reminderView||(busyExpanded?'busy':tasks.pending?'pending':tasks.unread?'completed':tasks.working?'busy':'completed'))!=='completed';
      reminderView='completed';busyExpanded=false;
      const count=tasks.notices.length;
      if(switching) {completionExpanded=count>3;broadcast();return snapshot();}
      if(count>1) { completionExpanded=count>3?!completionExpanded:false;broadcast();return snapshot(); }
      // 点击时读取最新提醒，避免界面刚更新时跳到旧对话；仅在跳转成功后标记对应条目。
      const latest=activity.snapshot().notices[0];
      if(latest) {
        try { await openChat(latest.session_id,latest.id); }
        catch(error) { reminderError=error.message;showReminders(); }
      } else showReminders();
    } else if(action==='open-pending') {
      reminderView='pending';completionExpanded=false;busyExpanded=false;
    } else if (action === 'open-busy') {
      const tasks=activity.snapshot();
      // 默认分类与浮窗一致：待处理、已完成、执行中；切换分类先展示列表，不直接跳转。
      const switching=(reminderView||(busyExpanded?'busy':tasks.pending?'pending':tasks.unread?'completed':tasks.working?'busy':'completed'))!=='busy';
      reminderView='busy';completionExpanded=false;
      if(switching) {busyExpanded=tasks.working>3;broadcast();return snapshot();}
      const busy=activity.snapshot().sessions.filter(item=>['thinking','working'].includes(item.state));
      if(busy.length>1) busyExpanded=busy.length>3?!busyExpanded:false;
      else if(busy.length===1) {
        busyExpanded=false;
        try { await openChat(busy[0].session_id); }
        catch(error) {reminderError=error.message;showReminders();}
      } else busyExpanded=false;
    } else if (action === 'close-completions') { completionExpanded=false;busyExpanded=false;reminderView=null; }
    else if (action === 'reminders') showReminders();
    else if (action === 'planner') showPlanner();
    else if (action === 'read-notice' && typeof value === 'string') { activity.markRead(value);saveReminders(); }
    else if (action === 'open-chat') { await openChat(value?.sessionId,value?.noticeId); }
    else if (action === 'panel') showPanel();
    else if (action === 'toggle-pet') windows.isPetVisible()?windows.hidePet():windows.showPet();
    else if (action === 'show-pet') windows.showPet();
    else if (action === 'hide-pet') windows.hidePet();
    else if (action === 'quit') app.quit();
    broadcast();
    return snapshot();
  }
  ipcMain.handle('action', (_event, action, value) => performAction(action, value));
  // 完整工作备注仅由小屋读取；桌宠只接收当前提醒及受限的处理动作。
  ipcMain.handle('planner',(event,name,value)=>{
    const panel=windows.isPanel(event.sender),pet=windows.isPet(event.sender);
    if((!panel&&!pet)||event.senderFrame!==event.sender.mainFrame)throw Error('不允许访问日程备忘');
    if(!planner)return {error:'日程备忘正在初始化'};
    if(!panel&&!['start','complete'].includes(name))return {error:'仅允许在小屋管理日程备忘'};
    try{const result=planner.action(name,value);return {value:panel?result:planner.summary()};}
    catch(error){return {error:error.message};}
  });
  // 菜单布局仅允许小屋主框架读写，悬浮桌宠与子框架不能修改。
  ipcMain.handle('sidebar-settings',(event,value)=>{
    if(!windows.isPanel(event.sender)||event.senderFrame!==event.sender.mainFrame)throw new Error('仅允许在小屋整理菜单');
    return value===undefined?sidebarSettings.snapshot():sidebarSettings.update(value);
  });
  ipcMain.handle('shortcut-settings',(event,value)=>{
    if(!windows.isPanel(event.sender)||event.senderFrame!==event.sender.mainFrame)throw new Error('仅允许在小屋配置快捷操作');
    shortcuts.update(value);broadcast();return snapshot();
  });
  ipcMain.handle('wechat', async(event,name,value)=>{
    if(!windows.isPanel(event.sender)||event.senderFrame!==event.sender.mainFrame)throw new Error('仅允许在小屋配置微信');
    if(!wechat)throw new Error('微信接入正在初始化');
    if(name==='pick-directory') {
      const result=await dialog.showOpenDialog({properties:['openDirectory']});
      return {path:result.canceled?'':result.filePaths[0]};
    }
    try{return {value:await wechat.action(name,value)};}
    catch(error){return {error:error.message};}
  });
  // 邮箱列表、正文和主动查看密码仅开放给小屋主框架，不向桌宠窗口或子框架暴露。
  ipcMain.handle('mail',async(event,name,value)=>{
    if(!windows.isPanel(event.sender)||event.senderFrame!==event.sender.mainFrame)throw new Error('仅允许在小屋读取邮箱');
    if(!mail)return {error:'邮箱接入正在初始化'};
    try{return {value:await mail.action(name,value)};}catch(error){return {error:error.message};}
  });
  // 订阅正文只向小屋主框架开放；远程采集页没有 preload，也不能借用此通道。
  ipcMain.handle('message-subscriptions',async(event,name,value)=>{
    if(!windows.isPanel(event.sender)||event.senderFrame!==event.sender.mainFrame)throw Error('仅允许在小屋查看消息订阅');
    if(!subscriptions)return {error:'消息订阅正在初始化'};
    try {
      let result;
      switch(name) {
        case 'snapshot':result=subscriptions.snapshot();break;
        case 'add':result=subscriptions.add(value);break;
        case 'set-enabled':result=subscriptions.setEnabled(value);break;
        case 'set-remark':result=subscriptions.setRemark(value);break;
        // 推荐理由与关注状态独立，未关注时也允许保存。
        case 'set-recommendation-reason':result=subscriptions.setRecommendationReason(value);break;
        case 'remove':result=subscriptions.remove(value);break;
        case 'clear-cache':result=subscriptions.clearCache();break;
        case 'mark-read':result=subscriptions.markRead(value);break;
        case 'delete-post':result=subscriptions.deletePost(value);break;
        case 'refresh':result=await subscriptions.refresh();break;
        case 'translate':result=await subscriptions.translate(value);break;
        case 'copy-menu': {
          // 只根据账号和消息 ID 读取本地原文或译文，忽略页面传入的正文；折叠时也复制完整内容。
          const post=subscriptions.snapshot().posts.find(p=>p.username===value?.username && p.id===value?.id);
          if(!post)throw Error('消息不存在。');
          const text=value.translation===true ? post.translation?.text : post.text;
          if(typeof text!=='string' || !text)throw Error('没有可复制的内容。');
          // 右键仅打开菜单，用户选择后才写入纯文本剪贴板，不改变阅读进度或页面状态。
          Menu.buildFromTemplate([{label:'复制内容',click:()=>clipboard.writeText(text)}])
            .popup({window:BrowserWindow.fromWebContents(event.sender)});
          break;
        }
        case 'open-post':
          await shell.openExternal(subscriptions.postUrl(value));
          result=subscriptions.markRead(value);break;
        case 'open-profile': {
          const account=subscriptions.snapshot().accounts.find(a=>a.username===value);
          if(!account)throw Error('订阅账号不存在。');
          await shell.openExternal(`https://x.com/${account.username}`);result=subscriptions.snapshot();break;
        }
        default:throw Error('不支持的订阅操作');
      }
      return {value:result};
    }catch(error){return {error:error.message};}
  });
  // Archery 仅向小屋主框架开放，逐笔审批还须由主进程弹框确认。
  ipcMain.handle('archery',async(event,name,value)=>{
    if(!windows.isPanel(event.sender)||event.senderFrame!==event.sender.mainFrame)throw new Error('仅允许在小屋查看 Archery');
    if(!archery)return {error:'Archery 接入正在初始化'};
    try{return {value:await archery.action(name,value)};}catch(error){return {error:error.message};}
  });
  // 额度页只读网关已保存的快照，token 不进入渲染进程，也不刷新上游额度。
  ipcMain.handle('quota',async(event,name,value)=>{
    if(!windows.isPanel(event.sender)||event.senderFrame!==event.sender.mainFrame)throw new Error('仅允许在小屋查看额度');
    if(!quota)return {error:'额度页面正在初始化'};
    if(!['snapshot','refresh','set-refresh','set-interval','set-list'].includes(name))return {error:'不支持的额度操作'};
    try{return {value:name==='set-interval'?quota.setRefreshInterval(value):name==='set-list'?quota.setListSettings(value):name==='set-refresh'?quota.setRefreshEnabled(value):name==='refresh'?await quota.refresh():quota.snapshot()};}catch(error){return {error:error.message};}
  });
  ipcMain.handle('quota-group',async(event,name,value)=>{
    if(!windows.isPanel(event.sender)||event.senderFrame!==event.sender.mainFrame)throw new Error('仅允许在小屋查看分组用量');
    if(['keys-snapshot','keys-open','keys-search','keys-select','keys-refresh','keys-set-expanded'].includes(name)) {
      // Key 消费与用户排行共用受限 IPC 入口，但账号选择、缓存及刷新流程互相独立。
      if(!keyUsage)return {error:'Key 用量正在初始化'};
      try{return {value:name==='keys-set-expanded'?keyUsage.setExpanded(value):name==='keys-search'?await keyUsage.search(value):name==='keys-select'?await keyUsage.select(value):name==='keys-refresh'?await keyUsage.refresh():name==='keys-open'?await keyUsage.open():keyUsage.snapshot()};}
      catch{return {error:'无法读取 Key 用量，请稍后重试。'};}
    }
    if(!groupUsage)return {error:'分组用量正在初始化'};
    if(!['snapshot','open','refresh','select','set-expanded'].includes(name))return {error:'不支持的分组用量操作'};
    try{return {value:name==='set-expanded'?groupUsage.setExpanded(value):name==='select'?await groupUsage.select(value):name==='refresh'?await groupUsage.refresh(value):name==='open'?await groupUsage.open():groupUsage.snapshot()};}
    catch{return {error:'无法读取分组用量，请检查组 ID 后重试。'};}
  });
  ipcMain.handle('pet-quota',async(event,name,value)=>{
    const panel=windows.isPanel(event.sender),pet=windows.isPet(event.sender);
    if((!panel&&!pet)||event.senderFrame!==event.sender.mainFrame)throw Error('不允许读取桌宠额度');
    if(!petQuota)return {error:'桌宠额度正在初始化'};
    if(['update','update-config','copy-config','delete-config'].includes(name)) {
      if(!panel)throw Error('仅允许在小屋修改流量跟踪配置');
      try {
        if(name==='copy-config')petQuota.copyConfig(value ?? 'primary');
        else if(name==='delete-config')petQuota.deleteConfig(value);
        else if(name==='update-config')petQuota.updateConfig(value?.id,value?.patch);
        else {
          if(value?.accountId!=null&&!quota.snapshot().accounts.some(account=>account.id===value.accountId))throw Error('请选择有效账号');
          if(value&&Object.keys(value).some(key=>['trackingConfigs','nextConfigId'].includes(key)))throw Error('请使用配置操作');
          petQuota.updateSettings(value);
        }
      }catch(error){return {error:error.message};}
    } else if(name==='ranking'&&pet) {
      try {petQuota.rankingSnapshot(value ?? 'primary');await windows.toggleRanking(value ?? 'primary');return {value:true};}catch(error){return {error:error.message};}
    } else if(name==='refresh'&&pet) {
      try{return {value:await petQuota.refresh(value ?? 'primary')};}catch(error){return {error:error.message};}
    } else if(name==='choose-account'&&pet) {
      try {
        // 副配置选择窗只列出可用账号；主配置保留完整选择范围。
        const id=value ?? 'primary',selected=petQuota.accountIdFor(id),accounts=petQuota.availableAccounts(id);
        if(!accounts.length)throw Error(quota.snapshot().accounts.length ? '没有可用的跟踪账号，其他账号已被配置占用' : '暂无可选账号，请先在 API 额度中同步账号');
        if(accounts.length===1)return {value:petQuota.snapshot(),message:'哎呀，其他账号都在展示啦，暂时没得换咯～'};
        const accountId=await windows.chooseTrackingAccount(accounts,selected);
        return {value:accountId===null?petQuota.snapshot():petQuota.selectAccount(accountId,id)};
      }catch(error){return {error:error.message};}
    } else if(name!=='snapshot')return {error:'不支持的桌宠额度操作'};
    const data=petQuota.snapshot();
    // 完整账号选项由小屋和独立选择窗读取；人物窗口只拿选中账号和排行前五。
    if(panel)data.accounts=quota.snapshot().accounts.map(({id,name})=>({id,name}));
    return {value:data};
  });
  app.on('before-quit', () => { subscriptions?.close();petQuota?.close();keyUsage?.close();groupUsage?.close();quota?.close();archery?.close();mail?.close();wechat?.close();codexRuntime.close();bridge?.close(); titles.close();cursorTitles.close(); });
  app.whenReady().then(async () => {
    // 先确认客户端运行状态，再过滤临时会话、同步已读，避免清掉退出时暂存的提醒。
    await refreshClients();
    activity.reconcile(titles.readState());
    if(savedReminders)saveReminders();
    windows.start({showPanelOnStartup:hooks.settings.showPanelOnStartup});
    planner=createPlanner({dataDir,onChange:()=>{syncPlannerNotifications();broadcast();},onDue:(item,preferences)=>{
      if(preferences.notifications&&Notification.isSupported()) {
        const notice=new Notification({title:'deepsleep · 日程提醒',body:item.title+(item.processMinutes?` · 准备好后开始处理 ${item.processMinutes} 分钟`:' · 完成后再开始下一轮'),silent:true});
        notice.on('click',showPlanner);plannerNotifications.set(item.id,{notice,token:item.run.token});notice.show();
      }
      if(preferences.sound)windows.chime();
    },onFinished:(item,preferences)=>{
      if(preferences.notifications&&Notification.isSupported()) {
        const key=item.id+':finished';plannerNotifications.get(key)?.notice.close();
        const notice=new Notification({title:'deepsleep · 处理结束',body:`${item.title} · ${item.processMinutes} 分钟处理已结束，下一轮已安排。`,silent:true});
        notice.on('click',showPlanner);plannerNotifications.set(key,{notice,finished:true,reminderId:item.id,windowEnd:item.run.windowEnd});notice.show();
      }
      if(preferences.sound)windows.chime();
    }});
    // 计时统一由主进程推进；关闭小屋不影响进度，唤醒时立即按持久化状态补算。
    tickPlanner();plannerTimer=setInterval(tickPlanner,1000);
    powerMonitor.on('resume',tickPlanner);
    app.once('before-quit',()=>{clearInterval(plannerTimer);powerMonitor.removeListener('resume',tickPlanner);for(const {notice} of plannerNotifications.values())notice.close();plannerNotifications.clear();});
    wechat=createWechatManager({store:createWechatStore({dataDir,safeStorage}),
      normalizeAvatar:bytes=>avatarFromImage(bytes,nativeImage),
      api:createWechatApi({fetchImpl:(url,options)=>net.fetch(url,options)}),
      makeQr:text=>QRCode.toDataURL(text,{width:256,margin:2,errorCorrectionLevel:'M'}),onChange:broadcast});
    wechat.start();
    // 邮件提醒只包含数量，正文、主题和发件人不进入系统通知或桌宠广播。
    mail=createMailReceiver({store:createMailStore({dataDir,safeStorage}),onNew:count=>{
      if(hooks.settings.notifications&&Notification.isSupported()) {
        const notice=new Notification({title:'deepsleep · 邮箱',body:`收到 ${count} 封新邮件，打开小屋查看。`,silent:!hooks.settings.sound});
        notice.on('click',showPanel);notice.show();
      }
    }});
    mail.start();
    archery=createArcheryPending({settingsFile:path.join(dataDir,'archery.json'),openExternal:url=>shell.openExternal(url),confirmApproval:async item=>{
      const result=await dialog.showMessageBox({type:'question',title:'确认审核通过',
        message:`审核通过工单 #${item.id}？`,
        detail:`${item.title}\n提交人：${item.submitter||'—'}\n实例：${item.instance||'—'}\n数据库：${item.database||'—'}\n\n仅审核这一笔工单，不请求执行 SQL。`,
        buttons:['取消','审核通过'],defaultId:0,cancelId:0,noLink:true});
      return result.response===1;
    }});
    archery.start();
    quota=createQuotaPanel({dataDir,tokenFile:process.env.WHALE_QUOTA_TOKEN_FILE||path.join(__dirname,'../../token'),fetchImpl:(url,options)=>net.fetch(url,options)});
    groupUsage=createGroupUsage({dataDir,tokenFile:process.env.WHALE_QUOTA_TOKEN_FILE||path.join(__dirname,'../../token'),fetchImpl:(url,options)=>net.fetch(url,options)});
    keyUsage=createKeyUsage({dataDir,tokenFile:process.env.WHALE_QUOTA_TOKEN_FILE||path.join(__dirname,'../../token'),fetchImpl:(url,options)=>net.fetch(url,options)});
    petQuota=createPetQuota({settings:petQuotaSettings,quota,groups:groupUsage});petQuota.start();
    subscriptions=createMessageSubscriptions({dataDir,readPosts:createXSubscriptionReader(),
      translateText:createSubscriptionTranslator({fetchImpl:(url,options)=>net.fetch(url,options)}),onChange:broadcast});
    subscriptions.start();
    // 休眠期间不积压轮询；唤醒只补查已到期账号，正常的一小时节奏保持不变。
    powerMonitor.on('resume',()=>void subscriptions.checkDue());
    for(const source of SOURCES)void hooks.refresh(source);
    try {
      const acceptEvent = event => {
        // 先校验和去重，再更新动作、成长和通知，防止重复 Stop 产生多次副作用。
        const source=sourceOf(event),status=sourceStatus[source];
        status.lastReceivedAt=Date.now();
        if(!hooks.settings.sources[source]) {status.ignored++;broadcast();return;}
        if(hooks.settings.events[source]?.[eventName(event)]===false||hooks.availability[source].state!=='checked'||!hooks.availability[source].events[eventName(event)]?.available) {
          status.ignored++;
          // 结束和工具返回仍清理跟踪，避免关闭提醒后卡在工作中；不产生完成、成长或通知。
          if(['Stop','Interrupt','SessionEnd','PostToolUse'].includes(event.hook_event_name)) {
            activity.pauseSession(event.session_id,event.turn_id);
            const tasks=activity.snapshot();behavior.task({...tasks,state:tasks.pending||tasks.working?tasks.state:'idle'});
          }
          broadcast();return;
        }
        const accepted = activity.accept(event);
        if (!accepted) return;
        status.lastAcceptedAt=Date.now();
        if(['Stop','UserPromptSubmit'].includes(accepted.hook_event_name))saveReminders();
        if(clientRunning[source]===false) {broadcast();return;}
        behavior.task(activity.snapshot());
        // completed 仅代表一轮回复结束，不代表任务整体成功或测试通过。
        if (accepted.state === 'completed') nurture.workCompleted();
        if (accepted.state==='completed' || accepted.hook_event_name==='PermissionRequest') {
          const tasks=activity.snapshot();
          const remaining=tasks.working+tasks.pending;
          const text = accepted.state === 'completed'
            ? `「${accepted.title}」本轮已结束 · ${remaining ? `还有 ${remaining} 个聊天在进行` : '当前没有其他活动聊天'}${tasks.pending ? `（${tasks.pending} 个在检查权限）` : ''}`
            : `「${accepted.title}」有操作进入权限检查，可能需要你确认。`;
          if (hooks.settings.notifications && Notification.isSupported()) {
            const notice = new Notification({ title: `deepsleep · ${source==='cursor'?'Cursor':'Codex'} 提醒`, body: text, silent: !hooks.settings.sound });
            const completionId=accepted.state==='completed'?tasks.notices[0]?.id:undefined;
            notice.on('click', () => openChat(accepted.session_id,completionId).catch(error=>{reminderError=error.message;showReminders();broadcast();})); notice.show();
          }
          if (hooks.settings.sound) windows.chime();
        }
        broadcast();
      };
      bridge = await startBridge(dataDir, event => {
        // 排队检测并接收，避免异步进程查询改变 Hook 的到达顺序。
        eventQueue=eventQueue.then(async()=>{await refreshClients();acceptEvent(event);}).catch(()=>{bridgeError='事件处理失败，请重试。';broadcast();});
      },packet=>cursorChats.receive(packet));
    } catch (error) { bridgeError = error.message; }
    broadcast();
    setInterval(broadcast, 200);
    // 每三秒定时检测，减少反复启动 ps 的开销；启动、接收 Hook 和跳转前仍即时检测。
    setInterval(()=>void refreshClients(),3000);
    setInterval(()=>{
      // Cursor 保存的是上次选中项，不能证明用户看过新结果；这里只同步 Codex 原生已读状态。
      if(activity.reconcile(titles.readState())) { saveReminders();broadcast(); }
    },1000);
    setInterval(() => { nurture.tick(10); broadcast(); }, 10 * 60 * 1000);
  });
}
