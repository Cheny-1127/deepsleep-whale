const $ = id => document.getElementById('quota-group-' + id);
const compact = value => typeof value === 'number' ? new Intl.NumberFormat('en', {notation: 'compact', maximumFractionDigits: 1}).format(value) : '—';
const time = at => new Date(at).toLocaleString('zh-CN', {timeZone: 'Asia/Shanghai'});

export function createGroupUsageView() {
  if (!$('refresh')) return;
  let latest = null, busy = false, polling = false, listKey = '', groupsKey = '';
  function renderGroups() {
    if (!latest) return;
    const groups = [{id: null, name: '全部分组'}, ...latest.groups];
    if (latest.groupId !== null && !groups.some(group => group.id === latest.groupId)) groups.push({id: latest.groupId, name: `分组 #${latest.groupId}`});
    const query = $('search').value.trim().toLowerCase(), working = busy || latest.busy;
    const filtered = groups.filter(group => group.name.toLowerCase().includes(query));
    const key = JSON.stringify([filtered, latest.groupId, working]);
    if (key === groupsKey) return;
    groupsKey = key;
    $('no-match').hidden = filtered.length > 0;
    $('options').replaceChildren(...filtered.map(group => {
      const option = document.createElement('button');
      option.type = 'button';option.setAttribute('role', 'option');option.setAttribute('aria-selected', String(group.id === latest.groupId));
      option.disabled = working;
      const name = document.createElement('span');name.textContent = group.name;
      const check = document.createElement('span');check.className = 'quota-group-check';check.textContent = '✓';check.setAttribute('aria-hidden', 'true');
      option.append(name, check);
      option.addEventListener('click', () => {
        $('picker').open = false;$('button').focus();
        if (group.id !== latest.groupId) void change({groupId: group.id, period: latest.period});
      });
      return option;
    }));
  }
  function render(data) {
    latest = data;
    const working = busy || data.busy;
    $('toggle').setAttribute('aria-expanded', String(data.expanded !== false));
    $('body').hidden = data.expanded === false;
    $('tools').hidden = data.expanded === false;
    $('status').textContent = data.error ? `同步更新失败（${time(data.failedAt)}）` : '';
    $('status').hidden = !data.error;
    $('error').textContent = data.error || '';$('error').hidden = !data.error;
    $('cache-error').textContent = data.cacheError || '';$('cache-error').hidden = !data.cacheError;
    $('groups-error').textContent = data.groupsError || '';$('groups-error').hidden = !data.groupsError;
    $('checked').textContent = `刷新时间：${data.checkedAt != null ? time(data.checkedAt) : '尚未刷新'}`;
    $('selected').textContent = data.groupId === null ? '全部分组' : data.groups.find(group => group.id === data.groupId)?.name || `分组 #${data.groupId}`;
    $('button').setAttribute('aria-disabled', String(working));
    $('search').disabled = working;$('refresh').disabled = working;
    $('period-button').setAttribute('aria-disabled', String(working));
    $('period-selected').textContent = data.period === 'week' ? '每周' : '每日';
    for (const option of $('period-options').querySelectorAll('button')) {
      option.disabled = working;option.setAttribute('aria-selected', String(option.dataset.period === data.period));
    }
    $('refresh').textContent = working ? '正在刷新…' : '立即刷新';
    renderGroups();
    $('count').textContent = `展示 ${data.users.length} 位用户 · Top 20`;
    $('empty').hidden = data.users.length > 0;
    $('empty').textContent = data.checkedAt != null ? '所选分组在此时间范围内暂无用量。' : working ? '正在读取用户排行…' : '尚未取得此时间范围的用户排行。';
    $('table').hidden = !data.users.length;
    const key = JSON.stringify([data.groupId, data.period, data.date, data.users]);
    if (key === listKey) return;
    listKey = key;
    $('list').replaceChildren(...data.users.map((user, index) => {
      const row = document.createElement('tr');
      const rank = document.createElement('td'), badge = document.createElement('span');
      badge.className = `quota-group-rank quota-group-rank-${index + 1}`;badge.textContent = String(index + 1);rank.append(badge);
      const identity = document.createElement('th');identity.scope = 'row';
      const email = document.createElement('span');email.textContent = user.email || '未知用户';
      const id = document.createElement('small');id.textContent = ` #${user.user_id}`;
      identity.append(email, id);row.append(rank, identity);
      for (const field of ['requests', 'input_tokens', 'output_tokens', 'cache_tokens', 'total_tokens', 'actual_cost']) {
        const cell = document.createElement('td'), value = user[field];
        cell.textContent = value == null ? '—' : field === 'actual_cost' ? `$${value.toFixed(4)}` : field === 'requests' ? value.toLocaleString('en') : compact(value);
        if (field === 'actual_cost') cell.className = 'quota-group-cost';
        if (field === 'total_tokens') cell.className = 'quota-group-total';
        if (value != null) cell.title = field === 'actual_cost' ? `$${value}` : value.toLocaleString('en');
        row.append(cell);
      }
      return row;
    }));
  }
  async function invoke(name, value) {
    const response = await window.whale.quotaGroup(name, value);
    if (response.error) throw Error(response.error);
    return response.value;
  }
  function failure() {
    if (latest) render({...latest, error: '无法读取分组用量，请稍后重试。', failedAt: latest.failedAt ?? Date.now()});
    else {$('error').textContent = '无法读取分组用量，请稍后重试。';$('error').hidden = false;}
  }
  async function open() {
    if (busy || polling) return;
    busy = true;
    try {render(await invoke('snapshot'));if(document.getElementById('quota-view').dataset.moduleEnabled!=='false')render(await invoke('open'));}
    catch {failure();}
    finally {busy = false;if (latest) render(latest);}
  }
  async function change(filter) {
    if (busy || polling || latest?.busy) {if (latest) render(latest);return;}
    busy = true;
    if (latest) render(latest);
    try {render(await invoke(filter ? 'select' : 'refresh', filter));} catch {failure();}
    finally {busy = false;if (latest) render(latest);}
  }
  $('refresh').addEventListener('click', () => void change());
  $('toggle').addEventListener('click', async () => {
    if (!latest) return;
    try {render(await invoke('set-expanded', latest.expanded === false));} catch {failure();}
  });
  for (const option of $('period-options').querySelectorAll('button')) option.addEventListener('click', () => {
    $('period-picker').open = false;$('period-button').focus();
    if (latest && option.dataset.period !== latest.period) void change({groupId: latest.groupId, period: option.dataset.period});
  });
  $('search').addEventListener('input', renderGroups);
  // 两个筛选共用菜单交互：互斥展开，支持方向键、Esc 和点击外部关闭。
  for (const prefix of ['', 'period-']) {
    const picker = $(prefix + 'picker'), button = $(prefix + 'button'), optionsBox = $(prefix + 'options');
    button.addEventListener('click', event => {if (busy || latest?.busy) event.preventDefault();});
    picker.addEventListener('toggle', () => {
      if (!picker.open) return;
      $(prefix ? 'picker' : 'period-picker').open = false;
      if (!prefix) {$('search').value = '';renderGroups();$('search').focus();}
      else optionsBox.querySelector('[aria-selected="true"]')?.focus();
    });
    picker.addEventListener('keydown', event => {
      if (busy || latest?.busy || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
      if (event.target === $('search') && ['Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      if (!picker.open) {picker.open = true;return;}
      const options = [...optionsBox.querySelectorAll('button:not(:disabled)')], index = options.indexOf(document.activeElement);
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 :
        index < 0 ? (event.key === 'ArrowUp' ? options.length - 1 : 0) : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
      options[next]?.focus();
    });
    document.addEventListener('pointerdown', event => {
      if (picker.open && !picker.contains(event.target)) picker.open = false;
    });
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape' && picker.open) {picker.open = false;button.focus();}
    });
  }
  document.getElementById('nav-quota').addEventListener('click', () => void open());
  // 每 5 秒只读取内存快照；跨过上海时间午夜时主动转到新一天。
  setInterval(async () => {
    if (document.getElementById('quota-view').hidden || busy || polling) return;
    polling = true;
    try {
      const data = await invoke('snapshot'), changedDay = latest?.date !== data.date;
      render(data);
      if (changedDay&&document.getElementById('quota-view').dataset.moduleEnabled!=='false') render(await invoke('open'));
    } catch {failure();}
    finally {polling = false;}
  }, 5000);
}
