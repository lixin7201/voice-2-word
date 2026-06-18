const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createVoiceServer } = require('./app');
const { createInitialData } = require('./lib/seed');
const { mediaUrlFingerprint, rawMediaUrlFingerprint } = require('./lib/media-fingerprint');

function startTestServer(options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-2-word-'));
  const dataFile = path.join(dir, 'db.json');
  if (options.initialData) fs.writeFileSync(dataFile, JSON.stringify(options.initialData, null, 2));
  const server = createVoiceServer({
    dataFile,
    uploadDir: path.join(dir, 'uploads'),
    exportDir: path.join(dir, 'exports'),
    jwtSecret: 'test-secret',
    publicBaseUrl: 'http://localhost:0',
    devFakeAsr: options.devFakeAsr ?? true,
    recoverProcessing: options.recoverProcessing,
    easyAiBaseUrl: options.easyAiBaseUrl,
    easyAiApiKey: options.easyAiApiKey,
    easyAiModel: options.easyAiModel,
    dashscopeApiKey: options.dashscopeApiKey,
    r2AccountId: options.r2AccountId,
    r2AccessKeyId: options.r2AccessKeyId,
    r2SecretAccessKey: options.r2SecretAccessKey,
    r2Bucket: options.r2Bucket,
    r2Endpoint: options.r2Endpoint,
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        dir,
        server,
        baseUrl: `http://127.0.0.1:${port}`,
      });
    });
  });
}

function startDelayedLlmServer() {
  let releaseResponse;
  let rejectResponse;
  let requestCount = 0;
  const releasePromise = new Promise((resolve, reject) => {
    releaseResponse = resolve;
    rejectResponse = reject;
  });
  const server = require('node:http').createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/chat/completions') {
      res.writeHead(404).end();
      return;
    }
    requestCount += 1;
    try {
      await releasePromise;
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        choices: [{
          message: {
            content: JSON.stringify({
              summaryMarkdown: '# 后台总结完成\n\n## 会议概览\n\n- 接口已先返回，再后台写入总结。',
              overviewCard: {
                heroTitle: '后台任务总结',
                heroSubtitle: '接口立即返回',
                cards: [{ title: '结果', items: ['后台完成'] }],
              },
              mindMap: {
                title: '后台任务思维导图',
                center: '总结',
                branches: [{ title: '完成', summary: '后台完成', children: [] }],
              },
              structuredJson: { async: true },
              titleSuggestion: '后台任务总结',
            }),
          },
        }],
      }));
    } catch {
      res.writeHead(500).end();
    }
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}`,
        release: releaseResponse,
        reject: rejectResponse,
        getRequestCount: () => requestCount,
      });
    });
  });
}

function startLlmProviderServer() {
  const requests = [];
  const server = require('node:http').createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString('utf8');
    requests.push({
      method: req.method,
      url: req.url,
      authorization: req.headers.authorization || '',
      body: body ? JSON.parse(body) : {},
    });
    if (req.method !== 'POST' || !['/v1/responses', '/v1/chat/completions'].includes(req.url)) {
      res.writeHead(404).end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    if (req.url === '/v1/responses') {
      res.end(JSON.stringify({
        output_text: JSON.stringify({
          summaryMarkdown: '# sub2api 总结\n\n模型池命中 sub2api。',
          overviewCard: { heroTitle: '模型池命中', cards: [] },
          mindMap: { title: '模型池', center: 'sub2api', branches: [] },
          structuredJson: { provider: 'sub2api' },
          titleSuggestion: '模型池命中',
        }),
      }));
      return;
    }
    res.end(JSON.stringify({
      choices: [{
        message: {
          content: JSON.stringify({
            summaryMarkdown: '# Kimi 总结',
            overviewCard: { heroTitle: 'Kimi', cards: [] },
            mindMap: { title: 'Kimi', center: 'Kimi', branches: [] },
            structuredJson: { provider: 'kimi' },
            titleSuggestion: 'Kimi 总结',
          }),
        },
      }],
    }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        requests,
      });
    });
  });
}

function startR2UploadServer() {
  const requests = [];
  const server = require('node:http').createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({
      method: req.method,
      url: req.url,
      bodyLength: Buffer.concat(chunks).length,
    });
    res.writeHead(200).end();
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      resolve({
        server,
        endpoint: `http://127.0.0.1:${port}`,
        requests,
      });
    });
  });
}

async function request(baseUrl, pathName, options = {}) {
  const response = await fetch(`${baseUrl}${pathName}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  return { response, body };
}

async function login(baseUrl, loginName) {
  const { response, body } = await request(baseUrl, '/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ loginName, password: 'dayibin' }),
  });
  assert.equal(response.status, 200);
  return body;
}

async function waitFor(condition, timeoutMs = 1000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail('等待条件超时');
}

function completedRecord(id, employee, departmentId, now) {
  return {
    id,
    owner_employee_id: employee.id,
    owner_department_id: departmentId,
    title: '已识别网页录音',
    title_source: 'manual',
    title_locked: true,
    ai_title: '',
    title_updated_at: now,
    source_type: 'web_capture',
    source_page_url: 'https://a.com/detail',
    source_page_title: '网页录音',
    source_media_url_hash: '',
    original_file_name: 'record.mp3',
    mime_type: 'audio/mpeg',
    file_size: 123456,
    duration_seconds: 360,
    r2_key: 'record.mp3',
    status: 'completed',
    template_type: 'meeting_minutes',
    followup_type: 'none',
    processing_started_at: now,
    transcribe_started_at: now,
    summarize_started_at: now,
    last_progress_at: now,
    asr_task_id: '',
    processing_attempts: 1,
    completed_at: now,
    error_message: '',
    archived_at: '',
    archived_by: '',
    deleted_at: '',
    deleted_by: '',
    created_at: now,
    updated_at: now,
  };
}

function addTranscriptAndSummary(data, recordId, now) {
  data.transcripts.push({
    id: `transcript-${recordId}`,
    audio_record_id: recordId,
    asr_provider: 'local-dev',
    asr_task_id: '',
    raw_text: '这是一条已经识别过的网页录音。',
    corrected_text: '这是一条已经识别过的网页录音。',
    segments_json: [],
    speaker_aliases_json: {},
    duration_ms: 360000,
    cost_cny: 0,
    created_at: now,
    updated_at: now,
  });
  data.summaries.push({
    id: `summary-${recordId}`,
    audio_record_id: recordId,
    template_type: 'meeting_minutes',
    summary_markdown: '已生成总结',
    overview_card_json: {},
    mind_map_json: {},
    structured_json: {},
    model_provider: 'local-dev',
    model_name: 'local-template',
    model_error: '',
    quality_status: 'ai_ok',
    quality_reason: '',
    input_transcript_chars: 15,
    summary_chars: 5,
    placeholder_count: 0,
    provider_errors_json: [],
    version: 1,
    created_at: now,
    updated_at: now,
  });
}

test('seeded users log in with expected roles and departments', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const lixin = await login(baseUrl, '离心');
    assert.equal(lixin.employee.globalRole, 'admin');
    assert.equal(Object.hasOwn(lixin, 'refreshToken'), false);

    const boss = await login(baseUrl, '练团长');
    assert.equal(boss.employee.globalRole, 'boss');

    const daijie = await login(baseUrl, '代姐');
    assert.equal(daijie.employee.globalRole, 'department_lead');
    assert.deepEqual(daijie.employee.departments.map((item) => item.name), ['招聘部']);

    const ermao = await login(baseUrl, '二毛');
    assert.deepEqual(ermao.employee.departments.map((item) => item.name).sort(), ['红娘部门', '运营部']);
  } finally {
    server.close();
  }
});

test('server refuses insecure default JWT secrets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-2-word-jwt-'));
  const previousAllowInsecure = process.env.VOICE_TO_WORD_ALLOW_INSECURE_JWT;
  delete process.env.VOICE_TO_WORD_ALLOW_INSECURE_JWT;
  try {
    assert.throws(() => createVoiceServer({
      dataFile: path.join(dir, 'db.json'),
      uploadDir: path.join(dir, 'uploads'),
      exportDir: path.join(dir, 'exports'),
      jwtSecret: '',
      recoverProcessing: false,
    }), /JWT_SECRET/);
    assert.throws(() => createVoiceServer({
      dataFile: path.join(dir, 'db.json'),
      uploadDir: path.join(dir, 'uploads'),
      exportDir: path.join(dir, 'exports'),
      jwtSecret: 'change-me-in-local-env',
      recoverProcessing: false,
    }), /JWT_SECRET/);
  } finally {
    if (previousAllowInsecure === undefined) delete process.env.VOICE_TO_WORD_ALLOW_INSECURE_JWT;
    else process.env.VOICE_TO_WORD_ALLOW_INSECURE_JWT = previousAllowInsecure;
  }
});

test('CORS only allows extension and configured origins', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const extensionPreflight = await fetch(`${baseUrl}/api/me`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'chrome-extension://abc123',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
      },
    });
    assert.equal(extensionPreflight.status, 204);
    assert.equal(extensionPreflight.headers.get('access-control-allow-origin'), 'chrome-extension://abc123');

    const blockedPreflight = await fetch(`${baseUrl}/api/me`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'https://evil.example',
        'Access-Control-Request-Method': 'GET',
        'Access-Control-Request-Headers': 'authorization',
      },
    });
    assert.equal(blockedPreflight.status, 204);
    assert.equal(blockedPreflight.headers.get('access-control-allow-origin'), null);
  } finally {
    server.close();
  }
});

test('server startup recovers interrupted summarizing records', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-2-word-recover-'));
  const dataFile = path.join(dir, 'db.json');
  const now = new Date().toISOString();
  const data = createInitialData(now);
  const owner = data.employees.find((employee) => employee.display_name === '离心');
  const membership = data.employee_departments.find((item) => item.employee_id === owner.id);
  data.audio_records.push({
    id: 'rec-recover-summary',
    owner_employee_id: owner.id,
    owner_department_id: membership.department_id,
    title: '重启恢复测试',
    title_source: 'manual',
    title_locked: true,
    ai_title: '',
    title_updated_at: now,
    source_type: 'manual_upload',
    source_page_url: '',
    source_page_title: '',
    source_media_url_hash: '',
    original_file_name: 'recover.mp3',
    mime_type: 'audio/mpeg',
    file_size: 10,
    duration_seconds: 1,
    r2_key: 'recover.mp3',
    status: 'summarizing',
    template_type: 'meeting_minutes',
    followup_type: 'none',
    processing_started_at: now,
    transcribe_started_at: now,
    summarize_started_at: now,
    last_progress_at: now,
    asr_task_id: 'task-existing',
    processing_attempts: 1,
    completed_at: null,
    error_message: '',
    created_at: now,
    updated_at: now,
  });
  data.transcripts.push({
    id: 'transcript-recover-summary',
    audio_record_id: 'rec-recover-summary',
    asr_provider: 'dashscope',
    asr_task_id: 'task-existing',
    raw_text: '团队讨论录音助手服务重启后，需要继续生成总结，避免用户看到任务卡住。',
    corrected_text: '团队讨论录音助手服务重启后，需要继续生成总结，避免用户看到任务卡住。',
    segments_json: [{ id: 'seg-1', startMs: 0, endMs: 1000, text: '需要恢复任务' }],
    speaker_aliases_json: {},
    duration_ms: 1000,
    cost_cny: null,
    created_at: now,
    updated_at: now,
  });
  fs.writeFileSync(dataFile, JSON.stringify(data, null, 2));

  createVoiceServer({
    dataFile,
    uploadDir: path.join(dir, 'uploads'),
    exportDir: path.join(dir, 'exports'),
    jwtSecret: 'test-secret',
    publicBaseUrl: 'http://localhost:0',
    devFakeAsr: true,
  });

  await waitFor(() => JSON.parse(fs.readFileSync(dataFile, 'utf8')).audio_records[0].status === 'completed');
  const recovered = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  assert.equal(recovered.audio_records[0].status, 'completed');
  assert.equal(recovered.followup_forms.length, 0);
  assert.ok(recovered.summaries.some((summary) => summary.audio_record_id === 'rec-recover-summary'));
  assert.match(
    recovered.record_processing_events.map((event) => event.message).join('\n'),
    /服务已重启，正在恢复处理任务。|已找到逐字稿，继续生成总结。/,
  );
});

test('speaker alias edits sync generated summary content', async () => {
  const now = new Date().toISOString();
  const data = createInitialData(now);
  const owner = data.employees.find((employee) => employee.display_name === '离心');
  const membership = data.employee_departments.find((item) => item.employee_id === owner.id);
  data.audio_records.push({
    id: 'rec-speaker-sync',
    owner_employee_id: owner.id,
    owner_department_id: membership.department_id,
    title: '说话人同步测试',
    title_source: 'manual',
    title_locked: true,
    ai_title: '',
    title_updated_at: now,
    source_type: 'manual_upload',
    source_page_url: '',
    source_page_title: '',
    source_media_url_hash: '',
    original_file_name: 'speaker-sync.mp3',
    mime_type: 'audio/mpeg',
    file_size: 10,
    duration_seconds: 1,
    r2_key: 'speaker-sync.mp3',
    status: 'completed',
    template_type: 'matchmaker_profile',
    followup_type: 'matchmaker',
    processing_started_at: now,
    transcribe_started_at: now,
    summarize_started_at: now,
    last_progress_at: now,
    asr_task_id: '',
    processing_attempts: 1,
    completed_at: now,
    error_message: '',
    created_at: now,
    updated_at: now,
  });
  data.transcripts.push({
    id: 'transcript-speaker-sync',
    audio_record_id: 'rec-speaker-sync',
    asr_provider: 'local-dev',
    asr_task_id: '',
    raw_text: 'Speaker 1 提出继续优化录音总结。',
    corrected_text: 'Speaker 1 提出继续优化录音总结。',
    segments_json: [{ id: 'seg-1', startMs: 0, endMs: 1000, speaker: 'Speaker 1', text: '继续优化录音总结' }],
    speaker_aliases_json: {},
    duration_ms: 1000,
    cost_cny: 0,
    created_at: now,
    updated_at: now,
  });
  data.summaries.push({
    id: 'summary-speaker-sync',
    audio_record_id: 'rec-speaker-sync',
    template_type: 'matchmaker_profile',
    summary_markdown: 'Speaker 1 提出继续优化录音总结。',
    overview_card_json: {
      heroTitle: 'Speaker 1 的总结卡片',
      heroSubtitle: 'Speaker 1 重点',
      cards: [{ title: '行动', blocks: [{ rows: [{ label: '负责人', value: 'Speaker 1' }], note: 'Speaker 1 已确认' }] }],
    },
    mind_map_json: {
      title: 'Speaker 1 思维导图',
      center: 'Speaker 1 决策',
      branches: [{ title: '行动', summary: 'Speaker 1 推进', children: [{ title: '下一步', detail: 'Speaker 1 跟进', items: ['Speaker 1 复盘'] }] }],
    },
    structured_json: { owner: 'Speaker 1', nested: { note: 'Speaker 1 已确认' } },
    model_provider: 'local-dev',
    model_name: 'local-template',
    model_error: '',
    version: 1,
    created_at: now,
    updated_at: now,
  });
  data.followup_forms.push({
    id: 'followup-speaker-sync',
    audio_record_id: 'rec-speaker-sync',
    business_type: 'matchmaker',
    stage: '待跟进',
    customer_name: '',
    company_name: '',
    status_label: 'Speaker 1 待跟进',
    suggested_tag: '',
    followup_markdown: 'Speaker 1 继续跟进客户。',
    fields_json: { owner: 'Speaker 1' },
    manual_edited: false,
    created_at: now,
    updated_at: now,
  });

  const { server, baseUrl } = await startTestServer({ initialData: data, recoverProcessing: false });
  try {
    const lixin = await login(baseUrl, '离心');
    const result = await request(baseUrl, '/api/records/rec-speaker-sync/transcript-speakers', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
      body: JSON.stringify({ speaker: 'Speaker 1', alias: '离心' }),
    });

    assert.equal(result.response.status, 200);
    assert.equal(result.body.record.transcript.speaker_aliases_json['Speaker 1'], '离心');
    assert.match(result.body.record.summary.summary_markdown, /离心/);
    assert.doesNotMatch(result.body.record.summary.summary_markdown, /Speaker 1/);
    assert.equal(result.body.record.summary.overview_card_json.heroTitle, '离心的总结卡片');
    assert.equal(result.body.record.summary.overview_card_json.cards[0].blocks[0].rows[0].value, '离心');
    assert.equal(result.body.record.summary.mind_map_json.branches[0].children[0].items[0], '离心复盘');
    assert.equal(result.body.record.summary.structured_json.nested.note, '离心已确认');
    assert.match(result.body.record.followupForm.followup_markdown, /离心/);
    assert.equal(result.body.record.followupForm.fields_json.owner, '离心');
  } finally {
    server.close();
  }
});

test('web root serves login workbench without weakening API auth', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const root = await fetch(`${baseUrl}/`);
    assert.equal(root.status, 200);
    assert.match(root.headers.get('content-type') || '', /text\/html/);
    const html = await root.text();
    assert.match(html, /大宜宾录音助手/);
    assert.match(html, /sidepanel\.js/);

    const stylesheet = await fetch(`${baseUrl}/webapp.css`);
    assert.equal(stylesheet.status, 200);
    assert.match(stylesheet.headers.get('content-type') || '', /text\/css/);

    const sidepanelScriptHead = await fetch(`${baseUrl}/sidepanel.js`, { method: 'HEAD' });
    assert.equal(sidepanelScriptHead.status, 200);
    assert.match(sidepanelScriptHead.headers.get('content-type') || '', /text\/javascript/);

    const installPage = await fetch(`${baseUrl}/install`);
    assert.equal(installPage.status, 200);
    assert.match(installPage.headers.get('content-type') || '', /text\/html/);
    const installHtml = await installPage.text();
    assert.match(installHtml, /安装大宜宾录音助手/);
    assert.match(installHtml, /voice-to-word-chrome-policy\.mobileconfig/);
    assert.match(installHtml, /install-windows-force-policy\.reg/);

    const macInstaller = await fetch(`${baseUrl}/releases/extension-crx/voice-to-word-chrome-policy.mobileconfig`);
    assert.equal(macInstaller.status, 200);
    assert.match(macInstaller.headers.get('content-type') || '', /application\/x-apple-aspen-config/);
    const macInstallerText = await macInstaller.text();
    assert.match(macInstallerText, /com\.apple\.ManagedClient\.preferences/);
    assert.match(macInstallerText, /ExtensionSettings/);

    const windowsInstaller = await fetch(`${baseUrl}/releases/extension-crx/install-windows-force-policy.reg`, { method: 'HEAD' });
    assert.equal(windowsInstaller.status, 200);
    assert.match(windowsInstaller.headers.get('content-type') || '', /text\/plain/);

    const protectedApi = await request(baseUrl, '/api/me');
    assert.equal(protectedApi.response.status, 401);
    assert.equal(protectedApi.body.error, '请先登录');
  } finally {
    server.close();
  }
});

test('record permissions isolate employee, department lead, and admin access', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const lixin = await login(baseUrl, '离心');
    const daijie = await login(baseUrl, '代姐');
    const ermao = await login(baseUrl, '二毛');
    const lanlan = await login(baseUrl, '岚岚');

    const create = await request(baseUrl, '/api/records', {
      method: 'POST',
      headers: { Authorization: `Bearer ${lanlan.accessToken}` },
      body: JSON.stringify({
        sourceType: 'manual_upload',
        title: '招聘客户电话',
        templateType: 'recruitment_followup',
      }),
    });
    assert.equal(create.response.status, 201);
    const recordId = create.body.record.id;

    const selfDetail = await request(baseUrl, `/api/records/${recordId}`, {
      headers: { Authorization: `Bearer ${lanlan.accessToken}` },
    });
    assert.equal(selfDetail.response.status, 200);

    const leadDetail = await request(baseUrl, `/api/records/${recordId}`, {
      headers: { Authorization: `Bearer ${daijie.accessToken}` },
    });
    assert.equal(leadDetail.response.status, 200);

    const wrongLead = await request(baseUrl, `/api/records/${recordId}`, {
      headers: { Authorization: `Bearer ${ermao.accessToken}` },
    });
    assert.equal(wrongLead.response.status, 403);

    const adminDetail = await request(baseUrl, `/api/records/${recordId}`, {
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
    });
    assert.equal(adminDetail.response.status, 200);
  } finally {
    server.close();
  }
});

test('record titles can be renamed only by owner or admin', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const lixin = await login(baseUrl, '离心');
    const daijie = await login(baseUrl, '代姐');
    const lanlan = await login(baseUrl, '岚岚');

    const create = await request(baseUrl, '/api/records', {
      method: 'POST',
      headers: { Authorization: `Bearer ${lanlan.accessToken}` },
      body: JSON.stringify({
        sourceType: 'manual_upload',
        title: '招聘客户电话',
        titleSource: 'manual',
        templateType: 'recruitment_followup',
      }),
    });
    const recordId = create.body.record.id;

    const invalid = await request(baseUrl, `/api/records/${recordId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${lanlan.accessToken}` },
      body: JSON.stringify({ title: '   ' }),
    });
    assert.equal(invalid.response.status, 400);

    const ownerRename = await request(baseUrl, `/api/records/${recordId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${lanlan.accessToken}` },
      body: JSON.stringify({ title: '招聘客户会员沟通' }),
    });
    assert.equal(ownerRename.response.status, 200);
    assert.equal(ownerRename.body.record.title, '招聘客户会员沟通');
    assert.equal(ownerRename.body.record.titleSource, 'manual');
    assert.equal(ownerRename.body.record.titleLocked, true);

    const leadRename = await request(baseUrl, `/api/records/${recordId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${daijie.accessToken}` },
      body: JSON.stringify({ title: '部门领导改名' }),
    });
    assert.equal(leadRename.response.status, 403);

    const adminRename = await request(baseUrl, `/api/records/${recordId}`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
      body: JSON.stringify({ title: '管理员复核标题' }),
    });
    assert.equal(adminRename.response.status, 200);
    assert.equal(adminRename.body.record.title, '管理员复核标题');
  } finally {
    server.close();
  }
});

test('manual upload creates completed local-development record and export', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const lanlan = await login(baseUrl, '岚岚');
    const create = await request(baseUrl, '/api/records', {
      method: 'POST',
      headers: { Authorization: `Bearer ${lanlan.accessToken}` },
      body: JSON.stringify({
        sourceType: 'manual_upload',
        title: '企业招聘沟通录音',
        templateType: 'recruitment_followup',
      }),
    });
    const recordId = create.body.record.id;

    const form = new FormData();
    form.append('file', new Blob(['fake audio'], { type: 'audio/mpeg' }), 'call.mp3');
    const uploadResponse = await fetch(`${baseUrl}/api/records/${recordId}/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${lanlan.accessToken}` },
      body: form,
    });
    const uploadBody = await uploadResponse.json();
    assert.equal(uploadResponse.status, 200);
    assert.equal(uploadBody.record.status, 'completed');
    assert.equal(uploadBody.record.followupForm.business_type, 'recruitment');
    assert.deepEqual(
      uploadBody.record.processingEvents.map((event) => event.phase),
      ['uploaded', 'uploaded', 'uploaded', 'summarizing', 'completed'],
    );
    assert.match(uploadBody.record.processingEvents.map((event) => event.message).join('\n'), /录音已上传/);
    assert.match(uploadBody.record.processingEvents.map((event) => event.message).join('\n'), /录音处理完成/);
    assert.equal(uploadBody.record.processingEvents.every((event) => Object.hasOwn(event, 'metadata')), true);

    const edited = await request(baseUrl, `/api/records/${recordId}/followup`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${lanlan.accessToken}` },
      body: JSON.stringify({
        stage: 'mid_late_effective_followup',
        companyName: '测试企业',
        suggestedTag: 'C 类，有需求',
        followupMarkdown: '中后期有效跟进\n【情况】：客户询问会员套餐，需人工确认。',
      }),
    });
    assert.equal(edited.response.status, 200);
    assert.equal(edited.body.followupForm.manual_edited, true);

    const exported = await request(baseUrl, `/api/records/${recordId}/export`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${lanlan.accessToken}` },
      body: JSON.stringify({ target: 'full_record', format: 'md' }),
    });
    assert.equal(exported.response.status, 200);
    assert.ok(exported.body.downloadUrl.includes('/api/export-files/'));
    assert.equal(typeof exported.body.downloadToken, 'string');
    assert.equal(exported.body.downloadUrl.includes('access_token='), false);
    const scopedDownload = await fetch(`${exported.body.downloadUrl.replace('http://localhost:0', baseUrl)}?download_token=${encodeURIComponent(exported.body.downloadToken)}`);
    assert.equal(scopedDownload.status, 200);
    const badScopedDownload = await fetch(`${exported.body.downloadUrl.replace('http://localhost:0', baseUrl)}?download_token=bad-token`);
    assert.equal(badScopedDownload.status, 401);
    const queryTokenMe = await fetch(`${baseUrl}/api/me?access_token=${encodeURIComponent(lanlan.accessToken)}`);
    assert.equal(queryTokenMe.status, 401);

    for (const format of ['txt', 'docx', 'pdf']) {
      const result = await request(baseUrl, `/api/records/${recordId}/export`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${lanlan.accessToken}` },
        body: JSON.stringify({ target: 'full_record', format }),
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.body.export.format, format);
    }
  } finally {
    server.close();
  }
});

test('web capture duplicate check only returns the current user own records', async () => {
  const now = new Date().toISOString();
  const data = createInitialData(now);
  const lanlan = data.employees.find((employee) => employee.display_name === '岚岚');
  const coco = data.employees.find((employee) => employee.display_name === 'Coco');
  const lanlanMembership = data.employee_departments.find((item) => item.employee_id === lanlan.id);
  const cocoMembership = data.employee_departments.find((item) => item.employee_id === coco.id);
  data.audio_records.push({
    ...completedRecord('rec-duplicate-lanlan', lanlan, lanlanMembership.department_id, now),
    title: '岚岚已识别录音',
    source_media_url_hash: mediaUrlFingerprint('https://a.com/audio?id=1&token=old'),
    archived_at: now,
  });
  addTranscriptAndSummary(data, 'rec-duplicate-lanlan', now);
  data.audio_records.push({
    ...completedRecord('rec-duplicate-coco', coco, cocoMembership.department_id, now),
    title: 'Coco 已识别录音',
    source_media_url_hash: mediaUrlFingerprint('https://a.com/audio?id=2&token=old'),
  });
  addTranscriptAndSummary(data, 'rec-duplicate-coco', now);

  const { server, baseUrl } = await startTestServer({ initialData: data });
  try {
    const lanlanLogin = await login(baseUrl, '岚岚');
    const own = await request(baseUrl, '/api/records/check-duplicate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${lanlanLogin.accessToken}` },
      body: JSON.stringify({
        candidateUrl: 'https://a.com/audio?token=new&id=1',
        sourcePageUrl: 'https://a.com/detail/1',
      }),
    });
    assert.equal(own.response.status, 200);
    assert.equal(own.body.duplicate, true);
    assert.equal(own.body.record.id, 'rec-duplicate-lanlan');
    assert.equal(own.body.record.hasTranscript, true);
    assert.equal(own.body.record.hasSummary, true);

    const otherUserRecord = await request(baseUrl, '/api/records/check-duplicate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${lanlanLogin.accessToken}` },
      body: JSON.stringify({ candidateUrl: 'https://a.com/audio?id=2&token=new' }),
    });
    assert.equal(otherUserRecord.body.duplicate, false);
  } finally {
    server.close();
  }
});

test('web capture duplicate check ignores deleted records and matches legacy raw hashes', async () => {
  const now = new Date().toISOString();
  const data = createInitialData(now);
  const lanlan = data.employees.find((employee) => employee.display_name === '岚岚');
  const membership = data.employee_departments.find((item) => item.employee_id === lanlan.id);
  data.audio_records.push({
    ...completedRecord('rec-deleted-duplicate', lanlan, membership.department_id, now),
    source_media_url_hash: mediaUrlFingerprint('https://a.com/audio?id=deleted&token=old'),
    deleted_at: now,
  });
  data.audio_records.push({
    ...completedRecord('rec-legacy-duplicate', lanlan, membership.department_id, now),
    source_media_url_hash: rawMediaUrlFingerprint('https://a.com/audio?id=legacy&token=old'),
  });

  const { server, baseUrl } = await startTestServer({ initialData: data });
  try {
    const loginBody = await login(baseUrl, '岚岚');
    const deleted = await request(baseUrl, '/api/records/check-duplicate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${loginBody.accessToken}` },
      body: JSON.stringify({ candidateUrl: 'https://a.com/audio?id=deleted&token=new' }),
    });
    assert.equal(deleted.body.duplicate, false);

    const legacy = await request(baseUrl, '/api/records/check-duplicate', {
      method: 'POST',
      headers: { Authorization: `Bearer ${loginBody.accessToken}` },
      body: JSON.stringify({ candidateUrl: 'https://a.com/audio?id=legacy&token=old' }),
    });
    assert.equal(legacy.body.duplicate, true);
    assert.equal(legacy.body.record.id, 'rec-legacy-duplicate');
  } finally {
    server.close();
  }
});

test('web capture record creation blocks duplicates unless forced', async () => {
  const now = new Date().toISOString();
  const data = createInitialData(now);
  const lanlan = data.employees.find((employee) => employee.display_name === '岚岚');
  const membership = data.employee_departments.find((item) => item.employee_id === lanlan.id);
  data.audio_records.push({
    ...completedRecord('rec-create-duplicate', lanlan, membership.department_id, now),
    source_media_url_hash: mediaUrlFingerprint('https://a.com/audio?id=42&token=old'),
  });

  const { server, baseUrl } = await startTestServer({ initialData: data });
  try {
    const loginBody = await login(baseUrl, '岚岚');
    const duplicate = await request(baseUrl, '/api/records', {
      method: 'POST',
      headers: { Authorization: `Bearer ${loginBody.accessToken}` },
      body: JSON.stringify({
        sourceType: 'web_capture',
        title: '重复网页录音',
        templateType: 'meeting_minutes',
        followupType: 'none',
        candidateUrl: 'https://a.com/audio?token=new&id=42',
      }),
    });
    assert.equal(duplicate.response.status, 409);
    assert.equal(duplicate.body.duplicate, true);
    assert.equal(duplicate.body.record.id, 'rec-create-duplicate');

    const forced = await request(baseUrl, '/api/records', {
      method: 'POST',
      headers: { Authorization: `Bearer ${loginBody.accessToken}` },
      body: JSON.stringify({
        sourceType: 'web_capture',
        title: '仍要重新识别',
        templateType: 'meeting_minutes',
        followupType: 'none',
        candidateUrl: 'https://a.com/audio?token=new&id=42',
        forceDuplicate: true,
      }),
    });
    assert.equal(forced.response.status, 201);
    assert.equal(forced.body.record.title, '仍要重新识别');

    const manual = await request(baseUrl, '/api/records', {
      method: 'POST',
      headers: { Authorization: `Bearer ${loginBody.accessToken}` },
      body: JSON.stringify({
        sourceType: 'manual_upload',
        title: '手动上传不查重',
        templateType: 'meeting_minutes',
        followupType: 'none',
        candidateUrl: 'https://a.com/audio?token=new&id=42',
      }),
    });
    assert.equal(manual.response.status, 201);
  } finally {
    server.close();
  }
});

test('R2 uploads use safe object keys for special original file names', async () => {
  const r2 = await startR2UploadServer();
  const { server, baseUrl } = await startTestServer({
    r2AccountId: 'account-id',
    r2AccessKeyId: 'access-key',
    r2SecretAccessKey: 'secret-key',
    r2Bucket: 'voice-bucket',
    r2Endpoint: r2.endpoint,
  });
  try {
    const lanlan = await login(baseUrl, '岚岚');
    const create = await request(baseUrl, '/api/records', {
      method: 'POST',
      headers: { Authorization: `Bearer ${lanlan.accessToken}` },
      body: JSON.stringify({
        sourceType: 'manual_upload',
        title: '特殊文件名上传',
        templateType: 'meeting_minutes',
      }),
    });
    const recordId = create.body.record.id;
    const form = new FormData();
    form.append('file', new Blob(['fake audio'], { type: 'audio/mpeg' }), "2026-06-18 09_18_40(1) it's ok!.mp3");
    const upload = await fetch(`${baseUrl}/api/records/${recordId}/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${lanlan.accessToken}` },
      body: form,
    });
    const body = await upload.json();
    assert.equal(upload.status, 200);
    assert.equal(body.record.originalFileName, "2026-06-18 09_18_40(1) it's ok!.mp3");
    assert.match(body.record.r2Key, new RegExp(`^audio/\\d{4}-\\d{2}-\\d{2}/${recordId}/source\\.mp3$`));
    assert.equal(r2.requests.length, 1);
    assert.doesNotMatch(r2.requests[0].url, /09_18_40|[()'!]/);
  } finally {
    server.close();
    r2.server.close();
  }
});

test('avatar upload rejects files over the 2MB limit', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const lixin = await login(baseUrl, '离心');
    const form = new FormData();
    form.append('avatar', new Blob([Buffer.alloc(2 * 1024 * 1024 + 1)], { type: 'image/png' }), 'avatar.png');
    const response = await fetch(`${baseUrl}/api/me/avatar`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
      body: form,
    });
    const body = await response.json();
    assert.equal(response.status, 413);
    assert.match(body.error, /上传文件超过限制|头像不能超过/);
  } finally {
    server.close();
  }
});

test('meeting minutes can skip follow-up and export omits follow-up section', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const lixin = await login(baseUrl, '离心');
    const create = await request(baseUrl, '/api/records', {
      method: 'POST',
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
      body: JSON.stringify({
        sourceType: 'manual_upload',
        title: '内部产品会议',
        templateType: 'meeting_minutes',
        followupType: 'none',
      }),
    });
    const recordId = create.body.record.id;

    const form = new FormData();
    form.append('file', new Blob(['fake audio for meeting'], { type: 'audio/mpeg' }), 'meeting.mp3');
    const uploadResponse = await fetch(`${baseUrl}/api/records/${recordId}/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
      body: form,
    });
    const uploadBody = await uploadResponse.json();
    assert.equal(uploadResponse.status, 200);
    assert.equal(uploadBody.record.status, 'completed');
    assert.equal(uploadBody.record.followupType, 'none');
    assert.equal(uploadBody.record.followupForm, null);

    const speakerAlias = await request(baseUrl, `/api/records/${recordId}/transcript-speakers`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
      body: JSON.stringify({ speaker: 'Speaker 1', alias: '离心' }),
    });
    assert.equal(speakerAlias.response.status, 200);
    assert.equal(speakerAlias.body.record.transcript.speaker_aliases_json['Speaker 1'], '离心');

    const clearedAlias = await request(baseUrl, `/api/records/${recordId}/transcript-speakers`, {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
      body: JSON.stringify({ speaker: 'Speaker 1', alias: '' }),
    });
    assert.equal(clearedAlias.response.status, 200);
    assert.equal(Object.hasOwn(clearedAlias.body.record.transcript.speaker_aliases_json, 'Speaker 1'), false);

    const audioRange = await fetch(`${baseUrl}/api/records/${recordId}/audio`, {
      headers: {
        Authorization: `Bearer ${lixin.accessToken}`,
        Range: 'bytes=0-3',
      },
    });
    assert.equal(audioRange.status, 206);
    assert.match(audioRange.headers.get('content-range') || '', /^bytes 0-3\//);
    const audioQueryToken = await fetch(`${baseUrl}/api/records/${recordId}/audio?access_token=${encodeURIComponent(lixin.accessToken)}`, {
      headers: { Range: 'bytes=0-3' },
    });
    assert.equal(audioQueryToken.status, 206);

    const exported = await request(baseUrl, `/api/records/${recordId}/export`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
      body: JSON.stringify({ target: 'full_record', format: 'md' }),
    });
    assert.equal(exported.response.status, 200);
    const downloadUrl = exported.body.downloadUrl.replace('http://localhost:0', baseUrl);
    const download = await fetch(downloadUrl, {
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
    });
    const text = await download.text();
    assert.equal(download.status, 200);
    assert.doesNotMatch(text, /跟单|暂无跟单/);

    for (const target of ['summary', 'transcript', 'overview_card', 'mind_map']) {
      for (const format of ['md', 'txt', 'docx', 'pdf']) {
        const result = await request(baseUrl, `/api/records/${recordId}/export`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${lixin.accessToken}` },
          body: JSON.stringify({ target, format }),
        });
        assert.equal(result.response.status, 200);
        assert.equal(result.body.export.format, format);
        const exportedFile = await fetch(result.body.downloadUrl.replace('http://localhost:0', baseUrl), {
          headers: { Authorization: `Bearer ${lixin.accessToken}` },
        });
        assert.equal(exportedFile.status, 200);
        const exportedBytes = await exportedFile.arrayBuffer();
        assert.ok(exportedBytes.byteLength > 0);
      }
    }

    for (const target of ['overview_card', 'mind_map']) {
      const result = await request(baseUrl, `/api/records/${recordId}/export`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${lixin.accessToken}` },
        body: JSON.stringify({ target, format: 'svg' }),
      });
      assert.equal(result.response.status, 200);
      assert.equal(result.body.export.format, 'svg');
      const exportedFile = await fetch(result.body.downloadUrl.replace('http://localhost:0', baseUrl), {
        headers: { Authorization: `Bearer ${lixin.accessToken}` },
      });
      assert.equal(exportedFile.status, 200);
      assert.match(exportedFile.headers.get('content-type') || '', /image\/svg\+xml/);
      assert.match(await exportedFile.text(), /<svg/);
    }

    const unsupportedSvg = await request(baseUrl, `/api/records/${recordId}/export`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
      body: JSON.stringify({ target: 'summary', format: 'svg' }),
    });
    assert.equal(unsupportedSvg.response.status, 400);

    const summaryMd = await request(baseUrl, `/api/records/${recordId}/export`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
      body: JSON.stringify({ target: 'summary', format: 'md' }),
    });
    const summaryDownload = await fetch(summaryMd.body.downloadUrl.replace('http://localhost:0', baseUrl), {
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
    });
    const summaryText = await summaryDownload.text();
    assert.match(summaryText, /总结卡片/);
    assert.match(summaryText, /思维导图/);

    const cardMd = await request(baseUrl, `/api/records/${recordId}/export`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
      body: JSON.stringify({ target: 'overview_card', format: 'md' }),
    });
    const cardDownload = await fetch(cardMd.body.downloadUrl.replace('http://localhost:0', baseUrl), {
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
    });
    const cardText = await cardDownload.text();
    assert.match(cardText, /总结卡片/);
    assert.doesNotMatch(cardText, /逐字稿/);

    const mindMapMd = await request(baseUrl, `/api/records/${recordId}/export`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
      body: JSON.stringify({ target: 'mind_map', format: 'md' }),
    });
    const mindMapDownload = await fetch(mindMapMd.body.downloadUrl.replace('http://localhost:0', baseUrl), {
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
    });
    const mindMapText = await mindMapDownload.text();
    assert.match(mindMapText, /思维导图/);
    assert.doesNotMatch(mindMapText, /逐字稿/);

    const bundle = await request(baseUrl, `/api/records/${recordId}/export`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
      body: JSON.stringify({ target: 'all_files', format: 'zip' }),
    });
    assert.equal(bundle.response.status, 200);
    assert.equal(bundle.body.export.format, 'zip');
    const bundleDownload = await fetch(bundle.body.downloadUrl.replace('http://localhost:0', baseUrl), {
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
    });
    const bundleBuffer = Buffer.from(await bundleDownload.arrayBuffer());
    assert.equal(bundleDownload.status, 200);
    assert.match(bundleDownload.headers.get('content-type') || '', /application\/zip/);
    assert.equal(bundleBuffer.subarray(0, 2).toString(), 'PK');
    assert.ok(bundleBuffer.includes(Buffer.from('01-full-record.md')));
    assert.ok(bundleBuffer.includes(Buffer.from('02-summary.pdf')));
    assert.ok(bundleBuffer.includes(Buffer.from('03-transcript.docx')));
    assert.ok(bundleBuffer.includes(Buffer.from('04-overview-card.svg')));
    assert.ok(bundleBuffer.includes(Buffer.from('05-mind-map.svg')));
  } finally {
    server.close();
  }
});

test('matchmaker records create matchmaker follow-up forms', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const coco = await login(baseUrl, 'Coco');
    const create = await request(baseUrl, '/api/records', {
      method: 'POST',
      headers: { Authorization: `Bearer ${coco.accessToken}` },
      body: JSON.stringify({
        sourceType: 'manual_upload',
        title: '红娘客户沟通',
        templateType: 'matchmaker_profile',
        followupType: 'matchmaker',
      }),
    });
    assert.equal(create.response.status, 201);
    assert.equal(create.body.record.followupType, 'matchmaker');

    const form = new FormData();
    form.append('file', new Blob(['fake audio for matchmaker'], { type: 'audio/mpeg' }), 'matchmaker.mp3');
    const upload = await fetch(`${baseUrl}/api/records/${create.body.record.id}/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${coco.accessToken}` },
      body: form,
    });
    const uploadBody = await upload.json();
    assert.equal(upload.status, 200);
    assert.equal(uploadBody.record.status, 'completed');
    assert.equal(uploadBody.record.followupType, 'matchmaker');
    assert.equal(uploadBody.record.followupForm.business_type, 'matchmaker');
    assert.match(uploadBody.record.followupForm.followup_markdown, /红娘|客户|画像|跟进/);
  } finally {
    server.close();
  }
});

test('regenerating with no follow-up deletes existing follow-up form', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const lanlan = await login(baseUrl, '岚岚');
    const create = await request(baseUrl, '/api/records', {
      method: 'POST',
      headers: { Authorization: `Bearer ${lanlan.accessToken}` },
      body: JSON.stringify({
        sourceType: 'manual_upload',
        title: '招聘客户沟通',
        templateType: 'recruitment_followup',
        followupType: 'recruitment',
      }),
    });
    const recordId = create.body.record.id;

    const form = new FormData();
    form.append('file', new Blob(['fake audio for recruitment'], { type: 'audio/mpeg' }), 'recruitment.mp3');
    const upload = await fetch(`${baseUrl}/api/records/${recordId}/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${lanlan.accessToken}` },
      body: form,
    });
    const uploadBody = await upload.json();
    assert.equal(upload.status, 200);
    assert.equal(uploadBody.record.followupForm.business_type, 'recruitment');

    const regenerated = await request(baseUrl, `/api/records/${recordId}/summarize`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${lanlan.accessToken}` },
      body: JSON.stringify({
        templateType: 'meeting_minutes',
        followupType: 'none',
        force: true,
      }),
    });
    assert.equal(regenerated.response.status, 200);
    assert.equal(regenerated.body.record.templateType, 'meeting_minutes');
    assert.equal(regenerated.body.record.followupType, 'none');
    assert.equal(regenerated.body.record.followupForm, null);

    const detail = await request(baseUrl, `/api/records/${recordId}`, {
      headers: { Authorization: `Bearer ${lanlan.accessToken}` },
    });
    assert.equal(detail.body.record.followupType, 'none');
    assert.equal(detail.body.record.followupForm, null);

    const exported = await request(baseUrl, `/api/records/${recordId}/export`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${lanlan.accessToken}` },
      body: JSON.stringify({ target: 'full_record', format: 'md' }),
    });
    const download = await fetch(exported.body.downloadUrl.replace('http://localhost:0', baseUrl), {
      headers: { Authorization: `Bearer ${lanlan.accessToken}` },
    });
    assert.equal(download.status, 200);
    assert.doesNotMatch(await download.text(), /跟单|暂无跟单/);
  } finally {
    server.close();
  }
});

test('summarize endpoint returns while the LLM job continues in the background', async () => {
  const llm = await startDelayedLlmServer();
  const now = new Date().toISOString();
  const data = createInitialData(now);
  const owner = data.employees.find((employee) => employee.display_name === '离心');
  const membership = data.employee_departments.find((item) => item.employee_id === owner.id);
  data.audio_records.push({
    id: 'rec-background-summary',
    owner_employee_id: owner.id,
    owner_department_id: membership.department_id,
    title: '后台总结接口测试',
    title_source: 'manual',
    title_locked: true,
    ai_title: '',
    title_updated_at: now,
    source_type: 'manual_upload',
    source_page_url: '',
    source_page_title: '',
    source_media_url_hash: '',
    original_file_name: 'background-summary.mp3',
    mime_type: 'audio/mpeg',
    file_size: 10,
    duration_seconds: 1,
    r2_key: 'background-summary.mp3',
    status: 'completed',
    template_type: 'meeting_minutes',
    followup_type: 'none',
    processing_started_at: now,
    transcribe_started_at: now,
    summarize_started_at: now,
    last_progress_at: now,
    asr_task_id: '',
    processing_attempts: 1,
    completed_at: now,
    error_message: '',
    created_at: now,
    updated_at: now,
  });
  data.transcripts.push({
    id: 'transcript-background-summary',
    audio_record_id: 'rec-background-summary',
    asr_provider: 'local-dev',
    asr_task_id: '',
    raw_text: '团队要求生成纪要时接口先返回，后台继续生成总结。',
    corrected_text: '团队要求生成纪要时接口先返回，后台继续生成总结。',
    segments_json: [{ id: 'seg-1', startMs: 0, endMs: 1000, text: '接口先返回' }],
    speaker_aliases_json: {},
    duration_ms: 1000,
    cost_cny: 0,
    created_at: now,
    updated_at: now,
  });

  const { server, baseUrl } = await startTestServer({
    initialData: data,
    recoverProcessing: false,
    easyAiBaseUrl: llm.baseUrl,
    easyAiApiKey: 'test-key',
    easyAiModel: 'test-model',
  });
  try {
    const lixin = await login(baseUrl, '离心');
    const startedAt = Date.now();
    const start = await request(baseUrl, '/api/records/rec-background-summary/summarize', {
      method: 'POST',
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
      body: JSON.stringify({ templateType: 'meeting_minutes', followupType: 'none' }),
    });

    assert.equal(start.response.status, 200);
    assert.equal(start.body.record.status, 'summarizing');
    assert.ok(Date.now() - startedAt < 500, 'summarize route should not wait for the LLM response');
    await waitFor(() => llm.getRequestCount() === 1);

    const during = await request(baseUrl, '/api/records/rec-background-summary', {
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
    });
    assert.equal(during.body.record.status, 'summarizing');

    llm.release();
    await waitFor(async () => {
      const detail = await request(baseUrl, '/api/records/rec-background-summary', {
        headers: { Authorization: `Bearer ${lixin.accessToken}` },
      });
      return detail.body.record.status === 'completed';
    });
    const completed = await request(baseUrl, '/api/records/rec-background-summary', {
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
    });
    assert.equal(completed.body.record.status, 'completed');
    assert.match(completed.body.record.summary.summary_markdown, /后台总结完成/);
  } finally {
    server.close();
    llm.release();
    llm.server.close();
  }
});

test('regenerating with another meeting template reuses the existing transcript', async () => {
  const now = new Date().toISOString();
  const data = createInitialData(now);
  const owner = data.employees.find((employee) => employee.display_name === '离心');
  const membership = data.employee_departments.find((item) => item.employee_id === owner.id);
  data.audio_records.push({
    ...completedRecord('rec-regenerate-template', owner, membership.department_id, now),
    source_type: 'manual_upload',
    source_media_url_hash: '',
    asr_task_id: 'dashscope-existing-task',
  });
  data.transcripts.push({
    id: 'transcript-regenerate-template',
    audio_record_id: 'rec-regenerate-template',
    asr_provider: 'dashscope',
    asr_task_id: 'dashscope-existing-task',
    raw_text: '会议决定由离心下周整理执行事项，并由团队确认截止时间。',
    corrected_text: '会议决定由离心下周整理执行事项，并由团队确认截止时间。',
    segments_json: [{ id: 'seg-1', startMs: 0, endMs: 1000, text: '整理执行事项' }],
    speaker_aliases_json: {},
    duration_ms: 1000,
    cost_cny: null,
    created_at: now,
    updated_at: now,
  });

  const { server, baseUrl } = await startTestServer({ initialData: data, recoverProcessing: false });
  try {
    const lixin = await login(baseUrl, '离心');
    const start = await request(baseUrl, '/api/records/rec-regenerate-template/summarize', {
      method: 'POST',
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
      body: JSON.stringify({ templateType: 'meeting_secretary', followupType: 'none' }),
    });
    assert.equal(start.response.status, 200);
    assert.equal(start.body.record.status, 'summarizing');
    assert.equal(start.body.record.templateType, 'meeting_secretary');

    await waitFor(async () => {
      const detail = await request(baseUrl, '/api/records/rec-regenerate-template', {
        headers: { Authorization: `Bearer ${lixin.accessToken}` },
      });
      return detail.body.record.status === 'completed';
    });

    const detail = await request(baseUrl, '/api/records/rec-regenerate-template', {
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
    });
    assert.equal(detail.body.record.templateType, 'meeting_secretary');
    assert.equal(detail.body.record.asrTaskId, 'dashscope-existing-task');
    assert.match(detail.body.record.summary.summary_markdown, /会议秘书/);

    const list = await request(baseUrl, '/api/records', {
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
    });
    assert.equal(list.body.records.filter((record) => record.id === 'rec-regenerate-template').length, 1);
    assert.equal(detail.body.record.processingEvents.some((event) => event.phase === 'transcribing'), false);
  } finally {
    server.close();
  }
});

test('failed LLM provider fallback keeps transcript and does not mark record completed', async () => {
  const now = new Date().toISOString();
  const data = createInitialData(now);
  const owner = data.employees.find((employee) => employee.display_name === '离心');
  const membership = data.employee_departments.find((item) => item.employee_id === owner.id);
  const provider = data.llm_providers.find((item) => item.id === 'llm_easyai_gpt55');
  Object.assign(provider, {
    enabled: true,
    api_key: 'bad-key',
    base_url: 'http://127.0.0.1:9/v1',
    timeout_ms: 100,
  });
  data.audio_records.push({
    id: 'rec-summary-fallback',
    owner_employee_id: owner.id,
    owner_department_id: membership.department_id,
    title: '总结失败保留逐字稿',
    title_source: 'manual',
    title_locked: true,
    ai_title: '',
    title_updated_at: now,
    source_type: 'manual_upload',
    source_page_url: '',
    source_page_title: '',
    source_media_url_hash: '',
    original_file_name: 'fallback.mp3',
    mime_type: 'audio/mpeg',
    file_size: 10,
    duration_seconds: 1,
    r2_key: 'fallback.mp3',
    status: 'completed',
    template_type: 'meeting_minutes',
    followup_type: 'none',
    processing_started_at: now,
    transcribe_started_at: now,
    summarize_started_at: now,
    last_progress_at: now,
    asr_task_id: '',
    processing_attempts: 1,
    completed_at: now,
    error_message: '',
    created_at: now,
    updated_at: now,
  });
  data.transcripts.push({
    id: 'transcript-summary-fallback',
    audio_record_id: 'rec-summary-fallback',
    asr_provider: 'dashscope',
    asr_task_id: '',
    raw_text: '团队讨论总结模型失败时，必须保留逐字稿，并提示用户稍后重试生成总结。',
    corrected_text: '团队讨论总结模型失败时，必须保留逐字稿，并提示用户稍后重试生成总结。',
    segments_json: [{ id: 'seg-1', startMs: 0, endMs: 1000, text: '保留逐字稿' }],
    speaker_aliases_json: {},
    duration_ms: 1000,
    cost_cny: null,
    created_at: now,
    updated_at: now,
  });

  const { server, baseUrl } = await startTestServer({ initialData: data, recoverProcessing: false });
  try {
    const lixin = await login(baseUrl, '离心');
    const start = await request(baseUrl, '/api/records/rec-summary-fallback/summarize', {
      method: 'POST',
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
      body: JSON.stringify({ templateType: 'meeting_minutes', followupType: 'none' }),
    });
    assert.equal(start.response.status, 200);

    await waitFor(async () => {
      const detail = await request(baseUrl, '/api/records/rec-summary-fallback', {
        headers: { Authorization: `Bearer ${lixin.accessToken}` },
      });
      return detail.body.record.status === 'transcribed';
    });

    const detail = await request(baseUrl, '/api/records/rec-summary-fallback', {
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
    });
    assert.equal(detail.body.record.status, 'transcribed');
    assert.match(detail.body.record.errorMessage, /AI 总结模型暂不可用/);
    assert.equal(detail.body.record.summary.quality_status, 'fallback_template');
    assert.equal(detail.body.record.summary.model_provider, 'local-template');
    assert.ok(Array.isArray(detail.body.record.summary.provider_errors_json));

    const summaryExport = await request(baseUrl, '/api/records/rec-summary-fallback/export', {
      method: 'POST',
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
      body: JSON.stringify({ target: 'summary', format: 'md' }),
    });
    assert.equal(summaryExport.response.status, 409);

    const bundle = await request(baseUrl, '/api/records/rec-summary-fallback/export', {
      method: 'POST',
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
      body: JSON.stringify({ target: 'all_files', format: 'zip' }),
    });
    assert.equal(bundle.response.status, 200);
  } finally {
    server.close();
  }
});

test('record audio endpoint enforces the same view permissions as detail pages', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const daijie = await login(baseUrl, '代姐');
    const ermao = await login(baseUrl, '二毛');
    const lanlan = await login(baseUrl, '岚岚');
    const create = await request(baseUrl, '/api/records', {
      method: 'POST',
      headers: { Authorization: `Bearer ${lanlan.accessToken}` },
      body: JSON.stringify({
        sourceType: 'manual_upload',
        title: '招聘音频权限测试',
        templateType: 'recruitment_followup',
        followupType: 'recruitment',
      }),
    });
    const recordId = create.body.record.id;

    const form = new FormData();
    form.append('file', new Blob(['audio permission bytes'], { type: 'audio/mpeg' }), 'permission.mp3');
    const upload = await fetch(`${baseUrl}/api/records/${recordId}/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${lanlan.accessToken}` },
      body: form,
    });
    assert.equal(upload.status, 200);

    const ownerAudio = await fetch(`${baseUrl}/api/records/${recordId}/audio`, {
      headers: { Authorization: `Bearer ${lanlan.accessToken}`, Range: 'bytes=0-4' },
    });
    assert.equal(ownerAudio.status, 206);

    const leadAudio = await fetch(`${baseUrl}/api/records/${recordId}/audio`, {
      headers: { Authorization: `Bearer ${daijie.accessToken}`, Range: 'bytes=0-4' },
    });
    assert.equal(leadAudio.status, 206);

    const wrongDepartmentAudio = await fetch(`${baseUrl}/api/records/${recordId}/audio`, {
      headers: { Authorization: `Bearer ${ermao.accessToken}` },
    });
    assert.equal(wrongDepartmentAudio.status, 403);

    const anonymousAudio = await fetch(`${baseUrl}/api/records/${recordId}/audio`);
    assert.equal(anonymousAudio.status, 401);
  } finally {
    server.close();
  }
});

test('audio endpoint falls back from octet-stream to playable mp3 MIME', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const lanlan = await login(baseUrl, '岚岚');
    const create = await request(baseUrl, '/api/records', {
      method: 'POST',
      headers: { Authorization: `Bearer ${lanlan.accessToken}` },
      body: JSON.stringify({
        sourceType: 'web_capture',
        title: 'Plaud mp3 MIME 测试',
        templateType: 'meeting_minutes',
        followupType: 'none',
      }),
    });
    const recordId = create.body.record.id;
    const form = new FormData();
    form.append('file', new Blob(['mp3 bytes'], { type: 'binary/octet-stream' }), 'plaud-record.mp3');
    const upload = await fetch(`${baseUrl}/api/records/${recordId}/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${lanlan.accessToken}` },
      body: form,
    });
    assert.equal(upload.status, 200);

    const audio = await fetch(`${baseUrl}/api/records/${recordId}/audio`, {
      headers: {
        Authorization: `Bearer ${lanlan.accessToken}`,
        Range: 'bytes=0-3',
      },
    });
    assert.equal(audio.status, 206);
    assert.equal(audio.headers.get('content-type'), 'audio/mpeg');
    assert.match(audio.headers.get('content-range') || '', /^bytes 0-3\//);
  } finally {
    server.close();
  }
});

test('record upload rejects known audio duration above 12 hours', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const lanlan = await login(baseUrl, '岚岚');
    const create = await request(baseUrl, '/api/records', {
      method: 'POST',
      headers: { Authorization: `Bearer ${lanlan.accessToken}` },
      body: JSON.stringify({
        sourceType: 'web_capture',
        title: '超长录音',
        templateType: 'meeting_minutes',
        followupType: 'none',
      }),
    });
    const form = new FormData();
    form.append('file', new Blob(['audio'], { type: 'audio/mpeg' }), 'long.mp3');
    form.append('candidateMeta', JSON.stringify({ durationSeconds: 12 * 60 * 60 + 1 }));
    const upload = await fetch(`${baseUrl}/api/records/${create.body.record.id}/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${lanlan.accessToken}` },
      body: form,
    });
    const body = await upload.json();
    assert.equal(upload.status, 400);
    assert.match(body.error, /最长支持 12 小时/);
  } finally {
    server.close();
  }
});

test('records can be archived by owner and purged by admin with local files removed', async () => {
  const { server, baseUrl, dir } = await startTestServer();
  try {
    const lixin = await login(baseUrl, '离心');
    const lanlan = await login(baseUrl, '岚岚');
    const create = await request(baseUrl, '/api/records', {
      method: 'POST',
      headers: { Authorization: `Bearer ${lanlan.accessToken}` },
      body: JSON.stringify({
        sourceType: 'manual_upload',
        title: '测试删除录音',
        templateType: 'meeting_minutes',
        followupType: 'none',
      }),
    });
    const recordId = create.body.record.id;
    const form = new FormData();
    form.append('file', new Blob(['delete-me'], { type: 'audio/mpeg' }), 'delete-me.mp3');
    const upload = await fetch(`${baseUrl}/api/records/${recordId}/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${lanlan.accessToken}` },
      body: form,
    });
    assert.equal(upload.status, 200);

    const exported = await request(baseUrl, `/api/records/${recordId}/export`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${lanlan.accessToken}` },
      body: JSON.stringify({ target: 'summary', format: 'md' }),
    });
    assert.equal(exported.response.status, 200);
    const uploadPath = path.join(dir, 'uploads', `${recordId}.mp3`);
    const exportPath = path.join(dir, 'exports', `${recordId}-summary.md`);
    assert.equal(fs.existsSync(uploadPath), true);
    assert.equal(fs.existsSync(exportPath), true);

    const archive = await request(baseUrl, `/api/records/${recordId}?mode=archive`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${lanlan.accessToken}` },
    });
    assert.equal(archive.response.status, 200);
    assert.equal(archive.body.mode, 'archive');

    const listed = await request(baseUrl, '/api/records', {
      headers: { Authorization: `Bearer ${lanlan.accessToken}` },
    });
    assert.equal(listed.body.records.some((record) => record.id === recordId), false);
    assert.equal(fs.existsSync(uploadPath), true);

    const wrongPurge = await request(baseUrl, `/api/records/${recordId}?mode=purge`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${lanlan.accessToken}` },
    });
    assert.equal(wrongPurge.response.status, 403);

    const purge = await request(baseUrl, `/api/records/${recordId}?mode=purge`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
    });
    assert.equal(purge.response.status, 200);
    assert.equal(purge.body.deleted, true);
    assert.equal(fs.existsSync(uploadPath), false);
    assert.equal(fs.existsSync(exportPath), false);

    const detail = await request(baseUrl, `/api/records/${recordId}`, {
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
    });
    assert.equal(detail.response.status, 404);

    const logs = await request(baseUrl, '/api/admin/audit-logs', {
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
    });
    assert.match(logs.body.auditLogs.map((log) => log.action).join('\n'), /archive_record/);
    assert.match(logs.body.auditLogs.map((log) => log.action).join('\n'), /purge_record/);
  } finally {
    server.close();
  }
});

test('AI title suggestions update filename titles but not manual titles', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const lanlan = await login(baseUrl, '岚岚');

    const autoCreate = await request(baseUrl, '/api/records', {
      method: 'POST',
      headers: { Authorization: `Bearer ${lanlan.accessToken}` },
      body: JSON.stringify({
        sourceType: 'manual_upload',
        title: '',
        titleSource: 'filename',
        templateType: 'meeting_minutes',
      }),
    });
    const autoForm = new FormData();
    autoForm.append('file', new Blob(['fake audio'], { type: 'audio/mpeg' }), '录音助手功能讨论.mp3');
    const autoUpload = await fetch(`${baseUrl}/api/records/${autoCreate.body.record.id}/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${lanlan.accessToken}` },
      body: autoForm,
    });
    const autoBody = await autoUpload.json();
    assert.equal(autoUpload.status, 200);
    assert.equal(autoBody.record.title, '录音助手功能讨论');
    assert.equal(autoBody.record.titleSource, 'ai');
    assert.equal(autoBody.record.aiTitle, '录音助手功能讨论');

    const manualCreate = await request(baseUrl, '/api/records', {
      method: 'POST',
      headers: { Authorization: `Bearer ${lanlan.accessToken}` },
      body: JSON.stringify({
        sourceType: 'manual_upload',
        title: '人工保留标题',
        titleSource: 'manual',
        templateType: 'meeting_minutes',
      }),
    });
    const manualForm = new FormData();
    manualForm.append('file', new Blob(['fake audio'], { type: 'audio/mpeg' }), '产品路线讨论.mp3');
    const manualUpload = await fetch(`${baseUrl}/api/records/${manualCreate.body.record.id}/upload`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${lanlan.accessToken}` },
      body: manualForm,
    });
    const manualBody = await manualUpload.json();
    assert.equal(manualUpload.status, 200);
    assert.equal(manualBody.record.title, '人工保留标题');
    assert.equal(manualBody.record.titleSource, 'manual');
    assert.equal(manualBody.record.aiTitle, '产品路线讨论');
  } finally {
    server.close();
  }
});

test('admin can create, disable, enable, and reset employees', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const lixin = await login(baseUrl, '离心');
    const departments = await request(baseUrl, '/api/departments', {
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
    });
    assert.equal(departments.response.status, 200);
    assert.ok(departments.body.departments.some((item) => item.name === '招聘部'));

    const me = await request(baseUrl, '/api/me', {
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
    });
    const recruitment = me.body.employee.departments.find((item) => item.name === '运营部');
    assert.ok(recruitment);

    const created = await request(baseUrl, '/api/admin/employees', {
      method: 'POST',
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
      body: JSON.stringify({
        displayName: '测试员工',
        departmentIds: [recruitment.id],
        globalRole: 'employee',
      }),
    });
    assert.equal(created.response.status, 201);
    const employeeId = created.body.employee.id;

    const disabled = await request(baseUrl, `/api/admin/employees/${employeeId}/disable`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
      body: JSON.stringify({}),
    });
    assert.equal(disabled.body.employee.status, 'inactive');

    const disabledLogin = await request(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ loginName: '测试员工', password: 'dayibin' }),
    });
    assert.equal(disabledLogin.response.status, 401);

    const enabled = await request(baseUrl, `/api/admin/employees/${employeeId}/enable`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
      body: JSON.stringify({}),
    });
    assert.equal(enabled.body.employee.status, 'active');

    const enabledLogin = await login(baseUrl, '测试员工');
    assert.equal(enabledLogin.employee.displayName, '测试员工');
  } finally {
    server.close();
  }
});

test('employees can update profile and change password', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const lanlan = await login(baseUrl, '岚岚');

    const profile = await request(baseUrl, '/api/me/profile', {
      headers: { Authorization: `Bearer ${lanlan.accessToken}` },
    });
    assert.equal(profile.response.status, 200);
    assert.equal(profile.body.employee.displayName, '岚岚');

    const updated = await request(baseUrl, '/api/me/profile', {
      method: 'PATCH',
      headers: { Authorization: `Bearer ${lanlan.accessToken}` },
      body: JSON.stringify({
        displayName: '岚岚',
        bio: '负责招聘客户跟进',
        aiProfileNote: '请优先输出待办、风险和责任人。',
        avatarColor: '#1b9a8a',
        globalRole: 'admin',
      }),
    });
    assert.equal(updated.response.status, 200);
    assert.equal(updated.body.employee.bio, '负责招聘客户跟进');
    assert.equal(updated.body.employee.aiProfileNote, '请优先输出待办、风险和责任人。');
    assert.equal(updated.body.employee.globalRole, 'employee');

    const wrongPassword = await request(baseUrl, '/api/auth/change-password', {
      method: 'POST',
      headers: { Authorization: `Bearer ${lanlan.accessToken}` },
      body: JSON.stringify({ oldPassword: 'wrong', newPassword: 'new-pass' }),
    });
    assert.equal(wrongPassword.response.status, 400);

    const changed = await request(baseUrl, '/api/auth/change-password', {
      method: 'POST',
      headers: { Authorization: `Bearer ${lanlan.accessToken}` },
      body: JSON.stringify({ oldPassword: 'dayibin', newPassword: 'new-pass' }),
    });
    assert.equal(changed.response.status, 200);

    const oldLogin = await request(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ loginName: '岚岚', password: 'dayibin' }),
    });
    assert.equal(oldLogin.response.status, 401);

    const newLogin = await request(baseUrl, '/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ loginName: '岚岚', password: 'new-pass' }),
    });
    assert.equal(newLogin.response.status, 200);
  } finally {
    server.close();
  }
});

test('admin settings centrally configure backend secrets without exposing them', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const lixin = await login(baseUrl, '离心');
    const lanlan = await login(baseUrl, '岚岚');

    const forbidden = await request(baseUrl, '/api/admin/settings', {
      headers: { Authorization: `Bearer ${lanlan.accessToken}` },
    });
    assert.equal(forbidden.response.status, 403);

    const initialSettings = await request(baseUrl, '/api/admin/settings', {
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
    });
    const timeoutField = initialSettings.body.groups
      .flatMap((group) => group.fields)
      .find((field) => field.key === 'dashscopeTimeoutMs');
    assert.equal(timeoutField.value, String(13 * 60 * 60 * 1000));

    const preflight = await fetch(`${baseUrl}/api/admin/settings`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'http://127.0.0.1:8132',
        'Access-Control-Request-Method': 'PUT',
        'Access-Control-Request-Headers': 'content-type,authorization',
      },
    });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get('access-control-allow-methods') || '', /\bPUT\b/);

    const saved = await request(baseUrl, '/api/admin/settings', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
      body: JSON.stringify({
        settings: {
          devFakeAsr: '0',
          dashscopeApiKey: 'dashscope-secret-key',
          r2AccountId: 'account-id',
          r2AccessKeyId: 'r2-access-key',
          r2SecretAccessKey: 'r2-secret-key',
          r2Bucket: 'voice-bucket',
          easyAiApiKey: 'easyai-secret-key',
        },
      }),
    });
    assert.equal(saved.response.status, 200);
    assert.equal(saved.body.status.dashscopeConfigured, true);
    assert.equal(saved.body.status.r2Configured, true);
    assert.equal(saved.body.status.llmConfigured, true);
    assert.equal(saved.body.status.devFakeAsr, false);
    assert.equal(saved.body.meta.settingsVersion, 2);

    const dashscopeField = saved.body.groups
      .flatMap((group) => group.fields)
      .find((field) => field.key === 'dashscopeApiKey');
    assert.equal(dashscopeField.value, '');
    assert.equal(dashscopeField.configured, true);
    assert.equal(dashscopeField.maskedValue.includes('dashscope-secret-key'), false);

    const health = await request(baseUrl, '/health');
    assert.equal(health.body.dashscopeConfigured, true);
    assert.equal(health.body.r2Configured, true);
    assert.equal(health.body.llmConfigured, true);
    assert.equal(health.body.devFakeAsr, false);

    const preserved = await request(baseUrl, '/api/admin/settings', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
      body: JSON.stringify({
        settings: {
          dashscopeApiKey: '',
          easyAiApiKey: '',
          publicBaseUrl: 'http://voice-server.local:8127',
        },
      }),
    });
    const preservedFields = preserved.body.groups.flatMap((group) => group.fields);
    assert.equal(preservedFields.find((field) => field.key === 'dashscopeApiKey').configured, true);
    assert.equal(preserved.body.status.publicBaseUrl, 'http://voice-server.local:8127');
    assert.equal(preserved.body.meta.settingsVersion, 3);

    const cleared = await request(baseUrl, '/api/admin/settings', {
      method: 'PUT',
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
      body: JSON.stringify({
        settings: { easyAiApiKey: '' },
        clearKeys: ['easyAiApiKey'],
      }),
    });
    assert.equal(cleared.body.status.llmConfigured, false);
    assert.equal(cleared.body.meta.settingsVersion, 4);

    const settingTest = await request(baseUrl, '/api/admin/settings/test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
      body: JSON.stringify({ target: 'publicBaseUrl' }),
    });
    assert.equal(settingTest.response.status, 200);
    assert.equal(settingTest.body.ok, true);

    const auditLogs = await request(baseUrl, '/api/admin/audit-logs', {
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
    });
    assert.equal(auditLogs.response.status, 200);
    const settingsAuditLogs = auditLogs.body.auditLogs.filter((log) => log.targetType === 'system_settings');
    assert.ok(settingsAuditLogs.length >= 4);
    assert.ok(settingsAuditLogs.some((log) => log.action === 'update_system_settings'));
    assert.ok(settingsAuditLogs.some((log) => log.action === 'test_system_settings'));
    assert.ok(settingsAuditLogs.every((log) => log.actorName === '离心'));
    assert.equal(JSON.stringify(settingsAuditLogs).includes('dashscope-secret-key'), false);
  } finally {
    server.close();
  }
});

test('admin llm provider pool protects secrets and drives summarize priority', async () => {
  const llm = await startLlmProviderServer();
  const now = new Date().toISOString();
  const data = createInitialData(now);
  const owner = data.employees.find((employee) => employee.display_name === '离心');
  const membership = data.employee_departments.find((item) => item.employee_id === owner.id);
  data.audio_records.push({
    id: 'rec-llm-provider-pool',
    owner_employee_id: owner.id,
    owner_department_id: membership.department_id,
    title: '模型池总结测试',
    title_source: 'manual',
    title_locked: true,
    ai_title: '',
    title_updated_at: now,
    source_type: 'manual_upload',
    source_page_url: '',
    source_page_title: '',
    source_media_url_hash: '',
    original_file_name: 'llm-provider.mp3',
    mime_type: 'audio/mpeg',
    file_size: 10,
    duration_seconds: 1,
    r2_key: 'llm-provider.mp3',
    status: 'completed',
    template_type: 'meeting_minutes',
    followup_type: 'none',
    processing_started_at: now,
    transcribe_started_at: now,
    summarize_started_at: now,
    last_progress_at: now,
    asr_task_id: '',
    processing_attempts: 1,
    completed_at: now,
    error_message: '',
    created_at: now,
    updated_at: now,
  });
  data.transcripts.push({
    id: 'transcript-llm-provider-pool',
    audio_record_id: 'rec-llm-provider-pool',
    asr_provider: 'local-dev',
    asr_task_id: '',
    raw_text: '团队要求总结优先命中新配置的 sub2api 模型。',
    corrected_text: '团队要求总结优先命中新配置的 sub2api 模型。',
    segments_json: [{ id: 'seg-1', startMs: 0, endMs: 1000, text: '命中 sub2api' }],
    speaker_aliases_json: {},
    duration_ms: 1000,
    cost_cny: 0,
    created_at: now,
    updated_at: now,
  });

  const { server, baseUrl } = await startTestServer({ initialData: data, recoverProcessing: false });
  try {
    const lixin = await login(baseUrl, '离心');
    const lanlan = await login(baseUrl, '岚岚');

    const forbidden = await request(baseUrl, '/api/admin/llm-providers', {
      headers: { Authorization: `Bearer ${lanlan.accessToken}` },
    });
    assert.equal(forbidden.response.status, 403);

    const initial = await request(baseUrl, '/api/admin/llm-providers', {
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
    });
    assert.equal(initial.response.status, 200);
    assert.ok(initial.body.providers.some((provider) => provider.id === 'llm_sub2api_gpt55'));
    assert.equal(JSON.stringify(initial.body).includes('api_key'), false);

    const tested = await request(baseUrl, '/api/admin/llm-providers/test', {
      method: 'POST',
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
      body: JSON.stringify({
        displayName: 'AI 大宜宾 sub2api - GPT-5.5',
        providerKey: 'sub2api',
        channelId: 'sub2api',
        protocol: 'openai-responses',
        baseUrl: llm.baseUrl,
        endpointPath: '/responses',
        apiKey: 'sub2api-secret-key',
        requestModel: 'gpt-5.5',
        reasoningEffort: 'high',
      }),
    });
    assert.equal(tested.body.ok, true);
    assert.equal(llm.requests.at(-1).url, '/v1/responses');
    assert.equal(llm.requests.at(-1).authorization, 'Bearer sub2api-secret-key');

    const created = await request(baseUrl, '/api/admin/llm-providers', {
      method: 'POST',
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
      body: JSON.stringify({
        displayName: 'AI 大宜宾 sub2api - GPT-5.5',
        providerKey: 'sub2api',
        channelId: 'sub2api',
        protocol: 'openai-responses',
        baseUrl: llm.baseUrl,
        endpointPath: '/responses',
        apiKey: 'sub2api-secret-key',
        requestModel: 'gpt-5.5',
        priority: 1,
        enabled: true,
        allowFallback: true,
        forceSaveWithoutTest: true,
      }),
    });
    assert.equal(created.response.status, 201);
    assert.equal(created.body.provider.configured, true);
    assert.equal(JSON.stringify(created.body).includes('sub2api-secret-key'), false);

    const health = await request(baseUrl, '/health');
    assert.equal(health.body.llmConfigured, true);

    const start = await request(baseUrl, '/api/records/rec-llm-provider-pool/summarize', {
      method: 'POST',
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
      body: JSON.stringify({ templateType: 'meeting_minutes', followupType: 'none' }),
    });
    assert.equal(start.response.status, 200);
    await waitFor(async () => {
      const detail = await request(baseUrl, '/api/records/rec-llm-provider-pool', {
        headers: { Authorization: `Bearer ${lixin.accessToken}` },
      });
      return detail.body.record.status === 'completed' &&
        detail.body.record.summary?.model_provider === 'sub2api';
    });
    const completed = await request(baseUrl, '/api/records/rec-llm-provider-pool', {
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
    });
    assert.equal(completed.body.record.summary.model_provider, 'sub2api');
    assert.equal(completed.body.record.summary.model_name, 'gpt-5.5');
    assert.match(completed.body.record.summary.summary_markdown, /sub2api 总结/);

    const providersAfterCall = await request(baseUrl, '/api/admin/llm-providers', {
      headers: { Authorization: `Bearer ${lixin.accessToken}` },
    });
    const sub2api = providersAfterCall.body.providers.find((provider) => provider.id === created.body.provider.id);
    assert.equal(sub2api.lastCallStatus, 'success');
  } finally {
    server.close();
    llm.server.close();
  }
});
