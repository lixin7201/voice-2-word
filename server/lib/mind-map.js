const DEFAULT_TONES = ['blue', 'green', 'orange', 'purple', 'cyan', 'warm'];

function normalizeMindMap(value, fallbackTitle = '') {
  if (!value) return null;
  const root = Array.isArray(value) ? { children: value } : value;
  if (!root || typeof root !== 'object') return null;

  const title = firstText(root.title, root.name, '录音思维导图');
  const center = firstText(root.center, root.topic, root.subject, root.title, fallbackTitle, '录音总结');
  const sourceBranches = firstArray(root.branches, root.children, root.nodes);
  let branches = sourceBranches.map((branch, index) => normalizeBranch(branch, index)).filter(Boolean);

  if (!branches.length && center) {
    branches = [{
      id: 'branch-1',
      title: center,
      summary: '已生成中心主题，暂无分支节点',
      tone: DEFAULT_TONES[0],
      children: [],
    }];
  }

  if (!center && !branches.length) return null;
  return {
    title,
    center,
    branches,
  };
}

function normalizeBranch(value, index) {
  const branch = typeof value === 'string' ? { title: value } : value;
  if (!branch || typeof branch !== 'object') return null;
  const children = firstArray(branch.children, branch.nodes, branch.items)
    .map((child, childIndex) => normalizeChild(child, childIndex))
    .filter(Boolean);
  const title = firstText(branch.title, branch.topic, branch.label, branch.name, branch.text, `分支 ${index + 1}`);
  const summary = firstText(branch.summary, branch.detail, branch.description, '');
  return {
    id: firstText(branch.id, `branch-${index + 1}`),
    title,
    summary,
    tone: firstText(branch.tone, DEFAULT_TONES[index % DEFAULT_TONES.length]),
    children,
  };
}

function normalizeChild(value, index) {
  if (typeof value === 'string') return { title: value, detail: '', items: [] };
  if (!value || typeof value !== 'object') return null;
  const nestedItems = firstArray(value.items, value.children, value.nodes)
    .map((item) => {
      if (typeof item === 'string') return item;
      if (!item || typeof item !== 'object') return '';
      return firstText(item.title, item.topic, item.label, item.name, item.text, item.detail, item.summary, '');
    })
    .filter(Boolean);
  return {
    title: firstText(value.title, value.topic, value.label, value.name, value.text, `要点 ${index + 1}`),
    detail: firstText(value.detail, value.summary, value.description, ''),
    items: nestedItems,
    tags: firstArray(value.tags).map((tag) => String(tag || '').trim()).filter(Boolean),
  };
}

function firstArray(...values) {
  const found = values.find((value) => Array.isArray(value));
  return found || [];
}

function firstText(...values) {
  for (const value of values) {
    const text = String(value ?? '').trim();
    if (text) return text;
  }
  return '';
}

module.exports = {
  normalizeMindMap,
};
