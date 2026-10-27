'use strict';
const {ImapFlow}=require('imapflow');
const PostalMime=require('postal-mime').default;
const MAX_SOURCE=5*1024*1024;
const DEFAULT_LIMIT=20;
function mailLimit(value) {
  const limit=value===undefined?DEFAULT_LIMIT:Number(value);
  if(!Number.isInteger(limit)||limit<1||limit>100)throw new Error('邮件数量必须为 1–100 的整数。');
  return limit;
}
const PRESETS={feishu:{host:'imap.feishu.cn',port:993},custom:{host:'',port:993}};
// 统一规范化账号与服务器；只有相同连接目标允许留空沿用已保存密码。
function validateConfig(value,previous) {
  if(!value||!Object.hasOwn(PRESETS,value.type))throw new Error('请选择邮箱类型。');
  const email=typeof value.email==='string'?value.email.trim():'';
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)||email.length>254)throw new Error('请输入完整的邮箱地址。');
  const host=value.type==='feishu'?PRESETS.feishu.host:typeof value.host==='string'?value.host.trim().toLowerCase():'';
  if(!/^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/i.test(host)||host.includes('..'))throw new Error('请输入有效的 IMAP 服务器地址，不包含协议或路径。');
  const port=value.type==='feishu'?993:Number(value.port);
  if(!Number.isInteger(port)||port<1||port>65535)throw new Error('IMAP 端口必须为 1–65535。');
  const same=previous?.email===email&&previous?.type===value.type&&previous?.host===host&&previous?.port===port;
  const password=typeof value.password==='string'&&value.password?value.password:same?previous.password:'';
  if(typeof password!=='string'||!password||password.length>4096)throw new Error('请输入邮箱客户端专用密码或授权码。');
  return {type:value.type,email,host,port,password,limit:mailLimit(value.limit)};
}
// 身份不包含密码或保留数量，修改这些设置仍可复用同一收件箱的缓存。
function identity(config){return JSON.stringify([config.email,config.type,config.host,config.port]);}
// 网络库错误可能携带连接信息，只向界面返回固定的脱敏说明。
function mailError(error) {
  if(error?.mailUserError)return error;
  let message='收取邮件失败，请检查网络、IMAP 配置及邮箱服务状态。';
  if(error?.authenticationFailed||error?.serverResponseCode==='AUTHENTICATIONFAILED')message='邮箱认证失败，请检查邮箱地址、客户端专用密码，并确认已开启 IMAP。';
  else if(['CERT_HAS_EXPIRED','DEPTH_ZERO_SELF_SIGNED_CERT','UNABLE_TO_VERIFY_LEAF_SIGNATURE','ERR_TLS_CERT_ALTNAME_INVALID'].includes(error?.code))message='邮箱服务器证书验证失败，请检查服务器地址和证书。';
  else if(['ENOTFOUND','ECONNREFUSED','ETIMEDOUT','CONNECT_TIMEOUT','GREETING_TIMEOUT'].includes(error?.code))message='无法连接邮箱服务器，请检查服务器地址、端口和网络。';
  return new Error(message);
}
function userError(text){const error=new Error(text);error.mailUserError=true;return error;}
// 协议适配层负责 TLS、只读收件箱和 MIME 解析，不负责持久化或界面状态。
function createImapMail({Client=ImapFlow,parse=source=>PostalMime.parse(source)}={}) {
  async function session(config,signal,work) {
    // 禁止关闭证书验证或输出协议日志，避免凭据和邮件正文进入日志。
    const client=new Client({host:config.host,port:config.port,secure:true,tls:{rejectUnauthorized:true,minVersion:'TLSv1.2'},
      auth:{user:config.email,pass:config.password},logger:false,logRaw:false,disableAutoIdle:true,
      connectionTimeout:15000,greetingTimeout:10000,socketTimeout:20000,maxLiteralSize:MAX_SOURCE,maxResponseSize:MAX_SOURCE+1024*1024});
    client.on('error',()=>{});
    const abort=()=>client.close(),timeout=setTimeout(abort,45000);timeout.unref?.();
    signal?.addEventListener('abort',abort,{once:true});let lock;
    try {
      if(signal?.aborted)throw userError('邮箱请求已取消。');
      await client.connect();
      // 只读打开 INBOX，读取正文使用客户端默认的 BODY.PEEK，不修改已读标记。
      lock=await client.getMailboxLock('INBOX',{readOnly:true});
      const result=await work(client);
      if(signal?.aborted)throw userError('邮箱请求已取消。');
      return result;
    }catch(error){throw mailError(error);}
    finally {
      lock?.release();client.close();clearTimeout(timeout);signal?.removeEventListener('abort',abort);
    }
  }
  async function readMessage(client,id) {
    // UID 只在同一个 UIDVALIDITY 内有效，不能用旧编号读取重建后的收件箱。
    const parts=/^(\d+):(\d+)$/.exec(id);
    if(!parts||String(client.mailbox.uidValidity)!==parts[1])throw userError('收件箱标识已变化，请重新收取后选择邮件。');
    const uid=Number(parts[2]);if(!Number.isSafeInteger(uid)||uid<1||uid>4294967295)throw userError('邮件标识无效。');
    // 下载前检查原文大小，下载后再次检查，限制包含附件在内的总响应。
    const size=await client.fetchOne(uid,{size:true},{uid:true});
    if(!size)throw userError('邮件已被移动或删除，请重新收取。');
    if(!Number.isFinite(size.size)||size.size>MAX_SOURCE)throw userError('邮件超过 5 MB，请使用原邮箱查看。');
    const item=await client.fetchOne(uid,{source:true},{uid:true});
    if(!item?.source||item.source.length>MAX_SOURCE)throw userError('邮件无法读取或超过 5 MB，请使用原邮箱查看。');
    const parsed=await parse(item.source);
    return {id,body:parsed.text||'（此邮件没有纯文本正文，请使用原邮箱查看。）',attachments:(parsed.attachments||[]).map(item=>item.filename||'未命名附件')};
  }
  return {
    list:(config,{signal}={})=>session(config,signal,async client=>{
      const limit=mailLimit(config.limit);
      const {exists,uidValidity}=client.mailbox,messages=[];
      if(!uidValidity)throw userError('邮箱服务器未返回有效的收件箱标识。');
      if(exists)for await(const item of client.fetch(`${Math.max(1,exists-limit+1)}:${exists}`,{uid:true,envelope:true})) {
        const envelope=item.envelope||{};
        messages.push({id:`${uidValidity}:${item.uid}`,subject:envelope.subject||'（无主题）',
          from:(envelope.from||[]).map(sender=>[sender.name,sender.address].filter(Boolean).join(' ')).join(', '),
          date:envelope.date instanceof Date?envelope.date.toISOString():''});
      }
      return {messages:messages.reverse(),hasMore:exists>limit,uidValidity:String(uidValidity)};
    }),
    read:(config,id,{signal}={})=>session(config,signal,client=>readMessage(client,id)),
    // 缺失正文共用一个连接；单封失败保留其他结果，后续同步再补齐。
    readMany:(config,ids,{signal}={})=>session(config,signal,async client=>{
      const details=[];
      for(const id of ids) {
        if(signal?.aborted)throw userError('邮箱请求已取消。');
        try{details.push(await readMessage(client,id));}
        catch(error){details.push({id,error:mailError(error).message});}
      }
      return details;
    })
  };
}

// 接收器管理加密缓存、去重和轮询；暂停保留缓存，关闭时清除内存中的账号与正文。
function createMailReceiver({store,imap=createImapMail(),onNew=()=>{},intervalMs=60000}={}) {
  let saved={version:1,enabled:false,config:null,seen:[]},messages=[],state='disconnected',error='',lastChecked=null,hasMore=false;
  // 版本号使暂停、重连后的旧异步结果失效；flight 防止重复同步并发写缓存。
  let timer,closed=false,version=0,flight=null;
  const controllers=new Set();
  function validDetail(item){return item&&typeof item.id==='string'&&typeof item.body==='string'&&Array.isArray(item.attachments)&&item.attachments.every(name=>typeof name==='string');}
  // 兼容没有 cache 字段的旧记录，只恢复当前收件箱和数量限制内的正文。
  function restoreCache() {
    const cache=saved.cache;
    if(saved.removedIds!==undefined&&(!Array.isArray(saved.removedIds)||saved.removedIds.some(id=>typeof id!=='string'||!/^\d+:\d+$/.test(id))))throw Error('本地邮件删除记录无效。');
    // 重启恢复同样应用删除记录，防止旧缓存重新显示已移除的邮件。
    const removed=new Set(saved.removedIds||[]);
    messages=Array.isArray(cache?.messages)?cache.messages.filter(item=>item&&typeof item.id==='string'&&item.id.startsWith(`${saved.uidValidity}:`)&&!removed.has(item.id)).slice(0,saved.config.limit):[];
    const ids=new Set(messages.map(item=>item.id));
    saved.cache={messages,details:Array.isArray(cache?.details)?cache.details.filter(item=>validDetail(item)&&ids.has(item.id)):[],
      lastChecked:Number.isFinite(cache?.lastChecked)?cache.lastChecked:null,hasMore:Boolean(cache?.hasMore)};
    lastChecked=saved.cache.lastChecked;hasMore=saved.cache.hasMore;
  }
  try{const loaded=store.load();if(loaded){loaded.config=validateConfig(loaded.config);saved=loaded;restoreCache();state=loaded.enabled?'disconnected':'paused';}}
  catch{error='邮箱加密配置无法读取，请重新填写连接；原文件已保留。';state='error';}
  // 快照只返回配置标记、列表和计数；密码与正文必须由受限 IPC 主动读取。
  function snapshot(){const config=saved.config;return {state,error,enabled:saved.enabled,email:config?.email||'',
    config:config?{type:config.type,email:config.email,host:config.host,port:config.port,limit:config.limit,hasPassword:true}:null,
    messages:messages.map(item=>({...item})),lastChecked,hasMore,cacheCount:saved.cache?.details.length||0,busy:Boolean(flight)};}
  function clearTimer(){clearTimeout(timer);timer=null;}
  function schedule(){clearTimer();if(!closed&&saved.enabled){timer=setTimeout(()=>void refresh().catch(()=>{}),intervalMs);timer.unref?.();}}
  function abortAll(){for(const controller of controllers)controller.abort();}
  async function request(method,config,value) {
    const controller=new AbortController();controllers.add(controller);
    try {
      if(method==='list')return await imap.list(config,{signal:controller.signal});
      if(method==='read')return await imap.read(config,value,{signal:controller.signal});
      // 兼容只实现单封读取的适配器，取消信号仍覆盖整个补齐过程。
      if(imap.readMany)return await imap.readMany(config,value,{signal:controller.signal});
      const details=[];
      for(const id of value) {
        if(controller.signal.aborted)throw new Error('邮箱请求已取消。');
        try{details.push(await imap.read(config,id,{signal:controller.signal}));}
        catch(error){details.push({id,error:error.message});}
      }
      return details;
    }finally{controllers.delete(controller);}
  }
  // 仅合并成功且仍在当前列表中的正文，失败占位不会覆盖已有缓存。
  function saveDetails(details) {
    const ids=new Set(messages.map(item=>item.id)),byId=new Map((saved.cache?.details||[]).map(item=>[item.id,item]));
    for(const item of details)if(validDetail(item)&&ids.has(item.id))byId.set(item.id,{id:item.id,body:item.body,attachments:item.attachments});
    const next={...saved,cache:{...saved.cache,details:[...byId.values()].filter(item=>ids.has(item.id))}};
    store.save(next);saved=next;
  }
  async function refresh(config) {
    if(closed)throw new Error('邮箱接入已关闭。');
    if(flight||controllers.size){schedule();throw new Error('正在连接或收取邮件，请稍后重试。');}
    if(!config&&!saved.enabled)return snapshot();
    const target=config||saved.config;
    if(!target)throw new Error('请先填写邮箱配置。');
    if(!store.available()){state='error';error='系统安全存储不可用，请恢复后重试，邮箱内容不会以明文保存。';schedule();throw new Error(error);}
    const stamp=version;state='checking';error='';clearTimer();
    flight=(async()=>{
      try {
        const result=await request('list',target);
        if(closed||stamp!==version)return snapshot();
        // 账号、服务器和 UIDVALIDITY 均一致时才复用正文与去重记录。
        const same=saved.config&&identity(saved.config)===identity(target)&&saved.uidValidity===result.uidValidity,seen=new Set(same?saved.seen:[]);
        // 本地删除记录跟随账号与 UIDVALIDITY，刷新时过滤，避免已移除的邮件反复出现。
        const removed=new Set(same?saved.removedIds||[]:[]);
        const recent=result.messages.slice(0,target.limit).filter(item=>!removed.has(item.id)),ids=new Set(recent.map(item=>item.id));
        // 扩大保留数量会读到更早的邮件，仅更高的新 UID 才触发新邮件提醒。
        const lastUid=Math.max(0,...[...seen].map(id=>Number(id.split(':')[1])));
        const fresh=recent.filter(item=>!seen.has(item.id)&&Number(item.id.split(':')[1])>lastUid);
        const cache={messages:recent,details:same?(saved.cache?.details||[]).filter(item=>ids.has(item.id)):[],lastChecked:Date.now(),hasMore:Boolean(result.hasMore)||result.messages.length>target.limit};
        const next={version:1,enabled:true,config:target,uidValidity:result.uidValidity,seen:[...new Set([...recent.map(item=>item.id),...seen])].slice(0,1000),removedIds:[...removed],cache};
        // 先保存列表，再补齐正文；断网或单封读取失败时仍有可用的本地列表。
        store.save(next);saved=next;messages=recent;hasMore=cache.hasMore;lastChecked=cache.lastChecked;
        if(same&&fresh.length)onNew(fresh.length);
        const cached=new Set(cache.details.map(item=>item.id)),missing=recent.filter(item=>!cached.has(item.id)).map(item=>item.id);
        if(missing.length) {
          const details=await request('readMany',target,missing);
          // 暂停或更换连接后，迟到的正文不得再次写入加密记录。
          if(closed||stamp!==version)return snapshot();
          saveDetails(details);
          const failed=messages.length-saved.cache.details.length;
          if(failed)error=`${failed} 封邮件正文暂未缓存，下次同步会重试；已缓存邮件仍可查看。`;
        }
        state='connected';
      }catch(cause){if(!closed&&stamp===version){state='error';error=cause.message;}}
      finally{flight=null;schedule();}
      return snapshot();
    })();
    return flight;
  }
  async function action(name,value) {
    if(closed)throw new Error('邮箱接入已关闭。');
    if(name==='snapshot')return snapshot();
    // 只响应用户主动查看，且必须匹配界面当前账号；主进程另行校验调用窗口。
    if(name==='reveal-password') {
      if(!saved.config||!value||identity(value)!==identity(saved.config))throw new Error('当前邮箱或服务器没有已保存的密码。');
      return {password:saved.config.password};
    }
    if(name==='connect') {
      if(flight||controllers.size)throw new Error('正在连接或收取邮件，请稍后重试。');
      const config=validateConfig(value,saved.config),same=saved.config&&identity(saved.config)===identity(config);
      // 更换目标先清理旧缓存并暂停；新目标连接失败时也不能展示旧账号邮件。
      const next={...saved,enabled:false,config,...(!same?{cache:undefined,uidValidity:undefined,seen:[],removedIds:[]}:{})};
      if(same&&next.cache) {
        const recent=messages.slice(0,config.limit),ids=new Set(recent.map(item=>item.id));
        next.cache={...next.cache,messages:recent,details:next.cache.details.filter(item=>ids.has(item.id)),hasMore:hasMore||messages.length>config.limit};
      }
      // 保存成功后才变更内存和定时器，磁盘或加密失败时保留原连接状态。
      store.save(next);version++;abortAll();clearTimer();saved=next;restoreCache();return refresh(config);
    }
    if(name==='refresh')return refresh();
    if(name==='delete-message') {
      const stamp=version;
      if(flight)await flight;
      // 确认窗口可能跨过重连或切换账号，必须重新校验目标，不能只凭相同的邮件 UID 删除。
      if(closed||stamp!==version||!saved.config||!value?.account||identity(value.account)!==identity(saved.config))throw new Error('邮箱连接已变化，请重新选择邮件。');
      if(typeof value.id!=='string'||!messages.some(item=>item.id===value.id))throw new Error('请从收件箱选择邮件。');
      const recent=messages.filter(item=>item.id!==value.id);
      const next={...saved,removedIds:[...new Set([...(saved.removedIds||[]),value.id])],cache:{...saved.cache,messages:recent,details:(saved.cache?.details||[]).filter(item=>item.id!==value.id)}};
      // 先落盘再更新列表；仅删除本地缓存，IMAP 始终保持只读。
      store.save(next);saved=next;messages=recent;version++;return snapshot();
    }
    if(name==='pause') {
      // 暂停只停止网络接收，已缓存的列表和正文继续支持离线查看。
      version++;abortAll();clearTimer();saved={...saved,enabled:false};state='paused';error='';
      if(saved.config)try{store.save(saved);}catch{error='已暂停接收，但暂停状态无法保存，下次启动可能恢复连接。';}
      return snapshot();
    }
    if(name==='read') {
      if(typeof value!=='string'||!messages.some(item=>item.id===value))throw new Error('请从收件箱选择邮件。');
      const stamp=version;
      // 本地正文优先；缺失时等待正在进行的自动同步，避免重复下载。
      let cached=saved.cache?.details.find(item=>item.id===value);
      if(cached)return {...cached,attachments:[...cached.attachments]};
      if(flight)await flight;
      if(closed||stamp!==version||!messages.some(item=>item.id===value))throw new Error('邮箱连接已改变，请重新选择邮件。');
      cached=saved.cache?.details.find(item=>item.id===value);
      if(cached)return {...cached,attachments:[...cached.attachments]};
      if(!saved.enabled)throw new Error('此邮件正文尚未缓存，请连接邮箱后重试。');
      if(controllers.size)throw new Error('正在收取或读取邮件，请稍后重试。');
      const result=await request('read',saved.config,value);
      if(closed||stamp!==version)throw new Error('邮箱连接已改变，请重新选择邮件。');
      saveDetails([result]);return result;
    }
    throw new Error('不支持的邮箱操作。');
  }
  return {snapshot,action,start(){if(saved.enabled)void refresh().catch(()=>{});},close(){closed=true;version++;clearTimer();abortAll();messages=[];saved={version:1,enabled:false,config:null,seen:[]};}};
}
module.exports={createMailReceiver,createImapMail,validateConfig,MAX_SOURCE,PRESETS};
