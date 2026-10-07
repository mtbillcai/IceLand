import { createView } from './view.mjs';
import { GitHubStore, clone, validItems, parseDocument, normalizeConfig, configKey, connectionToken, sameItems, mergeItems } from './sync.mjs?v=20261007-fetch-fix';

const $ = selector => document.querySelector(selector);
const ROOT = 'iceland-github-v1:';
let config = null, token = '', state, storageKey, storageOK = true, corrupt = false, authorized = false;
let working = false, timer, pendingConflict = null, lastCheck = 0, preview = false;
let canOwnCache = false, releaseLock;
const view = createView(commit);
const blank = () => ({ id: crypto.randomUUID(), updatedAt: 0, items: [], base: null, sha: null });
const dirty = () => state && !sameItems(state.items, state.base || []);
const writable = () => canOwnCache && !corrupt && (!config || (Boolean(token) && authorized));
const storedKey = () => ROOT + (config ? configKey(config) : 'local');

function status(title, message, warning = false) {
  $('#sync-label').textContent = title;
  $('#local-status').textContent = message;
  $('#local-status').classList.toggle('storage-warning', warning);
  $('#storage-note').textContent = !config ? '当前是本地清单。连接 GitHub 后可跨设备同步。'
    : authorized ? '私人清单 · 修改会自动同步到 GitHub。' : '私人清单 · 需要你的 GitHub 授权才能查看。';
}
function controls() {
  document.body.classList.toggle('locked', Boolean(config && !authorized));
  const disabled = !writable() || working || Boolean(pendingConflict);
  $('#add').disabled = disabled;
  $('#import-open').disabled = disabled;
  document.querySelectorAll('[data-check],[data-edit],[data-delete]').forEach(e => {
    e.disabled = disabled || (e.matches('[data-check]') && state.items.find(x => x.id === e.dataset.check)?.plan === '不带');
  });
  $('#sync-now').disabled = working || corrupt || Boolean(pendingConflict);
  $('#sync-now').textContent = working ? '同步中…' : pendingConflict ? '有待解决的冲突' : '立即同步';
  $('#settings-open').disabled = working || Boolean(pendingConflict);
  $('#welcome').hidden = Boolean(state.items.length);
}
function render() { view.setItems(config && !authorized ? [] : state.items); controls(); }
// Search/category navigation also re-renders item controls.
new MutationObserver(controls).observe($('#items'), { childList: true });
function cache() {
  if (!canOwnCache || corrupt) return;
  try { localStorage.setItem(storageKey, JSON.stringify(state)); storageOK = true; }
  catch { storageOK = false; }
}
async function ownCache() {
  releaseLock?.(); releaseLock = undefined;
  canOwnCache = false;
  if (!navigator.locks) { canOwnCache = true; return; }
  await new Promise(resolve => {
    navigator.locks.request(storageKey, { ifAvailable: true }, async lock => {
      canOwnCache = Boolean(lock);
      resolve();
      if (lock) await new Promise(release => { releaseLock = release; });
    }).catch(() => { canOwnCache = false; resolve(); });
  });
}
async function loadState() {
  storageKey = storedKey();
  corrupt = false; state = blank();
  await ownCache();
  try {
    const text = localStorage.getItem(storageKey);
    if (text) {
      const value = JSON.parse(text);
      parseDocument(text);
      if (value.base !== null && !validItems(value.base)) throw Error('invalid baseline');
      state = value;
    }
  } catch {
    corrupt = true;
    status('本地记录无法读取', '已停止自动保存，以免覆盖原记录。可以下载现有缓存后清除连接，再重新读取云端。', true);
  }
  render();
}
async function commit(next) {
  if (!writable() || working || pendingConflict) { render(); return false; }
  state.items = clone(next);
  state.updatedAt = Date.now();
  cache(); render();
  status(config ? '待同步到 GitHub' : '本地清单', storageOK
    ? '修改已保存在当前浏览器。' + (config ? '正在等待自动同步…' : '连接 GitHub 后，可在其他电脑上访问。')
    : '浏览器未允许本地保存。请同步或下载备份后再关闭页面。', !storageOK);
  clearTimeout(timer);
  if (config) timer = setTimeout(() => sync(), 1500);
  return true;
}
function showConflicts(result, remote) {
  pendingConflict = { result, remote };
  $('#conflict-list').replaceChildren();
  for (const conflict of result.conflicts) {
    const section = document.createElement('fieldset');
    const title = document.createElement('legend');
    title.textContent = conflict.local?.name || conflict.remote?.name || conflict.base?.name;
    section.append(title);
    for (const [value, name, item] of [['local', '此电脑版本', conflict.local], ['remote', 'GitHub 版本', conflict.remote]]) {
      const label = document.createElement('label');
      const input = document.createElement('input');
      input.type = 'radio'; input.name = conflict.id; input.value = value; input.required = true;
      const text = document.createElement('span');
      text.textContent = name + '：' + (item
        ? `${item.name} · ${item.category} · ${item.quantity || '未填数量'} · ${item.plan} · ${item.packed ? '已准备' : '未准备'}\n${item.note}`
        : '删除此物品');
      label.append(input, text); section.append(label);
    }
    $('#conflict-list').append(section);
  }
  status('同步已暂停', '请处理版本冲突。两份修改均未丢弃，云端未被覆盖。', true);
  if (!$('#conflicts').open) $('#conflicts').showModal();
  controls();
}
async function sync({ initialize = false } = {}) {
  if (!config) { openSettings(); return; }
  if (!token) { status('私人清单 · 尚未解锁', '点击「GitHub 同步设置」，输入仅能访问私有数据仓库的令牌。'); controls(); return; }
  if (working || corrupt || pendingConflict) return;
  if (view.isEditing()) { view.toast('请先保存或关闭正在编辑的物品，再同步。'); return; }
  if (!canOwnCache) { status('此标签页只读', '另一标签页正在管理这份清单。请关闭另一页后刷新。'); return; }
  working = true; controls();
  status('正在同步', '正在检查 GitHub 上的最新版本…');
  const store = new GitHubStore(config, token);
  try {
    let remote;
    try { remote = await store.read(); }
    catch (error) {
      if (error.status !== 404 || !initialize) throw error;
      // A 404 can also hide inaccessible repositories: verify the existing branch first.
      await store.assertBranch();
      if (!state.items.length) throw Error('请先导入清单，再创建云端文件。');
      const document = { id: state.id, items: clone(state.items), updatedAt: Date.now() };
      state.sha = await store.write(document);
      authorized = true;
      state.base = clone(document.items); state.updatedAt = document.updatedAt;
      cache(); render();
      status('已与 GitHub 同步', '已创建云端清单。其他电脑现在可以读取。');
      return true;
    }
    lastCheck = Date.now();
    authorized = true;
    if (state.base !== null && state.id !== remote.document.id)
      throw Error('云端已换成另一份清单。请先下载本机备份，再退出连接并重新连接。');
    const merged = mergeItems(state.base || [], state.items, remote.document.items);
    if (merged.conflicts.length) { showConflicts(merged, remote); return; }
    const hasChanges = !sameItems(merged.items, remote.document.items);
    if (hasChanges && !token) {
      status('本机有未同步的修改', '请在「GitHub 同步设置」填写令牌，才能保存到云端。', true);
      return;
    }
    let sha = remote.sha;
    const document = { id: remote.document.id, items: merged.items,
      updatedAt: hasChanges ? Date.now() : remote.document.updatedAt };
    if (hasChanges) sha = await store.write(document, remote.sha);
    state = { ...document, base: clone(document.items), sha };
    cache(); render();
    status('已与 GitHub 同步',
      `已读取 ${state.items.length} 项物品，${state.items.filter(item => item.packed && item.plan !== '不带').length} 项已准备 · ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`
      + ' · 私人清单，可以在其他电脑上授权后继续整理。'
      + (storageOK ? '' : ' 当前浏览器未允许缓存。'));
    return true;
  } catch (error) {
    if (error.status === 401 || error.status === 403 || error.status === 404) { authorized = false; render(); }
    status('同步未完成', error.message, true);
    if (error.status === 404 && token && state.items.length) {
      $('#initialize-cloud').hidden = false;
    }
    return false;
  } finally { working = false; controls(); }
}
$('#conflict-form').onsubmit = e => {
  e.preventDefault();
  const { result, remote } = pendingConflict;
  const choices = Object.fromEntries(new FormData(e.target));
  const resolved = mergeItems(state.base || [], state.items, remote.document.items, choices);
  if (resolved.conflicts.length) return;
  state.items = resolved.items;
  state.base = clone(remote.document.items); state.sha = remote.sha; state.id = remote.document.id;
  state.updatedAt = Date.now(); pendingConflict = null;
  $('#resolve-conflicts').hidden = true;
  cache(); render(); $('#conflicts').close(); void sync();
};
function deferConflicts() {
  // Keep the unresolved merge pending so timer/focus events cannot silently resume it.
  $('#conflicts').close();
  $('#resolve-conflicts').hidden = false;
}
$('#conflict-cancel').onclick = deferConflicts;
$('#conflicts').addEventListener('cancel', e => { e.preventDefault(); deferConflicts(); });

function openSettings() {
  const c = config || { owner: 'mtbillcai', repo: 'IceLand-data', branch: 'main', path: 'checklist.json' };
  for (const key of ['owner', 'repo', 'branch', 'path']) $(`#github-${key}`).value = c[key];
  $('#github-token').value = '';
  $('#github-token').placeholder = token ? '已填过令牌；留空可继续使用' : '粘贴生成的令牌，不是 GitHub 密码或令牌名称';
  $('#settings-error').textContent = '';
  $('#settings').showModal();
}
$('#settings-open').onclick = openSettings;
$('#settings-close').onclick = () => { $('#github-token').value = ''; $('#settings').close(); };
$('#settings').addEventListener('cancel', () => { $('#github-token').value = ''; });
$('#settings-form').onsubmit = async e => {
  e.preventDefault();
  const button = $('#settings-submit');
  if (button.disabled) return;
  button.disabled = true;
  button.textContent = '正在解锁并读取清单…';
  $('#settings-error').textContent = '';
  try {
    const next = normalizeConfig(Object.fromEntries(['owner', 'repo', 'branch', 'path'].map(k => [k, $(`#github-${k}`).value])));
    const switching = !config || configKey(next) !== configKey(config);
    if (config && switching && dirty()) throw Error('当前清单还有未同步修改，请先同步或下载备份。');
    const localDraft = !config ? clone(state) : null;
    token = connectionToken($('#github-token').value, token, switching);
    authorized = false;
    config = next;
    try {
      localStorage.setItem(ROOT + 'config', JSON.stringify(config));
      sessionStorage.setItem(ROOT + 'token:' + configKey(config), token);
    } catch { /* UI remains usable for the current page. */ }
    $('#github-token').value = '';
    if (switching) {
      await loadState();
      if (!corrupt && localDraft?.items.length && !state.items.length && state.base === null) {
        state = localDraft; cache(); render();
      }
    }
    const connected = await sync();
    if (connected || pendingConflict) $('#settings').close();
    else $('#settings-error').textContent = $('#local-status').textContent;
  } catch (error) {
    $('#settings-error').textContent = error.message;
    $('#github-token').focus();
  } finally {
    button.disabled = false;
    button.textContent = '解锁并加载清单';
  }
};
$('#disconnect').onclick = async () => {
  if (dirty() && !confirm('本机还有未同步修改。请确认已下载备份；退出连接会清除本机缓存，是否继续？')) return;
  try {
    localStorage.removeItem(storageKey); localStorage.removeItem(ROOT + 'config');
    if (config) sessionStorage.removeItem(ROOT + 'token:' + configKey(config));
  } catch {}
  token = ''; authorized = false; pendingConflict = null;
  $('#github-token').value = ''; $('#settings').close();
  await loadState();
  status('已退出连接', '凭证与该连接的本机缓存已清除。云端清单保持不变。');
};
$('#sync-now').onclick = () => token ? sync() : openSettings();
$('#initialize-cloud').onclick = async () => {
  if (!confirm('将在所选 GitHub 仓库创建 checklist JSON 文件。公开仓库中的清单会公开，是否继续？')) return;
  $('#initialize-cloud').hidden = true;
  await sync({ initialize: true });
};
$('#resolve-conflicts').onclick = () => { $('#resolve-conflicts').hidden = true; $('#conflicts').showModal(); };
$('#save-copy').onclick = () => {
  if (config && !authorized) return;
  let content;
  if (corrupt) {
    try { content = localStorage.getItem(storageKey); } catch {}
    if (!content) { view.toast('无法读取本地缓存。'); return; }
  } else content = JSON.stringify({ id: state.id, updatedAt: state.updatedAt, items: state.items }, null, 2);
  const url = URL.createObjectURL(new Blob([content], { type: 'application/json;charset=utf-8' }));
  const a = document.createElement('a'); a.href = url;
  a.download = `冰岛行李清单-${new Date().toISOString().slice(0,10)}.json`;
  a.click(); setTimeout(() => URL.revokeObjectURL(url), 5000);
};
$('#import-open').onclick = () => $('#import-file').click();
$('#import-file').onchange = async e => {
  const file = e.target.files[0]; e.target.value = '';
  if (!file || !writable() || working || pendingConflict) return;
  try {
    if (file.size > 2 * 1024 * 1024) throw Error('清单文件过大，请选择 2 MB 以内的 HTML 或 JSON。');
    let text = await file.text();
    if (/\.html?$/i.test(file.name)) {
      const match = text.match(/<script\b[^>]*\bid=["']saved-checklist["'][^>]*>([\s\S]*?)<\/script>/i);
      if (!match) throw Error('此 HTML 没有保存的清单数据，请选择原来的清单副本。');
      text = match[1];
    }
    const data = parseDocument(text);
    if (state.items.length && !confirm(`导入 ${data.items.length} 项物品将替换当前清单，并在连接后同步。是否继续？`)) return;
    if (!config && state.base === null) state.id = data.id;
    await commit(data.items);
    view.toast(`已导入 ${data.items.length} 项物品，保留原有勾选状态。`);
  } catch (error) { view.toast(error.message); }
};
window.addEventListener('beforeunload', e => {
  if (working || (config && dirty()) || (!storageOK && state.items.length)) { e.preventDefault(); e.returnValue = ''; }
});
window.addEventListener('online', () => { if (config && !pendingConflict) void sync(); });
window.addEventListener('focus', () => {
  if (config && Date.now() - lastCheck > (token ? 15000 : 120000)) void sync();
});
window.addEventListener('storage', e => {
  if (e.key !== storageKey || canOwnCache || !e.newValue) return;
  try { const next = JSON.parse(e.newValue); parseDocument(e.newValue); state = next; render(); } catch {}
});
setInterval(() => {
  if (config && !document.hidden && Date.now() - lastCheck > (token ? 30000 : 120000)) void sync();
}, 30000);

async function start() {
  let defaults = {};
  try { defaults = await (await fetch('./config.json', { cache: 'no-store' })).json(); } catch {}
  try {
    const saved = localStorage.getItem(ROOT + 'config');
    const candidate = saved ? JSON.parse(saved) : defaults;
    if (candidate.owner && candidate.repo) config = normalizeConfig(candidate);
  } catch { status('设置无法读取', '请重新填写 GitHub 同步设置。', true); }
  if (config) try { token = sessionStorage.getItem(ROOT + 'token:' + configKey(config)) || ''; } catch {}
  await loadState();
  if (corrupt) return;
  if (!canOwnCache) { status('此标签页只读', '另一标签页正在管理这份清单。请关闭另一页后刷新。'); return; }
  preview = ['localhost', '127.0.0.1'].includes(location.hostname) && defaults.localPreview;
  if (preview && !state.items.length && state.base === null) {
    try {
      const response = await fetch('./__local/checklist.json');
      const source = parseDocument(await response.text());
      state = { ...source, base: null, sha: null }; cache(); render();
    } catch {}
  }
  if (config) await sync();
  else status(preview ? '本机预览 · 原清单已导入' : '本地清单',
    '修改保存在当前浏览器；连接 GitHub 后自动同步。' + (preview ? '预览不会修改 GitHub 上的清单。' : ''));
}
void start();
