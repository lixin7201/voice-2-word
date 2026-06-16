const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { JsonStore } = require('./lib/store');
const { hashPassword, signToken, verifyPassword, verifyToken } = require('./lib/auth');
const { TEMPLATE_OPTIONS, buildLocalSummary, defaultTemplateForEmployee } = require('./lib/templates');
const { isR2Configured, presignR2Url, putR2Object } = require('./lib/r2');
const { isDashScopeConfigured, transcribeWithDashScope } = require('./lib/dashscope');
const { generateSummary } = require('./lib/llm');
const { buildExportText, createDocxBuffer, createPdfBuffer, stripMarkdown } = require('./lib/exporters');
const { resolveRuntimeConfig, saveSystemSettings, serializeSystemSettings } = require('./lib/system-settings');

const DEFAULT_DATA_FILE = path.join(process.cwd(), 'data', 'dev-db.json');
const DEFAULT_UPLOAD_DIR = path.join(process.cwd(), 'uploads');
const DEFAULT_EXPORT_DIR = path.join(process.cwd(), 'exports');
const SUPPORTED_EXTENSIONS = new Set(['mp3', 'm4a', 'wav', 'aac', 'flac', 'ogg', 'opus', 'mp4', 'mov', 'webm']);

function createVoiceServer(options = {}) {
  const config = {
    dataFile: options.dataFile || process.env.DATA_FILE || DEFAULT_DATA_FILE,
    uploadDir: options.uploadDir || process.env.UPLOAD_DIR || DEFAULT_UPLOAD_DIR,
    exportDir: options.exportDir || process.env.EXPORT_DIR || DEFAULT_EXPORT_DIR,
    jwtSecret: options.jwtSecret || process.env.JWT_SECRET || 'voice-2-word-local-dev-secret',
    publicBaseUrl: options.publicBaseUrl || process.env.PUBLIC_BASE_URL || 'http://lixindemac-studio.local:8127',
    devFakeAsr: options.devFakeAsr ?? process.env.VOICE_TO_WORD_DEV_FAKE_ASR === '1',
    dashscopeApiKey: options.dashscopeApiKey ?? process.env.DASHSCOPE_API_KEY,
    dashscopeBaseUrl: options.dashscopeBaseUrl || process.env.DASHSCOPE_BASE_URL,
    dashscopeModel: options.dashscopeModel || process.env.DASHSCOPE_MODEL || 'fun-asr',
    dashscopeVocabularyId: options.dashscopeVocabularyId || process.env.DASHSCOPE_VOCABULARY_ID,
    dashscopePollIntervalMs: options.dashscopePollIntervalMs || process.env.DASHSCOPE_POLL_INTERVAL_MS,
    dashscopeTimeoutMs: options.dashscopeTimeoutMs || process.env.DASHSCOPE_TIMEOUT_MS,
    r2AccountId: options.r2AccountId || process.env.CLOUDFLARE_R2_ACCOUNT_ID,
    r2AccessKeyId: options.r2AccessKeyId || process.env.CLOUDFLARE_R2_ACCESS_KEY_ID,
    r2SecretAccessKey: options.r2SecretAccessKey || process.env.CLOUDFLARE_R2_SECRET_ACCESS_KEY,
    r2Bucket: options.r2Bucket || process.env.CLOUDFLARE_R2_BUCKET,
    r2Endpoint: options.r2Endpoint || process.env.CLOUDFLARE_R2_ENDPOINT,
    easyAiBaseUrl: options.easyAiBaseUrl || process.env.EASYAI_BASE_URL || 'https://aisoeasy.cc',
    easyAiApiKey: options.easyAiApiKey || process.env.EASYAI_API_KEY,
    easyAiModel: options.easyAiModel || process.env.EASYAI_MODEL || 'gpt-5.5',
    kimiBaseUrl: options.kimiBaseUrl || process.env.KIMI_BASE_URL || 'https://api.moonshot.cn',
    kimiApiKey: options.kimiApiKey || process.env.KIMI_API_KEY,
    kimiModel: options.kimiModel || process.env.KIMI_MODEL || 'kimi-k2.6',
  };
  const store = options.store || new JsonStore(config.dataFile);
  store.load();

  return http.createServer(async (req, res) => {
    setCorsHeaders(res);
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    try {
      await routeRequest(req, res, store, config);
    } catch (error) {
      const status = error.statusCode || 500;
      sendJson(res, status, {
        error: error.publicMessage || error.message || '服务端错误',
      });
    }
  });
}

async function routeRequest(req, res, store, config) {
  const url = new URL(req.url, 'http://localhost');
  const pathname = url.pathname;
  const runtimeConfig = resolveRuntimeConfig(config, store);

  if (req.method === 'GET' && pathname === '/health') {
    sendJson(res, 200, {
      ok: true,
      service: 'voice-2-word',
      version: '0.1.0',
      r2Configured: isR2Configured(runtimeConfig),
      dashscopeConfigured: isDashScopeConfigured(runtimeConfig),
      llmConfigured: Boolean(runtimeConfig.easyAiApiKey || runtimeConfig.kimiApiKey),
      devFakeAsr: Boolean(runtimeConfig.devFakeAsr),
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/auth/login') {
    const body = await readJson(req);
    const employee = store.table('employees').find((item) =>
      (item.login_name === body.loginName || item.employee_no === body.loginName) &&
      item.status === 'active'
    );
    if (!employee || !verifyPassword(body.password || '', employee.password_hash)) {
      throw httpError(401, '工号/花名或密码不正确');
    }

    const now = new Date().toISOString();
    store.update('employees', employee.id, { last_login_at: now });
    addAudit(store, employee.id, 'login', 'employee', employee.id);
    const freshEmployee = store.findById('employees', employee.id);
    sendJson(res, 200, {
      accessToken: signToken({ employeeId: employee.id }, runtimeConfig.jwtSecret),
      refreshToken: signToken({ employeeId: employee.id, type: 'refresh' }, runtimeConfig.jwtSecret, 60 * 60 * 24 * 14),
      employee: serializeEmployee(freshEmployee, store),
    });
    return;
  }

  const auth = authenticate(req, store, runtimeConfig);

  if (req.method === 'GET' && pathname === '/api/me') {
    sendJson(res, 200, {
      employee: serializeEmployee(auth.employee, store),
      permissions: permissionsFor(auth.employee),
      templates: TEMPLATE_OPTIONS,
      defaultTemplate: defaultTemplateForEmployee(auth.employee, employeeDepartments(auth.employee.id, store)),
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/auth/change-password') {
    const body = await readJson(req);
    if (!verifyPassword(body.oldPassword || '', auth.employee.password_hash)) {
      throw httpError(400, '旧密码不正确');
    }
    if (!body.newPassword || String(body.newPassword).length < 6) {
      throw httpError(400, '新密码至少 6 位');
    }
    store.update('employees', auth.employee.id, { password_hash: hashPassword(body.newPassword) });
    sendJson(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/templates') {
    sendJson(res, 200, { templates: TEMPLATE_OPTIONS });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/departments') {
    sendJson(res, 200, { departments: store.table('departments') });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/records') {
    const records = store.table('audio_records')
      .filter((record) => canViewRecord(auth.employee, record, store))
      .filter((record) => filterRecord(record, url.searchParams, store))
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
      .map((record) => serializeRecord(record, store, { compact: true }));
    sendJson(res, 200, { records });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/records') {
    const body = await readJson(req);
    const ownerDepartment = pickOwnerDepartment(auth.employee, store, body.departmentId);
    const record = store.insert('audio_records', {
      owner_employee_id: auth.employee.id,
      owner_department_id: ownerDepartment?.id || null,
      title: body.title || defaultRecordTitle(body.sourceType),
      source_type: body.sourceType || 'manual_upload',
      source_page_url: body.sourcePageUrl || '',
      source_page_title: body.sourcePageTitle || '',
      source_media_url_hash: body.candidateUrl ? sha256(body.candidateUrl) : '',
      original_file_name: '',
      mime_type: '',
      file_size: 0,
      duration_seconds: null,
      r2_key: '',
      status: 'created',
      template_type: body.templateType || defaultTemplateForEmployee(auth.employee, employeeDepartments(auth.employee.id, store)),
      completed_at: null,
      error_message: '',
    });
    sendJson(res, 201, { record: serializeRecord(record, store) });
    return;
  }

  const recordIdMatch = pathname.match(/^\/api\/records\/([^/]+)$/);
  if (recordIdMatch && req.method === 'GET') {
    const record = requireRecord(recordIdMatch[1], store);
    ensureCanViewRecord(auth.employee, record, store);
    if (record.owner_employee_id !== auth.employee.id) {
      addAudit(store, auth.employee.id, 'view_other_record', 'audio_record', record.id);
    }
    sendJson(res, 200, { record: serializeRecord(record, store) });
    return;
  }

  const uploadMatch = pathname.match(/^\/api\/records\/([^/]+)\/upload$/);
  if (uploadMatch && req.method === 'POST') {
    const record = requireRecord(uploadMatch[1], store);
    ensureCanEditRecord(auth.employee, record, store);
    const upload = await readMultipart(req);
    const file = upload.files.file;
    if (!file) throw httpError(400, '请上传录音文件');
    const ext = safeExtension(file.filename || '');
    if (!SUPPORTED_EXTENSIONS.has(ext)) {
      throw httpError(400, '暂不支持该文件格式');
    }
    fs.mkdirSync(config.uploadDir, { recursive: true });
    const storedName = `${record.id}.${ext}`;
    const storedPath = path.join(config.uploadDir, storedName);
    fs.writeFileSync(storedPath, file.buffer);
    const uploaded = store.update('audio_records', record.id, {
      original_file_name: file.filename || storedName,
      mime_type: file.contentType || '',
      file_size: file.buffer.length,
      status: 'uploaded',
      error_message: '',
      source_media_url_hash: upload.fields.candidateUrl ? sha256(upload.fields.candidateUrl) : record.source_media_url_hash,
    });
    await enqueueRecordProcessing(uploaded, store, runtimeConfig);
    sendJson(res, 200, { record: serializeRecord(store.findById('audio_records', record.id), store) });
    return;
  }

  const noteMatch = pathname.match(/^\/api\/records\/([^/]+)\/note$/);
  if (noteMatch && req.method === 'PATCH') {
    const record = requireRecord(noteMatch[1], store);
    ensureCanViewRecord(auth.employee, record, store);
    const body = await readJson(req);
    const note = store.insert('record_notes', {
      audio_record_id: record.id,
      employee_id: auth.employee.id,
      note: String(body.note || '').trim(),
    });
    sendJson(res, 200, { note, record: serializeRecord(record, store) });
    return;
  }

  const summarizeMatch = pathname.match(/^\/api\/records\/([^/]+)\/summarize$/);
  if (summarizeMatch && req.method === 'POST') {
    const record = requireRecord(summarizeMatch[1], store);
    ensureCanViewRecord(auth.employee, record, store);
    const body = await readJson(req);
    const updated = store.update('audio_records', record.id, {
      template_type: body.templateType || record.template_type,
      status: 'summarizing',
      error_message: '',
    });
    await summarizeExistingRecord(updated, store, runtimeConfig);
    sendJson(res, 200, { record: serializeRecord(store.findById('audio_records', record.id), store) });
    return;
  }

  const transcribeMatch = pathname.match(/^\/api\/records\/([^/]+)\/transcribe$/);
  if (transcribeMatch && req.method === 'POST') {
    const record = requireRecord(transcribeMatch[1], store);
    ensureCanViewRecord(auth.employee, record, store);
    await enqueueRecordProcessing(record, store, runtimeConfig);
    sendJson(res, 200, { record: serializeRecord(store.findById('audio_records', record.id), store) });
    return;
  }

  const followupMatch = pathname.match(/^\/api\/records\/([^/]+)\/followup$/);
  if (followupMatch && req.method === 'PATCH') {
    const record = requireRecord(followupMatch[1], store);
    ensureCanViewRecord(auth.employee, record, store);
    const body = await readJson(req);
    const followup = upsertByAudioRecord(store, 'followup_forms', record.id, {
      business_type: body.businessType || businessTypeForTemplate(record.template_type),
      stage: body.stage || '',
      customer_name: body.customerName || '',
      company_name: body.companyName || '',
      status_label: body.statusLabel || '',
      suggested_tag: body.suggestedTag || '',
      followup_markdown: String(body.followupMarkdown || '').trim(),
      fields_json: body.fields || {},
      manual_edited: true,
    });
    addAudit(store, auth.employee.id, 'edit_followup', 'audio_record', record.id);
    sendJson(res, 200, { followupForm: followup, record: serializeRecord(record, store) });
    return;
  }

  const exportMatch = pathname.match(/^\/api\/records\/([^/]+)\/export$/);
  if (exportMatch && req.method === 'POST') {
    const record = requireRecord(exportMatch[1], store);
    ensureCanViewRecord(auth.employee, record, store);
    const body = await readJson(req);
    const exportFile = await createExportFile(record, auth.employee, body, store, runtimeConfig);
    if (record.owner_employee_id !== auth.employee.id) {
      addAudit(store, auth.employee.id, 'export_other_record', 'audio_record', record.id, body);
    }
    sendJson(res, 200, {
      export: exportFile,
      downloadUrl: `${runtimeConfig.publicBaseUrl}/api/export-files/${exportFile.id}/download`,
    });
    return;
  }

  const downloadMatch = pathname.match(/^\/api\/export-files\/([^/]+)\/download$/);
  if (downloadMatch && req.method === 'GET') {
    const exportFile = store.findById('export_files', downloadMatch[1]);
    if (!exportFile) throw httpError(404, '导出文件不存在');
    const record = requireRecord(exportFile.audio_record_id, store);
    ensureCanViewRecord(auth.employee, record, store);
    if (exportFile.storage === 'r2') {
      res.writeHead(302, {
        Location: presignR2Url(runtimeConfig, { method: 'GET', key: exportFile.r2_key, expiresIn: 900 }),
      });
      res.end();
      return;
    }
    const filePath = path.join(runtimeConfig.exportDir, exportFile.r2_key);
    if (!fs.existsSync(filePath)) throw httpError(404, '导出文件不存在');
    res.writeHead(200, {
      'Content-Type': contentTypeForExport(exportFile.format),
      'Content-Disposition': `attachment; filename="${encodeURIComponent(path.basename(filePath))}"`,
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  if (pathname === '/api/admin/employees' && req.method === 'GET') {
    ensureCanManageEmployees(auth.employee);
    const employees = store.table('employees').map((employee) => serializeEmployee(employee, store));
    sendJson(res, 200, { employees });
    return;
  }

  if (pathname === '/api/admin/settings' && req.method === 'GET') {
    ensureCanManageSettings(auth.employee);
    sendJson(res, 200, serializeSystemSettings(config, store));
    return;
  }

  if (pathname === '/api/admin/settings' && ['POST', 'PUT', 'PATCH'].includes(req.method)) {
    ensureCanManageSettings(auth.employee);
    const body = await readJson(req);
    saveSystemSettings(store, body, auth.employee.id);
    addAudit(store, auth.employee.id, 'update_system_settings', 'system_settings', 'global');
    sendJson(res, 200, serializeSystemSettings(config, store));
    return;
  }

  if (pathname === '/api/admin/audit-logs' && req.method === 'GET') {
    ensureCanManageEmployees(auth.employee);
    sendJson(res, 200, {
      auditLogs: store.table('audit_logs')
        .slice()
        .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
        .slice(0, 300),
    });
    return;
  }

  if (pathname === '/api/admin/employees' && req.method === 'POST') {
    ensureCanManageEmployees(auth.employee);
    const body = await readJson(req);
    const employee = createEmployee(body, store);
    addAudit(store, auth.employee.id, 'create_employee', 'employee', employee.id, { displayName: employee.display_name });
    sendJson(res, 201, { employee: serializeEmployee(employee, store) });
    return;
  }

  const employeePatchMatch = pathname.match(/^\/api\/admin\/employees\/([^/]+)$/);
  if (employeePatchMatch && req.method === 'PATCH') {
    ensureCanManageEmployees(auth.employee);
    const body = await readJson(req);
    const employee = requireEmployee(employeePatchMatch[1], store);
    const updated = updateEmployee(employee, body, store);
    addAudit(store, auth.employee.id, 'update_employee', 'employee', updated.id, body);
    sendJson(res, 200, { employee: serializeEmployee(updated, store) });
    return;
  }

  const employeeActionMatch = pathname.match(/^\/api\/admin\/employees\/([^/]+)\/(disable|enable|reset-password)$/);
  if (employeeActionMatch && req.method === 'POST') {
    ensureCanManageEmployees(auth.employee);
    const employee = requireEmployee(employeeActionMatch[1], store);
    const action = employeeActionMatch[2];
    const body = await readJson(req, true);
    let updated;
    if (action === 'disable') updated = store.update('employees', employee.id, { status: 'inactive' });
    if (action === 'enable') updated = store.update('employees', employee.id, { status: 'active' });
    if (action === 'reset-password') {
      updated = store.update('employees', employee.id, { password_hash: hashPassword(body.password || 'dayibin') });
    }
    addAudit(store, auth.employee.id, action.replace('-', '_'), 'employee', employee.id);
    sendJson(res, 200, { employee: serializeEmployee(updated, store) });
    return;
  }

  if (pathname === '/api/integrations/ztools/daily-review-source' && req.method === 'POST') {
    const body = await readJson(req);
    const employee = body.employeeId ? requireEmployee(body.employeeId, store) : auth.employee;
    const date = body.date || new Date().toISOString().slice(0, 10);
    const records = store.table('audio_records')
      .filter((record) => record.owner_employee_id === employee.id && String(record.created_at || '').startsWith(date))
      .filter((record) => canViewRecord(auth.employee, record, store))
      .map((record) => serializeRecord(record, store, { compact: true }));
    sendJson(res, 200, {
      employee: employee.display_name,
      date,
      records,
    });
    return;
  }

  throw httpError(404, '接口不存在');
}

function authenticate(req, store, config) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  const payload = verifyToken(token, config.jwtSecret);
  if (!payload?.employeeId) throw httpError(401, '请先登录');
  const employee = store.findById('employees', payload.employeeId);
  if (!employee || employee.status !== 'active') throw httpError(401, '账号不可用，请重新登录');
  return { employee };
}

function serializeEmployee(employee, store) {
  return {
    id: employee.id,
    employeeNo: employee.employee_no,
    loginName: employee.login_name,
    displayName: employee.display_name,
    globalRole: employee.global_role,
    status: employee.status,
    lastLoginAt: employee.last_login_at,
    departments: employeeDepartments(employee.id, store).map((department) => ({
      id: department.id,
      name: department.name,
      memberRole: department.memberRole,
    })),
    createdAt: employee.created_at,
    updatedAt: employee.updated_at,
  };
}

function serializeRecord(record, store, options = {}) {
  const owner = store.findById('employees', record.owner_employee_id);
  const department = record.owner_department_id ? store.findById('departments', record.owner_department_id) : null;
  const base = {
    id: record.id,
    title: record.title,
    owner: owner ? { id: owner.id, displayName: owner.display_name } : null,
    department: department ? { id: department.id, name: department.name } : null,
    sourceType: record.source_type,
    sourcePageUrl: record.source_page_url,
    sourcePageTitle: record.source_page_title,
    originalFileName: record.original_file_name,
    mimeType: record.mime_type,
    fileSize: record.file_size,
    durationSeconds: record.duration_seconds,
    status: record.status,
    templateType: record.template_type,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    completedAt: record.completed_at,
    errorMessage: record.error_message,
    noteCount: store.table('record_notes').filter((note) => note.audio_record_id === record.id).length,
  };
  if (options.compact) return base;
  return {
    ...base,
    transcript: store.table('transcripts').find((item) => item.audio_record_id === record.id) || null,
    summary: store.table('summaries').find((item) => item.audio_record_id === record.id) || null,
    followupForm: store.table('followup_forms').find((item) => item.audio_record_id === record.id) || null,
    notes: store.table('record_notes')
      .filter((note) => note.audio_record_id === record.id)
      .map((note) => ({
        ...note,
        employee: store.findById('employees', note.employee_id)?.display_name || '未知员工',
      })),
  };
}

function employeeDepartments(employeeId, store) {
  const memberships = store.table('employee_departments').filter((item) => item.employee_id === employeeId);
  return memberships.map((membership) => {
    const department = store.findById('departments', membership.department_id);
    return department ? { ...department, memberRole: membership.member_role } : null;
  }).filter(Boolean);
}

function permissionsFor(employee) {
  return {
    canManageEmployees: ['admin', 'boss'].includes(employee.global_role),
    canManageSettings: ['admin', 'boss'].includes(employee.global_role),
    canViewAllRecords: ['admin', 'boss'].includes(employee.global_role),
    canViewDepartmentRecords: employee.global_role === 'department_lead',
  };
}

function canViewRecord(employee, record, store) {
  if (record.owner_employee_id === employee.id) return true;
  if (['admin', 'boss'].includes(employee.global_role)) return true;
  return employeeDepartments(employee.id, store).some((department) =>
    department.id === record.owner_department_id && department.memberRole === 'lead'
  );
}

function ensureCanViewRecord(employee, record, store) {
  if (!canViewRecord(employee, record, store)) throw httpError(403, '没有权限查看该录音');
}

function ensureCanEditRecord(employee, record, store) {
  if (record.owner_employee_id === employee.id || ['admin', 'boss'].includes(employee.global_role)) return;
  throw httpError(403, '没有权限修改该录音');
}

function ensureCanManageEmployees(employee) {
  if (!['admin', 'boss'].includes(employee.global_role)) throw httpError(403, '没有员工管理权限');
}

function ensureCanManageSettings(employee) {
  if (!['admin', 'boss'].includes(employee.global_role)) throw httpError(403, '没有后台配置权限');
}

function pickOwnerDepartment(employee, store, requestedDepartmentId) {
  const departments = employeeDepartments(employee.id, store);
  if (requestedDepartmentId) {
    const requested = departments.find((department) => department.id === requestedDepartmentId);
    if (requested) return requested;
  }
  return departments.find((department) => department.memberRole === 'member') || departments[0] || null;
}

function filterRecord(record, params, store) {
  if (params.get('departmentId') && record.owner_department_id !== params.get('departmentId')) return false;
  if (params.get('employeeId') && record.owner_employee_id !== params.get('employeeId')) return false;
  if (params.get('status') && record.status !== params.get('status')) return false;
  if (params.get('templateType') && record.template_type !== params.get('templateType')) return false;
  const keyword = params.get('keyword')?.trim().toLowerCase();
  if (keyword) {
    const owner = store.findById('employees', record.owner_employee_id)?.display_name || '';
    const haystack = [record.title, record.original_file_name, record.source_page_title, owner].join('\n').toLowerCase();
    if (!haystack.includes(keyword)) return false;
  }
  return true;
}

async function enqueueRecordProcessing(record, store, config) {
  if (config.devFakeAsr) {
    await processUploadedRecord(record, store, config);
    return;
  }
  processUploadedRecord(record, store, config).catch((error) => {
    store.update('audio_records', record.id, {
      status: 'failed',
      error_message: error.message || String(error),
    });
  });
}

async function processUploadedRecord(record, store, config) {
  const localPath = path.join(config.uploadDir, `${record.id}.${safeExtension(record.original_file_name || '')}`);
  let audioUrl = '';
  let storageKey = record.r2_key;
  if (isR2Configured(config)) {
    storageKey = storageKey || `audio/${new Date().toISOString().slice(0, 10)}/${record.id}/${record.original_file_name || `${record.id}.mp3`}`;
    const buffer = fs.existsSync(localPath) ? fs.readFileSync(localPath) : Buffer.alloc(0);
    await putR2Object(config, storageKey, buffer, record.mime_type || 'application/octet-stream');
    store.update('audio_records', record.id, { r2_key: storageKey, status: 'uploaded' });
    audioUrl = presignR2Url(config, { method: 'GET', key: storageKey, expiresIn: 7200 });
  } else {
    storageKey = storageKey || path.basename(localPath);
    store.update('audio_records', record.id, { r2_key: storageKey });
  }

  if (config.devFakeAsr) {
    const transcriptText = `本地开发模式已接收文件：${record.original_file_name || record.title}`;
    const summary = buildLocalSummary(record, transcriptText);
    upsertByAudioRecord(store, 'transcripts', record.id, {
      audio_record_id: record.id,
      asr_provider: 'local-dev',
      asr_task_id: '',
      raw_text: transcriptText,
      corrected_text: transcriptText,
      segments_json: [],
      speaker_aliases_json: {},
      duration_ms: 0,
      cost_cny: 0,
    });
    upsertByAudioRecord(store, 'summaries', record.id, {
      audio_record_id: record.id,
      template_type: record.template_type,
      summary_markdown: summary.summaryMarkdown,
      overview_card_json: summary.overviewCard,
      mind_map_json: {},
      structured_json: summary.structuredJson,
      model_provider: summary.modelProvider || 'local-dev',
      model_name: summary.modelName || 'local-template',
      model_error: summary.modelError || '',
      version: 1,
    });
    upsertByAudioRecord(store, 'followup_forms', record.id, {
      audio_record_id: record.id,
      business_type: businessTypeForTemplate(record.template_type),
      stage: summary.followupStage || '',
      customer_name: summary.customerName || '',
      company_name: summary.companyName || '',
      status_label: summary.statusLabel || '待核对',
      suggested_tag: summary.suggestedTag || '待核对',
      followup_markdown: summary.followupMarkdown,
      fields_json: summary.followupFields || summary.structuredJson,
      manual_edited: false,
    });
    store.update('audio_records', record.id, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      error_message: '',
    });
    return;
  }

  if (!config.dashscopeApiKey) {
    store.update('audio_records', record.id, {
      status: 'failed',
      error_message: '后端尚未配置 DASHSCOPE_API_KEY，已保存录音文件，等待接入真实转写。',
    });
    return;
  }

  if (!isR2Configured(config)) {
    store.update('audio_records', record.id, {
      status: 'failed',
      error_message: '真实 DashScope 转写需要先配置 Cloudflare R2，以便生成公网临时音频链接。',
    });
    return;
  }

  const transcribing = store.update('audio_records', record.id, {
    status: 'transcribing',
    error_message: '',
  });
  const transcription = await transcribeWithDashScope(config, audioUrl);
  upsertByAudioRecord(store, 'transcripts', record.id, {
    audio_record_id: record.id,
    asr_provider: 'dashscope',
    asr_task_id: transcription.taskId,
    raw_text: transcription.rawText,
    corrected_text: transcription.correctedText,
    segments_json: transcription.segments,
    speaker_aliases_json: {},
    duration_ms: transcription.durationMs,
    cost_cny: null,
  });
  store.update('audio_records', record.id, {
    status: 'summarizing',
    duration_seconds: transcription.durationMs ? Math.round(transcription.durationMs / 1000) : record.duration_seconds,
  });
  await summarizeExistingRecord(transcribing, store, config);
}

async function summarizeExistingRecord(record, store, config) {
  const transcript = store.table('transcripts').find((item) => item.audio_record_id === record.id);
  const transcriptText = transcript?.corrected_text || transcript?.raw_text || '';
  const summary = await generateSummary(config, record, transcriptText);
  upsertByAudioRecord(store, 'summaries', record.id, {
    audio_record_id: record.id,
    template_type: record.template_type,
    summary_markdown: summary.summaryMarkdown,
    overview_card_json: summary.overviewCard,
    mind_map_json: summary.mindMap || {},
    structured_json: summary.structuredJson,
    model_provider: summary.modelProvider || 'local-template',
    model_name: summary.modelName || 'local-template',
    model_error: summary.modelError || '',
    version: 1,
  });
  upsertByAudioRecord(store, 'followup_forms', record.id, {
    audio_record_id: record.id,
    business_type: businessTypeForTemplate(record.template_type),
    stage: summary.followupStage || '',
    customer_name: summary.customerName || '',
    company_name: summary.companyName || '',
    status_label: summary.statusLabel || '待核对',
    suggested_tag: summary.suggestedTag || '待核对',
    followup_markdown: summary.followupMarkdown,
    fields_json: summary.followupFields || summary.structuredJson,
    manual_edited: false,
  });
  store.update('audio_records', record.id, {
    status: 'completed',
    completed_at: new Date().toISOString(),
    error_message: '',
  });
}

function businessTypeForTemplate(templateType) {
  if (templateType === 'matchmaker_profile') return 'matchmaker';
  if (templateType === 'recruitment_followup') return 'recruitment';
  if (templateType === 'customer_follow_up') return 'general_customer';
  return 'general';
}

async function createExportFile(record, employee, body, store, config) {
  const target = body.target || 'full_record';
  const format = body.format || 'md';
  if (!['md', 'txt', 'docx', 'pdf'].includes(format)) throw httpError(400, '暂不支持该导出格式');
  const markdown = buildExportText(record, store, target, true);
  let buffer;
  if (format === 'md') buffer = Buffer.from(markdown);
  if (format === 'txt') buffer = Buffer.from(stripMarkdown(markdown));
  if (format === 'docx') buffer = createDocxBuffer(record.title, stripMarkdown(markdown));
  if (format === 'pdf') buffer = createPdfBuffer(record.title, markdown);

  fs.mkdirSync(config.exportDir, { recursive: true });
  const fileName = `${record.id}-${target}.${format}`;
  fs.writeFileSync(path.join(config.exportDir, fileName), buffer);
  let storage = 'local';
  let storageKey = fileName;
  if (isR2Configured(config)) {
    storageKey = `exports/${new Date().toISOString().slice(0, 10)}/${fileName}`;
    await putR2Object(config, storageKey, buffer, contentTypeForExport(format));
    storage = 'r2';
  }
  return store.insert('export_files', {
    audio_record_id: record.id,
    export_type: target,
    format,
    r2_key: storageKey,
    storage,
    created_by: employee.id,
  });
}

function upsertByAudioRecord(store, tableName, audioRecordId, row) {
  const existing = store.table(tableName).find((item) => item.audio_record_id === audioRecordId);
  if (existing) return store.update(tableName, existing.id, row);
  return store.insert(tableName, row);
}

function contentTypeForExport(format) {
  if (format === 'md') return 'text/markdown; charset=utf-8';
  if (format === 'txt') return 'text/plain; charset=utf-8';
  if (format === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (format === 'pdf') return 'application/pdf';
  return 'application/octet-stream';
}

function createEmployee(body, store) {
  const displayName = String(body.displayName || '').trim();
  if (!displayName) throw httpError(400, '花名不能为空');
  const exists = store.table('employees').some((employee) => employee.login_name === displayName);
  if (exists) throw httpError(400, '该花名已存在');
  const now = new Date().toISOString();
  const employee = store.insert('employees', {
    employee_no: body.employeeNo || '',
    login_name: displayName,
    display_name: displayName,
    password_hash: hashPassword(body.password || 'dayibin'),
    global_role: body.globalRole || 'employee',
    status: 'active',
    last_login_at: null,
    created_at: now,
    updated_at: now,
  });
  replaceEmployeeDepartments(employee.id, body.departmentIds || [], store, body.memberRole || 'member');
  return employee;
}

function updateEmployee(employee, body, store) {
  const updates = {};
  if (body.displayName) {
    updates.display_name = String(body.displayName).trim();
    updates.login_name = String(body.displayName).trim();
  }
  if (body.employeeNo !== undefined) updates.employee_no = body.employeeNo;
  if (body.globalRole) updates.global_role = body.globalRole;
  if (body.status) updates.status = body.status;
  const updated = store.update('employees', employee.id, updates);
  if (Array.isArray(body.departmentIds)) {
    replaceEmployeeDepartments(employee.id, body.departmentIds, store, body.memberRole || 'member');
  }
  return updated;
}

function replaceEmployeeDepartments(employeeId, departmentIds, store, memberRole) {
  const table = store.table('employee_departments');
  for (let index = table.length - 1; index >= 0; index -= 1) {
    if (table[index].employee_id === employeeId) table.splice(index, 1);
  }
  for (const departmentId of departmentIds) {
    if (store.findById('departments', departmentId)) {
      table.push({
        id: crypto.randomUUID(),
        employee_id: employeeId,
        department_id: departmentId,
        member_role: memberRole,
        created_at: new Date().toISOString(),
      });
    }
  }
  store.save();
}

function addAudit(store, actorEmployeeId, action, targetType, targetId, metadata = {}) {
  store.insert('audit_logs', {
    actor_employee_id: actorEmployeeId,
    action,
    target_type: targetType,
    target_id: targetId,
    metadata_json: metadata,
  });
}

function requireRecord(id, store) {
  const record = store.findById('audio_records', id);
  if (!record) throw httpError(404, '录音记录不存在');
  return record;
}

function requireEmployee(id, store) {
  const employee = store.findById('employees', id);
  if (!employee) throw httpError(404, '员工不存在');
  return employee;
}

function readJson(req, allowEmpty = false) {
  return readBody(req).then((buffer) => {
    if (allowEmpty && buffer.length === 0) return {};
    if (buffer.length === 0) throw httpError(400, '请求体不能为空');
    return JSON.parse(buffer.toString('utf8'));
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

async function readMultipart(req) {
  const contentType = req.headers['content-type'] || '';
  const boundaryMatch = contentType.match(/boundary=([^;]+)/);
  if (!boundaryMatch) throw httpError(400, '上传格式不正确');
  const boundary = `--${boundaryMatch[1]}`;
  const body = (await readBody(req)).toString('latin1');
  const parts = body.split(boundary).slice(1, -1);
  const fields = {};
  const files = {};
  for (const part of parts) {
    const clean = part.replace(/^\r\n/, '').replace(/\r\n$/, '');
    const separatorIndex = clean.indexOf('\r\n\r\n');
    if (separatorIndex === -1) continue;
    const rawHeaders = clean.slice(0, separatorIndex);
    let rawContent = clean.slice(separatorIndex + 4);
    if (rawContent.endsWith('\r\n')) rawContent = rawContent.slice(0, -2);
    const dispositionLine = rawHeaders.split(/\r?\n/).find((line) => line.toLowerCase().startsWith('content-disposition:'));
    if (!dispositionLine) continue;
    const name = dispositionLine.match(/(?:^|;\s*)name="([^"]+)"/)?.[1];
    const filename = dispositionLine.match(/(?:^|;\s*)filename="([^"]*)"/)?.[1];
    if (!name) continue;
    const contentTypeMatch = rawHeaders.match(/content-type:\s*([^\r\n]+)/i);
    if (filename) {
      files[name] = {
        filename: path.basename(filename),
        contentType: contentTypeMatch?.[1] || '',
        buffer: Buffer.from(rawContent, 'latin1'),
      };
    } else {
      fields[name] = Buffer.from(rawContent, 'latin1').toString('utf8');
    }
  }
  return { fields, files };
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type,Authorization');
}

function httpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.publicMessage = message;
  return error;
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function safeExtension(fileName) {
  return String(fileName).split('.').pop().toLowerCase().replace(/[^a-z0-9]/g, '');
}

function defaultRecordTitle(sourceType) {
  const date = new Date().toISOString().slice(0, 10);
  return sourceType === 'web_capture' ? `${date} 网页录音` : `${date} 手动上传录音`;
}

module.exports = {
  createVoiceServer,
};
