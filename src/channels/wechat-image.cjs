'use strict';
const {createDecipheriv,createCipheriv,createHash,randomBytes}=require('node:crypto');
const {avatarData}=require('./subscription-avatar.cjs');
const LIMIT=4*1024*1024+16;
const CDN='https://novac2c.cdn.weixin.qq.com/c2c/download';

async function downloadWechatImage(item,{fetchImpl,signal}) {
  const media=item?.media;
  if(!media||media.encrypt_type!==undefined&&media.encrypt_type!==1)throw Error('不支持的微信图片格式');
  let key;
  if(item.aeskey){
    if(typeof item.aeskey!=='string'||!/^[a-f0-9]{32}$/i.test(item.aeskey))throw Error('微信图片密钥格式无效');
    key=Buffer.from(item.aeskey,'hex');
  }else if(media.aes_key){
    if(typeof media.aes_key!=='string'||media.aes_key.length>64||!/^[a-z0-9+/]+={0,2}$/i.test(media.aes_key))throw Error('微信图片密钥格式无效');
    key=Buffer.from(media.aes_key,'base64');
    if(key.length===32&&/^[a-f0-9]{32}$/i.test(key.toString('ascii')))key=Buffer.from(key.toString('ascii'),'hex');
    if(key.length!==16)throw Error('微信图片密钥格式无效');
  }
  if(!media.full_url&&(typeof media.encrypt_query_param!=='string'||!media.encrypt_query_param||media.encrypt_query_param.length>8192))throw Error('微信图片下载信息缺失');
  const target=media.full_url||CDN+'?encrypted_query_param='+encodeURIComponent(media.encrypt_query_param);
  if(typeof target!=='string'||target.length>12000)throw Error('微信图片下载地址无效');
  const url=new URL(target);
  // 下载图片只访问固定腾讯 CDN，不传 Bot 凭据；禁用重定向，避免消息指定其他服务器。
  if(url.origin!=='https://novac2c.cdn.weixin.qq.com'||url.username||url.password||url.hash||url.pathname!=='/c2c/download')throw Error('微信图片下载地址不受支持');
  const timeout=AbortSignal.timeout(10000),response=await fetchImpl(url.href,{redirect:'error',signal:signal?AbortSignal.any([signal,timeout]):timeout});
  if(!response.ok||!response.body||Number(response.headers?.get('content-length'))>LIMIT){await response.body?.cancel();throw Error('微信图片无法下载或超过 4 MB');}
  const reader=response.body.getReader(),chunks=[];let size=0;
  try {
    // 不能只相信 Content-Length，流式累计实际大小，超限立即取消下载。
    for(;;){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>LIMIT){await reader.cancel();throw Error('头像图片不能超过 4 MB');}chunks.push(Buffer.from(value));}
  }finally{reader.releaseLock();}
  const bytes=Buffer.concat(chunks);signal?.throwIfAborted();
  if(!key)return bytes;
  const decipher=createDecipheriv('aes-128-ecb',key,null);
  return Buffer.concat([decipher.update(bytes),decipher.final()]);
}
async function uploadWechatAvatar(avatar,{fetchImpl,getUploadUrl,signal}) {
  signal?.throwIfAborted();
  if(!avatarData(avatar))throw Error('头像预览格式无效');
  const bytes=Buffer.from(avatar.split(',')[1],'base64'),key=randomBytes(16),filekey=randomBytes(16).toString('hex');
  const cipher=createCipheriv('aes-128-ecb',key,null),encrypted=Buffer.concat([cipher.update(bytes),cipher.final()]);
  const result=await getUploadUrl({filekey,media_type:1,rawsize:bytes.length,rawfilemd5:createHash('md5').update(bytes).digest('hex'),filesize:encrypted.length,no_need_thumb:true,aeskey:key.toString('hex')});
  signal?.throwIfAborted();
  const full=result.upload_full_url?.trim(),param=result.upload_param;
  if(!full&&(typeof param!=='string'||!param||param.length>8192))throw Error('微信图片上传地址缺失');
  const target=full||'https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param='+encodeURIComponent(param)+'&filekey='+filekey;
  let url;try{url=new URL(target);}catch{throw Error('微信图片上传地址无效');}
  // 只上传已缩小的当前头像；CDN 请求不携带 Bot 凭据，也不能随服务端地址跳转到其他站点。
  if(target.length>12000||url.origin!=='https://novac2c.cdn.weixin.qq.com'||url.username||url.password||url.hash||url.pathname!=='/c2c/upload')throw Error('微信图片上传地址不受支持');
  const timeout=AbortSignal.timeout(15000),response=await fetchImpl(url.href,{method:'POST',headers:{'Content-Type':'application/octet-stream'},body:encrypted,redirect:'error',signal:signal?AbortSignal.any([signal,timeout]):timeout});
  const download=response.headers?.get('x-encrypted-param');await response.body?.cancel();signal?.throwIfAborted();
  if(!response.ok||typeof download!=='string'||!download||download.length>8192)throw Error('微信头像预览上传失败');
  // 腾讯发送端要求把十六进制密钥文本转为 base64，接收端再还原成 16 字节 AES 密钥。
  return {media:{encrypt_query_param:download,aes_key:Buffer.from(key.toString('hex')).toString('base64'),encrypt_type:1},mid_size:encrypted.length};
}
module.exports={downloadWechatImage,uploadWechatAvatar};
