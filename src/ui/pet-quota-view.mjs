// 额度条共用缓存；主条同步配置，副条在桌宠上临时选择账号。
export function createPetQuotaView() {
  if (!document.getElementById('pet-quota-controls')) return;
  const bars = new Map();
  const primaryGet = name => document.getElementById('pet-quota-' + name);
  bars.set('primary',{slot:'primary',controls:primaryGet('controls'),refresh:primaryGet('refresh'),fill:primaryGet('fill'),percent:primaryGet('percent'),meter:primaryGet('meter'),name:null,ranking:document.getElementById('pet-ranking-button'),tracking:null});
  function makeBar(id) {
    const root=document.getElementById('pet-quota-bar-template').content.cloneNode(true).firstElementChild;
    root.dataset.configId=String(id);root.id=`pet-quota-config-${id}`;
    document.getElementById('pet-quota-extra-bars').append(root);
    const get=name=>root.querySelector(`[data-field="${name}"]`);
    const bar={slot:id,controls:root,refresh:get('refresh'),fill:get('fill'),percent:get('percent'),meter:get('meter'),name:get('name'),ranking:get('ranking'),tracking:null};
    bars.set(id,bar);bindBar(bar);return bar;
  }
  let polling = false, switching = false, revision = 0;
  // 本地刷新状态按账号隔离，点击一条时不把其他账号的按钮一起禁用。
  const refreshingAccounts = new Set();
  function renderRefresh() {
    for (const bar of bars.values()) {
      const data = bar.tracking, busy = refreshingAccounts.has(data?.accountId) || data?.busy === true;
      bar.refresh.disabled = busy || switching || data?.accountId == null || data.paused;
      bar.refresh.setAttribute('aria-busy', String(busy));
      bar.refresh.title = busy ? '正在刷新额度' : data?.accountId == null ? '请先选择跟踪账号' : data.paused ? '跟踪账号已暂停刷新' : data.error ? '额度同步失败，点击重试' : '刷新额度';
    }
  }
  function renderBar(bar, data) {
    bar.tracking = data;
    bar.controls.hidden = !data;
    if (!data) return;
    bar.controls.dataset.tone = data.tone;
    bar.fill.style.width = data.remaining == null ? '0%' : `${Math.max(0, Math.min(100, data.remaining))}%`;
    bar.percent.textContent = data.remaining == null ? '—' : `${Math.round(data.remaining)}%`;
    if (bar.name) bar.name.textContent = data.name || (data.accountId == null ? '双击选择账号' : `账号 #${data.accountId}`);
    let text = data.accountId === null ? '尚未选择跟踪账号' : data.remaining === null ? `${data.name || '跟踪账号'} · 暂无 7d 额度数据` : `${data.name} · 7d 剩余 ${Math.round(data.remaining)}%`;
    if (data.resetAt) text += `\n重置时间：${new Date(data.resetAt).toLocaleString('zh-CN')}`;
    if (data.error) text += '\n同步失败，当前为上次数据';
    if (data.paused) text += '\n账号已暂停刷新';
    text += '\n双击进度条选择跟踪账号';
    if (bar.slot !== 'primary') text += `\n临时切换，重启后恢复流量跟踪配置-${bar.slot}`;
    bar.controls.title = text;
    bar.meter.setAttribute('aria-label', text);
    if (data.remaining == null) bar.meter.removeAttribute('aria-valuenow');
    else bar.meter.setAttribute('aria-valuenow', String(data.remaining));
  }
  function render(data) {
    renderBar(bars.get('primary'), data.tracking);
    const extras=data.extraTrackings || [];
    for(const [id,bar] of bars)if(id!=='primary'&&!extras.some(item=>item.id===id)){bar.controls.remove();bars.delete(id);}
    for(const item of extras)renderBar(bars.get(item.id)||makeBar(item.id),item.tracking);
    renderRefresh();
  }
  async function sync() {
    if (polling || switching || document.hidden) return;
    polling = true;
    const current = revision;
    try {
      const result = await window.whale.petQuota('snapshot');
      if (current !== revision) return;
      if (result.error) throw Error();
      render(result.value);
    } catch {if (current === revision) bars.forEach(bar => {bar.controls.title = '额度状态暂不可用';});}
    finally {polling = false;}
  }
  function bindBar(bar) {
    bar.ranking.addEventListener('click', () => void window.whale.petQuota('ranking',bar.slot));
    bar.refresh.addEventListener('click', async () => {
      if (bar.refresh.disabled) return;
      const accountId = bar.tracking.accountId;
      refreshingAccounts.add(accountId);
      renderRefresh();
      let error = '';
      try {
        const result = await window.whale.petQuota('refresh', bar.slot);
        if (result.error) error = result.error;
      } catch {error = '额度刷新失败，请重试';}
      finally {
        refreshingAccounts.delete(accountId);
        await sync();
        renderRefresh();
        if (error) {bar.controls.title = error;bar.refresh.title = error;}
      }
    });
    bar.controls.addEventListener('dblclick', async event => {
      if (event.target.closest('button') || switching) return;
      switching = true;
      // 切换账号后忽略之前发出的轮询结果，避免旧账号短暂覆盖新选择。
      revision++;
      renderRefresh();
      let error = '';
      try {
        const result = await window.whale.petQuota('choose-account', bar.slot);
        if (result.error) error = result.error;
        else render(result.value);
      } catch {error = '切换账号失败，请重试';}
      finally {
        switching = false;
        renderRefresh();
        if (error) bar.controls.title = error;
      }
    });
  }
  bindBar(bars.get('primary'));
  document.addEventListener('visibilitychange', () => void sync());
  setInterval(() => void sync(), 5000);
  void sync();
}
