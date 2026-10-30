import { updateSidebarStatus } from './sidebar-view.mjs';
import { confirmAction } from './confirm-dialog.mjs';
const $ = id => document.getElementById('quota-' + id);
const columns = [['showName', 'show-name', 'name-heading'], ['showPlatform', 'show-platform', 'platform-heading'],
  ['showRemaining', 'show-remaining', 'remaining-heading'], ['showSyncedAt', 'show-synced-at', 'synced-at-heading'], ['showRefresh', 'show-refresh', 'refresh-heading']];
// 前五项对应实际表格列；点数和 5 小时额度只控制单元格内部内容。
const settings = [...columns, ['showCredits', 'show-credits'], ['showFiveHour', 'show-five-hour']];

function resetCountdown(at) {
  const minutes = Math.ceil((Date.parse(at) - Date.now()) / 60000);
  if (minutes <= 0) return '0m';
  if (minutes >= 1440) return `${Math.floor(minutes / 1440)}d ${Math.floor(minutes % 1440 / 60)}h`;
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${minutes}m`;
}

function dateTime(at) {
  const date = new Date(at);
  if (!Number.isFinite(date.getTime())) return null;
  const pad = value => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth()+1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 未取得额度时显示缺失状态，不能画成 0% 或仍在读取的进度条。
function quotaMetric(name, period, remaining) {
  const line = document.createElement('div');
  line.className = `quota-window quota-window-${period}`;
  const label = document.createElement('span');
  label.className = 'quota-period';
  label.textContent = period;
  const value = document.createElement('strong');
  value.className = 'quota-value';
  const known = typeof remaining === 'number' && Number.isFinite(remaining);
  const percent = known ? Math.round(Math.min(100, Math.max(0, remaining))) : null;
  value.textContent = known ? `${percent}%` : '—';
  if (!known) value.title = '暂无数据';
  line.append(label);
  if (known) {
    const bar = document.createElement('progress');
    bar.max = 100;
    bar.value = percent;
    bar.setAttribute('aria-label', `${name} · ${period === '5h' ? '5 小时' : '7 天'}剩余`);
    bar.textContent = `${percent}%`;
    line.append(bar);
  } else {
    const placeholder = document.createElement('span');
    placeholder.className = 'quota-bar-empty';
    line.append(placeholder);
  }
  line.append(value);
  return line;
}

// 订阅与重置卡成组，所有接口文字都按纯文本显示。
function quotaPlatform(account, selected, onSelect) {
  const cell = document.createElement('td');
  cell.className = 'quota-platform';
  function chip(text, className) {
    const label = document.createElement('button');
    label.type = 'button';
    label.className = `quota-chip ${className}`;
    label.textContent = text;
    return label;
  }
  const subscription = document.createElement('div');
  subscription.className = 'quota-badge-group';
  const known = Number.isSafeInteger(account.resetCardCount) && account.resetCardCount >= 0;
  const reset = chip(`重置次数 ${known ? account.resetCardCount : '—'}`, 'quota-reset-count');
  reset.title = known ? `可用重置卡：${account.resetCardCount} 张` : '暂无重置卡数据';
  const dates = (known && account.resetCardCount > 0 && Array.isArray(account.resetCardExpiresAt) ? account.resetCardExpiresAt : []).map(dateTime).filter(Boolean);
  if (dates.length) reset.title += `\n到期时间：\n${dates.join('\n')}`;
  const plan = chip(account.subscriptionType || '订阅未知', 'quota-subscription');
  subscription.append(plan, reset);
  const expiry = document.createElement('div');
  expiry.className = 'quota-expiry';
  const subscriptionDate = account.subscriptionExpiresAt ? dateTime(account.subscriptionExpiresAt) : null;
  const accountText = subscriptionDate ? `账号到期：\n${subscriptionDate}` : '账号到期时间未知';
  const resetText = dates.length ? `重置卡到期：\n${dates[0]}` : known && account.resetCardCount === 0 ? '暂无可用重置卡' : '重置卡到期时间未知';
  function select(value) {
    plan.setAttribute('aria-pressed', String(value === 'subscription'));
    reset.setAttribute('aria-pressed', String(value === 'reset'));
    expiry.textContent = value === 'reset' ? resetText : accountText;
    onSelect(value);
  }
  plan.addEventListener('click', () => select('subscription'));
  reset.addEventListener('click', () => select('reset'));
  select(selected);
  cell.append(subscription, expiry);
  return cell;
}

export function createQuotaView() {
  if (!$('view')) return;
  let latest = null, busy = false, syncing = false, saving = false, listKey = '', sequence = 0, refreshButtons = [], resetLabels = [];
  let intervalDirty = false;
  const selectedExpiry = new Map();
  let closeAccountMenu = null;
  // 兼容已保存的分钟/小时配置；界面统一显示秒，不在读取时改写旧设置。
  function savedSeconds() {
    const saved=latest?.refreshInterval||{value:5,unit:'minutes'};
    return saved.value*({seconds:1,minutes:60,hours:3600}[saved.unit]);
  }
  function durationLabel(seconds) {
    const hours=Math.floor(seconds/3600),minutes=Math.floor(seconds%3600/60),rest=seconds%60;
    return [hours?`${hours}时`:'',minutes?`${minutes}分`:'',rest?`${rest}秒`:''].filter(Boolean).join('')||'0秒';
  }
  function intervalControls() {
    if (!intervalDirty) $('interval-value').value=String(savedSeconds());
    const raw=$('interval-value').value,seconds=Number(raw);
    // 外层预留固定位置，边框随数字与换算伸缩；长换算省略时悬停可读完整内容。
    const showPreview=Number.isSafeInteger(seconds)&&seconds>=60;
    $('interval-preview').hidden=!showPreview;
    $('interval-preview').textContent=showPreview?durationLabel(seconds):'';
    $('interval-preview').title=showPreview?durationLabel(seconds):'';
    // 网络刷新不锁住本地频率设置，只有设置写入期间短暂禁用。
    const disabled=saving||!latest;
    $('interval-value').disabled=disabled;$('interval-retry').disabled=disabled;
    $('interval-control').setAttribute('aria-busy',String(saving));
  }
  function render(data) {
    if (!data) return;
    latest = data;
    updateSidebarStatus('quota',data);
    intervalControls();
    const intervalLabel = data.refreshIntervalLabel || '5 分钟';
    const refreshing = data.busy || busy;
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const paused = accounts.length > 0 && accounts.every(account => account.refreshEnabled === false);
    const failedTime = data.failedAt != null ? `（${new Date(data.failedAt).toLocaleString('zh-CN')}）` : '';
    $('status').className = data.error ? 'pill quota-sync-failed' : 'pill';
    $('status').textContent = data.error ? `同步更新失败${failedTime}` : refreshing ? '正在读取' : paused ? '已暂停刷新' : data.checkedAt != null ? '已同步' : '等待读取';
    $('error').textContent = data.error || '';
    $('error').hidden = !data.error;
    $('cache-error').textContent = data.cacheError || '';
    $('cache-error').hidden = !data.cacheError;
    $('count').textContent = `${accounts.length} 个账号`;
    $('table').hidden = !accounts.length;
    $('empty').hidden = Boolean(accounts.length);
    $('empty').textContent = data.checkedAt != null ? '没有记下额度的账号。' : refreshing ? '正在读取账号额度…' : '尚未读取账号额度。';
    $('refresh').disabled = refreshing || saving;
    $('refresh').textContent = refreshing ? '正在刷新…' : '立即刷新';
    const showFiveHour = data.listSettings?.showFiveHour !== false;
    for (const [key, control, heading] of settings) {
      const visible = data.listSettings?.[key] !== false;
      $(control).checked = visible;
      $(control).disabled = refreshing || saving;
      if (heading) $(heading).hidden = !visible;
    }
    // 显示偏好与接口可用性分开：全部账号明确不支持时，不显示误导性的勾选。
    const fiveHourUnavailable = accounts.length > 0 && accounts.every(account => account.fiveHourWindowMinutes === 0);
    $('show-five-hour').checked = showFiveHour && !fiveHourUnavailable;
    $('show-five-hour').disabled = refreshing || saving || fiveHourUnavailable;
    $('five-hour-hint').textContent = fiveHourUnavailable ? '当前账号不适用' : '';
    $('five-hour-hint').hidden = !fiveHourUnavailable;
    // 本地快照轮询时更新倒计时，不重建未变化的账号行，也不额外请求接口。
    for (const {label, at} of resetLabels) label.textContent = resetCountdown(at);
    for (const button of refreshButtons) button.disabled = refreshing || saving;
    const key = JSON.stringify([accounts, settings.map(([key]) => data.listSettings?.[key] !== false), intervalLabel]);
    if (key === listKey) return;
    listKey = key;
    closeAccountMenu?.();
    refreshButtons = [];
    resetLabels = [];
    $('list').replaceChildren(...accounts.map(account => {
      const row = document.createElement('tr');
      if (account.upstreamMissing) row.className = 'quota-account-missing';
      const title = document.createElement('th');
      title.className = 'quota-account';
      if (account.upstreamMissing) {
        title.title = '上游账号不存在；右键管理本地账号';
      }
      title.setAttribute('scope', 'row');
      const name = account.name || `账号 #${account.id}`;
      // 账号名称始终按纯文本展示，长名称只换行，不挤偏额度列。
      title.textContent = name;
      title.tabIndex = 0;
      title.setAttribute('aria-haspopup', 'menu');
      if (!account.upstreamMissing) title.title = '右键管理本地账号';
      const openMenu = event => { event.preventDefault(); void accountMenu(account, title, event); };
      title.addEventListener('contextmenu', openMenu);
      title.addEventListener('keydown', event => {
        if (event.key === 'ContextMenu' || (event.shiftKey && event.key === 'F10')) openMenu(event);
      });
      const refreshCell = document.createElement('td');
      const toggle = document.createElement('button');
      const enabled = account.refreshEnabled !== false;
      toggle.type = 'button';
      toggle.className = 'quota-refresh-toggle';
      toggle.setAttribute('role', 'switch');
      toggle.setAttribute('aria-label', `${name} · 刷新`);
      toggle.setAttribute('aria-checked', String(enabled));
      toggle.textContent = enabled ? '已开启' : '已关闭';
      toggle.title = enabled ? `参与每 ${intervalLabel}及手动刷新` : '保留已有额度，仍检查上游账号是否存在';
      toggle.disabled = refreshing || saving;
      toggle.addEventListener('click', () => void setRefreshEnabled(account.id, !enabled));
      refreshButtons.push(toggle);
      // 单账号成功时间独立于整轮刷新；旧缓存未知时不借用整轮时间。
      const syncedAt = document.createElement('td');
      syncedAt.className = 'quota-account-synced';
      const syncedDate = account.lastSyncedAt != null ? new Date(account.lastSyncedAt) : null;
      const syncedKnown = syncedDate && Number.isFinite(syncedDate.getTime());
      const dateLabel = syncedKnown ? [syncedDate.getFullYear(), syncedDate.getMonth() + 1, syncedDate.getDate()].map(value => String(value).padStart(2, '0')).join('-') : '';
      syncedAt.textContent = syncedKnown ? `${dateLabel}\n${syncedDate.toLocaleTimeString('zh-CN', {hour12: false})}` : '尚无同步时间';
      syncedAt.title = syncedKnown ? `最后成功同步：${syncedDate.toLocaleString('zh-CN')}（本机同步网关数据）` : '下次成功同步后记录时间';
      syncedAt.setAttribute('aria-label', syncedAt.title);
      refreshCell.append(toggle);
      const windows = document.createElement('td');
      windows.className = 'quota-windows';
      const fiveHour = quotaMetric(name, '5h', account.fiveHourRemaining);
      // 接口可能为无效窗口返回 0% 已用和一个旧时间，窗口为 0 时整行隐藏。
      fiveHour.hidden = !showFiveHour || account.fiveHourWindowMinutes === 0;
      const sevenDay = quotaMetric(name, '7d', account.sevenDayRemaining);
      sevenDay.hidden = account.sevenDayWindowMinutes === 0;
      for (const [line, at] of [[fiveHour, account.fiveHourResetAt], [sevenDay, account.sevenDayResetAt]]) {
        if (line.hidden || typeof at !== 'string' || !Number.isFinite(Date.parse(at))) continue;
        const label = document.createElement('span');
        label.className = 'quota-reset-time';
        label.tabIndex = 0;
        const tooltip = document.createElement('span');
        tooltip.className = 'quota-reset-tooltip';
        tooltip.id = `quota-reset-${account.id}-${line === fiveHour ? '5h' : '7d'}`;
        tooltip.setAttribute('role', 'tooltip');
        tooltip.textContent = `重置时间：${new Date(at).toLocaleString('zh-CN')}`;
        label.setAttribute('aria-describedby', tooltip.id);
        const countdown = document.createElement('span');
        countdown.textContent = resetCountdown(at);
        const icon = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        icon.setAttribute('class', 'quota-reset-icon');
        icon.setAttribute('viewBox', '0 0 24 24');
        icon.setAttribute('fill', 'none');
        icon.setAttribute('stroke', 'currentColor');
        icon.setAttribute('stroke-width', '1.8');
        icon.setAttribute('stroke-linecap', 'round');
        icon.setAttribute('stroke-linejoin', 'round');
        icon.setAttribute('aria-hidden', 'true');
        icon.setAttribute('focusable', 'false');
        const arrows = document.createElementNS('http://www.w3.org/2000/svg', 'path');
        arrows.setAttribute('d', 'M20 11a8 8 0 0 0-14-5L3 9m0-5v5h5M4 13a8 8 0 0 0 14 5l3-3m0 5v-5h-5');
        icon.append(arrows);
        label.append(countdown, icon, tooltip);
        line.append(label);
        resetLabels.push({label: countdown, at});
      }
      windows.append(fiveHour, sevenDay);
      if (fiveHour.hidden && sevenDay.hidden) {
        const empty = document.createElement('span');
        empty.className = 'quota-unavailable';
        empty.textContent = '暂无适用额度';
        windows.append(empty);
      }
      const credits = document.createElement('div');
      credits.className = 'quota-credits';
      // 点数跟随账号名称展示；沿用旧点数偏好，新增刷新时间列使用独立偏好。
      const knownBalance = typeof account.creditsBalance === 'number' && Number.isFinite(account.creditsBalance) && account.creditsBalance >= 0;
      credits.textContent = knownBalance ? account.creditsBalance.toLocaleString('en-US', {maximumFractionDigits: 10}) : '—';
      credits.title = knownBalance ? `点数余额：${account.creditsBalance}` : '暂无点数数据';
      credits.hidden = data.listSettings?.showCredits === false;
      credits.setAttribute('aria-label', credits.title);
      title.append(credits);
      if (account.upstreamMissing) {
        const missing = document.createElement('div');
        missing.className = 'quota-missing-label';
        missing.textContent = '上游账号不存在 · 右键管理';
        title.append(missing);
      }
      row.append(title, quotaPlatform(account, selectedExpiry.get(account.id) || 'subscription', value => selectedExpiry.set(account.id, value)), windows, syncedAt, refreshCell);
      columns.forEach(([key], index) => { row.children[index].hidden = data.listSettings?.[key] === false; });
      return row;
    }));
  }
  async function invoke(name, value) {
    const result = await window.whale.quota(name, value);
    if (result.error) throw new Error(result.error);
    return result.value;
  }
  async function sync(checkFreshness = false) {
    if (busy || syncing || saving) return;
    syncing = true;
    const stamp = ++sequence;
    try {
      const data = await invoke('snapshot');
      if (stamp === sequence) {
        render(data);
        // 重试按后台下次刷新时间判断，独立于标签保留的首次失败时间。
        const lastSync = data.attemptedAt ?? data.checkedAt;
        const due = data.nextRefreshAt != null ? Date.now() >= data.nextRefreshAt :
          lastSync == null || Date.now() - lastSync >= (data.refreshIntervalMs ?? 300000);
        if (checkFreshness && $('view').dataset.moduleEnabled!=='false' && !data.busy && due) await refresh();
      }
    } catch {
      if (stamp === sequence) {
        $('error').textContent = '无法读取额度状态，请稍后重试。';
        $('error').hidden = false;
      }
    } finally { syncing = false; }
  }
  async function refresh() {
    if (busy || saving || latest?.busy) return;
    sequence++;
    busy = true;
    render(latest || {accounts: [], error: '', checkedAt: null, busy: true});
    try { render(await invoke('refresh')); }
    catch (error) {
      if (latest) latest = {...latest, error: error.message, failedAt: latest.failedAt ?? Date.now()};
      $('error').textContent = error.message;
      $('error').hidden = false;
    } finally {
      busy = false;
      if (latest) render(latest);
    }
  }
  async function setRefreshEnabled(id, enabled) {
    if (busy || saving || latest?.busy) return;
    sequence++;
    saving = true;
    $('settings-error').hidden = true;
    render(latest);
    try { render(await invoke('set-refresh', {id, enabled})); }
    catch {
      $('settings-error').textContent = '账号刷新设置保存失败，请重试。';
      $('settings-error').hidden = false;
    } finally {
      saving = false;
      if (latest) render(latest);
    }
  }
  let accountMenuOpen = false;
  function showAccountMenu(anchor, event) {
    const menu = document.createElement('div'), item = document.createElement('button');
    // 右键在 mouseDown 时打开；auto 弹层会在同次 mouseUp 时被浏览器误关。
    menu.className = 'quota-account-menu';menu.popover = 'manual';menu.setAttribute('role','menu');
    menu.setAttribute('aria-label','账号操作');
    item.type = 'button';item.className = 'ui-menu-item ui-danger-action';
    item.setAttribute('role','menuitem');item.textContent = '删除本地账号…';
    menu.append(item);$('view').append(menu);
    return new Promise(resolve => {
      let action = null, finished = false;
      const close = () => {
        if (finished) return;
        finished = true;
        menu.hidePopover();
        document.removeEventListener('whale-view-changed', navigation);
        document.removeEventListener('scroll', close, true);
        document.removeEventListener('pointerdown', outside, true);
        closeAccountMenu = null;menu.remove();resolve(action);
      };
      closeAccountMenu = close;
      const navigation = () => { if ($('view').hidden || $('view').inert) close(); };
      const outside = pointer => { if (!menu.contains(pointer.target)) close(); };
      document.addEventListener('whale-view-changed', navigation);
      document.addEventListener('scroll', close, true);
      document.addEventListener('pointerdown', outside, true);
      item.addEventListener('click', () => { action = 'remove';close(); });
      menu.addEventListener('keydown', key => {
        if (key.key === 'Escape' || key.key === 'Tab') { close();if (key.key === 'Escape') {key.preventDefault();anchor.focus({preventScroll:true});} }
        if (key.key === 'ArrowDown' || key.key === 'ArrowUp') {key.preventDefault();item.focus();}
      });
      menu.showPopover();
      const rect = anchor.getBoundingClientRect(), size = menu.getBoundingClientRect();
      const x = event.type === 'contextmenu' ? event.clientX : rect.left;
      const y = event.type === 'contextmenu' ? event.clientY : rect.bottom;
      menu.style.left = `${Math.max(8,Math.min(x,window.innerWidth-size.width-8))}px`;
      menu.style.top = `${Math.max(8,Math.min(y,window.innerHeight-size.height-8))}px`;
      item.focus({preventScroll:true});
    });
  }
  async function accountMenu(account, anchor, event) {
    if (accountMenuOpen || busy || saving || latest?.busy) return;
    accountMenuOpen = true;
    try {
      const action = await showAccountMenu(anchor, event);
      if (action !== 'remove') return;
      const confirmed = await confirmAction({owner:$('view'), title:'删除本地账号？',
        message:`确定删除“${account.name || `账号 #${account.id}`}”这个本地账号？上游账号不会被删除；若它仍存在，下次刷新会重新显示。`,
        confirmLabel:'删除本地账号', danger:true});
      if (confirmed) await removeAccount(account.id);
    } catch (error) { $('settings-error').textContent = error.message; $('settings-error').hidden = false; }
    finally { accountMenuOpen = false; }
  }
  async function removeAccount(id) {
    if (busy || saving || latest?.busy) return;
    sequence++;
    saving = true;
    $('settings-error').hidden = true;
    render(latest);
    try { render(await invoke('remove-account', id)); selectedExpiry.delete(id); }
    catch (error) { $('settings-error').textContent = error.message; $('settings-error').hidden = false; }
    finally { saving = false; if (latest) render(latest); }
  }
  $('refresh').addEventListener('click', () => void refresh());
  function intervalChanged() {
    intervalDirty = $('interval-value').value.trim()===''||Number($('interval-value').value)!==savedSeconds();
    $('interval-feedback').textContent = '';$('interval-retry').hidden = true;intervalControls();
  }
  $('interval-value').addEventListener('input',intervalChanged);
  async function saveInterval() {
    if (saving || !latest || !intervalDirty) return;
    const raw=$('interval-value').value.trim();
    // 清空只是临时编辑状态，完成编辑时恢复原值，不额外重置轮询时间。
    if(raw==='') {intervalDirty=false;$('interval-feedback').textContent='';$('interval-retry').hidden=true;intervalControls();return;}
    const input=Number(raw);
    if(!Number.isFinite(input)) {$('interval-feedback').textContent='未保存：请输入整数秒数。';return;}
    // 只在提交时收敛上下限，输入过程中保持原文并实时换算，避免光标跳动。
    const seconds=Math.min(86400,Math.max(5,input));
    if(!Number.isInteger(seconds)) {$('interval-feedback').textContent='未保存：请输入整数秒数。';return;}
    $('interval-value').value=String(seconds);intervalControls();
    if(seconds===savedSeconds()) {intervalDirty=false;$('interval-feedback').textContent='';$('interval-retry').hidden=true;return;}
    const value={value:seconds,unit:'seconds'};
    // 本地保存成功保持安静；通过禁用状态表示处理中，仅失败时显示说明与重试。
    sequence++;saving = true;$('interval-retry').hidden=true;$('interval-feedback').textContent = '';render(latest);
    try {
      const data = await invoke('set-interval',value);
      intervalDirty = false;render(data);$('interval-feedback').textContent = '';
    } catch (error) {
      $('interval-feedback').textContent = '未保存，原刷新频率仍有效。';$('interval-retry').hidden=false;
    } finally {saving = false;render(latest);}
  }
  $('interval-form').addEventListener('submit',event=>{event.preventDefault();return saveInterval();});
  $('interval-retry').addEventListener('click',()=>void saveInterval());
  // 失焦和回车共用提交逻辑；保存导致的禁用失焦不重复提交。
  $('interval-control').addEventListener('focusout',()=>{
    if(saving)return;
    setTimeout(()=>{if (!$('interval-control').contains(document.activeElement)) void saveInterval();},0);
  });
  $('interval-value').addEventListener('keydown',event=>{
    if(event.key==='Enter'&&!event.isComposing){event.preventDefault();void saveInterval();}
  });
  for (const [key, control] of settings) $(control).addEventListener('change', async () => {
    if (busy || saving || latest?.busy || !latest || $(control).disabled) { if (latest) render(latest);return; }
    const enabled = $(control).checked;
    sequence++;
    saving = true;
    $('settings-error').hidden = true;
    render(latest);
    try { render(await invoke('set-list', {[key]: enabled})); }
    catch (error) {
      $('settings-error').textContent = error.message === '请至少保留一列' ? error.message : '列设置保存失败，请重试。';
      $('settings-error').hidden = false;
    } finally {
      saving = false;
      render(latest);
    }
  });
  // 勾选时保持菜单展开，点击外部或按 Esc 收起，键盘焦点回到入口。
  document.addEventListener('pointerdown', event => {
    if ($('list-settings').open && !$('list-settings').contains(event.target)) $('list-settings').open = false;
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && $('list-settings').open) {
      $('list-settings').open = false;
      $('columns-button').focus();
    }
  });
  document.getElementById('nav-quota').addEventListener('click', () => void sync(true));
  // 此处只同步内存快照；网络轮询由主进程按已保存的间隔调度，不覆盖正在编辑的输入。
  setInterval(() => { if (!$('view').hidden) void sync(); }, 5000);
}
