'use strict';
const {randomBytes,randomUUID}=require('node:crypto');

// 消息协议参考 Hermes 868b9f2；二维码 POST 与重复绑定处理对照腾讯 openclaw-weixin 协议。
const BASE='https://ilinkai.weixin.qq.com';
const VERSION='2.2.0',CLIENT_VERSION=131584;
class WechatError extends Error {
  constructor(message,code){super(message);this.code=code;}
}
function trustedBase(value) {
  // 服务端返回的地址也需校验，防止扫码跳转或后续请求将机器人凭据发往其他域名。
  const url=new URL(value);
  if(url.protocol!=='https:'||url.username||url.password||url.port||url.pathname!=='/'||url.search||url.hash||
    !['weixin.qq.com','wechat.com'].some(domain=>url.hostname===domain||url.hostname.endsWith('.'+domain)))throw new Error('微信返回的服务地址不受支持');
  return url.origin;
}
function checkResult(data) {
  if(!data||typeof data!=='object'||Array.isArray(data))throw new WechatError('微信返回格式无法识别');
  const codes=[data.ret,data.errcode].filter(v=>v!==undefined&&v!==null&&v!==0);
  if(codes.length) {
    if(codes.includes(-14))throw new WechatError('微信登录已失效，请重新扫码',-14);
    if(codes.includes(-2)){
      const stale=['unknown error','prepare failed'].includes(String(data.errmsg||data.msg||'').toLowerCase());
      const error=new WechatError(stale?'微信会话尚未就绪，请给机器人发一条新消息后重试':'微信发送频率受限，稍后重试',-2);error.staleSession=stale;throw error;
    }
    throw new WechatError('微信接口返回错误（'+String(codes[0]).slice(0,12)+'）',codes[0]);
  }
  return data;
}
function splitText(text,limit=1800) {
  const chars=Array.from(String(text)),parts=[];
  for(let start=0;start<chars.length;) {
    let end=Math.min(start+limit,chars.length);
    if(end<chars.length) {
      // 优先在后半段的段落或换行处断开，保留所有空白；长行才按 Unicode 字符硬拆。
      let line=0,paragraph=0;
      for(let i=end-1;i>=start+Math.floor(limit/2);i--)if(chars[i]==='\n') {
        if(!line)line=i+1;
        if(chars[i-1]==='\n'){paragraph=i+1;break;}
      }
      end=paragraph||line||end;
      if(chars[end-1]==='\r'&&chars[end]==='\n'&&end>start+1)end--;
    }
    parts.push(chars.slice(start,end).join(''));start=end;
  }
  return parts;
}
function parseResponse(text) {
  // JSON 数字形式的微信 uint64 ID 必须在 JSON.parse 前保留原始数字；跳过完整字符串，不能改写正文。
  const lossless=text.replace(/"(?:\\.|[^"\\])*"|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g,value=>
    /^-?\d+$/.test(value)&&!Number.isSafeInteger(Number(value))?JSON.stringify(value):value);
  return JSON.parse(lossless);
}
function incoming(message,accountId) {
  if(!message||message.message_type!==1||!message.from_user_id||message.from_user_id===accountId||message.room_id||message.chat_room_id||
    message.to_user_id&&message.to_user_id!==accountId)return null;
  if(!message.message_id)return null; // 没有可去重 ID 的消息不能触发本机操作。
  const items=Array.isArray(message.item_list)?message.item_list:[];
  return {id:String(message.message_id),sender:String(message.from_user_id),context:typeof message.context_token==='string'?message.context_token:'',
    text:items.filter(item=>item.type===1&&typeof item.text_item?.text==='string').map(item=>item.text_item.text).join('\n').slice(0,16000)};
}
function createWechatApi({fetchImpl=globalThis.fetch,base=BASE}={}) {
  const validate=trustedBase,typingTickets=new WeakMap();
  async function request(endpoint,{account,body,signal,timeout=40000,host,baseInfo=true}={}) {
    const headers={'iLink-App-Id':'bot','iLink-App-ClientVersion':String(CLIENT_VERSION)};
    if(body) {
      headers['Content-Type']='application/json';headers.AuthorizationType='ilink_bot_token';
      headers['X-WECHAT-UIN']=Buffer.from(String(randomBytes(4).readUInt32BE())).toString('base64');
      if(account?.token)headers.Authorization='Bearer '+account.token;
    }
    const response=await fetchImpl(validate(host||account?.baseUrl||base)+'/ilink/bot/'+endpoint,{
      method:body?'POST':'GET',headers,redirect:'error',signal:signal?AbortSignal.any([signal,AbortSignal.timeout(timeout)]):AbortSignal.timeout(timeout),
      ...(body?{body:JSON.stringify({...body,...(baseInfo?{base_info:{channel_version:VERSION}}:{})})}:{})
    });
    if(!response.ok)throw new WechatError(`微信网络请求失败（HTTP ${response.status}）`);
    const text=await response.text();
    if(Buffer.byteLength(text)>2*1024*1024)throw new WechatError('微信响应超出大小限制');
    let data;try {data=parseResponse(text);}catch {throw new WechatError('微信响应无法解析');}
    return checkResult(data);
  }
  return {
    validate,baseUrl:validate(base),
    // 本地已有 token 让微信识别重复绑定；二维码接口使用 POST，且不携带普通 Bot API 的 base_info。
    qr:(signal,tokens=[])=>request('get_bot_qrcode?bot_type=3',{signal,body:{local_token_list:tokens},baseInfo:false}),
    qrStatus:(code,host,signal)=>request('get_qrcode_status?qrcode='+encodeURIComponent(code),{host,signal}),
    updates:(account,cursor,signal)=>request('getupdates',{account,body:{get_updates_buf:cursor||''},signal}),
    async typing(account,to,enabled,context,signal) {
      signal?.throwIfAborted();
      // 票据按账号对象和联系人隔离，仅在内存缓存十分钟；停止时过期也要重新获取。
      if(!typingTickets.has(account))typingTickets.set(account,new Map());
      const cache=typingTickets.get(account);let ticket=cache.get(to);
      if(!ticket||ticket.expires<=Date.now()) {
        const config=await request('getconfig',{account,signal,timeout:10000,body:{ilink_user_id:to,...(context?{context_token:context}:{})}});
        signal?.throwIfAborted();
        if(typeof config.typing_ticket!=='string'||!config.typing_ticket)return false;
        ticket={value:config.typing_ticket,expires:Date.now()+600000};
        if(cache.size>=128)cache.delete(cache.keys().next().value);
        cache.set(to,ticket);
      }
      signal?.throwIfAborted();
      await request('sendtyping',{account,signal,timeout:10000,body:{ilink_user_id:to,typing_ticket:ticket.value,status:enabled?1:2}});
      return true;
    },
    async send(account,to,text,context,clientId=randomUUID(),signal) {
      const deliver=token=>request('sendmessage',{account,signal,timeout:20000,body:{msg:{
        from_user_id:'',to_user_id:to,client_id:clientId,message_type:2,message_state:2,
        item_list:[{type:1,text_item:{text}}],...(token?{context_token:token}:{})
      }}});
      try{return await deliver(context);}catch(error){
        // Hermes 的旧会话回退：只重发同一结果一次，不创建新任务或更改收件人。
        if(context&&!signal?.aborted&&(error.code===-14||error.staleSession))return deliver('');
        throw error;
      }
    }
  };
}
module.exports={BASE,WechatError,trustedBase,checkResult,splitText,incoming,createWechatApi};
