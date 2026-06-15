const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { JsonStore } = require('./lib/store');
const { hashPassword, signToken, verifyPassword, verifyToken } = require('./lib/auth');
const { TEMPLATE_OPTIONS, buildLocalSummary, defaultTemplateForEmployee } = require('./lib/templates');

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

  if (req.method === 'GET' && pathname === '/health') {
    sendJson(res, 200, {
      ok: true,
      service: 'voice-2-word',
      version: '0.1.0',
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
      accessToken: signToken({ employeeId: employee.id }, config.jwtSecret),
      refreshToken: signToken({ employeeId: employee.id, type: 'refresh' }, config.jwtSecret, 60 * 60 * 24 * 14),
      employee: serializeEmployee(freshEmployee, store),
    });
    return;
  }

  const auth = authenticate(req, store, config);

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
    processUploadedRecord(uploaded, store, config);
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
      status: 'uploaded',
      error_message: '',
    });
    processUploadedRecord(updated, store, { ...config, devFakeAsr: true });
    sendJson(res, 200, { record: serializeRecord(store.findById('audio_records', record.id), store) });
    return;
  }

  const transcribeMatch = pathname.match(/^\/api\/records\/([^/]+)\/transcribe$/);
  if (transcribeMatch && req.method === 'POST') {
    const record = requireRecord(transcribeMatch[1], store);
    ensureCanViewRecord(auth.employee, record, store);
    processUploadedRecord(record, store, config);
    sendJson(res, 200, { record: serializeRecord(store.findById('audio_records', record.id), store) });
    return;
  }

  const exportMatch = pathname.match(/^\/api\/records\/([^/]+)\/export$/);
  if (exportMatch && req.method === 'POST') {
    const record = requireRecord(exportMatch[1], store);
    ensureCanViewRecord(auth.employee, record, store);
    const body = await readJson(req);
    const exportFile = createExportFile(record, auth.employee, body, store, config);
    if (record.owner_employee_id !== auth.employee.id) {
      addAudit(store, auth.employee.id, 'export_other_record', 'audio_record', record.id, body);
    }
    sendJson(res, 200, {
      export: exportFile,
      downloadUrl: `${config.publicBaseUrl}/api/export-files/${exportFile.id}/download`,
    });
    return;
  }

  const downloadMatch = pathname.match(/^\/api\/export-files\/([^/]+)\/download$/);
  if (downloadMatch && req.method === 'GET') {
    const exportFile = store.findById('export_files', downloadMatch[1]);
    if (!exportFile) throw httpError(404, '导出文件不存在');
    const record = requireRecord(exportFile.audio_record_id, store);
    ensureCanViewRecord(auth.employee, record, store);
    const filePath = path.join(config.exportDir, exportFile.r2_key);
    if (!fs.existsSync(filePath)) throw httpError(404, '导出文件不存在');
    res.writeHead(200, {
      'Content-Type': exportFile.format === 'md' ? 'text/markdown; charset=utf-8' : 'text/plain; charset=utf-8',
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

function processUploadedRecord(record, store, config) {
  if (config.devFakeAsr) {
    const summary = buildLocalSummary(record);
    store.insert('transcripts', {
      audio_record_id: record.id,
      asr_provider: 'local-dev',
      asr_task_id: '',
      raw_text: `本地开发模式已接收文件：${record.original_file_name || record.title}`,
      corrected_text: `本地开发模式已接收文件：${record.original_file_name || record.title}`,
      segments_json: [],
      speaker_aliases_json: {},
      duration_ms: 0,
      cost_cny: 0,
    });
    store.insert('summaries', {
      audio_record_id: record.id,
      template_type: record.template_type,
      summary_markdown: summary.summaryMarkdown,
      overview_card_json: summary.overviewCard,
      mind_map_json: {},
      structured_json: summary.structuredJson,
      model_provider: 'local-dev',
      model_name: 'local-template',
      model_error: '',
      version: 1,
    });
    store.insert('followup_forms', {
      audio_record_id: record.id,
      business_type: businessTypeForTemplate(record.template_type),
      stage: record.template_type === 'recruitment_followup' ? 'initial_effective_followup' : '',
      customer_name: '',
      company_name: '',
      status_label: '待核对',
      suggested_tag: '待核对',
      followup_markdown: summary.followupMarkdown,
      fields_json: summary.structuredJson,
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

  store.update('audio_records', record.id, {
    status: 'transcribing',
    error_message: 'DashScope 真实转写适配层已预留，下一阶段接入 R2 临时链接和轮询。',
  });
}

function businessTypeForTemplate(templateType) {
  if (templateType === 'matchmaker_profile') return 'matchmaker';
  if (templateType === 'recruitment_followup') return 'recruitment';
  if (templateType === 'customer_follow_up') return 'general_customer';
  return 'general';
}

function createExportFile(record, employee, body, store, config) {
  const target = body.target || 'full_record';
  const format = body.format || 'md';
  if (!['md', 'txt', 'docx', 'pdf'].includes(format)) throw httpError(400, '暂不支持该导出格式');
  if (['docx', 'pdf'].includes(format)) {
    throw httpError(400, 'DOCX/PDF 导出接口已预留，当前先支持 Markdown 和 TXT');
  }

  const summary = store.table('summaries').find((item) => item.audio_record_id === record.id);
  const transcript = store.table('transcripts').find((item) => item.audio_record_id === record.id);
  const followup = store.table('followup_forms').find((item) => item.audio_record_id === record.id);
  const text = [
    `# ${record.title}`,
    '',
    `员工：${store.findById('employees', record.owner_employee_id)?.display_name || ''}`,
    `创建时间：${record.created_at}`,
    `模板：${record.template_type}`,
    '',
    target !== 'transcript' ? '## 总结\n' + (summary?.summary_markdown || '暂无总结') : '',
    target !== 'summary' ? '## 逐字稿\n' + (transcript?.corrected_text || transcript?.raw_text || '暂无逐字稿') : '',
    target !== 'summary' && target !== 'transcript' ? '## 跟单\n' + (followup?.followup_markdown || '暂无跟单') : '',
  ].filter(Boolean).join('\n\n');

  fs.mkdirSync(config.exportDir, { recursive: true });
  const fileName = `${record.id}-${target}.${format}`;
  fs.writeFileSync(path.join(config.exportDir, fileName), format === 'txt' ? stripMarkdown(text) : text);
  return store.insert('export_files', {
    audio_record_id: record.id,
    export_type: target,
    format,
    r2_key: fileName,
    created_by: employee.id,
  });
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
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,DELETE,OPTIONS');
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

function stripMarkdown(markdown) {
  return markdown
    .replace(/^#+\s*/gm, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/^- /gm, '· ');
}

module.exports = {
  createVoiceServer,
};
