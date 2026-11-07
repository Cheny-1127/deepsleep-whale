'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {createHash} = require('node:crypto');
const {DEFAULT_BASE_URL,readQuotaToken} = require('./quota-credentials.cjs');
const validID = id => Number.isSafeInteger(id) && id > 0;
const validGroup = id => id === null || validID(id);
const message = (text, definite = false) => Object.assign(Error(text),{safe:true,definite});

function createKeyGroups({token,tokenFile,dataDir,baseUrl = DEFAULT_BASE_URL,fetchImpl = fetch,searchUsers,onChanged = () => {},
  clock = {now:() => Date.now(),setTimeout,clearTimeout}} = {}) {
  const origin = String(baseUrl).replace(/\/+$/,'');
  const file = dataDir ? path.join(dataDir,'quota-key-groups.json') : null;
  const users = new Map(), contexts = new Map(), favorites = new Map(), favoriteChecks = new Map(), controllers = new Set(), writes = new Set(), uncertain = new Set(), notices = new Map();
  let user = null, expanded = true, cacheError = '', closed = false, preferenceSource = null;
  const credential = () => readQuotaToken({token,tokenFile});
  const source = value => createHash('sha256').update(JSON.stringify([origin,value])).digest('hex');
  const pair = (userId,keyId) => `${userId}:${keyId}`;
  const projectUser = item => {
    if (!validID(item?.id) || typeof item.email !== 'string') throw message('用户信息不完整，请刷新后重试。');
    return {id:item.id,email:item.email.slice(0,320)};
  };
  const projectCachedKey = (item,keyId) => {
    if (item?.id !== keyId || !validGroup(item.groupId) ||
      ['name','groupName','status'].some(field => typeof item[field] !== 'string' || item[field].length > (field === 'status' ? 32 : 320))) throw Error('invalid cached key');
    return {id:keyId,name:item.name,groupId:item.groupId,groupName:item.groupName,status:item.status};
  };
  function restoreFavorite(item) {
    const cached = item.cached;if (cached === undefined) return;
    try {
      if (!cached || !Number.isSafeInteger(cached.checkedAt) || cached.checkedAt < 0 || cached.checkedAt > 8640000000000000 ||
        typeof cached.uncertain !== 'boolean' || !Array.isArray(cached.groups) || cached.groups.length > 2000) throw Error('invalid cached state');
      const seen = new Set(), groups = cached.groups.map(group => {
        if (!validID(group?.id) || seen.has(group.id) || typeof group.name !== 'string' || group.name.length > 320) throw Error('invalid cached group');
        seen.add(group.id);return {id:group.id,name:group.name};
      });
      const key = cached.key === null ? null : projectCachedKey(cached.key,item.keyId);
      if (cached.uncertain && !key || cached.notice != null && (cached.notice.kind !== 'error' || typeof cached.notice.text !== 'string' || cached.notice.text.length > 500)) throw Error('invalid cached notice');
      const state = context(item.user.id), id = pair(item.user.id,item.keyId);state.groups = groups;
      if (key) state.keys.push(key);
      favoriteChecks.set(id,cached.checkedAt);
      if (cached.uncertain) {uncertain.add(id);notices.set(id,{kind:'error',text:'上次切换结果未确认，请刷新核对后再操作。'});}
      else if (cached.notice) notices.set(id,{kind:'error',text:cached.notice.text});
    } catch { /* 旧收藏仍可补读，异常缓存不能成为归属或权限证据。 */ }
  }
  try {preferenceSource = source(credential());} catch { /* 尚未配置凭据时仍可初始化界面。 */ }
  try {
    if (file && fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file,'utf8'));
      if (saved.version === 1 && saved.source === source(credential())) {
        user = saved.user === null ? null : projectUser(saved.user);expanded = saved.expanded !== false;
        if (user) users.set(user.id,user);
        if (saved.favorites !== undefined && (!Array.isArray(saved.favorites) || saved.favorites.length > 20)) throw Error('invalid favorites');
        for (const item of saved.favorites || []) {
          const owner = projectUser(item.user), id = pair(owner.id,item.keyId);
          if (!validID(item.keyId) || typeof item.name !== 'string' || favorites.has(id)) throw Error('invalid favorite');
          favorites.set(id,{user:owner,keyId:item.keyId,name:item.name.slice(0,320)});users.set(owner.id,owner);
          restoreFavorite({...item,user:owner});
        }
      }
    }
  } catch {cacheError = '本地分组切换偏好无法读取，请重新选择用户。';user = null;favorites.clear();users.clear();contexts.clear();favoriteChecks.clear();uncertain.clear();notices.clear();}
  function save() {
    if (!file || closed) return;
    try {
      const signature = source(credential());
      if (preferenceSource !== null && signature !== preferenceSource) {cacheError = '管理凭据已变化，请重新加载后操作。';return;}
      preferenceSource = signature;
      const savedFavorites = [...favorites.values()].map(item => {
        const state = contexts.get(item.user.id), id = pair(item.user.id,item.keyId), key = state?.keys.find(key => key.id === item.keyId);
        const checkedAt = favoriteChecks.get(id) ?? state?.checkedAt ?? null, notice = notices.get(id);
        return {...item,name:key?.name || item.name,...(checkedAt === null ? {} : {cached:{key:key ? projectCachedKey(key,item.keyId) : null,
          groups:(state?.groups || []).map(group => ({id:group.id,name:group.name})),checkedAt,uncertain:uncertain.has(id) || writes.has(id),
          notice:notice?.kind === 'error' ? {kind:'error',text:notice.text} : null}})};
      });
      fs.writeFileSync(file+'.tmp',JSON.stringify({version:1,source:signature,user,expanded,favorites:savedFavorites}),{mode:0o600});
      fs.renameSync(file+'.tmp',file);cacheError = '';
    } catch {cacheError = '分组切换偏好保存失败，重启后可能无法恢复。';}
  }
  function context(userId) {
    if (!contexts.has(userId)) contexts.set(userId,{keys:[],groups:[],checkedAt:null,error:'',loading:null,revision:0});
    return contexts.get(userId);
  }
  function prune() {
    const retained = new Set([...favorites.values()].map(item => item.user.id));if (user) retained.add(user.id);
    for (const [id,item] of contexts) if (!retained.has(id) && !item.loading && ![...writes].some(value => value.startsWith(`${id}:`))) contexts.delete(id);
  }
  function projectKey(userId,key) {
    return {...key,busy:writes.has(pair(userId,key.id)),uncertain:uncertain.has(pair(userId,key.id)),notice:notices.get(pair(userId,key.id)) || null};
  }
  function snapshot() {
    const current = user && contexts.get(user.id);
    return {user:user && {...user},expanded,keys:(current?.checkedAt != null ? current.keys : []).map(key => projectKey(user.id,key)),groups:(current?.groups || []).map(group => ({...group})),
      checkedAt:current?.checkedAt ?? null,error:current?.error || '',cacheError,busy:Boolean(current?.loading),
      favorites:[...favorites.values()].map(item => {
        const state = contexts.get(item.user.id), key = state?.keys.find(key => key.id === item.keyId), checkedAt = favoriteChecks.get(pair(item.user.id,item.keyId)) ?? state?.checkedAt ?? null;
        return {user:{...item.user},keyId:item.keyId,name:key?.name || item.name,key:key ? projectKey(item.user.id,key) : null,
          groups:(state?.groups || []).map(group => ({...group})),checkedAt,error:state?.error || '',busy:Boolean(state?.loading),missing:checkedAt !== null && !key};
      })};
  }
  async function bounded(work) {
    if (closed) throw message('分组切换已关闭。');
    const controller = new AbortController();controllers.add(controller);
    const timeout = clock.setTimeout(() => controller.abort(),60000);timeout.unref?.();
    try {
      const key = credential(), signature = source(key);
      if (preferenceSource !== null && signature !== preferenceSource) throw message('管理凭据已变化，请重新加载后操作。');
      const request = async (route, method = 'GET', body) => {
        controller.signal.throwIfAborted();
        const response = await fetchImpl(`${origin}/api/v1/admin/${route}`,{method,redirect:'error',headers:{'x-api-key':key,...(body ? {'Content-Type':'application/json'} : {})},
          signal:controller.signal,...(body ? {body:JSON.stringify(body)} : {})});
        if (!response.ok) throw message(response.status === 401 || response.status === 403 ? '管理凭据无效或没有操作权限，请检查配置。' :
          response.status === 404 || response.status === 405 ? '服务端不支持此接口或对象已不存在，请刷新后核对。' : '服务端拒绝操作，请刷新后重试。',response.status >= 400 && response.status < 500);
        const result = await response.json();controller.signal.throwIfAborted();
        if (result?.code != null && result.code !== 0) throw message('服务端拒绝操作，请刷新后重试。');
        return result?.data ?? result;
      };
      const checkSource = () => {if (source(credential()) !== signature) throw message('管理凭据已变化，请重新加载后操作。');};
      return await work(request,checkSource);
    } finally {clock.clearTimeout(timeout);controller.abort();controllers.delete(controller);}
  }
  async function readKeys(request,userId) {
    const result = [], seen = new Set();
    for (let page = 1;page <= 10;page++) {
      const data = await request(`users/${userId}/api-keys?page=${page}&page_size=100`);
      if (!Array.isArray(data?.items) || data.items.length > 100 || !Number.isSafeInteger(data.total) || data.total < 0 || data.total > 1000) throw message('Key 列表不完整，无法确认归属，请刷新后重试。');
      for (const item of data.items) {
        if (!validID(item?.id) || item.user_id !== userId || seen.has(item.id) || !validGroup(item.group_id ?? null)) throw message('Key 归属或分组信息异常，请刷新后核对。');
        seen.add(item.id);result.push({id:item.id,name:typeof item.name === 'string' ? item.name.slice(0,320) : '',groupId:item.group_id ?? null,
          groupName:typeof item.group?.name === 'string' ? item.group.name.slice(0,320) : '',status:typeof item.status === 'string' ? item.status.slice(0,32) : ''});
      }
      if (result.length === data.total) return result;
      if (result.length > data.total || !data.items.length) break;
    }
    throw message('Key 列表不完整，无法确认归属，请刷新后重试。');
  }
  async function readContext(request,userId) {
    const [owner,directory,subscriptions] = await Promise.all([request(`users/${userId}`),request('groups/all'),request(`users/${userId}/subscriptions`)]);
    if (owner?.id !== userId || !['active','disabled'].includes(owner.status) || owner.allowed_groups !== null && !Array.isArray(owner.allowed_groups) ||
      owner.allowed_groups?.some(id => !validID(id)) || owner.restrict_public_groups != null && typeof owner.restrict_public_groups !== 'boolean' ||
      !Array.isArray(directory) || directory.length > 2000 || !Array.isArray(subscriptions) || subscriptions.length > 2000) throw message('用户分组权限信息不完整，暂不能切换。');
    const allowed = new Set(owner.allowed_groups || []), subscribed = new Set(), seen = new Set();
    for (const item of subscriptions) {
      if (item?.user_id !== userId || !validID(item.group_id) || !['active','expired','revoked','suspended'].includes(item.status)) throw message('订阅信息异常，暂不能切换。');
      const end = item.expires_at === null ? Infinity : Date.parse(item.expires_at), start = Date.parse(item.starts_at);
      if (!Number.isFinite(start) || !Number.isFinite(end) && end !== Infinity) throw message('订阅有效期不完整，暂不能切换。');
      if (item.status === 'active' && start <= clock.now() && end > clock.now()) subscribed.add(item.group_id);
    }
    return directory.flatMap(item => {
      if (!validID(item?.id) || seen.has(item.id) || typeof item.name !== 'string' || typeof item.is_exclusive !== 'boolean' ||
        !['active','inactive'].includes(item.status) || !['standard','subscription'].includes(item.subscription_type)) throw message('分组信息不完整，暂不能切换。');
      seen.add(item.id);
      const permitted = item.subscription_type === 'subscription' ? subscribed.has(item.id) :
        !item.is_exclusive && owner.restrict_public_groups !== true || allowed.has(item.id);
      return owner.status === 'active' && item.status === 'active' && permitted ? [{id:item.id,name:item.name.slice(0,320)}] : [];
    });
  }
  async function search(raw = '') {
    if (closed || typeof raw !== 'string' || raw.length > 100) throw message('搜索内容最多 100 字。');
    try {
      const result = await searchUsers(raw.trim());
      if (!Array.isArray(result) || result.length > 30) throw Error('invalid users');
      const projected = result.map(projectUser);
      for (const item of projected) {users.delete(item.id);users.set(item.id,item);}
      while (users.size > 300) users.delete(users.keys().next().value);
      return projected;
    } catch {throw message('无法搜索 Sub2API 用户，请稍后重试。');}
  }
  function refreshUser(userId) {
    if (closed || [...writes].some(key => key.startsWith(`${userId}:`))) return Promise.resolve();
    const state = context(userId);if (state.loading) return state.loading;
    const ticket = ++state.revision;state.error = '';
    const flight = (async () => {
      try {
        const data = await bounded(async (request,checkSource) => {
          const [nextKeys,nextGroups] = await Promise.all([readKeys(request,userId),readContext(request,userId)]);checkSource();return {nextKeys,nextGroups};
        });
        if (!closed && state.revision === ticket) {
          state.keys = data.nextKeys;state.groups = data.nextGroups;state.checkedAt = clock.now();
          for (const key of [...uncertain]) if (key.startsWith(`${userId}:`)) uncertain.delete(key);
          for (const key of [...notices.keys()]) if (key.startsWith(`${userId}:`)) notices.delete(key);
          for (const key of [...favoriteChecks.keys()]) if (key.startsWith(`${userId}:`)) favoriteChecks.delete(key);
          save();
        }
      } catch (failure) {if (!closed && state.revision === ticket) state.error = failure.safe ? failure.message : '读取 Key 分组失败，请稍后刷新。';}
    })().finally(() => {if (state.loading === flight) state.loading = null;prune();});
    state.loading = flight;return flight;
  }
  async function refresh() {if (user) await refreshUser(user.id);return snapshot();}
  async function refreshFavorites() {
    await Promise.all([...new Set([...favorites.values()].map(item => item.user.id))].map(refreshUser));return snapshot();
  }
  async function refreshFavorite(value) {
    if (closed || !value || !validID(value.userId) || !validID(value.keyId) || !favorites.has(pair(value.userId,value.keyId))) throw message('请选择已收藏的 Key。');
    const {userId,keyId} = value, id = pair(userId,keyId), state = context(userId), previous = state.keys.find(key => key.id === keyId);
    if (writes.has(id)) throw message('Key 正在保存，请稍后刷新。');
    if (state.loading) {await state.loading;return snapshot();}
    const {keys,groups} = await bounded(async (request,checkSource) => {
      const [keys,groups] = await Promise.all([readKeys(request,userId),readContext(request,userId)]);checkSource();return {keys,groups};
    }).catch(failure => {throw failure.safe ? failure : message('读取 Key 分组失败，请稍后刷新。');});
    // 用户接口返回完整列表，但只合并点选的 Key，保留其他行的状态和不确定结果。
    // 读取期间保存或整表刷新已替换该 Key 时，丢弃旧响应。
    if (!closed && favorites.has(id) && contexts.get(userId) === state && !writes.has(id) && state.keys.find(key => key.id === keyId) === previous) {
      const key = keys.find(key => key.id === keyId);
      state.keys = key ? previous ? state.keys.map(item => item.id === keyId ? key : item) : [...state.keys,key] : state.keys.filter(item => item.id !== keyId);
      state.groups = groups;state.error = '';favoriteChecks.set(id,clock.now());uncertain.delete(id);notices.delete(id);
      save();
    }
    return snapshot();
  }
  function setFavorite(value) {
    if (closed || !value || !validID(value.userId) || !validID(value.keyId) || typeof value.favorite !== 'boolean') throw message('请选择有效的用户和 Key。');
    const id = pair(value.userId,value.keyId);
    if (writes.has(id)) throw message('Key 正在保存，请稍后再修改收藏。');
    if (value.favorite) {
      if (!favorites.has(id)) {
        const key = user?.id === value.userId && contexts.get(value.userId)?.keys.find(key => key.id === value.keyId);
        if (!key) throw message('请从已加载的用户列表中收藏 Key。');
        if (favorites.size >= 20) throw message('最多收藏 20 个常用 Key。');
        favorites.set(id,{user:{...user},keyId:key.id,name:key.name});
      }
    } else {favorites.delete(id);favoriteChecks.delete(id);}
    save();prune();return snapshot();
  }
  async function select(id) {
    if (!validID(id) || !users.has(id) && user?.id !== id) throw message('请从用户列表中选择账号。');
    user = {...(users.get(id) || user)};save();prune();
    if (contexts.get(id)?.checkedAt === null || !contexts.has(id)) await refreshUser(id);
    return snapshot();
  }
  async function switchGroup(value) {
    if (closed || !value || !validID(value.userId) || !validID(value.keyId) || !validID(value.groupId) || !validGroup(value.expectedGroupId)) throw message('请选择有效的用户、Key 和目标分组。');
    const {userId,keyId,groupId,expectedGroupId} = value, id = pair(userId,keyId), state = contexts.get(userId), known = state?.keys.find(key => key.id === keyId);
    if (user?.id !== userId && !favorites.has(id) || !known || state.loading || known.groupId !== expectedGroupId || !state.groups.some(group => group.id === groupId) || groupId === expectedGroupId || writes.has(id) || uncertain.has(id)) throw message('Key 或可用分组已变化，请刷新后重新选择。');
    writes.add(id);notices.delete(id);state.revision++;save();
    let sent = false, writeFailure = null, actual = null, usageSyncFailed = false;
    try {
      await bounded(async (request,checkSource) => {
        const [freshKeys,available] = await Promise.all([readKeys(request,userId),readContext(request,userId)]);
        const fresh = freshKeys.find(key => key.id === keyId);
        if (!fresh || fresh.groupId !== expectedGroupId) throw message('Key 当前分组已变化，请刷新后核对。');
        if (!available.some(group => group.id === groupId)) throw message('目标分组不存在或已无权使用，请刷新后重新选择。');
        checkSource();sent = true;
        try {await request(`api-keys/${keyId}`,'PUT',{group_id:groupId});} catch (failure) {writeFailure = failure;}
      });
    } catch (failure) {writeFailure = failure;}
    if (sent && !closed) {
      try {
        actual = await bounded(async (request,checkSource) => {const list = await readKeys(request,userId);checkSource();return list.find(key => key.id === keyId);});
        if (!actual) throw Error('key not found');
      } catch {actual = null;}
    }
    try {
      if (!closed) {
        if (actual) {
          state.keys = state.keys.map(key => key.id === keyId ? actual : key);
          if (state.checkedAt !== null) state.checkedAt = clock.now();
          if (favorites.has(id)) favoriteChecks.set(id,clock.now());
          try {onChanged({userId,keyId,groupId:actual.groupId,groupName:actual.groupName});} catch {usageSyncFailed = true;}
        }
        if (sent && (!actual || actual.groupId !== groupId && !writeFailure?.definite)) {
          uncertain.add(id);notices.set(id,{kind:'error',text:'切换请求已发送，但结果未确认。请刷新核对后再操作。'});
        } else if (actual?.groupId === groupId) {
          notices.set(id,{kind:'success',text:`已切换至${actual.groupName || `分组 #${groupId}`}。`});
        } else {
          notices.set(id,{kind:'error',text:writeFailure?.safe ? writeFailure.message : sent ? '回读分组与目标不一致，请核对当前分组。' : '切换前检查失败，请刷新后重试。'});
        }
      }
    } finally {
      writes.delete(id);if (!closed) save();
      if (usageSyncFailed) cacheError = '分组已核对，但消费缓存未同步，请刷新 Key 今日消费。';
      prune();
    }
    return snapshot();
  }
  function setExpanded(value) {if (typeof value !== 'boolean') throw message('无效的折叠状态。');expanded = value;save();return snapshot();}
  function close() {closed = true;for (const controller of controllers) controller.abort();}
  return {snapshot,search,select,refresh,refreshFavorites,refreshFavorite,setFavorite,switchGroup,setExpanded,open:() => Promise.resolve(snapshot()),close};
}
module.exports = {createKeyGroups};
