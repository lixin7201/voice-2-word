const chromeApi = typeof chrome === 'undefined' ? null : chrome;
const IS_HOSTED_PAGE = typeof window !== 'undefined' && ['http:', 'https:'].includes(window.location.protocol);
const IS_EXTENSION_SURFACE = Boolean(chromeApi?.runtime?.id);
const DEFAULT_API_BASE_URL = IS_HOSTED_PAGE ? window.location.origin : 'http://lixindemac-studio.local:8127';
const STORAGE_KEYS = ['apiBaseUrl', 'accessToken', 'currentUser'];

const appState = {
  apiBaseUrl: DEFAULT_API_BASE_URL,
  accessToken: '',
  currentUser: null,
  permissions: {},
  templates: [],
  defaultTemplate: 'meeting_minutes',
  view: 'loading',
  status: '',
  statusType: '',
  records: [],
  detail: null,
  detailTab: 'summary',
  candidates: [],
  departments: [],
  employees: [],
  settingGroups: [],
  systemStatus: null,
  busy: false,
};

const app = document.getElementById('app');

document.addEventListener('DOMContentLoaded', init);

async function init() {
  const stored = await storageGet(STORAGE_KEYS);
  appState.apiBaseUrl = stored.apiBaseUrl || DEFAULT_API_BASE_URL;
  appState.accessToken = stored.accessToken || '';
  appState.currentUser = stored.currentUser || null;

  if (chromeApi?.runtime?.onMessage) {
    chromeApi.runtime.onMessage.addListener((request) => {
      if (request.type === 'STATE_UPDATE' && request.state) {
        handleBackgroundState(request.state);
      }
    });
  }

  if (appState.accessToken) {
    try {
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
  document.body.dataset.view = appState.view;
  if (appState.view === 'login' || appState.view === 'loading') {
    app.innerHTML = renderLogin();
    bindLogin();
    return;
  }

  app.innerHTML = [
    renderTopbar(),
    renderNav(),
    renderStatus(),
    renderCurrentView(),
  ].join('');
  bindCommon();
  bindCurrentView();
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
              <input id="loginName" name="loginName" autocomplete="username" placeholder="离心">
            </div>
            <div class="field">
              <label for="password">密码</label>
              <input id="password" name="password" type="password" autocomplete="current-password" placeholder="默认 dayibin">
            </div>
          </div>
          <button class="btn primary" type="submit" ${appState.busy ? 'disabled' : ''}>登录</button>
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
      <div class="brand">
        <h1 class="brand-title">大宜宾录音助手</h1>
        <div class="brand-subtitle">${escapeHtml(departments)}</div>
      </div>
      <button class="btn ghost user-chip" data-action="logout" title="退出登录">
        <span class="avatar">${escapeHtml((user?.displayName || '?').slice(0, 1))}</span>
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
        <button data-view="${view}" class="${appState.view === view ? 'active' : ''}">${label}</button>
      `).join('')}
    </nav>
  `;
}

function renderStatus() {
  if (!appState.status) return '';
  return `<div class="status ${escapeHtml(appState.statusType)}">${escapeHtml(appState.status)}</div>`;
}

function renderCurrentView() {
  if (appState.view === 'home') return renderHome();
  if (appState.view === 'capture') return renderCapture();
  if (appState.view === 'upload') return renderUpload();
  if (appState.view === 'history') return renderHistory();
  if (appState.view === 'detail') return renderDetail();
  if (appState.view === 'employees') return renderEmployees();
  if (appState.view === 'settings') return renderSettings();
  return renderHome();
}

function renderHome() {
  const recent = appState.records.slice(0, 5);
  const completed = appState.records.filter((record) => record.status === 'completed').length;
  const failed = appState.records.filter((record) => record.status === 'failed').length;
  return `
    <div class="stack">
      <section class="glass section stack">
        <div class="stats">
          <div class="stat"><strong>${appState.records.length}</strong><span class="meta">历史记录</span></div>
          <div class="stat"><strong>${completed}</strong><span class="meta">已完成</span></div>
          <div class="stat"><strong>${failed}</strong><span class="meta">失败任务</span></div>
        </div>
        <div class="btn-row">
          ${IS_EXTENSION_SURFACE ? '<button class="btn primary" data-view="capture">监听当前页录音</button>' : ''}
          <button class="btn primary" data-view="upload">上传录音文件</button>
          <button class="btn" data-view="history">查看历史记录</button>
        </div>
      </section>
      <section class="glass section">
        <h2>最近历史</h2>
        ${recent.length ? renderRecordList(recent) : '<div class="empty">暂无录音记录</div>'}
      </section>
    </div>
  `;
}

function renderCapture() {
  return `
    <section class="glass section stack">
      <div>
        <h2>监听当前页录音</h2>
        <div class="meta">打开网页录音并点击播放后，回到这里扫描候选音频。</div>
      </div>
      <div class="wave" aria-hidden="true">${Array.from({ length: 18 }, () => '<span></span>').join('')}</div>
      <div class="field">
        <label for="capture-template">总结模板</label>
        ${renderTemplateSelect('capture-template', appState.defaultTemplate)}
      </div>
      <div class="btn-row">
        <button class="btn primary" data-action="scan-page" ${appState.busy ? 'disabled' : ''}>扫描当前网页</button>
        <button class="btn" data-view="upload">手动上传</button>
      </div>
      ${renderCandidateList()}
    </section>
  `;
}

function renderCandidateList() {
  if (!appState.candidates.length) return '<div class="empty">还没有发现候选录音</div>';
  return `
    <div class="candidate-list">
      ${appState.candidates.map((candidate, index) => `
        <div class="item">
          <div class="item-title">
            <span>${escapeHtml(candidate.name || `候选 ${index + 1}`)}</span>
            <span class="badge ${candidate.uploadable === false ? 'failed' : ''}">${candidate.uploadable === false ? '需处理' : escapeHtml(candidate.type || 'media')}</span>
          </div>
          <div class="meta">${escapeHtml(candidate.source || 'network')} · ${escapeHtml(candidate.contentType || candidate.type || 'media')} · ${formatBytes(candidate.size || 0)}</div>
          <div class="meta">${escapeHtml(candidate.url || '')}</div>
          ${candidate.uploadable === false ? `<div class="status error">${escapeHtml(candidate.unsupportedReason || '该候选暂不能直接上传为单个录音文件。')}</div>` : ''}
          <div class="btn-row" style="margin-top:8px">
            <button class="btn primary" data-action="upload-candidate" data-index="${index}" ${appState.busy || candidate.uploadable === false ? 'disabled' : ''}>开始识别</button>
          </div>
        </div>
      `).join('')}
    </div>
  `;
}

function renderUpload() {
  return `
    <section class="glass section stack">
      <div>
        <h2>上传录音文件</h2>
        <div class="meta">支持 mp3、m4a、wav、aac、flac、ogg、opus、mp4、mov、webm。</div>
      </div>
      <form id="upload-form" class="form">
        <div class="field">
          <label for="audioFile">录音文件</label>
          <input id="audioFile" name="audioFile" type="file" accept=".mp3,.m4a,.wav,.aac,.flac,.ogg,.opus,.mp4,.mov,.webm,audio/*,video/*">
        </div>
        <div class="field">
          <label for="upload-title">标题</label>
          <input id="upload-title" name="title" placeholder="例如：招聘客户电话沟通">
        </div>
        <div class="field">
          <label for="upload-template">总结模板</label>
          ${renderTemplateSelect('upload-template', appState.defaultTemplate)}
        </div>
        <button class="btn primary" type="submit" ${appState.busy ? 'disabled' : ''}>上传并开始识别</button>
      </form>
    </section>
  `;
}

function renderHistory() {
  return `
    <section class="glass section stack">
      <div class="item-title">
        <h2>历史记录</h2>
        <button class="btn" data-action="refresh-records">刷新</button>
      </div>
      ${appState.records.length ? renderRecordList(appState.records) : '<div class="empty">暂无录音记录</div>'}
    </section>
  `;
}

function renderRecordList(records) {
  return `
    <div class="record-list">
      ${records.map((record) => `
        <div class="item" data-action="open-record" data-id="${escapeHtml(record.id)}">
          <div class="item-title">
            <span>${escapeHtml(record.title || record.originalFileName || '未命名录音')}</span>
            <span class="badge ${escapeHtml(record.status)}">${statusLabel(record.status)}</span>
          </div>
          <div class="meta">${escapeHtml(record.owner?.displayName || '')} · ${escapeHtml(record.department?.name || '未分配')} · ${escapeHtml(templateLabel(record.templateType))}</div>
          <div class="meta">${formatDate(record.createdAt)}${record.errorMessage ? ` · ${escapeHtml(record.errorMessage)}` : ''}</div>
        </div>
      `).join('')}
    </div>
  `;
}

function renderDetail() {
  const record = appState.detail;
  if (!record) return '<section class="glass section"><div class="empty">未选择记录</div></section>';
  const tabs = [
    ['summary', '总结'],
    ['transcript', '逐字稿'],
    ['followup', '跟单'],
    ['notes', '备注'],
    ['export', '导出'],
  ];
  return `
    <div class="stack">
      <section class="glass section detail-header">
        <button class="btn ghost" data-view="history">返回历史</button>
        <h2>${escapeHtml(record.title)}</h2>
        <div class="meta">${escapeHtml(record.owner?.displayName || '')} · ${escapeHtml(record.department?.name || '')} · ${formatDate(record.createdAt)}</div>
        <div class="btn-row">
          <span class="badge ${escapeHtml(record.status)}">${statusLabel(record.status)}</span>
          <span class="badge">${escapeHtml(templateLabel(record.templateType))}</span>
        </div>
        ${record.errorMessage ? `<div class="status error">${escapeHtml(record.errorMessage)}</div>` : ''}
      </section>
      <section class="glass section">
        <div class="tabbar">
          ${tabs.map(([tab, label]) => `<button data-tab="${tab}" class="${appState.detailTab === tab ? 'active' : ''}">${label}</button>`).join('')}
        </div>
        ${renderDetailTab(record)}
      </section>
    </div>
  `;
}

function renderDetailTab(record) {
  if (appState.detailTab === 'summary') {
    return `
      <div class="btn-row" style="margin-bottom:10px">
        <button class="btn" data-action="summarize-record">重新生成总结</button>
      </div>
      <div class="markdown">${escapeHtml(record.summary?.summary_markdown || '暂无总结')}</div>
    `;
  }
  if (appState.detailTab === 'transcript') {
    const text = record.transcript?.corrected_text || record.transcript?.raw_text || '暂无逐字稿';
    return `
      <div class="btn-row" style="margin-bottom:10px">
        <button class="btn" data-action="transcribe-record">重新转写</button>
      </div>
      <div class="markdown">${escapeHtml(text)}</div>
    `;
  }
  if (appState.detailTab === 'followup') {
    const followup = record.followupForm || {};
    return `
      <form id="followup-form" class="form">
        <div class="grid-2">
          <div class="field">
            <label for="followup-stage">阶段</label>
            <select id="followup-stage" name="stage">
              ${renderRecruitmentStageOptions(followup.stage || '')}
            </select>
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
        <button class="btn primary" type="submit">保存跟单修改</button>
      </form>
    `;
  }
  if (appState.detailTab === 'notes') {
    return `
      <form id="note-form" class="form">
        <div class="field">
          <label for="note">新增备注</label>
          <textarea id="note" name="note"></textarea>
        </div>
        <button class="btn primary" type="submit">保存备注</button>
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
  return `
    <div class="btn-row">
      <button class="btn primary" data-action="export-record" data-target="full_record" data-format="md">导出 Markdown</button>
      <button class="btn" data-action="export-record" data-target="transcript" data-format="txt">导出 TXT</button>
      <button class="btn" data-action="export-record" data-target="full_record" data-format="docx">导出 DOCX</button>
      <button class="btn" data-action="export-record" data-target="full_record" data-format="pdf">导出 PDF</button>
    </div>
  `;
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
            <select id="departmentId" name="departmentId">
              <option value="">管理层/待分配</option>
              ${appState.departments.map((department) => `
                <option value="${escapeHtml(department.id)}">${escapeHtml(department.name)}</option>
              `).join('')}
            </select>
          </div>
          <div class="field">
            <label for="globalRole">角色</label>
            <select id="globalRole" name="globalRole">
              <option value="employee">普通员工</option>
              <option value="department_lead">部门领导</option>
              <option value="admin">管理员</option>
              <option value="boss">老板</option>
            </select>
          </div>
        </div>
        <button class="btn primary" type="submit">新增员工</button>
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
  return `
    <section class="glass section stack">
      <div class="item-title">
        <h2>后台配置</h2>
        <button class="btn" data-action="refresh-settings">刷新</button>
      </div>
      <div class="settings-status">
        ${renderConfigBadge('R2 存储', status.r2Configured)}
        ${renderConfigBadge('录音转文字', status.dashscopeConfigured)}
        ${renderConfigBadge('总结模型', status.llmConfigured)}
        ${renderConfigBadge('演示模式', status.devFakeAsr)}
      </div>
      <form id="settings-form" class="form">
        ${(appState.settingGroups || []).map(renderSettingGroup).join('') || '<div class="empty">正在读取后台配置...</div>'}
        <button class="btn primary" type="submit" ${appState.busy ? 'disabled' : ''}>保存后台配置</button>
      </form>
    </section>
  `;
}

function renderConfigBadge(label, ok) {
  return `<span class="badge ${ok ? 'completed' : 'failed'}">${escapeHtml(label)}：${ok ? '已配置' : '未配置'}</span>`;
}

function renderSettingGroup(group) {
  return `
    <div class="setting-group">
      <div>
        <h3>${escapeHtml(group.title)}</h3>
        ${group.description ? `<div class="hint">${escapeHtml(group.description)}</div>` : ''}
      </div>
      ${(group.fields || []).map(renderSettingField).join('')}
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
    return `
      <div class="field">
        <label for="${escapeHtml(id)}">${escapeHtml(field.label)}</label>
        <select id="${escapeHtml(id)}" data-setting-key="${escapeHtml(field.key)}">
          ${(field.options || []).map((option) => `
            <option value="${escapeHtml(option.value)}" ${String(field.value) === String(option.value) ? 'selected' : ''}>${escapeHtml(option.label)}</option>
          `).join('')}
        </select>
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
        data-secret="${field.secret ? '1' : '0'}"
        type="${field.type === 'password' ? 'password' : field.type === 'number' ? 'number' : 'text'}"
        value="${field.secret ? '' : escapeHtml(field.value || '')}"
        placeholder="${field.secret && field.configured ? `已保存：${escapeHtml(field.maskedValue || '已配置')}` : ''}"
      >
      ${field.secret ? `<label class="inline-check"><input type="checkbox" data-clear-key="${escapeHtml(field.key)}"> 清空已保存密钥</label>` : ''}
      ${help ? `<div class="hint">${escapeHtml(help)}</div>` : ''}
    </div>
  `;
}

function renderRecruitmentStageOptions(selected) {
  const stages = [
    ['initial_effective_followup', '初期有效跟进'],
    ['mid_effective_followup', '中期有效跟进'],
    ['no_hiring_followup', '暂不招人有效跟进'],
    ['mid_late_effective_followup', '中后期有效跟进'],
    ['late_effective_followup', '后期有效跟进'],
  ];
  return [
    `<option value="">未判断/不适用</option>`,
    ...stages.map(([value, label]) => `<option value="${value}" ${value === selected ? 'selected' : ''}>${label}</option>`),
  ].join('');
}

function renderTemplateSelect(id, selected) {
  const templates = appState.templates.length ? appState.templates : [
    { value: 'meeting_minutes', label: '会议纪要' },
    { value: 'business_review', label: '业务复盘' },
    { value: 'customer_follow_up', label: '通用客户跟进' },
    { value: 'matchmaker_profile', label: '红娘客户画像' },
    { value: 'recruitment_followup', label: '招聘客户跟进' },
  ];
  return `
    <select id="${id}" name="templateType">
      ${templates.map((template) => `
        <option value="${escapeHtml(template.value)}" ${template.value === selected ? 'selected' : ''}>${escapeHtml(template.label)}</option>
      `).join('')}
    </select>
  `;
}

function bindLogin() {
  const form = document.getElementById('login-form');
  if (!form) return;
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = new FormData(form);
    appState.apiBaseUrl = String(data.get('apiBaseUrl') || DEFAULT_API_BASE_URL).trim();
    await storageSet({ apiBaseUrl: appState.apiBaseUrl });
    await runBusy(async () => {
      const body = await api('/api/auth/login', {
        method: 'POST',
        body: {
          loginName: String(data.get('loginName') || '').trim(),
          password: String(data.get('password') || ''),
        },
        skipAuth: true,
      });
      appState.accessToken = body.accessToken;
      appState.currentUser = body.employee;
      await storageSet({ accessToken: body.accessToken, currentUser: body.employee, apiBaseUrl: appState.apiBaseUrl });
      await loadMe();
      await loadDepartments();
      await loadRecords();
      setStatus('登录成功', 'success');
      appState.view = 'home';
    });
  });
}

function bindCommon() {
  document.querySelectorAll('[data-view]').forEach((button) => {
    button.addEventListener('click', async () => {
      appState.view = button.dataset.view;
      if (appState.view === 'employees') await loadEmployeesSafe();
      if (appState.view === 'settings') await loadSettingsSafe();
      render();
    });
  });

  document.querySelectorAll('[data-action="logout"]').forEach((button) => {
    button.addEventListener('click', () => logout(true));
  });
}

function bindCurrentView() {
  const scan = document.querySelector('[data-action="scan-page"]');
  if (scan) scan.addEventListener('click', scanPage);

  document.querySelectorAll('[data-action="upload-candidate"]').forEach((button) => {
    button.addEventListener('click', () => uploadCandidate(Number(button.dataset.index)));
  });

  const uploadForm = document.getElementById('upload-form');
  if (uploadForm) uploadForm.addEventListener('submit', uploadManualFile);

  document.querySelectorAll('[data-action="open-record"]').forEach((item) => {
    item.addEventListener('click', () => openRecord(item.dataset.id));
  });

  const refresh = document.querySelector('[data-action="refresh-records"]');
  if (refresh) refresh.addEventListener('click', async () => {
    await loadRecordsSafe();
    render();
  });

  document.querySelectorAll('[data-tab]').forEach((button) => {
    button.addEventListener('click', () => {
      appState.detailTab = button.dataset.tab;
      render();
    });
  });

  const noteForm = document.getElementById('note-form');
  if (noteForm) noteForm.addEventListener('submit', saveNote);

  const followupForm = document.getElementById('followup-form');
  if (followupForm) followupForm.addEventListener('submit', saveFollowup);

  const summarize = document.querySelector('[data-action="summarize-record"]');
  if (summarize) summarize.addEventListener('click', summarizeRecord);

  const transcribe = document.querySelector('[data-action="transcribe-record"]');
  if (transcribe) transcribe.addEventListener('click', transcribeRecord);

  document.querySelectorAll('[data-action="export-record"]').forEach((button) => {
    button.addEventListener('click', () => exportRecord(button.dataset.target, button.dataset.format));
  });

  const employeeForm = document.getElementById('employee-form');
  if (employeeForm) employeeForm.addEventListener('submit', createEmployee);

  const refreshEmployees = document.querySelector('[data-action="refresh-employees"]');
  if (refreshEmployees) refreshEmployees.addEventListener('click', async () => {
    await loadEmployeesSafe();
    render();
  });

  document.querySelectorAll('[data-action="disable-employee"], [data-action="enable-employee"], [data-action="reset-password"]').forEach((button) => {
    button.addEventListener('click', () => employeeAction(button.dataset.id, button.dataset.action));
  });

  const settingsForm = document.getElementById('settings-form');
  if (settingsForm) settingsForm.addEventListener('submit', saveSettings);

  const refreshSettings = document.querySelector('[data-action="refresh-settings"]');
  if (refreshSettings) refreshSettings.addEventListener('click', async () => {
    await loadSettingsSafe();
    render();
  });
}

async function scanPage() {
  setStatus('正在扫描当前网页...', '');
  appState.candidates = [];
  appState.busy = true;
  render();
  if (!chromeApi?.runtime?.sendMessage) {
    appState.busy = false;
    appState.candidates = [{
      url: 'https://example.com/demo.mp3',
      name: 'demo.mp3',
      type: 'mp3',
      source: 'demo',
      size: 0,
    }];
    setStatus('当前不是 Chrome 扩展环境，已显示演示候选。', 'success');
    render();
    return;
  }
  chromeApi.runtime.sendMessage({ type: 'SCAN_PAGE' });
}

function handleBackgroundState(state) {
  appState.busy = ['extracting'].includes(state.phase);
  if (Array.isArray(state.candidates)) {
    appState.candidates = state.candidates;
  } else if (state.url) {
    appState.candidates = [{ url: state.url, name: fileNameFromUrl(state.url), type: 'media', source: 'page', size: 0 }];
  }
  if (state.phase === 'error') setStatus(state.error || '扫描失败', 'error');
  if (state.phase === 'confirm') setStatus(state.statusText || '发现候选录音', 'success');
  if (state.phase === 'extracting') setStatus(state.statusText || '正在扫描...', '');
  render();
}

async function uploadCandidate(index) {
  const candidate = appState.candidates[index];
  if (!candidate?.url) return;
  if (candidate.uploadable === false) {
    setStatus(candidate.unsupportedReason || '该候选暂不能直接上传为单个录音文件。', 'error');
    render();
    return;
  }
  const templateType = document.getElementById('capture-template')?.value || appState.defaultTemplate;
  await runBusy(async () => {
    setStatus('正在读取候选录音...', '');
    const blob = await fetch(candidate.url, { credentials: 'include' }).then((response) => {
      if (!response.ok) throw new Error(`读取录音失败：HTTP ${response.status}`);
      return response.blob();
    });
    const fileName = supportedCandidateFileName(candidate, blob.type);
    const record = await createRecord({
      sourceType: 'web_capture',
      sourcePageUrl: candidate.pageUrl || '',
      sourcePageTitle: candidate.pageTitle || '',
      title: candidate.pageTitle || fileName || '网页录音',
      templateType,
      candidateUrl: candidate.url,
    });
    await uploadRecordFile(record.id, blob, fileName, { candidateUrl: candidate.url, candidateMeta: JSON.stringify(candidate) });
    await openRecord(record.id);
    await loadRecords();
    setStatus('录音已上传，任务已进入后端处理。', 'success');
  });
}

async function uploadManualFile(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const file = form.audioFile.files[0];
  if (!file) {
    setStatus('请选择录音文件', 'error');
    render();
    return;
  }
  await runBusy(async () => {
    const record = await createRecord({
      sourceType: 'manual_upload',
      title: form.title.value.trim() || file.name,
      templateType: form.templateType.value,
    });
    await uploadRecordFile(record.id, file, file.name);
    await openRecord(record.id);
    await loadRecords();
    setStatus('录音已上传，任务已进入后端处理。', 'success');
  });
}

async function createRecord(payload) {
  const body = await api('/api/records', {
    method: 'POST',
    body: payload,
  });
  return body.record;
}

async function uploadRecordFile(recordId, blob, fileName, extraFields = {}) {
  const form = new FormData();
  form.append('file', blob, fileName || 'record.mp3');
  Object.entries(extraFields).forEach(([key, value]) => form.append(key, value));
  const body = await api(`/api/records/${recordId}/upload`, {
    method: 'POST',
    form,
  });
  return body.record;
}

async function openRecord(recordId) {
  await runBusy(async () => {
    const body = await api(`/api/records/${recordId}`);
    appState.detail = body.record;
    appState.detailTab = 'summary';
    appState.view = 'detail';
  }, false);
  render();
}

async function saveNote(event) {
  event.preventDefault();
  const note = event.currentTarget.note.value.trim();
  if (!note || !appState.detail) return;
  await runBusy(async () => {
    await api(`/api/records/${appState.detail.id}/note`, {
      method: 'PATCH',
      body: { note },
    });
    await openRecord(appState.detail.id);
    setStatus('备注已保存', 'success');
  });
}

async function saveFollowup(event) {
  event.preventDefault();
  if (!appState.detail) return;
  const form = event.currentTarget;
  await runBusy(async () => {
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
    appState.detailTab = 'followup';
    setStatus('跟单已保存', 'success');
  });
}

async function summarizeRecord() {
  if (!appState.detail) return;
  await runBusy(async () => {
    await api(`/api/records/${appState.detail.id}/summarize`, {
      method: 'POST',
      body: { templateType: appState.detail.templateType, force: true },
    });
    await openRecord(appState.detail.id);
    appState.detailTab = 'summary';
    setStatus('总结已重新生成', 'success');
  });
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
  });
}

async function exportRecord(target, format) {
  if (!appState.detail) return;
  await runBusy(async () => {
    const body = await api(`/api/records/${appState.detail.id}/export`, {
      method: 'POST',
      body: { target, format },
    });
    const response = await fetch(body.downloadUrl, {
      headers: { Authorization: `Bearer ${appState.accessToken}` },
    });
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
    const blob = await response.blob();
    const blobUrl = URL.createObjectURL(blob);
    const filename = `${appState.detail.title || '录音记录'}-${target}.${format}`;
    setStatus('导出已生成。', 'success');
    if (chromeApi?.downloads?.download) {
      chromeApi.downloads.download({ url: blobUrl, filename: sanitizeFileName(filename), saveAs: true });
    } else {
      const link = document.createElement('a');
      link.href = blobUrl;
      link.download = sanitizeFileName(filename);
      link.click();
    }
  });
}

async function createEmployee(event) {
  event.preventDefault();
  const form = event.currentTarget;
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
    await loadEmployees();
    setStatus('员工已新增，默认密码 dayibin。', 'success');
  });
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
  });
}

async function saveSettings(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const settings = {};
  const clearKeys = [];

  form.querySelectorAll('[data-setting-key]').forEach((field) => {
    const key = field.dataset.settingKey;
    const value = String(field.value || '').trim();
    if (field.dataset.secret === '1') {
      if (value) settings[key] = value;
      return;
    }
    settings[key] = value;
  });

  form.querySelectorAll('[data-clear-key]:checked').forEach((field) => {
    clearKeys.push(field.dataset.clearKey);
    settings[field.dataset.clearKey] = '';
  });

  await runBusy(async () => {
    const body = await api('/api/admin/settings', {
      method: 'PUT',
      body: { settings, clearKeys },
    });
    appState.settingGroups = body.groups || [];
    appState.systemStatus = body.status || null;
    setStatus('后台配置已保存，员工端无需填写这些密钥。', 'success');
  });
}

async function loadMe() {
  const body = await api('/api/me');
  appState.currentUser = body.employee;
  appState.permissions = body.permissions || {};
  appState.templates = body.templates || [];
  appState.defaultTemplate = body.defaultTemplate || 'meeting_minutes';
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
}

async function loadSettingsSafe() {
  if (!appState.permissions.canManageSettings) return;
  await runBusy(loadSettings, false);
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
  const response = await fetch(`${appState.apiBaseUrl.replace(/\/$/, '')}${path}`, {
    method: options.method || 'GET',
    headers,
    body,
  });
  const text = await response.text();
  const data = text ? JSON.parse(text) : {};
  if (!response.ok) {
    if (response.status === 401 && !options.skipAuth) await logout(false);
    throw new Error(data.error || `请求失败：${response.status}`);
  }
  return data;
}

async function runBusy(task, shouldRender = true) {
  appState.busy = true;
  if (shouldRender) render();
  try {
    await task();
  } catch (error) {
    setStatus(error.message || String(error), 'error');
  } finally {
    appState.busy = false;
    if (shouldRender) render();
  }
}

async function logout(shouldRender) {
  appState.accessToken = '';
  appState.currentUser = null;
  appState.records = [];
  appState.detail = null;
  await storageSet({ accessToken: '', currentUser: null });
  appState.view = 'login';
  if (shouldRender) render();
}

function setStatus(message, type = '') {
  appState.status = message;
  appState.statusType = type;
}

function templateLabel(value) {
  return (appState.templates.find((template) => template.value === value) || {}).label || value || '';
}

function statusLabel(status) {
  return {
    created: '已创建',
    uploading: '上传中',
    uploaded: '已上传',
    transcribing: '转写中',
    transcribed: '已转写',
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

function storageGet(keys) {
  if (chromeApi?.storage?.local) {
    return chromeApi.storage.local.get(keys);
  }
  const result = {};
  keys.forEach((key) => {
    const value = localStorage.getItem(key);
    result[key] = key === 'currentUser' && value ? JSON.parse(value) : value;
  });
  return Promise.resolve(result);
}

function storageSet(values) {
  if (chromeApi?.storage?.local) {
    return chromeApi.storage.local.set(values);
  }
  Object.entries(values).forEach(([key, value]) => {
    localStorage.setItem(key, key === 'currentUser' ? JSON.stringify(value) : String(value || ''));
  });
  return Promise.resolve();
}
