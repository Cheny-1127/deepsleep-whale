'use strict';
const {randomUUID}=require('node:crypto');
const {createWechatGateway}=require('./wechat-gateway.cjs');
const {fresh,migrate}=require('./wechat-store.cjs');
const {profileText,userProfile}=require('./wechat-profile.cjs');
const LIMIT=8;
const liveStates=new Set(['queued','running','approval','question','recovering']);
function displayName(value='') {
  if(typeof value!=='string'||Array.from(value.trim()).length>40||/[\u0000-\u001f\u007f]/.test(value))throw Error('备注名请使用 40 字以内的单行文字。');
  return value.trim();
}

function createWechatManager({store,onChange=()=>{},...options}) {
  let records=[],selected='',loadError='',storageError='',closed=false,started=false,locked=false;
  const gateways=new Map();
  try {
    const value=store.load();
    if(value.version===3) {
      if(!Array.isArray(value.connections)||!value.connections.length||value.connections.length>LIMIT)throw Error('微信多账号数据格式无法识别，原文件已保留');
      const ids=new Set(),bots=new Set();
      records=value.connections.map(item=>{
        if(!item||typeof item.id!=='string'||!item.id||ids.has(item.id))throw Error('微信连接标识重复或缺失，原文件已保留');
        ids.add(item.id);const state=migrate(item.state);
        if(state.account) {
          if(typeof state.account.id!=='string'||!state.account.id||bots.has(state.account.id))throw Error('微信账号重复或缺失，原文件已保留');
          bots.add(state.account.id);
        }
        if(item.contactNames!==undefined&&(item.contactNames===null||typeof item.contactNames!=='object'||Array.isArray(item.contactNames)))throw Error('微信联系人备注名格式无法识别，原文件已保留');
        return {id:item.id,state,name:displayName(item.name),...(item.profile!==undefined?{profile:userProfile(item.profile)}:{}),contactNames:Object.fromEntries(Object.entries(item.contactNames||{}).map(([sender,name])=>[sender,displayName(name)]))};
      });
      if(!ids.has(value.selectedConnectionId))throw Error('微信选中连接不存在，原文件已保留');
      selected=value.selectedConnectionId;
    } else {
      // 只包装原有状态，不重新登录或丢弃游标、会话、任务及待投递结果。
      records=[{id:'wechat-legacy',state:migrate(value)}];selected=records[0].id;
    }
  } catch(error) {loadError=error.message;}
  function envelope(items=records,selection=selected){return {version:3,selectedConnectionId:selection,connections:items.map(({id,state,name,contactNames,profile})=>({id,state,...(name?{name}:{}),...(contactNames?{contactNames}:{}),...(profile?{profile}:{})}))};}
  function save(items=records,selection=selected) {
    if(loadError||storageError||closed)throw Error(loadError||storageError||'微信接入已关闭');
    try {store.save(envelope(items,selection));}
    catch {
      storageError='微信状态无法安全保存，已停止所有微信连接；请检查存储后重启。';
      // 不用其他连接的新状态覆盖失败现场，也不在失败后继续接收新任务。
      queueMicrotask(()=>{for(const gateway of gateways.values())gateway.close();onChange();});
      throw Error(storageError);
    }
  }
  const execution={
    busy:()=>locked,
    // 按网关内存中的恢复状态计数；暂停账号尚未落盘的旧排队记录已中断，不应继续占名额。
    count:()=>[...gateways.values()].reduce((sum,gateway)=>sum+gateway.schedulingState().jobs.filter(job=>liveStates.has(job.state)).length,0),
    acquire(id,job) {
      if(locked||closed||storageError)return null;
      // 所有连接共用执行锁；按最早入队时间选下一项，恢复跟踪优先于尚未执行的任务。
      const candidates=[...gateways].flatMap(([id,gateway])=>{const state=gateway.schedulingState();return state.enabled&&state.connected?state.jobs.filter(item=>['queued','recovering'].includes(item.state)).map(job=>({id,job})):[];});
      candidates.sort((a,b)=>(a.job.state==='recovering'?0:1)-(b.job.state==='recovering'?0:1)||a.job.startedAt-b.job.startedAt);
      if(candidates[0]&&(candidates[0].id!==id||candidates[0].job.id!==job.id))return null;
      locked=true;let released=false;
      return ()=>{if(released)return;released=true;locked=false;queueMicrotask(()=>{for(const gateway of gateways.values())gateway.wake();});};
    }
  };
  function attach(record) {
    const checkOwner=sender=>{
      if(!records.includes(record)||!record.state.enabled||record.state.account?.stale||record.state.account?.owner!==sender||!record.state.allowed.includes(sender))throw Error('仅扫码账号本人可以修改用户信息。');
    };
    // 子网关只读写自己的状态副本；由管理器统一加密落盘，避免覆盖另一账号或删除共享文件。
    const gateway=createWechatGateway({...options,execution:{...execution,acquire:job=>execution.acquire(record.id,job)},
      userInfo:{read:sender=>{checkOwner(sender);return {...userProfile(record.profile),remark:record.name||''};},
        update:(sender,field,value)=>{
          checkOwner(sender);let patch;
          if(field==='remark')patch={name:displayName(value)};
          else if(field==='nickname'||field==='avatar')patch={profile:userProfile({...userProfile(record.profile),[field]:field==='nickname'?profileText(value):value})};
          else throw Error('该设置暂未开放。');
          // 资料只改展示元数据；先安全保存，成功后才更新内存，轮询不会覆盖昵称或头像。
          save(records.map(item=>item===record?{...item,...patch}:item));Object.assign(record,patch);onChange();
        }},
      // 恢复当前连接时不提交它的旧 token，确保服务端签发新凭据；其他连接仍参与重复绑定检测。
      loginTokens:()=>[...new Set(records.filter(other=>other!==record).map(other=>other.state.account?.token).filter(Boolean))].slice(-10),
      validateAccount:(id,owner)=>{
        // 已有重复条目不在登录回调中自动合并，避免未经核对就覆盖两边的配置和任务记录。
        if(records.some(other=>other!==record&&other.state.account?.id===id))throw Error('这个微信已接入，请切换到已有连接。');
        const previous=record.state.account;
        // 机器人 ID 可在重新授权后变化；以已保存的扫码用户确认是本人，不能仅凭机器人 ID 继承操作权限。
        if(previous&&(previous.owner?previous.owner!==owner:previous.id!==id))throw Error('重新扫码只恢复当前微信；请使用原微信扫码，或用“添加微信”接入另一个号。');
        return Boolean(previous);
      },
      store:{available:()=>store.available(),load:()=>structuredClone(record.state),
        save:value=>{
          if(!records.includes(record))return;
          // 网关保存通信状态时必须保留管理器上的备注名，避免下一次轮询把展示元数据抹掉。
          const state=structuredClone(value),items=records.map(item=>item===record?{...item,state}:item);
          save(items);record.state=state;
        },remove:()=>{throw Error('请通过账号管理解绑指定微信。');}},onChange});
    gateways.set(record.id,gateway);return gateway;
  }
  for(const record of records)attach(record);
  function snapshot() {
    const current=gateways.get(selected)?.snapshot()||{status:'error',error:loadError,storageAvailable:store.available(),enabled:false,account:null,qr:null,clients:[],allowed:[],pending:[],jobs:[],active:null,outbox:0};
    const name=record=>record.name||record.profile?.nickname||`微信 ${records.indexOf(record)+1}`,record=records.find(item=>item.id===selected);
    return {...current,error:loadError||storageError||current.error,selectedConnectionId:selected,connectionLimit:LIMIT,connectionName:record?name(record):'当前微信',profile:userProfile(record?.profile),contactNames:{...record?.contactNames},
      // 只汇总其他微信的任务和待处理数量；原始备注单独返回，避免回退后的显示名覆盖昵称优先级。
      // 正文、联系人身份与配置仍只下发当前账号。
      connections:records.map(record=>{const value=gateways.get(record.id).snapshot();return {id:record.id,name:name(record),remark:record.name||'',...userProfile(record.profile),account:value.account,status:value.status,enabled:value.enabled,taskCount:value.jobs.filter(job=>liveStates.has(job.state)).length,pendingCount:value.pending.length,outboxCount:value.outbox};})};
  }
  function choose(id) {if(!gateways.has(id))throw Error('微信连接不存在，请重新选择。');save(records,id);selected=id;onChange();}
  return {
    snapshot,
    start(){if(started||closed||loadError)return;started=true;for(const gateway of gateways.values())gateway.start();},
    async action(name,payload) {
      if(loadError||storageError||closed)throw Error(loadError||storageError||'微信接入已关闭');
      if(name==='select-connection'){choose(payload);return snapshot();}
      if(name==='add-connection') {
        const empty=records.find(record=>!record.state.account);
        if(empty){choose(empty.id);return snapshot();}
        if(records.length>=LIMIT)throw Error('最多连接 8 个微信，请先解绑不再使用的账号。');
        // 新账号沿用已保存的客户端配置，之后各自修改；不复制联系人授权、会话和待投递内容。
        const state=fresh();state.clients=structuredClone(records.find(record=>record.id===selected).state.clients);
        const record={id:'wechat-'+randomUUID(),state},items=[...records,record];save(items,record.id);records=items;selected=record.id;attach(record);onChange();return snapshot();
      }
      // 所有页面操作冻结连接 ID，切换界面或迟到响应都不能把操作发给另一个微信。
      const scoped=payload&&typeof payload==='object'&&Object.hasOwn(payload,'connectionId');
      if(!scoped&&records.length!==1)throw Error('请选择要操作的微信连接。');
      const id=scoped?payload.connectionId:selected,value=scoped?payload.value:payload;
      const record=records.find(item=>item.id===id),gateway=gateways.get(id);
      if(!record||!gateway)throw Error('微信连接不存在，请重新选择。');
      if(name==='update-avatar'){
        // 限制原图大小并复用微信端的图片校验、居中裁切和缩放，页面不能直接写入任意头像数据。
        if(typeof value!=='string'||value.length>Math.ceil(4*1024*1024/3)*4+32)throw Error('头像图片不能超过 4 MB。');
        const match=/^data:image\/(?:png|jpeg);base64,([A-Za-z0-9+/]+={0,2})$/.exec(value);
        if(!match)throw Error('请选择 PNG 或 JPEG 格式的头像图片。');
        const bytes=Buffer.from(match[1],'base64');
        // Buffer 解码会容忍部分非法 Base64，回编码比对后才交给图片解码器。
        if(bytes.length>4*1024*1024||bytes.toString('base64')!==match[1])throw Error('头像图片无法读取或超过 4 MB。');
        if(typeof options.normalizeAvatar!=='function')throw Error('头像处理暂不可用，请重试。');
        const avatar=await options.normalizeAvatar(bytes);
        // 处理图片期间可能切换、删除账号或关闭模块；只允许写回最初选定且仍存在的连接。
        if(!records.includes(record))throw Error('微信连接不存在，请重新选择。');
        const profile=userProfile({...userProfile(record.profile),avatar});
        // 加密存储成功后才更新内存，写盘失败时继续显示原头像。
        save(records.map(item=>item===record?{...item,profile}:item));record.profile=profile;onChange();return snapshot();
      }
      // 昵称和备注名只改变展示元数据，保留头像，不写回机器人身份、联系人授权或执行路由。
      if(name==='rename-connection'||name==='rename-nickname'||name==='rename-user') {
        let patch;
        if(name==='rename-connection')patch={name:displayName(value)};
        else if(name==='rename-nickname')patch={profile:userProfile({...userProfile(record.profile),nickname:profileText(value)})};
        else {
          const current=gateway.snapshot(),sender=value?.sender;
          if(!current.allowed.includes(sender)&&!current.pending.includes(sender))throw Error('联系人不存在，请刷新后重试。');
          const label=displayName(value?.name);
          patch={contactNames:Object.fromEntries([...Object.entries(record.contactNames||{}).filter(([key])=>key!==sender),...(label?[[sender,label]]:[])])};
        }
        save(records.map(item=>item===record?{...item,...patch}:item));Object.assign(record,patch);onChange();return snapshot();
      }
      if(name==='forget') {
        // 仅停止并移除目标账号；最后一个账号解绑后保留空连接和客户端配置，方便重新扫码。
        await gateway.action('enable',false);
        let items=records.filter(item=>item!==record),selection=selected===id?items[0]?.id:selected;
        if(!items.length){const state=fresh();state.clients=structuredClone(record.state.clients);items=[{id:'wechat-'+randomUUID(),state}];selection=items[0].id;}
        save(items,selection);records=items;selected=selection;gateway.close();gateways.delete(id);
        for(const item of items)if(!gateways.has(item.id))attach(item);
        onChange();return snapshot();
      }
      const result=await gateway.action(name,value);
      return typeof result==='string'||name==='task-detail'||name==='discover-clients'?result:snapshot();
    },
    close(){if(closed)return;closed=true;for(const gateway of gateways.values())gateway.close();}
  };
}
module.exports={createWechatManager};
