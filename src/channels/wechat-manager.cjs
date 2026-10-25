'use strict';
const {randomUUID}=require('node:crypto');
const {createWechatGateway}=require('./wechat-gateway.cjs');
const {fresh,migrate}=require('./wechat-store.cjs');
const LIMIT=8;
const liveStates=new Set(['queued','running','approval','question','recovering']);

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
        return {id:item.id,state};
      });
      if(!ids.has(value.selectedConnectionId))throw Error('微信选中连接不存在，原文件已保留');
      selected=value.selectedConnectionId;
    } else {
      // 只包装原有状态，不重新登录或丢弃游标、会话、任务及待投递结果。
      records=[{id:'wechat-legacy',state:migrate(value)}];selected=records[0].id;
    }
  } catch(error) {loadError=error.message;}
  function envelope(items=records,selection=selected){return {version:3,selectedConnectionId:selection,connections:items.map(({id,state})=>({id,state}))};}
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
    // 子网关只读写自己的状态副本；由管理器统一加密落盘，避免覆盖另一账号或删除共享文件。
    const gateway=createWechatGateway({...options,execution:{...execution,acquire:job=>execution.acquire(record.id,job)},
      validateAccount:id=>{
        if(records.some(other=>other!==record&&other.state.account?.id===id))throw Error('这个微信已接入，请切换到已有连接。');
        if(record.state.account&&record.state.account.id!==id)throw Error('重新扫码只恢复当前微信；请用“添加微信”接入另一个号。');
      },
      store:{available:()=>store.available(),load:()=>structuredClone(record.state),
        save:value=>{
          if(!records.includes(record))return;
          const state=structuredClone(value),items=records.map(item=>item===record?{id:item.id,state}:item);
          save(items);record.state=state;
        },remove:()=>{throw Error('请通过账号管理解绑指定微信。');}},onChange});
    gateways.set(record.id,gateway);return gateway;
  }
  for(const record of records)attach(record);
  function snapshot() {
    const current=gateways.get(selected)?.snapshot()||{status:'error',error:loadError,storageAvailable:store.available(),enabled:false,account:null,qr:null,clients:[],allowed:[],pending:[],jobs:[],active:null,outbox:0};
    return {...current,error:loadError||storageError||current.error,selectedConnectionId:selected,connectionLimit:LIMIT,
      connections:records.map((record,index)=>{const value=gateways.get(record.id).snapshot();return {id:record.id,name:`微信 ${index+1}`,account:value.account,status:value.status,enabled:value.enabled};})};
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
