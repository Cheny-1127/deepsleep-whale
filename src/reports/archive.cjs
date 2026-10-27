'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash,randomUUID}=require('node:crypto');
const hash=value=>createHash('sha256').update(value).digest('hex');
function archiveReport({root,relative,id,content,previousHash}) {
  if(!path.isAbsolute(root||'')||!fs.existsSync(root)||!fs.statSync(root).isDirectory())throw Error('Obsidian 报告目录不存在，请在配置中选择已有目录');
  if(typeof relative!=='string'||path.isAbsolute(relative)||relative.split(/[\\/]/).some(p=>!p||p==='.'||p==='..')||/[\0\r\n]/.test(relative)||!relative.endsWith('.md'))throw Error('归档路径必须位于报告目录内');
  if(!/^(daily|weekly):20\d{2}-\d{2}-\d{2}$/.test(id)||typeof content!=='string'||content.length>200000||content.includes('<!-- deepsleep:'))throw Error('报告内容或标识无效');
  const base=fs.realpathSync(root),parts=relative.split(/[\\/]/);let directory=base;
  // 只允许配置根目录本身指向用户选定的位置；子目录和文件中的链接都拒绝跟随。
  for(const part of parts.slice(0,-1)){
    directory=path.join(directory,part);
    try {const stat=fs.lstatSync(directory);if(stat.isSymbolicLink()||!stat.isDirectory())throw Error('报告子目录含链接或不是目录');}
    catch(error){if(error.code==='ENOENT')fs.mkdirSync(directory,{mode:0o700});else throw error;}
  }
  const file=path.join(directory,parts.at(-1)),start=`<!-- deepsleep:${id}:start -->`,end=`<!-- deepsleep:${id}:end -->`;
  const checkDirectory=()=>{if(fs.realpathSync(directory)!==directory)throw Error('报告子目录已变为链接，未写入');};
  checkDirectory();
  const managed=`${start}\n${content.trim()}\n${end}`,digest=hash(managed);let original='',next=managed+'\n',exists=false;
  try {
    const stat=fs.lstatSync(file);exists=true;
    if(stat.isSymbolicLink()||!stat.isFile()||stat.nlink>1)throw Error('报告文件含链接或不是普通文件');
    if(stat.size>2*1024*1024)throw Error('已有报告文件过大，未覆盖');
    original=fs.readFileSync(file,'utf8');
    const a=original.indexOf(start),b=original.indexOf(end);
    if(a<0||b<a||original.indexOf(start,a+start.length)>=0||original.indexOf(end,b+end.length)>=0)throw Error('已有文件不是本应用的有效归档，未覆盖');
    const current=original.slice(a,b+end.length);
    // 相同内容可安全补记落盘状态，覆盖写入与状态保存之间意外退出的恢复场景。
    if(current!==managed&&(!previousHash||hash(current)!==previousHash))throw Error('报告内容已被手动修改，未覆盖；请在 Obsidian 核对后另存');
    next=original.slice(0,a)+managed+original.slice(b+end.length);
  }catch(error){if(error.code!=='ENOENT')throw error;}
  if(next!==original){
    const temporary=path.join(directory,`.deepsleep-${randomUUID()}.tmp`);
    try {
      checkDirectory();
      fs.writeFileSync(temporary,next,{mode:0o600,flag:'wx'});
      // 在替换前复核目标，避免把预览后用户刚写入的内容直接覆盖。
      if(exists){const stat=fs.lstatSync(file);if(stat.isSymbolicLink()||stat.nlink>1||fs.readFileSync(file,'utf8')!==original)throw Error('报告文件已变化，未覆盖，请重试');}
      else if(fs.existsSync(file))throw Error('已有文件刚被创建，未覆盖');
      checkDirectory();
      fs.renameSync(temporary,file);
    }finally{try{fs.unlinkSync(temporary);}catch{}}
  }
  return {path:file,hash:digest};
}
module.exports={archiveReport};
