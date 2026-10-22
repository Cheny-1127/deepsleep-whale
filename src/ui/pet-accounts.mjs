async function render() {
  try {
    const data = await window.accounts.snapshot();
    document.getElementById('error').hidden = true;
    document.getElementById('accounts').replaceChildren(...data.accounts.map(account => {
      const button = document.createElement('button');
      button.type = 'button';button.setAttribute('role', 'radio');button.setAttribute('aria-checked', String(account.id === data.accountId));
      const check = document.createElement('span');check.className = 'account-check';check.textContent = account.id === data.accountId ? '✓' : '';check.setAttribute('aria-hidden', 'true');
      const info = document.createElement('span');info.className = 'account-info';
      const name = document.createElement('span');name.className = 'account-name';name.textContent = account.name || `账号 #${account.id}`;name.title = name.textContent;
      const detail = document.createElement('span');detail.className = 'account-detail';
      detail.textContent = `${typeof account.remaining === 'number' ? `7d 剩余 ${Math.round(account.remaining)}%` : '暂无 7d 额度'}${account.paused ? ' · 已暂停刷新' : ''}`;
      info.append(name, detail);button.append(check, info);
      button.addEventListener('click', () => window.accounts.select(account.id));
      return button;
    }));
    const selected = document.querySelector('[aria-checked="true"]') || document.querySelector('#accounts button');
    selected?.focus();
  } catch {
    document.getElementById('error').textContent = '账号列表暂时无法读取，请关闭后重试。';
    document.getElementById('error').hidden = false;
  }
}
document.getElementById('close').addEventListener('click', () => window.accounts.close());
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') window.accounts.close();
  if (!['ArrowDown', 'ArrowUp'].includes(event.key)) return;
  const buttons = [...document.querySelectorAll('#accounts button')], index = buttons.indexOf(document.activeElement);
  if (index < 0) return;
  event.preventDefault();
  buttons[(index + (event.key === 'ArrowDown' ? 1 : buttons.length - 1)) % buttons.length].focus();
});
window.accounts.onOpen(() => void render());
