import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mergeItems, sameItems, validItems, parseDocument, normalizeConfig, connectionToken, encodeContent, decodeContent, GitHubStore } from '../docs/sync.mjs';
const item = (id = 'a', extra = {}) => ({ id, name: '保温杯', category: '零食与饮水', quantity: '1 个', note: '500ml', plan: '携带', packed: false, ...extra });
const cfg = { owner: 'mtbillcai', repo: 'IceLand', branch: 'data', path: 'checklist.json' };
const doc = items => ({ id: 'iceland-test', updatedAt: 1, items });
test('浏览器 fetch 不会以 GitHubStore 作为 this 调用', async () => {
  const store = new GitHubStore(cfg, '', async function () {
    assert.equal(this, undefined);
    return { ok: true, json: async () => ({ verified: true }) };
  });
  assert.deepEqual(await store.request('https://api.github.com/test'), { verified: true });
});
test('未填写令牌不能假装完成连接，切换仓库不会复用旧凭证', () => {
  assert.throws(() => connectionToken(''), /Generate token/);
  assert.throws(() => connectionToken('   '), /仅登录 GitHub/);
  assert.throws(() => connectionToken('', 'existing-test-token', true), /访问令牌/);
  assert.equal(connectionToken('', 'existing-test-token'), 'existing-test-token');
  assert.equal(connectionToken(' new-test-token ', 'old-test-token', true), 'new-test-token');
});
const sourcePath = fs.readdirSync('.').find(name => name.endsWith('_副本.html'));
test('原始 HTML 数据完整迁移', { skip: !sourcePath || !fs.existsSync('private-data/checklist.json') }, () => {
  const html = fs.readFileSync(sourcePath, 'utf8');
  const source = parseDocument(html.match(/id="saved-checklist">([\s\S]*?)<\/script>/)[1]);
  const backup = parseDocument(fs.readFileSync('private-data/checklist.json', 'utf8'));
  assert.deepEqual(backup, source);
  assert.equal(backup.items.length, source.items.length);
  assert.equal(backup.items.filter(x => x.packed).length, source.items.filter(x => x.packed).length);
});
test('中文和特殊字符的 GitHub Base64 内容往返', () => {
  const text = JSON.stringify(doc([item('a', { note: '🧊 </script> & "冰岛"' })]));
  assert.equal(decodeContent(encodeContent(text)), text);
});
test('数据校验拒绝重复 ID、无效状态和超长备注', () => {
  assert.equal(validItems([item(), item()]), false);
  assert.equal(validItems([item('a', { plan: 'invalid' })]), false);
  assert.equal(validItems([item('a', { note: 'a'.repeat(401) })]), false);
  assert.equal(validItems([item()]), true);
  assert.throws(() => parseDocument('{"items":[]}'));
});
test('仓库路径防止越界和错误来源', () => {
  assert.deepEqual(normalizeConfig(cfg), cfg);
  for (const patch of [{ owner: 'https://evil.test' }, { path: '../checklist.json' }, { path: '/checklist.json' }, { branch: 'a..b' }, { path: 'index.html' }])
    assert.throws(() => normalizeConfig({ ...cfg, ...patch }));
});
test('新电脑第一次读取完整云端内容', () => {
  const remote = [item(), item('b')];
  assert.deepEqual(mergeItems([], [], remote), { items: remote, conflicts: [] });
});
test('不同物品的离线修改自动合并', () => {
  const base = [item(), item('b')];
  const local = [item('a', { packed: true }), item('b')];
  const remote = [item(), item('b', { quantity: '2 个' })];
  const result = mergeItems(base, local, remote);
  assert.equal(result.conflicts.length, 0);
  assert.equal(result.items[0].packed, true);
  assert.equal(result.items[1].quantity, '2 个');
});
test('同一物品不同字段的修改自动合并', () => {
  assert.deepEqual(mergeItems([item()], [item('a', { note: '本机备注' })], [item('a', { packed: true })]),
    { items: [item('a', { note: '本机备注', packed: true })], conflicts: [] });
});
test('同一字段冲突必须选择版本', () => {
  const local = [item('a', { quantity: '2 个' })], remote = [item('a', { quantity: '3 个' })];
  assert.equal(mergeItems([item()], local, remote).conflicts.length, 1);
  assert.deepEqual(mergeItems([item()], local, remote, { a: 'remote' }).items, remote);
  assert.deepEqual(mergeItems([item()], local, remote, { a: 'local' }).items, local);
});
test('删除与编辑冲突不会丢弃任何版本', () => {
  const remote = [item('a', { name: '新保温杯' })];
  assert.equal(mergeItems([item()], [], remote).conflicts.length, 1);
  assert.deepEqual(mergeItems([item()], [], remote, { a: 'local' }).items, []);
  assert.deepEqual(mergeItems([item()], [], remote, { a: 'remote' }).items, remote);
});
test('单方删除与双向新增可合并', () => {
  const result = mergeItems([item()], [item('b')], [item(), item('c')]);
  assert.equal(result.conflicts.length, 0);
  assert.deepEqual(result.items.map(x => x.id), ['c', 'b']);
});
test('不带与已准备的交叉修改要求确认', () => {
  assert.equal(mergeItems([item()], [item('a', { plan: '不带' })], [item('a', { packed: true })]).conflicts.length, 1);
});
test('不同属性顺序视为相同数据，不产生多余提交', () => {
  const a = item(); const b = Object.fromEntries(Object.entries(a).reverse());
  assert.equal(sameItems([a], [b]), true);
});
function fakeGitHub() {
  let data = doc([item()]), version = 1;
  const calls = [];
  const fetcher = async (url, options) => {
    calls.push({ url, options });
    if (options.method === 'PUT') {
      const body = JSON.parse(options.body);
      if (!options.headers.Authorization) return new Response('{}', { status: 401 });
      if (body.sha !== 'v' + version) return new Response('{}', { status: 409 });
      data = parseDocument(decodeContent(body.content)); version++;
      return Response.json({ content: { sha: 'v' + version } });
    }
    return Response.json({ type: 'file', encoding: 'base64', sha: 'v' + version, content: encodeContent(JSON.stringify(data)) });
  };
  return { fetcher, calls, current: () => data };
}
test('两台电脑：A 写入，B 拉取并合并后写入，A 读到双方修改', async () => {
  const fake = fakeGitHub();
  const a = new GitHubStore(cfg, 'test-only-token', fake.fetcher);
  const b = new GitHubStore(cfg, 'test-only-token', fake.fetcher);
  const initial = await a.read();
  await a.write(doc([item('a', { packed: true })]), initial.sha);
  const latest = await b.read();
  const merged = mergeItems(initial.document.items, [item('a', { note: 'B 的备注' })], latest.document.items);
  await b.write(doc(merged.items), latest.sha);
  const final = await a.read();
  assert.equal(final.document.items[0].packed, true);
  assert.equal(final.document.items[0].note, 'B 的备注');
});
test('过期 SHA 被拒绝，云端不被覆盖', async () => {
  const fake = fakeGitHub(); const api = new GitHubStore(cfg, 'test-only-token', fake.fetcher);
  const initial = await api.read();
  await api.write(doc([item('a', { packed: true })]), initial.sha);
  await assert.rejects(api.write(doc([item('a', { quantity: '9 个' })]), initial.sha), e => e.status === 409);
  assert.equal(fake.current().items[0].packed, true);
  assert.equal(fake.current().items[0].quantity, '1 个');
});
test('匿名只能读取；令牌不出现在 URL 或清单内容', async () => {
  const fake = fakeGitHub(); const reader = new GitHubStore(cfg, '', fake.fetcher);
  await reader.read();
  assert.equal(fake.calls[0].options.headers.Authorization, undefined);
  await assert.rejects(reader.write(doc([item()]), 'v1'), /令牌/);
  assert.equal(fake.calls.length, 1);
  const writer = new GitHubStore(cfg, 'test-only-token', fake.fetcher);
  await writer.write(doc([item()]), 'v1');
  const call = fake.calls[1];
  assert.equal(call.options.headers.Authorization, 'Bearer test-only-token');
  assert.equal(call.url.includes('test-only-token'), false);
  assert.equal(call.options.body.includes('test-only-token'), false);
  assert.equal(call.options.redirect, 'error');
});
test('网络中断与无权限错误可辨认，未发生写入', async () => {
  const offline = new GitHubStore(cfg, 'test', async () => { throw Error('offline'); });
  await assert.rejects(offline.read(), /修改仍保存在本机/);
  for (const status of [401, 403, 404, 429]) {
    const api = new GitHubStore(cfg, 'test', async () => new Response('{}', { status }));
    await assert.rejects(api.read(), e => e.status === status);
  }
});
test('错误或损坏的云端数据不会被接受', async () => {
  const api = new GitHubStore(cfg, '', async () => Response.json({ type: 'file', encoding: 'base64', sha: 'x', content: encodeContent('{"id":"x","items":[{}]}') }));
  await assert.rejects(api.read(), /格式不正确/);
});
