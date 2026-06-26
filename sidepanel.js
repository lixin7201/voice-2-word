const chromeApi = typeof chrome === 'undefined' ? null : chrome;
const IS_HOSTED_PAGE = typeof window !== 'undefined' && ['http:', 'https:'].includes(window.location.protocol);
const IS_EXTENSION_SURFACE = Boolean(chromeApi?.runtime?.id);
const DEFAULT_API_BASE_URL = IS_HOSTED_PAGE ? window.location.origin : 'http://lixindemac-studio.local:8127';
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;
const TASK_START_REQUEST_TIMEOUT_MS = 60000;
const UPLOAD_REQUEST_TIMEOUT_MS = 10 * 60 * 1000;
const CANDIDATE_READ_TIMEOUT_MS = 2 * 60 * 1000;
const TRANSCRIPT_RENDER_BATCH = 80;
const MAX_AUDIO_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const RECOMMENDED_AUDIO_SECONDS = 2 * 60 * 60;
const MAX_AUDIO_SECONDS = 12 * 60 * 60;
const STORAGE_KEYS = ['apiBaseUrl', 'accessToken', 'currentUser', 'preferredTemplateType', 'preferredFollowupType', 'clientErrors'];
const MEETING_TEMPLATE_VALUES = new Set(['meeting_minutes', 'meeting_comprehensive_expert', 'meeting_secretary', 'smart_summary', 'phone_discussion']);

const appState = {
  apiBaseUrl: DEFAULT_API_BASE_URL,
  accessToken: '',
  currentUser: null,
  permissions: {},
  templates: [],
  followupOptions: [],
  defaultTemplate: 'meeting_minutes',
  defaultFollowupType: 'none',
  preferredTemplateType: '',
  preferredFollowupType: '',
  view: 'loading',
  status: '',
  statusType: '',
  records: [],
  selectedRecordIds: {},
  historyFilter: 'all',
  historyQuery: '',
  historyGroupBy: 'auto',
  historyExpandedGroups: {},
  detail: null,
  detailTab: 'summary',
  collapsedPanels: {},
  transcriptQuery: '',
  transcriptVisibleCount: TRANSCRIPT_RENDER_BATCH,
  activeSegmentId: '',
  mindMapExpanded: false,
  exportNotice: '',
  audioError: '',
  speakerEditing: null,
  candidates: [],
  departments: [],
  employees: [],
  profile: null,
  profileDraft: null,
  passwordDraft: null,
  settingGroups: [],
  systemStatus: null,
  settingsMeta: null,
  llmProviders: [],
  llmProviderPresets: [],
  llmProviderDraft: null,
  auditLogs: [],
  secretActions: {},
  settingChoices: {},
  processingChoices: {},
  runtime: null,
  extensionUpdate: null,
  titleEditing: false,
  titleDraft: null,
  scanActive: false,
  scanStartedAt: '',
  backgroundCandidateNotice: '',
  sharePanelOpen: false,
  shareLinks: [],
  shareStatus: '',
  shareStatusType: '',
  loginNameDraft: '',
  busy: false,
  activeAction: '',
  actionStates: {},
  candidateJobs: {},
  candidateTitleDrafts: {},
  uploadDraft: {
    title: '',
    notice: '',
    fileName: '',
    fileSize: 0,
    status: '',
    statusType: '',
  },
  profileUi: {
    avatarFileName: '',
    avatarFileSize: 0,
    avatarStatus: '待选择头像文件',
    avatarStatusType: '',
    profileStatus: '',
    profileStatusType: '',
    passwordStatus: '',
    passwordStatusType: '',
  },
  clientErrors: [],
  extensionDiagnostics: null,
};

const app = document.getElementById('app');
let scheduledRender = 0;
let detailPollTimer = 0;
let recordsPollTimer = 0;
let scanEmptyTimer = 0;
let clientErrorHandlersInstalled = false;
const candidateDuplicateRequests = new Set();

installClientErrorHandlers();
document.addEventListener('DOMContentLoaded', init);

async function init() {
  const stored = await storageGet(STORAGE_KEYS);
  appState.apiBaseUrl = stored.apiBaseUrl || DEFAULT_API_BASE_URL;
  appState.accessToken = stored.accessToken || '';
  appState.currentUser = stored.currentUser || null;
  appState.preferredTemplateType = stored.preferredTemplateType || '';
  appState.preferredFollowupType = stored.preferredFollowupType || '';
  appState.clientErrors = Array.isArray(stored.clientErrors) ? stored.clientErrors.slice(0, 20) : [];

  if (chromeApi?.runtime?.onMessage) {
    chromeApi.runtime.onMessage.addListener((request) => {
      if (request.type === 'STATE_UPDATE' && request.state) {
        handleBackgroundState(request.state);
      }
    });
  }

  if (appState.accessToken) {
    appState.view = 'home';
    render();
    try {
      await loadRuntimeSafe();
      await loadExtensionUpdateSafe();
      await loadMe();
      await loadDepartments();
      await loadRecords();
      appState.view = 'home';
    } catch {
      await logout(false);
      appState.view = 'login';
    }
  } else {
    appState.view = 'login';
  }
  render();
}

function render() {
  delete document.body.dataset.view;
  document.body.dataset.currentView = appState.view;
  if (appState.view === 'login' || appState.view === 'loading') {
    app.innerHTML = renderLogin();
    bindLogin();
    syncPolling();
    return;
  }

  app.innerHTML = [
    renderTopbar(),
    renderNav(),
    `<main class="main-panel">${renderClientErrorPanel()}${renderExtensionUpdateNotice()}${renderStatus()}${renderCurrentView()}</main>`,
  ].join('');
  bindCommon();
  bindCurrentView();
  syncPolling();
}

function scheduleRender() {
  if (scheduledRender) return;
  const frame = typeof window !== 'undefined' && window.requestAnimationFrame
    ? window.requestAnimationFrame
    : (callback) => window.setTimeout(callback, 16);
  scheduledRender = frame(() => {
    scheduledRender = 0;
    render();
  });
}

function renderLogin() {
  const intro = IS_HOSTED_PAGE ? `
    <section class="login-intro">
      <div class="brand-mark" aria-hidden="true">宜</div>
      <p class="login-eyebrow">本地后端工作台</p>
      <h1 class="login-heading">大宜宾录音助手</h1>
      <p class="login-summary">录音转文字、会议纪要、跟单信息一站完成</p>
      <dl class="login-proof">
        <div>
          <dt>服务地址</dt>
          <dd>${escapeHtml(DEFAULT_API_BASE_URL)}</dd>
        </div>
        <div>
          <dt>默认测试账号</dt>
          <dd>花名/工号「离心」，密码「dayibin」</dd>
        </div>
      </dl>
    </section>
  ` : '';
  return `
    <div class="${IS_HOSTED_PAGE ? 'login-view' : ''}">
      ${intro}
      <section class="glass section stack login-card">
        <div class="brand">
          <h1 class="brand-title">大宜宾录音助手</h1>
          <div class="brand-subtitle">录音转文字、总结、跟单记录</div>
        </div>
        ${renderStatus()}
        <form id="login-form" class="form">
          <details class="advanced-service">
            <summary>服务地址（一般不用改）</summary>
            <div class="field">
              <label for="apiBaseUrl">后端地址</label>
              <input id="apiBaseUrl" name="apiBaseUrl" value="${escapeHtml(appState.apiBaseUrl)}">
            </div>
          </details>
          <div class="grid-2">
            <div class="field">
              <label for="loginName">工号/花名</label>
              <input id="loginName" name="loginName" autocomplete="username" placeholder="离心" value="${escapeHtml(appState.loginNameDraft)}">
            </div>
            <div class="field">
              <label for="password">密码</label>
              <input id="password" name="password" type="password" autocomplete="current-password" placeholder="默认 dayibin">
            </div>
          </div>
          <button class="btn primary" type="submit" data-action="login-submit" ${appState.busy ? 'disabled' : ''}>登录</button>
        </form>
      </section>
    </div>
  `;
}

function renderTopbar() {
  const user = appState.currentUser;
  const departments = user?.departments?.map((item) => item.name).join(' / ') || '未分配部门';
  return `
    <header class="topbar glass">
      <div class="topbar-brand">
        <div class="brand-logo" aria-hidden="true">▮</div>
        <div class="brand">
          <h1 class="brand-title">大宜宾录音助手</h1>
          <div class="brand-subtitle">${escapeHtml(departments)}</div>
        </div>
      </div>
      <button class="btn ghost user-chip" type="button" data-view="profile" title="个人资料">
        ${renderAvatar(user)}
        <span>${escapeHtml(user?.displayName || '')}</span>
      </button>
    </header>
  `;
}

function renderNav() {
  const items = [
    ['home', '首页'],
    ['upload', '上传'],
    ['history', '历史'],
  ];
  if (IS_EXTENSION_SURFACE) items.splice(1, 0, ['capture', '监听']);
  if (appState.permissions.canManageEmployees) items.push(['employees', '员工']);
  if (appState.permissions.canManageSettings) items.push(['settings', '配置']);
  return `
    <nav class="nav">
      ${items.map(([view, label]) => `
        <button type="button" data-view="${view}" class="${appState.view === view ? 'active' : ''}">${label}</button>
      `).join('')}
    </nav>
  `;
}

function renderClientErrorPanel() {
  if (!appState.clientErrors.length) return '';
  const latest = appState.clientErrors[0];
  return `
    <section class="status error client-error-panel">
      <div class="item-title">
        <strong>插件前端异常</strong>
        <span class="meta">${escapeHtml(formatDate(latest.time))}</span>
      </div>
      <div>${escapeHtml(latest.message || '发生未知错误')}</div>
      <div class="meta">当前页面：${escapeHtml(latest.view || appState.view)} · 最近动作：${escapeHtml(latest.action || appState.activeAction || '无')}</div>
      <div class="btn-row">
        <button class="btn" type="button" data-action="copy-client-diagnostics">复制诊断</button>
        <button class="btn ghost" type="button" data-action="clear-client-errors">清除错误</button>
      </div>
    </section>
  `;
}

function renderStatus() {
  if (!appState.status) return '';
  return `<div class="status ${escapeHtml(appState.statusType)}">${escapeHtml(appState.status)}</div>`;
}

function renderExtensionUpdateNotice() {
  const update = appState.extensionUpdate || {};
  if (!update.hasUpdate && !update.mustUpdate) return '';
  const type = update.mustUpdate ? 'error' : 'warning';
  const changelog = Array.isArray(update.changelog) ? update.changelog.slice(0, 3) : [];
  return `
    <section class="status ${type} extension-update">
      <div class="item-title">
        <strong>${update.mustUpdate ? '当前插件版本过旧' : `发现新版插件 ${escapeHtml(update.latestVersion || '')}`}</strong>
        <span class="meta">当前 ${escapeHtml(update.currentVersion || '')}</span>
      </div>
      ${changelog.length ? `<div class="meta">${changelog.map(escapeHtml).join(' · ')}</div>` : ''}
      <div class="btn-row">
        ${update.downloadUrl ? `<button class="btn primary" type="button" data-action="download-extension-update">下载新版插件包</button>` : '<span class="meta">请联系管理员获取新版插件包</span>'}
        <button class="btn" type="button" data-action="refresh-extension-update">重新检查</button>
      </div>
    </section>
  `;
}

function renderMustUpdatePanel() {
  return `
    <section class="glass section stack">
      <h2>请先更新插件</h2>
      <p class="hint">当前插件版本过旧，为避免上传或监听失败，请更新后继续使用。历史记录仍可查看。</p>
    </section>
  `;
}

function renderCurrentView() {
  if (isExtensionMustUpdate() && ['capture', 'upload'].includes(appState.view)) return renderMustUpdatePanel();
  if (appState.view === 'home') return renderHome();
  if (appState.view === 'capture') return renderCapture();
  if (appState.view === 'upload') return renderUpload();
  if (appState.view === 'history') return renderHistory();
  if (appState.view === 'detail') return renderDetail();
  if (appState.view === 'profile') return renderProfile();
  if (appState.view === 'employees') return renderEmployees();
  if (appState.view === 'settings') return renderSettings();
  return renderHome();
}

function renderHome() {
  const recent = appState.records.slice(0, 5);
  const completed = appState.records.filter((record) => record.status === 'completed').length;
  const failed = appState.records.filter((record) => record.status === 'failed').length;
  const latestCompleted = appState.records.find((record) => record.status === 'completed');
  return `
    <div class="stack">
      ${renderCaptureNotice()}
      <form id="upload-form" class="home-flow">
        ${renderUploadIntakeCard()}
        ${renderProcessingSettingsCard('upload', currentTemplateType(), currentFollowupType(), {
          actionLabel: '上传并生成纪要',
          action: 'upload-manual',
        })}
      </form>
      ${latestCompleted ? renderHomeResultCard(latestCompleted) : renderHomeEmptyResult(completed, failed)}
      ${recent.length ? `
        <section class="glass section compact-history">
          <div class="item-title">
            <h2>最近历史</h2>
            <button class="btn" type="button" data-view="history">全部</button>
          </div>
          ${renderRecordList(recent)}
        </section>
      ` : ''}
    </div>
  `;
}

function renderHomeEmptyResult(completed, failed) {
  return `
    <section class="glass section result-shell">
      <div class="result-tabs">
        <button class="active" type="button">转写结果</button>
        <button type="button" disabled>逐字稿</button>
        <button type="button" disabled>摘要</button>
        <button type="button" disabled>更多</button>
      </div>
      <div class="empty">暂无转写结果</div>
      <div class="stats compact-stats">
        <div class="stat"><strong>${appState.records.length}</strong><span class="meta">历史记录</span></div>
        <div class="stat"><strong>${completed}</strong><span class="meta">已完成</span></div>
        <div class="stat"><strong>${failed}</strong><span class="meta">失败任务</span></div>
      </div>
    </section>
  `;
}

function renderHomeResultCard(record) {
  return `
    <section class="glass section result-shell">
      <div class="result-tabs">
        <button class="active" type="button" data-action="open-record" data-id="${escapeHtml(record.id)}">转写结果</button>
        <button type="button" data-action="open-record" data-id="${escapeHtml(record.id)}">逐字稿</button>
        <button type="button" data-action="open-record" data-id="${escapeHtml(record.id)}">摘要</button>
        <button type="button" data-action="open-record" data-id="${escapeHtml(record.id)}">更多</button>
        <span class="result-actions">
          <button class="btn" type="button" data-action="open-record" data-id="${escapeHtml(record.id)}">打开</button>
          <button class="btn" type="button" data-action="open-record" data-id="${escapeHtml(record.id)}">导出</button>
        </span>
      </div>
      <div class="result-meta-row">
        <span class="badge">${escapeHtml(templateLabel(record.templateType))}</span>
        <span>创建时间：${formatDate(record.createdAt)}</span>
      </div>
      <div class="result-preview">
        <h2>${escapeHtml(record.title || record.originalFileName || '未命名录音')}</h2>
        <p>${escapeHtml(record.owner?.displayName || '')} · ${escapeHtml(record.department?.name || '未分配')} · ${escapeHtml(followupLabel(record.followupType || 'none'))}</p>
        <div class="btn-row">
          <button class="btn primary" type="button" data-action="open-record" data-id="${escapeHtml(record.id)}">查看结果</button>
          ${IS_EXTENSION_SURFACE ? '<button class="btn" type="button" data-view="capture">继续监听</button>' : ''}
        </div>
      </div>
    </section>
  `;
}

function renderCaptureNotice() {
  if (!appState.candidates.length || appState.view === 'capture') return '';
  const extraCount = Math.max(0, appState.candidates.length - 1);
  return `
    <section class="capture-notice">
      <div>
        <strong>已找到当前页录音</strong>
        <span>${escapeHtml(appState.backgroundCandidateNotice || (extraCount ? `其它 ${extraCount} 个低可信候选已折叠。` : '可以进入监听页开始识别。'))}</span>
      </div>
      <button class="btn primary" type="button" data-view="capture">去识别</button>
    </section>
  `;
}

function renderCapture() {
  const scanLabel = appState.scanActive ? '重新锁定当前录音' : '识别当前页录音';
  return `
    <div class="stack capture-page">
      <section class="glass section capture-upload-card">
        <div class="upload-mark" aria-hidden="true">↑</div>
        <div class="capture-upload-copy">
          <h2>识别当前页录音</h2>
          <div class="meta">在左侧网页打开录音并点播放，这里会自动锁定最可能的一条。</div>
        </div>
        <div class="capture-main-actions">
          <button class="btn primary" data-action="scan-page" ${appState.busy ? 'disabled' : ''}>${scanLabel}</button>
          <button class="btn" data-action="scan-page" data-reset="1" ${appState.busy ? 'disabled' : ''}>重新监听当前页</button>
          <button class="btn" data-view="upload">手动上传</button>
        </div>
      </section>
      ${renderCandidateList()}
      ${renderProcessingSettingsCard('capture', currentTemplateType(), currentFollowupType())}
      <div class="btn-row">
        <button class="btn ghost" data-view="history">查看历史</button>
        <button class="btn ghost" data-view="settings">修改默认设置</button>
      </div>
    </div>
  `;
}

function renderCandidateList() {
  if (!appState.candidates.length) {
    const waiting = appState.scanActive;
    const waitingMs = appState.scanStartedAt ? Date.now() - new Date(appState.scanStartedAt).getTime() : 0;
    const longWait = waiting && waitingMs >= 20 * 1000;
    return `
      <section class="glass section capture-guide">
        <strong>${longWait ? '还没有发现录音' : waiting ? '正在监听当前页' : '还没有锁定录音'}</strong>
        <span>${waiting ? '请回到录音网页点击播放，插件会在播放时捕获录音地址。' : '先在左侧网页打开要转写的那条录音，再点击播放。'}</span>
        ${longWait ? '<span>请确认当前打开的是录音详情页、网页里的播放按钮已经点过，录音正在播放或刚刚发起加载。</span>' : ''}
        <span>如果刷新过录音网页，请点“重新监听当前页”重新绑定当前页面。</span>
        <span>如果仍没有出现，可复制监听诊断发给管理员，或点“手动上传”选择下载好的文件。</span>
        <div class="btn-row">
          <button class="btn" type="button" data-action="copy-extension-diagnostics">复制监听诊断</button>
        </div>
      </section>
    `;
  }
  const primaryIndex = primaryCandidateIndex();
  const primary = appState.candidates[primaryIndex];
  const extras = appState.candidates
    .map((candidate, index) => ({ candidate, index }))
    .filter((item) => item.index !== primaryIndex);
  return `
    <section class="glass section candidate-focus">
      ${renderCandidateCard(primary, primaryIndex, true)}
      ${extras.length ? `
        <details class="more-candidates">
          <summary>还有 ${extras.length} 个其它候选，通常不用管</summary>
          <div class="candidate-list">
            ${extras.map(({ candidate, index }) => renderCandidateCard(candidate, index, false)).join('')}
          </div>
        </details>
      ` : ''}
    </section>
  `;
}

function renderCandidateCard(candidate, index, primary) {
  const defaultTitle = defaultCandidateTitle(candidate);
  const job = appState.candidateJobs[index] || {};
  const title = appState.candidateTitleDrafts[index] ?? job.title ?? defaultTitle;
  const subtitle = candidateSubtitle(candidate);
  const duplicate = candidateDuplicate(candidate);
  const stateLabel = candidateJobLabel(job) || duplicateCandidateLabel(candidate) || (candidate.uploadable === false ? (candidate.lowConfidence ? '疑似无效' : '需手动上传') : (primary ? '当前录音' : '备用候选'));
  const action = renderCandidateAction(candidate, index, primary, job);
  return `
    <div class="candidate-card ${primary ? 'primary-candidate' : ''}">
      <div class="candidate-status-mark" title="候选录音，点击生成纪要后可在详情页播放">${primary ? '主' : '备'}</div>
      <div class="candidate-body">
        <div class="item-title">
          <span>${escapeHtml(title)}</span>
          <span class="badge ${candidateBadgeClass(candidate, duplicate)}">${escapeHtml(stateLabel)}</span>
        </div>
        <div class="meta">${escapeHtml(subtitle)}</div>
        <div class="field compact-field">
          <label for="candidate-title-${index}">录音标题</label>
          <input id="candidate-title-${index}" data-candidate-title="${index}" data-default-title="${escapeHtml(defaultTitle)}" value="${escapeHtml(title)}" placeholder="例如：客户电话沟通">
        </div>
        ${candidate.uploadable === false ? `<div class="status error">${escapeHtml(candidate.unsupportedReason || '该候选暂不能直接上传为单个录音文件。')}</div>` : ''}
        ${duplicate ? renderCandidateDuplicateNotice(candidate) : ''}
        ${renderCandidateJob(job, index)}
        ${primary && candidate.uploadable !== false ? '<div class="hint candidate-hint">候选页不直接播放录音；点击生成纪要后，可在详情页播放和跳转逐字稿时间戳。</div>' : ''}
      </div>
      ${action}
    </div>
  `;
}

function renderCandidateAction(candidate, index, primary, job = {}) {
  if (candidate.uploadable === false) {
    return `<button class="btn candidate-action" type="button" data-action="manual-upload-from-candidate" data-index="${index}">手动上传录音</button>`;
  }
  if (candidateDuplicate(candidate) && !isCandidateJobBusy(job)) {
    return `
      <div class="candidate-actions">
        <button class="btn primary" type="button" data-action="open-duplicate-record" data-index="${index}">${escapeHtml(duplicateOpenButtonLabel(candidate))}</button>
        <button class="btn" type="button" data-action="force-upload-candidate" data-index="${index}">仍要重新识别</button>
      </div>
    `;
  }
  if (isCandidateJobBusy(job)) {
    return `<button class="btn primary candidate-action" type="button" data-action="upload-candidate" data-index="${index}" disabled>${escapeHtml(candidateJobLabel(job) || '处理中')}</button>`;
  }
  if (['read_failed', 'failed'].includes(job.phase)) {
    return `
      <div class="candidate-actions">
        ${job.recordId && job.blob && job.fileName ? `<button class="btn primary" type="button" data-action="retry-candidate-upload" data-index="${index}">重试上传</button>` : ''}
        <button class="btn primary" type="button" data-action="upload-candidate" data-index="${index}">重新读取</button>
        <button class="btn" type="button" data-action="manual-upload-from-candidate" data-index="${index}">手动上传</button>
        <button class="btn ghost" type="button" data-action="copy-candidate-diagnostics" data-index="${index}">复制诊断</button>
      </div>
    `;
  }
  return `<button class="btn primary candidate-action" type="button" data-action="upload-candidate" data-index="${index}">${primary ? '生成纪要' : '使用这条生成'}</button>`;
}

function candidateBadgeClass(candidate, duplicate) {
  if (duplicate) return duplicate.record?.status === 'failed' ? 'failed' : 'completed';
  return candidate.uploadable === false ? 'failed' : '';
}

function candidateDuplicate(candidate = {}) {
  const duplicate = candidate.duplicate || {};
  return duplicate.checked && duplicate.duplicate && duplicate.record ? duplicate : null;
}

function duplicateCandidateLabel(candidate) {
  const duplicate = candidateDuplicate(candidate);
  if (!duplicate) return '';
  const status = duplicate.record?.status || '';
  if (status === 'failed') return '之前识别失败';
  if (['uploaded', 'transcribing', 'summarizing'].includes(status)) return '已有任务处理中';
  return '已识别过';
}

function renderCandidateDuplicateNotice(candidate) {
  const duplicate = candidateDuplicate(candidate);
  if (!duplicate) return '';
  const status = duplicate.record?.status || '';
  const message = status === 'failed'
    ? '这条录音之前处理失败，可打开记录重试。'
    : ['uploaded', 'transcribing', 'summarizing'].includes(status)
      ? '这条录音已进入处理流程，可直接查看进度。'
      : '这个账号下已处理过这条录音，可直接打开已有记录，避免重复消耗识别额度。';
  return `<div class="status warning candidate-duplicate-notice">${escapeHtml(message)}</div>`;
}

function duplicateOpenButtonLabel(candidate) {
  const status = candidateDuplicate(candidate)?.record?.status || '';
  if (status === 'failed') return '打开记录重试';
  if (['uploaded', 'transcribing', 'summarizing'].includes(status)) return '查看处理进度';
  return '打开已有记录';
}

function renderCandidateJob(job = {}, index = 0) {
  if (!job.phase) return '';
  const statusClass = ['read_failed', 'failed'].includes(job.phase) ? 'error' : (job.phase === 'processing' ? 'success' : '');
  const details = [
    job.recordId ? `记录 ID：${job.recordId}` : '',
    job.error || '',
  ].filter(Boolean);
  return `
    <div class="candidate-job status ${statusClass}">
      <strong>${escapeHtml(candidateJobLabel(job))}</strong>
      ${job.message ? `<div>${escapeHtml(job.message)}</div>` : ''}
      ${details.length ? `<div class="meta">${details.map(escapeHtml).join(' · ')}</div>` : ''}
    </div>
  `;
}

function candidateJobLabel(job = {}) {
  return ({
    idle: '可生成',
    reading: '正在读取网页录音',
    read_failed: '读取失败',
    creating_record: '正在创建记录',
    uploading: '正在上传到后端',
    processing: '已进入后端处理',
    failed: '流程失败',
  })[job.phase] || '';
}

function isCandidateJobBusy(job = {}) {
  return ['reading', 'creating_record', 'uploading', 'processing'].includes(job.phase);
}

function renderUpload() {
  return `
    <form id="upload-form" class="home-flow">
      ${renderUploadIntakeCard()}
      ${renderProcessingSettingsCard('upload', currentTemplateType(), currentFollowupType(), {
        actionLabel: '上传并生成纪要',
        action: 'upload-manual',
      })}
    </form>
  `;
}

function renderUploadIntakeCard() {
  const draft = appState.uploadDraft || {};
  return `
    <section class="glass section upload-intake-card">
      ${draft.notice ? `<div class="status error upload-fallback-notice">${escapeHtml(draft.notice)}</div>` : ''}
      <div class="upload-dropzone">
        <div class="upload-orb" aria-hidden="true">↑</div>
        <div class="upload-drop-copy">
          <h2>上传录音文件，开始转写</h2>
          <div class="meta">推荐 2 小时内；最高 12 小时、2GB，超长请先切分</div>
        </div>
        <label class="btn primary file-picker">
          选择文件
          <input id="audioFile" name="audioFile" type="file" accept=".mp3,.m4a,.wav,.aac,.flac,.ogg,.opus,.mp4,.mov,.webm,audio/*,video/*">
        </label>
      </div>
      <div id="upload-file-status" class="hint upload-file-status">
        ${draft.fileName ? `已选择：${escapeHtml(draft.fileName)}（${escapeHtml(formatBytes(draft.fileSize))}）` : '尚未选择文件'}
      </div>
      ${draft.status ? `<div id="upload-action-status" class="status ${escapeHtml(draft.statusType)}">${escapeHtml(draft.status)}</div>` : '<div id="upload-action-status"></div>'}
      <div class="field upload-title-field">
        <label for="upload-title">录音标题</label>
        <input id="upload-title" name="title" value="${escapeHtml(draft.title || '')}" placeholder="例如：招聘客户电话沟通">
      </div>
    </section>
  `;
}

function renderProcessingSettingsCard(prefix, selectedTemplate, selectedFollowup, options = {}) {
  return `
    <section class="glass section processing-settings-card">
      <div class="settings-card-title">
        <span class="settings-mark" aria-hidden="true">⚙</span>
        <div>
          <h2>转写设置</h2>
          <div class="meta">选择生成内容，系统将根据设置生成对应结果</div>
        </div>
      </div>
      ${renderProcessingPicker(prefix, selectedTemplate, selectedFollowup)}
      ${options.action ? `
        <div class="processing-apply-row">
          <button class="btn primary apply-button" type="button" data-action="${escapeHtml(options.action)}" ${appState.busy ? 'disabled' : ''}>${escapeHtml(options.actionLabel || '保存设置并应用')}</button>
        </div>
      ` : ''}
    </section>
  `;
}

function renderHistory() {
  const records = filteredHistoryRecords();
  const selectedCount = selectedRecordIds().length;
  const groupBy = effectiveHistoryGroupBy();
  const groups = groupHistoryRecords(records, groupBy);
  return `
    <section class="glass section stack">
      <div class="item-title">
        <h2>历史记录</h2>
        <button class="btn" data-action="refresh-records">刷新</button>
      </div>
      <div class="history-toolbar">
        <label class="history-search">
          <span>搜索</span>
          <input id="history-search" value="${escapeHtml(appState.historyQuery)}" placeholder="搜索标题 / 用户 ID">
        </label>
        <button class="btn ${appState.historyFilter === 'all' ? 'primary' : ''}" type="button" data-action="history-filter" data-filter="all">全部</button>
        <button class="btn ${appState.historyFilter === 'test' ? 'primary' : ''}" type="button" data-action="history-filter" data-filter="test">只看测试数据</button>
        ${renderHistoryGroupControls(groupBy)}
        <button class="btn" type="button" data-action="bulk-archive-records" ${selectedCount ? '' : 'disabled'}>归档已选 ${selectedCount || ''}</button>
        ${appState.permissions.canManageSettings ? `<button class="btn danger" type="button" data-action="bulk-purge-records" ${selectedCount ? '' : 'disabled'}>彻底删除已选 ${selectedCount || ''}</button>` : ''}
      </div>
      ${records.length ? renderHistoryGroups(groups, groupBy) : '<div class="empty">暂无录音记录</div>'}
    </section>
  `;
}

function renderHistoryGroupControls(groupBy) {
  if (!appState.permissions.canViewAllRecords && !appState.permissions.canViewDepartmentRecords) return '';
  return [
    ['employee', '按人'],
    ['department', '按部门'],
    ['none', '全部时间线'],
  ].map(([value, label]) =>
    `<button class="btn ${groupBy === value ? 'primary' : ''}" type="button" data-action="history-group" data-group="${value}">${label}</button>`
  ).join('');
}

function renderHistoryGroups(groups, groupBy) {
  if (groupBy === 'none') return renderRecordList(groups[0]?.records || []);
  return `
    <div class="history-group-list">
      ${groups.map((group) => renderHistoryGroup(group)).join('')}
    </div>
  `;
}

function renderHistoryGroup(group) {
  const expanded = historyGroupExpanded(group);
  const counts = group.counts;
  return `
    <section class="history-group">
      <button class="history-group-header" type="button" data-action="toggle-history-group" data-group-id="${escapeHtml(group.id)}" data-expanded="${expanded ? '1' : '0'}">
        <span>${expanded ? '收起' : '展开'}</span>
        <strong>${escapeHtml(group.title)}</strong>
        <em>${counts.total} 条 · 完成 ${counts.completed} · 待重试 ${counts.transcribed} · 处理中 ${counts.inProgress} · 失败 ${counts.failed}</em>
        <small>最近 ${escapeHtml(formatDate(group.latestCreatedAt))}</small>
      </button>
      ${expanded ? renderRecordList(group.records) : ''}
    </section>
  `;
}

function renderRecordList(records) {
  return `
    <div class="record-list">
      ${records.map((record) => `
        <div class="item history-item">
          <label class="history-select">
            <input type="checkbox" data-record-select="${escapeHtml(record.id)}" ${appState.selectedRecordIds[record.id] ? 'checked' : ''}>
            <span>选择</span>
          </label>
          <div class="history-main" data-action="open-record" data-id="${escapeHtml(record.id)}">
            <div class="item-title">
              <span>${escapeHtml(record.title || record.originalFileName || '未命名录音')}</span>
              <span class="badge ${escapeHtml(record.status)}">${statusLabel(record.status)}</span>
            </div>
            <div class="meta">${escapeHtml(record.owner?.displayName || '')} · ${escapeHtml(record.department?.name || '未分配')} · ${escapeHtml(templateLabel(record.templateType))} · ${escapeHtml(followupLabel(record.followupType || 'none'))} · ${escapeHtml(titleSourceLabel(record.titleSource))}</div>
            ${record.externalUserId ? `<div class="meta">用户 ID：${escapeHtml(record.externalUserId)}</div>` : ''}
            <div class="meta">${formatDate(record.createdAt)}${record.errorMessage ? ` · ${escapeHtml(record.errorMessage)}` : ''}</div>
            ${record.titleSource === 'filename' && record.status === 'completed' && !record.aiTitle ? '<div class="hint">可进入详情页改名。</div>' : ''}
          </div>
          <div class="history-actions">
            <button class="btn" type="button" data-action="archive-record" data-id="${escapeHtml(record.id)}">归档</button>
            ${appState.permissions.canManageSettings ? `<button class="btn danger" type="button" data-action="purge-record" data-id="${escapeHtml(record.id)}">彻底删除</button>` : ''}
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function filteredHistoryRecords() {
  const query = appState.historyQuery.trim().toLowerCase();
  return appState.records.filter((record) => {
    if (appState.historyFilter === 'test' && !isLikelyTestRecord(record)) return false;
    if (!query) return true;
    return historyRecordSearchText(record).includes(query);
  });
}

function historyRecordSearchText(record) {
  return [
    record.title,
    record.originalFileName,
    record.sourcePageTitle,
    record.externalUserId,
    record.owner?.displayName,
    record.department?.name,
  ].join('\n').toLowerCase();
}

function effectiveHistoryGroupBy() {
  if (appState.historyGroupBy && appState.historyGroupBy !== 'auto') return appState.historyGroupBy;
  if (appState.permissions.canViewAllRecords || appState.permissions.canViewDepartmentRecords) return 'employee';
  return 'none';
}

function groupHistoryRecords(records, groupBy) {
  if (groupBy === 'department') return groupRecords(records, (record) => ({
    id: record.department?.id || 'department:none',
    title: record.department?.name || '未分配部门',
  }));
  if (groupBy === 'employee') return groupRecords(records, (record) => ({
    id: record.owner?.id || 'employee:none',
    title: record.owner?.displayName || '未知员工',
  }));
  return [{
    id: 'all',
    title: '全部记录',
    records,
    counts: historyGroupCounts(records),
    latestCreatedAt: records[0]?.createdAt || '',
  }];
}

function groupRecords(records, identityForRecord) {
  const groups = new Map();
  records.forEach((record) => {
    const identity = identityForRecord(record);
    if (!groups.has(identity.id)) {
      groups.set(identity.id, {
        id: identity.id,
        title: identity.title,
        records: [],
        counts: null,
        latestCreatedAt: '',
      });
    }
    const group = groups.get(identity.id);
    group.records.push(record);
    if (!group.latestCreatedAt || String(record.createdAt || '').localeCompare(String(group.latestCreatedAt)) > 0) {
      group.latestCreatedAt = record.createdAt || '';
    }
  });
  return [...groups.values()]
    .map((group) => ({ ...group, counts: historyGroupCounts(group.records) }))
    .sort((left, right) => String(right.latestCreatedAt).localeCompare(String(left.latestCreatedAt)));
}

function historyGroupCounts(records) {
  return {
    total: records.length,
    completed: records.filter((record) => record.status === 'completed').length,
    transcribed: records.filter((record) => record.status === 'transcribed').length,
    inProgress: records.filter((record) => isInProgress(record.status)).length,
    failed: records.filter((record) => record.status === 'failed').length,
  };
}

function historyGroupExpanded(group) {
  if (appState.historyQuery.trim()) return true;
  if (Object.hasOwn(appState.historyExpandedGroups, group.id)) return Boolean(appState.historyExpandedGroups[group.id]);
  return group.counts.failed > 0 || group.counts.transcribed > 0 || group.counts.inProgress > 0;
}

function isLikelyTestRecord(record) {
  const text = [
    record.title,
    record.originalFileName,
    record.sourcePageTitle,
    record.id,
  ].join('\n').toLowerCase();
  return ['测试', '烟测', 'test', '0ba0d155'].some((keyword) => text.includes(keyword.toLowerCase()));
}

function selectedRecordIds() {
  return Object.entries(appState.selectedRecordIds || {})
    .filter(([, selected]) => selected)
    .map(([id]) => id);
}

function renderDetail() {
  const record = appState.detail;
  if (!record) return '<section class="glass section"><div class="empty">未选择记录</div></section>';
  if (!detailTabItems(record).some((item) => item.id === appState.detailTab)) appState.detailTab = 'summary';
  return `
    <div class="stack">
      <section class="glass section detail-header">
        <button class="btn ghost" data-view="history">返回历史</button>
        ${renderTitleEditor(record)}
        <div class="meta">${escapeHtml(record.owner?.displayName || '')} · ${escapeHtml(record.department?.name || '')} · ${formatDate(record.createdAt)}</div>
        ${renderExternalUserIdEditor(record)}
        <div class="btn-row">
          <span class="share-popover-wrap">
            <button class="btn" type="button" data-action="open-share-panel" aria-expanded="${appState.sharePanelOpen ? 'true' : 'false'}">分享</button>
            ${appState.sharePanelOpen ? renderSharePanel(record) : ''}
          </span>
          <span class="badge ${escapeHtml(record.status)}">${statusLabel(record.status)}</span>
          <span class="badge">${escapeHtml(templateLabel(record.templateType))}</span>
          <span class="badge">${escapeHtml(followupLabel(record.followupType || 'none'))}</span>
          <span class="badge">${escapeHtml(titleSourceLabel(record.titleSource))}</span>
        </div>
        ${renderRecordProgress(record)}
        ${record.errorMessage ? `<div class="status error">${escapeHtml(record.errorMessage)}</div>` : ''}
      </section>
      <section class="glass section detail-workspace">
        ${renderDetailTabs(record)}
        ${renderDetailPanel(record)}
      </section>
    </div>
  `;
}

function detailTabItems(record = {}) {
  return [
    { id: 'summary', label: '会议概览' },
    { id: 'transcript', label: '会议逐字稿' },
    { id: 'mind_map', label: '思维导图' },
    { id: 'followup', label: normalizeFollowupTypeUi(record.followupType, record.templateType) === 'none' ? '备注' : '跟单/备注' },
    { id: 'downloads', label: '下载' },
  ];
}

function renderDetailTabs(record) {
  return `
    <div class="detail-tabs" role="tablist" aria-label="录音详情栏目">
      ${detailTabItems(record).map((item) => `
        <button type="button" role="tab" data-detail-tab="${escapeHtml(item.id)}" aria-selected="${appState.detailTab === item.id ? 'true' : 'false'}" class="${appState.detailTab === item.id ? 'active' : ''}">
          ${escapeHtml(item.label)}
        </button>
      `).join('')}
    </div>
  `;
}

function renderDetailPanel(record) {
  const tab = detailTabItems(record).find((item) => item.id === appState.detailTab) || detailTabItems(record)[0];
  const collapsed = isDetailPanelCollapsed(record.id, tab.id);
  return `
    <section id="${escapeHtml(detailPanelAnchor(tab.id))}" class="detail-panel ${collapsed ? 'is-collapsed' : ''}" data-detail-panel="${escapeHtml(tab.id)}">
      <div class="item-title detail-panel-title">
        <h3>${escapeHtml(tab.label)}</h3>
        <button class="btn" type="button" data-action="toggle-detail-panel" data-panel="${escapeHtml(tab.id)}">${collapsed ? '展开' : '收起'}</button>
      </div>
      ${collapsed ? '' : `<div class="detail-panel-body">${renderDetailTab(record)}</div>`}
    </section>
  `;
}

function detailPanelAnchor(tabId) {
  if (tabId === 'summary') return 'summary-section';
  if (tabId === 'transcript') return 'transcript-section';
  if (tabId === 'mind_map') return 'mind-map-section';
  if (tabId === 'downloads') return 'download-section';
  return `${tabId}-section`;
}

function renderDetailTab(record) {
  if (appState.detailTab === 'summary') {
    return renderSummaryPanel(record);
  }
  if (appState.detailTab === 'transcript') {
    return `
      <div class="btn-row" style="margin-bottom:10px">
        <button class="btn" data-action="transcribe-record">重新转写</button>
      </div>
      ${renderTranscriptWorkspace(record)}
    `;
  }
  if (appState.detailTab === 'mind_map') {
    return renderMindMapTab(record);
  }
  if (appState.detailTab === 'followup') {
    return `
      ${normalizeFollowupTypeUi(record.followupType, record.templateType) === 'none' ? '' : renderFollowupEditor(record)}
      <div class="detail-notes">${renderNotesPanel(record)}</div>
    `;
  }
  if (appState.detailTab === 'notes') {
    return renderNotesPanel(record);
  }
  return renderDownloadPanel(record);
}

function isDetailPanelCollapsed(recordId, tabId) {
  return Boolean(appState.collapsedPanels?.[`${recordId || 'record'}:${tabId}`]);
}

function toggleDetailPanel(recordId, tabId) {
  const key = `${recordId || 'record'}:${tabId}`;
  appState.collapsedPanels = { ...appState.collapsedPanels, [key]: !appState.collapsedPanels?.[key] };
}

function renderMindMapTab(record) {
  const summary = record.summary || {};
  const state = mindMapState(summary.mind_map_json, record.title);
  if (!state.mindMap) {
    return `<div class="empty">${escapeHtml(state.reason)}</div>`;
  }
  return renderMindMap(state.mindMap, { showEmptyReason: true });
}

function renderNotesPanel(record) {
  return `
    <div class="item-title"><h3>备注</h3></div>
    <form id="note-form" class="form">
      <div class="field">
        <label for="note">新增备注</label>
        <textarea id="note" name="note"></textarea>
      </div>
      <button class="btn primary" type="button" data-action="save-note">保存备注</button>
    </form>
    <div class="record-list" style="margin-top:10px">
      ${(record.notes || []).map((note) => `
        <div class="item">
          <div class="item-title"><span>${escapeHtml(note.employee || '')}</span><span class="meta">${formatDate(note.created_at)}</span></div>
          <div class="markdown">${escapeHtml(note.note)}</div>
        </div>
      `).join('') || '<div class="empty">暂无备注</div>'}
    </div>
  `;
}

function renderFollowupEditor(record) {
  const followup = record.followupForm || {};
  return `
    <form id="followup-form" class="form followup-editor">
      <div class="field">
        <label for="externalUserIdInFollowup">用户 ID</label>
        <input id="externalUserIdInFollowup" name="externalUserId" value="${escapeHtml(record.externalUserId || '')}" placeholder="例如：客户后台 ID / 会员 ID">
      </div>
      <div class="grid-2">
        <div class="field">
          <label for="followup-stage">阶段</label>
          ${renderRecruitmentStageOptions(followup.stage || '')}
        </div>
        <div class="field">
          <label for="suggestedTag">建议标签</label>
          <input id="suggestedTag" name="suggestedTag" value="${escapeHtml(followup.suggested_tag || '')}">
        </div>
      </div>
      <div class="grid-2">
        <div class="field">
          <label for="companyName">企业/客户</label>
          <input id="companyName" name="companyName" value="${escapeHtml(followup.company_name || followup.customer_name || '')}">
        </div>
        <div class="field">
          <label for="statusLabel">状态</label>
          <input id="statusLabel" name="statusLabel" value="${escapeHtml(followup.status_label || '')}">
        </div>
      </div>
      <div class="field">
        <label for="followupMarkdown">跟单内容</label>
        <textarea id="followupMarkdown" name="followupMarkdown">${escapeHtml(followup.followup_markdown || '')}</textarea>
      </div>
      <button class="btn primary" type="button" data-action="save-followup">保存跟单修改</button>
    </form>
  `;
}

function renderTranscriptWorkspace(record, options = {}) {
  const segments = normalizedTranscriptSegments(record);
  const query = appState.transcriptQuery.trim().toLowerCase();
  const filtered = query
    ? segments.filter((segment) => [
      segment.text,
      segment.speaker,
      formatTimestamp(segment.startMs),
    ].join('\n').toLowerCase().includes(query))
    : segments;
  const visibleLimit = query
    ? Math.max(TRANSCRIPT_RENDER_BATCH, appState.transcriptVisibleCount)
    : appState.transcriptVisibleCount;
  const visibleSegments = filtered.slice(0, visibleLimit);
  const hiddenCount = Math.max(0, filtered.length - visibleSegments.length);
  const plainText = record.transcript?.corrected_text || record.transcript?.raw_text || '';
  return `
    <div class="recording-workspace-lite ${options.embedded ? 'embedded' : ''}">
      <div class="audio-panel">
        ${record.audioUrl ? `
          <audio id="record-audio" controls preload="metadata" src="${escapeHtml(authedUrl(record.audioUrl))}"></audio>
        ` : '<div class="empty">暂无可播放录音文件</div>'}
        ${appState.audioError ? `<div class="status error">${escapeHtml(appState.audioError)}</div>` : ''}
        <button class="btn" type="button" data-action="transcribe-record">重新转写</button>
      </div>
      <div class="transcript-toolbar">
        <input id="transcript-search" value="${escapeHtml(appState.transcriptQuery)}" placeholder="搜索逐字稿">
      </div>
      ${segments.length ? `
        <div class="transcript-list">
          ${visibleSegments.map((segment) => `
            <article class="transcript-segment ${appState.activeSegmentId === segment.id ? 'active' : ''}" role="button" tabindex="0" data-action="seek-segment" data-id="${escapeHtml(segment.id)}" data-start-ms="${escapeHtml(String(segment.startMs || 0))}">
              <button class="transcript-time" type="button" data-action="seek-segment" data-id="${escapeHtml(segment.id)}" data-start-ms="${escapeHtml(String(segment.startMs || 0))}">${escapeHtml(formatTimestamp(segment.startMs) || '--:--')}</button>
              ${renderSpeakerCell(segment)}
              <p>${escapeHtml(segment.text)}</p>
            </article>
          `).join('') || '<div class="empty">没有匹配的逐字稿</div>'}
          ${hiddenCount ? `
            <button class="btn transcript-more" type="button" data-action="show-more-transcript">
              显示更多 ${Math.min(TRANSCRIPT_RENDER_BATCH, hiddenCount)} 段（剩余 ${hiddenCount} 段）
            </button>
          ` : ''}
        </div>
      ` : `<div class="markdown">${escapeHtml(plainText || '暂无逐字稿')}</div>`}
    </div>
  `;
}

function renderSpeakerCell(segment) {
  if (!segment.speaker) return '<strong>录音</strong>';
  const editing = appState.speakerEditing;
  const isEditing = editing?.speaker === segment.speaker && editing?.segmentId === segment.id;
  const label = segment.speakerLabel || segment.speaker;
  return `
    <span class="transcript-speaker-cell">
      <button class="speaker-chip" type="button" data-action="edit-speaker" data-id="${escapeHtml(segment.id)}" data-speaker="${escapeHtml(segment.speaker)}" data-label="${escapeHtml(label)}" title="修改说话人">
        ${escapeHtml(label)}
        <span aria-hidden="true">✎</span>
      </button>
      ${isEditing ? `
        <div class="speaker-popover">
          <input id="speaker-alias-input" value="${escapeHtml(editing.value)}" placeholder="${escapeHtml(segment.speaker)}" maxlength="40">
          <label><input type="radio" checked readonly>应用到该说话人的所有片段</label>
          <div class="btn-row">
            <button class="btn" type="button" data-action="cancel-speaker">取消</button>
            <button class="btn primary" type="button" data-action="save-speaker" data-speaker="${escapeHtml(segment.speaker)}">保存</button>
          </div>
        </div>
      ` : ''}
    </span>
  `;
}

function renderSummaryWorkspace(record) {
  const summary = record.summary || {};
  const summaryMarkdown = summary.summary_markdown || '';
  const hasTranscript = Boolean(record.transcript?.corrected_text || record.transcript?.raw_text || normalizedTranscriptSegments(record).length);
  const hasSummary = hasSummaryContent(record);
  const wordCount = countReadableWords(record);
  const generatedAt = record.completedAt || summary.updated_at || summary.created_at || record.lastProgressAt || '';
  return `
    <section class="recording-workbench" data-api-base="${escapeHtml(activeApiBaseUrl())}">
      <header class="recording-workbench-header">
        <div>
          <span class="recording-workbench-kicker">${escapeHtml(resultTypeLabel(record))}</span>
          <h3>${escapeHtml(record.title || record.originalFileName || '未命名录音')}</h3>
          <div class="result-meta-row">
            <span>${escapeHtml(statusLabel(record.status))}</span>
            <span>${wordCount} 字</span>
            <span>约 ${Math.max(1, Math.ceil(wordCount / 450))} 分钟阅读</span>
            ${generatedAt ? `<span>${escapeHtml(formatDate(generatedAt))}</span>` : ''}
          </div>
        </div>
        <div class="recording-workbench-actions">
          <button class="btn" type="button" data-action="copy-summary" ${summaryMarkdown ? '' : 'disabled'}>复制</button>
          ${renderDownloadSelect('transcript', '下载逐字稿', hasTranscript)}
          ${renderDownloadSelect('summary', '下载总结', hasSummary)}
        </div>
        ${appState.exportNotice ? `<div class="export-notice">${escapeHtml(appState.exportNotice)}</div>` : ''}
      </header>
      <div class="recording-workbench-grid">
        <main id="summary-section" class="recording-workbench-summary-pane">
          ${renderSummaryPanel(record)}
        </main>
        <aside id="transcript-section" class="recording-workbench-transcript-pane">
          <div class="item-title"><h3>逐字稿</h3></div>
          ${renderTranscriptWorkspace(record, { embedded: true })}
        </aside>
      </div>
    </section>
  `;
}

function renderCompactDownloadControls(record) {
  const summary = record.summary || {};
  const hasTranscript = Boolean(record.transcript?.corrected_text || record.transcript?.raw_text || normalizedTranscriptSegments(record).length);
  const hasSummary = hasSummaryContent(record);
  return `
    <div class="compact-download-controls">
      ${renderDownloadSelect('transcript', '下载逐字稿', hasTranscript)}
      ${renderDownloadSelect('summary', '下载总结', hasSummary)}
    </div>
  `;
}

function renderDownloadPanel(record) {
  const hasTranscript = hasTranscriptContent(record);
  const hasSummary = hasSummaryContent(record);
  const mindMap = mindMapState(record.summary?.mind_map_json, record.title);
  const hasMindMap = Boolean(mindMap.mindMap);
  const exportFiles = Array.isArray(record.exportFiles) ? record.exportFiles : [];
  return `
    <div class="download-panel">
      ${renderDownloadGroup('完整包', '完整包 ZIP', [
        { target: 'all_files', format: 'zip', label: 'ZIP', enabled: true },
      ], '包含录音记录、总结、逐字稿、卡片和思维导图的可下载文件。')}
      ${renderDownloadGroup('总结', '总结 PDF / DOCX', [
        { target: 'summary', format: 'pdf', label: 'PDF', enabled: hasSummary },
        { target: 'summary', format: 'docx', label: 'DOCX', enabled: hasSummary },
        { target: 'summary', format: 'md', label: 'Markdown', enabled: hasSummary },
      ], hasSummary ? 'PDF 会包含总结卡片、文字纪要和思维导图。' : '未生成总结，暂不可下载。')}
      ${renderDownloadGroup('逐字稿', '逐字稿 TXT / MD / DOCX / PDF', [
        { target: 'transcript', format: 'txt', label: 'TXT', enabled: hasTranscript },
        { target: 'transcript', format: 'md', label: 'Markdown', enabled: hasTranscript },
        { target: 'transcript', format: 'docx', label: 'DOCX', enabled: hasTranscript },
        { target: 'transcript', format: 'pdf', label: 'PDF', enabled: hasTranscript },
      ], hasTranscript ? '逐字稿会保留时间戳和说话人。' : '逐字稿未生成，暂不可下载。')}
      ${renderDownloadGroup('思维导图', '思维导图 SVG / PDF', [
        { target: 'mind_map', format: 'svg', label: 'SVG', enabled: hasMindMap },
        { target: 'mind_map', format: 'pdf', label: 'PDF', enabled: hasMindMap },
        { target: 'mind_map', format: 'png', label: 'PNG', enabled: false },
      ], hasMindMap ? 'PNG 暂未开放，SVG 可作为可缩放图片使用。' : mindMap.reason)}
      ${renderDownloadGroup('总结卡片', '总结卡片 SVG / PDF', [
        { target: 'overview_card', format: 'svg', label: 'SVG', enabled: hasSummary },
        { target: 'overview_card', format: 'pdf', label: 'PDF', enabled: hasSummary },
        { target: 'overview_card', format: 'png', label: 'PNG', enabled: false },
      ], hasSummary ? 'PNG 暂未开放，SVG 可插入文档。' : '未生成总结卡片，暂不可下载。')}
      ${exportFiles.length ? `<div class="hint">最近生成：${exportFiles.slice(0, 5).map((file) => escapeHtml(`${exportTargetLabel(file.export_type)} ${formatLabel(file.format)} ${formatDate(file.created_at)}`)).join(' · ')}</div>` : ''}
      ${appState.exportNotice ? `<div class="export-notice">${escapeHtml(appState.exportNotice)}</div>` : ''}
    </div>
  `;
}

function renderSharePanel(record) {
  const hasAudio = Boolean(record.audioUrl);
  const hasTranscript = hasTranscriptContent(record);
  const hasSummary = hasSummaryContent(record);
  const shares = Array.isArray(appState.shareLinks) ? appState.shareLinks : [];
  return `
    <div class="share-panel">
      <div class="item-title">
        <h3>分享链接</h3>
        <button class="btn" type="button" data-action="close-share-panel">关闭</button>
      </div>
      <form id="share-form" class="share-form">
        <label class="share-option ${hasAudio ? '' : 'disabled'}">
          <span>录音</span>
          <input name="includeAudio" type="checkbox" ${hasAudio ? 'checked' : 'disabled'}>
        </label>
        <label class="share-option ${hasTranscript ? '' : 'disabled'}">
          <span>逐字稿</span>
          <input name="includeTranscript" type="checkbox" ${hasTranscript ? 'checked' : 'disabled'}>
        </label>
        <label class="share-option ${hasSummary ? '' : 'disabled'}">
          <span>总结</span>
          <input name="includeSummary" type="checkbox" ${hasSummary ? 'checked' : 'disabled'}>
        </label>
        <div class="field compact-field">
          <label for="share-expires-days">有效期</label>
          <select id="share-expires-days" name="expiresInDays">
            <option value="1">1 天</option>
            <option value="7" selected>7 天</option>
            <option value="30">30 天</option>
          </select>
        </div>
        <div class="btn-row">
          <button class="btn primary" type="button" data-action="create-share-link" ${appState.busy ? 'disabled' : ''}>复制链接</button>
          <button class="btn" type="button" data-action="refresh-share-links">刷新列表</button>
        </div>
        <div class="hint">分享链接在有效期内无需登录即可访问，请只发给需要查看的人。</div>
        ${appState.shareStatus ? `<div class="status ${escapeHtml(appState.shareStatusType)}">${escapeHtml(appState.shareStatus)}</div>` : ''}
      </form>
      ${shares.length ? `
        <div class="share-link-list">
          ${shares.map((share) => renderShareLinkRow(share)).join('')}
        </div>
      ` : '<div class="empty">还没有创建分享链接。</div>'}
    </div>
  `;
}

function renderShareLinkRow(share = {}) {
  const disabled = Boolean(share.revokedAt);
  const parts = [
    share.includeAudio ? '录音' : '',
    share.includeTranscript ? '逐字稿' : '',
    share.includeSummary ? '总结' : '',
  ].filter(Boolean).join(' / ') || '未选择内容';
  return `
    <div class="share-link-row ${disabled ? 'disabled' : ''}">
      <div>
        <strong>${escapeHtml(parts)}</strong>
        <div class="meta">有效期至 ${escapeHtml(formatDate(share.expiresAt))} · 访问 ${Number(share.accessCount || 0)} 次${disabled ? ' · 已撤销' : ''}</div>
        <div class="share-url">${escapeHtml(share.url || '')}</div>
      </div>
      <div class="share-link-actions">
        <button class="btn" type="button" data-action="copy-share-link" data-url="${escapeHtml(share.url || '')}" ${disabled ? 'disabled' : ''}>复制</button>
        <button class="btn danger" type="button" data-action="revoke-share-link" data-id="${escapeHtml(share.id || '')}" ${disabled ? 'disabled' : ''}>撤销</button>
      </div>
    </div>
  `;
}

function renderDownloadGroup(title, subtitle, actions, hint) {
  return `
    <section class="download-group">
      <div>
        <h4>${escapeHtml(title)}</h4>
        <span>${escapeHtml(subtitle)}</span>
      </div>
      <div class="download-action-row">
        ${actions.map((item) => `
          <button class="btn" type="button" data-action="export-direct" data-target="${escapeHtml(item.target)}" data-format="${escapeHtml(item.format)}" ${item.enabled ? '' : 'disabled'}>
            ${escapeHtml(item.label)}
          </button>
        `).join('')}
      </div>
      <p>${escapeHtml(hint || '')}</p>
    </section>
  `;
}

function renderDownloadSelect(target, label, enabled) {
  const formats = ['md', 'txt', 'docx', 'pdf'];
  return `
    <div class="download-select" aria-label="${escapeHtml(label)}">
      <label for="download-${escapeHtml(target)}-format">${escapeHtml(label)}</label>
      <select id="download-${escapeHtml(target)}-format" data-export-format="${escapeHtml(target)}" ${enabled ? '' : 'disabled'}>
        ${formats.map((format) => `<option value="${escapeHtml(format)}">${escapeHtml(formatLabel(format))}</option>`).join('')}
      </select>
      <button class="btn" type="button" data-action="export-selected" data-target="${escapeHtml(target)}" ${enabled ? '' : 'disabled'}>下载</button>
    </div>
  `;
}

function renderSummaryPanel(record) {
  const summary = record.summary || {};
  const summaryMarkdown = summary.summary_markdown || '';
  const showFollowup = normalizeFollowupTypeUi(record.followupType, record.templateType) !== 'none' || record.followupForm;
  return `
    <div class="summary-workspace">
      <div class="summary-toolbar">
        ${renderProcessingPicker('detail', record.templateType || currentTemplateType(), record.followupType || currentFollowupType())}
        <button class="btn primary" type="button" data-action="summarize-record" ${appState.busy ? 'disabled' : ''}>${summaryMarkdown ? '重新生成' : '生成纪要'}</button>
      </div>
      ${renderSummaryQualityNotice(record)}
      ${showFollowup ? renderFollowupResultPanel(record) : renderMeetingResultPanel(record)}
    </div>
  `;
}

function renderSummaryQualityNotice(record) {
  const summary = record.summary || {};
  const status = summaryQualityStatus(summary);
  if (!status || status === 'ai_ok') return '';
  if (record.status === 'summarizing') {
    return '<div class="status warning">正在重新生成总结，请稍等。旧的失败提示将在新结果生成后更新。</div>';
  }
  const reason = summary.quality_reason || record.errorMessage || '';
  if (status === 'fallback_template' || status === 'invalid') {
    return `<div class="status error">AI 总结未成功，逐字稿已保留。${reason ? ` ${escapeHtml(reason)}` : ''}</div>`;
  }
  if (status === 'low_information') {
    return `<div class="status warning">总结内容较少，建议回听核对。${reason ? ` ${escapeHtml(reason)}` : ''}</div>`;
  }
  return '';
}

function renderMeetingResultPanel(record) {
  const summary = record.summary || {};
  const summaryMarkdown = summary.summary_markdown || '';
  return `
    <section class="summary-result-panel meeting-result-panel">
      <div class="item-title"><h3>会议概览</h3></div>
      ${renderOverviewCard(summary.overview_card_json, record)}
      <div class="meeting-section-grid">
        ${renderMeetingSection('关键要点', summaryMarkdown || '暂无总结')}
        ${renderMeetingSection('待办事项', extractSummaryLines(summaryMarkdown, ['待办', '行动', '下一步']))}
        ${renderMeetingSection('风险/待确认事项', extractSummaryLines(summaryMarkdown, ['风险', '待确认', '问题']))}
      </div>
    </section>
  `;
}

function renderMeetingSection(title, content) {
  return `
    <section class="summary-markdown-panel">
      <div class="item-title"><h3>${escapeHtml(title)}</h3></div>
      <div class="markdown rich-markdown">${content ? renderMarkdown(content) : '待核对'}</div>
    </section>
  `;
}

function renderFollowupResultPanel(record) {
  const followup = record.followupForm || {};
  const fields = followup.fields_json && typeof followup.fields_json === 'object' ? followup.fields_json : {};
  const fieldRows = [
    ['用户 ID', record.externalUserId || '待填写'],
    ['客户/对象名称', followup.company_name || followup.customer_name || fields.customerName || fields.companyName],
    ['业务类型', businessTypeLabel(followup.business_type || record.followupType)],
    ['当前阶段', stageLabel(followup.stage || fields.stage)],
    ['需求或意向', fields.intent || fields.need || fields.requirement || followup.suggested_tag],
    ['关键信息', fields.keyInfo || fields.key_information || followup.status_label],
    ['下一步动作', fields.nextAction || fields.next_action || fields.action],
    ['负责人/时间', fields.owner || fields.ownerTime || fields.nextTime],
    ['风险或待确认', fields.risk || fields.risks || fields.todo || '待核对'],
  ];
  return `
    <section class="summary-result-panel followup-result-panel">
      <div class="item-title">
        <h3>跟单信息</h3>
        <button class="btn" type="button" data-action="copy-followup">复制跟单</button>
      </div>
      <div class="followup-field-grid">
        ${fieldRows.map(([label, value]) => `
          <div class="followup-field-card">
            <span>${escapeHtml(label)}</span>
            <strong>${escapeHtml(displayFieldValue(value))}</strong>
          </div>
        `).join('')}
      </div>
      <section class="summary-markdown-panel">
        <div class="item-title"><h3>跟单说明</h3></div>
        <div class="markdown rich-markdown">${renderMarkdown(followup.followup_markdown || record.summary?.summary_markdown || '待核对')}</div>
      </section>
      <details class="followup-edit-drawer">
        <summary>编辑跟单字段</summary>
        ${renderFollowupEditor(record)}
      </details>
    </section>
  `;
}

async function copyFollowup() {
  if (!appState.detail) return;
  if (followupFormHasUnsavedChanges(appState.detail)) {
    setStatus('当前跟单有未保存修改，请先保存后复制。', 'warning');
    render();
    return;
  }
  try {
    await copyText(formatFollowupCopy(appState.detail));
    setStatus('跟单已复制', 'success');
  } catch {
    setStatus('复制失败，请手动选中内容复制', 'error');
  }
  render();
}

function followupFormHasUnsavedChanges(record) {
  const form = document.getElementById('followup-form');
  if (!form) return false;
  const followup = record.followupForm || {};
  return (
    String(form.externalUserId?.value || '') !== String(record.externalUserId || '') ||
    String(form.stage?.value || '') !== String(followup.stage || '') ||
    String(form.companyName?.value || '') !== String(followup.company_name || followup.customer_name || '') ||
    String(form.statusLabel?.value || '') !== String(followup.status_label || '') ||
    String(form.suggestedTag?.value || '') !== String(followup.suggested_tag || '') ||
    String(form.followupMarkdown?.value || '') !== String(followup.followup_markdown || '')
  );
}

function formatFollowupCopy(record) {
  const userIdField = ['用户ID', (item) => item.externalUserId || ''];
  const type = followupCopyType(record);
  if (type === 'matchmaker') return formatCopyFields(record, [userIdField, ...matchmakerCopyFields()]);
  if (type === 'recruitment') return formatCopyFields(record, [userIdField, ...recruitmentCopyFields()]);
  return formatCopyFields(record, [userIdField, ...generalCustomerCopyFields()]);
}

function followupCopyType(record) {
  const businessType = record.followupForm?.business_type || '';
  if (businessType === 'matchmaker' || businessType === 'recruitment' || businessType === 'general_customer') return businessType;
  const type = normalizeFollowupTypeUi(record.followupType, record.templateType);
  return type === 'none' ? 'general_customer' : type;
}

function formatCopyFields(record, specs) {
  return specs.map(([label, resolver]) => `【${label}】：${cleanCopyValue(resolver(record))}`).join('\n');
}

function matchmakerCopyFields() {
  return [
    ['报价金额/成交状态', (record) => followupValue(record, ['quoteAndDealStatus'], record.followupForm?.status_label)],
    ['未成交原因', (record) => followupValue(record, ['notDealReason'])],
    ['第一印象', (record) => followupValue(record, ['firstImpression'])],
    ['个人基本情况', (record) => followupValue(record, ['basicProfile'])],
    ['工作收入', (record) => followupValue(record, ['workIncome'])],
    ['资产情况', (record) => followupValue(record, ['assets'])],
    ['家庭情况', (record) => followupValue(record, ['family'])],
    ['兴趣爱好', (record) => followupValue(record, ['hobbies'])],
    ['情感经历', (record) => followupValue(record, ['relationshipHistory'])],
    ['择偶硬性条件', (record) => followupValue(record, ['hardRequirements'])],
    ['择偶弹性偏好', (record) => followupValue(record, ['flexiblePreferences'])],
    ['忌讳点', (record) => followupValue(record, ['taboo'])],
    ['性格优点', (record) => followupValue(record, ['personalityStrengths'])],
    ['性格挑战', (record) => followupValue(record, ['personalityRisks'])],
    ['服务匹配建议', (record) => followupValue(record, ['serviceSuggestion'])],
    ['下次跟进话术', (record) => followupValue(record, ['nextScript'])],
    ['待补充信息', (record) => followupValue(record, ['pendingInfo'])],
  ];
}

function recruitmentCopyFields() {
  return [
    ['跟进阶段', (record) => stageLabel(record.followupForm?.stage || followupValue(record, ['stage']))],
    ['当前客户状态', (record) => followupValue(record, ['customerStatus'], record.followupForm?.status_label)],
    ['企业/客户名称', (record) => record.followupForm?.company_name || followupValue(record, ['companyName'])],
    ['联系人/角色', (record) => followupValue(record, ['contactRole'])],
    ['招聘岗位', (record) => followupValue(record, ['hiringRoles'])],
    ['招聘人数', (record) => followupValue(record, ['hiringCount'])],
    ['岗位要求', (record) => followupValue(record, ['requirements'])],
    ['薪资福利', (record) => followupValue(record, ['salaryBenefits'])],
    ['是否已添加微信', (record) => followupValue(record, ['wechatAdded'])],
    ['客户顾虑', (record) => followupValue(record, ['concerns'])],
    ['下一步动作', (record) => followupValue(record, ['nextAction'])],
    ['建议标签', (record) => record.followupForm?.suggested_tag || followupValue(record, ['suggestedTag'])],
    ['待补充信息', (record) => followupValue(record, ['pendingInfo'])],
  ];
}

function generalCustomerCopyFields() {
  return [
    ['客户状态', (record) => followupValue(record, ['customerStatus'], record.followupForm?.status_label)],
    ['客户/企业名称', (record) => record.followupForm?.company_name || record.followupForm?.customer_name || followupValue(record, ['customerName', 'companyName'])],
    ['沟通关键信息', (record) => followupValue(record, ['keyInfo', 'key_information'])],
    ['客户需求', (record) => followupValue(record, ['needs', 'need', 'requirement'])],
    ['客户顾虑', (record) => followupValue(record, ['concerns'])],
    ['下一步动作', (record) => followupValue(record, ['nextAction', 'next_action', 'action'])],
    ['待补充信息', (record) => followupValue(record, ['pendingInfo'])],
  ];
}

function followupValue(record, keys, fallback = '') {
  const followup = record.followupForm || {};
  const fields = followup.fields_json && typeof followup.fields_json === 'object' ? followup.fields_json : {};
  for (const key of keys) {
    const value = cleanCopyValue(fields[key]);
    if (value) return value;
  }
  const markdownFields = parseFollowupMarkdownFields(followup.followup_markdown || '');
  for (const key of keys) {
    const value = cleanCopyValue(markdownFields[key] || markdownFields[copyFieldAlias(key)]);
    if (value) return value;
  }
  return cleanCopyValue(fallback);
}

function parseFollowupMarkdownFields(text) {
  const fields = {};
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.trim().match(/^【([^】]+)】[:：]\s*(.*)$/);
    if (!match) continue;
    fields[match[1]] = match[2];
  }
  return fields;
}

function copyFieldAlias(key) {
  return ({
    quoteAndDealStatus: '报价金额/成交状态',
    notDealReason: '未成交原因',
    firstImpression: '第一印象',
    basicProfile: '个人基本情况',
    workIncome: '工作收入',
    assets: '资产情况',
    family: '家庭情况',
    hobbies: '兴趣爱好',
    relationshipHistory: '情感经历',
    hardRequirements: '择偶硬性条件',
    flexiblePreferences: '择偶弹性偏好',
    taboo: '忌讳点',
    personalityStrengths: '性格优点',
    personalityRisks: '性格挑战',
    serviceSuggestion: '服务匹配建议',
    nextScript: '下次跟进话术',
    pendingInfo: '待补充信息',
    customerStatus: '当前客户状态',
    companyName: '企业/客户名称',
    contactRole: '联系人/角色',
    hiringRoles: '招聘岗位',
    hiringCount: '招聘人数',
    requirements: '岗位要求',
    salaryBenefits: '薪资福利',
    wechatAdded: '是否已添加微信',
    concerns: '客户顾虑',
    nextAction: '下一步动作',
    suggestedTag: '建议标签',
    customerName: '客户/企业名称',
    keyInfo: '沟通关键信息',
    needs: '客户需求',
  })[key] || key;
}

function cleanCopyValue(value) {
  if (Array.isArray(value)) return value.map(cleanCopyValue).filter(Boolean).join('、');
  if (value && typeof value === 'object') return Object.values(value).map(cleanCopyValue).filter(Boolean).join('、');
  const text = String(value || '').trim();
  if (!text || /^(待核对|待确认|暂无|未提及|不明确|需补充)$/.test(text)) return '';
  return text;
}

function renderOverviewCard(rawCard, record) {
  const card = rawCard && typeof rawCard === 'object' ? rawCard : null;
  if (!card || !Object.keys(card).length) return '<div class="empty">生成纪要后，总结卡片会显示在这里。</div>';
  const cards = Array.isArray(card.cards) ? card.cards : Object.entries(card.keyFields || {}).map(([title, value], index) => ({
    id: `field-${index}`,
    title,
    items: [String(value || '待核对')],
    tone: ['blue', 'green', 'orange', 'purple'][index % 4],
  }));
  return `
    <section class="meeting-card">
      <div class="meeting-card-topline">
        <span>总结卡片 · ${escapeHtml(card.badge || card.template || templateLabel(record.templateType))}</span>
        <small>${escapeHtml(card.generatedByLabel || '内容由 AI 生成')}</small>
      </div>
      <div class="meeting-hero">
        <small>${escapeHtml(card.eyebrow || '录音整理')}</small>
        <h3>${escapeHtml(card.heroTitle || card.title || record.title || '录音总结')}</h3>
        ${card.heroSubtitle ? `<div class="meeting-tags">${String(card.heroSubtitle).split(/[、，,·&]+/).map((tag) => `<em>${escapeHtml(tag.trim())}</em>`).join('')}</div>` : ''}
      </div>
      <div class="meeting-card-grid">
        ${cards.map((item, index) => `
          <article class="knowledge-card tone-${escapeHtml(item.tone || 'blue')} ${item.layout ? `layout-${escapeHtml(item.layout)}` : ''} ${index === 0 ? 'is-feature' : ''}">
            <header><span>${index + 1}</span><h4>${escapeHtml(item.title || `重点 ${index + 1}`)}</h4></header>
            ${renderKnowledgeCardBody(item)}
          </article>
        `).join('')}
      </div>
    </section>
  `;
}

function renderKnowledgeCardBody(item) {
  const items = Array.isArray(item.items) ? item.items.filter(Boolean).slice(0, 6) : [];
  const blocks = Array.isArray(item.blocks) ? item.blocks : [];
  if (!blocks.length) {
    return `<ul class="knowledge-list">${items.map((value, index) => `<li><b>${index + 1}</b><span>${escapeHtml(value)}</span></li>`).join('')}</ul>`;
  }
  return `
    ${items.length ? `<div class="knowledge-card-summary">${items.slice(0, 5).map((value) => `<em>${escapeHtml(value)}</em>`).join('')}</div>` : ''}
    <div class="knowledge-blocks">
      ${blocks.map((block, blockIndex) => `
        <section class="knowledge-block tone-${escapeHtml(block.tone || item.tone || 'blue')}">
          ${block.title ? `<strong>${escapeHtml(block.title)}</strong>` : ''}
          ${Array.isArray(block.rows) && block.rows.length ? `
            <div class="knowledge-rows">
              ${block.rows.slice(0, 8).map((row) => `
                <div>
                  <span>${escapeHtml(row.label || '')}</span>
                  <b>${escapeHtml(row.value || '待核对')}</b>
                  ${row.note ? `<small>${escapeHtml(row.note)}</small>` : ''}
                </div>
              `).join('')}
            </div>
          ` : ''}
          ${Array.isArray(block.items) && block.items.length ? `
            <ul class="knowledge-list">
              ${block.items.slice(0, 8).map((value, index) => `<li><b>${index + 1}</b><span>${escapeHtml(value)}</span></li>`).join('')}
            </ul>
          ` : ''}
          ${block.note ? `<p>${escapeHtml(block.note)}</p>` : ''}
        </section>
      `).join('')}
    </div>
  `;
}

function renderMindMap(rawMindMap, options = {}) {
  const state = mindMapState(rawMindMap, appState.detail?.title || '');
  const mindMap = state.mindMap;
  if (!mindMap || !Array.isArray(mindMap.branches) || !mindMap.branches.length) {
    return options.showEmptyReason ? `<div class="empty">${escapeHtml(state.reason)}</div>` : '';
  }
  const expanded = appState.mindMapExpanded;
  return `
    <section class="mind-map-section">
      <div class="mind-map-heading">
        <div>
          <span>思维导图总结</span>
          <strong>${escapeHtml(mindMap.title || '录音思维导图')}</strong>
        </div>
        <button class="btn" type="button" data-action="toggle-mind-map">${expanded ? '收起' : '查看完整大图'}</button>
      </div>
      <div class="mind-map-viewer ${expanded ? 'is-expanded' : 'is-preview'}">
        <div class="mind-map-viewer-toolbar">
          <span>${expanded ? '完整大图' : '缩略预览'}</span>
          <button class="btn" type="button" data-action="toggle-mind-map">${expanded ? '收起' : '查看完整大图'}</button>
        </div>
        ${expanded ? '' : '<button class="mind-map-open-overlay" type="button" data-action="toggle-mind-map">查看完整大图</button>'}
        <div class="mind-map-canvas">
          <div class="mind-map-center">
            <small>中心主题</small>
            <strong>${escapeHtml(mindMap.center || '录音总结')}</strong>
          </div>
          <div class="mind-map-tree" aria-label="思维导图分支">
            ${mindMap.branches.map((branch, index) => `
              <article class="mind-map-topic tone-${escapeHtml(branch.tone || 'blue')}">
                <div class="mind-map-branch-label">
                  <span>${String(index + 1).padStart(2, '0')}</span>
                  <div>
                    <h4>${escapeHtml(branch.title || '重点分支')}</h4>
                    ${branch.summary ? `<p>${escapeHtml(branch.summary)}</p>` : ''}
                  </div>
                </div>
                <div class="mind-map-nodes">
                  ${(branch.children || []).map((child) => {
                    const leaves = mindMapLeafItems(child);
                    return `
                      <div class="mind-map-node">
                        <div class="mind-map-node-title">
                          <strong>${escapeHtml(child.title || '要点')}</strong>
                          ${(child.tags || []).length ? `<div class="mind-map-tags">${child.tags.map((tag) => `<em>${escapeHtml(tag)}</em>`).join('')}</div>` : ''}
                        </div>
                        ${leaves.length ? `<ul class="mind-map-leaves">${leaves.map((item) => `<li>${escapeHtml(item)}</li>`).join('')}</ul>` : ''}
                      </div>
                    `;
                  }).join('')}
                </div>
              </article>
            `).join('')}
          </div>
        </div>
      </div>
    </section>
  `;
}

function mindMapState(rawMindMap, fallbackTitle = '') {
  if (!rawMindMap) return { mindMap: null, reason: '暂无思维导图，重新生成总结后会显示在这里。' };
  const mindMap = normalizeMindMap(rawMindMap, fallbackTitle);
  if (!mindMap) return { mindMap: null, reason: '已生成数据结构异常，暂时无法显示思维导图。' };
  return { mindMap, reason: '' };
}

function normalizeMindMap(value, fallbackTitle = '') {
  if (!value) return null;
  const root = Array.isArray(value) ? { children: value } : value;
  if (!root || typeof root !== 'object') return null;
  const center = firstText(root.center, root.topic, root.subject, root.title, fallbackTitle, '录音总结');
  const sourceBranches = firstArray(root.branches, root.children, root.nodes);
  let branches = sourceBranches.map((branch, index) => normalizeMindMapBranch(branch, index)).filter(Boolean);
  if (!branches.length && center) {
    branches = [{
      id: 'branch-1',
      title: center,
      summary: '已生成中心主题，暂无分支节点',
      tone: 'blue',
      children: [],
    }];
  }
  if (!center && !branches.length) return null;
  return {
    title: firstText(root.title, root.name, '录音思维导图'),
    center,
    branches,
  };
}

function normalizeMindMapBranch(value, index) {
  const source = typeof value === 'string' ? { title: value } : value;
  if (!source || typeof source !== 'object') return null;
  const tones = ['blue', 'green', 'orange', 'purple', 'cyan', 'warm'];
  return {
    id: firstText(source.id, `branch-${index + 1}`),
    title: firstText(source.title, source.topic, source.label, source.name, source.text, `分支 ${index + 1}`),
    summary: firstText(source.summary, source.detail, source.description, ''),
    tone: firstText(source.tone, tones[index % tones.length]),
    children: firstArray(source.children, source.nodes, source.items)
      .map((child, childIndex) => normalizeMindMapChild(child, childIndex))
      .filter(Boolean),
  };
}

function normalizeMindMapChild(value, index) {
  if (typeof value === 'string') return { title: value, detail: '', items: [], tags: [] };
  if (!value || typeof value !== 'object') return null;
  const items = firstArray(value.items, value.children, value.nodes)
    .map((item) => {
      if (typeof item === 'string') return item;
      if (!item || typeof item !== 'object') return '';
      return firstText(item.title, item.topic, item.label, item.name, item.text, item.detail, item.summary, '');
    })
    .filter(Boolean);
  return {
    title: firstText(value.title, value.topic, value.label, value.name, value.text, `要点 ${index + 1}`),
    detail: firstText(value.detail, value.summary, value.description, ''),
    items,
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

function mindMapLeafItems(child) {
  if (!child || typeof child !== 'object') return [];
  return [child.detail, ...(Array.isArray(child.items) ? child.items : [])]
    .map((item) => String(item || '').trim())
    .filter(Boolean);
}

function resultTypeLabel(record) {
  return normalizeFollowupTypeUi(record.followupType, record.templateType) === 'none' ? '会议纪要' : '跟单信息';
}

function countReadableWords(record) {
  const summaryText = record.summary?.summary_markdown || record.followupForm?.followup_markdown || '';
  const transcriptText = record.transcript?.corrected_text || record.transcript?.raw_text || '';
  return String(summaryText || transcriptText).replace(/\s+/g, '').length;
}

function hasTranscriptContent(record) {
  return Boolean(record.transcript?.corrected_text || record.transcript?.raw_text || normalizedTranscriptSegments(record).length);
}

function hasSummaryContent(record) {
  const summary = record.summary || {};
  if (!summaryIsUsable(summary)) return false;
  return Boolean(summary.summary_markdown || summary.overview_card_json || mindMapState(summary.mind_map_json, record.title).mindMap);
}

function summaryQualityStatus(summary = {}) {
  return String(summary.quality_status || summary.qualityStatus || '');
}

function summaryIsUsable(summary = {}) {
  const status = summaryQualityStatus(summary);
  return status !== 'fallback_template' && status !== 'invalid';
}

function extractSummaryLines(markdown, keywords) {
  const lines = String(markdown || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const matched = lines.filter((line) => keywords.some((keyword) => line.includes(keyword)));
  return matched.length ? matched.join('\n') : '待核对';
}

function displayFieldValue(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join('、') || '待核对';
  if (value && typeof value === 'object') return Object.values(value).filter(Boolean).join('、') || '待核对';
  return String(value || '').trim() || '待核对';
}

function businessTypeLabel(value) {
  return ({
    recruitment: '招聘跟单',
    matchmaker: '红娘跟单',
    general_customer: '通用客户跟单',
    general: '通用跟单',
  })[value] || followupLabel(value) || '待核对';
}

function stageLabel(value) {
  const option = recruitmentStageOptions().find((item) => item.value === value);
  return option?.label || value || '待核对';
}

function normalizedTranscriptSegments(record) {
  const segments = record.transcript?.segments_json;
  if (Array.isArray(segments) && segments.length) {
    const aliases = record.transcript?.speaker_aliases_json || {};
    return segments.map((segment, index) => ({
      id: segment.id || `seg-${index + 1}`,
      startMs: Number(segment.startMs ?? segment.beginMs ?? segment.begin_time ?? 0),
      endMs: Number(segment.endMs ?? segment.end_time ?? 0),
      speaker: segment.speaker || segment.speakerAlias || '',
      speakerLabel: aliases[segment.speaker || segment.speakerAlias || ''] || segment.speakerAlias || segment.speaker || '',
      text: String(segment.text || '').trim(),
    })).filter((segment) => segment.text);
  }
  return [];
}

function renderProfile() {
  const profile = ensureProfileDraft();
  const passwordDraft = appState.passwordDraft || {};
  const profileUi = appState.profileUi || {};
  const avatarUploading = isActionBusy('avatar.upload');
  const profileSaving = isActionBusy('profile.save');
  const passwordSaving = isActionBusy('password.change');
  const departments = profile.departments?.map((item) => item.name).join(' / ') || '未分配部门';
  return `
    <div class="stack">
      <section class="glass section profile-panel">
        <div class="profile-head">
          ${renderAvatar(profile, 'large')}
          <div>
            <h2>个人资料</h2>
            <div class="meta">${escapeHtml(departments)} · ${escapeHtml(roleLabel(profile.globalRole))}</div>
          </div>
        </div>
        <form id="avatar-form" class="form">
          <div class="field">
            <label for="avatar-file">头像</label>
            <input id="avatar-file" name="avatar" type="file" accept=".png,.jpg,.jpeg,.webp,image/png,image/jpeg,image/webp">
          </div>
          <div id="avatar-file-status" class="hint avatar-file-status">
            ${profileUi.avatarFileName ? `已选择：${escapeHtml(profileUi.avatarFileName)}（${escapeHtml(formatBytes(profileUi.avatarFileSize))}）` : escapeHtml(profileUi.avatarStatus || '待选择头像文件')}
          </div>
          <button class="btn" type="button" data-action="upload-avatar" ${avatarUploading ? 'disabled' : ''}>${avatarUploading ? '上传中' : '上传头像'}</button>
          ${profileUi.avatarStatus ? `<div id="avatar-action-status" class="status ${escapeHtml(profileUi.avatarStatusType)}">${escapeHtml(profileUi.avatarStatus)}</div>` : '<div id="avatar-action-status"></div>'}
        </form>
      </section>
      <section class="glass section">
        <form id="profile-form" class="form">
          <div class="grid-2">
            <div class="field">
              <label for="profile-display-name">花名</label>
              <input id="profile-display-name" name="displayName" value="${escapeHtml(profile.displayName || '')}">
            </div>
            <div class="field">
              <label for="profile-avatar-color">头像底色</label>
              <input id="profile-avatar-color" name="avatarColor" type="color" value="${escapeHtml(profile.avatarColor || '#2e7bbd')}">
            </div>
          </div>
          <div class="field">
            <label for="profile-bio">一句话自我介绍</label>
            <input id="profile-bio" name="bio" value="${escapeHtml(profile.bio || '')}" maxlength="80" placeholder="例如：负责 AI 工具和内部效率系统">
          </div>
          <div class="field">
            <label for="profile-ai-note">AI 生成偏好</label>
            <textarea id="profile-ai-note" name="aiProfileNote" maxlength="500" placeholder="例如：我是运营部，关注需求拆解、执行步骤和责任人。会议纪要请优先输出待办和风险。">${escapeHtml(profile.aiProfileNote || '')}</textarea>
          </div>
          <button class="btn primary" type="button" data-action="save-profile" ${profileSaving ? 'disabled' : ''}>${profileSaving ? '保存中' : '保存个人资料'}</button>
          ${profileUi.profileStatus ? `<div id="profile-action-status" class="status ${escapeHtml(profileUi.profileStatusType)}">${escapeHtml(profileUi.profileStatus)}</div>` : '<div id="profile-action-status"></div>'}
        </form>
      </section>
      <section class="glass section">
        <form id="password-form" class="form">
          <h2>修改密码</h2>
          <div class="grid-2">
            <div class="field">
              <label for="old-password">旧密码</label>
              <input id="old-password" name="oldPassword" type="password" autocomplete="current-password" value="${escapeHtml(passwordDraft.oldPassword || '')}">
            </div>
            <div class="field">
              <label for="new-password">新密码</label>
              <input id="new-password" name="newPassword" type="password" autocomplete="new-password" value="${escapeHtml(passwordDraft.newPassword || '')}">
            </div>
          </div>
          <div class="field">
            <label for="confirm-password">确认新密码</label>
            <input id="confirm-password" name="confirmPassword" type="password" autocomplete="new-password" value="${escapeHtml(passwordDraft.confirmPassword || '')}">
          </div>
          <div class="btn-row">
            <button class="btn primary" type="button" data-action="change-password" ${passwordSaving ? 'disabled' : ''}>${passwordSaving ? '保存中' : '保存密码'}</button>
            <button class="btn danger" type="button" data-action="logout">退出登录</button>
          </div>
          ${profileUi.passwordStatus ? `<div id="password-action-status" class="status ${escapeHtml(profileUi.passwordStatusType)}">${escapeHtml(profileUi.passwordStatus)}</div>` : '<div id="password-action-status"></div>'}
        </form>
      </section>
    </div>
  `;
}

function ensureProfileDraft() {
  const source = appState.profile || appState.currentUser || {};
  if (!appState.profileDraft || appState.profileDraft.id !== source.id) {
    appState.profileDraft = {
      ...source,
      displayName: source.displayName || '',
      bio: source.bio || '',
      aiProfileNote: source.aiProfileNote || '',
      avatarColor: source.avatarColor || '#2e7bbd',
    };
  }
  return appState.profileDraft;
}

function updateProfileDraftFromForm(form) {
  if (!form) return;
  const current = ensureProfileDraft();
  appState.profileDraft = {
    ...current,
    displayName: form.displayName?.value || '',
    bio: form.bio?.value || '',
    aiProfileNote: form.aiProfileNote?.value || '',
    avatarColor: form.avatarColor?.value || '#2e7bbd',
  };
}

function updatePasswordDraftFromForm(form) {
  if (!form) return;
  appState.passwordDraft = {
    oldPassword: form.oldPassword?.value || '',
    newPassword: form.newPassword?.value || '',
    confirmPassword: form.confirmPassword?.value || '',
  };
}

function renderEmployees() {
  return `
    <section class="glass section stack">
      <div class="item-title">
        <h2>员工管理</h2>
        <button class="btn" data-action="refresh-employees">刷新</button>
      </div>
      <form id="employee-form" class="form">
        <div class="grid-2">
          <div class="field">
            <label for="displayName">花名</label>
            <input id="displayName" name="displayName">
          </div>
          <div class="field">
            <label for="employeeNo">工号</label>
            <input id="employeeNo" name="employeeNo" placeholder="可选">
          </div>
        </div>
        <div class="grid-2">
          <div class="field">
            <label for="departmentId">部门</label>
            ${renderEmployeeDepartmentSelect('employee-department', '')}
          </div>
          <div class="field">
            <label for="globalRole">角色</label>
            ${renderEmployeeRoleSelect('employee-role', 'employee')}
          </div>
        </div>
        <button class="btn primary" type="button" data-action="create-employee">新增员工</button>
      </form>
      <div class="employee-list">
        ${appState.employees.map((employee) => `
          <div class="item">
            <div class="item-title">
              <span>${escapeHtml(employee.displayName)}</span>
              <span class="badge ${employee.status === 'inactive' ? 'failed' : 'completed'}">${employee.status === 'inactive' ? '停用' : '启用'}</span>
            </div>
            <div class="meta">${escapeHtml(employee.globalRole)} · ${escapeHtml(employee.departments.map((item) => item.name).join(' / ') || '未分配')}</div>
            <div class="btn-row" style="margin-top:8px">
              <button class="btn" data-action="${employee.status === 'inactive' ? 'enable-employee' : 'disable-employee'}" data-id="${escapeHtml(employee.id)}">${employee.status === 'inactive' ? '恢复' : '停用'}</button>
              <button class="btn" data-action="reset-password" data-id="${escapeHtml(employee.id)}">重置密码</button>
            </div>
          </div>
        `).join('') || '<div class="empty">暂无员工数据</div>'}
      </div>
    </section>
  `;
}

function renderSettings() {
  const status = appState.systemStatus || {};
  const meta = appState.settingsMeta || {};
  return `
    <section class="glass section stack">
      <div class="item-title">
        <h2>设置中心</h2>
        <div class="btn-row">
          <button class="btn" type="button" data-action="copy-extension-diagnostics">复制扩展诊断</button>
          <button class="btn" type="button" data-action="refresh-settings">刷新</button>
        </div>
      </div>
      <div class="settings-status">
        ${renderConfigBadge('R2 存储', status.r2Configured)}
        ${renderConfigBadge('录音转文字', status.dashscopeConfigured)}
        ${renderConfigBadge('总结模型', status.llmConfigured)}
        ${renderConfigBadge('演示模式', status.devFakeAsr)}
      </div>
      <div class="meta">配置版本 ${escapeHtml(meta.settingsVersion || appState.runtime?.settingsVersion || 1)}${meta.settingsUpdatedAt ? ` · 最近更新 ${formatDate(meta.settingsUpdatedAt)}` : ''}${meta.settingsUpdatedBy ? ` · ${escapeHtml(meta.settingsUpdatedBy)}` : ''}</div>
      <div id="settings-form" class="form">
        ${(appState.settingGroups || []).map(renderSettingGroup).join('') || '<div class="empty">正在读取后台配置...</div>'}
        <div class="settings-save-bar">
          <button class="btn primary" type="button" data-action="save-settings" ${appState.busy || !appState.settingGroups.length ? 'disabled' : ''}>保存全部设置</button>
        </div>
      </div>
      ${renderLlmProviderPool()}
      ${renderSettingsSyncRules(status)}
      ${renderSettingsAuditLogs()}
    </section>
  `;
}

function renderConfigBadge(label, ok) {
  if (ok === undefined || ok === null) {
    return `<span class="badge">${escapeHtml(label)}：读取中</span>`;
  }
  return `<span class="badge ${ok ? 'completed' : 'failed'}">${escapeHtml(label)}：${ok ? '已配置' : '未配置'}</span>`;
}

function renderSettingGroup(group) {
  return `
    <div class="setting-group" data-setting-group="${escapeHtml(group.id)}">
      <div>
        <h3>${escapeHtml(group.title)}</h3>
        ${group.description ? `<div class="hint">${escapeHtml(group.description)}</div>` : ''}
      </div>
      ${(group.fields || []).map(renderSettingField).join('')}
      <div class="btn-row">
        <button class="btn" type="button" data-action="test-settings" data-target="${escapeHtml(testTargetForGroup(group.id))}">测试本组</button>
        <button class="btn primary" type="button" data-action="save-settings-group" data-group="${escapeHtml(group.id)}" ${appState.busy ? 'disabled' : ''}>保存本组</button>
      </div>
    </div>
  `;
}

function renderSettingField(field) {
  const id = `setting-${field.key}`;
  const help = [
    field.secret && field.configured ? `已保存：${field.maskedValue || '已配置'}` : '',
    field.help || '',
  ].filter(Boolean).join('；');
  if (field.type === 'select') {
    const selectedValue = String(appState.settingChoices[field.key] ?? field.value ?? field.defaultValue ?? '');
    return `
      <div class="field choice-field">
        <label for="${escapeHtml(id)}">${escapeHtml(field.label)}</label>
        <div class="secret-actions setting-choice-actions">
          ${(field.options || []).map((option) => `
            <button
              class="secret-action setting-choice ${String(option.value) === selectedValue ? 'active' : ''}"
              type="button"
              data-action="setting-choice"
              data-key="${escapeHtml(field.key)}"
              data-value="${escapeHtml(option.value)}"
              aria-pressed="${String(option.value) === selectedValue ? 'true' : 'false'}"
            >${escapeHtml(option.label)}</button>
          `).join('')}
        </div>
        <input id="${escapeHtml(id)}" data-setting-key="${escapeHtml(field.key)}" type="hidden" value="${escapeHtml(selectedValue)}">
        ${help ? `<div class="hint">${escapeHtml(help)}</div>` : ''}
      </div>
    `;
  }
  if (field.secret) {
    const action = appState.secretActions[field.key] || 'keep';
    return `
      <div class="field secret-field">
        <label for="${escapeHtml(id)}">${escapeHtml(field.label)}</label>
        <div class="secret-state">${field.configured ? `已配置：${escapeHtml(field.maskedValue || '已保存')}` : '未配置'}</div>
        <div class="secret-actions">
          ${[
            ['keep', '保持现有'],
            ['replace', '替换'],
            ['clear', '清空'],
          ].map(([value, label]) => `
            <button
              class="secret-action ${action === value ? 'active' : ''}"
              type="button"
              data-action="secret-action"
              data-key="${escapeHtml(field.key)}"
              data-value="${escapeHtml(value)}"
              aria-pressed="${action === value ? 'true' : 'false'}"
            >${escapeHtml(label)}</button>
          `).join('')}
        </div>
        <input
          id="${escapeHtml(id)}"
          data-setting-key="${escapeHtml(field.key)}"
          data-secret="1"
          type="password"
          value=""
          placeholder="选择“替换”后输入新密钥"
          ${action === 'replace' ? '' : 'disabled'}
        >
        ${help ? `<div class="hint">${escapeHtml(help)}</div>` : ''}
      </div>
    `;
  }
  return `
    <div class="field">
      <label for="${escapeHtml(id)}">${escapeHtml(field.label)}</label>
      <input
        id="${escapeHtml(id)}"
        data-setting-key="${escapeHtml(field.key)}"
        data-secret="0"
        type="${field.type === 'number' ? 'number' : 'text'}"
        value="${escapeHtml(field.value || '')}"
      >
      ${help ? `<div class="hint">${escapeHtml(help)}</div>` : ''}
    </div>
  `;
}

function renderLlmProviderPool() {
  const providers = appState.llmProviders || [];
  const presets = appState.llmProviderPresets || [];
  return `
    <section class="llm-provider-section">
      <div class="item-title">
        <div>
          <h3>总结模型池</h3>
          <div class="hint">按列表顺序调用，可用上移/下移调整；API Key 只保存在后端。</div>
        </div>
        <button class="btn primary" type="button" data-action="new-llm-provider">新增模型</button>
      </div>
      <div class="llm-preset-row">
        ${presets.map((preset) => `
          <button class="secret-action" type="button" data-action="new-llm-provider" data-preset-id="${escapeHtml(preset.id)}">${escapeHtml(preset.displayName)}</button>
        `).join('')}
      </div>
      ${providers.length ? `
        <div class="llm-provider-list">
          ${providers.map((provider, index) => renderLlmProviderRow(provider, index, providers.length)).join('')}
        </div>
      ` : '<div class="empty">暂无模型，请选择模板新增。</div>'}
      ${appState.llmProviderDraft ? renderLlmProviderForm(appState.llmProviderDraft) : ''}
    </section>
  `;
}

function renderLlmProviderRow(provider, index, total) {
  const testLabel = provider.lastTestStatus ? `${provider.lastTestStatus === 'passed' ? '成功' : '失败'}${provider.lastTestAt ? ` · ${formatDate(provider.lastTestAt)}` : ''}` : '未测试';
  const callLabel = provider.lastCallStatus ? `${provider.lastCallStatus === 'success' ? '成功' : '失败'}${provider.lastCallAt ? ` · ${formatDate(provider.lastCallAt)}` : ''}` : '未调用';
  return `
    <article class="llm-provider-row">
      <div class="llm-provider-main">
        <div class="item-title compact">
          <strong>${escapeHtml(provider.displayName || provider.providerKey)}</strong>
          <span class="badge ${provider.enabled ? 'completed' : ''}">第 ${index + 1} 个 · ${provider.enabled ? '启用' : '停用'}</span>
        </div>
        <div class="meta">${escapeHtml(provider.protocol)} · ${escapeHtml(provider.baseUrl)} · ${escapeHtml(provider.requestModel)}</div>
        <div class="meta">Key ${provider.configured ? escapeHtml(provider.maskedApiKey || '已保存') : '未配置'} · 最近测试 ${escapeHtml(testLabel)} · 最近调用 ${escapeHtml(callLabel)}</div>
        ${provider.lastTestMessage ? `<div class="hint">${escapeHtml(provider.lastTestMessage)}</div>` : ''}
        ${provider.lastCallMessage ? `<div class="hint">${escapeHtml(provider.lastCallMessage)}</div>` : ''}
      </div>
      <div class="llm-provider-actions">
        <button class="btn" type="button" data-action="move-llm-provider" data-id="${escapeHtml(provider.id)}" data-direction="up" ${index === 0 ? 'disabled' : ''}>上移排序</button>
        <button class="btn" type="button" data-action="move-llm-provider" data-id="${escapeHtml(provider.id)}" data-direction="down" ${index === total - 1 ? 'disabled' : ''}>下移排序</button>
        <button class="btn" type="button" data-action="edit-llm-provider" data-id="${escapeHtml(provider.id)}">编辑</button>
        <button class="btn" type="button" data-action="test-existing-llm-provider" data-id="${escapeHtml(provider.id)}">测试</button>
        <button class="btn" type="button" data-action="toggle-llm-provider" data-id="${escapeHtml(provider.id)}" data-enabled="${provider.enabled ? '0' : '1'}">${provider.enabled ? '停用' : '启用'}</button>
        <button class="btn danger" type="button" data-action="delete-llm-provider" data-id="${escapeHtml(provider.id)}">删除</button>
      </div>
    </article>
  `;
}

function renderLlmProviderForm(draft) {
  const isEditing = Boolean(draft.id);
  return `
    <div class="llm-provider-form" id="llm-provider-form">
      <div class="item-title compact">
        <h3>${isEditing ? '编辑模型' : '新增模型'}</h3>
        <button class="btn ghost" type="button" data-action="cancel-llm-provider">取消</button>
      </div>
      <input id="llm-provider-id" type="hidden" value="${escapeHtml(draft.id || '')}">
      <div class="grid-2">
        <div class="field">
          <label for="llm-provider-protocol">协议</label>
          <select id="llm-provider-protocol">
            ${['openai-responses', 'openai-chat', 'anthropic-messages', 'gemini-native'].map((protocol) => `
              <option value="${escapeHtml(protocol)}" ${draft.protocol === protocol ? 'selected' : ''}>${escapeHtml(protocol)}</option>
            `).join('')}
          </select>
        </div>
        ${renderLlmInput('llm-provider-base-url', 'Base URL', draft.baseUrl)}
        ${renderLlmInput('llm-provider-request-model', '模型名称', draft.requestModel)}
        <div class="field">
          <label for="llm-provider-reasoning-effort">Reasoning Effort</label>
          <select id="llm-provider-reasoning-effort">
            ${['low', 'medium', 'high', 'xhigh'].map((effort) => `
              <option value="${escapeHtml(effort)}" ${String(draft.reasoningEffort || 'high') === effort ? 'selected' : ''}>${escapeHtml(effort)}</option>
            `).join('')}
          </select>
        </div>
      </div>
      <div class="field secret-field">
        <label for="llm-provider-api-key">API Key</label>
        <div class="secret-state">${draft.configured ? `已配置：${escapeHtml(draft.maskedApiKey || '已保存')}` : '未配置'}</div>
        <input id="llm-provider-api-key" type="password" value="" placeholder="${draft.configured ? '留空则保留现有密钥' : '输入模型 API Key'}">
      </div>
      ${draft.testMessage ? `<div class="status ${draft.testStatus === 'passed' ? 'success' : 'error'}">${escapeHtml(draft.testMessage)}</div>` : ''}
      <div class="btn-row">
        <button class="btn" type="button" data-action="test-llm-provider" ${appState.busy ? 'disabled' : ''}>测试连接</button>
        <button class="btn primary" type="button" data-action="save-llm-provider" ${appState.busy ? 'disabled' : ''}>保存模型</button>
      </div>
    </div>
  `;
}

function renderLlmInput(id, label, value, type = 'text') {
  return `
    <div class="field">
      <label for="${escapeHtml(id)}">${escapeHtml(label)}</label>
      <input id="${escapeHtml(id)}" type="${escapeHtml(type)}" value="${escapeHtml(value ?? '')}">
    </div>
  `;
}

function renderSettingsAuditLogs() {
  const logs = (appState.auditLogs || [])
    .filter((log) => ['system_settings', 'llm_provider'].includes(log.targetType))
    .slice(0, 50);
  return `
    <section class="settings-audit">
      <div class="item-title">
        <h3>配置修改记录</h3>
        <span class="meta">最近 ${logs.length} 条</span>
      </div>
      ${logs.length ? `
        <div class="settings-audit-list">
          ${logs.map((log) => `
            <div class="settings-audit-row">
              <strong>${escapeHtml(auditActionLabel(log.action))}</strong>
              <span>${escapeHtml(formatDate(log.createdAt))}</span>
              <span>${escapeHtml(log.actorName || log.actorEmployeeId || '系统')}</span>
              <span>${escapeHtml(log.targetId || '')}</span>
            </div>
          `).join('')}
        </div>
      ` : '<div class="empty">暂无配置修改记录</div>'}
    </section>
  `;
}

function auditActionLabel(action) {
  return ({
    update_system_settings: '保存设置',
    test_system_settings: '测试设置',
    create_llm_provider: '新增模型',
    update_llm_provider: '修改模型',
    test_llm_provider: '测试模型',
    reorder_llm_providers: '调整模型优先级',
    delete_llm_provider: '删除模型',
  })[action] || action || '操作';
}

function renderRecruitmentStageOptions(selected) {
  return renderChoiceControl('followup-stage', 'stage', recruitmentStageOptions(), selected || '');
}

function recruitmentStageOptions() {
  return [
    { value: '', label: '未判断/不适用' },
    { value: 'initial_effective_followup', label: '初期有效跟进' },
    { value: 'mid_effective_followup', label: '中期有效跟进' },
    { value: 'no_hiring_followup', label: '暂不招人有效跟进' },
    { value: 'mid_late_effective_followup', label: '中后期有效跟进' },
    { value: 'late_effective_followup', label: '后期有效跟进' },
  ];
}

function renderTemplateSelect(id, selected) {
  const templates = appState.templates.length ? appState.templates : [
    { value: 'meeting_minutes', label: '推理总结' },
    { value: 'meeting_comprehensive_expert', label: '会议总结全面专家' },
    { value: 'meeting_secretary', label: '会议秘书' },
    { value: 'smart_summary', label: '智能摘要' },
    { value: 'phone_discussion', label: '电话讨论' },
    { value: 'business_review', label: '业务复盘' },
    { value: 'customer_follow_up', label: '通用客户跟进' },
    { value: 'matchmaker_profile', label: '红娘客户画像' },
    { value: 'recruitment_followup', label: '招聘客户跟进' },
  ];
  return renderNativeSelect(id, 'templateType', templates, selected);
}

function renderFollowupSelect(id, selected) {
  const options = appState.followupOptions.length ? appState.followupOptions : [
    { value: 'none', label: '不生成跟单' },
    { value: 'general_customer', label: '通用客户跟单' },
    { value: 'matchmaker', label: '红娘跟单/画像字段' },
    { value: 'recruitment', label: '招聘跟单' },
  ];
  return renderNativeSelect(id, 'followupType', options, selected);
}

function renderProcessingPicker(prefix, selectedTemplate, selectedFollowup) {
  const state = processingPickerState(prefix, selectedTemplate, selectedFollowup);
  const meetingOptions = meetingTemplateOptionsForPicker();
  const followupOptions = followupOptionsForPicker();
  return `
    <div class="processing-picker" data-processing-prefix="${escapeHtml(prefix)}">
      <div class="processing-mode-grid">
        ${renderProcessingModeCard(prefix, 'meeting', '会议纪要', '适合会议记录、要点总结、待办事项整理', state.mode === 'meeting')}
        ${renderProcessingModeCard(prefix, 'followup', '跟单信息', '适合跟进记录、客户沟通、商机整理', state.mode === 'followup')}
      </div>
      ${state.mode === 'followup' ? `
        <div class="field processing-subfield">
          <label for="${escapeHtml(prefix)}-followup-select">跟单类型</label>
          ${renderNativeSelect(`${prefix}-followup-select`, 'followupTypeSelect', followupOptions, state.followupType, {
            dataAction: 'followup-type-select',
            dataPrefix: prefix,
          })}
        </div>
      ` : `
        <div class="field processing-subfield">
          <label for="${escapeHtml(prefix)}-template-select">总结模板</label>
          ${renderNativeSelect(`${prefix}-template-select`, 'templateTypeSelect', meetingOptions, state.templateType, {
            dataAction: 'template-type-select',
            dataPrefix: prefix,
          })}
        </div>
      `}
      <input id="${escapeHtml(prefix)}-template" name="templateType" type="hidden" value="${escapeHtml(state.templateType)}">
      <input id="${escapeHtml(prefix)}-followup" name="followupType" type="hidden" value="${escapeHtml(state.followupType)}">
    </div>
  `;
}

function renderProcessingModeCard(prefix, mode, title, description, selected) {
  return `
    <button
      class="processing-mode-card ${selected ? 'active' : ''}"
      type="button"
      data-action="processing-mode-choice"
      data-prefix="${escapeHtml(prefix)}"
      data-mode="${escapeHtml(mode)}"
      aria-pressed="${selected ? 'true' : 'false'}"
    >
      <span class="processing-mode-icon" aria-hidden="true">${mode === 'meeting' ? '□' : '◇'}</span>
      <span>
        <strong>${escapeHtml(title)}</strong>
        <em>${escapeHtml(description)}</em>
      </span>
      ${selected ? '<b aria-hidden="true">✓</b>' : ''}
    </button>
  `;
}

function renderNativeSelect(id, name, options, selected, attrs = {}) {
  const selectedValue = String(appState.processingChoices[id] ?? selected ?? options[0]?.value ?? '');
  const extraAttrs = [
    attrs.dataAction ? `data-action="${escapeHtml(attrs.dataAction)}"` : '',
    attrs.dataPrefix ? `data-prefix="${escapeHtml(attrs.dataPrefix)}"` : '',
  ].filter(Boolean).join(' ');
  return `
    <select id="${escapeHtml(id)}" name="${escapeHtml(name)}" ${extraAttrs}>
      ${options.map((option) => `
        <option value="${escapeHtml(option.value)}" ${String(option.value) === selectedValue ? 'selected' : ''}>${escapeHtml(option.label)}</option>
      `).join('')}
    </select>
  `;
}

function processingPickerState(prefix, selectedTemplate, selectedFollowup) {
  const templateChoice = String(appState.processingChoices[`${prefix}-template`] ?? selectedTemplate ?? currentTemplateType());
  const rawFollowup = String(appState.processingChoices[`${prefix}-followup`] ?? selectedFollowup ?? followupTypeForTemplateUi(templateChoice));
  const normalizedFollowup = normalizeFollowupTypeUi(rawFollowup, templateChoice);
  const mode = normalizedFollowup === 'none' ? 'meeting' : 'followup';
  const fallbackFollowup = preferredFollowupTypeUi();
  const followupType = mode === 'meeting' ? 'none' : (normalizeFollowupTypeUi(normalizedFollowup, templateChoice) === 'none' ? fallbackFollowup : normalizedFollowup);
  const templateType = mode === 'meeting' ? normalizeMeetingTemplateType(templateChoice) : templateTypeForFollowupUi(followupType);
  return { mode, templateType, followupType };
}

function meetingTemplateOptionsForPicker() {
  const templates = appState.templates.length ? appState.templates : [
    { value: 'meeting_minutes', label: '推理总结' },
    { value: 'meeting_comprehensive_expert', label: '会议总结全面专家' },
    { value: 'meeting_secretary', label: '会议秘书' },
    { value: 'smart_summary', label: '智能摘要' },
    { value: 'phone_discussion', label: '电话讨论' },
  ];
  return templates.filter((option) => MEETING_TEMPLATE_VALUES.has(option.value));
}

function followupOptionsForPicker() {
  const options = appState.followupOptions.length ? appState.followupOptions : [
    { value: 'general_customer', label: '通用客户跟单' },
    { value: 'matchmaker', label: '红娘跟单/画像字段' },
    { value: 'recruitment', label: '招聘跟单' },
  ];
  return options.filter((option) => option.value !== 'none');
}

function preferredFollowupTypeUi() {
  const current = normalizeFollowupTypeUi(currentFollowupType(), currentTemplateType());
  return current === 'none' ? 'general_customer' : current;
}

function preferredMeetingTemplateType() {
  return normalizeMeetingTemplateType(appState.preferredTemplateType || appState.defaultTemplate || 'meeting_minutes');
}

function normalizeMeetingTemplateType(value) {
  return MEETING_TEMPLATE_VALUES.has(String(value || '')) ? String(value) : 'meeting_minutes';
}

function normalizeFollowupTypeUi(value, fallbackTemplateType = '') {
  const allowed = new Set(['none', 'general_customer', 'matchmaker', 'recruitment']);
  const type = String(value || '').trim();
  if (allowed.has(type)) return type;
  return followupTypeForTemplateUi(fallbackTemplateType);
}

function followupTypeForTemplateUi(templateType) {
  if (templateType === 'matchmaker_profile') return 'matchmaker';
  if (templateType === 'recruitment_followup') return 'recruitment';
  if (templateType === 'customer_follow_up') return 'general_customer';
  return 'none';
}

function currentExtensionVersion() {
  return chromeApi?.runtime?.getManifest?.().version || appState.runtime?.version || '0.0.0';
}

function compareVersions(left, right) {
  const a = String(left || '0').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const b = String(right || '0').split('.').map((part) => Number.parseInt(part, 10) || 0);
  const length = Math.max(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    if ((a[index] || 0) > (b[index] || 0)) return 1;
    if ((a[index] || 0) < (b[index] || 0)) return -1;
  }
  return 0;
}

function isExtensionMustUpdate() {
  return Boolean(appState.extensionUpdate?.mustUpdate);
}

function downloadExtensionUpdate() {
  const url = appState.extensionUpdate?.downloadUrl || '';
  if (!url) return;
  const filename = `voice-to-word-extension-${appState.extensionUpdate.latestVersion || 'latest'}.zip`;
  if (chromeApi?.downloads?.download) {
    chromeApi.downloads.download({ url, filename: sanitizeFileName(filename), saveAs: true });
    return;
  }
  const link = document.createElement('a');
  link.href = url;
  link.download = sanitizeFileName(filename);
  link.click();
}

function templateTypeForFollowupUi(followupType) {
  if (followupType === 'matchmaker') return 'matchmaker_profile';
  if (followupType === 'recruitment') return 'recruitment_followup';
  if (followupType === 'general_customer') return 'customer_follow_up';
  return 'meeting_minutes';
}

function renderEmployeeDepartmentSelect(id, selected) {
  const options = [
    { value: '', label: '管理层/待分配' },
    ...appState.departments.map((department) => ({ value: department.id, label: department.name })),
  ];
  return renderChoiceControl(id, 'departmentId', options, selected);
}

function renderEmployeeRoleSelect(id, selected) {
  return renderChoiceControl(id, 'globalRole', [
    { value: 'employee', label: '普通员工' },
    { value: 'department_lead', label: '部门领导' },
    { value: 'admin', label: '管理员' },
    { value: 'boss', label: '老板' },
  ], selected);
}

function renderChoiceControl(id, name, options, selected) {
  const selectedValue = String(appState.processingChoices[id] ?? selected ?? options[0]?.value ?? '');
  return `
    <div class="choice-select" data-choice-id="${escapeHtml(id)}">
      <div class="secret-actions choice-select-actions">
      ${options.map((option) => `
          <button
            class="secret-action choice-select-option ${String(option.value) === selectedValue ? 'active' : ''}"
            type="button"
            data-action="processing-choice"
            data-choice-id="${escapeHtml(id)}"
            data-value="${escapeHtml(option.value)}"
            aria-pressed="${String(option.value) === selectedValue ? 'true' : 'false'}"
          >${escapeHtml(option.label)}</button>
      `).join('')}
      </div>
      <input id="${escapeHtml(id)}" name="${escapeHtml(name)}" type="hidden" value="${escapeHtml(selectedValue)}">
    </div>
  `;
}

function onClick(selector, handler) {
  document.querySelectorAll(selector).forEach((node) => {
    node.addEventListener('click', async (event) => {
      event?.preventDefault?.();
      event?.stopPropagation?.();
      try {
        await handler(event, node);
      } catch (error) {
        reportClientError(error, {
          selector,
          action: node.dataset?.action || node.dataset?.view || '',
        });
      }
    });
  });
}

function onSubmit(form, handler, context = {}) {
  if (!form) return;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await handler(event, form);
    } catch (error) {
      reportClientError(error, context);
    }
  });
}

function bindLogin() {
  const form = document.getElementById('login-form');
  if (!form) return;
  const handleLogin = async (event) => {
    event.preventDefault();
    if (appState.busy) return;
    const data = new FormData(form);
    appState.loginNameDraft = String(data.get('loginName') || '').trim();
    appState.apiBaseUrl = String(data.get('apiBaseUrl') || DEFAULT_API_BASE_URL).trim();
    await storageSet({ apiBaseUrl: appState.apiBaseUrl });
    setStatus('正在登录...', '');
    await runBusy(async () => {
      const body = await api('/api/auth/login', {
        method: 'POST',
        body: {
          loginName: appState.loginNameDraft,
          password: String(data.get('password') || ''),
        },
        skipAuth: true,
      });
      appState.accessToken = body.accessToken;
      appState.currentUser = body.employee;
      appState.loginNameDraft = '';
      await storageSet({ accessToken: body.accessToken, currentUser: body.employee, apiBaseUrl: appState.apiBaseUrl });
      await loadMe();
      await loadRuntimeSafe();
      await loadExtensionUpdateSafe();
      await loadDepartments();
      await loadRecords();
      setStatus('登录成功', 'success');
      appState.view = 'home';
    }, true);
  };
  onSubmit(form, handleLogin, { action: 'login.submit' });
  form.querySelector('[data-action="login-submit"]')?.addEventListener('click', async (event) => {
    event.preventDefault();
    event.stopPropagation();
    try {
      await handleLogin(event);
    } catch (error) {
      reportClientError(error, { action: 'login.submit' });
    }
  });
}

function bindCommon() {
  onClick('button[data-view]', async (_event, button) => {
    const nextView = button.dataset.view;
    appState.view = nextView;
    render();
    if (nextView === 'employees') {
      await loadEmployeesSafe();
      render();
    }
    if (nextView === 'profile') {
      await loadProfileSafe();
      render();
    }
    if (nextView === 'capture') {
      await loadBackgroundStateSafe();
      if (!appState.scanActive && !appState.candidates.length) {
        await scanPage({ keepCandidates: true });
      } else {
        render();
      }
    }
    if (nextView === 'settings') {
      await loadSettingsSafe();
      render();
    }
  });

  onClick('button[data-action="logout"]', () => logout(true));
  onClick('button[data-action="copy-client-diagnostics"]', copyClientDiagnostics);
  onClick('button[data-action="clear-client-errors"]', clearClientErrors);
  onClick('button[data-action="refresh-extension-update"]', async () => {
    await loadExtensionUpdateSafe();
    render();
  });
  onClick('button[data-action="download-extension-update"]', () => downloadExtensionUpdate());
}

function bindCurrentView() {
  onClick('button[data-action="scan-page"]', (event) => scanPage({
    keepCandidates: event?.currentTarget?.dataset?.keepCandidates === '1',
    reset: event?.currentTarget?.dataset?.reset === '1',
  }));
  onClick('button[data-action="upload-candidate"]', (_event, button) => uploadCandidate(Number(button.dataset.index)));
  onClick('button[data-action="open-duplicate-record"]', (_event, button) => openDuplicateRecord(Number(button.dataset.index)));
  onClick('button[data-action="force-upload-candidate"]', (_event, button) => forceUploadCandidate(Number(button.dataset.index)));
  onClick('button[data-action="retry-candidate-upload"]', (_event, button) => retryCandidateUpload(Number(button.dataset.index)));
  onClick('button[data-action="manual-upload-from-candidate"]', (_event, button) => openManualUploadFromCandidate(Number(button.dataset.index)));
  onClick('button[data-action="copy-candidate-diagnostics"]', (_event, button) => copyCandidateDiagnostics(Number(button.dataset.index)));

  document.querySelectorAll('[data-candidate-title]').forEach((input) => {
    input.addEventListener('input', () => {
      appState.candidateTitleDrafts[input.dataset.candidateTitle] = input.value;
    });
  });

  const uploadForm = document.getElementById('upload-form');
  onSubmit(uploadForm, uploadManualFile, { action: 'upload.manual' });
  onClick('button[data-action="upload-manual"]', uploadManualFile);
  const uploadTitle = document.getElementById('upload-title');
  if (uploadTitle) uploadTitle.addEventListener('input', () => {
    appState.uploadDraft.title = uploadTitle.value;
  });
  const audioFile = document.getElementById('audioFile');
  if (audioFile) audioFile.addEventListener('change', handleManualFileChange);

  onClick('[data-action="open-record"]', (_event, item) => openRecord(item.dataset.id));

  onClick('button[data-action="refresh-records"]', async () => {
    await loadRecordsSafe();
    render();
  });

  onClick('button[data-action="history-filter"]', (_event, button) => {
    appState.historyFilter = button.dataset.filter || 'all';
    appState.selectedRecordIds = {};
    render();
  });

  onClick('button[data-action="history-group"]', (_event, button) => {
    appState.historyGroupBy = button.dataset.group || 'auto';
    appState.historyExpandedGroups = {};
    appState.selectedRecordIds = {};
    render();
  });

  onClick('button[data-action="toggle-history-group"]', (_event, button) => {
    const id = button.dataset.groupId || '';
    appState.historyExpandedGroups[id] = button.dataset.expanded !== '1';
    render();
  });

  document.querySelectorAll('[data-record-select]').forEach((input) => {
    input.addEventListener('change', () => {
      appState.selectedRecordIds[input.dataset.recordSelect] = input.checked;
      render();
    });
  });

  const historySearch = document.getElementById('history-search');
  if (historySearch) historySearch.addEventListener('input', (event) => {
    const value = event.currentTarget.value;
    appState.historyQuery = value;
    render();
    const nextInput = document.getElementById('history-search');
    nextInput?.focus?.();
    nextInput?.setSelectionRange?.(value.length, value.length);
  });

  onClick('button[data-action="archive-record"]', (_event, button) => deleteRecord(button.dataset.id, 'archive'));
  onClick('button[data-action="purge-record"]', (_event, button) => deleteRecord(button.dataset.id, 'purge'));
  onClick('button[data-action="bulk-archive-records"]', () => bulkDeleteRecords('archive'));
  onClick('button[data-action="bulk-purge-records"]', () => bulkDeleteRecords('purge'));

  onClick('button[data-tab]', (_event, button) => {
    appState.detailTab = button.dataset.tab;
    render();
  });

  onClick('button[data-detail-tab]', (_event, button) => {
    appState.detailTab = button.dataset.detailTab || 'summary';
    render();
  });

  onClick('button[data-action="toggle-detail-panel"]', (_event, button) => {
    if (!appState.detail) return;
    toggleDetailPanel(appState.detail.id, button.dataset.panel || appState.detailTab);
    render();
  });

  onClick('button[data-action="edit-title"]', () => {
    appState.titleEditing = true;
    appState.titleDraft = appState.detail?.title || '';
    render();
  });

  onClick('button[data-action="cancel-title"]', () => {
    appState.titleEditing = false;
    appState.titleDraft = null;
    render();
  });

  onClick('button[data-action="save-title"]', saveRecordTitle);
  const recordUserForm = document.getElementById('record-user-form');
  onSubmit(recordUserForm, saveRecordUserId, { action: 'record.user_id.save' });
  onClick('button[data-action="save-record-user-id"]', saveRecordUserId);

  const noteForm = document.getElementById('note-form');
  onSubmit(noteForm, saveNote, { action: 'note.save' });
  onClick('button[data-action="save-note"]', saveNote);

  const followupForm = document.getElementById('followup-form');
  onSubmit(followupForm, saveFollowup, { action: 'followup.save' });
  onClick('button[data-action="save-followup"]', saveFollowup);

  onClick('button[data-action="summarize-record"]', summarizeRecord);

  onClick('button[data-action="copy-summary"]', async () => {
    const text = appState.detail?.summary?.summary_markdown || '';
    if (!text) return;
    await copyText(text);
    setStatus('总结已复制', 'success');
    render();
  });
  onClick('button[data-action="copy-followup"]', copyFollowup);

  onClick('button[data-action="transcribe-record"]', transcribeRecord);

  onClick('button[data-action="open-share-panel"]', openSharePanel);
  onClick('button[data-action="close-share-panel"]', () => {
    appState.sharePanelOpen = false;
    appState.shareStatus = '';
    render();
  });
  onClick('button[data-action="refresh-share-links"]', refreshShareLinks);
  onClick('button[data-action="create-share-link"]', createShareLink);
  onClick('button[data-action="copy-share-link"]', async (_event, button) => {
    if (!button.dataset.url) return;
    await copyText(button.dataset.url);
    appState.shareStatus = '分享链接已复制';
    appState.shareStatusType = 'success';
    render();
  });
  onClick('button[data-action="revoke-share-link"]', (_event, button) => revokeShareLink(button.dataset.id || ''));

  const transcriptSearch = document.getElementById('transcript-search');
  if (transcriptSearch) transcriptSearch.addEventListener('input', (event) => {
    appState.transcriptQuery = event.currentTarget.value;
    appState.transcriptVisibleCount = TRANSCRIPT_RENDER_BATCH;
    render();
  });

  const audio = document.getElementById('record-audio');
  if (audio) audio.addEventListener('timeupdate', () => {
    updateActiveTranscriptSegment(Math.round(audio.currentTime * 1000));
  });
  if (audio) audio.addEventListener('error', () => {
    appState.audioError = '浏览器无法播放该格式，可下载录音后播放，或重新上传常见 MP3/M4A 文件。';
    setStatus(appState.audioError, 'error');
    render();
  });

  document.querySelectorAll('.transcript-list').forEach((list) => {
    list.addEventListener('click', (event) => {
      if (event.target.closest?.('[data-action="edit-speaker"], [data-action="save-speaker"], [data-action="cancel-speaker"], .speaker-popover')) return;
      const item = event.target.closest?.('[data-action="seek-segment"]');
      if (!item || !list.contains(item)) return;
      event.stopPropagation();
      seekTranscriptSegment(item.dataset.id, Number(item.dataset.startMs || 0));
    });
    list.addEventListener('keydown', (event) => {
      if (!['Enter', ' '].includes(event.key)) return;
      const item = event.target.closest?.('[data-action="seek-segment"]');
      if (!item || !list.contains(item)) return;
      event.preventDefault();
      seekTranscriptSegment(item.dataset.id, Number(item.dataset.startMs || 0));
    });
  });

  onClick('button[data-action="edit-speaker"]', (_event, button) => {
    appState.speakerEditing = {
      speaker: button.dataset.speaker || '',
      segmentId: button.dataset.id || '',
      value: button.dataset.label === button.dataset.speaker ? '' : (button.dataset.label || ''),
    };
    render();
    document.getElementById('speaker-alias-input')?.focus();
  });

  onClick('button[data-action="cancel-speaker"]', () => {
    appState.speakerEditing = null;
    render();
  });

  onClick('button[data-action="save-speaker"]', (_event, button) => saveSpeakerAlias(button.dataset.speaker || ''));

  onClick('button[data-action="show-more-transcript"]', () => {
    appState.transcriptVisibleCount += TRANSCRIPT_RENDER_BATCH;
    render();
  });

  onClick('button[data-action="toggle-mind-map"]', () => {
    appState.mindMapExpanded = !appState.mindMapExpanded;
    render();
  });

  onClick('button[data-action="export-direct"]', (_event, button) => {
    if (button.disabled) return;
    exportRecord(button.dataset.target, button.dataset.format);
  });

  onClick('button[data-action="copy-processing-diagnostics"]', copyProcessingDiagnostics);

  onClick('button[data-action="export-record"]', (_event, button) => exportRecord(button.dataset.target, button.dataset.format));

  onClick('button[data-action="export-selected"]', (_event, button) => exportSelectedRecord(button.dataset.target || 'summary'));

  const employeeForm = document.getElementById('employee-form');
  onSubmit(employeeForm, createEmployee, { action: 'employee.create' });
  onClick('button[data-action="create-employee"]', createEmployee);

  onClick('button[data-action="refresh-employees"]', async () => {
    await loadEmployeesSafe();
    render();
  });

  onClick('button[data-action="disable-employee"], button[data-action="enable-employee"], button[data-action="reset-password"]', (_event, button) => employeeAction(button.dataset.id, button.dataset.action));

  onClick('button[data-action="save-settings"]', saveSettings);

  onClick('button[data-action="save-settings-group"]', (event, button) => saveSettings(event, button.dataset.group || ''));

  onClick('button[data-action="secret-action"]', (_event, button) => {
    appState.secretActions[button.dataset.key] = button.dataset.value;
    render();
    if (button.dataset.value === 'replace') {
      document.getElementById(`setting-${button.dataset.key}`)?.focus();
    }
  });

  onClick('button[data-action="setting-choice"]', (_event, button) => {
    appState.settingChoices[button.dataset.key] = button.dataset.value;
    render();
  });

  onClick('button[data-action="processing-choice"]', (_event, button) => {
    const choiceId = button.dataset.choiceId;
    const value = button.dataset.value;
    appState.processingChoices[choiceId] = value;
    const root = button.closest('.choice-select');
    root?.querySelectorAll('[data-action="processing-choice"]').forEach((item) => {
      const active = item.dataset.value === value;
      item.classList.toggle('active', active);
      item.setAttribute('aria-pressed', active ? 'true' : 'false');
    });
    const input = document.getElementById(choiceId);
    if (input) input.value = value;
  });

  onClick('button[data-action="processing-mode-choice"]', (_event, button) => setProcessingModeChoice(button.dataset.prefix || '', button.dataset.mode || 'meeting'));

  document.querySelectorAll('[data-action="template-type-select"]').forEach((select) => {
    select.addEventListener('change', () => {
      setProcessingTemplateChoice(select.dataset.prefix || '', select.value || 'meeting_minutes');
    });
  });

  document.querySelectorAll('[data-action="followup-type-select"]').forEach((select) => {
    select.addEventListener('change', () => {
      setProcessingFollowupChoice(select.dataset.prefix || '', select.value || 'general_customer');
    });
  });

  onClick('button[data-action="test-settings"]', (_event, button) => testSettings(button.dataset.target));
  onClick('button[data-action="copy-extension-diagnostics"]', copyExtensionDiagnostics);

  onClick('button[data-action="refresh-settings"]', async () => {
    await loadSettingsSafe();
    render();
  });

  onClick('button[data-action="new-llm-provider"]', (_event, button) => {
    startLlmProviderDraft(button.dataset.presetId || '');
    render();
  });
  onClick('button[data-action="edit-llm-provider"]', (_event, button) => {
    editLlmProviderDraft(button.dataset.id);
    render();
  });
  onClick('button[data-action="cancel-llm-provider"]', () => {
    appState.llmProviderDraft = null;
    render();
  });
  onClick('button[data-action="test-llm-provider"]', testLlmProviderDraft);
  onClick('button[data-action="save-llm-provider"]', saveLlmProviderDraft);
  onClick('button[data-action="test-existing-llm-provider"]', (_event, button) => testExistingLlmProvider(button.dataset.id));
  onClick('button[data-action="toggle-llm-provider"]', (_event, button) => toggleLlmProvider(button.dataset.id, button.dataset.enabled === '1'));
  onClick('button[data-action="move-llm-provider"]', (_event, button) => moveLlmProvider(button.dataset.id, button.dataset.direction));
  onClick('button[data-action="delete-llm-provider"]', (_event, button) => deleteLlmProvider(button.dataset.id));

  const profileForm = document.getElementById('profile-form');
  onSubmit(profileForm, saveProfile, { action: 'profile.save' });
  if (profileForm) profileForm.addEventListener('input', () => updateProfileDraftFromForm(profileForm));
  if (profileForm) profileForm.addEventListener('change', () => updateProfileDraftFromForm(profileForm));
  onClick('button[data-action="save-profile"]', saveProfile);

  const avatarForm = document.getElementById('avatar-form');
  onSubmit(avatarForm, uploadAvatar, { action: 'avatar.upload' });
  const avatarFile = document.getElementById('avatar-file');
  if (avatarFile) avatarFile.addEventListener('change', handleAvatarFileChange);
  onClick('button[data-action="upload-avatar"]', uploadAvatar);

  const passwordForm = document.getElementById('password-form');
  onSubmit(passwordForm, changePassword, { action: 'password.change' });
  if (passwordForm) passwordForm.addEventListener('input', () => updatePasswordDraftFromForm(passwordForm));
  onClick('button[data-action="change-password"]', changePassword);
}

async function scanPage(options = {}) {
  setStatus(options.reset ? '正在重新监听当前网页...' : '正在扫描当前网页...', '');
  if (!options.keepCandidates) appState.candidates = [];
  appState.scanActive = true;
  appState.scanStartedAt = new Date().toISOString();
  scheduleScanEmptyHint();
  render();
  if (!chromeApi?.runtime?.sendMessage) {
    appState.candidates = [{
      url: 'https://example.com/demo.mp3',
      name: 'demo.mp3',
      type: 'mp3',
      source: 'demo',
      size: 0,
    }];
    scheduleCandidateDuplicateChecks();
    setStatus('当前不是 Chrome 扩展环境，已显示演示候选。', 'success');
    render();
    return;
  }
  chromeApi.runtime.sendMessage({ type: options.reset ? 'RESET_AND_SCAN_PAGE' : 'SCAN_PAGE' }, () => {
    if (chromeApi.runtime.lastError) {
      appState.scanActive = false;
      clearScanEmptyHint();
      setStatus(`监听启动失败：${chromeApi.runtime.lastError.message}`, 'error');
      render();
    }
  });
}

function scheduleScanEmptyHint() {
  clearScanEmptyHint();
  if (typeof window === 'undefined') return;
  scanEmptyTimer = window.setTimeout(() => {
    scanEmptyTimer = 0;
    if (appState.scanActive && appState.view === 'capture' && !appState.candidates.length) render();
  }, 20 * 1000);
}

function clearScanEmptyHint() {
  if (!scanEmptyTimer || typeof window === 'undefined') return;
  window.clearTimeout(scanEmptyTimer);
  scanEmptyTimer = 0;
}

function handleBackgroundState(state) {
  const previousCandidateCount = appState.candidates.length;
  appState.scanActive = ['extracting', 'confirm'].includes(state.phase);
  if (Array.isArray(state.candidates)) {
    appState.candidates = state.candidates.slice(0, 12);
  } else if (state.url) {
    appState.candidates = [{ url: state.url, name: fileNameFromUrl(state.url), type: 'media', source: 'page', size: 0 }];
  }
  scheduleCandidateDuplicateChecks();
  if (state.phase === 'confirm' && appState.candidates.length) {
    clearScanEmptyHint();
    appState.backgroundCandidateNotice = state.statusText || '已找到当前页录音，可以开始识别。';
    if (shouldAutoOpenCapture(appState.view)) appState.view = 'capture';
    setStatus(appState.backgroundCandidateNotice, 'success');
  } else if (state.phase === 'error') {
    clearScanEmptyHint();
    setStatus(state.error || '扫描失败', 'error');
  } else if (appState.view === 'capture') {
    if (state.phase === 'extracting') setStatus(state.statusText || '正在监听当前网页...', '');
    if (state.phase === 'idle') setStatus(state.statusText || '', '');
  } else if (state.phase === 'extracting' && previousCandidateCount === 0) {
    appState.backgroundCandidateNotice = state.statusText || '正在监听当前网页。';
  }
  if (shouldRenderForBackgroundState(state)) scheduleRender();
}

function scheduleCandidateDuplicateChecks() {
  if (!appState.accessToken) return;
  appState.candidates.forEach((candidate, index) => {
    if (!shouldCheckCandidateDuplicate(candidate)) return;
    const key = String(candidate.url || '');
    if (candidateDuplicateRequests.has(key)) return;
    candidateDuplicateRequests.add(key);
    markCandidateDuplicate(index, key, { checking: true, checked: false, duplicate: false, record: null });
    checkCandidateDuplicate(candidate, index, key).finally(() => {
      candidateDuplicateRequests.delete(key);
    });
  });
}

function shouldCheckCandidateDuplicate(candidate = {}) {
  if (!candidate.url || candidate.uploadable === false) return false;
  if (candidate.duplicate?.checked || candidate.duplicate?.checking) return false;
  return /^https?:\/\//i.test(String(candidate.url));
}

async function checkCandidateDuplicate(candidate, index, key) {
  try {
    const body = await api('/api/records/check-duplicate', {
      method: 'POST',
      body: {
        candidateUrl: candidate.url,
        sourcePageUrl: candidate.pageUrl || '',
        sourcePageTitle: candidate.pageTitle || '',
      },
    });
    markCandidateDuplicate(index, key, {
      checking: false,
      checked: true,
      duplicate: Boolean(body.duplicate),
      record: body.record || null,
    });
    if (body.duplicate && appState.view === 'capture') {
      setStatus('这条录音已识别过，已为你找到历史记录。', 'warning');
    }
    scheduleRender();
  } catch {
    markCandidateDuplicate(index, key, {
      checking: false,
      checked: false,
      duplicate: false,
      record: null,
    });
  }
}

function markCandidateDuplicate(index, key, duplicate) {
  const candidate = appState.candidates[index];
  if (!candidate || String(candidate.url || '') !== key) return;
  appState.candidates[index] = {
    ...candidate,
    duplicate,
  };
}

function shouldAutoOpenCapture(view) {
  return view === 'home';
}

function shouldRenderForBackgroundState(state) {
  if (isEditingSensitiveView() && hasEditableFocus()) return false;
  if (appState.view === 'capture') return true;
  return ['home', 'history', 'upload'].includes(appState.view) && ['confirm', 'error'].includes(state.phase);
}

function isEditingSensitiveView() {
  return ['profile', 'settings', 'employees', 'detail'].includes(appState.view);
}

function hasEditableFocus() {
  const active = typeof document !== 'undefined' ? document.activeElement : null;
  if (!active) return false;
  const tag = String(active.tagName || '').toLowerCase();
  return ['input', 'textarea', 'select'].includes(tag) || Boolean(active.isContentEditable);
}

function setCandidateJob(index, patch) {
  const current = appState.candidateJobs[index] || {};
  appState.candidateJobs[index] = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  appState.activeAction = `candidate.${index}.upload`;
}

function openManualUploadFromCandidate(index) {
  const candidate = appState.candidates[index] || {};
  const job = appState.candidateJobs[index] || {};
  const title = appState.candidateTitleDrafts[index] || job.title || defaultCandidateTitle(candidate);
  appState.uploadDraft = {
    title,
    notice: '网页读取失败，建议上传从 Plaud 下载的原始录音文件。',
    fileName: '',
    fileSize: 0,
    status: '',
    statusType: '',
  };
  appState.view = 'upload';
  render();
}

function copyCandidateDiagnostics(index) {
  const candidate = appState.candidates[index] || {};
  const job = appState.candidateJobs[index] || {};
  return copyText(JSON.stringify({
    type: 'candidate',
    time: new Date().toISOString(),
    view: appState.view,
    action: `candidate.${index}.upload`,
    job: diagnosticCandidateJob(job),
    candidate: {
      name: candidate.name,
      type: candidate.type,
      size: candidate.size,
      source: candidate.source,
      pageTitle: candidate.pageTitle,
      pageUrl: candidate.pageUrl,
      uploadable: candidate.uploadable,
      unsupportedReason: candidate.unsupportedReason,
      urlHost: safeUrlHost(candidate.url),
    },
  }, null, 2)).then(() => {
    setStatus('候选诊断已复制', 'success');
    render();
  });
}

async function openDuplicateRecord(index) {
  const recordId = candidateDuplicate(appState.candidates[index])?.record?.id || '';
  if (!recordId) return;
  await openRecord(recordId);
}

async function forceUploadCandidate(index) {
  const ok = typeof window === 'undefined' || !window.confirm
    ? true
    : window.confirm('这条录音已经识别过，继续会重新上传并重新转写，可能产生额外费用。是否继续？');
  if (!ok) return;
  await uploadCandidate(index, { forceDuplicate: true });
}

function diagnosticCandidateJob(job = {}) {
  const {
    blob: _blob,
    ...safeJob
  } = job;
  return safeJob;
}

function handleManualFileChange(event) {
  const file = event.currentTarget.files?.[0];
  appState.uploadDraft.fileName = file?.name || '';
  appState.uploadDraft.fileSize = file?.size || 0;
  if (!file) {
    setUploadStatus('尚未选择文件', '');
    return;
  }
  const validation = validateAudioLimits({ size: file.size });
  setUploadStatus(
    validation.ok ? (validation.warning || `可上传：${file.name}（${formatBytes(file.size)}）`) : validation.message,
    validation.ok ? 'success' : 'error',
  );
}

function validateAudioLimits({ size = 0, durationSeconds = 0 } = {}) {
  const numericSize = Number(size || 0);
  const numericDuration = Number(durationSeconds || 0);
  if (Number.isFinite(numericSize) && numericSize > MAX_AUDIO_FILE_BYTES) {
    return { ok: false, message: '单个录音最大支持 2GB，请先切分后再上传。' };
  }
  if (Number.isFinite(numericDuration) && numericDuration > MAX_AUDIO_SECONDS) {
    return { ok: false, message: '单个录音最长支持 12 小时，请先切分后再上传。' };
  }
  if (Number.isFinite(numericDuration) && numericDuration > RECOMMENDED_AUDIO_SECONDS) {
    return { ok: true, warning: '录音超过 2 小时，已允许提交，但处理时间会较长，可稍后回来查看。' };
  }
  return { ok: true, warning: '' };
}

function handleAvatarFileChange(event) {
  const file = event.currentTarget.files?.[0];
  appState.profileUi.avatarFileName = file?.name || '';
  appState.profileUi.avatarFileSize = file?.size || 0;
  if (!file) {
    setProfileStatus('avatar', '待选择头像文件', '');
    return;
  }
  const validation = validateAvatarFile(file);
  setProfileStatus(
    'avatar',
    validation.ok
      ? `可上传：${file.name}（${formatBytes(file.size)}）`
      : validation.message,
    validation.ok ? 'success' : 'error',
  );
}

function setUploadStatus(message, type = '') {
  appState.uploadDraft.status = message;
  appState.uploadDraft.statusType = type;
  const fileStatus = document.getElementById('upload-file-status');
  if (fileStatus) {
    fileStatus.textContent = appState.uploadDraft.fileName
      ? `已选择：${appState.uploadDraft.fileName}（${formatBytes(appState.uploadDraft.fileSize)}）`
      : '尚未选择文件';
  }
  setInlineStatus('upload-action-status', message, type);
}

function setProfileStatus(section, message, type = '') {
  const key = `${section}Status`;
  const typeKey = `${section}StatusType`;
  appState.profileUi[key] = message;
  appState.profileUi[typeKey] = type;
  if (section === 'avatar') {
    const fileStatus = document.getElementById('avatar-file-status');
    if (fileStatus) {
      fileStatus.textContent = appState.profileUi.avatarFileName
        ? `已选择：${appState.profileUi.avatarFileName}（${formatBytes(appState.profileUi.avatarFileSize)}）`
        : message;
    }
    setInlineStatus('avatar-action-status', message, type);
    return;
  }
  setInlineStatus(`${section}-action-status`, message, type);
}

function setInlineStatus(id, message, type = '') {
  const node = document.getElementById(id);
  if (!node) return;
  node.className = message ? `status ${type || ''}` : '';
  node.textContent = message || '';
}

async function uploadCandidate(index, options = {}) {
  const candidate = appState.candidates[index];
  if (!candidate?.url) return;
  if (candidate.uploadable === false) {
    setCandidateJob(index, {
      phase: 'read_failed',
      message: candidate.unsupportedReason || '该候选暂不能直接上传为单个录音文件。',
      error: candidate.unsupportedReason || '该候选暂不能直接上传为单个录音文件。',
    });
    openManualUploadFromCandidate(index);
    return;
  }
  const candidateValidation = validateAudioLimits({ size: candidate.size, durationSeconds: candidate.durationSeconds });
  if (!candidateValidation.ok) {
    setCandidateJob(index, {
      phase: 'read_failed',
      message: candidateValidation.message,
      error: candidateValidation.message,
    });
    setStatus(candidateValidation.message, 'error');
    render();
    return;
  }
  if (options.forceDuplicate !== true && appState.accessToken) {
    const duplicate = await ensureCandidateDuplicateChecked(index, candidate);
    if (duplicate) {
      setStatus('这条录音已识别过，已为你找到历史记录。', 'warning');
      render();
      return;
    }
  }
  const templateType = document.getElementById('capture-template')?.value || currentTemplateType();
  const followupType = document.getElementById('capture-followup')?.value || currentFollowupType();
  const titleInput = document.querySelector(`[data-candidate-title="${index}"]`);
  const defaultTitle = titleInput?.dataset.defaultTitle || defaultCandidateTitle(candidate);
  const title = String(titleInput?.value || defaultTitle).trim() || defaultTitle;
  const titleSource = title === defaultTitle
    ? (candidate.pageTitle ? 'page' : 'filename')
    : 'manual';
  appState.candidateTitleDrafts[index] = title;
  let phase = 'reading';
  let record = null;
  try {
    setCandidateJob(index, {
      phase,
      title,
      message: '正在读取网页录音。',
    });
    setStatus('正在读取候选录音...', '');
    render();
    const blob = await readCandidateBlob(candidate);
    const blobValidation = validateAudioLimits({ size: blob.size, durationSeconds: candidate.durationSeconds });
    if (!blobValidation.ok) throw new Error(blobValidation.message);
    const fileName = supportedCandidateFileName(candidate, blob.type);
    phase = 'creating_record';
    setCandidateJob(index, {
      phase,
      title,
      message: '录音已读取，正在创建记录。',
    });
    render();
    record = await createRecord({
      sourceType: 'web_capture',
      sourcePageUrl: candidate.pageUrl || '',
      sourcePageTitle: candidate.pageTitle || '',
      title,
      titleSource,
      templateType,
      followupType,
      candidateUrl: candidate.url,
      forceDuplicate: options.forceDuplicate === true,
    });
    await rememberProcessingDefaults(templateType, followupType);
    phase = 'uploading';
    setCandidateJob(index, {
      phase,
      title,
      recordId: record.id,
      blob,
      fileName,
      candidateMeta: candidate,
      message: '记录已创建，正在上传到后端。',
    });
    render();
    await uploadRecordFile(record.id, blob, fileName, { candidateUrl: candidate.url, candidateMeta: JSON.stringify(candidate) });
    setCandidateJob(index, {
      phase: 'processing',
      title,
      recordId: record.id,
      message: '录音已上传，后端正在处理。',
    });
    await openRecord(record.id);
    await loadRecords();
    setStatus('录音已上传，任务已进入后端处理。', 'success');
  } catch (error) {
    const message = error.message || String(error);
    if (error.status === 409 && error.data?.duplicate) {
      markCandidateDuplicate(index, String(candidate.url || ''), {
        checking: false,
        checked: true,
        duplicate: true,
        record: error.data.record || null,
      });
    }
    setCandidateJob(index, {
      phase: phase === 'reading' ? 'read_failed' : 'failed',
      title,
      recordId: record?.id || '',
      blob: appState.candidateJobs[index]?.blob,
      fileName: appState.candidateJobs[index]?.fileName,
      candidateMeta: appState.candidateJobs[index]?.candidateMeta,
      message,
      error: message,
    });
    setStatus(message, 'error');
    render();
  }
}

async function ensureCandidateDuplicateChecked(index, candidate) {
  const known = candidateDuplicate(candidate);
  if (known) return known;
  if (!appState.accessToken || !/^https?:\/\//i.test(String(candidate.url || ''))) return null;
  try {
    markCandidateDuplicate(index, String(candidate.url || ''), { checking: true, checked: false, duplicate: false, record: null });
    const body = await api('/api/records/check-duplicate', {
      method: 'POST',
      body: {
        candidateUrl: candidate.url,
        sourcePageUrl: candidate.pageUrl || '',
        sourcePageTitle: candidate.pageTitle || '',
      },
    });
    markCandidateDuplicate(index, String(candidate.url || ''), {
      checking: false,
      checked: true,
      duplicate: Boolean(body.duplicate),
      record: body.record || null,
    });
    return body.duplicate ? appState.candidates[index]?.duplicate || null : null;
  } catch {
    markCandidateDuplicate(index, String(candidate.url || ''), {
      checking: false,
      checked: false,
      duplicate: false,
      record: null,
    });
    return null;
  }
}

async function retryCandidateUpload(index) {
  const job = appState.candidateJobs[index] || {};
  const candidate = appState.candidates[index] || job.candidateMeta || {};
  if (!job.recordId || !job.blob || !job.fileName) {
    setCandidateJob(index, {
      ...job,
      phase: 'failed',
      message: '缺少可重试的录音文件，请重新读取或改用手动上传。',
      error: '缺少可重试的录音文件',
    });
    render();
    return;
  }
  try {
    setCandidateJob(index, {
      ...job,
      phase: 'uploading',
      message: '正在重试上传到已创建的记录。',
      error: '',
    });
    render();
    await uploadRecordFile(job.recordId, job.blob, job.fileName, { candidateUrl: candidate.url || '', candidateMeta: JSON.stringify(candidate) });
    setCandidateJob(index, {
      ...job,
      phase: 'processing',
      message: '录音已上传，后端正在处理。',
      error: '',
    });
    await openRecord(job.recordId);
    await loadRecords();
    setStatus('录音已上传，任务已进入后端处理。', 'success');
  } catch (error) {
    const message = error.message || String(error);
    setCandidateJob(index, {
      ...job,
      phase: 'failed',
      message,
      error: message,
    });
    setStatus(message, 'error');
    render();
  }
}

async function readCandidateBlob(candidate) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), CANDIDATE_READ_TIMEOUT_MS);
  try {
    const blob = await fetchCandidateBlob(candidate, controller.signal);
    validateCandidateBlobComplete(candidate, blob);
    return blob;
  } catch (error) {
    throw new Error(candidateReadFailureMessage(error));
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchCandidateBlob(candidate, signal) {
  if (candidate.rangeSize > 0) {
    try {
      const ranged = await fetchCandidateResponse(candidate, signal, {
        Range: `bytes=0-${Math.max(0, Number(candidate.rangeSize) - 1)}`,
      });
      return await ranged.blob();
    } catch (error) {
      if (isAbortError(error)) throw error;
    }
  }
  const response = await fetchCandidateResponse(candidate, signal);
  return response.blob();
}

async function fetchCandidateResponse(candidate, signal, headers = undefined) {
  const response = await fetch(candidate.url, { credentials: 'include', signal, headers });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response;
}

function isAbortError(error) {
  return /AbortError|aborted|超时|timeout/i.test(String(error?.name || error?.message || error || ''));
}

function validateCandidateBlobComplete(candidate, blob) {
  if (!blob || blob.size === 0) throw new Error('录音文件为空');
  const expectedSize = Number(candidate.rangeSize || 0);
  if (!expectedSize) return;
  const tolerance = Math.max(1024, Math.round(expectedSize * 0.02));
  if (blob.size + tolerance >= expectedSize) return;
  throw new Error(`只读取到 ${formatBytes(blob.size)}，完整录音约 ${formatBytes(expectedSize)}。网页只放行了播放器分片，请在原网页下载录音文件后手动上传。`);
}

function candidateReadFailureMessage(error) {
  const raw = String(error?.message || error || '网络读取失败');
  let reason = raw;
  if (/HTTP\s+(401|403)/i.test(raw)) reason = '网页登录态或权限不允许插件直接读取该录音';
  else if (/HTTP\s+404/i.test(raw)) reason = '网页录音地址已过期或文件不存在';
  else if (/AbortError|aborted|超时|timeout/i.test(raw)) reason = '读取网页录音超时';
  else if (/Failed to fetch|Load failed|NetworkError|fetch/i.test(raw)) reason = '浏览器没有放行这个网页录音地址';
  return `无法直接读取这个网页录音：${reason}。请在原网页下载录音文件，再回到这里点“手动上传”。`;
}

async function uploadManualFile(event) {
  const form = formFromEvent(event, 'upload-form');
  if (!form) return;
  const file = form.audioFile.files[0];
  if (!file) {
    setStatus('请选择录音文件', 'error');
    setUploadStatus('请选择录音文件', 'error');
    return;
  }
  const validation = validateAudioLimits({ size: file.size });
  if (!validation.ok) {
    setStatus(validation.message, 'error');
    setUploadStatus(validation.message, 'error');
    return;
  }
  appState.uploadDraft.title = form.title.value.trim();
  appState.uploadDraft.fileName = file.name;
  appState.uploadDraft.fileSize = file.size;
  setUploadStatus(validation.warning || '正在创建记录...', validation.warning ? 'success' : '');
  setActionState('upload.manual', { status: 'busy', message: '正在上传录音文件' });
  try {
    const title = form.title.value.trim();
    const record = await createRecord({
      sourceType: 'manual_upload',
      title,
      titleSource: title ? 'manual' : 'filename',
      templateType: form.templateType.value,
      followupType: form.followupType.value,
    });
    await rememberProcessingDefaults(form.templateType.value, form.followupType.value);
    setUploadStatus('正在上传录音文件...', '');
    await uploadRecordFile(record.id, file, file.name);
    await openRecord(record.id);
    await loadRecords();
    setActionState('upload.manual', { status: 'success', message: '录音已上传' });
    appState.uploadDraft = { title: '', notice: '', fileName: '', fileSize: 0, status: '', statusType: '' };
    setStatus('录音已上传，任务已进入后端处理。', 'success');
  } catch (error) {
    const message = error.message || String(error);
    setActionState('upload.manual', { status: 'error', message });
    setUploadStatus(message, 'error');
    setStatus(message, 'error');
  }
}

async function createRecord(payload) {
  const body = await api('/api/records', {
    method: 'POST',
    body: payload,
  });
  return body.record;
}

async function rememberProcessingDefaults(templateType, followupType) {
  appState.preferredTemplateType = templateType || appState.preferredTemplateType;
  appState.preferredFollowupType = followupType || appState.preferredFollowupType;
  appState.processingChoices = {};
  await storageSet({
    preferredTemplateType: appState.preferredTemplateType,
    preferredFollowupType: appState.preferredFollowupType,
  });
}

function setProcessingModeChoice(prefix, mode) {
  if (!prefix) return;
  if (mode === 'followup') {
    const followupType = preferredFollowupTypeUi();
    appState.processingChoices[`${prefix}-followup`] = followupType;
    appState.processingChoices[`${prefix}-template`] = templateTypeForFollowupUi(followupType);
  } else {
    appState.processingChoices[`${prefix}-followup`] = 'none';
    appState.processingChoices[`${prefix}-template`] = preferredMeetingTemplateType();
  }
  render();
}

function setProcessingTemplateChoice(prefix, templateType) {
  if (!prefix) return;
  const nextTemplate = normalizeMeetingTemplateType(templateType);
  appState.processingChoices[`${prefix}-template`] = nextTemplate;
  appState.processingChoices[`${prefix}-followup`] = 'none';
  appState.preferredTemplateType = nextTemplate;
  storageSet({ preferredTemplateType: nextTemplate });
  render();
}

function setProcessingFollowupChoice(prefix, followupType) {
  if (!prefix) return;
  const normalized = normalizeFollowupTypeUi(followupType, '');
  const nextFollowup = normalized === 'none' ? 'general_customer' : normalized;
  appState.processingChoices[`${prefix}-followup`] = nextFollowup;
  appState.processingChoices[`${prefix}-template`] = templateTypeForFollowupUi(nextFollowup);
  appState.preferredFollowupType = nextFollowup;
  storageSet({ preferredFollowupType: nextFollowup });
  render();
}

async function uploadRecordFile(recordId, blob, fileName, extraFields = {}) {
  const form = new FormData();
  form.append('file', blob, fileName || 'record.mp3');
  Object.entries(extraFields).forEach(([key, value]) => form.append(key, value));
  const body = await api(`/api/records/${recordId}/upload`, {
    method: 'POST',
    form,
    timeoutMs: UPLOAD_REQUEST_TIMEOUT_MS,
  });
  return body.record;
}

async function openRecord(recordId) {
  await runBusy(async () => {
    const body = await api(`/api/records/${recordId}`);
    appState.detail = body.record;
    appState.detailTab = 'summary';
    appState.view = 'detail';
    appState.titleEditing = false;
    appState.titleDraft = null;
    appState.processingChoices = {};
    appState.activeSegmentId = '';
    appState.transcriptQuery = '';
    appState.transcriptVisibleCount = TRANSCRIPT_RENDER_BATCH;
    appState.mindMapExpanded = false;
    appState.exportNotice = '';
    appState.audioError = '';
    appState.speakerEditing = null;
    appState.sharePanelOpen = false;
    appState.shareLinks = [];
    appState.shareStatus = '';
  }, false);
  render();
}

async function openSharePanel() {
  if (!appState.detail) return;
  appState.sharePanelOpen = true;
  appState.shareStatus = '正在加载分享链接...';
  appState.shareStatusType = 'warning';
  render();
  await refreshShareLinks();
}

async function refreshShareLinks() {
  if (!appState.detail) return;
  try {
    const body = await api(`/api/records/${appState.detail.id}/share-links`);
    appState.shareLinks = body.shares || [];
    render();
  } catch (error) {
    appState.shareStatus = error.message || String(error);
    appState.shareStatusType = 'error';
    render();
  }
}

async function createShareLink(event) {
  const form = formFromEvent(event, 'share-form');
  if (!form || !appState.detail) return;
  const payload = {
    includeAudio: Boolean(form.includeAudio?.checked),
    includeTranscript: Boolean(form.includeTranscript?.checked),
    includeSummary: Boolean(form.includeSummary?.checked),
    expiresInDays: Number(form.expiresInDays?.value || 7),
  };
  try {
    const body = await api(`/api/records/${appState.detail.id}/share-links`, {
      method: 'POST',
      body: payload,
    });
    appState.shareLinks = [body.share, ...appState.shareLinks.filter((share) => share.id !== body.share.id)];
    await copyText(body.share.url || '');
    appState.shareStatus = '分享链接已创建并复制';
    appState.shareStatusType = 'success';
    render();
  } catch (error) {
    appState.shareStatus = error.message || String(error);
    appState.shareStatusType = 'error';
    render();
  }
}

async function revokeShareLink(id) {
  if (!id || !appState.detail) return;
  try {
    const body = await api(`/api/share-links/${encodeURIComponent(id)}`, { method: 'DELETE' });
    appState.shareLinks = appState.shareLinks.map((share) => share.id === id ? body.share : share);
    appState.shareStatus = '分享链接已撤销';
    appState.shareStatusType = 'success';
    render();
  } catch (error) {
    appState.shareStatus = error.message || String(error);
    appState.shareStatusType = 'error';
    render();
  }
}

async function saveRecordTitle(event) {
  event?.preventDefault?.();
  if (!appState.detail) return;
  const title = document.getElementById('record-title-input')?.value.trim() || '';
  appState.titleDraft = title;
  await runBusy(async () => {
    const body = await api(`/api/records/${appState.detail.id}`, {
      method: 'PATCH',
      body: { title, titleSource: 'manual' },
    });
    appState.detail = body.record;
    appState.titleEditing = false;
    appState.titleDraft = null;
    await loadRecords();
    setStatus('标题已保存', 'success');
  }, true);
}

async function saveRecordUserId(event) {
  event?.preventDefault?.();
  if (!appState.detail) return;
  const form = formFromEvent(event, 'record-user-form') || document.getElementById('record-user-form');
  const externalUserId = form?.externalUserId?.value.trim() || '';
  await saveExternalUserId(externalUserId, '用户 ID 已保存');
}

async function saveExternalUserId(externalUserId, successMessage) {
  if (!appState.detail) return;
  await runBusy(async () => {
    const body = await api(`/api/records/${appState.detail.id}`, {
      method: 'PATCH',
      body: { externalUserId },
    });
    appState.detail = body.record;
    await loadRecords();
    setStatus(successMessage, 'success');
  }, true);
}

async function saveNote(event) {
  const form = formFromEvent(event, 'note-form');
  if (!form) return;
  const note = form.note.value.trim();
  if (!note || !appState.detail) return;
  await runBusy(async () => {
    await api(`/api/records/${appState.detail.id}/note`, {
      method: 'PATCH',
      body: { note },
    });
    await openRecord(appState.detail.id);
    setStatus('备注已保存', 'success');
  }, true);
}

async function saveProfile(event) {
  const form = formFromEvent(event, 'profile-form');
  if (!form) return;
  updateProfileDraftFromForm(form);
  setActionState('profile.save', { status: 'busy', message: '正在保存个人资料' });
  setProfileStatus('profile', '正在保存个人资料...', '');
  try {
    const body = await api('/api/me/profile', {
      method: 'PATCH',
      body: {
        displayName: form.displayName.value.trim(),
        bio: form.bio.value.trim(),
        aiProfileNote: form.aiProfileNote.value.trim(),
        avatarColor: form.avatarColor.value,
      },
    });
    appState.profile = body.employee;
    appState.currentUser = body.employee;
    appState.profileDraft = null;
    await storageSet({ currentUser: body.employee });
    setActionState('profile.save', { status: 'success', message: '个人资料已保存' });
    setProfileStatus('profile', '个人资料已保存', 'success');
    setStatus('个人资料已保存', 'success');
    render();
  } catch (error) {
    const message = error.message || String(error);
    setActionState('profile.save', { status: 'error', message });
    setProfileStatus('profile', message, 'error');
    setStatus(message, 'error');
  }
}

async function uploadAvatar(event) {
  const formElement = formFromEvent(event, 'avatar-form');
  if (!formElement) return;
  const file = formElement.avatar.files[0];
  if (!file) {
    setStatus('请选择头像文件', 'error');
    setProfileStatus('avatar', '请选择头像文件', 'error');
    return;
  }
  const validation = validateAvatarFile(file);
  if (!validation.ok) {
    setStatus(validation.message, 'error');
    setProfileStatus('avatar', validation.message, 'error');
    return;
  }
  appState.profileUi.avatarFileName = file.name;
  appState.profileUi.avatarFileSize = file.size;
  const form = new FormData();
  form.append('avatar', file, file.name);
  setActionState('avatar.upload', { status: 'busy', message: '正在上传头像' });
  setProfileStatus('avatar', '上传中', '');
  try {
    const body = await api('/api/me/avatar', {
      method: 'POST',
      form,
      timeoutMs: UPLOAD_REQUEST_TIMEOUT_MS,
    });
    appState.profile = body.employee;
    appState.currentUser = body.employee;
    await storageSet({ currentUser: body.employee });
    setActionState('avatar.upload', { status: 'success', message: '头像已更新' });
    setProfileStatus('avatar', '头像已更新', 'success');
    setStatus('头像已更新', 'success');
    render();
  } catch (error) {
    const message = error.message || String(error);
    setActionState('avatar.upload', { status: 'error', message });
    setProfileStatus('avatar', message, 'error');
    setStatus(message, 'error');
  }
}

function validateAvatarFile(file) {
  const name = String(file?.name || '');
  const type = String(file?.type || '').toLowerCase();
  const ext = safeExtension(name);
  const ok = ['png', 'jpg', 'jpeg', 'webp'].includes(ext) || ['image/png', 'image/jpeg', 'image/webp'].includes(type);
  return ok
    ? { ok: true, message: '头像格式可上传' }
    : { ok: false, message: '头像格式不支持，请选择 PNG、JPG 或 WebP 图片。' };
}

async function changePassword(event) {
  const form = formFromEvent(event, 'password-form');
  if (!form) return;
  updatePasswordDraftFromForm(form);
  if (form.newPassword.value !== form.confirmPassword.value) {
    setStatus('两次新密码不一致', 'error');
    setProfileStatus('password', '两次新密码不一致', 'error');
    return;
  }
  setActionState('password.change', { status: 'busy', message: '正在修改密码' });
  setProfileStatus('password', '正在修改密码...', '');
  try {
    await api('/api/auth/change-password', {
      method: 'POST',
      body: {
        oldPassword: form.oldPassword.value,
        newPassword: form.newPassword.value,
      },
    });
    form.reset();
    appState.passwordDraft = null;
    setActionState('password.change', { status: 'success', message: '密码已修改' });
    setProfileStatus('password', '密码已修改', 'success');
    setStatus('密码已修改', 'success');
    render();
  } catch (error) {
    const message = error.message || String(error);
    setActionState('password.change', { status: 'error', message });
    setProfileStatus('password', message, 'error');
    setStatus(message, 'error');
  }
}

async function saveFollowup(event) {
  if (!appState.detail) return;
  const form = formFromEvent(event, 'followup-form');
  if (!form) return;
  await runBusy(async () => {
    if (String(form.externalUserId?.value || '').trim() !== String(appState.detail.externalUserId || '')) {
      const body = await api(`/api/records/${appState.detail.id}`, {
        method: 'PATCH',
        body: { externalUserId: form.externalUserId.value.trim() },
      });
      appState.detail = body.record;
    }
    await api(`/api/records/${appState.detail.id}/followup`, {
      method: 'PATCH',
      body: {
        stage: form.stage.value,
        companyName: form.companyName.value.trim(),
        statusLabel: form.statusLabel.value.trim(),
        suggestedTag: form.suggestedTag.value.trim(),
        followupMarkdown: form.followupMarkdown.value.trim(),
      },
    });
    await openRecord(appState.detail.id);
    appState.detailTab = 'summary';
    setStatus('跟单已保存', 'success');
  }, true);
}

async function saveSpeakerAlias(speaker) {
  if (!appState.detail || !speaker) return;
  const alias = document.getElementById('speaker-alias-input')?.value.trim() || '';
  await runBusy(async () => {
    const body = await api(`/api/records/${appState.detail.id}/transcript-speakers`, {
      method: 'PATCH',
      body: { speaker, alias },
    });
    appState.detail = body.record;
    appState.speakerEditing = null;
    setStatus(alias ? '说话人已更新' : '说话人别名已清除', 'success');
  }, true);
}

async function summarizeRecord() {
  if (!appState.detail) return;
  const templateType = document.getElementById('detail-template')?.value || appState.detail.templateType;
  const followupType = document.getElementById('detail-followup')?.value || appState.detail.followupType || 'none';
  await runBusy(async () => {
    const body = await api(`/api/records/${appState.detail.id}/summarize`, {
      method: 'POST',
      body: { templateType, followupType, force: true },
      timeoutMs: TASK_START_REQUEST_TIMEOUT_MS,
    });
    appState.detail = body.record || {
      ...appState.detail,
      templateType,
      followupType,
      status: 'summarizing',
    };
    await rememberProcessingDefaults(templateType, followupType);
    appState.detailTab = 'summary';
    setStatus('已开始生成总结，完成后会自动刷新。', 'success');
  }, true);
}

async function transcribeRecord() {
  if (!appState.detail) return;
  await runBusy(async () => {
    await api(`/api/records/${appState.detail.id}/transcribe`, {
      method: 'POST',
      body: {},
    });
    await openRecord(appState.detail.id);
    setStatus('已重新触发转写', 'success');
  }, true);
}

async function seekTranscriptSegment(segmentId, startMs) {
  const audio = document.getElementById('record-audio');
  if (!audio || !Number.isFinite(startMs)) return;
  highlightTranscriptSegment(segmentId || '');
  const target = Math.max(0, startMs / 1000);
  try {
    if (Number.isFinite(audio.duration) && audio.duration > 0) {
      audio.currentTime = Math.min(target, Math.max(0, audio.duration - 0.2));
    } else {
      audio.currentTime = target;
    }
    await audio.play();
  } catch {
    setStatus('已跳到对应时间点，请手动点击播放器播放。', 'success');
  }
}

function updateActiveTranscriptSegment(currentMs) {
  const segments = normalizedTranscriptSegments(appState.detail || {});
  if (!segments.length || !Number.isFinite(currentMs)) return;
  const active = segments.find((segment) => (
    segment.endMs > segment.startMs && currentMs >= segment.startMs && currentMs < segment.endMs
  )) || [...segments].reverse().find((segment) => currentMs >= segment.startMs);
  if (!active || active.id === appState.activeSegmentId) return;
  highlightTranscriptSegment(active.id);
}

function highlightTranscriptSegment(segmentId) {
  appState.activeSegmentId = segmentId || '';
  document.querySelectorAll('.transcript-segment.active').forEach((node) => node.classList.remove('active'));
  document.querySelectorAll(`[data-id="${cssEscape(segmentId || '')}"]`).forEach((node) => {
    if (node.classList.contains('transcript-segment')) {
      node.classList.add('active');
      node.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
  });
}

async function exportSelectedRecord(target) {
  const select = document.querySelector(`[data-export-format="${cssEscape(target)}"]`);
  const format = select?.value || 'md';
  await exportRecord(target, format);
}

async function exportRecord(target, format) {
  if (!appState.detail) return;
  await runBusy(async () => {
    showExportNotice(`正在生成${exportTargetLabel(target)} ${formatLabel(format)}...`);
    const body = await api(`/api/records/${appState.detail.id}/export`, {
      method: 'POST',
      body: { target, format },
    });
    const downloadUrl = authedDownloadUrl(body.downloadUrl, body.downloadToken);
    const filename = `${appState.detail.title || '录音记录'}-${target}.${format}`;
    showExportNotice(`${exportTargetLabel(target)} ${formatLabel(format)} 已生成`);
    setStatus('导出已生成。', 'success');
    if (chromeApi?.downloads?.download) {
      chromeApi.downloads.download({ url: downloadUrl, filename: sanitizeFileName(filename), saveAs: true });
    } else {
      const link = document.createElement('a');
      link.href = downloadUrl;
      link.download = sanitizeFileName(filename);
      link.click();
    }
  }, true);
}

async function deleteRecord(recordId, mode) {
  if (!recordId) return;
  const message = mode === 'purge'
    ? '确定要彻底删除这条录音吗？数据库记录、本地文件和 R2 对象会被清理。'
    : '确定要归档这条录音吗？归档后普通历史列表不再显示。';
  if (!confirmAction(message)) return;
  await runBusy(async () => {
    const body = await api(`/api/records/${recordId}?mode=${encodeURIComponent(mode)}`, { method: 'DELETE' });
    delete appState.selectedRecordIds[recordId];
    if (appState.detail?.id === recordId) {
      appState.detail = null;
      appState.view = 'history';
    }
    await loadRecords();
    const extra = mode === 'purge'
      ? `已清理 ${body.localFilesDeleted?.length || 0} 个本地文件、${body.r2ObjectsDeleted || 0} 个 R2 对象。`
      : '已从普通历史列表移除。';
    setStatus(mode === 'purge' ? `录音已彻底删除。${extra}` : `录音已归档。${extra}`, 'success');
  }, true);
}

async function bulkDeleteRecords(mode) {
  const ids = selectedRecordIds();
  if (!ids.length) return;
  const message = mode === 'purge'
    ? `确定要彻底删除 ${ids.length} 条录音吗？数据库记录、本地文件和 R2 对象会被清理。`
    : `确定要归档 ${ids.length} 条录音吗？`;
  if (!confirmAction(message)) return;
  await runBusy(async () => {
    await api('/api/records/bulk-delete', {
      method: 'POST',
      body: { ids, mode },
    });
    appState.selectedRecordIds = {};
    await loadRecords();
    setStatus(mode === 'purge' ? '已彻底删除所选录音。' : '已归档所选录音。', 'success');
  }, true);
}

function confirmAction(message) {
  if (typeof window !== 'undefined' && typeof window.confirm === 'function') return window.confirm(message);
  return true;
}

async function createEmployee(event) {
  const form = formFromEvent(event, 'employee-form');
  if (!form) return;
  await runBusy(async () => {
    await api('/api/admin/employees', {
      method: 'POST',
      body: {
        displayName: form.displayName.value.trim(),
        employeeNo: form.employeeNo.value.trim(),
        globalRole: form.globalRole.value,
        departmentIds: form.departmentId.value ? [form.departmentId.value] : [],
      },
    });
    delete appState.processingChoices['employee-department'];
    delete appState.processingChoices['employee-role'];
    await loadEmployees();
    setStatus('员工已新增，默认密码 dayibin。', 'success');
  }, true);
}

async function employeeAction(employeeId, action) {
  const endpoint = action === 'disable-employee'
    ? 'disable'
    : action === 'enable-employee'
      ? 'enable'
      : 'reset-password';
  await runBusy(async () => {
    await api(`/api/admin/employees/${employeeId}/${endpoint}`, {
      method: 'POST',
      body: {},
    });
    await loadEmployees();
    setStatus('员工状态已更新。', 'success');
  }, true);
}

async function saveSettings(event, groupId = '') {
  event?.preventDefault?.();
  const form = document.getElementById('settings-form');
  if (!form) return;
  const scope = groupId
    ? document.querySelector(`[data-setting-group="${cssEscape(groupId)}"]`)
    : form;
  if (!scope) return;
  const settings = {};
  const clearKeys = [];
  let validationError = '';

  scope.querySelectorAll('[data-setting-key]').forEach((field) => {
    const key = field.dataset.settingKey;
    const value = String(field.value || '').trim();
    if (field.dataset.secret === '1') {
      const action = appState.secretActions[key] || 'keep';
      if (action === 'replace') {
        if (!value) validationError = '替换密钥时请填写新密钥';
        settings[key] = value;
      }
      if (action === 'clear') {
        clearKeys.push(key);
        settings[key] = '';
      }
      return;
    }
    settings[key] = value;
  });

  if (validationError) {
    setStatus(validationError, 'error');
    render();
    return;
  }

  await runBusy(async () => {
    const body = await api('/api/admin/settings', {
      method: 'PUT',
      body: { settings, clearKeys },
    });
    appState.settingGroups = body.groups || [];
    appState.systemStatus = body.status || null;
    appState.settingsMeta = body.meta || null;
    appState.secretActions = {};
    appState.settingChoices = {};
    await loadRuntimeSafe();
    await loadAuditLogsSafe();
    setStatus(`${groupId ? '本组设置' : '设置'}已保存，配置版本 ${appState.settingsMeta?.settingsVersion || ''} 已生效。`, 'success');
  }, true);
}

async function testSettings(target) {
  await runBusy(async () => {
    const body = await api('/api/admin/settings/test', {
      method: 'POST',
      body: { target },
    });
    await loadAuditLogsSafe();
    setStatus(body.message || '设置测试完成', body.ok ? 'success' : 'error');
  }, true);
}

function startLlmProviderDraft(presetId = '') {
  const preset = (appState.llmProviderPresets || []).find((item) => item.id === presetId) || {};
  appState.llmProviderDraft = llmProviderToDraft({
    ...preset,
    id: '',
    enabled: preset.enabled || false,
    configured: false,
    maskedApiKey: '',
  });
}

function editLlmProviderDraft(id) {
  const provider = (appState.llmProviders || []).find((item) => item.id === id);
  if (!provider) return;
  appState.llmProviderDraft = llmProviderToDraft(provider);
}

function llmProviderToDraft(provider = {}) {
  return {
    id: provider.id || '',
    displayName: provider.displayName || '',
    providerKey: provider.providerKey || '',
    channelId: provider.channelId || provider.providerKey || '',
    protocol: provider.protocol || 'openai-responses',
    baseUrl: provider.baseUrl || '',
    endpointPath: provider.endpointPath || '',
    requestModel: provider.requestModel || '',
    priority: provider.priority || 100,
    enabled: Boolean(provider.enabled),
    allowFallback: provider.allowFallback !== false,
    timeoutMs: provider.timeoutMs || 120000,
    reasoningEffort: provider.reasoningEffort || 'high',
    configured: Boolean(provider.configured),
    maskedApiKey: provider.maskedApiKey || '',
    testStatus: '',
    testMessage: '',
  };
}

function collectLlmProviderDraft() {
  const value = (id) => document.getElementById(id)?.value || '';
  const current = appState.llmProviderDraft || {};
  const protocol = value('llm-provider-protocol') || current.protocol || 'openai-responses';
  const baseUrl = value('llm-provider-base-url').trim();
  const requestModel = value('llm-provider-request-model').trim();
  const inferred = inferLlmProviderDefaults({ ...current, protocol, baseUrl, requestModel });
  const body = {
    id: value('llm-provider-id'),
    displayName: current.displayName || inferred.displayName,
    providerKey: current.providerKey || inferred.providerKey,
    channelId: current.channelId || inferred.channelId,
    protocol,
    baseUrl,
    endpointPath: current.endpointPath || inferred.endpointPath,
    requestModel,
    priority: Number(current.priority || inferred.priority || 100),
    enabled: true,
    allowFallback: true,
    timeoutMs: Number(current.timeoutMs || 120000),
    reasoningEffort: value('llm-provider-reasoning-effort') || 'high',
    clearApiKey: false,
  };
  const apiKey = value('llm-provider-api-key').trim();
  if (apiKey) body.apiKey = apiKey;
  return body;
}

function inferLlmProviderDefaults(draft = {}) {
  const protocol = draft.protocol || 'openai-responses';
  const baseUrl = String(draft.baseUrl || '').toLowerCase();
  const requestModel = String(draft.requestModel || '').toLowerCase();
  if (baseUrl.includes('aisoeasy') || draft.providerKey === 'easyai') {
    return {
      displayName: 'EasyAI GPT-5.5',
      providerKey: 'easyai',
      channelId: 'easyai',
      endpointPath: protocol === 'openai-chat' ? '/chat/completions' : '/responses',
      priority: 10,
    };
  }
  if (baseUrl.includes('127.0.0.1:8080') || baseUrl.includes('localhost:8080') || draft.providerKey === 'sub2api') {
    return {
      displayName: 'AI 大宜宾 sub2api - GPT-5.5',
      providerKey: 'sub2api',
      channelId: 'sub2api',
      endpointPath: '/responses',
      priority: 20,
    };
  }
  if (baseUrl.includes('kimi') || requestModel.includes('kimi') || draft.providerKey === 'kimi') {
    return {
      displayName: 'Kimi K2.6',
      providerKey: 'kimi',
      channelId: 'kimi',
      endpointPath: '/chat/completions',
      priority: 30,
    };
  }
  const providerKey = slugifyProviderKey(requestModel || protocol || 'custom-model');
  return {
    displayName: draft.displayName || draft.requestModel || '自定义模型',
    providerKey,
    channelId: providerKey,
    endpointPath: protocol === 'openai-chat' ? '/chat/completions' : protocol === 'openai-responses' ? '/responses' : '',
    priority: 100,
  };
}

function slugifyProviderKey(value) {
  const slug = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'custom-model';
}

function syncLlmProviderDraftFromForm(patch = {}) {
  const current = appState.llmProviderDraft || {};
  appState.llmProviderDraft = {
    ...current,
    ...collectLlmProviderDraft(),
    ...patch,
  };
}

async function testLlmProviderDraft() {
  syncLlmProviderDraftFromForm({ testStatus: '', testMessage: '正在测试模型连接...' });
  render();
  await runBusy(async () => {
    const body = await api('/api/admin/llm-providers/test', {
      method: 'POST',
      body: collectLlmProviderDraft(),
      timeoutMs: 140000,
    });
    syncLlmProviderDraftFromForm({
      testStatus: body.ok ? 'passed' : 'failed',
      testMessage: body.message || (body.ok ? '模型测试通过' : '模型测试失败'),
    });
    await loadLlmProvidersSafe();
    await loadAuditLogsSafe();
    setStatus(body.message || '模型测试完成', body.ok ? 'success' : 'error');
  }, true);
}

async function saveLlmProviderDraft() {
  const draft = collectLlmProviderDraft();
  await runBusy(async () => {
    const body = await api(draft.id ? `/api/admin/llm-providers/${encodeURIComponent(draft.id)}` : '/api/admin/llm-providers', {
      method: draft.id ? 'PATCH' : 'POST',
      body: draft.enabled ? draft : { ...draft, forceSaveWithoutTest: true },
      timeoutMs: 140000,
    });
    await loadSettings();
    appState.llmProviderDraft = null;
    setStatus(`${body.provider?.displayName || '模型'}已保存。`, 'success');
  }, true);
}

async function testExistingLlmProvider(id) {
  await runBusy(async () => {
    const body = await api('/api/admin/llm-providers/test', {
      method: 'POST',
      body: { id },
      timeoutMs: 140000,
    });
    await loadLlmProvidersSafe();
    await loadAuditLogsSafe();
    setStatus(body.message || '模型测试完成', body.ok ? 'success' : 'error');
  }, true);
}

async function toggleLlmProvider(id, enabled) {
  await runBusy(async () => {
    await api(`/api/admin/llm-providers/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: { enabled, forceSaveWithoutTest: !enabled },
      timeoutMs: 140000,
    });
    await loadSettings();
    setStatus(enabled ? '模型已启用。' : '模型已停用。', 'success');
  }, true);
}

async function moveLlmProvider(id, direction) {
  const providers = (appState.llmProviders || []).slice();
  const index = providers.findIndex((provider) => provider.id === id);
  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (index < 0 || targetIndex < 0 || targetIndex >= providers.length) return;
  const [provider] = providers.splice(index, 1);
  providers.splice(targetIndex, 0, provider);
  await runBusy(async () => {
    const body = await api('/api/admin/llm-providers/reorder', {
      method: 'POST',
      body: { ids: providers.map((item) => item.id) },
    });
    appState.llmProviders = body.providers || [];
    await loadAuditLogsSafe();
    setStatus('模型优先级已更新。', 'success');
  }, true);
}

async function deleteLlmProvider(id) {
  if (typeof window.confirm === 'function' && !window.confirm('确认删除这个模型？')) return;
  await runBusy(async () => {
    await api(`/api/admin/llm-providers/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await loadSettings();
    setStatus('模型已删除。', 'success');
  }, true);
}

async function loadMe() {
  const body = await api('/api/me');
  appState.currentUser = body.employee;
  appState.permissions = body.permissions || {};
  appState.templates = body.templates || [];
  appState.followupOptions = body.followupOptions || [];
  appState.defaultTemplate = body.defaultTemplate || 'meeting_minutes';
  appState.defaultFollowupType = body.defaultFollowupType || 'none';
  await storageSet({ currentUser: body.employee });
}

async function loadDepartments() {
  const body = await api('/api/departments');
  appState.departments = body.departments || [];
}

async function loadRecords() {
  const body = await api('/api/records');
  appState.records = body.records || [];
}

async function loadRecordsSafe() {
  await runBusy(loadRecords, false);
}

async function loadEmployees() {
  const body = await api('/api/admin/employees');
  appState.employees = body.employees || [];
}

async function loadEmployeesSafe() {
  if (!appState.permissions.canManageEmployees) return;
  await runBusy(loadEmployees, false);
}

async function loadSettings() {
  const body = await api('/api/admin/settings');
  appState.settingGroups = body.groups || [];
  appState.systemStatus = body.status || null;
  appState.settingsMeta = body.meta || null;
  appState.settingChoices = {};
  await loadLlmProviders();
  await loadAuditLogsSafe();
}

async function loadSettingsSafe() {
  if (!appState.permissions.canManageSettings) return;
  await runBusy(loadSettings, false);
}

async function loadLlmProviders() {
  const body = await api('/api/admin/llm-providers');
  appState.llmProviders = body.providers || [];
  appState.llmProviderPresets = body.presets || [];
}

async function loadLlmProvidersSafe() {
  if (!appState.permissions.canManageSettings) return;
  try {
    await loadLlmProviders();
  } catch {
    appState.llmProviders = [];
    appState.llmProviderPresets = [];
  }
}

async function loadAuditLogsSafe() {
  if (!appState.permissions.canManageSettings) return;
  try {
    const body = await api('/api/admin/audit-logs');
    appState.auditLogs = body.auditLogs || [];
  } catch {
    appState.auditLogs = [];
  }
}

async function loadProfile() {
  const body = await api('/api/me/profile');
  appState.profile = body.employee;
  appState.currentUser = body.employee;
  await storageSet({ currentUser: body.employee });
}

async function loadProfileSafe() {
  await runBusy(loadProfile, false);
}

async function loadRuntimeSafe() {
  try {
    const body = await api('/api/runtime', { skipAuth: true });
    appState.runtime = body;
  } catch {
    appState.runtime = null;
  }
}

async function loadExtensionUpdateSafe() {
  try {
    const body = await api('/api/extension/latest', { skipAuth: true });
    const currentVersion = currentExtensionVersion();
    const latest = body.latestExtension || {};
    appState.extensionUpdate = {
      currentVersion,
      latestVersion: latest.version || currentVersion,
      hasUpdate: compareVersions(latest.version || currentVersion, currentVersion) > 0,
      mustUpdate: compareVersions(latest.minSupportedVersion || '0.0.0', currentVersion) > 0,
      changelog: Array.isArray(latest.changelog) ? latest.changelog : [],
      downloadUrl: latest.downloadUrl || '',
      sha256: latest.sha256 || '',
    };
  } catch {
    appState.extensionUpdate = null;
  }
}

function loadBackgroundStateSafe() {
  if (!chromeApi?.runtime?.sendMessage) return Promise.resolve();
  return new Promise((resolve) => {
    chromeApi.runtime.sendMessage({ type: 'GET_STATE' }, (state) => {
      if (chromeApi.runtime.lastError || !state) {
        resolve();
        return;
      }
      handleBackgroundState(state);
      resolve();
    });
  });
}

function renderAvatar(user, size = '') {
  const className = size === 'large' ? 'avatar avatar-large' : 'avatar';
  const style = user?.avatarColor ? ` style="background:${escapeHtml(user.avatarColor)}"` : '';
  if (user?.avatarUrl) {
    return `<span class="${className}"${style}><img src="${escapeHtml(user.avatarUrl)}" alt=""></span>`;
  }
  return `<span class="${className}"${style}>${escapeHtml((user?.displayName || '?').slice(0, 1))}</span>`;
}

function renderTitleEditor(record) {
  if (!appState.titleEditing) {
    return `
      <div class="title-row">
        <h2>${escapeHtml(record.title || '未命名录音')}</h2>
        <button class="btn ghost icon-btn" data-action="edit-title" title="编辑标题">✎</button>
      </div>
    `;
  }
  const titleValue = appState.titleDraft === null ? (record.title || '') : appState.titleDraft;
  return `
    <div id="title-editor" class="title-form">
      <input id="record-title-input" name="title" value="${escapeHtml(titleValue)}" maxlength="60" autofocus>
      <button class="btn primary" type="button" data-action="save-title" ${appState.busy ? 'disabled' : ''}>保存</button>
      <button class="btn" type="button" data-action="cancel-title">取消</button>
    </div>
  `;
}

function renderExternalUserIdEditor(record) {
  return `
    <form id="record-user-form" class="record-user-form">
      <div class="field">
        <label for="record-external-user-id">用户 ID</label>
        <input id="record-external-user-id" name="externalUserId" value="${escapeHtml(record.externalUserId || '')}" placeholder="打完电话后填客户后台 ID">
      </div>
      <button class="btn primary" type="button" data-action="save-record-user-id" ${appState.busy ? 'disabled' : ''}>保存 ID</button>
    </form>
  `;
}

function renderRecordProgress(record) {
  const facts = [
    record.originalFileName ? `文件：${record.originalFileName}` : '',
    record.durationSeconds ? `时长：${Math.round(record.durationSeconds / 60)} 分钟` : '',
    record.fileSize ? `大小：${formatBytes(record.fileSize)}` : '',
    record.asrTaskId ? '转写任务已提交' : '',
  ].filter(Boolean);
  const idleMs = record.lastProgressAt ? Date.now() - new Date(record.lastProgressAt).getTime() : 0;
  const longRunning = isInProgress(record.status) && idleMs > 5 * 60 * 1000;
  const veryLongRunning = isInProgress(record.status) && idleMs > 20 * 60 * 1000;
  return `
    <div class="progress-box">
      <div class="progress-steps">
        ${progressStepsFor(record).map((status) => `
          <span class="${progressStepClass(record.status, status)}">${statusLabel(status)}</span>
        `).join('')}
      </div>
      <div class="progress-current ${record.status === 'failed' ? 'failed' : ''}">
        <strong>${escapeHtml(statusLabel(record.status) || '处理中')}</strong>
        <span>${escapeHtml(progressDescription(record))}</span>
      </div>
      ${facts.length ? `<div class="meta">${facts.map(escapeHtml).join(' · ')}</div>` : ''}
      ${renderRecordFileEntries(record)}
      ${renderProcessingTimeline(record)}
      <div class="btn-row">
        <button class="btn" type="button" data-action="copy-processing-diagnostics">复制处理诊断</button>
        ${veryLongRunning && record.asrTaskId ? '<button class="btn" type="button" data-action="transcribe-record">重新查询 DashScope 状态</button>' : ''}
      </div>
      ${veryLongRunning ? '<div class="hint">长录音或服务排队中，任务 ID 已保存，可稍后回来查看或重新查询状态。</div>' : longRunning ? '<div class="hint">仍在转写，可离开页面稍后查看。</div>' : ''}
      ${record.status === 'transcribed' ? renderRecordRetryButton(record) : ''}
      ${record.status === 'failed' ? renderRecordRetryButton(record) : ''}
    </div>
  `;
}

function renderProcessingTimeline(record) {
  const events = Array.isArray(record.processingEvents) ? record.processingEvents.slice(-6) : [];
  if (!events.length) return '';
  return `
    <div class="processing-timeline">
      <strong>最近处理进度</strong>
      ${events.map((event) => `
        <div>
          <span>${escapeHtml(formatDate(event.createdAt))}</span>
          <p>${escapeHtml(event.message || statusLabel(event.phase) || event.phase || '')}</p>
        </div>
      `).join('')}
    </div>
  `;
}

function progressStepClass(current, step) {
  const order = ['uploaded', 'transcribing', 'summarizing', 'transcribed', 'completed'];
  if (current === 'failed') return 'failed';
  return order.indexOf(current) >= order.indexOf(step) ? 'active' : '';
}

function progressStepsFor(record) {
  if (record.status === 'transcribed') return ['uploaded', 'transcribing', 'transcribed', 'completed'];
  return record.status === 'failed' ? ['uploaded', 'transcribing', 'summarizing', 'failed'] : ['uploaded', 'transcribing', 'summarizing', 'completed'];
}

function progressDescription(record) {
  if (record.status === 'uploaded') return '录音已上传，后台准备转写。';
  if (record.status === 'transcribing') return '正在把录音转成带时间戳的逐字稿。';
  if (record.status === 'transcribed') return record.errorMessage || '逐字稿已生成，AI 总结待重试。';
  if (record.status === 'summarizing') return '正在生成结果，请稍等。';
  if (record.status === 'completed') return '录音、逐字稿和结果已就绪。';
  if (record.status === 'failed') return record.errorMessage || '处理失败，请检查配置或重新生成。';
  return '等待处理。';
}

function renderRecordFileEntries(record) {
  const audioReady = Boolean(record.audioUrl);
  const transcriptReady = hasTranscriptContent(record);
  const summaryReady = hasSummaryContent(record);
  return `
    <div class="file-entry-row">
      ${renderFileEntry('录音', audioReady, audioReady ? authedUrl(record.audioUrl) : '')}
      ${renderFileEntry('逐字稿', transcriptReady, transcriptReady ? '#transcript-section' : '')}
      ${renderFileEntry('总结', summaryReady, summaryReady ? '#summary-section' : '')}
    </div>
  `;
}

function renderFileEntry(label, enabled, href) {
  if (!enabled) return `<span class="file-entry disabled">${escapeHtml(label)}<small>未就绪</small></span>`;
  return `<a class="file-entry enabled" href="${escapeHtml(href)}" ${href.startsWith('#') ? '' : 'target="_blank" rel="noopener"'}>${escapeHtml(label)}<small>可打开</small></a>`;
}

function renderRecordRetryButton(record) {
  return hasTranscriptContent(record)
    ? '<button class="btn" type="button" data-action="summarize-record">重新生成</button>'
    : '<button class="btn" type="button" data-action="transcribe-record">重新转写</button>';
}

function renderSettingsSyncRules(status) {
  return `
    <div class="settings-sync">
      <h3>员工端同步</h3>
      <div class="sync-grid">
        <span>DashScope/R2/总结模型池参数</span><strong>下次上传或总结立即使用</strong>
        <span>演示模式</span><strong>下次处理立即生效</strong>
        <span>个人资料和 AI 偏好</span><strong>重新生成总结时使用</strong>
        <span>员工插件连接地址</span><strong>服务器地址变更时需在登录页修改</strong>
      </div>
      <div class="hint">当前后端公开地址：${escapeHtml(status.publicBaseUrl || appState.runtime?.publicBaseUrl || appState.apiBaseUrl)}</div>
    </div>
  `;
}

function syncPolling() {
  const shouldPollDetail = appState.view === 'detail' && appState.detail && isInProgress(appState.detail.status);
  if (shouldPollDetail && !detailPollTimer) detailPollTimer = window.setInterval(pollDetail, 3000);
  if (!shouldPollDetail && detailPollTimer) {
    window.clearInterval(detailPollTimer);
    detailPollTimer = 0;
  }

  const shouldPollRecords = ['home', 'history'].includes(appState.view) && appState.records.some((record) => isInProgress(record.status));
  if (shouldPollRecords && !recordsPollTimer) recordsPollTimer = window.setInterval(pollRecords, 5000);
  if (!shouldPollRecords && recordsPollTimer) {
    window.clearInterval(recordsPollTimer);
    recordsPollTimer = 0;
  }
}

async function pollDetail() {
  if (!appState.detail || appState.busy) return;
  try {
    const body = await api(`/api/records/${appState.detail.id}`);
    appState.detail = body.record;
    await loadRecords();
    render();
  } catch (error) {
    setStatus(error.message || String(error), 'error');
    render();
  }
}

async function pollRecords() {
  if (appState.busy) return;
  try {
    await loadRecords();
    render();
  } catch {
    syncPolling();
  }
}

function isInProgress(status) {
  return ['created', 'uploading', 'uploaded', 'transcribing', 'summarizing'].includes(status);
}

function titleSourceLabel(value) {
  return ({
    manual: '人工命名',
    ai: 'AI 命名',
    filename: '文件名',
    page: '网页标题',
  })[value] || '标题';
}

function roleLabel(value) {
  return ({
    employee: '普通员工',
    department_lead: '部门领导',
    admin: '管理员',
    boss: '老板',
  })[value] || value || '';
}

function defaultCandidateTitle(candidate) {
  return candidate.recordingTitle || usefulPageTitle(candidate.pageTitle) || usefulCandidateName(candidate.name) || '当前页录音';
}

function primaryCandidateIndex() {
  const uploadable = appState.candidates.findIndex((candidate) => candidate.uploadable !== false);
  return uploadable >= 0 ? uploadable : 0;
}

function usefulPageTitle(title) {
  const value = String(title || '').trim();
  if (!value) return '';
  if (/^(plaud|plaud\s*网页端|网页端)$/i.test(value)) return '';
  return value;
}

function usefulCandidateName(name) {
  const value = String(name || '').trim();
  if (!value) return '';
  if (/^(me|account|profile|user|user-app|download|file|object)$/i.test(value)) return '';
  return value;
}

function candidateSubtitle(candidate) {
  const parts = [];
  const duration = formatCandidateDuration(candidate.durationSeconds);
  if (duration) parts.push(duration);
  if (candidate.size) parts.push(formatBytes(candidate.size));
  if (candidate.type) parts.push(String(candidate.type).toUpperCase());
  if (!parts.length) parts.push(candidate.current ? '当前播放中' : '已从当前页面捕获');
  return parts.join(' · ');
}

function formatCandidateDuration(seconds) {
  const total = Number(seconds || 0);
  if (!Number.isFinite(total) || total <= 0) return '';
  return `${Math.max(1, Math.round(total / 60))} 分钟`;
}

function testTargetForGroup(groupId) {
  return ({
    service: 'publicBaseUrl',
    asr: 'dashscope',
    storage: 'r2',
    llm: 'llm',
  })[groupId] || 'all';
}

async function api(path, options = {}) {
  const headers = {};
  let body;
  if (options.form) {
    body = options.form;
  } else if (options.body !== undefined) {
    headers['Content-Type'] = 'application/json';
    body = JSON.stringify(options.body);
  }
  if (!options.skipAuth && appState.accessToken) {
    headers.Authorization = `Bearer ${appState.accessToken}`;
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || DEFAULT_REQUEST_TIMEOUT_MS);
  let response;
  try {
    response = await fetch(`${activeApiBaseUrl()}${path}`, {
      method: options.method || 'GET',
      headers,
      body,
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') {
      throw new Error('请求超时，请确认后端服务是否正常。');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    if (response.status === 401 && !options.skipAuth) await logout(false);
    const error = new Error(data.error || `请求失败：${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

function setActionState(actionKey, patch = {}) {
  if (!actionKey) return;
  appState.activeAction = actionKey;
  appState.actionStates[actionKey] = {
    ...(appState.actionStates[actionKey] || {}),
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  appState.busy = Object.values(appState.actionStates).some((state) => state.status === 'busy');
}

function clearActionState(actionKey) {
  delete appState.actionStates[actionKey];
  appState.busy = Object.values(appState.actionStates).some((state) => state.status === 'busy');
}

function isActionBusy(actionKey) {
  return appState.actionStates[actionKey]?.status === 'busy';
}

async function runAction(actionKey, task, options = {}) {
  setActionState(actionKey, { status: 'busy', message: options.message || '' });
  if (options.renderStart) render();
  try {
    const result = await task();
    if (options.successMessage) {
      setActionState(actionKey, { status: 'success', message: options.successMessage });
    } else if (options.clearOnSuccess !== false) {
      clearActionState(actionKey);
    }
    return result;
  } catch (error) {
    const message = error.message || String(error);
    setActionState(actionKey, { status: 'error', message });
    setStatus(message, 'error');
  } finally {
    if (options.renderEnd) render();
  }
}

async function runBusy(task, shouldRender = false) {
  return runAction('busy.general', task, {
    renderStart: shouldRender,
    renderEnd: shouldRender,
  });
}

async function logout(shouldRender) {
  if (detailPollTimer) window.clearInterval(detailPollTimer);
  if (recordsPollTimer) window.clearInterval(recordsPollTimer);
  clearScanEmptyHint();
  detailPollTimer = 0;
  recordsPollTimer = 0;
  appState.accessToken = '';
  appState.currentUser = null;
  appState.records = [];
  appState.detail = null;
  appState.profile = null;
  appState.scanActive = false;
  appState.transcriptVisibleCount = TRANSCRIPT_RENDER_BATCH;
  appState.titleDraft = null;
  appState.processingChoices = {};
  appState.speakerEditing = null;
  await storageSet({ accessToken: '', currentUser: null });
  appState.view = 'login';
  if (shouldRender) render();
}

function setStatus(message, type = '') {
  appState.status = message;
  appState.statusType = type;
}

function installClientErrorHandlers() {
  if (clientErrorHandlersInstalled || typeof window === 'undefined' || !window.addEventListener) return;
  clientErrorHandlersInstalled = true;
  window.addEventListener('error', (event) => {
    reportClientError(event.error || event.message || '未知脚本错误', {
      source: 'window.error',
      filename: event.filename || '',
      line: event.lineno || 0,
      column: event.colno || 0,
    });
  });
  window.addEventListener('unhandledrejection', (event) => {
    reportClientError(event.reason || '未处理的异步错误', { source: 'unhandledrejection' });
  });
}

function reportClientError(error, context = {}) {
  const message = extensionContextMessage(error) || String(error?.message || error || '未知错误');
  const entry = {
    time: new Date().toISOString(),
    message,
    stack: String(error?.stack || ''),
    view: appState.view,
    action: context.action || appState.activeAction || '',
    context,
  };
  appState.clientErrors = [entry, ...appState.clientErrors].slice(0, 20);
  storageSet({ clientErrors: appState.clientErrors }).catch(() => {});
  setStatus(message, 'error');
  if (app && appState.view !== 'loading') {
    try {
      render();
    } catch {
      // Keep the original error visible in storage if rendering itself fails.
    }
  }
}

function copyProcessingDiagnostics() {
  const record = appState.detail;
  if (!record) return Promise.resolve();
  return copyText(JSON.stringify({
    type: 'record-processing',
    time: new Date().toISOString(),
    recordId: record.id,
    status: record.status,
    title: record.title,
    fileName: record.originalFileName,
    fileSize: record.fileSize,
    durationSeconds: record.durationSeconds,
    r2KeyExists: Boolean(record.r2Key),
    asrTaskId: record.asrTaskId || '',
    lastProgressAt: record.lastProgressAt || '',
    latestError: record.errorMessage || '',
    events: record.processingEvents || [],
  }, null, 2)).then(() => {
    setStatus('处理诊断已复制', 'success');
    render();
  });
}

function extensionContextMessage(error) {
  const raw = String(error?.message || error || '');
  if (/Extension context invalidated|context invalidated|Receiving end does not exist/i.test(raw)) {
    return '扩展上下文已失效，请重新打开侧栏或重新加载扩展。';
  }
  return '';
}

function copyClientDiagnostics() {
  return copyText(JSON.stringify({
    type: 'sidepanel',
    time: new Date().toISOString(),
    view: appState.view,
    activeAction: appState.activeAction,
    status: appState.status,
    loggedIn: Boolean(appState.accessToken),
    backendUrl: activeApiBaseUrl(),
    extensionVersion: currentExtensionVersion(),
    candidatesCount: appState.candidates.length,
    scanActive: appState.scanActive,
    scanStartedAt: appState.scanStartedAt || '',
    errors: appState.clientErrors,
    extensionDiagnostics: appState.extensionDiagnostics,
  }, null, 2)).then(() => {
    setStatus('前端诊断已复制', 'success');
    render();
  });
}

async function clearClientErrors() {
  appState.clientErrors = [];
  await storageSet({ clientErrors: [] });
  setStatus('错误诊断已清除', 'success');
  render();
}

async function copyExtensionDiagnostics() {
  const diagnostics = await getExtensionDiagnostics();
  appState.extensionDiagnostics = diagnostics;
  await copyText(JSON.stringify({
    type: 'extension',
    time: new Date().toISOString(),
    view: appState.view,
    activeAction: appState.activeAction,
    diagnostics,
  }, null, 2));
  setStatus('扩展诊断已复制', 'success');
  render();
}

function getExtensionDiagnostics() {
  if (!chromeApi?.runtime?.sendMessage) {
    return Promise.resolve({
      available: false,
      reason: '当前不是 Chrome 扩展侧栏环境。',
    });
  }
  return new Promise((resolve) => {
    chromeApi.runtime.sendMessage({ type: 'GET_DIAGNOSTICS' }, (diagnostics) => {
      if (chromeApi.runtime.lastError || !diagnostics) {
        resolve({
          available: false,
          error: extensionContextMessage(chromeApi.runtime.lastError) || chromeApi.runtime.lastError?.message || '无法读取扩展诊断。',
        });
        return;
      }
      resolve(diagnostics);
    });
  });
}

function copyText(text) {
  if (navigator?.clipboard?.writeText) return navigator.clipboard.writeText(text);
  return Promise.resolve();
}

function safeUrlHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

function templateLabel(value) {
  return (appState.templates.find((template) => template.value === value) || {}).label || value || '';
}

function followupLabel(value) {
  return (appState.followupOptions.find((option) => option.value === value) || {}).label || value || '';
}

function formatLabel(format) {
  return ({ md: 'Markdown', txt: 'TXT', docx: 'DOCX', pdf: 'PDF', svg: 'SVG', zip: 'ZIP' })[format] || format;
}

function exportTargetLabel(target) {
  return ({
    summary: '总结',
    overview_card: '总结卡片',
    mind_map: '思维导图',
    transcript: '逐字稿',
    full_record: '完整记录',
    all_files: '全部文件',
  })[target] || '文件';
}

function currentTemplateType() {
  return appState.preferredTemplateType || appState.defaultTemplate || 'meeting_minutes';
}

function currentFollowupType() {
  return appState.preferredFollowupType || appState.defaultFollowupType || 'none';
}

function statusLabel(status) {
  return {
    created: '已创建',
    uploading: '上传中',
    uploaded: '已上传',
    transcribing: '转写中',
    transcribed: '已转写，待生成总结',
    summarizing: '总结中',
    completed: '完成',
    failed: '失败',
    cancelled: '已取消',
  }[status] || status || '';
}

function formatDate(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.getMonth() + 1}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
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

function authedUrl(path) {
  const base = activeApiBaseUrl();
  const url = path.startsWith('http') ? new URL(path) : new URL(path, `${base}/`);
  if (appState.accessToken) url.searchParams.set('access_token', appState.accessToken);
  return url.href;
}

function apiDownloadUrl(path) {
  const base = activeApiBaseUrl();
  const url = path.startsWith('http') ? new URL(path) : new URL(path, `${base}/`);
  if (url.pathname.startsWith('/api/')) {
    return `${base}${url.pathname}${url.search}`;
  }
  return url.href;
}

function authedDownloadUrl(path, downloadToken = '') {
  const url = new URL(apiDownloadUrl(path));
  if (downloadToken) url.searchParams.set('download_token', downloadToken);
  return url.href;
}

function activeApiBaseUrl() {
  return (IS_HOSTED_PAGE ? window.location.origin : appState.apiBaseUrl).replace(/\/$/, '');
}

function showExportNotice(message) {
  appState.exportNotice = message;
  const header = document.querySelector('.recording-workbench-header');
  if (!header) return;
  let notice = header.querySelector('.export-notice');
  if (!notice) {
    notice = document.createElement('div');
    notice.className = 'export-notice';
    header.appendChild(notice);
  }
  notice.textContent = message;
}

function cssEscape(value) {
  if (window.CSS?.escape) return window.CSS.escape(value);
  return String(value).replace(/["\\]/g, '\\$&');
}

function formFromEvent(event, formId) {
  event?.preventDefault?.();
  const target = event?.currentTarget;
  return target?.closest?.('form') || document.getElementById(formId);
}

function formatBytes(size) {
  if (!size) return '大小未知';
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

function fileNameFromUrl(url) {
  try {
    const parsed = new URL(url);
    return decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || 'record.mp3');
  } catch {
    return 'record.mp3';
  }
}

function supportedCandidateFileName(candidate, blobType) {
  const originalName = candidate.name || fileNameFromUrl(candidate.url);
  const existingExt = safeExtension(originalName);
  if (isSupportedAudioExtension(existingExt)) return originalName;
  const candidateExt = isSupportedAudioExtension(candidate.type) ? candidate.type : '';
  const blobExt = extensionForContentType(blobType || candidate.contentType);
  const ext = candidateExt || blobExt;
  if (!ext) throw new Error('无法判断该网页录音格式，请尝试下载后用“上传录音文件”处理。');
  return `${originalName.replace(/\.[^.]+$/, '')}.${ext}`;
}

function isSupportedAudioExtension(value) {
  return ['mp3', 'm4a', 'wav', 'aac', 'flac', 'ogg', 'opus', 'mp4', 'mov', 'webm'].includes(String(value || '').toLowerCase());
}

function safeExtension(fileName) {
  return String(fileName || '').split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function extensionForContentType(contentType) {
  return ({
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/mp4': 'm4a',
    'audio/x-m4a': 'm4a',
    'audio/aac': 'aac',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/flac': 'flac',
    'audio/ogg': 'ogg',
    'audio/opus': 'opus',
    'video/mp4': 'mp4',
    'video/quicktime': 'mov',
    'video/webm': 'webm',
  })[String(contentType || '').split(';')[0].trim().toLowerCase()] || '';
}

function sanitizeFileName(value) {
  return String(value || 'record.md').replace(/[\\/:*?"<>|]/g, '_');
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function renderMarkdown(markdown) {
  const html = [];
  let listOpen = false;
  const closeList = () => {
    if (!listOpen) return;
    html.push('</ul>');
    listOpen = false;
  };
  for (const rawLine of String(markdown || '').split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const trimmed = line.trim();
    if (!trimmed) {
      closeList();
      continue;
    }
    const heading = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (heading) {
      closeList();
      const level = Math.min(3, heading[1].length);
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    if (/^>\s+/.test(trimmed)) {
      closeList();
      html.push(`<blockquote>${renderInlineMarkdown(trimmed.replace(/^>\s+/, ''))}</blockquote>`);
      continue;
    }
    const listItem = line.match(/^[-*+]\s+(.+)$/);
    if (listItem) {
      if (!listOpen) {
        html.push('<ul>');
        listOpen = true;
      }
      html.push(`<li>${renderInlineMarkdown(listItem[1])}</li>`);
      continue;
    }
    closeList();
    html.push(`<p>${renderInlineMarkdown(trimmed)}</p>`);
  }
  closeList();
  return html.join('');
}

function renderInlineMarkdown(value) {
  return escapeHtml(value).replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
}

function storageGet(keys) {
  if (chromeApi?.storage?.local) {
    return chromeApi.storage.local.get(keys);
  }
  const result = {};
  keys.forEach((key) => {
    const value = localStorage.getItem(key);
    result[key] = ['currentUser', 'clientErrors'].includes(key) && value ? JSON.parse(value) : value;
  });
  return Promise.resolve(result);
}

function storageSet(values) {
  if (chromeApi?.storage?.local) {
    return chromeApi.storage.local.set(values);
  }
  Object.entries(values).forEach(([key, value]) => {
    localStorage.setItem(key, ['currentUser', 'clientErrors'].includes(key) ? JSON.stringify(value) : String(value || ''));
  });
  return Promise.resolve();
}
