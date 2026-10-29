'use strict';
const safe=message=>Object.assign(Error(message),{reportSafe:true});
// 提交采集与发布归属共用作者口径，发布人或合并人不能代替真实提交作者。
function authorFilter({authors,authorMode='email',authorNames}={}){
  if(!['email','name'].includes(authorMode))throw safe('请选择 GitLab 作者筛选方式');
  const identities=new Set(String((authorMode==='name'?authorNames:authors)||'').split(/[,，\n]/).map(v=>v.trim().toLowerCase()).filter(Boolean));
  if(!identities.size)throw safe(authorMode==='name'?'请配置要采集的 GitLab 作者名':'请配置要采集的 GitLab 作者邮箱');
  const field=authorMode==='name'?'author_name':'author_email';
  return {field,matches:commit=>typeof commit?.[field]==='string'&&identities.has(commit[field].trim().toLowerCase())};
}
function isMergeCommit(commit){
  // 部分接口缺少父提交信息，用标准合并标题兜底；纯合并操作不证明本人参与开发。
  const parents=commit?.parent_ids||commit?.sourceMeta?.parentShas||[];
  return parents.length>1||/^Merge\s+(?:branch|remote-tracking branch|commit|tag|pull request)\b/i.test(String(commit?.title||commit?.message||'').trim());
}
module.exports={authorFilter,isMergeCommit};
