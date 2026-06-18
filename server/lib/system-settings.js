const { hasConfiguredLlmProvider } = require('./llm-providers');

const DEFAULT_PUBLIC_BASE_URL = 'http://lixindemac-studio.local:8127';

const SETTING_GROUPS = [
  {
    id: 'service',
    title: '服务开关',
    description: '控制后端对员工插件暴露的地址和真实转写模式。',
    fields: [
      {
        key: 'publicBaseUrl',
        label: '后端公开地址',
        type: 'url',
        defaultValue: DEFAULT_PUBLIC_BASE_URL,
        help: '员工插件和导出下载使用这个地址，一般保持默认即可。',
      },
      {
        key: 'devFakeAsr',
        label: '本地演示模式',
        type: 'select',
        defaultValue: '0',
        options: [
          { value: '0', label: '关闭，使用真实转写' },
          { value: '1', label: '开启，跳过真实转写' },
        ],
        help: '演示模式不会调用 DashScope 和模型，只生成模板内容。',
      },
    ],
  },
  {
    id: 'asr',
    title: '录音转文字',
    description: 'DashScope Fun-ASR 负责把录音转成文字。',
    fields: [
      { key: 'dashscopeApiKey', label: 'DashScope API Key', type: 'password', secret: true },
      { key: 'dashscopeBaseUrl', label: 'DashScope 地址', type: 'url', defaultValue: 'https://dashscope.aliyuncs.com/api/v1' },
      { key: 'dashscopeModel', label: 'DashScope 模型', type: 'text', defaultValue: 'fun-asr' },
      { key: 'dashscopeVocabularyId', label: '热词表 ID', type: 'text', help: '没有热词表时留空。' },
      { key: 'dashscopePollIntervalMs', label: '查询间隔毫秒', type: 'number', defaultValue: '5000' },
      { key: 'dashscopeTimeoutMs', label: '最长等待毫秒', type: 'number', defaultValue: '46800000' },
    ],
  },
  {
    id: 'storage',
    title: '录音存储',
    description: 'Cloudflare R2 用来生成 DashScope 可以访问的临时音频链接。',
    fields: [
      { key: 'r2AccountId', label: 'R2 Account ID', type: 'text' },
      { key: 'r2AccessKeyId', label: 'R2 Access Key ID', type: 'password', secret: true },
      { key: 'r2SecretAccessKey', label: 'R2 Secret Access Key', type: 'password', secret: true },
      { key: 'r2Bucket', label: 'R2 Bucket', type: 'text' },
      { key: 'r2Endpoint', label: 'R2 Endpoint', type: 'url', help: '可留空，系统会按 Account ID 自动生成。' },
    ],
  },
  {
    id: 'llm',
    title: '旧版总结模型兜底',
    description: '模型池未启用可用模型时，才使用这些旧字段兜底；新模型请在“总结模型池”里配置。',
    fields: [
      { key: 'easyAiBaseUrl', label: 'EasyAI 地址', type: 'url', defaultValue: 'https://aisoeasy.cc/v1' },
      { key: 'easyAiApiKey', label: 'EasyAI API Key', type: 'password', secret: true },
      { key: 'easyAiModel', label: 'EasyAI 模型', type: 'text', defaultValue: 'gpt-5.5' },
      { key: 'kimiBaseUrl', label: 'Kimi 地址', type: 'url', defaultValue: 'https://api.kimi.com/coding/v1' },
      { key: 'kimiApiKey', label: 'Kimi API Key', type: 'password', secret: true },
      { key: 'kimiModel', label: 'Kimi 模型', type: 'text', defaultValue: 'kimi-k2.6' },
    ],
  },
];

const ENV_BY_KEY = {
  publicBaseUrl: 'PUBLIC_BASE_URL',
  devFakeAsr: 'VOICE_TO_WORD_DEV_FAKE_ASR',
  dashscopeApiKey: 'DASHSCOPE_API_KEY',
  dashscopeBaseUrl: 'DASHSCOPE_BASE_URL',
  dashscopeModel: 'DASHSCOPE_MODEL',
  dashscopeVocabularyId: 'DASHSCOPE_VOCABULARY_ID',
  dashscopePollIntervalMs: 'DASHSCOPE_POLL_INTERVAL_MS',
  dashscopeTimeoutMs: 'DASHSCOPE_TIMEOUT_MS',
  r2AccountId: 'CLOUDFLARE_R2_ACCOUNT_ID',
  r2AccessKeyId: 'CLOUDFLARE_R2_ACCESS_KEY_ID',
  r2SecretAccessKey: 'CLOUDFLARE_R2_SECRET_ACCESS_KEY',
  r2Bucket: 'CLOUDFLARE_R2_BUCKET',
  r2Endpoint: 'CLOUDFLARE_R2_ENDPOINT',
  easyAiBaseUrl: 'EASYAI_BASE_URL',
  easyAiApiKey: 'EASYAI_API_KEY',
  easyAiModel: 'EASYAI_MODEL',
  kimiBaseUrl: 'KIMI_BASE_URL',
  kimiApiKey: 'KIMI_API_KEY',
  kimiModel: 'KIMI_MODEL',
};

const ALL_FIELDS = SETTING_GROUPS.flatMap((group) => group.fields);
const FIELD_BY_KEY = new Map(ALL_FIELDS.map((field) => [field.key, field]));
const SECRET_KEYS = new Set(ALL_FIELDS.filter((field) => field.secret).map((field) => field.key));

function resolveRuntimeConfig(baseConfig, store) {
  const settings = storedSettings(store);
  const resolved = { ...baseConfig };

  for (const field of ALL_FIELDS) {
    const value = firstMeaningfulValue(settings[field.key], baseConfig[field.key], process.env[ENV_BY_KEY[field.key]], field.defaultValue);
    if (value === undefined) continue;
    resolved[field.key] = field.key === 'devFakeAsr' ? toBoolean(value) : String(value);
  }

  return resolved;
}

function serializeSystemSettings(baseConfig, store) {
  const runtimeConfig = resolveRuntimeConfig(baseConfig, store);
  const meta = systemMeta(store);
  const updatedBy = meta.settings_updated_by
    ? store.findById('employees', meta.settings_updated_by)
    : null;
  return {
    groups: SETTING_GROUPS.map((group) => ({
      ...group,
      fields: group.fields.map((field) => serializeField(field, runtimeConfig[field.key])),
    })),
    meta: {
      settingsVersion: Number(meta.settings_version || 1),
      settingsUpdatedAt: meta.settings_updated_at || '',
      settingsUpdatedBy: updatedBy ? updatedBy.display_name : '',
    },
    status: {
      publicBaseUrl: runtimeConfig.publicBaseUrl,
      devFakeAsr: Boolean(runtimeConfig.devFakeAsr),
      r2Configured: Boolean(runtimeConfig.r2AccountId && runtimeConfig.r2AccessKeyId && runtimeConfig.r2SecretAccessKey && runtimeConfig.r2Bucket),
      dashscopeConfigured: Boolean(runtimeConfig.dashscopeApiKey),
      llmConfigured: hasConfiguredLlmProvider(runtimeConfig, store),
    },
  };
}

function saveSystemSettings(store, body, actorEmployeeId) {
  const settings = body.settings && typeof body.settings === 'object' ? body.settings : body;
  const clearKeys = new Set(Array.isArray(body.clearKeys) ? body.clearKeys : []);

  for (const [key, rawValue] of Object.entries(settings || {})) {
    const field = FIELD_BY_KEY.get(key);
    if (!field) continue;
    const value = String(rawValue ?? '').trim();
    if (SECRET_KEYS.has(key) && !value && !clearKeys.has(key)) continue;
    if (clearKeys.has(key)) {
      deleteStoredSetting(store, key);
    } else {
      upsertStoredSetting(store, key, value, actorEmployeeId, field.secret);
    }
  }
  bumpSettingsVersion(store, actorEmployeeId);
}

function serializeField(field, value) {
  const displayValue = field.key === 'devFakeAsr'
    ? (toBoolean(value) ? '1' : '0')
    : value;
  if (field.secret) {
    return {
      ...field,
      value: '',
      configured: Boolean(value),
      maskedValue: maskSecret(value),
    };
  }
  return {
    ...field,
    value: displayValue === undefined || displayValue === null ? '' : String(displayValue),
    configured: Boolean(displayValue),
  };
}

function storedSettings(store) {
  const rows = store.table('system_settings');
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

function systemMeta(store) {
  let meta = store.table('system_meta')[0];
  if (!meta) {
    meta = store.insert('system_meta', {
      id: 'system-meta',
      schema_version: 2,
      settings_version: 1,
      settings_updated_at: '',
      settings_updated_by: null,
    });
  }
  return meta;
}

function bumpSettingsVersion(store, actorEmployeeId) {
  const meta = systemMeta(store);
  store.update('system_meta', meta.id, {
    schema_version: 2,
    settings_version: Number(meta.settings_version || 1) + 1,
    settings_updated_at: new Date().toISOString(),
    settings_updated_by: actorEmployeeId || null,
  });
}

function upsertStoredSetting(store, key, value, actorEmployeeId, isSecret) {
  const existing = store.table('system_settings').find((row) => row.key === key);
  const row = {
    key,
    value,
    is_secret: Boolean(isSecret),
    updated_by: actorEmployeeId || null,
  };
  if (existing) return store.update('system_settings', existing.id, row);
  return store.insert('system_settings', row);
}

function deleteStoredSetting(store, key) {
  const existing = store.table('system_settings').find((row) => row.key === key);
  if (!existing) return false;
  return store.delete('system_settings', existing.id);
}

function firstMeaningfulValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && String(value) !== '') return value;
  }
  return undefined;
}

function toBoolean(value) {
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function maskSecret(value) {
  if (!value) return '';
  const text = String(value);
  if (text.length <= 8) return '已保存';
  return `${text.slice(0, 3)}...${text.slice(-4)}`;
}

module.exports = {
  SETTING_GROUPS,
  resolveRuntimeConfig,
  saveSystemSettings,
  serializeSystemSettings,
};
