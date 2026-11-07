import {createSelectView} from './select-view.mjs';

const $ = id => document.getElementById('quota-switch-' + id);
const states = {active:'启用',inactive:'停用',expired:'已过期',quota_exhausted:'额度用尽'};

export function createKeyGroupsView() {
  if (!$('picker')) return;
  let latest = null, busy = false, sequence = 0, searchSequence = 0, timer, listKey = '', actionError = '', activeOption = -1, composing = false, tab = 'favorites';
  const drafts = new Map(), pending = new Set(), refreshing = new Set(), initialLoads = new Set(), groupSelects = [];
  const enabled = () => document.getElementById('quota-view').dataset.moduleEnabled !== 'false';
  const pair = (userId,keyId) => `${userId}:${keyId}`;
  const pickerOpen = () => !$('menu').hidden;
  const selectedLabel = () => latest?.user ? `${latest.user.email} #${latest.user.id}` : '';
  async function invoke(name,value) {
    const result = await window.whale.quotaGroup('key-groups-' + name,value);
    if (result.error) throw Error(result.error);
    return result.value;
  }
  function showError(text) {$('error').textContent = text;$('error').hidden = !text;}
  function render(data) {
    latest = data;
    const working = busy || data.busy, favorites = data.favorites || [], active = document.activeElement;
    const focusedRow = $('body').contains(active) && active.closest('.quota-switch-row');
    const focused = focusedRow ? {row:focusedRow.dataset.rowId,selector:active.closest('.ui-select') ? 'summary' : active.classList.contains('quota-switch-pin') ? '.quota-switch-pin' : active.classList.contains('quota-switch-key-info') ? '.quota-switch-key-info' : active.classList.contains('quota-switch-row-refresh') ? '.quota-switch-row-refresh' : '.quota-switch-save'} : null;
    $('toggle').setAttribute('aria-expanded',String(data.expanded));
    $('body').hidden = !data.expanded;$('tools').hidden = !data.expanded || tab !== 'search';
    $('favorites').hidden = tab !== 'favorites';$('search-panel').hidden = tab !== 'search';
    for (const name of ['favorites','search']) {
      $('tab-' + name).setAttribute('aria-selected',String(tab === name));$('tab-' + name).tabIndex = tab === name ? 0 : -1;
    }
    if (!data.expanded) closePicker();
    // 输入内容只是搜索草稿；更新列表时不覆盖草稿，只有明确选择结果才修改用户。
    if (!pickerOpen()) $('search').value = selectedLabel();
    $('count').textContent = `${tab === 'favorites' ? favorites.length : data.keys.length} 个 Key`;
    $('refresh').disabled = working || !data.user || data.keys.some(key => key.busy) || pending.size > 0 || refreshing.size > 0 || !enabled();
    $('refresh').textContent = working ? '正在查询…' : '立即刷新';
    $('checked').textContent = data.checkedAt === null ? '尚未查询' : `刷新时间：${new Date(data.checkedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}`;
    showError(actionError || (tab === 'search' ? data.error : ''));
    $('cache-error').textContent = data.cacheError;$('cache-error').hidden = !data.cacheError;
    $('empty').hidden = data.keys.length > 0;
    $('empty').textContent = working ? '正在读取 Key 和分组权限…' : !data.user ? '选择 Sub2API 用户，查看其 API Key 和可用分组。' : data.checkedAt === null ? '尚未取得 Key 分组，请点击“立即刷新”。' : '该用户暂无 API Key。';
    $('table').hidden = !data.keys.length;$('note').hidden = !data.keys.length;
    $('favorites-empty').hidden = favorites.length > 0;$('favorites-table').hidden = !favorites.length;
    const nextKey = JSON.stringify([data.user?.id,data.keys,data.groups,data.error,favorites,working,enabled(),[...pending],[...refreshing],[...drafts]]);
    if (nextKey === listKey) return;
    listKey = nextKey;
    for (const view of groupSelects.splice(0)) view.destroy();
    const favoriteIds = new Set(favorites.map(item => pair(item.user.id,item.keyId)));
    function rowsFor(entries,section) {
      const rows = [];
      for (const entry of entries) {
        const {user,key,groups} = entry, keyId = key?.id ?? entry.keyId, localId = pair(user.id,keyId), label = key?.name || entry.name || '未命名 Key';
        const row = document.createElement('tr'), name = document.createElement('th'), status = document.createElement('td');
        row.className = 'quota-switch-row';row.dataset.keyId = String(keyId);row.dataset.rowId = `${section}-${user.id}-${keyId}`;name.scope = 'row';
        const title = document.createElement('div'), text = document.createElement('span'), pin = document.createElement('button'), pinned = favoriteIds.has(localId);
        title.className = 'quota-switch-key-title';text.textContent = label;pin.type = 'button';pin.className = 'ui-icon-button quota-switch-pin';
        pin.setAttribute('aria-pressed',String(pinned));pin.title = `${pinned ? '取消常用' : '设为常用'} ${label}`;pin.setAttribute('aria-label',pin.title);
        pin.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><polygon points="12,3 14.8,8.7 21,9.6 16.5,14 17.6,20.2 12,17.3 6.4,20.2 7.5,14 3,9.6 9.2,8.7"/></svg>';
        pin.disabled = busy || entry.busy || key?.busy || pending.has(localId) || refreshing.has(localId) || !enabled();
        pin.addEventListener('click',() => void load('set-favorite',{userId:user.id,keyId,favorite:!pinned}));
        text.className = 'quota-switch-key-name';
        const info = document.createElement('span'), tooltip = document.createElement('span'), tooltipName = document.createElement('strong');
        info.className = 'quota-switch-key-info';info.tabIndex = 0;info.setAttribute('aria-label',label);
        tooltip.className = 'quota-switch-key-tooltip';tooltip.id = `quota-switch-key-${section}-${user.id}-${keyId}`;tooltip.setAttribute('role','tooltip');
        info.setAttribute('aria-describedby',tooltip.id);tooltipName.textContent = label;tooltip.append(tooltipName);
        for (const [caption,value] of [['Key 编号',`#${keyId}`],['所属账号',`${user.email} #${user.id}`]]) {
          const line = document.createElement('span'), field = document.createElement('span'), detail = document.createElement('span');
          line.className = 'quota-switch-key-detail';field.textContent = caption;detail.textContent = value;line.append(field,detail);tooltip.append(line);
        }
        info.append(text,tooltip);title.append(pin,info);name.append(title);
        status.className = 'quota-switch-status';status.dataset.state = key?.uncertain ? 'uncertain' : key?.status || 'unknown';
        status.textContent = !key ? '—' : key.uncertain ? '待核对' : states[key.status] || '其他';
        status.title = key?.uncertain ? `${states[key.status] || '其他'} · 切换结果待核对，请刷新核对后再操作。` : status.textContent;
        if (key?.notice?.kind === 'success' && (!drafts.has(localId) || drafts.get(localId) === key.groupId)) {
          const saved = document.createElement('span');saved.className = 'quota-switch-saved';saved.textContent = '✓';saved.title = key.notice.text;
          saved.setAttribute('role','status');saved.setAttribute('aria-label',key.notice.text);title.append(saved);
        }
        const target = document.createElement('td'), operation = document.createElement('td');
        const button = document.createElement('button'), changing = key?.busy || pending.has(localId);
        button.type = 'button';button.className = 'outline quota-switch-save';button.dataset.keyId = String(keyId);
        button.textContent = changing ? '保存中…' : '保存';button.setAttribute('aria-label',`保存 ${label} 的分组`);
        row.append(name,target,status);
        if (section === 'favorites') {
          const refreshCell = document.createElement('td');refreshCell.className = 'quota-switch-refresh-cell';
          const refresh = document.createElement('button');refresh.type = 'button';refresh.className = 'ui-icon-button quota-switch-row-refresh';
          refresh.title = `刷新 ${label}`;refresh.setAttribute('aria-label',refresh.title);refresh.setAttribute('aria-busy',String(refreshing.has(localId)));
          if (entry.checkedAt !== null) refresh.title += ` · ${new Date(entry.checkedAt).toLocaleString('zh-CN',{timeZone:'Asia/Shanghai'})}`;
          refresh.innerHTML = '<svg width="16" height="16" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M16.5 9a6.5 6.5 0 1 0-1.5 5M16.5 4v5h-5" stroke-linecap="round" stroke-linejoin="round"/></svg>';
          refresh.disabled = busy || entry.busy || changing || refreshing.has(localId) || !enabled();
          refresh.addEventListener('click',() => void refreshFavorite(user.id,keyId));refreshCell.append(refresh);row.append(refreshCell);
        }
        operation.append(button);row.append(operation);rows.push(row);
        if (!key) {
          const placeholder = document.createElement('span');placeholder.className = 'quota-switch-placeholder';
          placeholder.textContent = busy || entry.busy || refreshing.has(localId) ? '正在读取…' : entry.missing ? 'Key 已移除' : '未取得分组';target.append(placeholder);button.disabled = true;
        } else {
          const currentName = key.groupName || (key.groupId === null ? '未绑定分组' : `分组 #${key.groupId}`);
          const picker = document.createElement('details'), trigger = document.createElement('summary'), menu = document.createElement('div'), options = document.createElement('div');
          picker.className = 'ui-select';trigger.className = 'ui-select-trigger';menu.className = 'ui-select-menu';options.className = 'ui-select-options';
          options.id = `quota-switch-groups-${section}-${user.id}-${key.id}`;options.setAttribute('role','listbox');options.setAttribute('aria-label',`${label}的可用分组`);
          trigger.dataset.keyId = button.dataset.keyId = String(key.id);trigger.setAttribute('aria-label',`${key.name || `Key #${key.id}`}的所属分组`);
          trigger.innerHTML = '<span></span><svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m3 6 5 5 5-5" stroke="currentColor" stroke-width="1.5"/></svg>';
          menu.append(options);picker.append(trigger,menu);
          const items = groups.map(group => ({value:String(group.id),label:group.name}));
          if (!groups.some(group => group.id === key.groupId)) {
            items.unshift({value:key.groupId === null ? '' : String(key.groupId),label:currentName,disabled:true});
          }
          const draft = drafts.get(localId), candidate = groups.some(group => group.id === draft) ? draft : key.groupId;
          const blocked = busy || entry.busy || changing || refreshing.has(localId) || key.uncertain || Boolean(entry.error) || !groups.length || !enabled();
          const view = createSelectView({picker,trigger,options,label:trigger.firstElementChild,onChange:value => {drafts.set(localId,Number(value));render(latest);}});
          view.render({items,value:candidate === null ? '' : String(candidate),disabled:blocked});groupSelects.push(view);
          button.classList.toggle('primary',candidate !== key.groupId);button.classList.toggle('outline',candidate === key.groupId);
          button.disabled = blocked || candidate === key.groupId || !groups.some(group => group.id === candidate);
          button.addEventListener('click',() => void change(user.id,key,candidate));
          target.append(picker);
          if (candidate !== key.groupId && !changing && !key.uncertain) {
            const hint = document.createElement('small');hint.className = 'quota-switch-draft';hint.textContent = '未保存';hint.title = `当前为 ${currentName}`;target.append(hint);
          }
        }
        const noticeValue = key?.notice?.kind === 'error' ? key.notice : section === 'favorites' && entry.error ? {kind:'error',text:entry.error} : null;
        if (noticeValue) {
          const notice = document.createElement('tr'), cell = document.createElement('td'), text = document.createElement('p');
          notice.className = 'quota-switch-notice';cell.colSpan = section === 'favorites' ? 5 : 4;text.textContent = noticeValue.text;text.dataset.kind = noticeValue.kind;
          text.setAttribute('role',noticeValue.kind === 'error' ? 'alert' : 'status');cell.append(text);notice.append(cell);rows.push(notice);
        }
      }
      return rows;
    }
    $('favorites-list').replaceChildren(...rowsFor(favorites,'favorites'));
    const sortedKeys = [...data.keys].sort((a,b) => Number(favoriteIds.has(pair(data.user.id,b.id))) - Number(favoriteIds.has(pair(data.user.id,a.id))));
    $('list').replaceChildren(...rowsFor(sortedKeys.map(key => ({user:data.user,key,groups:data.groups,busy:data.busy,error:data.error})),'current'));
    if (focused?.row) $('body').querySelector(`[data-row-id="${focused.row}"] ${focused.selector}:not(:disabled):not([aria-disabled="true"])`)?.focus();
  }
  async function load(name = 'open',value) {
    const ticket = ++sequence;busy = true;actionError = '';
    if (name === 'select') {
      const favorites = new Set((latest?.favorites || []).map(item => pair(item.user.id,item.keyId)));
      for (const id of drafts.keys()) if (!favorites.has(id)) drafts.delete(id);
      listKey = '';if (latest) render({...latest,user:null,keys:[],groups:[],checkedAt:null,error:''});
    }
    else if (latest) render(latest);
    try {const data = await invoke(enabled() ? name : 'snapshot',value);if (ticket === sequence) render(data);}
    catch (failure) {if (ticket === sequence) {if (latest) latest = {...latest,error:failure.message};else showError(failure.message);}}
    finally {if (ticket === sequence) {busy = false;if (latest) render(latest);fillMissingFavorites();}}
  }
  async function change(userId,key,groupId) {
    const localId = pair(userId,key.id), ticket = sequence;
    if (pending.has(localId) || !enabled()) return;
    actionError = '';pending.add(localId);render(latest);
    try {
      const data = await invoke('switch',{userId,keyId:key.id,expectedGroupId:key.groupId,groupId});
      const result = (data.user?.id === userId && data.keys.find(item => item.id === key.id)) || data.favorites.find(item => item.user.id === userId && item.keyId === key.id)?.key;
      if (result?.groupId === groupId && result.notice?.kind === 'success') drafts.delete(localId);
      if (ticket === sequence) render(data);
      else {
        const current = sequence, snapshot = await invoke('snapshot');if (current === sequence) render(snapshot);
      }
    } catch (failure) {if (ticket === sequence) actionError = failure.message;}
    finally {pending.delete(localId);if (latest) render(latest);}
  }
  async function refreshFavorite(userId,keyId) {
    const id = pair(userId,keyId), ticket = sequence;
    if (refreshing.has(id) || pending.has(id) || !enabled()) return;
    actionError = '';initialLoads.add(id);refreshing.add(id);render(latest);
    try {
      const data = await invoke('refresh-favorite',{userId,keyId});drafts.delete(id);
      if (ticket === sequence) render(data);
      else {const current = sequence, snapshot = await invoke('snapshot');if (current === sequence) render(snapshot);}
    } catch (failure) {actionError = failure.message.includes('刷新') ? failure.message : `${failure.message}请点击该行刷新后重试。`;}
    finally {refreshing.delete(id);if (latest) render(latest);}
  }
  function fillMissingFavorites() {
    if (!latest?.expanded || tab !== 'favorites' || busy || !enabled()) return;
    for (const item of latest.favorites || []) {
      if (item.checkedAt === null && !initialLoads.has(pair(item.user.id,item.keyId))) void refreshFavorite(item.user.id,item.keyId);
    }
  }
  function setTab(name) {tab = name;closePicker();for (const view of groupSelects) view.close();if (latest) render(latest);fillMissingFavorites();}
  for (const name of ['favorites','search']) $('tab-' + name).addEventListener('click',() => setTab(name));
  $('tabs').addEventListener('keydown',event => {
    if (!['ArrowLeft','ArrowRight','Home','End'].includes(event.key)) return;
    event.preventDefault();setTab(event.key === 'Home' ? 'favorites' : event.key === 'End' ? 'search' : tab === 'favorites' ? 'search' : 'favorites');$('tab-' + tab).focus();
  });
  $('toggle').addEventListener('click',async () => {
    if (!latest || $('toggle').disabled) return;
    $('toggle').disabled = true;
    try {render(await invoke('set-expanded',!latest.expanded));}
    catch (failure) {showError(failure.message);}
    finally {$('toggle').disabled = false;fillMissingFavorites();}
  });
  async function search() {
    const ticket = ++searchSequence, query = $('search').value.trim();
    highlightOption(-1);$('options').replaceChildren();$('search-status').textContent = '正在读取用户…';
    try {
      const users = await invoke('search',query);
      if (ticket !== searchSequence || !pickerOpen()) return;
      $('options').replaceChildren(...users.map(user => {
        const button = document.createElement('button');button.type = 'button';button.id = `quota-switch-user-${user.id}`;button.tabIndex = -1;
        button.setAttribute('role','option');button.setAttribute('aria-selected',String(user.id === latest?.user?.id));
        button.textContent = `${user.email} #${user.id}`;
        button.addEventListener('pointerdown',event => event.preventDefault());
        button.addEventListener('click',() => {closePicker();void load('select',user.id);});return button;
      }));
      $('search-status').textContent = users.length ? '最多显示 30 个用户，可搜索邮箱或用户名。' : '没有匹配的用户。';
    } catch (failure) {if (ticket === searchSequence && pickerOpen()) $('search-status').textContent = failure.message;}
  }
  function highlightOption(index) {
    const options = [...$('options').querySelectorAll('button')];activeOption = index;
    options.forEach((option,i) => option.classList.toggle('is-active',i === index));
    if (options[index]) {$('search').setAttribute('aria-activedescendant',options[index].id);options[index].scrollIntoView({block:'nearest'});}
    else $('search').removeAttribute('aria-activedescendant');
  }
  function clearSearch() {clearTimeout(timer);searchSequence++;highlightOption(-1);}
  function closePicker() {
    clearSearch();$('menu').hidden = true;$('search').setAttribute('aria-expanded','false');$('button').setAttribute('aria-expanded','false');
    $('search').value = selectedLabel();$('search').placeholder = '搜索邮箱或用户名';
  }
  function openPicker() {
    if (pickerOpen()) return;
    $('menu').hidden = false;$('search').setAttribute('aria-expanded','true');$('button').setAttribute('aria-expanded','true');
    $('search').value = '';$('search').placeholder = selectedLabel() || '搜索邮箱或用户名';void search();
  }
  function queueSearch() {
    clearSearch();if (!pickerOpen()) return;
    $('options').replaceChildren();$('search-status').textContent = '正在搜索…';
    if (!composing) timer = setTimeout(() => void search(),300);
  }
  $('search').addEventListener('focus',openPicker);
  $('search').addEventListener('click',openPicker);
  $('search').addEventListener('input',() => {
    if (!pickerOpen()) {const query = $('search').value;openPicker();$('search').value = query;}
    queueSearch();
  });
  $('search').addEventListener('compositionstart',() => {openPicker();composing = true;clearSearch();});
  $('search').addEventListener('compositionend',() => {composing = false;queueSearch();});
  $('button').addEventListener('pointerdown',event => event.preventDefault());
  $('button').addEventListener('click',() => {if (pickerOpen()) closePicker();else {$('search').focus();openPicker();}});
  $('picker').addEventListener('keydown',event => {
    if (event.isComposing || composing) return;
    if (event.key === 'Escape' && pickerOpen()) {event.preventDefault();event.stopPropagation();closePicker();return;}
    if (event.key === 'Enter' && pickerOpen() && activeOption >= 0) {event.preventDefault();$('options').querySelectorAll('button')[activeOption]?.click();return;}
    if (!pickerOpen() && !event.ctrlKey && !event.metaKey && !event.altKey && (event.key.length === 1 || ['Backspace','Delete'].includes(event.key))) openPicker();
    if (!['ArrowDown','ArrowUp'].includes(event.key)) return;
    event.preventDefault();if (!pickerOpen()) {openPicker();return;}
    const count = $('options').children.length;
    highlightOption(count ? activeOption < 0 ? (event.key === 'ArrowUp' ? count-1 : 0) : (activeOption+(event.key === 'ArrowDown' ? 1 : -1)+count)%count : -1);
  });
  $('picker').addEventListener('focusout',event => {if (!$('picker').contains(event.relatedTarget)) closePicker();});
  document.addEventListener('pointerdown',event => {if (!$('picker').contains(event.target)) closePicker();});
  document.addEventListener('whale-view-changed',() => {if ($('picker').closest('[hidden]')) closePicker();});
  $('refresh').addEventListener('click',() => {
    for (const id of drafts.keys()) if (id.startsWith(`${latest?.user?.id}:`)) drafts.delete(id);
    void load('refresh');
  });
  document.getElementById('nav-quota').addEventListener('click',() => void load());
}
