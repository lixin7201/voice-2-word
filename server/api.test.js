const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createVoiceServer } = require('./app');

function startTestServer() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-2-word-'));
  const server = createVoiceServer({
    dataFile: path.join(dir, 'db.json'),
    uploadDir: path.join(dir, 'uploads'),
    exportDir: path.join(dir, 'exports'),
    jwtSecret: 'test-secret',
    publicBaseUrl: 'http://localhost:0',
    devFakeAsr: true,
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

test('seeded users log in with expected roles and departments', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const lixin = await login(baseUrl, '离心');
    assert.equal(lixin.employee.globalRole, 'admin');

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

test('admin settings centrally configure backend secrets without exposing them', async () => {
  const { server, baseUrl } = await startTestServer();
  try {
    const lixin = await login(baseUrl, '离心');
    const lanlan = await login(baseUrl, '岚岚');

    const forbidden = await request(baseUrl, '/api/admin/settings', {
      headers: { Authorization: `Bearer ${lanlan.accessToken}` },
    });
    assert.equal(forbidden.response.status, 403);

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
  } finally {
    server.close();
  }
});
