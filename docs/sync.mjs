// No credentials are bundled with the site. Requests go only to api.github.com.
export const fields = ['name', 'category', 'quantity', 'note', 'plan', 'packed'];
export const clone = value => structuredClone(value);
export const same = (a, b) => a === undefined || b === undefined
  ? a === b : a.id === b.id && fields.every(key => a[key] === b[key]);
export function sameItems(a, b) {
  return a.length === b.length && a.every((item, i) => same(item, b[i]));
}
export function validItems(value) {
  const ids = new Set();
  return Array.isArray(value) && value.length <= 2000 && value.every(x => {
    if (!x || typeof x.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(x.id) || ids.has(x.id)
      || typeof x.name !== 'string' || !x.name.trim() || x.name.length > 80
      || typeof x.category !== 'string' || !x.category.trim() || x.category.length > 30
      || typeof x.quantity !== 'string' || x.quantity.length > 40
      || typeof x.note !== 'string' || x.note.length > 400 || typeof x.packed !== 'boolean'
      || !['携带', '按需', '不带'].includes(x.plan)) return false;
    ids.add(x.id);
    return true;
  });
}
export function parseDocument(text) {
  const data = JSON.parse(text);
  if (!data || typeof data.id !== 'string' || !/^[a-zA-Z0-9-]{1,100}$/.test(data.id)
    || !validItems(data.items)) throw Error('清单文件格式不正确，未覆盖本地记录。');
  return { id: data.id, updatedAt: Number(data.updatedAt) || 0, items: data.items };
}
export function normalizeConfig(input) {
  const result = Object.fromEntries(['owner', 'repo', 'branch', 'path'].map(k => [k, String(input[k] || '').trim()]));
  result.branch ||= 'main';
  result.path ||= 'checklist.json';
  if (!/^[a-zA-Z0-9-]+$/.test(result.owner) || !/^[a-zA-Z0-9_.-]+$/.test(result.repo)
    || result.repo === '.' || result.repo === '..' || /[\x00-\x20~^:?*\[\\]/.test(result.branch)
    || result.branch.includes('..') || result.branch.startsWith('/') || result.branch.endsWith('/')
    || !result.path.endsWith('.json') || result.path.split('/').some(p => !p || p === '.' || p === '..')
    || /[\x00-\x1f\\]/.test(result.path)) throw Error('请填写有效的 GitHub 用户、仓库、分支和 JSON 文件路径。');
  return result;
}
export const configKey = c => `${c.owner.toLowerCase()}/${c.repo.toLowerCase()}/${c.branch}/${c.path}`;

export function connectionToken(input, existing = '', switching = false) {
  const token = String(input || '').trim() || (switching ? '' : existing);
  if (!token) throw Error('还没有填写访问令牌。请先在 GitHub 点击 Generate token，再把生成的令牌粘贴到这里。仅登录 GitHub 账号还不能解锁清单。');
  return token;
}

// Three-way merge, including deletions. Concurrent edits to different fields can merge.
// Conflicting items remain local until the user explicitly resolves them.
export function mergeItems(base, local, remote, choices = {}) {
  const maps = [base, local, remote].map(list => new Map(list.map(x => [x.id, x])));
  const ids = [...new Set([...remote, ...local, ...base].map(x => x.id))];
  const items = [], conflicts = [];
  for (const id of ids) {
    const [b, l, r] = maps.map(m => m.get(id));
    let result, conflictFields = [];
    if (same(l, r)) result = l;
    else if (same(b, l)) result = r;
    else if (same(b, r)) result = l;
    else if (b && l && r) {
      result = { id };
      for (const key of fields) {
        if (l[key] === r[key] || b[key] === r[key]) result[key] = l[key];
        else if (b[key] === l[key]) result[key] = r[key];
        else conflictFields.push(key);
      }
      // '不带' and a simultaneous packed change need an explicit choice as well.
      if (!conflictFields.length && result.plan === '不带' && result.packed
        && (l.plan !== r.plan || l.packed !== r.packed)) conflictFields = ['plan', 'packed'];
    } else conflictFields = ['item'];
    if (conflictFields.length) {
      if (choices[id] === 'local') result = l;
      else if (choices[id] === 'remote') result = r;
      else { conflicts.push({ id, base: b, local: l, remote: r, fields: conflictFields }); result = l; }
    }
    if (result) items.push(clone(result));
  }
  return { items, conflicts };
}

export function encodeContent(text) {
  return btoa(Array.from(new TextEncoder().encode(text), byte => String.fromCharCode(byte)).join(''));
}
export function decodeContent(encoded) {
  return new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(encoded.replace(/\s/g, '')), c => c.charCodeAt(0)));
}
export class GitHubStore {
  constructor(config, token, fetcher = globalThis.fetch) {
    this.config = normalizeConfig(config);
    this.token = token;
    this.fetcher = fetcher;
    const {owner, repo, path} = this.config;
    this.url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${path.split('/').map(encodeURIComponent).join('/')}`;
  }
  async request(url, options = {}) {
    const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    if (options.body) headers['Content-Type'] = 'application/json';
    let response;
    try {
      // Browser fetch rejects an arbitrary receiver; call it as a standalone function.
      const fetcher = this.fetcher;
      response = await fetcher(url, { ...options, headers, cache: 'no-store',
        credentials: 'omit', redirect: 'error', signal: AbortSignal.timeout(20000) });
    } catch { throw Error('暂时无法连接 GitHub。修改仍保存在本机，请检查网络后重试。'); }
    if (!response.ok) {
      const messages = {
        401: 'GitHub 令牌无效或已过期，请在「同步设置」中重新填写。',
        403: 'GitHub 拒绝访问：请检查令牌权限、账户权限或 API 频率限制。',
        404: '找不到仓库、分支或清单文件，也可能是令牌没有访问权限。',
        409: '另一台设备刚刚更新了清单，请再次同步。',
        422: 'GitHub 未接受保存，请检查分支保护、文件路径或同时写入冲突。',
        429: 'GitHub 请求过于频繁，请稍后重试。'
      };
      const error = Error(messages[response.status] || `GitHub 请求失败（${response.status}），请稍后重试。`);
      error.status = response.status;
      throw error;
    }
    return response.json();
  }
  async read() {
    const response = await this.request(`${this.url}?ref=${encodeURIComponent(this.config.branch)}&t=${Date.now()}`);
    if (response.type !== 'file' || response.encoding !== 'base64' || !response.sha || !response.content)
      throw Error('GitHub 返回的清单不是可读取的 JSON 文件。');
    return { document: parseDocument(decodeContent(response.content)), sha: response.sha };
  }
  async assertBranch() {
    const { owner, repo, branch } = this.config;
    return this.request(`https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/branches/${encodeURIComponent(branch)}`);
  }
  async write(document, sha) {
    if (!this.token) throw Error('读取公开清单无需令牌；要保存修改，请先填写具有 Contents 读写权限的令牌。');
    const body = { message: 'Update Iceland packing checklist', branch: this.config.branch,
      content: encodeContent(JSON.stringify(document, null, 2) + '\n') };
    if (sha) body.sha = sha;
    const result = await this.request(this.url, { method: 'PUT', body: JSON.stringify(body) });
    if (!result.content?.sha) throw Error('未收到 GitHub 保存确认，请重新同步以核对结果。');
    return result.content.sha;
  }
}
