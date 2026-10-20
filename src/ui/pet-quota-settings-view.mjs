const $ = id => document.getElementById('quota-pet-' + id);

export function createPetQuotaSettingsView() {
  if (!$('body')) return;
  let latest, saving = false, polling = false, accountsKey = '', initialized = false, revision = 0;
  const accountsToggle = document.getElementById('quota-accounts-toggle');
  function render(data) {
    latest = data;
    for (const [button, body, expanded] of [
      [accountsToggle, document.getElementById('quota-accounts-body'), data.settings.accountsExpanded],
      [$('toggle'), $('body'), data.settings.configExpanded]
    ]) {
      button.setAttribute('aria-expanded', String(expanded));body.hidden = !expanded;button.disabled = saving;
    }
    document.getElementById('quota-account-tools').hidden = !data.settings.accountsExpanded;
    $('group').textContent = data.ranking.groupName;
    // 阈值只在首次同步填入，避免轮询覆盖正在编辑的数字。
    if (!initialized) {
      $('yellow').value = data.settings.yellowBelow;$('red').value = data.settings.redBelow;initialized = true;
    }
    $('thresholds').querySelector('button').disabled = saving;
    const key = JSON.stringify([data.accounts, data.settings.accountId, saving]);
    if (key === accountsKey) return;
    accountsKey = key;
    const accounts = [{id: null, name: '暂不跟踪'}, ...data.accounts];
    if (data.settings.accountId !== null && !accounts.some(account => account.id === data.settings.accountId)) {
      accounts.push({id: data.settings.accountId, name: `账号 #${data.settings.accountId}（暂不可用）`});
    }
    $('accounts').replaceChildren(...accounts.map(account => {
      const label = document.createElement('label'), radio = document.createElement('input'), text = document.createElement('span');
      radio.type = 'radio';radio.name = 'pet-quota-account';radio.value = account.id ?? '';
      radio.checked = account.id === data.settings.accountId;radio.disabled = saving;
      radio.addEventListener('change', () => {if (radio.checked) void update({accountId: account.id});});
      text.textContent = account.name || `账号 #${account.id}`;label.append(radio, text);return label;
    }));
  }
  async function invoke(name, patch) {
    const result = await window.whale.petQuota(name, patch);
    if (result.error) throw Error(result.error);
    return result.value;
  }
  function error(message) {$('error').textContent = message;$('error').hidden = false;}
  async function update(patch) {
    if (saving || !latest) return;
    revision++;saving = true;$('error').hidden = true;render(latest);
    try {render(await invoke('update', patch));}
    catch (reason) {error(reason.message || '桌宠配置保存失败，请重试。');}
    finally {saving = false;render(latest);}
  }
  async function sync() {
    if (saving || polling) return;
    polling = true;const stamp = revision;
    try {const data = await invoke('snapshot');if (stamp === revision) render(data);} catch {if (stamp === revision) error('暂时无法读取桌宠配置，请稍后重试。');}
    finally {polling = false;}
  }
  accountsToggle.addEventListener('click', () => {if (latest) void update({accountsExpanded: !latest.settings.accountsExpanded});});
  $('toggle').addEventListener('click', () => {if (latest) void update({configExpanded: !latest.settings.configExpanded});});
  $('thresholds').addEventListener('submit', async event => {
    event.preventDefault();
    const yellowBelow = Number($('yellow').value), redBelow = Number($('red').value);
    if (!$('yellow').value || !$('red').value || !Number.isFinite(yellowBelow) || !Number.isFinite(redBelow) ||
      redBelow < 0 || yellowBelow > 100 || redBelow >= yellowBelow) {
      error('淡红色阈值须小于淡黄色阈值，范围为 0～100。');return;
    }
    await update({yellowBelow, redBelow});
  });
  document.getElementById('nav-quota').addEventListener('click', () => void sync());
  setInterval(() => {if (!document.getElementById('quota-view').hidden) void sync();}, 5000);
  void sync();
}
