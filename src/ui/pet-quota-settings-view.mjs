const $ = id => document.getElementById('quota-pet-' + id);
export function createPetQuotaSettingsView() {
  if (!$('body')) return;
  let latest, saving = false, polling = false, revision = 0;
  const cards = new Map(), accountsToggle = document.getElementById('quota-accounts-toggle');
  const configFor = card => card.id === 'primary' ? latest.settings : latest.settings.trackingConfigs.find(config => config.id === card.id);
  const selectedAccount = card => card.draftAccountId !== undefined ? card.draftAccountId : card.baseline?.accountId ?? null;
  const selectedGroup = card => card.draftGroupId !== undefined ? card.draftGroupId : card.baseline?.groupId ?? null;
  // 页面禁用已占用选项，主进程在提交时仍会校验；保存和临时账号都参与互斥。
  function accountOwner(card, accountId) {
    if (card.id === 'primary' || accountId === null) return null;
    if (latest.settings.accountId === accountId) return '流量跟踪配置';
    const owner = (latest.settings.trackingConfigs || []).find(config => config.id !== card.id &&
      (config.accountId === accountId || latest.extraTrackings?.some(item => item.id === config.id && item.tracking.accountId === accountId)));
    return owner ? `流量跟踪配置-${owner.id}` : null;
  }
  function dirty(card) {
    return card.baseline && (selectedAccount(card) !== card.baseline.accountId || Number(card.get('yellow').value) !== card.baseline.yellowBelow ||
      Number(card.get('red').value) !== card.baseline.redBelow || card.id !== 'primary' && selectedGroup(card) !== card.baseline.groupId);
  }
  function refreshApply(card) {card.get('actions').hidden = !dirty(card);card.get('apply').disabled = saving;}
  function accept(card, config) {
    for (const [id,key] of [['yellow','yellowBelow'],['red','redBelow']]) if (String(card.get(id).value) !== String(config[key])) card.get(id).value = config[key];
    card.baseline = {accountId:config.accountId,yellowBelow:config.yellowBelow,redBelow:config.redBelow,groupId:config.groupId};
    card.draftAccountId = undefined;card.draftGroupId = undefined;
  }
  function renderGroups(card) {
    const choices = [{id:null,name:'全部分组'},...latest.ranking.groups], selected = selectedGroup(card);
    if (!choices.some(group => group.id === selected)) choices.push({id:selected,name:`分组 #${selected}`});
    card.get('group').textContent = choices.find(group => group.id === selected).name;
    card.get('group-button').setAttribute('aria-disabled',String(saving));
    const key = JSON.stringify([choices,selected,saving]);
    if (card.groupsKey === key) return;
    card.groupsKey = key;
    card.get('group-options').replaceChildren(...choices.map(group => {
      const button=document.createElement('button'),name=document.createElement('span'),check=document.createElement('span');
      button.type='button';button.setAttribute('role','option');button.setAttribute('aria-selected',String(group.id === selected));button.disabled=saving;
      name.textContent=group.name;check.className='quota-group-check';check.textContent='✓';check.setAttribute('aria-hidden','true');button.append(name,check);
      button.addEventListener('click',()=>{card.get('group-picker').open=false;card.get('group-button').focus();card.draftGroupId=group.id;refreshApply(card);renderGroups(card);});
      return button;
    }));
  }
  function makeCard(id) {
    let root;
    if (id !== 'primary') {
      root=$('config-template').content.cloneNode(true).firstElementChild;root.dataset.configId=String(id);
      for (const element of root.querySelectorAll('[data-field]')) element.id=`quota-config-${id}-${element.dataset.field}`;
      root.id=`quota-config-${id}`;
      $('extra-configs').append(root);
    }
    const get=name=>id === 'primary' ? $(name) : name === 'card' ? root : root.querySelector(`[data-field="${name}"]`);
    const card={id,root,get,baseline:null,draftAccountId:undefined,draftGroupId:undefined,accountsKey:'',groupsKey:''};
    cards.set(id,card);
    get('copy').setAttribute('aria-label',id === 'primary' ? '复制流量跟踪配置' : `复制流量跟踪配置-${id}`);
    get('copy').title=id === 'primary' ? '复制流量跟踪配置' : `复制流量跟踪配置-${id}`;
    get('copy').addEventListener('click',()=>void update('copy-config',id));
    if (id !== 'primary') {
      const title=`流量跟踪配置-${id}`;get('title').textContent=title;
      root.querySelector('table').setAttribute('aria-label',title);
      get('accounts').setAttribute('aria-label',`${title}额度跟踪账号`);
      get('delete').setAttribute('aria-label',`删除${title}`);get('delete').title=`删除${title}`;
      get('delete').addEventListener('click',()=>void update('delete-config',id));
      get('toggle').setAttribute('aria-controls',get('body').id);root.setAttribute('aria-labelledby',get('heading').id);
      get('yellow').setAttribute('aria-label',`${title}淡黄色阈值`);get('red').setAttribute('aria-label',`${title}淡红色阈值`);
      get('group-button').addEventListener('click',event=>{if(saving)event.preventDefault();});
      get('group-picker').addEventListener('keydown',event=>{
        if(event.key==='Escape'){get('group-picker').open=false;get('group-button').focus();}
      });
    }
    get('toggle').addEventListener('click',()=>{const config=latest&&configFor(card);if(config)void update('update-config',{id,patch:{configExpanded:!config.configExpanded}});});
    get('yellow').addEventListener('input',()=>refreshApply(card));get('red').addEventListener('input',()=>refreshApply(card));
    get('apply').addEventListener('click',()=>void apply(card));
    return card;
  }
  makeCard('primary');
  function render(data) {
    latest=data;
    const configs=data.settings.trackingConfigs || [];
    for(const [id,card] of cards) if(id!=='primary'&&!configs.some(config=>config.id===id)){card.root.remove();cards.delete(id);}
    for(const config of configs) if(!cards.has(config.id))makeCard(config.id);
    accountsToggle.setAttribute('aria-expanded',String(data.settings.accountsExpanded));accountsToggle.disabled=saving;
    document.getElementById('quota-accounts-body').hidden=!data.settings.accountsExpanded;
    document.getElementById('quota-account-tools').hidden=!data.settings.accountsExpanded;
    for(const card of cards.values()) {
      const config=configFor(card);card.get('copy').disabled=saving;
      if(card.id!=='primary') {
        // 主配置抢占后立即同步副账号；只丢弃冲突的账号草稿，保留阈值和分组草稿。
        if(card.baseline)card.baseline.accountId=config.accountId;
        if(card.draftAccountId!==undefined&&accountOwner(card,card.draftAccountId))card.draftAccountId=undefined;
      }
      if(card.id!=='primary')card.get('delete').disabled=saving;
      card.get('toggle').setAttribute('aria-expanded',String(config.configExpanded));card.get('toggle').disabled=saving;card.get('body').hidden=!config.configExpanded;
      if(!dirty(card))accept(card,config);
      if(card.id==='primary')card.get('group').textContent=data.ranking.groupName;else renderGroups(card);
      card.get('yellow').disabled=saving;card.get('red').disabled=saving;refreshApply(card);
      const selected=selectedAccount(card),owners=data.accounts.map(account=>accountOwner(card,account.id));
      const key=JSON.stringify([data.accounts,config.accountId,selected,saving,owners]);
      if(card.accountsKey===key)continue;card.accountsKey=key;
      const accounts=[{id:null,name:'暂不跟踪'},...data.accounts];
      for(const id of [config.accountId,selected])if(id!==null&&!accounts.some(account=>account.id===id))accounts.push({id,name:`账号 #${id}（暂不可用）`});
      card.get('accounts').replaceChildren(...accounts.map(account=>{
        const label=document.createElement('label'),radio=document.createElement('input'),text=document.createElement('span');
        const owner=accountOwner(card,account.id);
        radio.type='radio';radio.name=`pet-quota-account-${card.id}`;radio.value=account.id??'';radio.checked=account.id===selected;radio.disabled=saving||Boolean(owner);
        if(owner){label.title=`已被${owner}占用`;radio.setAttribute('aria-description',label.title);}
        radio.addEventListener('change',()=>{if(radio.checked&&card.baseline){card.draftAccountId=account.id;refreshApply(card);}});
        text.textContent=account.name||`账号 #${account.id}`;label.append(radio,text);return label;
      }));
    }
  }
  async function invoke(name,value) {const result=await window.whale.petQuota(name,value);if(result.error)throw Error(result.error);return result.value;}
  function error(message,card=cards.get('primary')) {card.get('error').textContent=message;card.get('error').hidden=false;}
  async function update(name,value,commitCard) {
    if(saving||!latest)return;
    revision++;saving=true;for(const card of cards.values())card.get('error').hidden=true;render(latest);
    try {const data=await invoke(name,value);if(commitCard)commitCard.baseline=null;render(data);}
    catch(reason){error(reason.message||'流量跟踪配置保存失败，请重试。',commitCard);}
    finally {saving=false;render(latest);}
  }
  async function apply(card) {
    if(saving||!dirty(card))return;
    const yellowBelow=Number(card.get('yellow').value),redBelow=Number(card.get('red').value);
    if(!card.get('yellow').value||!card.get('red').value||!Number.isFinite(yellowBelow)||!Number.isFinite(redBelow)||redBelow<0||yellowBelow>100||redBelow>=yellowBelow){error('淡红色阈值须小于淡黄色阈值，范围为 0～100。',card);return;}
    const patch={};
    if(selectedAccount(card)!==card.baseline.accountId)patch.accountId=selectedAccount(card);
    if(yellowBelow!==card.baseline.yellowBelow)patch.yellowBelow=yellowBelow;
    if(redBelow!==card.baseline.redBelow)patch.redBelow=redBelow;
    if(card.id!=='primary'&&selectedGroup(card)!==card.baseline.groupId)patch.groupId=selectedGroup(card);
    await update('update-config',{id:card.id,patch},card);
  }
  async function sync() {
    if(saving||polling)return;polling=true;const stamp=revision;
    // 保存前发出的旧快照不能覆盖保存后的界面和草稿。
    try {const data=await invoke('snapshot');if(stamp===revision)render(data);}catch{if(stamp===revision)error('暂时无法读取流量跟踪配置，请稍后重试。');}
    finally{polling=false;}
  }
  document.addEventListener('pointerdown',event=>{
    for(const card of cards.values())if(card.id!=='primary'){
      const picker=card.get('group-picker');if(picker.open&&!picker.contains(event.target))picker.open=false;
    }
  });
  accountsToggle.addEventListener('click',()=>{if(latest)void update('update',{accountsExpanded:!latest.settings.accountsExpanded});});
  document.getElementById('nav-quota').addEventListener('click',()=>void sync());
  setInterval(()=>{if(!document.getElementById('quota-view').hidden)void sync();},5000);void sync();
}
