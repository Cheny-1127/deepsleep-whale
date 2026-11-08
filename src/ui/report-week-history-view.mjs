import {reportMarkdownHtml} from './report-markdown.mjs';

export function createWeekHistoryView({container,request}){
  const dialog=document.createElement('dialog');dialog.id='report-week-history-dialog';dialog.className='ui-dialog';dialog.setAttribute('aria-labelledby','report-week-history-heading');
  dialog.innerHTML=`<header class="report-week-history-header"><h2 id="report-week-history-heading">历史周报</h2><div class="report-actions"><button id="report-week-history-refresh" class="outline" type="button">刷新</button><button id="report-week-history-close" class="outline" type="button">关闭</button></div></header>
    <p id="report-week-history-note" class="report-note" role="status"></p><p id="report-week-history-error" class="ui-alert" role="alert" hidden></p>
    <div class="report-week-history-body"><div id="report-week-history-list" class="report-week-history-list" role="group" aria-label="历史周报列表"></div>
      <section id="report-week-history-reader" class="report-week-history-reader" aria-labelledby="report-week-history-title" hidden><h3 id="report-week-history-title"></h3><p id="report-week-history-origin" class="report-note"></p>
        <div class="ui-tabs" role="tablist" aria-label="历史周报显示方式"><button id="report-week-history-preview-tab" type="button" role="tab" aria-selected="true" aria-controls="report-week-history-preview">阅读预览</button><button id="report-week-history-source-tab" type="button" role="tab" aria-selected="false" aria-controls="report-week-history-source" tabindex="-1">Markdown 源码</button></div>
        <article id="report-week-history-preview" class="report-markdown" role="tabpanel" aria-labelledby="report-week-history-preview-tab" tabindex="0"></article><div id="report-week-history-source" role="tabpanel" aria-labelledby="report-week-history-source-tab" hidden><textarea id="report-week-history-markdown" class="report-preview" readonly aria-label="历史周报 Markdown 源码"></textarea></div>
      </section></div>`;
  container.append(dialog);
  const $=name=>dialog.querySelector('#report-week-history-'+name),sourceName=item=>item.source==='draft'?(item.variant==='ai'?'AI 周报草稿':'应用草稿'):'Obsidian';
  let items=[],selected='',listTicket=0,readTicket=0;
  function error(text=''){$('error').textContent=text;$('error').hidden=!text;}
  function showTab(name){for(const tab of ['preview','source']){const active=tab===name;$(tab).hidden=!active;$(tab+'-tab').setAttribute('aria-selected',String(active));$(tab+'-tab').tabIndex=active?0:-1;}}
  function markSelection(){for(const button of $('list').children)button.setAttribute('aria-pressed',String(button.dataset.id===selected));}
  async function read(item){
    const ticket=++readTicket;selected=item.id;markSelection();error();$('reader').hidden=true;
    try{
      const report=await request('read-week',{id:item.id});if(ticket!==readTicket||!dialog.open)return;
      $('title').textContent=`${report.start} ～ ${report.end}`;$('origin').textContent=sourceName(report)+(report.relative?' · '+report.relative:'');
      // 阅读时隐藏元数据和本应用归档标记；源码保留完整原文，不把笔记中的 HTML 当作页面执行。
      const body=report.content.replace(/^---\r?\n[\s\S]*?\r?\n---(?:\r?\n|$)/,'').replace(/^<!-- deepsleep:weekly:20\d{2}-\d{2}-\d{2}(?:\.\.20\d{2}-\d{2}-\d{2})?:(?:start|end) -->\r?$/gm,'');
      $('preview').innerHTML=reportMarkdownHtml(body);$('markdown').value=report.content;showTab('preview');$('reader').hidden=false;
      $('preview').scrollTop=$('markdown').scrollTop=0;
    }catch(failure){if(ticket===readTicket&&dialog.open)error(failure.message);}
  }
  async function refresh(){
    const ticket=++listTicket;++readTicket;error();$('refresh').disabled=true;$('reader').hidden=true;$('note').textContent='正在读取历史周报…';$('list').replaceChildren();
    try{
      const result=await request('list-weeks');if(ticket!==listTicket||!dialog.open)return;
      items=result.items;$('note').textContent=[items.length?`${items.length} 份周报 · 按日期倒序`:'暂无历史周报。保存过的草稿和 Obsidian 周报会显示在这里。',result.note,result.limited?'仅显示部分记录，可在 Obsidian 查看其余周报。':''].filter(Boolean).join(' · ');
      $('list').replaceChildren(...items.map(item=>{
        const button=document.createElement('button');button.type='button';button.className='outline report-week-history-item';button.dataset.id=item.id;
        const range=document.createElement('strong'),source=document.createElement('span'),title=document.createElement('span');
        range.textContent=`${item.start} ～ ${item.end}`;source.textContent=sourceName(item);title.textContent=item.title;title.className='report-week-history-label';
        button.append(range,source,title);button.addEventListener('click',()=>void read(item));return button;
      }));
      const item=items.find(item=>item.id===selected)||items[0];if(item)await read(item);else selected='';
    }catch(failure){if(ticket===listTicket&&dialog.open){$('note').textContent='';error(failure.message);}}
    finally{if(ticket===listTicket)$('refresh').disabled=false;}
  }
  document.getElementById('report-history-week').addEventListener('click',()=>{dialog.showModal();void refresh();});
  $('refresh').addEventListener('click',()=>void refresh());$('close').addEventListener('click',()=>dialog.close());
  dialog.addEventListener('close',()=>{++listTicket;++readTicket;});
  for(const name of ['preview','source'])$(name+'-tab').addEventListener('click',()=>showTab(name));
  dialog.querySelector('[role="tablist"]').addEventListener('keydown',event=>{
    if(!['ArrowLeft','ArrowRight','Home','End'].includes(event.key))return;event.preventDefault();
    const name=event.key==='Home'?'preview':event.key==='End'?'source':$('preview').hidden?'preview':'source';showTab(name);$(name+'-tab').focus();
  });
}
