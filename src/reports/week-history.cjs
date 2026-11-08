'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const {validDate,weekRange}=require('./model.cjs');
const MAX_BYTES=2*1024*1024;

// 只读配置目录内的周报；历史成稿保持原路径、日期及正文，不转为应用托管文件。
function archivedWeeks({root,weeklyDir}){
  const result={items:[],limited:false,note:''};
  if(!root)return result;
  let base;
  try{if(!path.isAbsolute(root)||!fs.statSync(root).isDirectory())throw Error();base=fs.realpathSync(root);}
  catch{return {...result,note:'Obsidian 报告目录无法读取，仍可查看应用草稿。'};}
  let visited=0,bytes=0;
  const seen=new Set(),folders=new Set();
  function directory(relative){
    if(typeof relative!=='string'||path.isAbsolute(relative)||relative.split(/[\\/]/).some(p=>!p||p==='.'||p==='..'))return null;
    const full=path.join(base,relative);
    try{if(fs.realpathSync(full)!==full||!fs.lstatSync(full).isDirectory())return null;return full;}catch{return null;}
  }
  function entries(full){try{return fs.readdirSync(full,{withFileTypes:true}).sort((a,b)=>b.name.localeCompare(a.name));}catch{return [];}}
  if(directory(weeklyDir))folders.add(weeklyDir);
  const reports=directory('03-报告');
  if(reports)for(const year of entries(reports))if(year.isDirectory()&&/^20\d{2}$/.test(year.name)){
    const relative=path.join('03-报告',year.name,'周报');if(directory(relative))folders.add(relative);
  }
  function read(relative){
    const full=path.join(base,relative);let fd;
    try{
      if(fs.realpathSync(path.dirname(full))!==path.dirname(full))return;
      fd=fs.openSync(full,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
      const stat=fs.fstatSync(fd);
      if(!stat.isFile()||stat.nlink!==1||stat.size>MAX_BYTES)return;
      if(bytes+stat.size>16*1024*1024){result.limited=true;return;}bytes+=stat.size;
      const buffer=Buffer.alloc(stat.size+1),length=fs.readSync(fd,buffer,0,buffer.length,0),after=fs.fstatSync(fd);
      if(length!==stat.size||after.size!==stat.size||after.mtimeMs!==stat.mtimeMs||fs.realpathSync(path.dirname(full))!==path.dirname(full))return;
      const content=buffer.subarray(0,length).toString('utf8');if(content.length>200000)return;
      const front=content.slice(0,16384).match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)?.[1]||'';
      const field=name=>front.match(new RegExp('^'+name+':[^\\S\\r\\n]*["\']?([^"\'\\r\\n]+)','m'))?.[1]?.trim();
      const named=path.basename(relative).match(/^(20\d{2}-\d{2}-\d{2})(?:至(20\d{2}-\d{2}-\d{2})-周报)?\.md$/);
      const from=field('period_start'),until=field('period_end');
      let start,end;
      if(from!==undefined||until!==undefined){if(!validDate(from)||!validDate(until)||until<from)return;start=from;end=until;}
      else if(named&&validDate(named[1])&&(!named[2]||validDate(named[2])&&named[2]>=named[1])){start=named[1];end=named[2]||weekRange(start).end;}
      else return;
      const title=content.match(/^#\s+(.+)$/m)?.[1]?.trim().slice(0,200)||`${start} ～ ${end}`;
      const id='obsidian:'+createHash('sha256').update(JSON.stringify([base,relative])).digest('hex');
      result.items.push({id,source:'obsidian',start,end,title,relative,content});
    }catch{/* 不跟随文件链接；读取期间移走、修改或无权读取的文件不作为历史正文返回。 */}
    finally{if(fd!==undefined)fs.closeSync(fd);}
  }
  function walk(relative,depth=0){
    const full=directory(relative);if(!full)return;
    for(const entry of entries(full)){
      if(++visited>4000){result.limited=true;return;}
      const child=path.join(relative,entry.name);
      if(entry.isDirectory()&&depth<2)walk(child,depth+1);
      else if(entry.isFile()&&entry.name.endsWith('.md')&&!seen.has(child)){seen.add(child);read(child);}
    }
  }
  for(const folder of folders)walk(folder);
  result.items.sort((a,b)=>b.end.localeCompare(a.end)||b.start.localeCompare(a.start)||a.id.localeCompare(b.id));
  if(result.items.length>256){result.items.length=256;result.limited=true;}
  return result;
}
module.exports={archivedWeeks};
