// 只展示主进程给出的今日前五；邮箱和费用按纯文本写入，5 秒轮询不直接请求接口。
let key = '', groupsKey = '', polling = false, updating = false, checkedAt = null, latest = null, busy = false, openHeight = 0, generation = 0, reopen = false;
const refreshTime = at => at == null ? '尚无成功记录' : new Date(at).toLocaleTimeString('zh-CN', {timeZone:'Asia/Shanghai', hour12:false});
const refresh = document.getElementById('refresh');
const group = document.getElementById('group');
const picker = document.getElementById('group-picker');
const groupButton = document.getElementById('group-button');
const optionsBox = document.getElementById('group-options');
const source = document.getElementById('source');
function resize() {
  const card = document.querySelector('.ranking-card').getBoundingClientRect();
  if (picker.open) openHeight = Math.max(openHeight, picker.querySelector('.quota-group-menu').getBoundingClientRect().bottom);
  else openHeight = 0;
  const bottom = Math.max(card.bottom, openHeight);
  window.ranking.resize(Math.min(400, Math.ceil(bottom) + 6));
}
function renderGroups() {
  if (!latest) return;
  const choices = [{id:null, name:'全部分组'}, ...latest.groups];
  if (!choices.some(item => item.id === latest.groupId)) choices.push({id:latest.groupId, name:latest.groupName});
  const nextKey = JSON.stringify([choices, latest.groupId]);
  if (groupsKey !== nextKey) {
    groupsKey = nextKey;
    optionsBox.replaceChildren(...choices.map(item => {
      const option = document.createElement('button'), name = document.createElement('span'), check = document.createElement('span');
      option.type = 'button';option.setAttribute('role', 'option');option.setAttribute('aria-selected', String(item.id === latest.groupId));
      name.textContent = item.name;
      check.className = 'quota-group-check';check.textContent = '✓';check.setAttribute('aria-hidden', 'true');
      option.append(name, check);
      option.addEventListener('click', () => {
        picker.open = false;groupButton.focus();
        if (item.id !== latest.groupId) void render('select', item.id);
      });
      return option;
    }));
  }
  for (const option of optionsBox.querySelectorAll('button')) option.disabled = updating || busy;
}
function setWorking() {
  const working = updating || busy;
  refresh.disabled = working;
  groupButton.setAttribute('aria-disabled', String(working));
  renderGroups();
}
async function render(action = 'snapshot', groupId) {
  if (polling || document.hidden) return;
  polling = true;const stamp = generation;
  updating = action !== 'snapshot';
  setWorking();
  refresh.setAttribute('aria-busy', String(action === 'refresh'));
  try {
    const data = action === 'select' ? await window.ranking.selectGroup(groupId) : await window.ranking[action]();
    // 共用弹窗切换账号后，旧请求即使迟到也不能覆盖新账号的来源和榜单。
    if(stamp !== generation)return;
    latest = data;
    source.textContent = `${data.source.configName} · ${data.source.accountName}`;
    source.title = source.textContent;
    checkedAt = data.checkedAt;
    busy = data.busy === true;
    group.textContent = data.groupId === null ? '全部分组' : data.groupName;
    group.title = data.groupName;
    const status = document.getElementById('status');
    status.className = data.error ? 'failed' : '';
    status.textContent = data.error ? `同步失败，刷新时间：${refreshTime(checkedAt)}` : checkedAt == null ? '' : `刷新时间：${refreshTime(checkedAt)}`;
    document.getElementById('empty').hidden = Boolean(data.users.length);
    document.getElementById('empty').textContent = data.busy ? '正在读取今日排行…' : data.error ? '暂时无法取得今日排行' : '该分组今日暂无用量';
    const nextKey = JSON.stringify(data.users);
    if (key !== nextKey) {
      key = nextKey;
      document.getElementById('users').replaceChildren(...data.users.map((user, index) => {
        const row = document.createElement('li'), rank = document.createElement('span'), name = document.createElement('span'), cost = document.createElement('span');
        rank.className = 'rank';rank.textContent = index + 1;
        name.className = 'name';name.textContent = user.email || `用户 #${user.user_id}`;name.title = name.textContent;
        cost.className = 'cost';cost.textContent = user.actual_cost == null ? '—' : `$${user.actual_cost.toFixed(2)}`;
        if (user.actual_cost != null) cost.title = `$${user.actual_cost.toFixed(4)}`;
        row.append(rank, name, cost);return row;
      }));
    }
  } catch {
    busy = false;
    document.getElementById('status').textContent = `同步失败，刷新时间：${refreshTime(checkedAt)}`;
    document.getElementById('status').className = 'failed';
  } finally {polling = false;updating = false;setWorking();refresh.setAttribute('aria-busy', 'false');resize();if(reopen){reopen=false;void render();}}
}
refresh.addEventListener('click', () => void render('refresh'));
groupButton.addEventListener('click', event => {if (polling || busy || !latest) event.preventDefault();});
picker.addEventListener('toggle', () => {
  if (picker.open) {renderGroups();optionsBox.querySelector('[aria-selected="true"]')?.focus();}
  resize();
});
picker.addEventListener('keydown', event => {
  if (polling || busy || !latest || !['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
  event.preventDefault();
  if (!picker.open) {picker.open = true;return;}
  const options = [...optionsBox.querySelectorAll('button:not(:disabled)')], index = options.indexOf(document.activeElement);
  const next = event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 :
    index < 0 ? (event.key === 'ArrowUp' ? options.length - 1 : 0) : (index + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length;
  options[next]?.focus();
});
document.addEventListener('pointerdown', event => {if (picker.open && !picker.contains(event.target)) picker.open = false;});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (picker.open) {picker.open = false;groupButton.focus();}
  else window.ranking.close();
});
document.addEventListener('visibilitychange', () => {if (document.hidden) picker.open = false;});
document.addEventListener('visibilitychange', () => void render());
setInterval(() => void render(), 5000);
void render();

window.ranking.onOpen(() => {
  // 每次打开先清除旧来源；正在读取时只安排一次补读，避免沿用上一个账号的标识。
  generation++;source.textContent = '正在读取…';source.title = '';picker.open = false;
  if(polling)reopen=true;else void render();
});
