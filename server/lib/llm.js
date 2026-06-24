const { buildLocalSummary, buildSummaryPrompt } = require('./templates');
const { resolveLlmProviders } = require('./llm-providers');

async function generateSummary(config, record, transcriptText, context = {}, fetchImpl = fetch) {
  if (typeof context === 'function') {
    fetchImpl = context;
    context = {};
  }
  const store = context.store || null;
  const providers = resolveLlmProviders(config, store);
  const providerErrors = [];

  for (const provider of providers) {
    try {
      const generated = await callSummaryProvider(provider, record, transcriptText, context, fetchImpl);
      updateProviderCallStatus(store, provider, 'success', '');
      return {
        ...generated,
        modelProvider: provider.channelId || provider.providerKey || provider.displayName,
        modelName: provider.requestModel,
        modelError: '',
      };
    } catch (error) {
      const message = safeProviderError(error, provider);
      providerErrors.push({
        provider: provider.displayName || provider.providerKey || provider.channelId || '',
        model: provider.requestModel || '',
        message,
      });
      updateProviderCallStatus(store, provider, 'failed', message);
      if (provider.allowFallback === false) break;
    }
  }

  return {
    ...buildLocalSummary(record, transcriptText),
    modelProvider: 'local-template',
    modelName: 'local-template',
    modelError: providerErrors.map((error) => `${error.provider}: ${error.message}`).join('；'),
    providerErrors,
  };
}

async function callSummaryProvider(provider, record, transcriptText, context, fetchImpl) {
  const content = await requestProviderText(provider, buildSummaryPrompt(record, transcriptText, context), fetchImpl, {
    responseFormatJson: true,
  });
  const parsed = parseJsonContent(content);
  if (!parsed.summaryMarkdown) {
    throw new Error('模型返回缺少 summaryMarkdown');
  }
  return {
    summaryMarkdown: parsed.summaryMarkdown,
    structuredJson: parsed.structuredJson || {},
    overviewCard: parsed.overviewCard || {},
    mindMap: parsed.mindMap || {},
    followupMarkdown: parsed.followupMarkdown || '',
    followupFields: parsed.followupFields || {},
    followupStage: parsed.followupStage || '',
    suggestedTag: parsed.suggestedTag || '',
    statusLabel: parsed.statusLabel || '',
    customerName: parsed.customerName || '',
    companyName: parsed.companyName || '',
    titleSuggestion: parsed.titleSuggestion || '',
  };
}

async function testLlmProviderConnection(provider, fetchImpl = fetch) {
  const startedAt = Date.now();
  const content = await requestProviderText(provider, [
    {
      role: 'system',
      content: '你是模型连通性测试助手，只需要简短回答。',
    },
    {
      role: 'user',
      content: '请回复“模型测试通过”。',
    },
  ], fetchImpl, { responseFormatJson: false });
  return {
    ok: true,
    message: '模型测试通过',
    latencyMs: Date.now() - startedAt,
    provider: provider.channelId || provider.providerKey || '',
    requestModel: provider.requestModel,
    sample: String(content || '').slice(0, 80),
  };
}

async function requestProviderText(provider, messages, fetchImpl, options = {}) {
  if (provider.protocol === 'openai-responses') return callOpenAiResponses(provider, messages, fetchImpl);
  if (provider.protocol === 'openai-chat') return callOpenAiChat(provider, messages, fetchImpl, options);
  throw new Error(`协议 ${provider.protocol || 'unknown'} 暂未接入总结链路`);
}

async function callOpenAiResponses(provider, messages, fetchImpl) {
  const instructions = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');
  const inputText = messages
    .filter((message) => message.role !== 'system')
    .map((message) => `${message.role || 'user'}:\n${message.content || ''}`)
    .join('\n\n');
  const body = {
    model: provider.requestModel,
    instructions,
    input: [{
      role: 'user',
      content: [{
        type: 'input_text',
        text: inputText,
      }],
    }],
  };
  if (provider.reasoningEffort) {
    body.reasoning = { effort: provider.reasoningEffort };
  }

  const json = await fetchProviderJson(provider, responsesUrl(provider.baseUrl, provider.endpointPath), {
    method: 'POST',
    headers: providerHeaders(provider),
    body: JSON.stringify(body),
  }, fetchImpl);
  const content = extractResponsesText(json);
  if (!content) throw new Error('模型返回为空');
  return content;
}

async function callOpenAiChat(provider, messages, fetchImpl, options = {}) {
  const payload = {
    model: provider.requestModel,
    temperature: chatTemperature(provider),
    messages,
  };
  if (options.responseFormatJson) payload.response_format = { type: 'json_object' };
  const json = await fetchProviderJson(provider, chatCompletionsUrl(provider.baseUrl, provider.endpointPath), {
    method: 'POST',
    headers: providerHeaders(provider),
    body: JSON.stringify(payload),
  }, fetchImpl);
  const content = json.choices?.[0]?.message?.content || '';
  if (!content) throw new Error('模型返回为空');
  return content;
}

function chatTemperature(provider) {
  if (/api\.kimi\.com/i.test(provider.baseUrl || '') && /^kimi-k/i.test(provider.requestModel || '')) {
    return 1;
  }
  return 0.2;
}

async function fetchProviderJson(provider, url, options, fetchImpl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), provider.timeoutMs || 120000);
  let response;
  try {
    response = await fetchImpl(url, {
      ...options,
      signal: controller.signal,
    });
  } catch (error) {
    if (error.name === 'AbortError') throw new Error('模型请求超时');
    throw error;
  } finally {
    clearTimeout(timeout);
  }
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.error) {
    throw new Error(json.error?.message || json.message || `模型请求失败：HTTP ${response.status}`);
  }
  return json;
}

function providerHeaders(provider) {
  const headers = {
    Authorization: `Bearer ${provider.apiKey}`,
    'Content-Type': 'application/json',
  };
  if (provider.protocol === 'openai-chat' && /api\.kimi\.com/i.test(provider.baseUrl || '')) {
    headers['User-Agent'] = 'KimiCLI/1.30.0';
  }
  return headers;
}

function responsesUrl(baseUrl, endpointPath = '/responses') {
  return appendEndpoint(baseUrl, endpointPath || '/responses', false);
}

function chatCompletionsUrl(baseUrl, endpointPath = '/chat/completions') {
  return appendEndpoint(baseUrl, endpointPath || '/chat/completions', true);
}

function appendEndpoint(baseUrl, endpointPath, ensureV1) {
  const clean = String(baseUrl || '').replace(/\/+$/, '');
  const path = String(endpointPath || '').startsWith('/') ? String(endpointPath || '') : `/${endpointPath || ''}`;
  if (clean.endsWith(path)) return clean;
  if (ensureV1 && !clean.endsWith('/v1') && path.startsWith('/chat/')) return `${clean}/v1${path}`;
  return `${clean}${path}`;
}

function extractResponsesText(json) {
  if (json.output_text) return json.output_text;
  const pieces = [];
  for (const output of json.output || []) {
    for (const content of output.content || []) {
      if (typeof content.text === 'string') pieces.push(content.text);
      if (typeof content.output_text === 'string') pieces.push(content.output_text);
    }
  }
  if (pieces.length) return pieces.join('\n');
  return json.choices?.[0]?.message?.content || '';
}

function parseJsonContent(content) {
  const trimmed = String(content || '').trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const match = trimmed.match(/\{[\s\S]*\}/);
    if (!match) return {};
    return JSON.parse(match[0]);
  }
}

function updateProviderCallStatus(store, provider, status, message) {
  if (!store || !provider.id || String(provider.id).startsWith('legacy_')) return;
  store.update('llm_providers', provider.id, {
    last_call_status: status,
    last_call_message: String(message || '').slice(0, 300),
    last_call_at: new Date().toISOString(),
  });
}

function safeProviderError(error, provider) {
  let message = String(error?.message || error || '模型请求失败');
  if (provider.apiKey) message = message.split(String(provider.apiKey)).join('[secret]');
  return message.replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/g, 'Bearer [secret]').slice(0, 300);
}

module.exports = {
  chatCompletionsUrl,
  generateSummary,
  parseJsonContent,
  responsesUrl,
  testLlmProviderConnection,
};
