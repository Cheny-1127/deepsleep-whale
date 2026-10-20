// 只展示主进程给出的今日前五；邮箱和费用按纯文本写入，5 秒轮询不直接请求接口。
let key = '', polling = false;
const refresh = document.getElementById('refresh');
async function render(action = 'snapshot') {
  if (polling || document.hidden) return;
  polling = true;
  let busy = false;
  refresh.disabled = true;
  refresh.setAttribute('aria-busy', String(action === 'refresh'));
  try {
    const data = await window.ranking[action]();
    busy = data.busy === true;
    document.getElementById('group').textContent = data.groupName;
    document.getElementById('group').title = data.groupName;
    const status = document.getElementById('status');
    status.className = data.error ? 'failed' : '';
    status.textContent = data.error ? '同步失败，保留上次数据' : data.checkedAt == null ? '' : `更新于 ${new Date(data.checkedAt).toLocaleTimeString('zh-CN')}`;
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
    window.ranking.resize(Math.ceil(document.querySelector('.ranking-card').getBoundingClientRect().height) + 12);
  } catch {
    document.getElementById('status').textContent = '暂时无法读取排行';
    document.getElementById('status').className = 'failed';
  } finally {polling = false;refresh.disabled = busy;refresh.setAttribute('aria-busy', 'false');}
}
refresh.addEventListener('click', () => void render('refresh'));
document.addEventListener('keydown', event => {if (event.key === 'Escape') window.ranking.close();});
document.addEventListener('visibilitychange', () => void render());
setInterval(() => void render(), 5000);
void render();
