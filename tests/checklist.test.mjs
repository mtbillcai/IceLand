import test from 'node:test';
import assert from 'node:assert/strict';
import { matchesPreparation, applyBulkAction } from '../docs/checklist.mjs';
import { mergeItems, parseDocument, clone } from '../docs/sync.mjs';

const items = [
  { id: 'ready', name: '测试已准备', category: '衣物与鞋履', quantity: '2', note: '保留备注', plan: '携带', packed: true },
  { id: 'pending', name: '测试未准备', category: '数码与摄影', quantity: '1', note: '', plan: '按需', packed: false },
  { id: 'skip', name: '测试不带', category: '证件与出行', quantity: '1', note: '', plan: '不带', packed: false },
];
test('未准备筛选包含携带和按需，排除已准备和不带', () => {
  assert.deepEqual(items.filter(item => matchesPreparation(item, 'unprepared')).map(item => item.id), ['pending']);
  assert.deepEqual(items.filter(item => matchesPreparation(item, 'prepared')).map(item => item.id), ['ready']);
  assert.equal(items.filter(item => matchesPreparation(item, 'all')).length, 3);
});
test('取消全部勾选保留全部信息，不修改原数组', () => {
  const original = clone(items);
  const result = applyBulkAction(items, 'uncheck');
  assert.deepEqual(result, items.map(item => ({ ...item, packed: false })));
  assert.deepEqual(items, original);
  assert.equal(result.filter(item => matchesPreparation(item, 'unprepared')).length, 2);
});
test('清空可以同步为空清单，远端同时编辑仍需解决冲突', () => {
  const result = mergeItems(items, applyBulkAction(items, 'clear'), clone(items));
  assert.deepEqual(result.items, []);
  assert.deepEqual(result.conflicts, []);
  assert.deepEqual(parseDocument(JSON.stringify({ id: 'fixture', updatedAt: 1, items: result.items })).items, []);
  const changed = clone(items); changed[0].note = '另一台电脑修改';
  assert.equal(mergeItems(items, [], changed).conflicts.length, 1);
});
