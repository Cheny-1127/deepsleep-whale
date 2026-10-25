// JXA 仅由 macOS osascript 执行；不会主动申请权限、激活窗口或发送全局按键。
function run(argv) {
  ObjC.import('ApplicationServices');
  if(!$.AXIsProcessTrusted())return JSON.stringify({status:'permission-required'});
  var threadId=argv[0],title=argv[1]||'';
  if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(threadId))return JSON.stringify({status:'invalid-target'});
  var system=Application('System Events'),seenCodex=false;
  var labels=['Scroll to bottom','滚动到底部','滚动至底部','捲動到底部','捲動至底部'];
  function attribute(node,name) {try{return node.attributes.byName(name).value();}catch(_){return null;}}
  function value(node,name) {try{return node[name]();}catch(_){return null;}}
  function matchesTitle(name) {
    if(!title||typeof name!=='string')return false;
    return name===title||['Codex','ChatGPT'].some(function(app){return [' — ',' - ',' · '].some(function(separator){return name===title+separator+app||name===app+separator+title;});});
  }
  for(var attempt=0;attempt<25;attempt++) {
    var foreground=system.applicationProcesses.whose({frontmost:true})();
    var process=foreground.length===1?foreground[0]:null;
    if(!process||['com.openai.codex','com.openai.chat'].indexOf(value(process,'bundleIdentifier'))<0) {
      if(seenCodex)return JSON.stringify({status:'focus-changed'});
      delay(0.1);continue;
    }
    seenCodex=true;
    var windows=process.windows(),window=null;
    for(var w=0;w<windows.length;w++)if(attribute(windows[w],'AXMain')===true){window=windows[w];break;}
    if(!window){delay(0.1);continue;}
    var matches=matchesTitle(value(window,'name')),document=null,queue=[{node:window,depth:0}],buttons=[],visited=0;
    // 有界遍历仅检查控件角色、文档 URL 和滚动按钮标签，不采集聊天正文。
    while(queue.length&&visited++<3000) {
      var entry=queue.shift(),node=entry.node,role=value(node,'role');
      if(role==='AXWebArea') {
        var url=attribute(node,'AXURL');
        if(typeof url==='string'&&new RegExp('(?:/|%2F)'+threadId+'(?:[/?#&]|$)','i').test(url)){matches=true;document=node;}
      }
      if(role==='AXButton'&&value(node,'enabled')===true&&labels.indexOf(value(node,'description')||value(node,'name'))>=0)buttons.push(node);
      if(entry.depth<24) {
        var children;try{children=node.uiElements();}catch(_){children=[];}
        for(var c=0;c<children.length;c++)queue.push({node:children[c],depth:entry.depth+1});
      }
    }
    if(matches&&buttons.length===1) {
      // 重新核对前台窗口，防止等待/遍历期间用户切走；唯一允许的动作是滚动按钮的 AXPress。
      if(value(process,'frontmost')!==true||attribute(window,'AXMain')!==true)return JSON.stringify({status:'focus-changed'});
      var currentURL=document?attribute(document,'AXURL'):null;
      if(!matchesTitle(value(window,'name'))&&!(typeof currentURL==='string'&&new RegExp('(?:/|%2F)'+threadId+'(?:[/?#&]|$)','i').test(currentURL)))return JSON.stringify({status:'not-found'});
      buttons[0].actions.byName('AXPress').perform();
      return JSON.stringify({status:'scrolled'});
    }
    delay(0.1);
  }
  return JSON.stringify({status:'not-found'});
}
