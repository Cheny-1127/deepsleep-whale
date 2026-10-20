// 底条只读主进程摘要。定时轮询不直接请求额度接口，手动刷新才触发同步。
export function createPetQuotaView() {
  const controls = document.getElementById('pet-quota-controls');
  if (!controls) return;
  const refreshButton = document.getElementById('pet-quota-refresh');
  let polling = false, refreshing = false, tracking = null;
  function renderRefresh() {
    const busy = refreshing || tracking?.busy === true;
    refreshButton.disabled = busy || tracking?.accountId == null || tracking.paused;
    refreshButton.setAttribute('aria-busy', String(busy));
    refreshButton.title = busy ? '正在刷新额度' : tracking?.accountId == null ? '请先选择跟踪账号' : tracking.paused ? '跟踪账号已暂停刷新' : tracking.error ? '额度同步失败，点击重试' : '刷新额度';
  }
  async function sync() {
    if (polling || document.hidden) return;
    polling = true;
    try {
      const result = await window.whale.petQuota('snapshot');
      if (result.error) throw Error();
      const data = result.value.tracking, fill = document.getElementById('pet-quota-fill');
      tracking = data;
      renderRefresh();
      controls.dataset.tone = data.tone;
      fill.style.width = data.remaining == null ? '0%' : `${Math.max(0, Math.min(100, data.remaining))}%`;
      document.getElementById('pet-quota-percent').textContent = data.remaining == null ? '—' : `${Math.round(data.remaining)}%`;
      let text = data.accountId === null ? '请在 API 额度中选择跟踪账号' : data.remaining === null ? `${data.name || '跟踪账号'} · 暂无 7d 额度数据` : `${data.name} · 7d 剩余 ${Math.round(data.remaining)}%`;
      if (data.resetAt) text += `\n重置时间：${new Date(data.resetAt).toLocaleString('zh-CN')}`;
      if (data.error) text += '\n同步失败，当前为上次数据';
      if (data.paused) text += '\n账号已暂停刷新';
      controls.title = text;
      document.getElementById('pet-quota-meter').setAttribute('aria-label', text);
      if (data.remaining == null) document.getElementById('pet-quota-meter').removeAttribute('aria-valuenow');
      else document.getElementById('pet-quota-meter').setAttribute('aria-valuenow', String(data.remaining));
    } catch {controls.title = '额度状态暂不可用';}
    finally {polling = false;}
  }
  refreshButton.addEventListener('click', async () => {
    if (refreshButton.disabled) return;
    refreshing = true;
    renderRefresh();
    let error = '';
    try {
      const result = await window.whale.petQuota('refresh');
      if (result.error) error = result.error;
    } catch {error = '额度刷新失败，请重试';}
    finally {
      refreshing = false;
      await sync();
      renderRefresh();
      if (error) {controls.title = error;refreshButton.title = error;}
    }
  });
  document.getElementById('pet-ranking-button').addEventListener('click', () => void window.whale.petQuota('ranking'));
  document.addEventListener('visibilitychange', () => void sync());
  setInterval(() => void sync(), 5000);
  void sync();
}
