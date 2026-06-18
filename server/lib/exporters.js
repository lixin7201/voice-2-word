const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeMindMap } = require('./mind-map');

const CHROME_PATH = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

function buildExportText(record, store, target = 'full_record', markdown = true) {
  const summary = store.table('summaries').find((item) => item.audio_record_id === record.id);
  const transcript = store.table('transcripts').find((item) => item.audio_record_id === record.id);
  const followup = store.table('followup_forms').find((item) => item.audio_record_id === record.id);
  const owner = store.findById('employees', record.owner_employee_id)?.display_name || '';
  const department = record.owner_department_id ? store.findById('departments', record.owner_department_id)?.name || '' : '';
  const sections = [
    titleLine(record.title, markdown),
    '',
    `员工：${owner}`,
    `部门：${department}`,
    `创建时间：${record.created_at}`,
    `来源：${record.source_page_title || record.source_type}`,
    `模板：${record.template_type}`,
    '',
  ];
  if (target === 'overview_card') {
    sections.push(
      heading('总结卡片', markdown),
      renderOverviewCard(summary?.overview_card_json, markdown),
      '',
    );
    return sections.filter((item) => item !== undefined).join('\n');
  }
  if (target === 'mind_map') {
    sections.push(
      heading('思维导图', markdown),
      renderMindMap(summary?.mind_map_json, markdown),
      '',
    );
    return sections.filter((item) => item !== undefined).join('\n');
  }
  if (target !== 'transcript') {
    sections.push(
      heading('总结卡片', markdown),
      renderOverviewCard(summary?.overview_card_json, markdown),
      '',
      heading('文字重点总结', markdown),
      summary?.summary_markdown || '暂无总结',
      '',
      heading('思维导图', markdown),
      renderMindMap(summary?.mind_map_json, markdown),
      '',
    );
  }
  if (target !== 'summary') sections.push(heading('逐字稿', markdown), renderTranscript(transcript, markdown), '');
  if (target !== 'summary' && target !== 'transcript' && shouldExportFollowup(record, followup)) {
    sections.push(heading('跟单', markdown), followup.followup_markdown || '', '');
  }
  return sections.filter((item) => item !== undefined).join('\n');
}

function buildExportSvg(record, store, target) {
  const summary = store.table('summaries').find((item) => item.audio_record_id === record.id);
  if (target === 'overview_card') return renderOverviewCardSvg(record, summary?.overview_card_json);
  if (target === 'mind_map') return renderMindMapSvg(record, summary?.mind_map_json);
  throw new Error('该内容不支持 SVG 导出');
}

function buildExportBundle(record, store) {
  const bundleTargets = [
    { target: 'full_record', fileName: '01-full-record', formats: ['md', 'txt', 'docx', 'pdf'] },
    { target: 'summary', fileName: '02-summary', formats: ['md', 'txt', 'docx', 'pdf'] },
    { target: 'transcript', fileName: '03-transcript', formats: ['md', 'txt', 'docx', 'pdf'] },
    { target: 'overview_card', fileName: '04-overview-card', formats: ['md', 'txt', 'docx', 'pdf', 'svg'] },
    { target: 'mind_map', fileName: '05-mind-map', formats: ['md', 'txt', 'docx', 'pdf', 'svg'] },
  ];
  const files = {
    'README.txt': Buffer.from([
      `${record.title || '录音记录'} 导出包`,
      '',
      '01-full-record：完整记录',
      '02-summary：总结',
      '03-transcript：逐字稿',
      '04-overview-card：总结卡片',
      '05-mind-map：思维导图',
      '',
      '说明：DOCX/PDF 便于归档，Markdown/TXT 便于继续编辑，SVG 可作为可缩放图片打开或插入文档。',
    ].join('\n')),
  };

  for (const item of bundleTargets) {
    const markdown = buildExportText(record, store, item.target, true);
    for (const format of item.formats) {
      if (format === 'md') files[`${item.fileName}.md`] = Buffer.from(markdown);
      if (format === 'txt') files[`${item.fileName}.txt`] = Buffer.from(stripMarkdown(markdown));
      if (format === 'docx') files[`${item.fileName}.docx`] = item.target === 'summary'
        ? createSummaryDocxBuffer(record, store, markdown)
        : createDocxBuffer(record.title, stripMarkdown(markdown));
      if (format === 'pdf') files[`${item.fileName}.pdf`] = item.target === 'summary'
        ? createSummaryPdfBuffer(record, store, markdown)
        : createPdfBuffer(record.title, markdown);
      if (format === 'svg') files[`${item.fileName}.svg`] = Buffer.from(buildExportSvg(record, store, item.target));
    }
  }

  return zipStore(files);
}

function createSummaryDocxBuffer(record, store, markdown) {
  const visuals = summaryVisualAssets(record, store);
  return createDocxBuffer(record.title, stripMarkdown(markdown), visuals.map((asset) => ({
    fileName: asset.fileName,
    title: asset.title,
    data: asset.svg,
    width: asset.width,
    height: asset.height,
  })));
}

function createSummaryPdfBuffer(record, store, markdown) {
  const summary = store.table('summaries').find((item) => item.audio_record_id === record.id);
  const html = buildSummaryExportHtml(record, store);
  try {
    return writeHtmlPdf(html);
  } catch {
    return createPdfBuffer(record.title, summaryPdfFallbackText(summary, markdown));
  }
}

function summaryPdfFallbackText(summary, markdown) {
  return [
    '总结卡片',
    renderOverviewCard(summary?.overview_card_json, false),
    '',
    '文字重点总结',
    stripMarkdown(summary?.summary_markdown || markdown || '暂无总结'),
    '',
    '思维导图',
    renderMindMap(summary?.mind_map_json, false),
    '',
    '提示：当前运行环境未能使用 Chrome 生成视觉化 PDF，已自动生成文字版备份。',
  ].join('\n');
}

function buildSummaryExportHtml(record, store) {
  const summary = store.table('summaries').find((item) => item.audio_record_id === record.id) || {};
  const followup = store.table('followup_forms').find((item) => item.audio_record_id === record.id);
  const owner = store.findById('employees', record.owner_employee_id)?.display_name || '';
  const department = record.owner_department_id ? store.findById('departments', record.owner_department_id)?.name || '' : '';
  const source = record.source_page_title || record.source_type || '录音';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <title>${escapeHtml(record.title || '录音总结')}</title>
  <style>
    *{box-sizing:border-box}body{margin:0;padding:32px;font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#10232d;background:#f6fafb;letter-spacing:0}.page{max-width:920px;margin:0 auto;display:grid;gap:22px}.cover,.section{background:#fff;border:1px solid #d9e7eb;border-radius:10px;padding:22px;break-inside:avoid}.cover{background:linear-gradient(135deg,#e9f7f6,#eef6ff)}h1,h2,h3,p{margin-top:0}h1{font-size:30px;margin-bottom:12px}h2{font-size:20px;margin-bottom:14px}.meta-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.meta-grid div{padding:10px;border-radius:8px;background:rgba(255,255,255,.72)}.meta-grid span{display:block;color:#62727c;font-size:12px}.meta-grid strong{font-size:15px}.card-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.summary-card{padding:14px;border:1px solid #d7e5e9;border-radius:10px;background:#fbfefd}.summary-card.feature{grid-column:1/-1}.summary-card h3{font-size:17px;margin-bottom:8px}.summary-card ul,.markdown ul{padding-left:20px}.summary-card li,.markdown li{margin:5px 0}.markdown{line-height:1.72}.markdown h1{font-size:23px}.markdown h2{font-size:18px;border-bottom:1px solid #d9e7eb;padding-bottom:6px}.mind-map{display:grid;gap:14px}.mind-map-center{padding:18px;border-radius:14px;background:#e9f7f6;border:1px solid #b7d8d5;text-align:center}.mind-map-center small{display:block;color:#62727c;margin-bottom:4px}.mind-map-center strong{font-size:20px}.mind-map-branches{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px}.mind-map-branch{padding:14px;border:1px solid #d7e5e9;border-radius:10px;background:#fff}.mind-map-branch h3{font-size:16px;margin-bottom:6px}.mind-map-branch p{color:#45616c}.mind-map-branch li{margin:6px 0}.followup{background:#fffaf0}@media print{body{background:#fff;padding:0}.page{max-width:none}.cover,.section{box-shadow:none;break-inside:avoid}.section{page-break-inside:avoid}}
  </style>
</head>
<body>
  <main class="page">
    <section class="cover">
      <h1>${escapeHtml(record.title || record.original_file_name || '录音总结')}</h1>
      <div class="meta-grid">
        <div><span>员工</span><strong>${escapeHtml(owner || '未记录')}</strong></div>
        <div><span>部门</span><strong>${escapeHtml(department || '未分配')}</strong></div>
        <div><span>创建时间</span><strong>${escapeHtml(record.created_at || '')}</strong></div>
        <div><span>来源</span><strong>${escapeHtml(source)}</strong></div>
      </div>
    </section>
    <section class="section" data-section="overview-card">
      <h2>总结卡片</h2>
      ${renderOverviewCardHtml(summary.overview_card_json)}
    </section>
    <section class="section markdown" data-section="summary-markdown">
      <h2>文字纪要</h2>
      ${markdownToHtml(summary.summary_markdown || '暂无总结')}
    </section>
    <section class="section" data-section="mind-map">
      <h2>思维导图</h2>
      ${renderMindMapHtml(summary.mind_map_json, record.title)}
    </section>
    ${shouldExportFollowup(record, followup) ? `<section class="section followup" data-section="followup"><h2>跟单信息/备注</h2>${markdownToHtml(followup.followup_markdown || '暂无跟单信息')}</section>` : ''}
  </main>
</body>
</html>`;
}

function renderOverviewCardHtml(card) {
  if (!card || typeof card !== 'object' || !Object.keys(card).length) return '<p>暂无总结卡片</p>';
  const cards = Array.isArray(card.cards) && card.cards.length
    ? card.cards
    : Object.entries(card.keyFields || {}).map(([title, value]) => ({ title, items: [String(value || '待核对')] }));
  return [
    card.heroTitle || card.title ? `<h3>${escapeHtml(card.heroTitle || card.title)}</h3>` : '',
    card.heroSubtitle ? `<p>${escapeHtml(card.heroSubtitle)}</p>` : '',
    `<div class="card-grid">${cards.map((item, index) => `
      <article class="summary-card ${index === 0 ? 'feature' : ''}">
        <h3>${escapeHtml(item.title || `重点 ${index + 1}`)}</h3>
        ${renderOverviewCardItemsHtml(item)}
      </article>
    `).join('')}</div>`,
  ].join('');
}

function renderOverviewCardItemsHtml(item) {
  const lines = [];
  for (const value of item.items || []) lines.push(String(value || '').trim());
  for (const block of item.blocks || []) {
    if (block.title) lines.push(block.title);
    for (const value of block.items || []) lines.push(String(value || '').trim());
    for (const row of block.rows || []) lines.push(`${row.label || ''}：${row.value || '待核对'}${row.note ? `（${row.note}）` : ''}`);
    if (block.note) lines.push(block.note);
  }
  const filtered = lines.filter(Boolean).slice(0, 10);
  return filtered.length ? `<ul>${filtered.map((line) => `<li>${escapeHtml(line)}</li>`).join('')}</ul>` : '<p>待核对</p>';
}

function renderMindMapHtml(rawMindMap, fallbackTitle = '') {
  const mindMap = normalizeMindMap(rawMindMap, fallbackTitle);
  if (!mindMap) return '<p>暂无思维导图</p>';
  return `
    <div class="mind-map">
      <h3>${escapeHtml(mindMap.title || '录音思维导图')}</h3>
      <div class="mind-map-center"><small>中心主题</small><strong>${escapeHtml(mindMap.center || fallbackTitle || '录音总结')}</strong></div>
      <div class="mind-map-branches">
        ${mindMap.branches.map((branch, index) => `
          <article class="mind-map-branch">
            <h3>${String(index + 1).padStart(2, '0')} ${escapeHtml(branch.title || '重点分支')}</h3>
            ${branch.summary ? `<p>${escapeHtml(branch.summary)}</p>` : ''}
            ${branch.children?.length ? `<ul>${branch.children.map((child) => `<li><strong>${escapeHtml(child.title || '要点')}</strong>${child.detail ? `：${escapeHtml(child.detail)}` : ''}${child.items?.length ? `<br>${escapeHtml(child.items.join('；'))}` : ''}</li>`).join('')}</ul>` : ''}
          </article>
        `).join('')}
      </div>
    </div>
  `;
}

function markdownToHtml(markdown) {
  const lines = String(markdown || '').split(/\r?\n/);
  const html = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      html.push('</ul>');
      inList = false;
    }
  };
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line) {
      closeList();
      continue;
    }
    const headingMatch = line.match(/^(#{1,4})\s+(.+)$/);
    if (headingMatch) {
      closeList();
      html.push(`<h${Math.min(headingMatch[1].length + 1, 4)}>${escapeHtml(headingMatch[2])}</h${Math.min(headingMatch[1].length + 1, 4)}>`);
      continue;
    }
    const listMatch = line.match(/^[-*]\s+(.+)$/);
    if (listMatch) {
      if (!inList) {
        html.push('<ul>');
        inList = true;
      }
      html.push(`<li>${escapeHtml(listMatch[1])}</li>`);
      continue;
    }
    closeList();
    html.push(`<p>${escapeHtml(line.replace(/^>\s*/, ''))}</p>`);
  }
  closeList();
  return html.join('\n') || '<p>暂无内容</p>';
}

function writeHtmlPdf(html) {
  if (!fs.existsSync(CHROME_PATH)) throw new Error('本机 Chrome 不可用');
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-summary-pdf-'));
  const htmlPath = path.join(tempDir, 'summary.html');
  const pdfPath = path.join(tempDir, 'summary.pdf');
  try {
    fs.writeFileSync(htmlPath, html);
    childProcess.execFileSync(CHROME_PATH, [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--run-all-compositor-stages-before-draw',
      `--print-to-pdf=${pdfPath}`,
      `file://${htmlPath}`,
    ], { timeout: 30000, stdio: 'ignore' });
    if (!fs.existsSync(pdfPath)) throw new Error('Chrome 未生成 PDF');
    return fs.readFileSync(pdfPath);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

function summaryVisualAssets(record, store) {
  return [
    {
      fileName: 'summary-card.svg',
      title: '总结卡片',
      svg: Buffer.from(buildExportSvg(record, store, 'overview_card')),
      width: 5486400,
      height: 3200400,
    },
    {
      fileName: 'mind-map.svg',
      title: '思维导图',
      svg: Buffer.from(buildExportSvg(record, store, 'mind_map')),
      width: 5486400,
      height: 3657600,
    },
  ];
}

function renderOverviewCard(card, markdown) {
  if (!card || typeof card !== 'object' || !Object.keys(card).length) return '暂无总结卡片';
  const lines = [];
  const title = card.heroTitle || card.title;
  if (title) lines.push(markdown ? `### ${title}` : `【${title}】`);
  if (card.heroSubtitle) lines.push(card.heroSubtitle);
  const cards = Array.isArray(card.cards) ? card.cards : Object.entries(card.keyFields || {}).map(([key, value]) => ({
    title: key,
    items: [String(value || '待核对')],
  }));
  for (const item of cards) {
    if (item.title) lines.push(markdown ? `- **${item.title}**` : `· ${item.title}`);
    for (const value of item.items || []) lines.push(markdown ? `  - ${value}` : `  · ${value}`);
    for (const block of item.blocks || []) {
      if (block.title) lines.push(markdown ? `  - ${block.title}` : `  · ${block.title}`);
      for (const value of block.items || []) lines.push(markdown ? `    - ${value}` : `    · ${value}`);
      for (const row of block.rows || []) lines.push(markdown ? `    - ${row.label}：${row.value}${row.note ? `（${row.note}）` : ''}` : `    · ${row.label}：${row.value}${row.note ? `（${row.note}）` : ''}`);
      if (block.note) lines.push(markdown ? `    - ${block.note}` : `    · ${block.note}`);
    }
  }
  return lines.length ? lines.join('\n') : '暂无总结卡片';
}

function renderMindMap(mindMap, markdown) {
  mindMap = normalizeMindMap(mindMap);
  if (!mindMap || !Array.isArray(mindMap.branches) || !mindMap.branches.length) return '暂无思维导图';
  const lines = [];
  if (mindMap.title) lines.push(markdown ? `### ${mindMap.title}` : `【${mindMap.title}】`);
  if (mindMap.center) lines.push(markdown ? `- **中心主题**：${mindMap.center}` : `· 中心主题：${mindMap.center}`);
  for (const branch of mindMap.branches) {
    lines.push(markdown ? `- **${branch.title || '分支'}**${branch.summary ? `：${branch.summary}` : ''}` : `· ${branch.title || '分支'}${branch.summary ? `：${branch.summary}` : ''}`);
    for (const child of branch.children || []) {
      lines.push(markdown ? `  - ${child.title || '要点'}${child.detail ? `：${child.detail}` : ''}` : `  · ${child.title || '要点'}${child.detail ? `：${child.detail}` : ''}`);
      for (const item of child.items || []) lines.push(markdown ? `    - ${item}` : `    · ${item}`);
    }
  }
  return lines.join('\n');
}

function renderTranscript(transcript, markdown) {
  if (!transcript) return '暂无逐字稿';
  const segments = Array.isArray(transcript.segments_json) ? transcript.segments_json : [];
  const aliases = transcript.speaker_aliases_json && typeof transcript.speaker_aliases_json === 'object'
    ? transcript.speaker_aliases_json
    : {};
  const lines = segments
    .map((segment, index) => {
      const text = String(segment.text || '').trim();
      if (!text) return '';
      const speaker = String(segment.speaker || segment.speakerAlias || '录音').trim();
      const speakerLabel = aliases[speaker] || speaker;
      const time = formatTimestamp(Number(segment.startMs ?? segment.beginMs ?? segment.begin_time ?? 0));
      if (markdown) return `- [${time || '--:--'}] **${speakerLabel}**：${text}`;
      return `${time || '--:--'} ${speakerLabel}：${text}`;
    })
    .filter(Boolean);
  if (lines.length) return lines.join('\n');
  return transcript.corrected_text || transcript.raw_text || '暂无逐字稿';
}

function renderOverviewCardSvg(record, card) {
  const safeCard = card && typeof card === 'object' ? card : {};
  const title = safeCard.heroTitle || safeCard.title || record.title || '录音总结卡片';
  const subtitle = safeCard.heroSubtitle || safeCard.badge || '内容由 AI 生成';
  const cards = Array.isArray(safeCard.cards) && safeCard.cards.length
    ? safeCard.cards
    : Object.entries(safeCard.keyFields || {}).map(([key, value]) => ({ title: key, items: [String(value || '待核对')] }));
  const visibleCards = cards.slice(0, 8);
  const cardHeight = 150;
  const height = 240 + Math.max(1, Math.ceil(visibleCards.length / 2)) * (cardHeight + 24);
  const nodes = [
    `<rect width="1200" height="${height}" rx="18" fill="#f6fbfc"/>`,
    `<rect x="28" y="28" width="1144" height="164" rx="16" fill="#e9f7f6" stroke="#b7d8d5"/>`,
    `<text x="58" y="76" fill="#0f766e" font-size="24" font-weight="700">${escapeXml(subtitle)}</text>`,
    ...svgTextLines(title, 58, 124, 50, 21, '#122934', 20),
  ];
  visibleCards.forEach((item, index) => {
    const col = index % 2;
    const row = Math.floor(index / 2);
    const x = 28 + col * 586;
    const y = 218 + row * (cardHeight + 24);
    nodes.push(...renderSvgCard(item, index, x, y, 558, cardHeight));
  });
  return svgDocument(1200, height, nodes);
}

function renderSvgCard(item, index, x, y, width, height) {
  const title = item.title || `重点 ${index + 1}`;
  const items = (item.items || []).slice(0, 4);
  const nodes = [
    `<rect x="${x}" y="${y}" width="${width}" height="${height}" rx="14" fill="${svgToneFill(item.tone)}" stroke="#c7dadd"/>`,
    `<circle cx="${x + 36}" cy="${y + 38}" r="16" fill="#ffffff" stroke="#8fcac4"/>`,
    `<text x="${x + 36}" y="${y + 44}" text-anchor="middle" fill="#0f766e" font-size="17" font-weight="700">${index + 1}</text>`,
    ...svgTextLines(title, x + 64, y + 46, 24, 17, '#122934', 18),
  ];
  let lineY = y + 82;
  items.forEach((value) => {
    nodes.push(`<circle cx="${x + 43}" cy="${lineY - 5}" r="4" fill="#0f766e"/>`);
    nodes.push(...svgTextLines(String(value), x + 58, lineY, 44, 13, '#2a4650', 16));
    lineY += 32;
  });
  return nodes;
}

function renderMindMapSvg(record, mindMap) {
  const safeMap = normalizeMindMap(mindMap, record.title) || {};
  const branches = Array.isArray(safeMap.branches) && safeMap.branches.length ? safeMap.branches.slice(0, 6) : [];
  const branchHeight = 132;
  const height = 180 + Math.max(1, branches.length) * branchHeight;
  const centerY = Math.round(height / 2);
  const nodes = [
    `<rect width="1400" height="${height}" rx="18" fill="#fbfefd"/>`,
    `<text x="40" y="30" fill="#122934" font-size="24" font-weight="700">${escapeXml(safeMap.title || record.title || '思维导图总结')}</text>`,
    `<rect x="40" y="40" width="260" height="${height - 80}" rx="16" fill="#e9f7f6" stroke="#b7d8d5"/>`,
    `<text x="76" y="${centerY - 18}" fill="#647985" font-size="20" font-weight="700">中心主题</text>`,
    ...svgTextLines(safeMap.center || safeMap.title || record.title || '录音总结', 76, centerY + 24, 13, 26, '#122934', 25),
  ];
  branches.forEach((branch, index) => {
    const y = 82 + index * branchHeight;
    const tone = svgToneStroke(branch.tone);
    nodes.push(`<path d="M 300 ${centerY} C 410 ${centerY}, 410 ${y + 44}, 520 ${y + 44}" fill="none" stroke="${tone}" stroke-width="3" stroke-linecap="round"/>`);
    nodes.push(`<rect x="520" y="${y}" width="820" height="104" rx="14" fill="${svgToneFill(branch.tone)}" stroke="#c7dadd"/>`);
    nodes.push(`<circle cx="556" cy="${y + 42}" r="16" fill="#ffffff" stroke="${tone}"/>`);
    nodes.push(`<text x="556" y="${y + 48}" text-anchor="middle" fill="#0f766e" font-size="15" font-weight="700">${String(index + 1).padStart(2, '0')}</text>`);
    nodes.push(...svgTextLines(branch.title || '重点分支', 584, y + 36, 26, 18, '#122934', 18));
    nodes.push(...svgTextLines(branch.summary || firstMindMapDetail(branch), 584, y + 68, 64, 13, '#2a4650', 16).slice(0, 2));
  });
  return svgDocument(1400, height, nodes);
}

function firstMindMapDetail(branch) {
  const firstChild = Array.isArray(branch.children) ? branch.children[0] : null;
  if (!firstChild) return '';
  return firstChild.detail || firstChild.title || (Array.isArray(firstChild.items) ? firstChild.items[0] : '') || '';
}

function svgTextLines(value, x, y, maxChars, fontSize, fill, lineHeight) {
  return wrapLine(String(value || ''), maxChars).slice(0, 3).map((line, index) =>
    `<text x="${x}" y="${y + index * lineHeight}" fill="${fill}" font-size="${fontSize}" font-weight="${index === 0 ? 700 : 500}">${escapeXml(line)}</text>`
  );
}

function svgDocument(width, height, nodes) {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<style>text{font-family:-apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;letter-spacing:0}</style>`,
    ...nodes,
    `</svg>`,
  ].join('\n');
}

function svgToneFill(tone = '') {
  return ({
    blue: '#eef6ff',
    cyan: '#eafafa',
    green: '#edf9f1',
    orange: '#fff5e8',
    warm: '#fff7df',
    purple: '#f6f0ff',
    neutral: '#f5f7f9',
  })[tone] || '#ffffff';
}

function svgToneStroke(tone = '') {
  return ({
    blue: '#6fa6d8',
    cyan: '#63c4cb',
    green: '#82bf77',
    orange: '#d99c51',
    warm: '#d8b77a',
    purple: '#b194d8',
    neutral: '#92aab1',
  })[tone] || '#8fcac4';
}

function formatTimestamp(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '';
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const base = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return hours ? `${String(hours).padStart(2, '0')}:${base}` : base;
}

function shouldExportFollowup(record, followup) {
  if (!followup) return false;
  const type = record.followup_type || followupTypeForTemplate(record.template_type);
  return type !== 'none';
}

function followupTypeForTemplate(templateType) {
  if (templateType === 'matchmaker_profile') return 'matchmaker';
  if (templateType === 'recruitment_followup') return 'recruitment';
  if (templateType === 'customer_follow_up') return 'general_customer';
  return 'none';
}

function titleLine(title, markdown) {
  return markdown ? `# ${title}` : title;
}

function heading(title, markdown) {
  return markdown ? `## ${title}` : `【${title}】`;
}

function stripMarkdown(markdown) {
  return markdown
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^- /gm, '· ');
}

function createDocxBuffer(title, text, images = []) {
  const relationshipXml = images.length
    ? `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${images.map((image, index) => `<Relationship Id="rIdImage${index + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${escapeXml(image.fileName)}"/>`).join('')}</Relationships>`
    : '';
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>` +
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">` +
    `<w:body>${paragraph(title, true)}${images.map((image, index) => `${paragraph(image.title, true)}${imageParagraph(image, index)}`).join('')}${text.split(/\n+/).map((line) => paragraph(line)).join('')}` +
    `<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>` +
    `</w:body></w:document>`;
  const files = {
    '[Content_Types].xml': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="svg" ContentType="image/svg+xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
    '_rels/.rels': `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
    'word/document.xml': documentXml,
  };
  if (relationshipXml) files['word/_rels/document.xml.rels'] = relationshipXml;
  images.forEach((image) => {
    files[`word/media/${image.fileName}`] = image.data;
  });
  return zipStore(files);
}

function imageParagraph(image, index) {
  const embedId = `rIdImage${index + 1}`;
  const docPrId = index + 2;
  const cx = image.width || 5486400;
  const cy = image.height || 3200400;
  return `<w:p><w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${docPrId}" name="${escapeXml(image.title || image.fileName)}"/><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic><pic:nvPicPr><pic:cNvPr id="${docPrId}" name="${escapeXml(image.fileName)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${embedId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

function paragraph(text, bold = false) {
  const value = escapeXml(text || ' ');
  const runProps = bold ? '<w:rPr><w:b/></w:rPr>' : '';
  return `<w:p><w:r>${runProps}<w:t xml:space="preserve">${value}</w:t></w:r></w:p>`;
}

function createPdfBuffer(title, text) {
  const lines = [title, '', ...stripMarkdown(text).split(/\n+/)].flatMap((line) => wrapLine(line, 32));
  const pages = [];
  for (let index = 0; index < lines.length; index += 34) pages.push(lines.slice(index, index + 34));
  const objects = [];
  const add = (body) => {
    objects.push(body);
    return objects.length;
  };
  const fontId = add('<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [ << /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> >> ] >>');
  const pageIds = [];
  for (const pageLines of pages.length ? pages : [[]]) {
    const content = [
      'BT',
      `/F1 11 Tf`,
      '48 790 Td',
      ...pageLines.map((line, index) => `${index ? '0 -21 Td ' : ''}<${utf16beHex(line || ' ')}> Tj`),
      'ET',
    ].join('\n');
    const contentId = add(`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`);
    const pageId = add(`<< /Type /Page /Parent 0 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    pageIds.push(pageId);
  }
  const pagesId = add(`<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] /Count ${pageIds.length} >>`);
  pageIds.forEach((pageId) => {
    objects[pageId - 1] = objects[pageId - 1].replace('/Parent 0 0 R', `/Parent ${pagesId} 0 R`);
  });
  const catalogId = add(`<< /Type /Catalog /Pages ${pagesId} 0 R >>`);
  return buildPdf(objects, catalogId);
}

function wrapLine(line, max) {
  const text = String(line || '');
  if (text.length <= max) return [text];
  const output = [];
  for (let index = 0; index < text.length; index += max) output.push(text.slice(index, index + max));
  return output;
}

function buildPdf(objects, catalogId) {
  const chunks = ['%PDF-1.4\n'];
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(chunks.join('')));
    chunks.push(`${index + 1} 0 obj\n${object}\nendobj\n`);
  });
  const xrefOffset = Buffer.byteLength(chunks.join(''));
  chunks.push(`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`);
  for (let index = 1; index <= objects.length; index += 1) {
    chunks.push(`${String(offsets[index]).padStart(10, '0')} 00000 n \n`);
  }
  chunks.push(`trailer\n<< /Size ${objects.length + 1} /Root ${catalogId} 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`);
  return Buffer.from(chunks.join(''));
}

function zipStore(files) {
  const localParts = [];
  const centralParts = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const nameBuffer = Buffer.from(name);
    const data = Buffer.from(content);
    const crc = crc32(data);
    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(0, 8);
    localHeader.writeUInt32LE(0, 10);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(data.length, 18);
    localHeader.writeUInt32LE(data.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);
    localParts.push(localHeader, nameBuffer, data);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(0, 10);
    centralHeader.writeUInt32LE(0, 12);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(data.length, 20);
    centralHeader.writeUInt32LE(data.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    centralParts.push(centralHeader, nameBuffer);
    offset += localHeader.length + nameBuffer.length + data.length;
  }
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...localParts, ...centralParts, end]);
}

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let index = 0; index < 8; index += 1) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function utf16beHex(value) {
  const utf16le = Buffer.from(String(value).replace(/[()\\]/g, ''), 'utf16le');
  for (let index = 0; index < utf16le.length; index += 2) {
    const left = utf16le[index];
    utf16le[index] = utf16le[index + 1];
    utf16le[index + 1] = left;
  }
  return utf16le.toString('hex');
}

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function escapeHtml(value) {
  return escapeXml(value).replace(/'/g, '&#039;');
}

function hashContent(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

module.exports = {
  buildSummaryExportHtml,
  buildExportBundle,
  buildExportSvg,
  buildExportText,
  createDocxBuffer,
  createPdfBuffer,
  createSummaryDocxBuffer,
  createSummaryPdfBuffer,
  hashContent,
  markdownToHtml,
  renderMindMapHtml,
  renderOverviewCardHtml,
  stripMarkdown,
};
