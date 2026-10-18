'use strict';
const {AgentError}=require('./agent-error.cjs');
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
// 两种客户端共用同一份问题校验，限制题数和字段长度，并拒绝无法唯一关联的重复 ID。
function normalizeQuestions(value) {
  const invalid=()=>{throw new AgentError('INTERACTION','turn');};
  if(!Array.isArray(value)||!value.length||value.length>10)invalid();
  const ids=new Set();
  return value.map(entry=>{
    if(!object(entry)||typeof entry.id!=='string'||!entry.id||entry.id.length>1000||ids.has(entry.id)||typeof entry.question!=='string'||!entry.question.trim()||entry.question.length>8000)invalid();
    ids.add(entry.id);
    if(entry.options!=null&&(!Array.isArray(entry.options)||entry.options.length>20))invalid();
    const options=(entry.options||[]).map(option=>{
      if(!object(option)||typeof option.label!=='string'||!option.label.trim()||option.label.length>500||option.description!=null&&(typeof option.description!=='string'||option.description.length>2000))invalid();
      return {label:option.label,description:option.description||''};
    });
    return {id:entry.id,header:typeof entry.header==='string'?entry.header.slice(0,200):'',question:entry.question,options,isOther:entry.isOther===true,isSecret:entry.isSecret===true};
  });
}
function normalizeAnswer(value,questions) {
  if(!object(value?.answers))throw new AgentError('INTERACTION','turn');
  // 只回填本次请求包含的题目；按自有属性取值，避免题目 ID 与对象原型属性冲突。
  return {answers:Object.fromEntries(questions.map(question=>{
    const answer=Object.hasOwn(value.answers,question.id)?value.answers[question.id]?.answers:null;
    if(!Array.isArray(answer)||!answer.length||answer.length>20||answer.some(text=>typeof text!=='string'||!text.trim()||text.length>16000))throw new AgentError('INTERACTION','turn');
    return [question.id,{answers:[...answer]}];
  }))};
}
function asyncQuestions(item) {
  if(typeof item?.id!=='string'||!item.id||item.id.length>1000)throw new AgentError('INTERACTION','turn');
  // 桌面用工具调用 ID 和原始题目下标定位选项；筛掉已答题目后也必须沿用这个标识。
  return normalizeQuestions((item.questions||[]).map((question,index)=>({id:JSON.stringify(['request_user_input_async',item.id,index]),question:question.title,
    options:question.options?.map(label=>({label}))})));
}
function asyncReply(questions,response) {
  // 异步问题必须按桌面的结构化回复协议回填，普通文本不能解除原问题的待选择状态。
  return '<send_user_message_question_reply>\n'+JSON.stringify(questions.map(question=>({questionItemId:question.id,question:question.question,answer:response.answers[question.id].answers.join('\n')})))+'\n</send_user_message_question_reply>';
}
function answeredQuestionIds(items) {
  const ids=new Set();
  for(const item of items) {
    // 尚未接受或已拒绝的插入消息不算回答成功，避免提前撤销仍在等待的微信问题。
    if(item?.type!=='userMessage'&&(item?.type!=='steeringUserMessage'||item.status!=='accepted'))continue;
    const input=item.type==='userMessage'?item.content:item.input;
    if(!Array.isArray(input)||input.length!==1||input[0]?.type!=='text')continue;
    const match=String(input[0].text||'').trim().match(/^<send_user_message_question_reply>\s*([\s\S]*?)\s*<\/send_user_message_question_reply>$/);
    if(!match)continue;
    try{const values=JSON.parse(match[1]);for(const value of Array.isArray(values)?values:[values])if(typeof value?.questionItemId==='string')ids.add(value.questionItemId);}catch{}
  }
  return ids;
}
module.exports={normalizeQuestions,normalizeAnswer,asyncQuestions,asyncReply,answeredQuestionIds};
