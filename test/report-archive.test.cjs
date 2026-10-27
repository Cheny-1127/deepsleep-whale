'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {archiveReport}=require('../src/reports/archive.cjs');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'whale-vault-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
test('archive updates only its managed block and refuses edits within that block',t=>{
  const root=fixture(t),options={root,relative:'日报/2026-10-26.md',id:'daily:2026-10-26',content:'# 今日工作\n- 修复登录'};
  const first=archiveReport(options),file=path.join(root,options.relative);
  fs.appendFileSync(file,'\n我的手写备注\n');
  const second=archiveReport({...options,content:'# 今日工作\n- 完成回归',previousHash:first.hash});
  assert.match(fs.readFileSync(file,'utf8'),/我的手写备注/);
  fs.writeFileSync(file,fs.readFileSync(file,'utf8').replace('完成回归','人工修改'));
  assert.throws(()=>archiveReport({...options,previousHash:second.hash}),/手动修改/);
  assert.match(fs.readFileSync(file,'utf8'),/人工修改/);
});
test('archive rejects traversal, symlinks, unrelated files and missing roots',t=>{
  const root=fixture(t),outside=fixture(t),options={root,id:'daily:2026-10-26',content:'工作'};
  assert.throws(()=>archiveReport({...options,relative:'../other.md'}));
  fs.symlinkSync(outside,path.join(root,'链接'));assert.throws(()=>archiveReport({...options,relative:'链接/report.md'}),/链接/);
  fs.writeFileSync(path.join(root,'existing.md'),'手写内容');assert.throws(()=>archiveReport({...options,relative:'existing.md'}),/已有文件/);
  assert.equal(fs.readFileSync(path.join(root,'existing.md'),'utf8'),'手写内容');
  assert.throws(()=>archiveReport({...options,root:path.join(root,'missing'),relative:'report.md'}),/目录/);
});
