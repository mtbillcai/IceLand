export function matchesPreparation(item, filter) {
  if (filter === 'all') return true;
  return item.plan !== '不带' && (filter === 'prepared' ? item.packed : !item.packed);
}

export function applyBulkAction(items, action) {
  if (action === 'clear') return [];
  if (action === 'uncheck') return items.map(item => ({ ...item, packed: false }));
  throw Error('未知的批量操作。');
}
