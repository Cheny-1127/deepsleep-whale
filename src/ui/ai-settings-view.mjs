import {createSelectView} from './select-view.mjs';
import {confirmAction} from './confirm-dialog.mjs';

export function createAiSettingsView(){
  const entry=document.getElementById('ai-settings-open'),features=document.getElementById('nav-ai-sessions');if(!entry)return;
  const dialog=document.createElement('dialog');dialog.id='ai-settings-dialog';dialog.className='ui-dialog ai-settings-dialog';
  dialog.setAttribute('aria-labelledby','ai-settings-heading');dialog.setAttribute('aria-describedby','ai-settings-description');
  dialog.innerHTML=`<form id="ai-settings-form" novalidate>
    <div class="ai-settings-heading"><h2 id="ai-settings-heading">AI 配置</h2><button id="ai-settings-close" class="ui-icon-button" type="button" aria-label="关闭 AI 配置">×</button></div>
    <p id="ai-settings-description" class="ai-settings-note">需要 AI 的功能共用这份配置。</p>
    <label class="ai-settings-field" for="ai-base-url">API 地址<input id="ai-base-url" name="baseUrl" type="url" maxlength="2048" placeholder="https://example.com/v1" autocomplete="off" spellcheck="false" required></label>
    <p class="ai-settings-note ai-settings-field-help">填写服务商提供的基础地址，通常以 /v1 结尾。</p>
    <label class="ai-settings-field" for="ai-api-key">API Key<input id="ai-api-key" name="apiKey" type="password" maxlength="4096" placeholder="填写 API Key" autocomplete="off" spellcheck="false"></label>
    <p class="ai-settings-note ai-settings-field-help">密钥加密保存在本机，不会回显。更换地址需重新填写。</p>
    <label class="ai-settings-field" for="ai-model">模型<input id="ai-model" name="model" maxlength="200" placeholder="服务商提供的模型名称" autocomplete="off" spellcheck="false" required></label>
    <div class="ai-settings-grid"><div class="ai-settings-field"><span id="ai-protocol-label">接口类型</span><input type="hidden" name="protocol" value="chat"><details id="ai-protocol-picker" class="ui-select"><summary id="ai-protocol-trigger" class="ui-select-trigger" aria-labelledby="ai-protocol-label ai-protocol-selected"><span id="ai-protocol-selected"></span><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3 6 5 5 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></summary><div class="ui-select-menu"><div id="ai-protocol-options" class="ui-select-options" role="listbox" aria-labelledby="ai-protocol-label"></div></div></details></div>
    <div class="ai-settings-field"><span id="ai-effort-label">推理强度</span><input type="hidden" name="reasoningEffort" value=""><details id="ai-effort-picker" class="ui-select"><summary id="ai-effort-trigger" class="ui-select-trigger" aria-labelledby="ai-effort-label ai-effort-selected"><span id="ai-effort-selected"></span><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3 6 5 5 5-5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg></summary><div class="ui-select-menu"><div id="ai-effort-options" class="ui-select-options" role="listbox" aria-labelledby="ai-effort-label"></div></div></details></div></div>
    <p class="ai-settings-note ai-settings-field-help">不同模型支持的强度可能不同，不确定时选「模型默认」。</p>
    <p id="ai-settings-feedback" class="ai-settings-note" role="status" hidden></p><p id="ai-settings-error" class="ui-alert" role="alert" hidden></p>
    <div class="ai-settings-actions"><button id="ai-settings-clear" class="text-button ui-danger-action" type="button" hidden>清除配置</button><div><button id="ai-settings-cancel" class="outline" type="button">取消</button><button id="ai-settings-test" class="outline" type="button">测试连接</button><button id="ai-settings-save" class="primary" type="submit">保存</button></div></div>
  </form>`;
  document.body.append(dialog);
  const $=id=>document.getElementById(id),form=$('ai-settings-form');
  let running='',ticket=0;
  const items=[{value:'chat',label:'Chat Completions'},{value:'responses',label:'Responses'}];
  const efforts=[{value:'',label:'模型默认'},{value:'low',label:'低（low）'},{value:'medium',label:'中（medium）'},{value:'high',label:'高（high）'},{value:'xhigh',label:'极高（xhigh）'},{value:'max',label:'最高（max）'}];
  const select=createSelectView({picker:$('ai-protocol-picker'),trigger:$('ai-protocol-trigger'),options:$('ai-protocol-options'),label:$('ai-protocol-selected'),onChange:value=>{form.elements.protocol.value=value;renderSelect();resetMessages();}});
  const effortSelect=createSelectView({picker:$('ai-effort-picker'),trigger:$('ai-effort-trigger'),options:$('ai-effort-options'),label:$('ai-effort-selected'),onChange:value=>{form.elements.reasoningEffort.value=value;renderSelect();resetMessages();}});
  function renderSelect(){select.render({items,value:form.elements.protocol.value,disabled:Boolean(running)});effortSelect.render({items:efforts,value:form.elements.reasoningEffort.value,disabled:Boolean(running)});}
  function message(id,text){$(id).textContent=text;$(id).hidden=!text;}
  function resetMessages(){message('ai-settings-feedback','');message('ai-settings-error','');}
  function renderStatus(value){
    $('ai-settings-status').textContent=value.error?'需检查':value.configured?'已配置':'未配置';
    features.dataset.configured=String(value.configured);features.title=entry.title=value.error|| (value.configured?`AI 功能 · ${value.model}`:'AI 会话与全局模型配置');
  }
  async function request(name,value){const result=await window.whale.ai(name,value);if(result.error)throw Error(result.error);return result.value;}
  function busy(name){
    running=name;for(const element of form.querySelectorAll('input,button'))element.disabled=Boolean(name);
    $('ai-settings-cancel').disabled=$('ai-settings-close').disabled=Boolean(name&&name!=='test');
    $('ai-settings-test').textContent=name==='test'?'测试中…':'测试连接';$('ai-settings-save').textContent=name==='save'?'保存中…':'保存';renderSelect();
  }
  function values(){return {baseUrl:form.elements.baseUrl.value,apiKey:form.elements.apiKey.value,model:form.elements.model.value,protocol:form.elements.protocol.value,reasoningEffort:form.elements.reasoningEffort.value};}
  async function run(name,work){
    if(running)return;const current=++ticket;resetMessages();busy(name);
    try{await work(current);}catch(error){if(ticket===current&&dialog.open)message('ai-settings-error',error.message);}
    finally{if(ticket===current)busy('');}
  }
  async function open(){
    if(running||dialog.open)return;
    try{
      const value=await request('snapshot');renderStatus(value);
      form.elements.baseUrl.value=value.baseUrl;form.elements.model.value=value.model;form.elements.protocol.value=value.protocol;
      form.elements.reasoningEffort.value=value.reasoningEffort||'';
      form.elements.apiKey.value='';form.elements.apiKey.placeholder=value.hasKey?'已保存，留空保留原密钥':'填写 API Key';
      $('ai-settings-clear').hidden=!value.configured&&!value.error;resetMessages();message('ai-settings-error',value.error);
      busy('');renderSelect();dialog.showModal();
    }catch(error){features.title=entry.title=error.message;$('ai-settings-status').textContent='暂不可用';}
  }
  entry.addEventListener('click',()=>void open());
  function close(){if(running&&running!=='test')return;dialog.close();}
  $('ai-settings-close').addEventListener('click',close);$('ai-settings-cancel').addEventListener('click',close);
  dialog.addEventListener('cancel',event=>{if(running&&running!=='test')event.preventDefault();});
  dialog.addEventListener('close',()=>{
    if(running==='test')void request('cancel-test').catch(()=>{});
    ++ticket;busy('');form.elements.apiKey.value='';select.close();effortSelect.close();resetMessages();entry.focus({preventScroll:true});
  });
  form.addEventListener('input',resetMessages);
  $('ai-settings-test').addEventListener('click',()=>void run('test',async current=>{
    const result=await request('test',values());
    if(ticket===current&&dialog.open){const cached=result.usage?.cacheReadTokens;message('ai-settings-feedback','连接正常。'+(cached==null?'上游未返回缓存命中数据。':'缓存读取 '+cached+' tokens。')+'测试不会保存配置。');}
  }));
  form.addEventListener('submit',event=>{event.preventDefault();const input=values();void run('save',async()=>{renderStatus(await request('save',input));dialog.close();});});
  $('ai-settings-clear').addEventListener('click',async()=>{
    if(running)return;
    if(!(await confirmAction({owner:dialog,title:'清除 AI 配置？',message:'清除本机保存的地址、模型和密钥。需要 AI 的功能将等待重新配置。',confirmLabel:'清除配置',danger:true})))return;
    void run('clear',async()=>{renderStatus(await request('clear'));dialog.close();});
  });
  void request('snapshot').then(renderStatus).catch(error=>{features.title=entry.title=error.message;$('ai-settings-status').textContent='暂不可用';});
}
