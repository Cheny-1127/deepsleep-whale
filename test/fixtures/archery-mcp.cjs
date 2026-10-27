'use strict';
// 本地协议替身：只处理握手与固定读取/逐笔审批工具，不访问真实 Archery。
const readline=require('node:readline'),fs=require('node:fs');
readline.createInterface({input:process.stdin}).on('line',line=>{
  const request=JSON.parse(line);if(request.id===undefined)return;
  fs.appendFileSync(process.env.TRACE_FILE,JSON.stringify({method:request.method,params:request.params})+'\n');
  let result;
  if(request.method==='initialize')result={protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture-archery',version:'1.0'}};
  else if(request.method==='tools/call'&&request.params.name==='work_order_pending_list') {
    const {page,page_size}=request.params.arguments;
    result={structuredContent:{status:'success',data:{items:[{order_id:566,order_type:'work_order',title:'审核测试',submitter:'测试提交人'}],
      pagination:{page,page_size,total:null,source_total:1,has_more:false,next_page:null,scope:'source_page_filtered'}}},content:[]};
  }else if(request.method==='tools/call'&&request.params.name==='work_order_detail') {
    const id=request.params.arguments.order_id;
    result={content:[],structuredContent:{status:'success',data:{workflow_id:id,workflow:{id,is_offline_export:0},sql_content:'SELECT 1;',review_content:'测试审核',execute_result:''}}};
  }else if(request.method==='tools/call'&&request.params.name==='work_order_approve') {
    const [id]=request.params.arguments.order_ids;
    result={content:[],structuredContent:{status:'success',data:{succeeded:[id],failed:[],unknown:[],remaining:[],results:[{order_id:id,status:'success',message:'passed'}]}}};
  }else {process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'not permitted'}})+'\n');return;}
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result})+'\n');
});
