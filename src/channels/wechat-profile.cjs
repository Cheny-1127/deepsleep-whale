'use strict';
const {avatarData}=require('./subscription-avatar.cjs');

function profileText(value,label='昵称') {
  if(typeof value!=='string'||Array.from(value.trim()).length>40||/[\u0000-\u001f\u007f]/.test(value))throw Error(`${label}请使用 40 字以内的单行文字。`);
  return value.trim();
}
function userProfile(value={}) {
  if(!value||typeof value!=='object'||Array.isArray(value))throw Error('微信用户资料格式无法识别，原文件已保留');
  const nickname=profileText(value.nickname??''),avatar=value.avatar??'';
  if(avatar!==''&&!avatarData(avatar))throw Error('微信头像格式无法识别，原文件已保留');
  return {nickname,avatar};
}
function imageSize(bytes) {
  if(bytes.length>=24&&bytes.subarray(0,8).equals(Buffer.from('89504e470d0a1a0a','hex'))&&bytes.toString('ascii',12,16)==='IHDR')return [bytes.readUInt32BE(16),bytes.readUInt32BE(20)];
  if(bytes[0]===255&&bytes[1]===216){
    for(let offset=2;offset+4<=bytes.length;){
      if(bytes[offset++]!==255)break;while(bytes[offset]===255)offset++;
      const marker=bytes[offset++];if(marker===217||marker===218)break;
      if(marker===1||marker>=208&&marker<=215)continue;
      if(offset+2>bytes.length)break;const length=bytes.readUInt16BE(offset);
      if(length<2||offset+length>bytes.length)break;
      if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)&&length>=8)return [bytes.readUInt16BE(offset+5),bytes.readUInt16BE(offset+3)];
      offset+=length;
    }
  }
  throw Error('请发送 PNG 或 JPEG 格式的头像图片。');
}
function avatarFromImage(bytes,nativeImage) {
  if(!Buffer.isBuffer(bytes)||bytes.length>4*1024*1024)throw Error('头像图片不能超过 4 MB。');
  // 解码前检查文件头和像素数，避免压缩体积很小但尺寸异常的图片占用大量内存。
  const [width,height]=imageSize(bytes);
  if(!width||!height||width>8192||height>8192||width*height>16000000)throw Error('头像图片尺寸过大，请缩小后重试。');
  const image=nativeImage.createFromBuffer(bytes);if(image.isEmpty())throw Error('头像图片无法读取，请换一张重试。');
  const size=image.getSize(),edge=Math.min(size.width,size.height);
  const output=image.crop({x:Math.floor((size.width-edge)/2),y:Math.floor((size.height-edge)/2),width:edge,height:edge}).resize({width:128,height:128,quality:'good'}).toPNG();
  const data=avatarData('data:image/png;base64,'+output.toString('base64'));
  if(!data)throw Error('头像处理失败，请换一张重试。');return data;
}
module.exports={profileText,userProfile,avatarFromImage};
