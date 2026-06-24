const app = document.getElementById('shareApp');

initSharePage();

async function initSharePage() {
  const token = decodeURIComponent(location.pathname.split('/s/')[1] || '');
  if (!token) {
    renderError('分享链接不完整。');
    return;
  }
  try {
    const response = await fetch(`/api/shared/${encodeURIComponent(token)}`, { cache: 'no-store' });
    const text = await response.text();
    const body = text ? JSON.parse(text) : {};
    if (!response.ok) throw new Error(body.error || `分享链接无法访问：${response.status}`);
    renderShare(body);
  } catch (error) {
    renderError(error.message || String(error));
  }
}

function renderShare(data) {
  const includes = data.includes || {};
  app.innerHTML = `
    <section class="share-card">
      <p class="eyebrow">大宜宾录音助手</p>
      <h1>${escapeHtml(data.title || '录音分享')}</h1>
      <div class="meta-row">
        ${includes.audio ? '<span class="badge">录音</span>' : ''}
        ${includes.transcript ? '<span class="badge">逐字稿</span>' : ''}
        ${includes.summary ? '<span class="badge">总结</span>' : ''}
      </div>
      <p class="meta">有效期至 ${escapeHtml(formatDate(data.expiresAt))}</p>
    </section>
    ${data.audio ? renderAudio(data.audio) : ''}
    ${data.summary ? renderSummary(data.summary) : ''}
    ${data.transcript ? renderTranscript(data.transcript) : ''}
  `;
}

function renderAudio(audio) {
  return `
    <section class="content-section">
      <h2>录音</h2>
      <audio controls preload="metadata" src="${escapeHtml(audio.url || '')}"></audio>
      <p class="meta">${audio.durationSeconds ? `约 ${Math.round(audio.durationSeconds / 60)} 分钟` : ''}${audio.fileSize ? ` · ${formatBytes(audio.fileSize)}` : ''}</p>
    </section>
  `;
}

function renderSummary(summary) {
  const text = summary.markdown || overviewText(summary.overviewCard) || '';
  if (!text) return '';
  return `
    <section class="content-section">
      <h2>总结</h2>
      <div class="markdown">${escapeHtml(text)}</div>
    </section>
  `;
}

function renderTranscript(transcript) {
  const segments = Array.isArray(transcript.segments) ? transcript.segments : [];
  return `
    <section class="content-section">
      <h2>逐字稿</h2>
      ${segments.length ? segments.map(renderSegment).join('') : `<div class="transcript-text">${escapeHtml(transcript.text || '暂无逐字稿')}</div>`}
    </section>
  `;
}

function renderSegment(segment) {
  return `
    <article class="segment">
      <div class="time">${escapeHtml(formatTimestamp(Number(segment.startMs || segment.start_ms || 0)))}</div>
      <div>
        ${segment.speaker ? `<div class="meta">${escapeHtml(segment.speaker)}</div>` : ''}
        <div class="segment-text">${escapeHtml(segment.text || '')}</div>
      </div>
    </article>
  `;
}

function renderError(message) {
  app.innerHTML = `
    <section class="share-card error">
      <p class="eyebrow">分享链接不可用</p>
      <h1>无法打开</h1>
      <p>${escapeHtml(message || '分享链接已失效，请联系分享人重新生成。')}</p>
    </section>
  `;
}

function overviewText(card = {}) {
  const parts = [];
  if (card.heroTitle) parts.push(card.heroTitle);
  if (card.heroSubtitle) parts.push(card.heroSubtitle);
  if (Array.isArray(card.cards)) {
    for (const item of card.cards) {
      if (item.title) parts.push(item.title);
      if (Array.isArray(item.items)) parts.push(...item.items);
    }
  }
  return parts.filter(Boolean).join('\n');
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function formatTimestamp(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '00:00';
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const base = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return hours ? `${String(hours).padStart(2, '0')}:${base}` : base;
}

function formatBytes(size) {
  const value = Number(size || 0);
  if (!value) return '';
  if (value < 1024 * 1024) return `${Math.round(value / 1024)} KB`;
  return `${(value / 1024 / 1024).toFixed(1)} MB`;
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}
