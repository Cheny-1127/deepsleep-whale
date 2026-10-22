const $ = id => document.getElementById(id);
const time = value => value === null ? '尚未成功检查' : new Date(value).toLocaleString('zh-CN', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
const node = (tag, text, className) => {const el = document.createElement(tag);el.textContent = text;if (className) el.className = className;return el;};

export function createMessageSubscriptionsView() {
  const view = $('subscriptions-view');if (!view) return;
  const recommendations = [...view.querySelectorAll('[data-recommended-username]')];
  const translationRequests = new Set();
  const expandedTranslations = new Set();
  let data, filter = '', pending = false, loading = false, lastContent = '', revision = 0;
  function renderSummary(summary) {
    const count = summary?.unread || 0;
    $('subscriptions-badge').hidden = count === 0;
    $('subscriptions-badge').textContent = count > 99 ? '99+' : String(count);
    $('nav-subscriptions').setAttribute('aria-label', `消息订阅${count ? `，${count} 条未读` : ''}`);
    // 复用小屋的轻量状态广播；版本或检查状态变化时才取正文，避免定时传输整份缓存。
    if (summary && (!data || summary.revision !== data.revision || summary.busy !== data.busy)) void load();
  }
  function error(message = '') {$('subscriptions-error').textContent = message;$('subscriptions-error').hidden = !message;}
  function feedback(message) {$('subscriptions-feedback').textContent = message;$('subscriptions-feedback').hidden = !message;}
  const button = (text, action, className = 'outline') => {
    const el = node('button', text, className);el.type = 'button';el.addEventListener('click', action);return el;
  };
  async function call(name, value, message) {
    if (pending) return false;
    pending = true;revision++;render();error();feedback('');
    try {
      const result = await window.whale.subscriptions(name, value);
      if (result.error) throw Error(result.error);
      data = result.value;if (message) feedback(message);return true;
    } catch (err) {error(err.message || '订阅操作失败，请重试。');return false;}
    finally {pending = false;revision++;lastContent = '';render();}
  }
  async function translate(post) {
    const key = `${post.username}/${post.id}`;
    if (pending || post.translating || translationRequests.has(key)) return;
    translationRequests.add(key);revision++;lastContent = '';render();
    try {
      const result = await window.whale.subscriptions('translate',{username:post.username,id:post.id});
      if (result.error) throw Error(result.error);
      // 翻译期间允许清缓存、刷新和标记已读；不能用较早的 IPC 返回快照覆盖这些操作。
    } catch (err) {error(err.message || '翻译失败，请重试。');}
    finally {translationRequests.delete(key);revision++;lastContent = '';render();void load();}
  }
  function toggleTranslation(post) {
    const key = `${post.username}/${post.id}`;
    // 收起仅改变当前页面的展开状态，不删除已保存译文；再次展开直接读取缓存。
    if (post.translation) {
      if (expandedTranslations.has(key)) expandedTranslations.delete(key);else expandedTranslations.add(key);
      lastContent = '';render();return;
    }
    expandedTranslations.add(key);void translate(post);
  }
  function select(username) {filter = username;lastContent = '';render();}
  function render() {
    for (const id of ['subscriptions-add','subscriptions-refresh','subscriptions-read-all']) $(id).disabled = pending || Boolean(data?.storeError);
    // 清理可中止正在进行的自动采集；手动操作仍串行，避免响应乱序覆盖页面。
    $('subscriptions-clear').disabled = pending || Boolean(data?.storeError) || !data?.posts.length;
    // 推荐仅提供添加入口；订阅结果沿用主进程快照，失败不会误显示为已订阅。
    for (const recommended of recommendations) {
      const subscribed = data?.accounts.some(a => a.username === recommended.dataset.recommendedUsername);
      recommended.textContent = subscribed ? '已订阅' : '添加订阅';
      recommended.disabled = pending || !data || Boolean(data.storeError) || subscribed || data.accounts.length >= data.accountLimit;
    }
    if (!data) return;
    $('subscriptions-refresh').disabled ||= data.busy || !data.accounts.some(a => a.enabled);
    $('subscriptions-refresh').textContent = data.busy ? '正在检查…' : '立即检查';
    $('subscriptions-read-all').disabled ||= !data.unread;
    $('subscriptions-add').disabled ||= data.accounts.length >= data.accountLimit;
    $('subscriptions-status').textContent = `${data.accounts.length} 个订阅 · ${data.posts.length} 条缓存 · ${data.unread} 条未读`;
    renderSummary(data);
    if (data.storeError) error(data.storeError);
    if (filter && !data.accounts.some(a => a.username === filter)) filter = '';
    const cachedKeys = new Set(data.posts.map(post => `${post.username}/${post.id}`));
    for (const key of expandedTranslations) if (!cachedKeys.has(key)) expandedTranslations.delete(key);
    // 定时只读快照不重建未变化的列表，避免打断键盘焦点和正在阅读的位置。
    const content = JSON.stringify([data.accounts,data.posts,filter,$('subscriptions-unread').checked,pending]);
    if (content === lastContent) return;lastContent = content;
    $('subscriptions-all').setAttribute('aria-pressed',String(!filter));
    $('subscriptions-accounts').replaceChildren();
    for (const account of data.accounts) {
      const row = node('div','','subscriptions-account');row.dataset.username = account.username;
      const choose = button(`@${account.username}`,()=>select(account.username),'ui-menu-item');choose.setAttribute('aria-pressed',String(filter === account.username));
      const meta = node('small',`${account.unread} 未读 · ${account.count} 缓存${account.error ? ' · 检查失败' : ''}`);
      const tools = node('div','','subscriptions-account-tools');
      const toggle = button(account.enabled ? '暂停' : '启用',()=>call('set-enabled',{username:account.username,enabled:!account.enabled}));
      toggle.setAttribute('aria-label',`${account.enabled ? '暂停' : '启用'} @${account.username}`);
      const remove = button('删除',()=>call('remove',account.username,'已删除订阅和该账号的缓存。'));
      remove.setAttribute('aria-label',`删除 @${account.username}`);
      for (const el of [toggle,remove]) {el.disabled = pending || Boolean(data.storeError);el.className = 'text-button';}
      tools.append(toggle,remove);row.append(choose,meta,tools);$('subscriptions-accounts').append(row);
    }
    $('subscriptions-feed-title').textContent = filter ? `@${filter}` : '全部动态';
    const accounts = data.accounts.filter(a => !filter || a.username === filter);
    $('subscriptions-account-status').replaceChildren();
    for (const account of accounts) {
      const status = node('div',`@${account.username} · ${account.enabled ? '每小时检查' : '已暂停'} · ${time(account.checkedAt)}${account.error ? ` · ${account.error}` : ''}`);
      if (account.error) status.append(' ',button('打开主页',()=>call('open-profile',account.username),'text-button'));
      $('subscriptions-account-status').append(status);
    }
    const posts = data.posts.filter(p => (!filter || p.username === filter) && (!$('subscriptions-unread').checked || p.unread));
    $('subscriptions-posts').replaceChildren();
    for (const post of posts) {
      const card = node('article','','ui-card subscriptions-post');card.dataset.postId = post.id;
      const key = `${post.username}/${post.id}`, value = {username:post.username,id:post.id};
      const expanded = Boolean(post.translation) && expandedTranslations.has(key);
      const header = node('div','','subscriptions-post-header');
      const heading = node('div','','subscriptions-post-heading');heading.append(node('strong',`@${post.username}`),node('span',time(post.publishedAt)));
      if (post.unread) {
        const dot = node('span','','subscriptions-unread-dot');
        dot.setAttribute('role','img');dot.setAttribute('aria-label','未读');heading.prepend(dot);
      }
      const actions = node('div','','subscriptions-post-actions');
      const originalButton = button('查看原文 ↗',()=>call('open-post',value));originalButton.disabled = pending;
      const translating = post.translating || translationRequests.has(key);
      const translateButton = button(translating ? '翻译中…' : expanded ? '取消翻译' : '中文翻译',()=>toggleTranslation(post));
      translateButton.disabled = pending || translating || (!post.translation && Boolean(data.storeError));
      translateButton.setAttribute('aria-expanded',String(expanded));
      if (post.translation) translateButton.setAttribute('aria-controls',`subscription-translation-${post.username}-${post.id}`);
      actions.append(originalButton,translateButton);header.append(heading,actions);
      // 动态正文始终通过 textContent 写入，不插入远程 HTML、图片或可执行链接。
      card.append(header,node('p',post.text));
      if (post.truncated) card.append(node('p','内容已截取，完整内容请查看原文。','subscriptions-truncated'));
      if (post.translation) {
        const translated = node('div','','subscriptions-translation');translated.lang = 'zh-CN';
        translated.id = `subscription-translation-${post.username}-${post.id}`;translated.hidden = !expanded;
        translated.append(node('strong','中文译文'),node('p',post.translation.text));card.append(translated);
      }
      if (post.translationError) card.append(node('p',post.translationError,'ui-alert'));
      if (post.unread) {
        const readActions = node('div','','subscriptions-post-read-actions');
        const readButton = button('标为已读',()=>call('mark-read',value));readButton.disabled = pending;
        readActions.append(readButton);card.append(readActions);
      }
      $('subscriptions-posts').append(card);
    }
    $('subscriptions-empty').hidden = posts.length > 0;
    $('subscriptions-empty').textContent = !data.accounts.length ? '还没有订阅，添加一个 X 账号开始阅读。' : $('subscriptions-unread').checked ? '暂时没有未读动态。' : data.busy ? '正在读取公开动态，首次检查最多需要半分钟…' : '暂无缓存。可点击“立即检查”；新获取的动态默认未读。';
  }
  async function load() {
    if (view.hidden || loading || pending) return;loading = true;const requestedAt = revision;
    try {const result = await window.whale.subscriptions('snapshot');if (requestedAt !== revision) return;if (result.error) throw Error(result.error);data = result.value;render();}
    catch (err) {error(err.message || '无法读取订阅。');}finally {loading = false;}
  }
  $('subscriptions-form').addEventListener('submit',async event=>{
    event.preventDefault();const input = $('subscriptions-input');
    if (await call('add',input.value,'已添加订阅，新获取的动态将标为未读。')) input.value = '';
  });
  $('subscriptions-all').addEventListener('click',()=>select(''));
  for (const recommended of recommendations) recommended.addEventListener('click',()=>call('add',recommended.dataset.recommendedUsername,'已添加订阅，新获取的动态将标为未读。'));
  $('subscriptions-unread').addEventListener('change',render);
  $('subscriptions-refresh').addEventListener('click',()=>call('refresh'));
  $('subscriptions-read-all').addEventListener('click',()=>call('mark-read',null,'已全部标为已读。'));
  $('subscriptions-clear').addEventListener('click',()=>call('clear-cache',undefined,'缓存已清除，订阅、已读状态和去重进度已保留。'));
  // 只缓存译文，不记住展开状态；再次进入或重启后均需主动点击才显示。
  // 离开时也清空，防止尚未完成的翻译在返回页面后自动展开。
  new MutationObserver(()=>{
    expandedTranslations.clear();lastContent = '';
    if (!view.hidden) {render();void load();}
  }).observe(view,{attributes:true,attributeFilter:['hidden']});
  void load();return {renderSummary};
}
