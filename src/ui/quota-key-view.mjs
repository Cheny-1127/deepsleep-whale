const $ = id => document.getElementById('quota-key-' + id);
const money = value => `$${value.toFixed(4)}`;
const time = value => new Date(value).toLocaleString('zh-CN', {timeZone:'Asia/Shanghai'});

export function createKeyUsageView() {
  if (!$('picker')) return;
  let latest, busy = false, polling = false, sequence = 0, searchSequence = 0, timer, listKey = '';
  const collapsedGroups = new Set();
  // 整卡折叠偏好由主进程落盘；保留表格节点，展开时复用仍有效的消费缓存。
  $('toggle').addEventListener('click',async () => {
    if ($('toggle').disabled) return;
    const expanded = $('toggle').getAttribute('aria-expanded') !== 'true';
    $('toggle').disabled = true;
    try {
      const data = await invoke('set-expanded',expanded);
      if (latest) latest = {...latest,expanded:data.expanded};
      renderExpanded(data.expanded !== false);
      $('cache-error').textContent = data.cacheError || '';$('cache-error').hidden = !data.cacheError;
      if (expanded && !busy && !polling) void load();
    } catch {$('error').textContent = '无法保存折叠状态，请稍后重试。';$('error').hidden = false;}
    finally {$('toggle').disabled = false;}
  });
  function renderExpanded(expanded) {
    $('toggle').setAttribute('aria-expanded',String(expanded));
    $('body').hidden = !expanded;$('tools').hidden = !expanded;$('collapsed-summary').hidden = expanded;
    if (!expanded) {$('picker').open = false;clearSearch();}
  }
  async function invoke(name, value) {
    const result = await window.whale.quotaGroup('keys-' + name,value);
    if (result.error) throw Error(result.error);
    return result.value;
  }
  function render(data) {
    latest = data;
    renderExpanded(data.expanded !== false);
    const working = busy || data.busy;
    $('selected').textContent = data.user ? `${data.user.email} #${data.user.id}` : '请选择账号';
    $('refresh').disabled = working || !data.user;
    $('refresh').textContent = working ? '正在查询…' : '立即刷新';
    $('error').textContent = data.error || '';$('error').hidden = !data.error;
    $('cache-error').textContent = data.cacheError || '';$('cache-error').hidden = !data.cacheError;
    $('checked').textContent = data.checkedAt === null ? '尚未查询' : `刷新时间：${time(data.checkedAt)}`;
    $('summary').textContent = data.user && data.checkedAt !== null ? `${data.date} · ${data.keys.length} 个 Key · 合计 ${money(data.totalCost)}` : '';
    $('collapsed-summary').textContent = $('summary').textContent;
    $('empty').hidden = Boolean(data.keys.length);
    $('empty').textContent = working ? '正在查询该账号的全部 Key…' : !data.user ? '选择账号，查看其所有 Key 的今日实际扣费。' :
      data.checkedAt === null ? '尚未取得该账号今日消费。' : '该账号暂无 API Key。';
    $('table').hidden = !data.keys.length;$('note').hidden = !data.keys.length;
    // 快照轮询不重复构建相同表格，保留按钮焦点及用户正在操作的展开状态。
    const key = JSON.stringify([data.user?.id,data.date,data.keys]);
    if (key === listKey) return;
    listKey = key;
    const groups = new Map(), rows = [];
    for (const item of data.keys) {
      if (!groups.has(item.groupId)) groups.set(item.groupId,{name:item.groupName || (item.groupId === null ? '未绑定分组' : `分组 #${item.groupId}`),keys:[],cost:0});
      const group = groups.get(item.groupId);group.keys.push(item);group.cost += item.todayCost;
    }
    for (const [groupId,group] of [...groups.entries()].sort((a,b) => b[1].cost-a[1].cost)) {
      const heading = document.createElement('tr'), label = document.createElement('th'), total = document.createElement('td');
      const toggle = document.createElement('button'), arrow = document.createElement('span'), title = document.createElement('span');
      // 按账号与分组隔离折叠状态，避免不同账号的同名分组互相影响。
      const groupKey = `${data.user.id}:${groupId}`, children = [];
      heading.className = 'quota-key-group';label.colSpan = 2;label.scope = 'row';
      toggle.type = 'button';toggle.className = 'quota-key-group-toggle';
      toggle.setAttribute('aria-expanded',String(!collapsedGroups.has(groupKey)));
      arrow.className = 'quota-key-group-arrow';arrow.textContent = '▾';arrow.setAttribute('aria-hidden','true');
      title.textContent = `${group.name} · ${group.keys.length} 个 Key`;toggle.append(arrow,title);label.append(toggle);
      toggle.addEventListener('click',() => {
        const collapsed = !collapsedGroups.has(groupKey);
        if (collapsed) collapsedGroups.add(groupKey);else collapsedGroups.delete(groupKey);
        toggle.setAttribute('aria-expanded',String(!collapsed));
        for (const row of children) row.hidden = collapsed;
      });
      total.textContent = money(group.cost);heading.append(label,total);rows.push(heading);
      for (const item of group.keys.sort((a,b) => b.todayCost-a.todayCost || a.id-b.id)) {
        const row = document.createElement('tr'), name = document.createElement('th'), id = document.createElement('small');
        row.className = 'quota-key-item';row.hidden = collapsedGroups.has(groupKey);children.push(row);
        name.scope = 'row';name.textContent = item.name || '未命名 Key';id.textContent = `#${item.id}`;name.append(id);
        const status = document.createElement('td'), cost = document.createElement('td');
        status.textContent = ({active:'启用',inactive:'停用',expired:'已过期',quota_exhausted:'额度用尽'})[item.status] || '其他';
        cost.textContent = money(item.todayCost);cost.title = `$${item.todayCost}`;row.append(name,status,cost);rows.push(row);
      }
    }
    $('list').replaceChildren(...rows);
  }
  async function load(name = 'open', value) {
    // 只接受最后一次操作的结果，防止切换账号后旧请求覆盖新账号的展示。
    const revision = ++sequence;busy = true;
    if (latest) render(name === 'select' ? {...latest,user:null,keys:[],totalCost:0,checkedAt:null,error:''} : latest);
    try {const data = await invoke(name,value);if (revision === sequence) render(data);}
    catch {if (revision === sequence) {
      if (latest) latest = {...latest,error:'无法读取 Key 今日消费，请稍后重试。'};
      else {$('error').textContent = '无法读取 Key 今日消费，请稍后重试。';$('error').hidden = false;}
    }}
    finally {if (revision === sequence) {busy = false;if (latest) render(latest);}}
  }
  function clearSearch() {clearTimeout(timer);searchSequence++;}
  async function search() {
    const query = $('search').value.trim(), revision = ++searchSequence;
    $('search-status').textContent = '正在读取账号…';$('options').replaceChildren();
    try {
      const users = await invoke('search',query);
      if (revision !== searchSequence || !$('picker').open) return;
      $('options').replaceChildren(...users.map(user => {
        const option = document.createElement('button'), name = document.createElement('span'), check = document.createElement('span');
        option.type = 'button';option.setAttribute('role','option');option.setAttribute('aria-selected',String(user.id === latest?.user?.id));
        name.textContent = `${user.email} #${user.id}`;check.className = 'quota-group-check';check.textContent = '✓';check.setAttribute('aria-hidden','true');
        option.append(name,check);
        option.addEventListener('click',() => {$('picker').open = false;$('button').focus();void load('select',user.id);});
        return option;
      }));
      $('search-status').textContent = users.length ? '最多显示 30 个账号，可搜索邮箱或用户名。' : '没有匹配的账号。';
    } catch {if (revision === searchSequence) $('search-status').textContent = '读取账号失败，请重新展开后重试。';}
  }
  $('picker').addEventListener('toggle',() => {
    clearSearch();
    if ($('picker').open) {$('search').value = '';void search();$('search').focus();}
  });
  $('search').addEventListener('input',() => {
    clearSearch();$('options').replaceChildren();$('search-status').textContent = '正在搜索…';timer = setTimeout(() => void search(),300);
  });
  $('picker').addEventListener('keydown',event => {
    if (event.key === 'Escape') {$('picker').open = false;$('button').focus();return;}
    if (!['ArrowDown','ArrowUp','Home','End'].includes(event.key) || event.target === $('search') && ['Home','End'].includes(event.key)) return;
    event.preventDefault();
    if (!$('picker').open) {$('picker').open = true;return;}
    const options = [...$('options').querySelectorAll('button')], index = options.indexOf(document.activeElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length-1 : index < 0 ?
      (event.key === 'ArrowUp' ? options.length-1 : 0) : (index+(event.key === 'ArrowDown' ? 1 : -1)+options.length)%options.length;
    options[next]?.focus();
  });
  document.addEventListener('pointerdown',event => {if (!$('picker').contains(event.target)) $('picker').open = false;});
  $('refresh').addEventListener('click',() => {if (!busy && !polling) void load('refresh');});
  document.getElementById('nav-quota').addEventListener('click',() => {if (!busy && !polling) void load();});
  setInterval(async () => {
    // 收起或离开页面时暂停检查；snapshot 仅读本地状态，缓存到期才触发管理接口查询。
    if (document.getElementById('quota-view').hidden || $('body').hidden || busy || polling) return;
    polling = true;
    try {
      const revision = sequence, data = await invoke('snapshot');
      if (revision !== sequence) return;
      render(data);
      if (data.user && !data.busy && (data.attemptedAt === null || Date.now()-data.attemptedAt >= 1800000)) await load();
    } catch {/* 快照读取失败时保留当前结果，手动刷新会显示错误。 */}
    finally {polling = false;}
  },5000);
}
