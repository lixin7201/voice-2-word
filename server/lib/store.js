const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { createInitialData } = require('./seed');

class JsonStore {
  constructor(filePath) {
    this.filePath = filePath;
    this.data = null;
  }

  load() {
    if (!fs.existsSync(this.filePath)) {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
      this.data = createInitialData();
      migrateData(this.data);
      this.save();
      return this.data;
    }
    this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
    if (migrateData(this.data)) this.save();
    return this.data;
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2));
  }

  table(name) {
    if (!this.data) this.load();
    if (!Array.isArray(this.data[name])) this.data[name] = [];
    return this.data[name];
  }

  insert(tableName, row) {
    const now = new Date().toISOString();
    const record = {
      id: row.id || crypto.randomUUID(),
      created_at: row.created_at || now,
      updated_at: row.updated_at || now,
      ...row,
    };
    this.table(tableName).push(record);
    this.save();
    return record;
  }

  update(tableName, id, updates) {
    const table = this.table(tableName);
    const index = table.findIndex((row) => row.id === id);
    if (index === -1) return null;
    table[index] = {
      ...table[index],
      ...updates,
      updated_at: new Date().toISOString(),
    };
    this.save();
    return table[index];
  }

  delete(tableName, id) {
    const table = this.table(tableName);
    const index = table.findIndex((row) => row.id === id);
    if (index === -1) return false;
    table.splice(index, 1);
    this.save();
    return true;
  }

  findById(tableName, id) {
    return this.table(tableName).find((row) => row.id === id) || null;
  }
}

function migrateData(data) {
  let changed = false;
  const ensureTable = (name) => {
    if (!Array.isArray(data[name])) {
      data[name] = [];
      changed = true;
    }
    return data[name];
  };

  ensureTable('departments');
  const employees = ensureTable('employees');
  ensureTable('employee_departments');
  const records = ensureTable('audio_records');
  ensureTable('transcripts');
  ensureTable('summaries');
  ensureTable('followup_forms');
  ensureTable('record_notes');
  ensureTable('record_processing_events');
  ensureTable('export_files');
  ensureTable('system_settings');
  ensureTable('audit_logs');
  ensureTable('ztools_daily_digest_queue');
  const systemMeta = ensureTable('system_meta');

  if (!systemMeta.length) {
    systemMeta.push({
      id: 'system-meta',
      schema_version: 2,
      settings_version: 1,
      settings_updated_at: '',
      settings_updated_by: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    });
    changed = true;
  } else {
    const meta = systemMeta[0];
    changed = assignDefault(meta, 'schema_version', 2) || changed;
    changed = assignDefault(meta, 'settings_version', 1) || changed;
    changed = assignDefault(meta, 'settings_updated_at', '') || changed;
    changed = assignDefault(meta, 'settings_updated_by', null) || changed;
  }

  for (const employee of employees) {
    changed = assignDefault(employee, 'avatar_url', '') || changed;
    changed = assignDefault(employee, 'avatar_r2_key', '') || changed;
    changed = assignDefault(employee, 'avatar_color', avatarColorFor(employee.id || employee.display_name || employee.login_name)) || changed;
    changed = assignDefault(employee, 'bio', '') || changed;
    changed = assignDefault(employee, 'ai_profile_note', '') || changed;
    changed = assignDefault(employee, 'profile_updated_at', '') || changed;
  }

  for (const record of records) {
    const inferredSource = inferTitleSource(record);
    changed = assignDefault(record, 'title_source', inferredSource) || changed;
    changed = assignDefault(record, 'title_locked', inferredSource === 'manual') || changed;
    changed = assignDefault(record, 'ai_title', '') || changed;
    changed = assignDefault(record, 'title_updated_at', record.updated_at || record.created_at || '') || changed;
    changed = assignDefault(record, 'followup_type', inferFollowupType(record)) || changed;
    changed = assignDefault(record, 'processing_started_at', '') || changed;
    changed = assignDefault(record, 'transcribe_started_at', '') || changed;
    changed = assignDefault(record, 'summarize_started_at', '') || changed;
    changed = assignDefault(record, 'last_progress_at', '') || changed;
    changed = assignDefault(record, 'asr_task_id', '') || changed;
    changed = assignDefault(record, 'processing_attempts', 0) || changed;
    changed = assignDefault(record, 'archived_at', '') || changed;
    changed = assignDefault(record, 'archived_by', '') || changed;
    changed = assignDefault(record, 'deleted_at', '') || changed;
    changed = assignDefault(record, 'deleted_by', '') || changed;
  }

  return changed;
}

function inferFollowupType(record) {
  if (record.followup_type) return record.followup_type;
  if (record.template_type === 'matchmaker_profile') return 'matchmaker';
  if (record.template_type === 'recruitment_followup') return 'recruitment';
  if (record.template_type === 'customer_follow_up') return 'general_customer';
  return 'none';
}

function assignDefault(row, key, value) {
  if (row[key] !== undefined) return false;
  row[key] = value;
  return true;
}

function inferTitleSource(record) {
  if (record.title_source) return record.title_source;
  const title = String(record.title || '').trim();
  const original = String(record.original_file_name || '').trim();
  if (!title || title === original || looksLikeHashFileName(title)) return 'filename';
  if (record.source_page_title && title === record.source_page_title) return 'page';
  return 'manual';
}

function looksLikeHashFileName(value) {
  const base = path.basename(String(value || '')).replace(/\.[a-z0-9]{2,5}$/i, '');
  if (base.length < 24) return false;
  if (/[\u4e00-\u9fa5\s]/.test(base)) return false;
  return /^[a-z0-9_-]+$/i.test(base) && /[a-f0-9]{24,}/i.test(base);
}

function avatarColorFor(seed) {
  const colors = ['#2e7bbd', '#1b9a8a', '#7a5af8', '#c47f1a', '#25855a', '#b0446b'];
  const text = String(seed || '');
  let total = 0;
  for (const char of text) total += char.charCodeAt(0);
  return colors[total % colors.length];
}

module.exports = {
  JsonStore,
};
