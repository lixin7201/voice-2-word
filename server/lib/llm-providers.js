const SUPPORTED_PROTOCOLS = new Set([
  'openai-responses',
  'openai-chat',
  'anthropic-messages',
  'gemini-native',
]);

const GENERATION_PROTOCOLS = new Set([
  'openai-responses',
  'openai-chat',
]);

const DEFAULT_LLM_PROVIDER_TEMPLATES = [
  {
    id: 'llm_easyai_gpt55',
    display_name: 'EasyAI GPT-5.5',
    provider_key: 'easyai',
    channel_id: 'easyai',
    protocol: 'openai-responses',
    base_url: 'https://aisoeasy.cc/v1',
    endpoint_path: '/responses',
    api_key: '',
    request_model: 'gpt-5.5',
    priority: 10,
    enabled: false,
    allow_fallback: true,
    timeout_ms: 120000,
    reasoning_effort: 'high',
    supports_json: true,
    supports_files: false,
  },
  {
    id: 'llm_sub2api_gpt55',
    display_name: 'AI 大宜宾 sub2api - GPT-5.5',
    provider_key: 'sub2api',
    channel_id: 'sub2api',
    protocol: 'openai-responses',
    base_url: 'http://127.0.0.1:8080/v1',
    endpoint_path: '/responses',
    api_key: '',
    request_model: 'gpt-5.5',
    priority: 20,
    enabled: false,
    allow_fallback: true,
    timeout_ms: 120000,
    reasoning_effort: 'high',
    supports_json: true,
    supports_files: false,
  },
  {
    id: 'llm_kimi_k26',
    display_name: 'Kimi K2.6',
    provider_key: 'kimi',
    channel_id: 'kimi',
    protocol: 'openai-chat',
    base_url: 'https://api.kimi.com/coding/v1',
    endpoint_path: '/chat/completions',
    api_key: '',
    request_model: 'kimi-k2.6',
    priority: 30,
    enabled: false,
    allow_fallback: true,
    timeout_ms: 120000,
    reasoning_effort: '',
    supports_json: true,
    supports_files: false,
  },
];

function defaultLlmProviderRows(now = new Date().toISOString()) {
  return DEFAULT_LLM_PROVIDER_TEMPLATES.map((provider) => ({
    ...provider,
    last_test_status: '',
    last_test_message: '',
    last_test_at: '',
    last_call_status: '',
    last_call_message: '',
    last_call_at: '',
    created_by: null,
    updated_by: null,
    created_at: now,
    updated_at: now,
  }));
}

function ensureDefaultLlmProviderTemplates(store) {
  const rows = store.table('llm_providers');
  const existingIds = new Set(rows.map((row) => row.id));
  for (const provider of defaultLlmProviderRows()) {
    if (!existingIds.has(provider.id)) store.insert('llm_providers', provider);
  }
}

function resolveLlmProviders(config, store) {
  const storedProviders = store
    ? store.table('llm_providers').map(providerForCall).filter(isCallableProvider)
    : [];
  if (storedProviders.length) return storedProviders.sort(compareProviderPriority);
  return legacyProviders(config);
}

function hasConfiguredLlmProvider(config, store) {
  return resolveLlmProviders(config, store).length > 0;
}

function providerForCall(row) {
  return {
    id: row.id,
    displayName: row.display_name || row.displayName || row.provider_key || row.providerKey || '',
    providerKey: row.provider_key || row.providerKey || '',
    channelId: row.channel_id || row.channelId || row.provider_key || row.providerKey || '',
    protocol: row.protocol || '',
    baseUrl: row.base_url || row.baseUrl || '',
    endpointPath: row.endpoint_path || row.endpointPath || '',
    apiKey: row.api_key || row.apiKey || '',
    requestModel: row.request_model || row.requestModel || row.model || '',
    priority: Number(row.priority || 100),
    enabled: row.enabled !== false && row.enabled !== 'false' && row.enabled !== 0 && row.enabled !== '0',
    allowFallback: row.allow_fallback !== false && row.allowFallback !== false && row.allow_fallback !== 'false',
    timeoutMs: Number(row.timeout_ms || row.timeoutMs || 120000),
    reasoningEffort: row.reasoning_effort || row.reasoningEffort || '',
  };
}

function serializeLlmProvider(row) {
  const configured = Boolean(row.api_key || row.apiKey);
  return {
    id: row.id,
    displayName: row.display_name || '',
    providerKey: row.provider_key || '',
    channelId: row.channel_id || '',
    protocol: row.protocol || '',
    baseUrl: row.base_url || '',
    endpointPath: row.endpoint_path || '',
    requestModel: row.request_model || '',
    priority: Number(row.priority || 100),
    enabled: row.enabled !== false,
    allowFallback: row.allow_fallback !== false,
    timeoutMs: Number(row.timeout_ms || 120000),
    reasoningEffort: row.reasoning_effort || '',
    supportsJson: row.supports_json !== false,
    supportsFiles: Boolean(row.supports_files),
    configured,
    maskedApiKey: configured ? maskSecret(row.api_key || row.apiKey) : '',
    lastTestStatus: row.last_test_status || '',
    lastTestMessage: row.last_test_message || '',
    lastTestAt: row.last_test_at || '',
    lastCallStatus: row.last_call_status || '',
    lastCallMessage: row.last_call_message || '',
    lastCallAt: row.last_call_at || '',
    createdBy: row.created_by || '',
    updatedBy: row.updated_by || '',
    createdAt: row.created_at || '',
    updatedAt: row.updated_at || '',
  };
}

function serializeLlmProviderPreset(row) {
  const serialized = serializeLlmProvider(row);
  return {
    ...serialized,
    id: row.id,
    configured: false,
    maskedApiKey: '',
  };
}

function isCallableProvider(provider) {
  return Boolean(
    provider.enabled &&
    provider.baseUrl &&
    provider.apiKey &&
    provider.requestModel &&
    SUPPORTED_PROTOCOLS.has(provider.protocol)
  );
}

function compareProviderPriority(left, right) {
  return Number(left.priority || 100) - Number(right.priority || 100) ||
    String(left.displayName || '').localeCompare(String(right.displayName || ''));
}

function legacyProviders(config) {
  const providers = [];
  if (config.easyAiBaseUrl && config.easyAiApiKey && config.easyAiModel) {
    const model = config.easyAiModel || 'gpt-5.5';
    const responses = String(model).toLowerCase().startsWith('gpt-5.5');
    providers.push({
      id: 'legacy_easyai',
      displayName: 'EasyAI GPT-5.5',
      providerKey: 'easyai',
      channelId: 'easyai',
      protocol: responses ? 'openai-responses' : 'openai-chat',
      baseUrl: responses ? ensureOpenAiV1BaseUrl(config.easyAiBaseUrl) : config.easyAiBaseUrl,
      endpointPath: responses ? '/responses' : '/chat/completions',
      apiKey: config.easyAiApiKey,
      requestModel: model,
      priority: 10,
      enabled: true,
      allowFallback: true,
      timeoutMs: 120000,
      reasoningEffort: responses ? 'high' : '',
    });
  }
  if (config.sub2apiBaseUrl && config.sub2apiApiKey && config.sub2apiModel) {
    providers.push({
      id: 'legacy_sub2api',
      displayName: 'AI 大宜宾 sub2api - GPT-5.5',
      providerKey: 'sub2api',
      channelId: 'sub2api',
      protocol: 'openai-responses',
      baseUrl: config.sub2apiBaseUrl,
      endpointPath: '/responses',
      apiKey: config.sub2apiApiKey,
      requestModel: config.sub2apiModel || 'gpt-5.5',
      priority: 20,
      enabled: true,
      allowFallback: true,
      timeoutMs: 120000,
      reasoningEffort: 'high',
    });
  }
  if (config.kimiBaseUrl && config.kimiApiKey && config.kimiModel) {
    providers.push({
      id: 'legacy_kimi',
      displayName: 'Kimi K2.6',
      providerKey: 'kimi',
      channelId: 'kimi',
      protocol: 'openai-chat',
      baseUrl: config.kimiBaseUrl,
      endpointPath: '/chat/completions',
      apiKey: config.kimiApiKey,
      requestModel: config.kimiModel || 'kimi-k2.6',
      priority: 30,
      enabled: true,
      allowFallback: true,
      timeoutMs: 120000,
      reasoningEffort: '',
    });
  }
  return providers;
}

function ensureOpenAiV1BaseUrl(baseUrl) {
  const clean = String(baseUrl || '').replace(/\/+$/, '');
  return clean.endsWith('/v1') ? clean : `${clean}/v1`;
}

function maskSecret(value) {
  if (!value) return '';
  const text = String(value);
  if (text.length <= 8) return '已保存';
  return `${text.slice(0, 3)}...${text.slice(-4)}`;
}

module.exports = {
  DEFAULT_LLM_PROVIDER_TEMPLATES,
  GENERATION_PROTOCOLS,
  SUPPORTED_PROTOCOLS,
  defaultLlmProviderRows,
  ensureDefaultLlmProviderTemplates,
  hasConfiguredLlmProvider,
  providerForCall,
  resolveLlmProviders,
  serializeLlmProvider,
  serializeLlmProviderPreset,
};
