import { updateSidebarStatus } from './sidebar-view.mjs';
const $ = id => document.getElementById(id);
const time = value => value === null ? '尚未成功检查' : new Date(value).toLocaleString('zh-CN', {month:'numeric',day:'numeric',hour:'2-digit',minute:'2-digit'});
const node = (tag, text, className) => {const el = document.createElement(tag);el.textContent = text;if (className) el.className = className;return el;};

export function createMessageSubscriptionsView() {
  const view = $('subscriptions-view');if (!view) return;
  const recommendations = [...view.querySelectorAll('[data-recommended-username]')];
  const reasonInputs = [...view.querySelectorAll('[data-recommendation-reason]')];
  // 理由输入框不随快照重建；草稿独立保留，避免后台状态更新覆盖正在输入的内容。
  const reasonDrafts = new Set();
  const tabs = [...$('subscriptions-tabs').querySelectorAll('[role="tab"]')];
  // Tab 仅切换页面分区，共用订阅快照与筛选状态，不重复发起采集。
  function selectTab(tab, focus = false) {
    for (const item of tabs) {
      const selected = item === tab;
      item.setAttribute('aria-selected',String(selected));item.tabIndex = selected ? 0 : -1;
      $(item.getAttribute('aria-controls')).hidden = !selected;
    }
    if (tab.id !== 'subscriptions-tab-feed') expandedTranslations.clear();
    lastContent = '';render();
    if (focus) tab.focus();
  }
  for (const tab of tabs) {
    tab.addEventListener('click',()=>selectTab(tab));
    tab.addEventListener('keydown',event=>{
      const index = tabs.indexOf(tab);
      const next = {ArrowRight:(index+1)%tabs.length,ArrowLeft:(index+tabs.length-1)%tabs.length,Home:0,End:tabs.length-1}[event.key];
      if (next === undefined) return;
      event.preventDefault();selectTab(tabs[next],true);
    });
  }
  const remarkDrafts = new Map();
  const translationRequests = new Set();
  const expandedTranslations = new Set();
  const expandedBodies = new Set();
  let data, filter = '', pending = false, loading = false, lastContent = '', revision = 0;
  function renderSummary(summary) {
    const count = summary?.unread || 0;
    $('subscriptions-badge').hidden = count === 0;
    $('subscriptions-badge').textContent = count > 99 ? '99+' : String(count);
    $('nav-subscriptions').setAttribute('aria-label', `消息订阅${count ? `，${count} 条未读` : ''}`);
    // 复用小屋的轻量状态广播；版本或检查状态变化时才取正文，避免定时传输整份缓存。
    if (summary && (!data || summary.revision !== data.revision || summary.busy !== data.busy)) void load();
  }
  function readingPosition() {
    if (view.hidden || $('subscriptions-panel-feed').hidden || !window.scrollY) return ()=>{};
    const x = window.scrollX, y = window.scrollY;
    const anchors = [...$('subscriptions-posts').children].map(card=>({key:card.dataset.postKey,rect:card.getBoundingClientRect()})).filter(item=>item.rect.bottom>0);
    // 保存当前可见消息的位置；删除它时优先锚定下一条，而不是跳回列表起点。
    return ()=>{
      const cards = new Map([...$('subscriptions-posts').children].map(card=>[card.dataset.postKey,card]));
      const anchor = anchors.find(item=>cards.has(item.key));
      window.scrollTo(x,anchor ? window.scrollY + cards.get(anchor.key).getBoundingClientRect().top - anchor.rect.top : y);
    };
  }
  function error(message = '') {const restore = readingPosition();$('subscriptions-error').textContent = message;$('subscriptions-error').hidden = !message;$('subscriptions-add-error').textContent = message;$('subscriptions-add-error').hidden = !message;restore();}
  function feedback(message) {const restore = readingPosition();$('subscriptions-feedback').textContent = message;$('subscriptions-feedback').hidden = !message;restore();}
  const button = (text, action, className = 'outline') => {
    const el = node('button', text, className);el.type = 'button';el.addEventListener('click', action);return el;
  };
  function copyMenu(element, value) {
    element.addEventListener('contextmenu',async event=>{
      event.preventDefault();event.stopPropagation();
      // 复制独立于修改操作，不重建列表，避免右键打断展开状态和当前阅读位置。
      try {
        const result = await window.whale.subscriptions('copy-menu',value);
        if (result.error) throw Error(result.error);
      } catch (err) {error(err.message || '无法打开复制菜单，请重试。');}
    });
  }
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
    // 翻译和阅读状态独立：点击即记为已读，翻译失败也不回滚阅读记录。
    const key = `${post.username}/${post.id}`;
    // 收起仅改变当前页面的展开状态，不删除已保存译文；再次展开直接读取缓存。
    if (post.translation) {
      if (expandedTranslations.has(key)) expandedTranslations.delete(key);else expandedTranslations.add(key);
      lastContent = '';render();
    } else {expandedTranslations.add(key);void translate(post);}
    if (post.unread) void call('mark-read',{username:post.username,id:post.id});
  }
  function select(username) {filter = username;lastContent = '';render();}
  function render() {
    updateSidebarStatus('subscriptions',data);
    const restore = readingPosition();
    for (const id of ['subscriptions-add','subscriptions-open-add','subscriptions-refresh','subscriptions-read-all']) $(id).disabled = pending || Boolean(data?.storeError);
    // 清理可中止正在进行的自动采集；手动操作仍串行，避免响应乱序覆盖页面。
    $('subscriptions-clear').disabled = pending || Boolean(data?.storeError) || !data?.posts.length;
    // 推荐与管理列表共用关注状态；已有账号恢复关注，不重复添加。
    for (const recommended of recommendations) {
      const account = data?.accounts.find(a => a.username === recommended.dataset.recommendedUsername);
      const followed = Boolean(account?.enabled);
      recommended.textContent = followed ? '已关注' : '关注';
      recommended.setAttribute('aria-pressed',String(followed));
      recommended.setAttribute('aria-label',`${followed ? '取消关注' : '关注'} @${recommended.dataset.recommendedUsername}`);
      recommended.title = followed ? '点击取消关注' : '点击关注';
      recommended.disabled = pending || !data || Boolean(data.storeError) || (!account && data.accounts.length >= data.accountLimit);
    }
    for (const input of reasonInputs) {
      if (!reasonDrafts.has(input.dataset.recommendationReason)) input.value = data?.recommendationReasons?.[input.dataset.recommendationReason] ?? '';
      input.disabled = pending || !data || Boolean(data.storeError);
    }
    for (const id of ['subscriptions-close-add','subscriptions-cancel-add','subscriptions-input','subscriptions-remark']) $(id).disabled = pending;
    if (!data) return;
    $('subscriptions-refresh').disabled ||= data.busy || !data.accounts.some(a => a.enabled);
    $('subscriptions-refresh').textContent = data.busy ? '正在检查…' : '立即检查';
    $('subscriptions-read-all').disabled ||= !data.unread;
    $('subscriptions-add').disabled ||= data.accounts.length >= data.accountLimit;
    $('subscriptions-open-add').disabled = $('subscriptions-add').disabled;
    $('subscriptions-status').textContent = `${data.accounts.length} 个订阅 · ${data.posts.length} 条缓存 · ${data.unread} 条未读`;
    renderSummary(data);
    if (data.storeError) error(data.storeError);
    if (filter && !data.accounts.some(a => a.username === filter)) filter = '';
    const cachedKeys = new Set(data.posts.map(post => `${post.username}/${post.id}`));
    for (const set of [expandedTranslations,expandedBodies]) for (const key of set) if (!cachedKeys.has(key)) set.delete(key);
    // 定时只读快照不重建未变化的列表，避免打断键盘焦点和正在阅读的位置。
    const query = $('subscriptions-search').value.normalize('NFKC').trim().toLocaleLowerCase();
    // 头像随账号资料传输一次，各条消息复用，避免大量动态在 IPC 中重复传输图片。
    const avatars = new Map(data.accounts.map(a=>[a.username,a.avatar]));
    const names = new Map(data.accounts.map(a=>[a.username,a.displayName || data.posts.find(p=>p.username===a.username && p.displayName)?.displayName || `@${a.username}`]));
    const matches = new Set(data.accounts.filter(a=>[names.get(a.username),`@${a.username}`].some(text=>text.normalize('NFKC').toLocaleLowerCase().includes(query))).map(a=>a.username));
    const content = JSON.stringify([data.accounts,data.posts,filter,query,$('subscriptions-unread').checked,pending]);
    if (content === lastContent) return;lastContent = content;
    $('subscriptions-all').setAttribute('aria-pressed',String(!filter));
    $('subscriptions-accounts').replaceChildren();
    $('subscriptions-managed-accounts').replaceChildren();
    $('subscriptions-manage-empty').hidden = data.accounts.length > 0;
    $('subscriptions-table').hidden = data.accounts.length === 0;
    for (const username of remarkDrafts.keys()) if (!data.accounts.some(a=>a.username===username)) remarkDrafts.delete(username);
    for (const account of data.accounts) {
      const choose = button('',()=>select(account.username),'outline subscriptions-account');
      choose.hidden = !matches.has(account.username);choose.title = `@${account.username}`;
      choose.dataset.username = account.username;choose.setAttribute('aria-pressed',String(filter === account.username));
      choose.append(node('span',names.get(account.username)));
      if (account.unread) choose.append(node('small',`${account.unread} 未读`));
      $('subscriptions-accounts').append(choose);
      const managed = node('tr','','subscriptions-managed-account');managed.dataset.username = account.username;
      const name = node('th',names.get(account.username));name.scope = 'row';
      const handle = node('td',`@${account.username}`);
      const remarkCell = node('td','');const remarkForm = node('form','','subscriptions-remark-form');
      const remark = document.createElement('input');remark.type = 'text';remark.maxLength = 200;
      remark.value = remarkDrafts.get(account.username) ?? account.remark ?? '';remark.placeholder = '输入备注，回车保存';remark.title = '按回车保存备注';
      remark.setAttribute('aria-label',`@${account.username} 自定义备注`);
      remark.disabled = pending || Boolean(data.storeError);
      remark.addEventListener('input',()=>remarkDrafts.set(account.username,remark.value));
      // 中文输入法确认候选词时，不触发备注提交。
      remark.addEventListener('keydown',event=>{if (event.key === 'Enter' && event.isComposing) event.preventDefault();});
      remarkForm.addEventListener('submit',async event=>{
        event.preventDefault();
        if (pending || remark.disabled || remark.value === (account.remark || '')) return;
        if (await call('set-remark',{username:account.username,remark:remark.value},'备注已保存。')) {
          remarkDrafts.delete(account.username);lastContent = '';render();
        }
      });
      remarkForm.append(remark);remarkCell.append(remarkForm);
      const tools = node('td','','subscriptions-account-tools');
      const toggle = button(account.enabled ? '取消关注' : '关注',()=>call('set-enabled',{username:account.username,enabled:!account.enabled}));
      toggle.setAttribute('aria-label',`${account.enabled ? '取消关注' : '关注'} @${account.username}`);
      toggle.disabled = pending || Boolean(data.storeError);tools.append(toggle);
      managed.append(name,handle,remarkCell,tools);$('subscriptions-managed-accounts').append(managed);
    }
    $('subscriptions-feed-title').textContent = filter ? names.get(filter) : query ? '筛选结果' : '全部动态';
    $('subscriptions-feed-title').title = filter ? `@${filter}` : '';
    const accounts = data.accounts.filter(a => matches.has(a.username) && (!filter || a.username === filter));
    $('subscriptions-account-status').replaceChildren();
    for (const account of accounts) {
      const status = node('div',`${names.get(account.username)} · ${account.enabled ? '每小时检查' : '已暂停'} · ${time(account.checkedAt)}${account.error ? ` · ${account.error}` : ''}`);
      status.title = `@${account.username}`;
      if (account.error) status.append(' ',button('打开主页',()=>call('open-profile',account.username),'text-button'));
      $('subscriptions-account-status').append(status);
    }
    const posts = data.posts.filter(p => matches.has(p.username) && (!filter || p.username === filter) && (!$('subscriptions-unread').checked || p.unread));
    const fragment = document.createDocumentFragment();
    for (const post of posts) {
      const card = node('article','','ui-card subscriptions-post');card.dataset.postId = post.id;
      const key = `${post.username}/${post.id}`, value = {username:post.username,id:post.id};card.dataset.postKey = key;
      const expanded = Boolean(post.translation) && expandedTranslations.has(key);
      const header = node('div','','subscriptions-post-header');
      // 标题统一打开原文，已读和未读都可操作；沿用主进程打开后标为已读的流程。
      const heading = button('',()=>call('open-post',value),'subscriptions-post-heading');
      heading.disabled = pending;heading.setAttribute('aria-label',`查看原文：@${post.username} ${time(post.publishedAt)}`);heading.title = `查看原文 · @${post.username}`;
      const author = node('strong',names.get(post.username) || post.displayName || `@${post.username}`);author.title = `@${post.username}`;
      // 首字占位始终保留在图片下方；图片缺失或加载失败时直接回退，不改变标题尺寸。
      const avatar = node('span',Array.from(author.textContent.replace(/^@/,''))[0] || '?','subscriptions-avatar');
      avatar.setAttribute('aria-hidden','true');
      if (avatars.get(post.username)) {
        const image = document.createElement('img');image.alt = '';image.src = avatars.get(post.username);
        image.addEventListener('error',()=>image.remove(),{once:true});avatar.append(image);
      }
      heading.append(avatar,author,node('span',time(post.publishedAt)),node('span','↗'));
      if (post.unread) {
        const dot = node('span','','subscriptions-unread-dot');
        dot.setAttribute('role','img');dot.setAttribute('aria-label','未读');heading.prepend(dot);
      }
      const actions = node('div','','subscriptions-post-actions');
      const translating = post.translating || translationRequests.has(key);
      const translateButton = button(translating ? '翻译中…' : expanded ? '取消翻译' : '中文翻译',()=>toggleTranslation(post));
      translateButton.disabled = pending || translating || (!post.translation && Boolean(data.storeError));
      translateButton.setAttribute('aria-expanded',String(expanded));
      if (post.translation) translateButton.setAttribute('aria-controls',`subscription-translation-${post.username}-${post.id}`);
      const deleteButton = button('',()=>call('delete-post',value,'消息及译文已从本地缓存删除。'),'ui-icon-button subscriptions-delete');
      deleteButton.setAttribute('aria-label','删除消息');deleteButton.title = '删除消息';deleteButton.disabled = pending || Boolean(data.storeError);
      // 复用配置页的垃圾桶图标与公共图标按钮样式，远程正文仍只通过 textContent 展示。
      const icon = document.createElementNS('http://www.w3.org/2000/svg','svg');
      icon.setAttribute('viewBox','0 0 20 20');icon.setAttribute('width','20');icon.setAttribute('height','20');
      icon.setAttribute('fill','none');icon.setAttribute('stroke','currentColor');icon.setAttribute('stroke-width','1.5');icon.setAttribute('aria-hidden','true');
      const path = document.createElementNS('http://www.w3.org/2000/svg','path');
      path.setAttribute('d','M3 5h14M8 5V3h4v2M5 5l1 12h8l1-12M8 8v6m4-6v6');path.setAttribute('stroke-linecap','round');path.setAttribute('stroke-linejoin','round');
      icon.append(path);deleteButton.append(icon);actions.append(translateButton,deleteButton);header.append(heading,actions);
      // 动态正文始终通过 textContent 写入，不插入远程 HTML、图片或可执行链接。
      const body = node('p',post.text,'subscriptions-post-body');
      copyMenu(body,value);
      const bodyExpanded = expandedBodies.has(key);body.classList.toggle('is-collapsed',!bodyExpanded);
      body.id = `subscription-body-${post.username}-${post.id}`;
      // 仅正文触发阅读：超出两行时展开，短文不改变排版；标题和翻译沿用各自操作。
      body.setAttribute('role','button');body.tabIndex = 0;body.setAttribute('aria-disabled',String(pending || Boolean(data.storeError)));
      const readBody = ()=>{
        if (pending || data.storeError) return;
        // 选中文本用于复制时不触发展开或已读。
        if (window.getSelection()?.type === 'Range') return;
        if (body.classList.contains('is-collapsed') && body.scrollHeight > body.clientHeight + 1) {
          expandedBodies.add(key);lastContent = '';render();
        }
        if (post.unread) void call('mark-read',value);
      };
      body.addEventListener('click',readBody);
      body.addEventListener('keydown',event=>{
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();readBody();
      });
      card.append(header,body);
      if (post.truncated) card.append(node('p','内容已截取，完整内容请查看原文。','subscriptions-truncated'));
      if (post.translation) {
        // 已缓存的译文仍由本次页面的展开状态控制；只显示正文，不再添加“中文译文”标题。
        const translated = node('div','','subscriptions-translation');translated.lang = 'zh-CN';
        translated.id = `subscription-translation-${post.username}-${post.id}`;translated.hidden = !expanded;
        copyMenu(translated,{...value,translation:true});
        translated.append(node('p',post.translation.text));card.append(translated);
      }
      if (post.translationError) card.append(node('p',post.translationError,'ui-alert'));
      fragment.append(card);
    }
    // 在离屏片段中构建完成后一次替换，避免清空列表触发页面高度塌缩。
    $('subscriptions-posts').replaceChildren(fragment);
    for (const body of $('subscriptions-posts').querySelectorAll('.subscriptions-post-body')) updateBodyState(body);
    $('subscriptions-empty').hidden = posts.length > 0;
    $('subscriptions-empty').textContent = !data.accounts.length ? '还没有订阅，添加一个 X 账号开始阅读。' : query ? '没有匹配的动态，请调整昵称或账号筛选。' : $('subscriptions-unread').checked ? '暂时没有未读动态。' : data.busy ? '正在读取公开动态，首次检查最多需要半分钟…' : '暂无缓存。可点击“立即检查”；新获取的动态默认未读。';
    restore();
  }
  async function load() {
    if (view.hidden || loading || pending) return;loading = true;const requestedAt = revision;
    try {const result = await window.whale.subscriptions('snapshot');if (requestedAt !== revision) return;if (result.error) throw Error(result.error);data = result.value;render();}
    catch (err) {error(err.message || '无法读取订阅。');}finally {loading = false;}
  }
  function updateBodyState(body) {
    const expanded = !body.classList.contains('is-collapsed');
    if (expanded || body.scrollHeight > body.clientHeight + 1) body.setAttribute('aria-expanded',String(expanded));
    else body.removeAttribute('aria-expanded');
    body.title = expanded ? '点击设为已读' : body.hasAttribute('aria-expanded') ? '点击展开并设为已读' : '点击设为已读';
  }
  // 阅读区变宽或变窄后重新判断是否超过两行，不额外显示展开按钮。
  new ResizeObserver(()=>{
    for (const body of view.querySelectorAll('.subscriptions-post-body')) updateBodyState(body);
  }).observe(view.querySelector('.subscriptions-feed'));
  const addDialog = $('subscriptions-add-dialog');
  $('subscriptions-open-add').addEventListener('click',()=>{error();addDialog.showModal();$('subscriptions-input').focus();});
  for (const id of ['subscriptions-close-add','subscriptions-cancel-add']) $(id).addEventListener('click',()=>{if (!pending) addDialog.close();});
  addDialog.addEventListener('cancel',event=>{if (pending) event.preventDefault();});
  $('subscriptions-form').addEventListener('submit',async event=>{
    event.preventDefault();const input = $('subscriptions-input');
    if (await call('add',{username:input.value,remark:$('subscriptions-remark').value},'已添加订阅，新获取的动态将标为未读。')) {
      input.value = '';$('subscriptions-remark').value = '';addDialog.close();
    }
  });
  $('subscriptions-all').addEventListener('click',()=>select(''));
  for (const input of reasonInputs) {
    const username = input.dataset.recommendationReason;
    input.addEventListener('input',()=>reasonDrafts.add(username));
    // 回车保存，输入法确认候选词时不提交；失败保留草稿供用户重试。
    input.addEventListener('keydown',event=>{if (event.key === 'Enter' && event.isComposing) event.preventDefault();});
    input.form.addEventListener('submit',async event=>{
      event.preventDefault();
      if (pending || input.disabled || input.value === (data?.recommendationReasons?.[username] ?? '')) return;
      if (await call('set-recommendation-reason',{username,reason:input.value},'推荐理由已保存。')) {
        reasonDrafts.delete(username);render();
      }
    });
  }
  for (const recommended of recommendations) recommended.addEventListener('click',()=>{
    const username = recommended.dataset.recommendedUsername;
    const account = data?.accounts.find(a=>a.username===username);
    if (account) void call('set-enabled',{username,enabled:!account.enabled});
    else void call('add',username,'已添加订阅，新获取的动态将标为未读。');
  });
  // 输入搜索时回到全部账号，避免之前选中的账号挡住其他昵称的匹配结果。
  $('subscriptions-search').addEventListener('input',()=>{filter = '';lastContent = '';render();});
  $('subscriptions-unread').addEventListener('change',render);
  $('subscriptions-refresh').addEventListener('click',()=>call('refresh'));
  $('subscriptions-read-all').addEventListener('click',()=>call('mark-read',null,'已全部标为已读。'));
  $('subscriptions-clear').addEventListener('click',()=>call('clear-cache',undefined,'缓存已清除，订阅、已读状态和去重进度已保留。'));
  // 只缓存译文，不记住展开状态；再次进入或重启后均需主动点击才显示。
  // 离开时也清空，防止尚未完成的翻译在返回页面后自动展开。
  new MutationObserver(()=>{
    expandedTranslations.clear();expandedBodies.clear();lastContent = '';
    if (view.hidden && addDialog.open) addDialog.close();
    if (!view.hidden) {selectTab(tabs[0]);render();void load();}
  }).observe(view,{attributes:true,attributeFilter:['hidden']});
  void load();return {renderSummary};
}
