const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function loadSidepanel(options = {}) {
  const origin = options.origin || 'http://127.0.0.1:8137';
  const dom = options.dom || null;
  const appElement = dom?.appElement || { innerHTML: '' };
  const fetchCalls = [];
  const clickedLinks = [];
  const appendedNotices = [];
  const storage = new Map();
  const timeoutDelays = [];
  const wrappedSetTimeout = (callback, delay) => {
    timeoutDelays.push(delay);
    return setTimeout(callback, delay);
  };
  const header = {
    querySelector() {
      return null;
    },
    appendChild(node) {
      appendedNotices.push(node);
    },
  };
  const document = dom?.document || {
    body: { dataset: {} },
    addEventListener() {},
    getElementById(id) {
      return id === 'app' ? appElement : null;
    },
    querySelector(selector) {
      return selector === '.recording-workbench-header' ? header : null;
    },
    querySelectorAll() {
      return [];
    },
    createElement(tagName) {
      const node = {
        tagName,
        className: '',
        textContent: '',
        href: '',
        download: '',
        click() {
          if (tagName === 'a') {
            clickedLinks.push({ href: node.href, download: node.download });
          }
        },
      };
      return node;
    },
  };
  const context = {
    AbortController,
    Blob,
    FormData,
    URL,
    clearInterval,
    clearTimeout,
    console,
    document,
    chrome: options.chrome,
    localStorage: {
      getItem(key) {
        return storage.has(key) ? storage.get(key) : null;
      },
      setItem(key, value) {
        storage.set(key, String(value));
      },
    },
    fetch: async (url, requestOptions) => {
      if (typeof options.fetchImpl === 'function') {
        return options.fetchImpl(url, requestOptions, fetchCalls);
      }
      fetchCalls.push({ url, requestOptions });
      const requestBody = requestOptions?.body && typeof requestOptions.body === 'string'
        ? JSON.parse(requestOptions.body)
        : {};
      const responseBody = typeof options.responseFor === 'function'
        ? options.responseFor(url, requestOptions, requestBody)
        : undefined;
      const exportResponse = responseBody !== undefined
        ? responseBody
        : typeof options.exportResponse === 'function'
          ? options.exportResponse(requestBody)
          : options.exportResponse;
      return {
        ok: true,
        status: 200,
        text: async () => JSON.stringify(exportResponse || {
          downloadUrl: 'http://localhost:0/api/export-files/export-summary-md',
          export: { format: 'md' },
        }),
      };
    },
    navigator: { clipboard: { writeText: async () => {} } },
    setInterval,
    setTimeout: wrappedSetTimeout,
    window: {
      addEventListener() {},
      CSS: { escape: (value) => String(value) },
      clearInterval,
      clearTimeout,
      location: { protocol: 'http:', origin },
      requestAnimationFrame: (callback) => callback(),
      setInterval,
      setTimeout: wrappedSetTimeout,
      ...(dom?.window || {}),
    },
  };
  vm.createContext(context);
  const source = fs.readFileSync(path.join(__dirname, '..', 'sidepanel.js'), 'utf8');
  vm.runInContext(`${source}
globalThis.__sidepanel = {
  appState,
  activeApiBaseUrl,
  authedDownloadUrl,
  candidateReadFailureMessage,
  exportRecord,
  fetchCandidateBlob,
  formatFollowupCopy,
  hasSummaryContent,
  handleBackgroundState,
  normalizedTranscriptSegments,
  renderDetailTab,
  renderDetail,
  renderExtensionUpdateNotice,
  renderHistory,
  renderEmployees,
  renderHome,
  renderProfile,
  renderSettingField,
  renderSettings,
  renderCapture,
  renderRecordProgress,
  renderProcessingPicker,
  setProcessingTemplateChoice,
	  renderSummaryWorkspace,
	  summarizeRecord,
	  renderTemplateSelect,
	  renderFollowupSelect,
	  renderUpload,
	  renderTitleEditor,
	  scanPage,
		  render,
		  bindCommon,
		  bindCurrentView,
		  openSharePanel,
		  uploadAvatar,
	  uploadCandidate,
	  validateCandidateBlobComplete,
	  retryCandidateUpload,
	  reportClientError,
	  clearClientErrors
	};`, context);
  return {
    api: context.__sidepanel,
    appElement,
	    appendedNotices,
	    clickedLinks,
	    fetchCalls,
	    timeoutDelays,
	  };
}

function createTestDom() {
  let documentRef;

  class TestElement {
    constructor(tagName, attrs = {}) {
      this.tagName = tagName.toUpperCase();
      this.ownerDocument = documentRef;
      this.children = [];
      this.parentNode = null;
      this.listeners = {};
      this.attributes = { ...attrs };
      this.dataset = datasetFromAttrs(attrs);
      this.id = attrs.id || '';
      this.name = attrs.name || '';
      this.type = attrs.type || '';
      this.className = attrs.class || '';
      this.value = attrs.value || '';
      this.files = [];
      this.disabled = Object.prototype.hasOwnProperty.call(attrs, 'disabled');
      this.textContent = '';
      this._innerHTML = '';
      this.classList = {
        contains: (name) => classNames(this).includes(name),
        add: (name) => {
          if (!classNames(this).includes(name)) this.className = [...classNames(this), name].join(' ');
        },
        remove: (name) => {
          this.className = classNames(this).filter((item) => item !== name).join(' ');
        },
        toggle: (name, force) => {
          const has = classNames(this).includes(name);
          const shouldAdd = force === undefined ? !has : Boolean(force);
          if (shouldAdd) this.classList.add(name);
          else this.classList.remove(name);
        },
      };
    }

    set innerHTML(value) {
      this._innerHTML = String(value || '');
      if (this.ownerDocument) this.ownerDocument.renderCount += 1;
      parseHtmlInto(this, this._innerHTML);
    }

    get innerHTML() {
      return this._innerHTML;
    }

    appendChild(node) {
      node.parentNode = this;
      node.ownerDocument = this.ownerDocument;
      this.children.push(node);
      if (node.id) this.ownerDocument.idMap.set(node.id, node);
      const form = node.name ? node.closest('form') : null;
      if (form) form[node.name] = node;
      return node;
    }

    addEventListener(type, handler) {
      this.listeners[type] = this.listeners[type] || [];
      this.listeners[type].push(handler);
    }

    async click() {
      if (['INPUT', 'TEXTAREA', 'SELECT'].includes(this.tagName)) this.focus();
      await dispatchBubblingEvent(this, 'click');
    }

    focus() {
      this.ownerDocument.activeElement = this;
    }

    closest(selector) {
      let node = this;
      while (node) {
        if (matchesSelector(node, selector)) return node;
        node = node.parentNode;
      }
      return null;
    }

    contains(target) {
      let node = target;
      while (node) {
        if (node === this) return true;
        node = node.parentNode;
      }
      return false;
    }

    querySelectorAll(selector) {
      return queryWithin(this.children, selector);
    }

    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    }

    setAttribute(name, value) {
      this.attributes[name] = String(value);
      if (name === 'class') this.className = String(value);
      if (name.startsWith('data-')) this.dataset[toDatasetKey(name.slice(5))] = String(value);
    }

    scrollIntoView() {}
  }

  documentRef = {
    idMap: new Map(),
    renderCount: 0,
    activeElement: null,
    listeners: {},
    addEventListener(type, handler) {
      this.listeners[type] = this.listeners[type] || [];
      this.listeners[type].push(handler);
    },
    createElement(tagName) {
      return new TestElement(tagName);
    },
    getElementById(id) {
      return this.idMap.get(id) || null;
    },
    querySelectorAll(selector) {
      const nodes = [];
      if (matchesSelector(this.body, selector)) nodes.push(this.body);
      return nodes.concat(queryWithin(this.body.children, selector));
    },
    querySelector(selector) {
      return this.querySelectorAll(selector)[0] || null;
    },
  };

  documentRef.body = new TestElement('body');
  documentRef.body.ownerDocument = documentRef;
  const appElement = new TestElement('div', { id: 'app' });
  appElement.ownerDocument = documentRef;
  documentRef.body.appendChild(appElement);

  return {
    document: documentRef,
    appElement,
    window: { addEventListener() {} },
  };
}

function parseHtmlInto(root, html) {
  root.children = [];
  root.ownerDocument.idMap = new Map([['app', root]]);
  const stack = [root];
  const tagPattern = /<\/?([a-zA-Z0-9-]+)([^>]*)>/g;
  const voidTags = new Set(['input', 'img', 'br', 'hr', 'meta', 'link']);
  let match;
  while ((match = tagPattern.exec(html))) {
    const [raw, tagName, rawAttrs] = match;
    const tag = tagName.toLowerCase();
    if (raw.startsWith('</')) {
      while (stack.length > 1 && stack[stack.length - 1].tagName.toLowerCase() !== tag) stack.pop();
      if (stack.length > 1) stack.pop();
      continue;
    }
    const node = new root.constructor(tag, parseAttrs(rawAttrs));
    stack[stack.length - 1].appendChild(node);
    if (!voidTags.has(tag) && !raw.endsWith('/>')) stack.push(node);
  }
}

function parseAttrs(rawAttrs) {
  const attrs = {};
  const attrPattern = /([:\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  let match;
  while ((match = attrPattern.exec(rawAttrs))) {
    attrs[match[1]] = match[2] ?? match[3] ?? match[4] ?? '';
  }
  return attrs;
}

function datasetFromAttrs(attrs) {
  const dataset = {};
  Object.entries(attrs).forEach(([key, value]) => {
    if (key.startsWith('data-')) dataset[toDatasetKey(key.slice(5))] = value;
  });
  return dataset;
}

function toDatasetKey(value) {
  return value.replace(/-([a-z])/g, (_match, char) => char.toUpperCase());
}

function classNames(node) {
  return String(node.className || '').split(/\s+/).filter(Boolean);
}

function queryWithin(children, selector) {
  const results = [];
  const visit = (node) => {
    if (matchesSelector(node, selector)) results.push(node);
    node.children.forEach(visit);
  };
  children.forEach(visit);
  return results;
}

function matchesSelector(node, selector) {
  return String(selector || '').split(',').some((part) => matchesSimpleSelector(node, part.trim()));
}

function matchesSimpleSelector(node, selector) {
  if (!selector) return false;
  if (selector === '*') return true;
  const attrMatches = Array.from(selector.matchAll(/\[([\w-]+)(?:="([^"]*)")?\]/g));
  const withoutAttrs = selector.replace(/\[[^\]]+\]/g, '');
  const idMatch = withoutAttrs.match(/#([\w-]+)/);
  const classMatches = Array.from(withoutAttrs.matchAll(/\.([\w-]+)/g)).map((match) => match[1]);
  const tag = withoutAttrs.replace(/#[\w-]+/g, '').replace(/\.[\w-]+/g, '').trim();
  if (tag && node.tagName.toLowerCase() !== tag.toLowerCase()) return false;
  if (idMatch && node.id !== idMatch[1]) return false;
  if (classMatches.some((name) => !classNames(node).includes(name))) return false;
  return attrMatches.every((match) => {
    const attrName = match[1];
    const expected = match[2];
    const actual = attrName.startsWith('data-')
      ? node.dataset[toDatasetKey(attrName.slice(5))]
      : node.attributes[attrName];
    if (expected === undefined) return actual !== undefined;
    return String(actual) === expected;
  });
}

async function dispatchBubblingEvent(target, type) {
  const event = {
    type,
    target,
    currentTarget: target,
    defaultPrevented: false,
    stopped: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {
      this.stopped = true;
    },
  };
  let node = target;
  while (node) {
    event.currentTarget = node;
    for (const handler of node.listeners[type] || []) {
      await handler(event);
    }
    if (event.stopped) break;
    node = node.parentNode;
  }
  return event;
}

test('title editing and secret replacement render as stable click controls', () => {
  const { api } = loadSidepanel();
  api.appState.titleEditing = true;

  const titleHtml = api.renderTitleEditor({ title: '客户电话沟通' });
  assert.match(titleHtml, /id="title-editor"/);
  assert.doesNotMatch(titleHtml, /<form/i);
  assert.match(titleHtml, /data-action="save-title"/);
  assert.match(titleHtml, /data-action="cancel-title"/);
  assert.match(titleHtml, /type="button"/);

  api.appState.titleDraft = '用户正在输入的新标题';
  const draftHtml = api.renderTitleEditor({ title: '旧标题' });
  assert.match(draftHtml, /value="用户正在输入的新标题"/);
  assert.doesNotMatch(draftHtml, /value="旧标题"/);

  api.appState.titleDraft = '';
  const emptyDraftHtml = api.renderTitleEditor({ title: '旧标题' });
  assert.match(emptyDraftHtml, /value=""/);

  const field = {
    configured: true,
    key: 'dashscopeApiKey',
    label: 'DashScope API Key',
    maskedValue: 'sk-...ce65',
    secret: true,
  };
  const keepHtml = api.renderSettingField(field);
  assert.doesNotMatch(keepHtml, /<select/i);
  assert.match(keepHtml, /data-action="secret-action"/);
  assert.match(keepHtml, /data-value="replace"/);
  assert.match(keepHtml, /data-value="clear"/);
  assert.match(keepHtml, /type="button"/);
  assert.match(keepHtml.match(/<input[\s\S]*?>/)[0], /disabled/);

  api.appState.secretActions.dashscopeApiKey = 'replace';
  const replaceHtml = api.renderSettingField(field);
  assert.doesNotMatch(replaceHtml.match(/<input[\s\S]*?>/)[0], /disabled/);

  const choiceHtml = api.renderSettingField({
    key: 'devFakeAsr',
    label: '本地演示模式',
    type: 'select',
    value: '0',
    options: [
      { value: '0', label: '关闭，使用真实转写' },
      { value: '1', label: '开启，跳过真实转写' },
    ],
  });
  assert.doesNotMatch(choiceHtml, /<select/i);
  assert.match(choiceHtml, /data-action="setting-choice"/);
  assert.match(choiceHtml, /data-value="1"/);
  assert.match(choiceHtml, /type="hidden"/);
  assert.match(choiceHtml, /aria-pressed="true"[^>]*>关闭，使用真实转写/);

  api.appState.settingChoices.devFakeAsr = '1';
  const selectedChoiceHtml = api.renderSettingField({
    key: 'devFakeAsr',
    label: '本地演示模式',
    type: 'select',
    value: '0',
    options: [
      { value: '0', label: '关闭，使用真实转写' },
      { value: '1', label: '开启，跳过真实转写' },
    ],
  });
  assert.match(selectedChoiceHtml, /aria-pressed="true"[^>]*>开启，跳过真实转写/);
});

test('summary workbench renders audio, clickable transcript, mind map, and download entry points', () => {
  const { api } = loadSidepanel();
  api.appState.accessToken = 'token-123';
  api.appState.templates = [{ value: 'meeting_minutes', label: '会议纪要' }];
  api.appState.followupOptions = [{ value: 'none', label: '不生成跟单' }];

  const html = api.renderSummaryWorkspace({
    id: 'rec_1',
    title: '产品会议录音',
    status: 'completed',
    templateType: 'meeting_minutes',
    followupType: 'none',
    audioUrl: '/api/records/rec_1/audio',
    transcript: {
      corrected_text: '第一段\n第二段',
      speaker_aliases_json: { 'Speaker 1': '离心' },
      segments_json: [
        { id: 'seg_a', startMs: 12345, endMs: 16000, speaker: 'Speaker 1', text: '第一段重点' },
        { id: 'seg_b', startMs: 18000, endMs: 22000, speaker: '同事', text: '第二段行动项' },
      ],
    },
    summary: {
      summary_markdown: '# 总结\n- 重点',
      overview_card_json: {
        badge: '会议纪要',
        heroTitle: '产品会议录音',
        cards: [{
          title: '结论',
          items: ['继续优化监听'],
          tone: 'green',
          layout: 'wide',
          blocks: [
            {
              title: '关键字段',
              rows: [
                { label: '负责人', value: '离心', note: '逐字稿明确提到' },
                { label: '状态', value: '推进中' },
              ],
            },
            {
              title: '下一步',
              items: ['继续测试录音监听', '确认配置保存稳定'],
              note: '重要信息需回听核对。',
            },
          ],
        }],
      },
      mind_map_json: {
        title: '产品会议思维导图',
        center: '录音助手',
        branches: [{ title: '体验', children: [{ title: '录音对照', items: ['点击逐字稿跳转'] }] }],
      },
    },
  });

  assert.match(html, /data-api-base="http:\/\/127\.0\.0\.1:8137"/);
  assert.doesNotMatch(html, /class="workbench-pane-tabs"/);
  assert.doesNotMatch(html, /data-action="workbench-pane"/);
  assert.match(html, /recording-workbench-summary-pane/);
  assert.match(html, /recording-workbench-transcript-pane/);
  assert.match(html, /会议概览/);
  assert.match(html, /关键要点/);
  assert.match(html, /待办事项/);
  assert.match(html, /风险\/待确认事项/);
  assert.match(html, /<audio id="record-audio"/);
  assert.match(html, /data-action="transcribe-record"/);
  assert.match(html, /\/api\/records\/rec_1\/audio\?access_token=token-123/);
  assert.match(html, /data-action="seek-segment"/);
  assert.match(html, /role="button" tabindex="0" data-action="seek-segment"/);
  assert.match(html, /data-id="seg_a"/);
  assert.match(html, /data-start-ms="12345"/);
  assert.match(html, /data-action="edit-speaker"/);
  assert.match(html, /data-speaker="Speaker 1"/);
  assert.match(html, /离心/);
  assert.match(html, /下载逐字稿/);
  assert.match(html, /data-export-format="transcript"/);
  assert.match(html, /data-action="export-selected" data-target="transcript"/);
  assert.match(html, /下载总结/);
  assert.match(html, /data-export-format="summary"/);
  assert.match(html, /data-action="export-selected" data-target="summary"/);
  assert.match(html, /<option value="docx">DOCX<\/option>/);
  assert.match(html, /<option value="pdf">PDF<\/option>/);
  assert.doesNotMatch(html, /下载全部文件/);
  assert.doesNotMatch(html, /下载总结卡片/);
  assert.doesNotMatch(html, /下载思维导图/);
  assert.doesNotMatch(html, /data-target="overview_card"/);
  assert.doesNotMatch(html, /data-target="mind_map"/);
  assert.match(html, /knowledge-card-summary/);
  assert.match(html, /knowledge-blocks/);
  assert.match(html, /负责人/);
  assert.match(html, /推进中/);
  assert.match(html, /重要信息需回听核对。/);
  assert.doesNotMatch(html, /思维导图总结/);
  assert.doesNotMatch(html, /产品会议思维导图/);

  api.appState.speakerEditing = { speaker: 'Speaker 1', segmentId: 'seg_a', value: '离心' };
  const editingHtml = api.renderSummaryWorkspace({
    id: 'rec_1',
    title: '产品会议录音',
    status: 'completed',
    templateType: 'meeting_minutes',
    followupType: 'none',
    audioUrl: '/api/records/rec_1/audio',
    transcript: {
      corrected_text: '第一段\n第二段',
      speaker_aliases_json: { 'Speaker 1': '离心' },
      segments_json: [
        { id: 'seg_a', startMs: 12345, endMs: 16000, speaker: 'Speaker 1', text: '第一段重点' },
      ],
    },
    summary: { summary_markdown: '# 总结', overview_card_json: {}, mind_map_json: {} },
  });
  assert.match(editingHtml, /id="speaker-alias-input"/);
  assert.match(editingHtml, /data-action="save-speaker"/);
  assert.match(editingHtml, /应用到该说话人的所有片段/);

  const followupHtml = api.renderSummaryWorkspace({
    id: 'rec_2',
    title: '客户沟通录音',
    status: 'completed',
    templateType: 'recruitment_followup',
    followupType: 'recruitment',
    audioUrl: '/api/records/rec_2/audio',
    transcript: {
      corrected_text: '客户希望下周确认会员套餐',
      segments_json: [{ id: 'seg_a', startMs: 12345, endMs: 16000, speaker: '客户', text: '下周确认会员套餐' }],
    },
    summary: { summary_markdown: '# 跟单总结', overview_card_json: {}, mind_map_json: {} },
    followupForm: {
      business_type: 'recruitment',
      stage: 'mid_late_effective_followup',
      company_name: '测试企业',
      status_label: '推进中',
      suggested_tag: 'C 类，有需求',
      followup_markdown: '客户询问会员套餐，需要下周回访。',
      fields_json: {
        intent: '了解会员套餐',
        nextAction: '下周回访',
        owner: '离心',
        risk: '预算待确认',
      },
    },
  });
  assert.match(followupHtml, /跟单信息/);
  assert.match(followupHtml, /客户\/对象名称/);
  assert.match(followupHtml, /测试企业/);
  assert.match(followupHtml, /中后期有效跟进/);
  assert.match(followupHtml, /下周回访/);
  assert.doesNotMatch(followupHtml, /会议概览/);
});

test('follow-up copy text uses fixed business fields with empty missing values', () => {
  const { api } = loadSidepanel();
  const matchmakerText = api.formatFollowupCopy({
    templateType: 'matchmaker_profile',
    followupType: 'matchmaker',
    followupForm: {
      business_type: 'matchmaker',
      status_label: '已报价 3980',
      followup_markdown: '【第一印象】：沟通主动\n【性格挑战】：待核对',
      fields_json: {
        basicProfile: '32 岁，本地工作',
        assets: '有房',
        serviceSuggestion: '先核对资料',
      },
    },
  });
  assert.match(matchmakerText, /^【报价金额\/成交状态】：已报价 3980/m);
  assert.match(matchmakerText, /【个人基本情况】：32 岁，本地工作/);
  assert.match(matchmakerText, /【资产情况】：有房/);
  assert.match(matchmakerText, /【性格挑战】：\n/);
  assert.doesNotMatch(matchmakerText, /待核对/);

  const recruitmentText = api.formatFollowupCopy({
    templateType: 'recruitment_followup',
    followupType: 'recruitment',
    followupForm: {
      business_type: 'recruitment',
      stage: 'mid_late_effective_followup',
      company_name: '测试企业',
      suggested_tag: 'C 类，有需求',
      status_label: '推进中',
      followup_markdown: '',
      fields_json: {
        hiringRoles: '服务员',
        hiringCount: '',
        requirements: '有经验优先',
        nextAction: '下周回访',
      },
    },
  });
  assert.match(recruitmentText, /^【跟进阶段】：中后期有效跟进/m);
  assert.match(recruitmentText, /【企业\/客户名称】：测试企业/);
  assert.match(recruitmentText, /【招聘岗位】：服务员/);
  assert.match(recruitmentText, /【招聘人数】：\n/);
  assert.match(recruitmentText, /【建议标签】：C 类，有需求/);
});

test('fallback template summaries are visible but not treated as downloadable summaries', () => {
  const { api } = loadSidepanel();
  api.appState.accessToken = 'token-123';
  api.appState.templates = [{ value: 'meeting_minutes', label: '会议纪要' }];
  api.appState.followupOptions = [{ value: 'none', label: '不生成跟单' }];
  const record = {
    id: 'rec_fallback',
    title: '模型失败录音',
    status: 'transcribed',
    templateType: 'meeting_minutes',
    followupType: 'none',
    errorMessage: 'AI 总结模型暂不可用，已保留逐字稿，可重试生成总结。',
    transcript: { corrected_text: '逐字稿已生成' },
    summary: {
      summary_markdown: '# 临时模板\n- 待核对',
      quality_status: 'fallback_template',
      quality_reason: '真实总结模型全部失败，系统仅生成临时模板',
      overview_card_json: { heroTitle: '临时模板' },
      mind_map_json: { title: '临时模板', center: '待核对', branches: [] },
    },
  };
  const html = api.renderSummaryWorkspace(record);

  assert.equal(api.hasSummaryContent(record), false);
  assert.match(html, /AI 总结未成功/);
  assert.match(html, /下载逐字稿/);
  assert.match(html, /data-action="export-selected" data-target="summary" disabled/);
});

test('summarizing records hide stale fallback failure notice', () => {
  const { api } = loadSidepanel();
  const html = api.renderSummaryWorkspace({
    id: 'rec_summarizing',
    title: '重新生成中的录音',
    status: 'summarizing',
    templateType: 'meeting_minutes',
    followupType: 'none',
    transcript: { corrected_text: '逐字稿已生成' },
    summary: {
      summary_markdown: '# 临时模板\n- 待核对',
      quality_status: 'fallback_template',
      quality_reason: '真实总结模型全部失败，系统仅生成临时模板',
    },
  });

  assert.match(html, /正在重新生成总结/);
  assert.doesNotMatch(html, /AI 总结未成功/);
});

test('share panel opens immediately while share links are loading', async () => {
  const { api, appElement } = loadSidepanel({
    fetchImpl: async () => new Promise(() => {}),
  });
  api.appState.accessToken = 'token-123';
  api.appState.view = 'detail';
  api.appState.detail = {
    id: 'rec_share',
    title: '可分享录音',
    status: 'completed',
    createdAt: '2026-06-24T08:00:00.000Z',
    templateType: 'meeting_minutes',
    followupType: 'none',
    owner: { displayName: '离心' },
    department: { name: '运营部' },
    audioUrl: '/api/records/rec_share/audio',
    transcript: { corrected_text: '逐字稿' },
    summary: { summary_markdown: '总结正文', quality_status: 'ai_ok' },
  };

  api.openSharePanel();

  assert.match(appElement.innerHTML, /分享链接/);
  assert.match(appElement.innerHTML, /正在加载分享链接/);
});

test('admin history defaults to employee groups with collapsible record lists', () => {
  const { api } = loadSidepanel();
  api.appState.permissions = { canViewAllRecords: true };
  api.appState.records = [
    {
      id: 'rec-1',
      title: '岚岚录音',
      status: 'completed',
      createdAt: '2026-06-18T01:00:00.000Z',
      owner: { id: 'emp-lanlan', displayName: '岚岚' },
      department: { id: 'dep-rec', name: '招聘部' },
      templateType: 'meeting_minutes',
      followupType: 'none',
      titleSource: 'manual',
    },
    {
      id: 'rec-2',
      title: '泡泡录音',
      status: 'transcribed',
      createdAt: '2026-06-18T02:00:00.000Z',
      owner: { id: 'emp-paopao', displayName: '泡泡' },
      department: { id: 'dep-match', name: '红娘部门' },
      templateType: 'meeting_minutes',
      followupType: 'none',
      titleSource: 'manual',
    },
  ];

  const html = api.renderHistory();

  assert.match(html, /data-action="history-group" data-group="employee"/);
  assert.match(html, /泡泡/);
  assert.match(html, /待重试 1/);
  assert.match(html, /data-expanded="1"/);
  assert.match(html, /岚岚/);
  assert.match(html, /data-expanded="0"/);
});

test('detail page renders horizontal tabs and keeps panel state', () => {
  const { api } = loadSidepanel();
  api.appState.templates = [{ value: 'meeting_minutes', label: '会议纪要' }];
  api.appState.followupOptions = [{ value: 'none', label: '不生成跟单' }];
  api.appState.detail = {
    id: 'rec_1',
    title: '产品会议录音',
    status: 'completed',
    templateType: 'meeting_minutes',
    followupType: 'none',
    owner: { displayName: '离心' },
    department: { name: '运营部' },
    createdAt: '2026-06-17T08:00:00.000Z',
    transcript: { corrected_text: '第一段', segments_json: [] },
    audioUrl: '/api/records/rec_1/audio',
    summary: { summary_markdown: '# 总结', overview_card_json: {}, mind_map_json: { topic: '家具广告合作沟通', children: [] } },
    notes: [],
  };

  const html = api.renderDetail();
  assert.equal(api.appState.detailTab, 'summary');
  assert.match(html, /class="detail-tabs"/);
  assert.match(html, /data-detail-tab="summary"/);
  assert.match(html, /会议概览/);
  assert.match(html, /data-detail-tab="transcript"/);
  assert.match(html, /会议逐字稿/);
  assert.match(html, /data-detail-tab="mind_map"/);
  assert.match(html, /思维导图/);
  assert.match(html, /id="summary-section"/);
  assert.match(html, /data-action="open-share-panel"/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /<audio id="record-audio"/);

  api.appState.sharePanelOpen = true;
  api.appState.shareLinks = [{
    id: 'share_1',
    url: 'http://127.0.0.1:8137/s/share-token',
    includeAudio: true,
    includeTranscript: true,
    includeSummary: true,
    expiresAt: '2026-07-01T00:00:00.000Z',
    accessCount: 2,
  }];
  const shareHtml = api.renderDetail();
  assert.match(shareHtml, /class="share-popover-wrap"/);
  assert.match(shareHtml, /aria-expanded="true"/);
  assert.match(shareHtml, /分享链接/);
  assert.match(shareHtml, /name="includeAudio" type="checkbox" checked/);
  assert.match(shareHtml, /name="includeTranscript" type="checkbox" checked/);
  assert.match(shareHtml, /name="includeSummary" type="checkbox" checked/);
  assert.match(shareHtml, /data-action="create-share-link"/);
  assert.match(shareHtml, /http:\/\/127\.0\.0\.1:8137\/s\/share-token/);
  assert.match(shareHtml, /data-action="revoke-share-link"/);
  api.appState.detail.summary.quality_status = 'fallback_template';
  const fallbackShareHtml = api.renderDetail();
  assert.match(fallbackShareHtml, /name="includeSummary" type="checkbox" disabled/);
  api.appState.sharePanelOpen = false;
  api.appState.detail.summary.quality_status = '';

  api.appState.detailTab = 'transcript';
  api.appState.audioError = '浏览器无法播放该格式，可下载录音后播放。';
  const transcriptHtml = api.renderDetail();
  assert.equal(api.appState.detailTab, 'transcript');
  assert.match(transcriptHtml, /id="transcript-section"/);
  assert.match(transcriptHtml, /<audio id="record-audio"/);
  assert.match(transcriptHtml, /浏览器无法播放该格式/);
  api.appState.audioError = '';

  api.appState.detailTab = 'mind_map';
  const mindMapHtml = api.renderDetail();
  assert.match(mindMapHtml, /思维导图总结/);
  assert.match(mindMapHtml, /家具广告合作沟通/);

  api.appState.collapsedPanels['rec_1:mind_map'] = true;
  const collapsedHtml = api.renderDetail();
  assert.match(collapsedHtml, /data-panel="mind_map">展开/);
  assert.doesNotMatch(collapsedHtml, /mind-map-canvas/);
});

test('processing settings render meeting templates and follow-up type separately', () => {
  const { api } = loadSidepanel();
  api.appState.templates = [
    { value: 'meeting_minutes', label: '推理总结' },
    { value: 'meeting_secretary', label: '会议秘书' },
    { value: 'phone_discussion', label: '电话讨论' },
    { value: 'business_review', label: '业务复盘' },
  ];
  api.appState.followupOptions = [
    { value: 'none', label: '不生成跟单' },
    { value: 'recruitment', label: '招聘跟单' },
  ];

  const meetingHtml = api.renderProcessingPicker('upload', 'meeting_minutes', 'none');
  assert.match(meetingHtml, /data-action="processing-mode-choice"/);
  assert.match(meetingHtml, /data-mode="meeting"/);
  assert.match(meetingHtml, /data-mode="followup"/);
  assert.match(meetingHtml, /id="upload-template-select"/);
  assert.match(meetingHtml, /推理总结/);
  assert.match(meetingHtml, /会议秘书/);
  assert.match(meetingHtml, /电话讨论/);
  assert.match(meetingHtml, /name="templateType" type="hidden" value="meeting_minutes"/);
  assert.match(meetingHtml, /name="followupType" type="hidden" value="none"/);
  assert.doesNotMatch(meetingHtml, /业务复盘/);

  api.appState.processingChoices['upload-followup'] = 'recruitment';
  api.appState.processingChoices['upload-template'] = 'recruitment_followup';
  const followupHtml = api.renderProcessingPicker('upload', 'meeting_minutes', 'none');
  assert.match(followupHtml, /aria-pressed="true"[\s\S]*跟单信息/);
  assert.match(followupHtml, /id="upload-followup-select"/);
  assert.match(followupHtml, /<select/);
  assert.match(followupHtml, /招聘跟单/);
  assert.doesNotMatch(followupHtml, /电话讨论/);
  assert.match(followupHtml, /name="templateType" type="hidden" value="recruitment_followup"/);
  assert.match(followupHtml, /name="followupType" type="hidden" value="recruitment"/);
});

test('background audio candidates are surfaced without a manual refresh', () => {
  const { api } = loadSidepanel();
  const candidate = {
    url: 'https://web.plaud.cn/api/file?id=abc',
    name: '客户录音.mp3',
    type: 'mp3',
    source: 'network:xmlhttprequest',
    size: 1024,
    uploadable: true,
  };

  api.appState.view = 'home';
  api.handleBackgroundState({
    phase: 'confirm',
    statusText: '已找到当前页录音，可以开始识别。',
    candidates: [candidate],
  });
  assert.equal(api.appState.view, 'capture');
  assert.equal(api.appState.candidates[0].name, '客户录音.mp3');
  assert.equal(api.appState.statusType, 'success');

  api.appState.view = 'detail';
  api.handleBackgroundState({
    phase: 'confirm',
    statusText: '已找到当前页录音，可以开始识别。',
    candidates: [candidate],
  });
  assert.equal(api.appState.view, 'detail');
  assert.match(api.appState.status, /已找到当前页录音/);

  api.appState.view = 'home';
  const homeHtml = api.renderHome();
  assert.match(homeHtml, /capture-notice/);
  assert.match(homeHtml, /已找到当前页录音/);
  assert.match(homeHtml, /data-view="capture"/);
});

test('background capture updates do not steal user navigation from history', () => {
  const { api } = loadSidepanel();
  api.appState.view = 'history';
  api.appState.records = [];

  api.handleBackgroundState({
    phase: 'confirm',
    statusText: '已找到当前页录音，可以开始识别。',
    candidates: [{
      url: 'https://web.plaud.cn/api/file?id=abc',
      name: '客户录音.mp3',
      type: 'mp3',
      source: 'network:media',
      size: 30 * 1024 * 1024,
      uploadable: true,
    }],
  });

  assert.equal(api.appState.view, 'history');
  assert.equal(api.appState.candidates[0].name, '客户录音.mp3');
  assert.match(api.appState.backgroundCandidateNotice, /已找到当前页录音/);
});

test('scan page in extension context starts background scan without candidate state', async () => {
  const sentMessages = [];
  const { api } = loadSidepanel({
    chrome: {
      runtime: {
        id: 'extension-test',
        lastError: null,
        sendMessage(message, callback) {
          sentMessages.push(message);
          callback?.();
        },
      },
    },
  });

  api.appState.view = 'capture';
  await api.scanPage();
  assert.equal(sentMessages.length, 1);
  assert.equal(sentMessages[0].type, 'SCAN_PAGE');
  assert.equal(api.appState.scanActive, true);
  assert.equal(api.appState.status, '正在扫描当前网页...');
  assert.equal(api.appState.clientErrors.length, 0);
});

test('profile draft survives background state updates while editing', () => {
  const { api, appElement } = loadSidepanel();
  api.appState.view = 'profile';
  api.appState.currentUser = {
    id: 'emp-1',
    displayName: '离心',
    bio: '',
    aiProfileNote: '',
    avatarColor: '#2e7bbd',
    departments: [{ name: '运营部' }],
    globalRole: 'admin',
  };
  api.appState.profile = api.appState.currentUser;
  api.appState.profileDraft = {
    ...api.appState.currentUser,
    displayName: '正在输入中文 abc123',
    bio: '资料页草稿',
    aiProfileNote: '总结请先列待办',
    avatarColor: '#123456',
  };
  appElement.innerHTML = 'profile-still-editing';

  const beforeHtml = api.renderProfile();
  api.handleBackgroundState({
    phase: 'confirm',
    statusText: '已找到当前页录音',
    candidates: [{ url: 'https://example.com/record.mp3', name: 'record.mp3' }],
  });
  const afterHtml = api.renderProfile();

  assert.equal(appElement.innerHTML, 'profile-still-editing');
  assert.equal(api.appState.view, 'profile');
  assert.match(beforeHtml, /正在输入中文 abc123/);
  assert.match(afterHtml, /正在输入中文 abc123/);
  assert.match(afterHtml, /总结请先列待办/);
});

test('profile DOM clicks keep focus and do not bind body as navigation', async () => {
  const dom = createTestDom();
  const { api } = loadSidepanel({ dom });
  api.appState.view = 'profile';
  api.appState.currentUser = {
    id: 'emp-1',
    displayName: '离心',
    bio: '',
    aiProfileNote: '',
    avatarColor: '#2e7bbd',
    departments: [{ name: '运营部' }],
    globalRole: 'admin',
  };
  api.appState.profile = api.appState.currentUser;

  api.render();

  assert.equal(dom.document.body.dataset.view, undefined);
  assert.equal(dom.document.querySelectorAll('body[data-view]').length, 0);
  assert.equal(dom.document.querySelectorAll('[data-view]').some((node) => node.tagName === 'BODY'), false);

  const profileBio = dom.document.getElementById('profile-bio');
  const renderCountBeforeClick = dom.document.renderCount;
  await profileBio.click();

  assert.equal(dom.document.activeElement.id, 'profile-bio');
  assert.equal(dom.document.renderCount, renderCountBeforeClick);

  profileBio.value = '中文 abc123';
  await dispatchBubblingEvent(profileBio, 'input');
  assert.equal(api.appState.profileDraft.bio, '中文 abc123');
});

test('avatar upload keeps local file status and sends avatar request', async () => {
  const { api, fetchCalls } = loadSidepanel({
    responseFor: (url) => {
      if (String(url).endsWith('/api/me/avatar')) {
        return {
          employee: {
            id: 'emp-1',
            displayName: '离心',
            avatarUrl: '/avatars/emp-1.png',
            departments: [],
          },
        };
      }
      return { employee: { id: 'emp-1', displayName: '离心', departments: [] } };
    },
  });
  api.appState.accessToken = 'token-abc';
  api.appState.view = 'profile';
  const file = new Blob(['avatar'], { type: 'image/png' });
  Object.defineProperty(file, 'name', { value: 'avatar.png' });
  const form = { avatar: { files: [file] } };

  await api.uploadAvatar({
    preventDefault() {},
    currentTarget: { closest: () => form },
  });

  assert.equal(fetchCalls[0].url, 'http://127.0.0.1:8137/api/me/avatar');
  assert.equal(fetchCalls[0].requestOptions.method, 'POST');
  assert.equal(api.appState.profileUi.avatarFileName, 'avatar.png');
  assert.equal(api.appState.profileUi.avatarStatus, '头像已更新');
  assert.equal(api.appState.currentUser.avatarUrl, '/avatars/emp-1.png');
});

test('avatar file selection validates supported image formats locally', () => {
  const { api } = loadSidepanel();
  api.appState.profileUi = {
    avatarFileName: '',
    avatarFileSize: 0,
    avatarStatus: '',
    avatarStatusType: '',
  };
  const png = new Blob(['avatar'], { type: 'image/png' });
  Object.defineProperty(png, 'name', { value: 'avatar.png' });
  const script = new Blob(['nope'], { type: 'application/javascript' });
  Object.defineProperty(script, 'name', { value: 'avatar.js' });

  api.appState.profileUi.avatarFileName = png.name;
  api.appState.profileUi.avatarFileSize = png.size;
  const pngHtml = api.renderProfile();
  assert.match(pngHtml, /avatar\.png/);

  api.appState.profileUi.avatarFileName = script.name;
  api.appState.profileUi.avatarFileSize = script.size;
  api.appState.profileUi.avatarStatus = '头像格式不支持，请选择 PNG、JPG 或 WebP 图片。';
  api.appState.profileUi.avatarStatusType = 'error';
  const invalidHtml = api.renderProfile();
  assert.match(invalidHtml, /头像格式不支持/);
});

test('candidate upload shows card status immediately and recovers with manual fallback', async () => {
  let rejectCandidateFetch;
  const { api, appElement, timeoutDelays } = loadSidepanel({
    fetchImpl: (url, requestOptions, fetchCalls) => {
      fetchCalls.push({ url, requestOptions });
      if (String(url).endsWith('/api/records/check-duplicate')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ duplicate: false }),
        });
      }
      return new Promise((_resolve, reject) => {
        rejectCandidateFetch = reject;
      });
    },
  });
  api.appState.view = 'capture';
  api.appState.currentUser = { displayName: '离心', departments: [] };
  api.appState.templates = [{ value: 'meeting_minutes', label: '会议纪要' }];
  api.appState.followupOptions = [{ value: 'none', label: '不生成跟单' }];
  api.appState.candidates = [{
    url: 'https://web.plaud.cn/api/file?id=abc',
    name: '客户录音.mp3',
    type: 'mp3',
    source: 'network:xmlhttprequest',
    size: 1024,
    uploadable: true,
  }];
  api.render();

  const uploadPromise = api.uploadCandidate(0);
  assert.match(appElement.innerHTML, /正在读取网页录音/);
  assert.equal(api.appState.candidateJobs[0].phase, 'reading');
  assert.ok(timeoutDelays.includes(2 * 60 * 1000));

  rejectCandidateFetch(new Error('Failed to fetch'));
  await uploadPromise;

  assert.equal(api.appState.candidateJobs[0].phase, 'read_failed');
  assert.match(appElement.innerHTML, /读取失败/);
  assert.match(appElement.innerHTML, /手动上传/);
  assert.match(appElement.innerHTML, /data-view="home"/);
});

test('candidate upload can retry the same created record after upload failure', async () => {
  let uploadAttempts = 0;
  const { api, appElement } = loadSidepanel({
    fetchImpl: async (url, requestOptions, fetchCalls) => {
      fetchCalls.push({ url, requestOptions });
      if (url === 'https://web.plaud.cn/api/file?id=retry') {
        return {
          ok: true,
          status: 200,
          blob: async () => {
            const blob = new Blob(['audio'], { type: 'audio/mpeg' });
            return blob;
          },
        };
      }
      if (String(url).endsWith('/api/records') && requestOptions.method === 'POST') {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            record: {
              id: 'rec_retry',
              title: '重试录音',
              status: 'created',
              templateType: 'meeting_minutes',
              followupType: 'none',
            },
          }),
        };
      }
      if (String(url).endsWith('/api/records/rec_retry/upload')) {
        uploadAttempts += 1;
        if (uploadAttempts === 1) {
          return {
            ok: false,
            status: 500,
            text: async () => JSON.stringify({ error: '上传失败' }),
          };
        }
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            record: {
              id: 'rec_retry',
              title: '重试录音',
              status: 'completed',
              templateType: 'meeting_minutes',
              followupType: 'none',
            },
          }),
        };
      }
      if (String(url).endsWith('/api/records/rec_retry')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            record: {
              id: 'rec_retry',
              title: '重试录音',
              status: 'completed',
              templateType: 'meeting_minutes',
              followupType: 'none',
              summary: {},
            },
          }),
        };
      }
      if (String(url).endsWith('/api/records')) {
        return {
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ records: [] }),
        };
      }
      throw new Error(`Unexpected fetch ${url}`);
    },
  });
  api.appState.accessToken = 'token-abc';
  api.appState.view = 'capture';
  api.appState.currentUser = { displayName: '离心', departments: [] };
  api.appState.templates = [{ value: 'meeting_minutes', label: '会议纪要' }];
  api.appState.followupOptions = [{ value: 'none', label: '不生成跟单' }];
  api.appState.candidates = [{
    url: 'https://web.plaud.cn/api/file?id=retry',
    name: 'retry.mp3',
    type: 'mp3',
    source: 'network:xmlhttprequest',
    uploadable: true,
  }];

  await api.uploadCandidate(0);
  assert.equal(api.appState.candidateJobs[0].phase, 'failed');
  assert.equal(api.appState.candidateJobs[0].recordId, 'rec_retry');
  assert.ok(api.appState.candidateJobs[0].blob);
  assert.match(appElement.innerHTML, /重试上传/);

  await api.retryCandidateUpload(0);
  assert.equal(uploadAttempts, 2);
  assert.equal(api.appState.view, 'detail');
  assert.equal(api.appState.detail.id, 'rec_retry');
  assert.match(appElement.innerHTML, /录音已上传|重试录音/);
});

test('client error boundary renders diagnostics and keeps current view visible', () => {
  const { api, appElement } = loadSidepanel();
  api.appState.view = 'home';
  api.appState.currentUser = { displayName: '离心', departments: [] };
  api.appState.records = [];

  api.reportClientError(new Error('button exploded'), { action: 'test.throw' });

  assert.equal(api.appState.clientErrors.length, 1);
  assert.match(appElement.innerHTML, /插件前端异常/);
  assert.match(appElement.innerHTML, /button exploded/);
  assert.match(appElement.innerHTML, /上传录音文件，开始转写|暂无转写结果/);
});

test('continuous DOM flow keeps navigation usable after capture failure fallback', async () => {
  let rejectCandidateFetch;
  const dom = createTestDom();
  const { api } = loadSidepanel({
    dom,
    fetchImpl: (url, requestOptions, fetchCalls) => {
      fetchCalls.push({ url, requestOptions });
      if (String(url).endsWith('/api/me/profile')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({
            employee: {
              id: 'emp-1',
              displayName: '离心',
              bio: '中文 abc123',
              aiProfileNote: '',
              avatarColor: '#2e7bbd',
              departments: [{ name: '运营部' }],
              globalRole: 'admin',
            },
          }),
        });
      }
      if (String(url).endsWith('/api/records/check-duplicate')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: async () => JSON.stringify({ duplicate: false }),
        });
      }
      return new Promise((_resolve, reject) => {
        rejectCandidateFetch = reject;
      });
    },
  });
  api.appState.accessToken = 'token-abc';
  api.appState.view = 'profile';
  api.appState.currentUser = {
    id: 'emp-1',
    displayName: '离心',
    bio: '',
    aiProfileNote: '',
    avatarColor: '#2e7bbd',
    departments: [{ name: '运营部' }],
    globalRole: 'admin',
  };
  api.appState.profile = api.appState.currentUser;
  api.appState.templates = [{ value: 'meeting_minutes', label: '会议纪要' }];
  api.appState.followupOptions = [{ value: 'none', label: '不生成跟单' }];
  api.render();

  const bio = dom.document.getElementById('profile-bio');
  await bio.click();
  bio.value = '中文 abc123';
  await dispatchBubblingEvent(bio, 'input');
  assert.equal(api.appState.profileDraft.bio, '中文 abc123');

  const avatarFile = dom.document.getElementById('avatar-file');
  const avatar = new Blob(['avatar'], { type: 'image/png' });
  Object.defineProperty(avatar, 'name', { value: 'avatar.png' });
  avatarFile.files = [avatar];
  await dispatchBubblingEvent(avatarFile, 'change');
  assert.match(api.appState.profileUi.avatarStatus, /可上传/);

  await dom.document.querySelector('button[data-view="upload"]').click();
  assert.equal(api.appState.view, 'upload');
  assert.ok(dom.document.getElementById('upload-title'));

  await dom.document.querySelector('button[data-view="profile"]').click();
  assert.equal(api.appState.view, 'profile');
  const oldPassword = dom.document.getElementById('old-password');
  const newPassword = dom.document.getElementById('new-password');
  await oldPassword.click();
  oldPassword.value = 'old-pass';
  await dispatchBubblingEvent(oldPassword, 'input');
  await newPassword.click();
  newPassword.value = 'new-pass';
  await dispatchBubblingEvent(newPassword, 'input');
  assert.equal(api.appState.passwordDraft.oldPassword, 'old-pass');
  assert.equal(api.appState.passwordDraft.newPassword, 'new-pass');

  api.appState.candidates = [{
    url: 'https://web.plaud.cn/api/file?id=flow',
    name: 'flow.mp3',
    type: 'mp3',
    source: 'network:xmlhttprequest',
    uploadable: true,
  }];
  api.appState.view = 'capture';
  api.render();
  const uploadPromise = api.uploadCandidate(0);
  for (let index = 0; index < 20 && !rejectCandidateFetch; index += 1) await Promise.resolve();
  assert.equal(typeof rejectCandidateFetch, 'function');
  rejectCandidateFetch(new Error('Failed to fetch'));
  await uploadPromise;
  assert.match(dom.appElement.innerHTML, /手动上传/);

  await dom.document.querySelector('button[data-action="manual-upload-from-candidate"]').click();
  assert.equal(api.appState.view, 'upload');
  assert.match(dom.appElement.innerHTML, /网页读取失败/);
  assert.ok(dom.document.querySelector('button[data-view="home"]'));
});

test('summarize record starts background task with task-start timeout', async () => {
  const { api, fetchCalls, timeoutDelays } = loadSidepanel({
    responseFor: (_url, _requestOptions, body) => ({
      record: {
        id: 'rec_1',
        title: '录音总结',
        status: 'summarizing',
        templateType: body.templateType,
        followupType: body.followupType,
        transcript: { corrected_text: '逐字稿' },
        summary: { summary_markdown: '# 旧总结' },
      },
    }),
  });
  api.appState.accessToken = 'token-abc';
  api.appState.currentUser = { displayName: '离心', departments: [] };
  api.appState.view = 'history';
  api.appState.detail = {
    id: 'rec_1',
    title: '录音总结',
    status: 'completed',
    templateType: 'meeting_minutes',
    followupType: 'none',
    transcript: { corrected_text: '逐字稿' },
    summary: { summary_markdown: '# 旧总结' },
  };

  await api.summarizeRecord();

  assert.equal(fetchCalls[0].url, 'http://127.0.0.1:8137/api/records/rec_1/summarize');
  assert.equal(fetchCalls[0].requestOptions.method, 'POST');
  assert.deepEqual(JSON.parse(fetchCalls[0].requestOptions.body), {
    templateType: 'meeting_minutes',
    followupType: 'none',
    force: true,
  });
  assert.ok(timeoutDelays.includes(60000));
  assert.equal(api.appState.detail.status, 'summarizing');
  assert.equal(api.appState.status, '已开始生成总结，完成后会自动刷新。');
});

test('capture page shows one current recording and folds other candidates', () => {
  const { api } = loadSidepanel();
  api.appState.templates = [{ value: 'meeting_minutes', label: '会议纪要' }];
  api.appState.followupOptions = [{ value: 'none', label: '不生成跟单' }];
  api.appState.candidates = [
    {
      url: 'https://web.plaud.cn/api/file?id=current',
      name: 'download',
      type: 'mp3',
      source: 'network:xmlhttprequest',
      size: 3.9 * 1024 * 1024,
      uploadable: true,
      recordingTitle: '2026-06-12 11:14:48',
      current: true,
      durationSeconds: 1009,
    },
    {
      url: 'https://web.plaud.cn/api/file?id=old',
      name: 'old.mp3',
      type: 'mp3',
      source: 'network:xmlhttprequest',
      size: 2 * 1024 * 1024,
      uploadable: true,
    },
  ];

  const html = api.renderCapture();
  assert.match(html, /识别当前页录音/);
  assert.match(html, /2026-06-12 11:14:48/);
  assert.match(html, /当前录音/);
  assert.match(html, /data-action="upload-candidate" data-index="0"/);
  assert.match(html, /还有 1 个其它候选，通常不用管/);
  assert.doesNotMatch(html, /https:\/\/web\.plaud\.cn\/api\/file/);
});

test('capture candidate renders duplicate record actions', () => {
  const { api } = loadSidepanel();
  api.appState.templates = [{ value: 'meeting_minutes', label: '推理总结' }];
  api.appState.followupOptions = [{ value: 'none', label: '不生成跟单' }];
  api.appState.candidates = [{
    url: 'https://web.plaud.cn/api/file?id=current',
    name: '客户录音.mp3',
    type: 'mp3',
    source: 'network:xmlhttprequest',
    size: 3 * 1024 * 1024,
    uploadable: true,
    duplicate: {
      checked: true,
      duplicate: true,
      record: {
        id: 'rec_existing',
        title: '客户电话沟通',
        status: 'completed',
      },
    },
  }];

  const html = api.renderCapture();
  assert.match(html, /已识别过/);
  assert.match(html, /打开已有记录/);
  assert.match(html, /仍要重新识别/);
  assert.doesNotMatch(html, /data-action="upload-candidate" data-index="0"/);
});

test('candidate upload failures explain the manual upload fallback', () => {
  const { api } = loadSidepanel();
  api.appState.templates = [{ value: 'meeting_minutes', label: '会议纪要' }];
  api.appState.followupOptions = [{ value: 'none', label: '不生成跟单' }];
  api.appState.candidates = [{
    url: 'https://web.plaud.cn/api/file?id=abc',
    name: '客户录音.mp3',
    type: 'mp3',
    source: 'network:xmlhttprequest',
    size: 1024,
    uploadable: true,
  }];

  const html = api.renderCapture();
  assert.match(html, /候选页不直接播放录音/);
  assert.match(html, /详情页播放/);

  const forbidden = api.candidateReadFailureMessage(new Error('HTTP 403'));
  assert.match(forbidden, /网页登录态或权限/);
  assert.match(forbidden, /手动上传/);

  const expired = api.candidateReadFailureMessage(new Error('HTTP 404'));
  assert.match(expired, /地址已过期/);
  assert.match(expired, /下载录音文件/);
});

test('candidate reader requests the complete range for partial media recordings', async () => {
  const completeSize = 1024 * 1024;
  const { api, fetchCalls } = loadSidepanel({
    fetchImpl: async (url, requestOptions, calls) => {
      calls.push({ url, requestOptions });
      return {
        ok: true,
        status: 206,
        blob: async () => new Blob(['x'.repeat(completeSize)], { type: 'audio/mpeg' }),
      };
    },
  });

  const blob = await api.fetchCandidateBlob({
    url: 'https://web.plaud.cn/api/file?id=abc',
    rangeSize: completeSize,
  }, new AbortController().signal);

  assert.equal(blob.size, completeSize);
  assert.equal(fetchCalls[0].requestOptions.headers.Range, `bytes=0-${completeSize - 1}`);
  assert.doesNotThrow(() => api.validateCandidateBlobComplete({ rangeSize: completeSize }, blob));
});

test('candidate reader rejects tiny partial blobs when a full recording size is known', () => {
  const { api } = loadSidepanel();
  assert.throws(
    () => api.validateCandidateBlobComplete(
      { rangeSize: 70 * 1024 * 1024 },
      new Blob(['x'.repeat(2 * 1024)], { type: 'application/octet-stream' }),
    ),
    /只读取到 2 KB，完整录音约 70\.0 MB/,
  );
});

test('employee create form uses stable department and role buttons', () => {
  const { api } = loadSidepanel();
  api.appState.departments = [
    { id: 'dept-operations', name: '运营部' },
    { id: 'dept-recruitment', name: '招聘部' },
  ];
  api.appState.employees = [];

  const html = api.renderEmployees();
  assert.doesNotMatch(html, /<select/i);
  assert.match(html, /data-choice-id="employee-department"/);
  assert.match(html, /name="departmentId" type="hidden" value=""/);
  assert.match(html, /data-value="dept-recruitment"/);
  assert.match(html, /data-choice-id="employee-role"/);
  assert.match(html, /name="globalRole" type="hidden" value="employee"/);
  assert.match(html, /data-value="department_lead"/);

  api.appState.processingChoices['employee-department'] = 'dept-recruitment';
  api.appState.processingChoices['employee-role'] = 'department_lead';
  const selectedHtml = api.renderEmployees();
  assert.match(selectedHtml, /name="departmentId" type="hidden" value="dept-recruitment"/);
  assert.match(selectedHtml, /name="globalRole" type="hidden" value="department_lead"/);
  assert.match(selectedHtml, /aria-pressed="true"[^>]*>招聘部/);
  assert.match(selectedHtml, /aria-pressed="true"[^>]*>部门领导/);
});

test('long transcript renders in batches to keep the workbench responsive', () => {
  const { api } = loadSidepanel();
  api.appState.accessToken = 'token-123';
  const segments = Array.from({ length: 125 }, (_, index) => ({
    id: `seg_${index + 1}`,
    startMs: index * 1000,
    endMs: index * 1000 + 900,
    speaker: 'Speaker 1',
    text: `第 ${index + 1} 段逐字稿`,
  }));

  const html = api.renderSummaryWorkspace({
    id: 'rec_long',
    title: '长录音',
    status: 'completed',
    templateType: 'meeting_minutes',
    followupType: 'none',
    audioUrl: '/api/records/rec_long/audio',
    transcript: {
      corrected_text: '长录音逐字稿',
      segments_json: segments,
    },
    summary: {
      summary_markdown: '# 总结',
      overview_card_json: {},
      mind_map_json: {},
    },
  });

  assert.equal((html.match(/class="transcript-segment/g) || []).length, 80);
  assert.match(html, /显示更多 45 段/);
  assert.match(html, /剩余 45 段/);
  assert.match(html, /第 80 段逐字稿/);
  assert.doesNotMatch(html, /第 81 段逐字稿/);
});

test('record progress renders status, file entries, timeline, and diagnostics', () => {
  const { api } = loadSidepanel();
  const html = api.renderRecordProgress({
    status: 'summarizing',
    originalFileName: 'meeting.mp3',
    fileSize: 1024,
    lastProgressAt: new Date().toISOString(),
    processingEvents: [
      { phase: 'uploaded', message: '录音已上传，后台准备处理。', createdAt: '2026-06-17T08:00:00.000Z' },
      { phase: 'summarizing', message: '逐字稿已生成，正在生成总结。', createdAt: '2026-06-17T08:01:00.000Z' },
    ],
  });

  assert.match(html, /总结中/);
  assert.match(html, /正在生成结果，请稍等。/);
  assert.match(html, /class="file-entry-row"/);
  assert.match(html, /录音<small>未就绪/);
  assert.match(html, /逐字稿<small>未就绪/);
  assert.match(html, /总结<small>未就绪/);
  assert.match(html, /最近处理进度/);
  assert.match(html, /录音已上传，后台准备处理。/);
  assert.match(html, /逐字稿已生成，正在生成总结。/);
  assert.match(html, /data-action="copy-processing-diagnostics"/);
  assert.doesNotMatch(html, /metadata_json/);
});

test('editable forms render save controls as explicit action buttons', () => {
  const { api } = loadSidepanel();
  api.appState.departments = [{ id: 'dept-1', name: '运营部' }];
  api.appState.employees = [];
  api.appState.profile = {
    displayName: '离心',
    avatarColor: '#1b9a8a',
    departments: [{ name: '运营部' }],
    globalRole: 'admin',
  };

  const uploadHtml = api.renderUpload();
  api.appState.detailTab = 'followup';
  const followupHtml = api.renderDetailTab({
    templateType: 'recruitment_followup',
    followupType: 'recruitment',
    followupForm: { followup_markdown: '跟进内容' },
  });
  api.appState.detailTab = 'notes';
  const noteHtml = api.renderDetailTab({ notes: [] });
  const profileHtml = api.renderProfile();
  const employeesHtml = api.renderEmployees();
  const html = [uploadHtml, followupHtml, noteHtml, profileHtml, employeesHtml].join('\n');

  for (const action of [
    'upload-manual',
    'save-followup',
    'save-note',
    'upload-avatar',
    'save-profile',
    'change-password',
    'create-employee',
  ]) {
    const pattern = new RegExp(`<button[^>]*type="button"[^>]*data-action="${action}"|<button[^>]*data-action="${action}"[^>]*type="button"`);
    assert.match(html, pattern);
  }

  assert.doesNotMatch(html, /<button[^>]*type="submit"[^>]*>(上传并开始识别|保存跟单修改|保存备注|上传头像|保存个人资料|保存密码|新增员工)/);
  assert.doesNotMatch(followupHtml, /<select/i);
  assert.match(followupHtml, /data-action="processing-choice"/);
  assert.match(followupHtml, /name="stage" type="hidden"/);
  assert.match(followupHtml, /未判断\/不适用/);
});

test('hosted export downloads use the current backend origin with scoped download tokens', async () => {
  const { api, clickedLinks, fetchCalls } = loadSidepanel({
    origin: 'http://127.0.0.1:8137',
    exportResponse: (body) => ({
      downloadUrl: `http://localhost:0/api/export-files/export-${body.target}-${body.format}`,
      downloadToken: `download-${body.target}-${body.format}`,
      export: { format: body.format },
    }),
  });
  api.appState.accessToken = 'token-abc';
  api.appState.apiBaseUrl = 'http://lixindemac-studio.local:8127';
  api.appState.currentUser = { displayName: '离心', departments: [] };
  api.appState.detail = { id: 'rec_1', title: '录音总结', status: 'completed' };
  api.appState.view = 'detail';

  assert.equal(api.activeApiBaseUrl(), 'http://127.0.0.1:8137');
  assert.equal(
    api.authedDownloadUrl('http://localhost:0/api/export-files/export-summary-md', 'download-abc'),
    'http://127.0.0.1:8137/api/export-files/export-summary-md?download_token=download-abc',
  );

  await api.exportRecord('summary', 'md');

  assert.equal(fetchCalls[0].url, 'http://127.0.0.1:8137/api/records/rec_1/export');
  assert.equal(fetchCalls[0].requestOptions.method, 'POST');
  assert.equal(fetchCalls[0].requestOptions.headers.Authorization, 'Bearer token-abc');
  assert.deepEqual(JSON.parse(fetchCalls[0].requestOptions.body), { target: 'summary', format: 'md' });
  assert.equal(clickedLinks[0].href.includes('access_token='), false);
  assert.deepEqual(clickedLinks, [{
    href: 'http://127.0.0.1:8137/api/export-files/export-summary-md?download_token=download-summary-md',
    download: '录音总结-summary.md',
  }]);
  assert.equal(api.appState.exportNotice, '总结 Markdown 已生成');

  await api.exportRecord('all_files', 'zip');

  assert.equal(fetchCalls[1].url, 'http://127.0.0.1:8137/api/records/rec_1/export');
  assert.deepEqual(JSON.parse(fetchCalls[1].requestOptions.body), { target: 'all_files', format: 'zip' });
  assert.equal(clickedLinks[1].href.includes('access_token='), false);
  assert.deepEqual(clickedLinks[1], {
    href: 'http://127.0.0.1:8137/api/export-files/export-all_files-zip?download_token=download-all_files-zip',
    download: '录音总结-all_files.zip',
  });
  assert.equal(api.appState.exportNotice, '全部文件 ZIP 已生成');
});

test('settings page renders recent settings audit records without secret metadata', () => {
  const { api } = loadSidepanel();
  api.appState.settingGroups = [{
    id: 'service',
    title: '服务开关',
    description: '测试',
    fields: [{
      key: 'publicBaseUrl',
      label: '后端公开地址',
      type: 'text',
      value: 'http://127.0.0.1:8137',
    }],
  }];
  api.appState.systemStatus = {
    r2Configured: false,
    dashscopeConfigured: false,
    llmConfigured: false,
    devFakeAsr: true,
  };
  api.appState.settingsMeta = {
    settingsVersion: 4,
    settingsUpdatedAt: '2026-06-17T03:00:00.000Z',
    settingsUpdatedBy: '离心',
  };
  api.appState.llmProviderPresets = [{
    id: 'llm_sub2api_gpt55',
    displayName: 'AI 大宜宾 sub2api - GPT-5.5',
  }];
  api.appState.llmProviders = [{
    id: 'llm_sub2api_gpt55',
    displayName: 'AI 大宜宾 sub2api - GPT-5.5',
    providerKey: 'sub2api',
    channelId: 'sub2api',
    protocol: 'openai-responses',
    baseUrl: 'http://127.0.0.1:8080/v1',
    endpointPath: '/responses',
    requestModel: 'gpt-5.5',
    priority: 20,
    enabled: true,
    allowFallback: true,
    configured: true,
    maskedApiKey: 'sk-...abcd',
    lastTestStatus: 'passed',
    lastTestAt: '2026-06-17T03:00:00.000Z',
    lastCallStatus: 'success',
    lastCallAt: '2026-06-17T03:01:00.000Z',
  }];
  api.appState.llmProviderDraft = {
    protocol: 'openai-responses',
    baseUrl: 'http://127.0.0.1:8080/v1',
    requestModel: 'gpt-5.5',
    reasoningEffort: 'high',
    configured: false,
  };
  api.appState.auditLogs = [
    {
      id: 'audit_1',
      createdAt: '2026-06-17T03:00:00.000Z',
      actorName: '离心',
      action: 'update_system_settings',
      targetType: 'system_settings',
      targetId: 'global',
    },
    {
      id: 'audit_2',
      createdAt: '2026-06-17T03:01:00.000Z',
      actorName: '离心',
      action: 'test_system_settings',
      targetType: 'system_settings',
      targetId: 'publicBaseUrl',
    },
    {
      id: 'audit_3',
      createdAt: '2026-06-17T03:02:00.000Z',
      actorName: '离心',
      action: 'test_llm_provider',
      targetType: 'llm_provider',
      targetId: 'llm_sub2api_gpt55',
    },
    {
      id: 'audit_4',
      createdAt: '2026-06-17T03:02:00.000Z',
      actorName: '离心',
      action: 'update_employee',
      targetType: 'employee',
      targetId: 'emp-1',
    },
  ];

  const html = api.renderSettings();
  assert.match(html, /配置修改记录/);
  assert.match(html, /data-setting-group="service"/);
  assert.match(html, /data-action="save-settings-group"/);
  assert.match(html, /保存本组/);
  assert.match(html, /保存全部设置/);
  assert.match(html, /总结模型池/);
  assert.match(html, /AI 大宜宾 sub2api - GPT-5\.5/);
  assert.match(html, /openai-responses/);
  assert.match(html, /Base URL/);
  assert.match(html, /模型名称/);
  assert.match(html, /Reasoning Effort/);
  assert.doesNotMatch(html, /Provider 标识/);
  assert.doesNotMatch(html, /通道标识/);
  assert.doesNotMatch(html, /Endpoint Path/);
  assert.doesNotMatch(html, /超时毫秒/);
  assert.match(html, /sk-\.\.\.abcd/);
  assert.doesNotMatch(html, /sub2api-secret-key/);
  assert.match(html, /保存设置/);
  assert.match(html, /测试设置/);
  assert.match(html, /测试模型/);
  assert.doesNotMatch(html, /update_employee/);
  const auditSection = html.match(/<section class="settings-audit">[\s\S]*?<\/section>/)?.[0] || '';
  assert.doesNotMatch(auditSection, /secret|apiKey|metadata/i);
});
