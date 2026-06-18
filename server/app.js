const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { JsonStore } = require('./lib/store');
const { hashPassword, signToken, verifyPassword, verifyToken } = require('./lib/auth');
const {
  FOLLOWUP_OPTIONS,
  TEMPLATE_OPTIONS,
  buildLocalSummary,
  defaultFollowupForEmployee,
  defaultTemplateForEmployee,
  normalizeFollowupType,
  shouldGenerateFollowup,
} = require('./lib/templates');
const { normalizeMindMap } = require('./lib/mind-map');
const { deleteR2Objects, isR2Configured, presignR2Url, putR2Object } = require('./lib/r2');
const { isDashScopeConfigured, fetchDashScopeTranscription, resolveDashScopeBaseUrl, submitDashScopeTask, waitForDashScopeTask } = require('./lib/dashscope');
const { generateSummary } = require('./lib/llm');
const {
  buildExportBundle,
  buildExportSvg,
  buildExportText,
  createDocxBuffer,
  createPdfBuffer,
  createSummaryDocxBuffer,
  createSummaryPdfBuffer,
  stripMarkdown,
} = require('./lib/exporters');
const { resolveRuntimeConfig, saveSystemSettings, serializeSystemSettings } = require('./lib/system-settings');

const DEFAULT_DATA_FILE = path.join(process.cwd(), 'data', 'dev-db.json');
const DEFAULT_UPLOAD_DIR = path.join(process.cwd(), 'uploads');
const DEFAULT_EXPORT_DIR = path.join(process.cwd(), 'exports');
const MAX_AUDIO_FILE_BYTES = 2 * 1024 * 1024 * 1024;
const MAX_AUDIO_SECONDS = 12 * 60 * 60;
const SUPPORTED_EXTENSIONS = new Set(['mp3', 'm4a', 'wav', 'aac', 'flac', 'ogg', 'opus', 'mp4', 'mov', 'webm']);
const SUPPORTED_AVATAR_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'webp']);
const WEB_ASSETS = new Map([
  ['/', { file: 'webapp.html', contentType: 'text/html; charset=utf-8' }],
  ['/app', { file: 'webapp.html', contentType: 'text/html; charset=utf-8' }],
  ['/webapp.html', { file: 'webapp.html', contentType: 'text/html; charset=utf-8' }],
  ['/webapp.css', { file: 'webapp.css', contentType: 'text/css; charset=utf-8' }],
  ['/sidepanel.css', { file: 'sidepanel.css', contentType: 'text/css; charset=utf-8' }],
  ['/sidepanel.js', { file: 'sidepanel.js', contentType: 'text/javascript; charset=utf-8' }],
]);

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
  if (options.recoverProcessing !== false) {
    void recoverInterruptedRecords(store, config);
  }

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

  if (['GET', 'HEAD'].includes(req.method) && serveWebAsset(pathname, req.method, res)) {
    return;
  }

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

  if (req.method === 'GET' && pathname === '/api/runtime') {
    const settingsMeta = store.table('system_meta')[0] || {};
    sendJson(res, 200, {
      service: 'voice-2-word',
      version: '0.1.0',
      settingsVersion: Number(settingsMeta.settings_version || 1),
      publicBaseUrl: runtimeConfig.publicBaseUrl,
      features: {
        profile: true,
        autoTitle: true,
        settingsCenter: true,
      },
    });
    return;
  }

  const avatarMatch = pathname.match(/^\/uploads\/avatars\/([^/]+)$/);
  if (avatarMatch && req.method === 'GET') {
    serveLocalAvatar(avatarMatch[1], config, res);
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
      followupOptions: FOLLOWUP_OPTIONS,
      defaultTemplate: defaultTemplateForEmployee(auth.employee, employeeDepartments(auth.employee.id, store)),
      defaultFollowupType: defaultFollowupForEmployee(auth.employee, employeeDepartments(auth.employee.id, store)),
    });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/me/profile') {
    sendJson(res, 200, {
      employee: serializeEmployee(auth.employee, store),
      permissions: permissionsFor(auth.employee),
    });
    return;
  }

  if (req.method === 'PATCH' && pathname === '/api/me/profile') {
    const body = await readJson(req);
    const updated = updateOwnProfile(auth.employee, body, store);
    addAudit(store, auth.employee.id, 'update_profile', 'employee', auth.employee.id);
    sendJson(res, 200, { employee: serializeEmployee(updated, store) });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/me/avatar') {
    const upload = await readMultipart(req);
    const file = upload.files.avatar || upload.files.file;
    if (!file) throw httpError(400, '请上传头像文件');
    const avatar = await saveAvatar(file, auth.employee, store, runtimeConfig);
    addAudit(store, auth.employee.id, 'update_avatar', 'employee', auth.employee.id);
    sendJson(res, 200, { avatarUrl: avatar.avatar_url, employee: serializeEmployee(avatar, store) });
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
    const titleMeta = normalizeInitialTitle(body, body.sourceType);
    const record = store.insert('audio_records', {
      owner_employee_id: auth.employee.id,
      owner_department_id: ownerDepartment?.id || null,
      title: titleMeta.title,
      title_source: titleMeta.titleSource,
      title_locked: titleMeta.titleLocked,
      ai_title: '',
      title_updated_at: new Date().toISOString(),
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
      processing_started_at: '',
      transcribe_started_at: '',
      summarize_started_at: '',
      last_progress_at: '',
      asr_task_id: '',
      processing_attempts: 0,
      completed_at: null,
      error_message: '',
      archived_at: '',
      archived_by: '',
      deleted_at: '',
      deleted_by: '',
      followup_type: normalizeFollowupType(body.followupType || defaultFollowupForEmployee(auth.employee, employeeDepartments(auth.employee.id, store)), body.templateType),
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

  if (recordIdMatch && req.method === 'PATCH') {
    const record = requireRecord(recordIdMatch[1], store);
    ensureCanEditRecord(auth.employee, record, store);
    const body = await readJson(req);
    const title = normalizeRecordTitle(body.title);
    const updated = store.update('audio_records', record.id, {
      title,
      title_source: 'manual',
      title_locked: true,
      title_updated_at: new Date().toISOString(),
    });
    addAudit(store, auth.employee.id, 'rename_record', 'audio_record', record.id, { title });
    sendJson(res, 200, { record: serializeRecord(updated, store) });
    return;
  }

  if (recordIdMatch && req.method === 'DELETE') {
    const record = requireRecord(recordIdMatch[1], store);
    const mode = url.searchParams.get('mode') || 'archive';
    const result = await deleteRecordWithMode(record, mode, auth.employee, store, runtimeConfig);
    sendJson(res, 200, result);
    return;
  }

  if (req.method === 'POST' && pathname === '/api/records/bulk-delete') {
    const body = await readJson(req);
    const mode = body.mode || 'archive';
    const ids = Array.isArray(body.ids) ? body.ids.slice(0, 100) : [];
    if (!ids.length) throw httpError(400, '请选择要删除的记录');
    const results = [];
    for (const id of ids) {
      const record = requireRecord(id, store);
      results.push(await deleteRecordWithMode(record, mode, auth.employee, store, runtimeConfig));
    }
    sendJson(res, 200, { results });
    return;
  }

  const audioMatch = pathname.match(/^\/api\/records\/([^/]+)\/audio$/);
  if (audioMatch && ['GET', 'HEAD'].includes(req.method)) {
    const record = requireRecord(audioMatch[1], store);
    ensureCanViewRecord(auth.employee, record, store);
    serveRecordAudio(req, res, record, runtimeConfig);
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
    if (file.buffer.length > MAX_AUDIO_FILE_BYTES) {
      throw httpError(413, '单个录音最大支持 2GB，请先切分后再上传。');
    }
    const candidateMeta = parseJsonObject(upload.fields.candidateMeta);
    const durationSeconds = Number(upload.fields.durationSeconds || candidateMeta.durationSeconds || 0);
    if (Number.isFinite(durationSeconds) && durationSeconds > MAX_AUDIO_SECONDS) {
      throw httpError(400, '单个录音最长支持 12 小时，请先切分后再上传。');
    }
    fs.mkdirSync(config.uploadDir, { recursive: true });
    const storedName = `${record.id}.${ext}`;
    const storedPath = path.join(config.uploadDir, storedName);
    fs.writeFileSync(storedPath, file.buffer);
    const uploadTitleUpdates = {};
    if (!record.title_locked && (!record.title || record.title_source === 'filename')) {
      uploadTitleUpdates.title = file.filename || storedName;
      uploadTitleUpdates.title_source = 'filename';
      uploadTitleUpdates.title_updated_at = new Date().toISOString();
    }
    const uploaded = store.update('audio_records', record.id, {
      ...uploadTitleUpdates,
      original_file_name: file.filename || storedName,
      mime_type: file.contentType || '',
      file_size: file.buffer.length,
      duration_seconds: Number.isFinite(durationSeconds) && durationSeconds > 0 ? Math.round(durationSeconds) : record.duration_seconds,
      status: 'uploaded',
      error_message: '',
      processing_started_at: record.processing_started_at || new Date().toISOString(),
      last_progress_at: new Date().toISOString(),
      source_media_url_hash: upload.fields.candidateUrl ? sha256(upload.fields.candidateUrl) : record.source_media_url_hash,
    });
    addProcessingEvent(store, record.id, 'uploaded', '录音已上传，后台准备处理。', {
      fileName: file.filename || storedName,
      fileSize: file.buffer.length,
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
      followup_type: normalizeFollowupType(body.followupType ?? record.followup_type, body.templateType || record.template_type),
      status: 'summarizing',
      summarize_started_at: new Date().toISOString(),
      last_progress_at: new Date().toISOString(),
      error_message: '',
    });
    addProcessingEvent(store, record.id, 'summarizing', '正在重新生成总结。');
    startSummarizeJob(updated, store, runtimeConfig);
    sendJson(res, 200, { record: serializeRecord(store.findById('audio_records', record.id), store) });
    return;
  }

  const transcribeMatch = pathname.match(/^\/api\/records\/([^/]+)\/transcribe$/);
  if (transcribeMatch && req.method === 'POST') {
    const record = requireRecord(transcribeMatch[1], store);
    ensureCanViewRecord(auth.employee, record, store);
    addProcessingEvent(store, record.id, 'uploaded', '已重新触发转写。');
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
      business_type: body.businessType || businessTypeForFollowup(record.followup_type, record.template_type),
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

  const transcriptSpeakersMatch = pathname.match(/^\/api\/records\/([^/]+)\/transcript-speakers$/);
  if (transcriptSpeakersMatch && req.method === 'PATCH') {
    const record = requireRecord(transcriptSpeakersMatch[1], store);
    ensureCanEditRecord(auth.employee, record, store);
    const transcript = store.table('transcripts').find((item) => item.audio_record_id === record.id);
    if (!transcript) throw httpError(404, '逐字稿不存在');
    const body = await readJson(req);
    const previousAliases = transcript.speaker_aliases_json || {};
    const aliases = normalizeSpeakerAliases(body, transcript.speaker_aliases_json || {});
    const updated = store.update('transcripts', transcript.id, {
      speaker_aliases_json: aliases,
      updated_at: new Date().toISOString(),
    });
    const syncResult = syncSpeakerAliasesIntoGeneratedContent(store, record.id, previousAliases, aliases);
    addAudit(store, auth.employee.id, 'edit_transcript_speakers', 'audio_record', record.id, {
      speakers: Object.keys(updated.speaker_aliases_json || {}),
      syncedSections: syncResult.updatedSections,
    });
    sendJson(res, 200, { transcript: updated, record: serializeRecord(record, store) });
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

  if (pathname === '/api/admin/settings/test' && req.method === 'POST') {
    ensureCanManageSettings(auth.employee);
    const body = await readJson(req);
    const result = await testSystemSettings(resolveRuntimeConfig(config, store), body.target || 'all');
    addAudit(store, auth.employee.id, 'test_system_settings', 'system_settings', String(body.target || 'all'), { ok: result.ok });
    sendJson(res, 200, result);
    return;
  }

  if (pathname === '/api/admin/audit-logs' && req.method === 'GET') {
    ensureCanManageEmployees(auth.employee);
    sendJson(res, 200, {
      auditLogs: store.table('audit_logs')
        .slice()
        .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
        .slice(0, 300)
        .map((log) => serializeAuditLog(log, store)),
    });
    return;
  }

  if (pathname === '/api/admin/storage-usage' && req.method === 'GET') {
    ensureCanManageSettings(auth.employee);
    sendJson(res, 200, storageUsage(store, runtimeConfig));
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
  const url = new URL(req.url, 'http://localhost');
  const token = header.startsWith('Bearer ') ? header.slice(7) : (url.searchParams.get('access_token') || '');
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
    avatarUrl: employee.avatar_url || '',
    avatarColor: employee.avatar_color || '#2e7bbd',
    bio: employee.bio || '',
    aiProfileNote: employee.ai_profile_note || '',
    profileUpdatedAt: employee.profile_updated_at || '',
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
    titleSource: record.title_source || 'filename',
    titleLocked: Boolean(record.title_locked),
    aiTitle: record.ai_title || '',
    titleUpdatedAt: record.title_updated_at || '',
    owner: owner ? { id: owner.id, displayName: owner.display_name } : null,
    department: department ? { id: department.id, name: department.name } : null,
    sourceType: record.source_type,
    sourcePageUrl: record.source_page_url,
    sourcePageTitle: record.source_page_title,
    originalFileName: record.original_file_name,
    audioUrl: record.original_file_name ? `/api/records/${record.id}/audio` : '',
    mimeType: record.mime_type,
    fileSize: record.file_size,
    durationSeconds: record.duration_seconds,
    r2Key: record.r2_key || '',
    status: record.status,
    followupType: normalizeFollowupType(record.followup_type, record.template_type),
    processingStartedAt: record.processing_started_at || '',
    transcribeStartedAt: record.transcribe_started_at || '',
    summarizeStartedAt: record.summarize_started_at || '',
    lastProgressAt: record.last_progress_at || '',
    asrTaskId: record.asr_task_id || '',
    processingAttempts: Number(record.processing_attempts || 0),
    templateType: record.template_type,
    createdAt: record.created_at,
    updatedAt: record.updated_at,
    completedAt: record.completed_at,
    errorMessage: record.error_message,
    archivedAt: record.archived_at || '',
    archivedBy: record.archived_by || '',
    noteCount: store.table('record_notes').filter((note) => note.audio_record_id === record.id).length,
  };
  if (options.compact) return base;
  const summary = store.table('summaries').find((item) => item.audio_record_id === record.id) || null;
  const serializedSummary = summary
    ? { ...summary, mind_map_json: normalizeMindMap(summary.mind_map_json, record.title) || {} }
    : null;
  return {
    ...base,
    transcript: store.table('transcripts').find((item) => item.audio_record_id === record.id) || null,
    summary: serializedSummary,
    processingEvents: processingEventsForRecord(record.id, store),
    exportFiles: store.table('export_files')
      .filter((file) => file.audio_record_id === record.id)
      .sort((left, right) => String(right.created_at).localeCompare(String(left.created_at)))
      .slice(0, 5),
    followupForm: normalizeFollowupType(record.followup_type, record.template_type) === 'none'
      ? null
      : store.table('followup_forms').find((item) => item.audio_record_id === record.id) || null,
    notes: store.table('record_notes')
      .filter((note) => note.audio_record_id === record.id)
      .map((note) => ({
        ...note,
        employee: store.findById('employees', note.employee_id)?.display_name || '未知员工',
      })),
  };
}

function processingEventsForRecord(recordId, store) {
  return store.table('record_processing_events')
    .filter((event) => event.audio_record_id === recordId)
    .sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)))
    .slice(-8)
    .map((event) => ({
      id: event.id,
      phase: event.phase || '',
      message: event.message || '',
      metadata: event.metadata_json || {},
      createdAt: event.created_at || '',
    }));
}

function normalizeSpeakerAliases(body, existing = {}) {
  const next = { ...(existing && typeof existing === 'object' ? existing : {}) };
  const applyAlias = (speaker, alias) => {
    const key = String(speaker || '').trim().slice(0, 80);
    if (!key) throw httpError(400, '请选择要修改的说话人');
    const value = String(alias || '').trim().slice(0, 40);
    if (value) next[key] = value;
    else delete next[key];
  };

  if (body && typeof body.aliases === 'object' && !Array.isArray(body.aliases)) {
    Object.entries(body.aliases).slice(0, 80).forEach(([speaker, alias]) => applyAlias(speaker, alias));
  } else {
    applyAlias(body?.speaker, body?.alias);
  }

  return Object.fromEntries(
    Object.entries(next)
      .map(([speaker, alias]) => [String(speaker || '').trim().slice(0, 80), String(alias || '').trim().slice(0, 40)])
      .filter(([speaker, alias]) => speaker && alias)
      .slice(0, 80),
  );
}

function syncSpeakerAliasesIntoGeneratedContent(store, recordId, previousAliases, nextAliases) {
  const replacements = buildSpeakerAliasReplacements(previousAliases, nextAliases);
  if (!replacements.length) return { updatedSections: [] };
  const replacer = createLiteralReplacer(replacements);
  const updatedSections = [];

  const summary = store.table('summaries').find((item) => item.audio_record_id === recordId);
  if (summary) {
    const updates = replaceRowFields(summary, ['summary_markdown', 'structured_json', 'overview_card_json', 'mind_map_json'], replacer);
    if (updates.mind_map_json) {
      const record = store.findById('audio_records', recordId);
      updates.mind_map_json = normalizeMindMap(updates.mind_map_json, record?.title || '') || {};
    }
    if (Object.keys(updates).length) {
      store.update('summaries', summary.id, updates);
      updatedSections.push('summary');
    }
  }

  const followup = store.table('followup_forms').find((item) => item.audio_record_id === recordId);
  if (followup) {
    const updates = replaceRowFields(followup, ['followup_markdown', 'fields_json'], replacer);
    if (Object.keys(updates).length) {
      store.update('followup_forms', followup.id, updates);
      updatedSections.push('followup');
    }
  }

  return { updatedSections };
}

function buildSpeakerAliasReplacements(previousAliases = {}, nextAliases = {}) {
  const previous = normalizeAliasMap(previousAliases);
  const next = normalizeAliasMap(nextAliases);
  const speakers = new Set([...Object.keys(previous), ...Object.keys(next)]);
  const replacements = new Map();

  for (const speaker of speakers) {
    const oldLabel = previous[speaker] || '';
    const nextLabel = next[speaker] || '';
    if (!nextLabel || nextLabel === speaker) continue;
    if (oldLabel && oldLabel !== nextLabel) replacements.set(oldLabel, nextLabel);
    replacements.set(speaker, nextLabel);
  }

  return [...replacements.entries()]
    .filter(([source, target]) => source && target && source !== target)
    .sort((left, right) => right[0].length - left[0].length);
}

function normalizeAliasMap(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .map(([speaker, alias]) => [String(speaker || '').trim(), String(alias || '').trim()])
      .filter(([speaker, alias]) => speaker && alias),
  );
}

function createLiteralReplacer(replacements) {
  const lookup = new Map(replacements);
  const pattern = new RegExp(replacements.map(([source]) => escapeRegExp(source)).join('|'), 'g');
  return (text) => {
    let changed = false;
    const replaced = String(text).replace(pattern, (match) => {
      changed = true;
      return lookup.get(match) || match;
    });
    return changed ? compactCjkSpacing(replaced) : String(text);
  };
}

function replaceRowFields(row, fields, replacer) {
  const updates = {};
  for (const field of fields) {
    const current = row[field];
    const replaced = replaceGeneratedValue(current, replacer);
    if (JSON.stringify(current) !== JSON.stringify(replaced)) updates[field] = replaced;
  }
  return updates;
}

function replaceGeneratedValue(value, replacer) {
  if (typeof value === 'string') return replacer(value);
  if (Array.isArray(value)) return value.map((item) => replaceGeneratedValue(item, replacer));
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, nested]) => [replacer(key), replaceGeneratedValue(nested, replacer)]),
    );
  }
  return value;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function compactCjkSpacing(value) {
  return String(value).replace(/([\u3400-\u9fff])\s+([\u3400-\u9fff])/g, '$1$2');
}

function addProcessingEvent(store, recordId, phase, message, metadata = {}) {
  if (!recordId || !phase || !message) return null;
  return store.insert('record_processing_events', {
    audio_record_id: recordId,
    phase,
    message,
    metadata_json: metadata,
  });
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
  if (record.archived_at && params.get('includeArchived') !== '1') return false;
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
      last_progress_at: new Date().toISOString(),
    });
    addProcessingEvent(store, record.id, 'failed', error.message || '处理失败，请检查配置后重试。');
  });
}

async function recoverInterruptedRecords(store, config) {
  const runtimeConfig = resolveRuntimeConfig(config, store);
  const records = store.table('audio_records').filter((record) =>
    ['uploaded', 'transcribing', 'summarizing'].includes(record.status)
  );
  for (const record of records) {
    addProcessingEvent(store, record.id, record.status, '服务已重启，正在恢复处理任务。');
    await recoverInterruptedRecord(record, store, runtimeConfig).catch((error) => {
      store.update('audio_records', record.id, {
        status: 'failed',
        error_message: error.message || String(error),
        last_progress_at: new Date().toISOString(),
      });
      addProcessingEvent(store, record.id, 'failed', error.message || '恢复处理失败，请重新触发转写。');
    });
  }
}

async function recoverInterruptedRecord(record, store, config) {
  const current = store.findById('audio_records', record.id) || record;
  const transcript = store.table('transcripts').find((item) => item.audio_record_id === current.id);
  if (current.status === 'summarizing' && (transcript?.corrected_text || transcript?.raw_text)) {
    addProcessingEvent(store, current.id, 'summarizing', '已找到逐字稿，继续生成总结。');
    await summarizeExistingRecord(current, store, config);
    return;
  }
  if (current.status === 'transcribing' && current.asr_task_id && config.dashscopeApiKey) {
    addProcessingEvent(store, current.id, 'transcribing', '继续查询已提交的转写任务。');
    await waitAndSummarizeDashScopeRecord(current, store, config, resolveDashScopeBaseUrl(config), current.asr_task_id);
    return;
  }
  await processUploadedRecord(current, store, config);
}

async function processUploadedRecord(record, store, config) {
  let current = store.findById('audio_records', record.id) || record;
  const startedAt = new Date().toISOString();
  current = store.update('audio_records', record.id, {
    status: 'uploaded',
    processing_started_at: current.processing_started_at || startedAt,
    last_progress_at: startedAt,
    processing_attempts: Number(current.processing_attempts || 0) + 1,
    error_message: '',
  }) || current;
  addProcessingEvent(store, record.id, 'uploaded', '开始处理录音文件。');

  const localPath = path.join(config.uploadDir, `${record.id}.${safeExtension(record.original_file_name || '')}`);
  let audioUrl = '';
  let storageKey = record.r2_key;
  if (isR2Configured(config)) {
    storageKey = storageKey || `audio/${new Date().toISOString().slice(0, 10)}/${record.id}/${record.original_file_name || `${record.id}.mp3`}`;
    const buffer = fs.existsSync(localPath) ? fs.readFileSync(localPath) : Buffer.alloc(0);
    addProcessingEvent(store, record.id, 'uploaded', '正在上传录音到 R2 存储。', { storageKey });
    await putR2Object(config, storageKey, buffer, record.mime_type || 'application/octet-stream');
    current = store.update('audio_records', record.id, {
      r2_key: storageKey,
      status: 'uploaded',
      last_progress_at: new Date().toISOString(),
    }) || current;
    audioUrl = presignR2Url(config, { method: 'GET', key: storageKey, expiresIn: 7200 });
    addProcessingEvent(store, record.id, 'uploaded', 'R2 音频已上传，公网临时链接已生成。', { storageKey });
  } else {
    storageKey = storageKey || path.basename(localPath);
    current = store.update('audio_records', record.id, {
      r2_key: storageKey,
      last_progress_at: new Date().toISOString(),
    }) || current;
  }
  addProcessingEvent(store, record.id, 'uploaded', '录音文件已准备好。');

  if (config.devFakeAsr) {
    const transcriptText = `本地开发模式已接收文件：${record.original_file_name || record.title}`;
    current = store.update('audio_records', record.id, {
      status: 'summarizing',
      summarize_started_at: new Date().toISOString(),
      last_progress_at: new Date().toISOString(),
    }) || current;
    addProcessingEvent(store, record.id, 'summarizing', '演示模式已生成逐字稿，正在生成总结。');
    const summary = buildLocalSummary(current, transcriptText);
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
      mind_map_json: normalizeMindMap(summary.mindMap, current.title || record.title) || {},
      structured_json: summary.structuredJson,
      model_provider: summary.modelProvider || 'local-dev',
      model_name: summary.modelName || 'local-template',
      model_error: summary.modelError || '',
      version: 1,
    });
    if (shouldGenerateFollowup(current)) {
      upsertFollowupFromSummary(store, current, summary);
    } else {
      deleteFollowupForRecord(store, record.id);
    }
    applyAiTitleSuggestion(current, summary.titleSuggestion, store);
    store.update('audio_records', record.id, {
      status: 'completed',
      completed_at: new Date().toISOString(),
      last_progress_at: new Date().toISOString(),
      error_message: '',
    });
    addProcessingEvent(store, record.id, 'completed', '录音处理完成。');
    return;
  }

  if (!config.dashscopeApiKey) {
    store.update('audio_records', record.id, {
      status: 'failed',
      error_message: '后端尚未配置 DASHSCOPE_API_KEY，已保存录音文件，等待接入真实转写。',
      last_progress_at: new Date().toISOString(),
    });
    addProcessingEvent(store, record.id, 'failed', '后端尚未配置 DashScope API Key，已保存录音文件。');
    return;
  }

  if (!isR2Configured(config)) {
    store.update('audio_records', record.id, {
      status: 'failed',
      error_message: '真实 DashScope 转写需要先配置 Cloudflare R2，以便生成公网临时音频链接。',
      last_progress_at: new Date().toISOString(),
    });
    addProcessingEvent(store, record.id, 'failed', '真实转写需要先配置 Cloudflare R2。');
    return;
  }

  const submitted = await submitDashScopeTask(config, audioUrl);
  current = store.update('audio_records', record.id, {
    status: 'transcribing',
    asr_task_id: submitted.taskId,
    transcribe_started_at: new Date().toISOString(),
    last_progress_at: new Date().toISOString(),
    error_message: '',
  }) || current;
  addProcessingEvent(store, record.id, 'transcribing', '转写任务已提交。', { taskId: submitted.taskId });
  await waitAndSummarizeDashScopeRecord(current, store, config, submitted.baseUrl, submitted.taskId);
}

async function waitAndSummarizeDashScopeRecord(record, store, config, baseUrl, taskId) {
  const queried = await waitForDashScopeTask(config, baseUrl, taskId);
  const transcription = await fetchDashScopeTranscription(queried);
  upsertByAudioRecord(store, 'transcripts', record.id, {
    audio_record_id: record.id,
    asr_provider: 'dashscope',
    asr_task_id: taskId,
    raw_text: transcription.rawText,
    corrected_text: transcription.correctedText,
    segments_json: transcription.segments,
    speaker_aliases_json: {},
    duration_ms: transcription.durationMs,
    cost_cny: null,
  });
  const current = store.update('audio_records', record.id, {
    status: 'summarizing',
    duration_seconds: transcription.durationMs ? Math.round(transcription.durationMs / 1000) : record.duration_seconds,
    summarize_started_at: new Date().toISOString(),
    last_progress_at: new Date().toISOString(),
  });
  addProcessingEvent(store, record.id, 'summarizing', '逐字稿已生成，正在生成总结。');
  await summarizeExistingRecord(current, store, config);
}

async function summarizeExistingRecord(record, store, config) {
  const transcript = store.table('transcripts').find((item) => item.audio_record_id === record.id);
  const transcriptText = transcript?.corrected_text || transcript?.raw_text || '';
  const owner = store.findById('employees', record.owner_employee_id);
  const profileContext = buildEmployeeProfileContext(owner, store);
  const summary = await generateSummary(config, record, transcriptText, { profileContext });
  upsertByAudioRecord(store, 'summaries', record.id, {
    audio_record_id: record.id,
    template_type: record.template_type,
    summary_markdown: summary.summaryMarkdown,
    overview_card_json: summary.overviewCard,
    mind_map_json: normalizeMindMap(summary.mindMap, record.title) || {},
    structured_json: summary.structuredJson,
    model_provider: summary.modelProvider || 'local-template',
    model_name: summary.modelName || 'local-template',
    model_error: summary.modelError || '',
    version: 1,
  });
  if (shouldGenerateFollowup(record)) {
    upsertFollowupFromSummary(store, record, summary);
  } else {
    deleteFollowupForRecord(store, record.id);
  }
  applyAiTitleSuggestion(record, summary.titleSuggestion, store);
  store.update('audio_records', record.id, {
    status: 'completed',
    completed_at: new Date().toISOString(),
    last_progress_at: new Date().toISOString(),
    error_message: '',
  });
  addProcessingEvent(store, record.id, 'completed', '总结已生成。');
}

function startSummarizeJob(record, store, config) {
  summarizeExistingRecord(record, store, config).catch((error) => {
    store.update('audio_records', record.id, {
      status: 'failed',
      error_message: error.message || String(error),
      last_progress_at: new Date().toISOString(),
    });
    addProcessingEvent(store, record.id, 'failed', error.message || '总结生成失败，请稍后重试。');
  });
}

function upsertFollowupFromSummary(store, record, summary) {
  return upsertByAudioRecord(store, 'followup_forms', record.id, {
    audio_record_id: record.id,
    business_type: businessTypeForFollowup(record.followup_type, record.template_type),
    stage: summary.followupStage || '',
    customer_name: summary.customerName || '',
    company_name: summary.companyName || '',
    status_label: summary.statusLabel || '待核对',
    suggested_tag: summary.suggestedTag || '待核对',
    followup_markdown: summary.followupMarkdown || '',
    fields_json: summary.followupFields || summary.structuredJson || {},
    manual_edited: false,
  });
}

function businessTypeForFollowup(followupType, templateType) {
  const normalized = normalizeFollowupType(followupType, templateType);
  if (normalized === 'matchmaker') return 'matchmaker';
  if (normalized === 'recruitment') return 'recruitment';
  if (normalized === 'general_customer') return 'general_customer';
  return 'general';
}

async function createExportFile(record, employee, body, store, config) {
  const target = body.target || 'full_record';
  const format = body.format || 'md';
  if (!['summary', 'transcript', 'full_record', 'overview_card', 'mind_map', 'all_files'].includes(target)) throw httpError(400, '暂不支持该导出内容');
  if (!['md', 'txt', 'docx', 'pdf', 'svg', 'zip'].includes(format)) throw httpError(400, '暂不支持该导出格式');
  if (target === 'all_files' && format !== 'zip') throw httpError(400, '全部文件仅支持 ZIP 下载');
  if (format === 'zip' && target !== 'all_files') throw httpError(400, 'ZIP 仅用于下载全部文件');
  if (format === 'svg' && !['overview_card', 'mind_map'].includes(target)) throw httpError(400, '只有总结卡片和思维导图支持 SVG 下载');
  const markdown = buildExportText(record, store, target, true);
  let buffer;
  if (format === 'zip') {
    buffer = buildExportBundle(record, store);
  } else {
    if (format === 'md') buffer = Buffer.from(markdown);
    if (format === 'txt') buffer = Buffer.from(stripMarkdown(markdown));
    if (format === 'docx') buffer = target === 'summary'
      ? createSummaryDocxBuffer(record, store, markdown)
      : createDocxBuffer(record.title, stripMarkdown(markdown));
    if (format === 'pdf') buffer = target === 'summary'
      ? createSummaryPdfBuffer(record, store, markdown)
      : createPdfBuffer(record.title, markdown);
    if (format === 'svg') buffer = Buffer.from(buildExportSvg(record, store, target));
  }

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

function deleteFollowupForRecord(store, audioRecordId) {
  const existing = store.table('followup_forms').find((item) => item.audio_record_id === audioRecordId);
  if (existing) store.delete('followup_forms', existing.id);
}

async function deleteRecordWithMode(record, mode, employee, store, config) {
  if (mode === 'purge') return purgeRecord(record, employee, store, config);
  if (mode && mode !== 'archive') throw httpError(400, '删除模式仅支持 archive 或 purge');
  ensureCanArchiveRecord(employee, record);
  const now = new Date().toISOString();
  const archived = store.update('audio_records', record.id, {
    archived_at: now,
    archived_by: employee.id,
    last_progress_at: now,
  });
  addAudit(store, employee.id, 'archive_record', 'audio_record', record.id, {
    title: record.title,
  });
  return { mode: 'archive', record: serializeRecord(archived, store) };
}

async function purgeRecord(record, employee, store, config) {
  ensureCanPurgeRecords(employee);
  const exportFiles = store.table('export_files').filter((file) => file.audio_record_id === record.id);
  const r2Keys = [
    record.r2_key,
    ...exportFiles.filter((file) => file.storage === 'r2').map((file) => file.r2_key),
  ].filter(Boolean);

  if (isR2Configured(config) && r2Keys.length) {
    await deleteR2Objects(config, r2Keys);
  }

  const localFiles = deleteLocalRecordFiles(record, exportFiles, config);
  for (const tableName of ['transcripts', 'summaries', 'followup_forms', 'record_notes', 'record_processing_events', 'export_files']) {
    deleteRowsForAudioRecord(store, tableName, record.id);
  }
  store.delete('audio_records', record.id);
  addAudit(store, employee.id, 'purge_record', 'audio_record', record.id, {
    title: record.title,
    localFilesDeleted: localFiles.deleted,
    r2KeysDeleted: isR2Configured(config) ? r2Keys : [],
  });
  return {
    mode: 'purge',
    id: record.id,
    deleted: true,
    localFilesDeleted: localFiles.deleted,
    r2ObjectsDeleted: isR2Configured(config) ? r2Keys.length : 0,
  };
}

function ensureCanArchiveRecord(employee, record) {
  if (record.owner_employee_id === employee.id || ['admin', 'boss'].includes(employee.global_role)) return;
  throw httpError(403, '只能归档自己的录音');
}

function ensureCanPurgeRecords(employee) {
  if (['admin', 'boss'].includes(employee.global_role)) return;
  throw httpError(403, '只有管理员可以彻底删除录音');
}

function deleteRowsForAudioRecord(store, tableName, audioRecordId) {
  const table = store.table(tableName);
  let changed = false;
  for (let index = table.length - 1; index >= 0; index -= 1) {
    if (table[index].audio_record_id === audioRecordId) {
      table.splice(index, 1);
      changed = true;
    }
  }
  if (changed) store.save();
}

function deleteLocalRecordFiles(record, exportFiles, config) {
  const candidates = new Set();
  const ext = safeExtension(record.original_file_name || record.r2_key || '');
  if (ext) candidates.add(path.join(config.uploadDir, `${record.id}.${ext}`));
  if (record.r2_key) candidates.add(path.join(config.uploadDir, path.basename(record.r2_key)));
  for (const file of exportFiles) {
    if (file.storage !== 'r2' && file.r2_key) candidates.add(path.join(config.exportDir, path.basename(file.r2_key)));
  }
  if (fs.existsSync(config.exportDir)) {
    for (const fileName of fs.readdirSync(config.exportDir)) {
      if (fileName.startsWith(`${record.id}-`)) candidates.add(path.join(config.exportDir, fileName));
    }
  }

  const deleted = [];
  for (const filePath of candidates) {
    if (!filePath || !fs.existsSync(filePath)) continue;
    fs.unlinkSync(filePath);
    deleted.push(filePath);
  }
  return { deleted };
}

function storageUsage(store, config) {
  return {
    records: store.table('audio_records').length,
    archivedRecords: store.table('audio_records').filter((record) => record.archived_at).length,
    exportFiles: store.table('export_files').length,
    localUploadsBytes: directorySize(config.uploadDir),
    localExportsBytes: directorySize(config.exportDir),
    r2ObjectCount: store.table('audio_records').filter((record) => record.r2_key).length +
      store.table('export_files').filter((file) => file.r2_key).length,
  };
}

function directorySize(dirPath) {
  if (!fs.existsSync(dirPath)) return 0;
  let total = 0;
  for (const name of fs.readdirSync(dirPath)) {
    const filePath = path.join(dirPath, name);
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) total += directorySize(filePath);
    else total += stat.size;
  }
  return total;
}

function contentTypeForExport(format) {
  if (format === 'md') return 'text/markdown; charset=utf-8';
  if (format === 'txt') return 'text/plain; charset=utf-8';
  if (format === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
  if (format === 'pdf') return 'application/pdf';
  if (format === 'svg') return 'image/svg+xml; charset=utf-8';
  if (format === 'zip') return 'application/zip';
  return 'application/octet-stream';
}

function normalizeInitialTitle(body, sourceType) {
  const title = String(body.title || '').trim();
  const requestedSource = ['filename', 'manual', 'ai', 'page'].includes(body.titleSource) ? body.titleSource : '';
  if (title) {
    const titleSource = requestedSource || 'manual';
    return {
      title: normalizeRecordTitle(title),
      titleSource,
      titleLocked: titleSource === 'manual',
    };
  }
  return {
    title: defaultRecordTitle(sourceType),
    titleSource: 'filename',
    titleLocked: false,
  };
}

function normalizeRecordTitle(value) {
  const title = String(value || '').replace(/\s+/g, ' ').trim();
  if (!title) throw httpError(400, '标题不能为空');
  if (title.length > 60) throw httpError(400, '标题最多 60 字');
  return title;
}

function updateOwnProfile(employee, body, store) {
  const updates = { profile_updated_at: new Date().toISOString() };
  if (body.displayName !== undefined) {
    const displayName = String(body.displayName || '').trim();
    if (!displayName) throw httpError(400, '花名不能为空');
    if (displayName.length > 24) throw httpError(400, '花名最多 24 字');
    updates.display_name = displayName;
  }
  if (body.bio !== undefined) updates.bio = limitText(body.bio, 80, '一句话自我介绍最多 80 字');
  if (body.aiProfileNote !== undefined) updates.ai_profile_note = limitText(body.aiProfileNote, 500, 'AI 生成偏好最多 500 字');
  if (body.avatarColor !== undefined) updates.avatar_color = normalizeAvatarColor(body.avatarColor);
  return store.update('employees', employee.id, updates);
}

async function saveAvatar(file, employee, store, config) {
  const ext = safeExtension(file.filename || '');
  if (!SUPPORTED_AVATAR_EXTENSIONS.has(ext)) throw httpError(400, '头像仅支持 png/jpg/jpeg/webp');
  if (file.buffer.length > 2 * 1024 * 1024) throw httpError(400, '头像不能超过 2MB');
  const contentType = file.contentType || contentTypeForAvatar(ext);
  const timestamp = Date.now();

  if (isR2Configured(config)) {
    const key = `avatars/${employee.id}/${timestamp}.${ext}`;
    await putR2Object(config, key, file.buffer, contentType);
    return store.update('employees', employee.id, {
      avatar_url: presignR2Url(config, { method: 'GET', key, expiresIn: 60 * 60 * 24 * 7 }),
      avatar_r2_key: key,
      profile_updated_at: new Date().toISOString(),
    });
  }

  const avatarDir = path.join(config.uploadDir, 'avatars');
  fs.mkdirSync(avatarDir, { recursive: true });
  const fileName = `${employee.id}-${timestamp}.${ext}`;
  fs.writeFileSync(path.join(avatarDir, fileName), file.buffer);
  return store.update('employees', employee.id, {
    avatar_url: `${config.publicBaseUrl.replace(/\/$/, '')}/uploads/avatars/${encodeURIComponent(fileName)}`,
    avatar_r2_key: '',
    profile_updated_at: new Date().toISOString(),
  });
}

function applyAiTitleSuggestion(record, rawSuggestion, store) {
  const titleSuggestion = sanitizeTitleSuggestion(rawSuggestion);
  if (!titleSuggestion) return null;
  const current = store.findById('audio_records', record.id) || record;
  const updates = {
    ai_title: titleSuggestion,
    title_updated_at: new Date().toISOString(),
  };
  if (current.title_locked !== true) {
    updates.title = titleSuggestion;
    updates.title_source = 'ai';
  }
  return store.update('audio_records', current.id, updates);
}

function sanitizeTitleSuggestion(value) {
  const title = String(value || '')
    .replace(/[`"'“”‘’]/g, '')
    .replace(/\.(mp3|m4a|wav|aac|flac|ogg|opus|mp4|mov|webm)$/i, '')
    .replace(/\s+/g, '')
    .trim();
  if (title.length < 2 || title.length > 30) return '';
  if (/^[a-f0-9_-]{24,}$/i.test(title)) return '';
  return title;
}

function buildEmployeeProfileContext(employee, store) {
  if (!employee) return '';
  const departments = employeeDepartments(employee.id, store).map((department) => department.name).join(' / ') || '未分配部门';
  const lines = [
    '录音所属员工：',
    `- 花名：${employee.display_name}`,
    `- 部门：${departments}`,
  ];
  if (employee.bio) lines.push(`- 一句话介绍：${employee.bio}`);
  if (employee.ai_profile_note) lines.push(`- AI 生成偏好：${employee.ai_profile_note}`);
  return lines.join('\n');
}

function limitText(value, maxLength, message) {
  const text = String(value || '').trim();
  if (text.length > maxLength) throw httpError(400, message);
  return text;
}

function normalizeAvatarColor(value) {
  const color = String(value || '').trim();
  if (!/^#[0-9a-f]{6}$/i.test(color)) throw httpError(400, '头像颜色格式不正确');
  return color.toLowerCase();
}

function contentTypeForAvatar(ext) {
  if (ext === 'jpg' || ext === 'jpeg') return 'image/jpeg';
  if (ext === 'webp') return 'image/webp';
  return 'image/png';
}

function serveLocalAvatar(rawFileName, config, res) {
  const fileName = path.basename(decodeURIComponent(rawFileName || ''));
  const filePath = path.join(config.uploadDir, 'avatars', fileName);
  if (!fs.existsSync(filePath)) throw httpError(404, '头像不存在');
  res.writeHead(200, {
    'Content-Type': contentTypeForAvatar(safeExtension(fileName)),
    'Cache-Control': 'public, max-age=3600',
  });
  fs.createReadStream(filePath).pipe(res);
}

function serveRecordAudio(req, res, record, config) {
  const ext = safeExtension(record.original_file_name || record.r2_key || '');
  const localCandidates = [
    record.r2_key ? path.join(config.uploadDir, path.basename(record.r2_key)) : '',
    ext ? path.join(config.uploadDir, `${record.id}.${ext}`) : '',
  ].filter(Boolean);
  const localPath = localCandidates.find((candidate) => fs.existsSync(candidate));
  if (!localPath && isR2Configured(config) && record.r2_key) {
    res.writeHead(302, {
      Location: presignR2Url(config, { method: 'GET', key: record.r2_key, expiresIn: 900 }),
    });
    res.end();
    return;
  }
  if (!localPath) throw httpError(404, '录音文件不存在');

  const stat = fs.statSync(localPath);
  const contentType = playableAudioContentType(record.mime_type, ext);
  const range = req.headers.range;
  if (!range) {
    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Length': stat.size,
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'private, max-age=300',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    fs.createReadStream(localPath).pipe(res);
    return;
  }

  const match = String(range).match(/bytes=(\d*)-(\d*)/);
  const start = match?.[1] ? Number(match[1]) : 0;
  const end = match?.[2] ? Number(match[2]) : stat.size - 1;
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || end >= stat.size) {
    res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
    res.end();
    return;
  }
  res.writeHead(206, {
    'Content-Type': contentType,
    'Content-Length': end - start + 1,
    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'private, max-age=300',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(localPath, { start, end }).pipe(res);
}

function contentTypeForAudio(ext) {
  if (ext === 'mp3') return 'audio/mpeg';
  if (ext === 'm4a') return 'audio/mp4';
  if (ext === 'aac') return 'audio/aac';
  if (ext === 'flac') return 'audio/flac';
  if (ext === 'wav') return 'audio/wav';
  if (ext === 'ogg' || ext === 'opus') return 'audio/ogg';
  if (ext === 'webm') return 'audio/webm';
  if (ext === 'mp4') return 'video/mp4';
  if (ext === 'mov') return 'video/quicktime';
  return 'application/octet-stream';
}

function playableAudioContentType(mimeType, ext) {
  const normalized = String(mimeType || '').split(';')[0].trim().toLowerCase();
  if (!normalized || ['binary/octet-stream', 'application/octet-stream'].includes(normalized)) {
    return contentTypeForAudio(ext);
  }
  return mimeType;
}

async function testSystemSettings(config, target) {
  const targets = target === 'all' ? ['publicBaseUrl', 'dashscope', 'r2', 'easyai', 'kimi'] : [target];
  const checks = targets.map((item) => checkSystemSettingTarget(config, item));
  const ok = checks.every((item) => item.ok);
  return {
    ok,
    target,
    message: ok ? '配置检查通过' : '部分配置缺失或格式不正确',
    details: checks,
  };
}

function checkSystemSettingTarget(config, target) {
  if (target === 'publicBaseUrl') {
    try {
      new URL(config.publicBaseUrl);
      return { target, ok: true, message: '后端公开地址格式正确' };
    } catch {
      return { target, ok: false, message: '后端公开地址格式不正确' };
    }
  }
  if (target === 'dashscope') {
    return requiredSettingCheck(target, config, ['dashscopeApiKey', 'dashscopeModel']);
  }
  if (target === 'r2') {
    return requiredSettingCheck(target, config, ['r2AccountId', 'r2AccessKeyId', 'r2SecretAccessKey', 'r2Bucket']);
  }
  if (target === 'easyai') {
    return requiredSettingCheck(target, config, ['easyAiBaseUrl', 'easyAiApiKey', 'easyAiModel']);
  }
  if (target === 'kimi') {
    return requiredSettingCheck(target, config, ['kimiBaseUrl', 'kimiApiKey', 'kimiModel']);
  }
  return { target, ok: false, message: '未知测试目标' };
}

function requiredSettingCheck(target, config, keys) {
  const missing = keys.filter((key) => !config[key]);
  return {
    target,
    ok: missing.length === 0,
    message: missing.length ? `缺少配置：${missing.join(', ')}` : '必要配置已填写',
  };
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
    avatar_url: '',
    avatar_r2_key: '',
    avatar_color: avatarColorFor(displayName),
    bio: '',
    ai_profile_note: '',
    profile_updated_at: '',
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

function serializeAuditLog(log, store) {
  const actor = log.actor_employee_id ? store.findById('employees', log.actor_employee_id) : null;
  return {
    id: log.id,
    createdAt: log.created_at,
    actorEmployeeId: log.actor_employee_id || '',
    actorName: actor?.display_name || actor?.login_name || '',
    action: log.action || '',
    targetType: log.target_type || '',
    targetId: log.target_id || '',
  };
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

function parseJsonObject(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
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
        filename: path.basename(decodeMultipartHeaderValue(filename)),
        contentType: contentTypeMatch?.[1] || '',
        buffer: Buffer.from(rawContent, 'latin1'),
      };
    } else {
      fields[name] = Buffer.from(rawContent, 'latin1').toString('utf8');
    }
  }
  return { fields, files };
}

function decodeMultipartHeaderValue(value) {
  try {
    return Buffer.from(String(value || ''), 'latin1').toString('utf8');
  } catch {
    return String(value || '');
  }
}

function sendJson(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(payload));
}

function serveWebAsset(pathname, method, res) {
  const asset = WEB_ASSETS.get(pathname);
  if (!asset) return false;
  const filePath = path.join(process.cwd(), asset.file);
  if (!fs.existsSync(filePath)) throw httpError(404, '页面文件不存在');
  res.writeHead(200, {
    'Content-Type': asset.contentType,
    'Cache-Control': 'no-store',
  });
  if (method === 'HEAD') {
    res.end();
    return true;
  }
  fs.createReadStream(filePath).pipe(res);
  return true;
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

function avatarColorFor(seed) {
  const colors = ['#2e7bbd', '#1b9a8a', '#7a5af8', '#c47f1a', '#25855a', '#b0446b'];
  let total = 0;
  for (const char of String(seed || '')) total += char.charCodeAt(0);
  return colors[total % colors.length];
}

module.exports = {
  createVoiceServer,
};
