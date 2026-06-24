const test = require('node:test');
const assert = require('node:assert/strict');
const { generateSummary, responsesUrl, chatCompletionsUrl } = require('./llm');

function createStore(providers) {
  return {
    providers,
    table(name) {
      return name === 'llm_providers' ? this.providers : [];
    },
    update(name, id, updates) {
      assert.equal(name, 'llm_providers');
      const provider = this.providers.find((item) => item.id === id);
      Object.assign(provider, updates);
      return provider;
    },
  };
}

function record() {
  return {
    id: 'rec-1',
    title: '模型池测试录音',
    original_file_name: 'test.mp3',
    template_type: 'meeting_minutes',
    followup_type: 'none',
  };
}

function summaryJson(title = '模型池总结') {
  return JSON.stringify({
    summaryMarkdown: `# ${title}`,
    overviewCard: { heroTitle: title, cards: [] },
    mindMap: { title, center: title, branches: [] },
    structuredJson: { title },
    titleSuggestion: title,
  });
}

function provider(overrides = {}) {
  return {
    id: overrides.id || 'llm_sub2api_gpt55',
    display_name: overrides.display_name || 'AI 大宜宾 sub2api - GPT-5.5',
    provider_key: overrides.provider_key || 'sub2api',
    channel_id: overrides.channel_id || 'sub2api',
    protocol: overrides.protocol || 'openai-responses',
    base_url: overrides.base_url || 'http://127.0.0.1:8080/v1',
    endpoint_path: overrides.endpoint_path || '/responses',
    api_key: overrides.api_key || 'secret-key',
    request_model: overrides.request_model || 'gpt-5.5',
    priority: overrides.priority || 10,
    enabled: overrides.enabled ?? true,
    allow_fallback: overrides.allow_fallback ?? true,
    timeout_ms: 120000,
    reasoning_effort: overrides.reasoning_effort || 'high',
  };
}

test('openai responses providers call /responses and parse output_text', async () => {
  const store = createStore([provider()]);
  const calls = [];
  const result = await generateSummary({}, record(), '逐字稿内容', { store }, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), headers: options.headers });
    return {
      ok: true,
      json: async () => ({ output_text: summaryJson('Responses 总结') }),
    };
  });

  assert.equal(calls[0].url, 'http://127.0.0.1:8080/v1/responses');
  assert.equal(calls[0].body.model, 'gpt-5.5');
  assert.equal(calls[0].body.reasoning.effort, 'high');
  assert.equal(calls[0].headers.Authorization, 'Bearer secret-key');
  assert.equal(result.modelProvider, 'sub2api');
  assert.equal(result.modelName, 'gpt-5.5');
  assert.match(result.summaryMarkdown, /Responses 总结/);
  assert.equal(store.providers[0].last_call_status, 'success');
});

test('openai responses providers parse output content text fallback', async () => {
  const store = createStore([provider()]);
  const result = await generateSummary({}, record(), '逐字稿内容', { store }, async () => ({
    ok: true,
    json: async () => ({
      output: [{
        content: [{ text: summaryJson('Content Text 总结') }],
      }],
    }),
  }));

  assert.match(result.summaryMarkdown, /Content Text 总结/);
});

test('openai chat providers still call /chat/completions', async () => {
  const store = createStore([provider({
    id: 'llm_kimi_k26',
    display_name: 'Kimi K2.6',
    provider_key: 'kimi',
    channel_id: 'kimi',
    protocol: 'openai-chat',
    base_url: 'https://api.kimi.com/coding/v1',
    endpoint_path: '/chat/completions',
    request_model: 'kimi-k2.6',
  })]);
  const calls = [];
  const result = await generateSummary({}, record(), '逐字稿内容', { store }, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body), headers: options.headers });
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: summaryJson('Kimi 总结') } }],
      }),
    };
  });

  assert.equal(calls[0].url, 'https://api.kimi.com/coding/v1/chat/completions');
  assert.equal(calls[0].body.model, 'kimi-k2.6');
  assert.equal(calls[0].body.temperature, 1);
  assert.equal(calls[0].headers['User-Agent'], 'KimiCLI/1.30.0');
  assert.equal(result.modelProvider, 'kimi');
});

test('failed provider falls back to the next priority provider', async () => {
  const store = createStore([
    provider({ id: 'llm_easyai_gpt55', display_name: 'EasyAI GPT-5.5', provider_key: 'easyai', channel_id: 'easyai', base_url: 'https://aisoeasy.cc/v1', priority: 10 }),
    provider({ id: 'llm_sub2api_gpt55', priority: 20 }),
  ]);
  const result = await generateSummary({}, record(), '逐字稿内容', { store }, async (url) => {
    if (url.includes('aisoeasy')) {
      return {
        ok: false,
        status: 401,
        json: async () => ({ error: { message: 'bad key secret-key' } }),
      };
    }
    return {
      ok: true,
      json: async () => ({ output_text: summaryJson('sub2api 兜底成功') }),
    };
  });

  assert.equal(result.modelProvider, 'sub2api');
  assert.match(result.summaryMarkdown, /sub2api 兜底成功/);
  assert.equal(store.providers[0].last_call_status, 'failed');
  assert.doesNotMatch(store.providers[0].last_call_message, /secret-key/);
  assert.equal(store.providers[1].last_call_status, 'success');
});

test('all failed providers return local template with structured provider errors', async () => {
  const store = createStore([
    provider({ id: 'llm_easyai_gpt55', display_name: 'EasyAI GPT-5.5', provider_key: 'easyai', channel_id: 'easyai', base_url: 'https://aisoeasy.cc/v1', priority: 10 }),
    provider({ id: 'llm_sub2api_gpt55', priority: 20 }),
  ]);
  const result = await generateSummary({}, record(), '逐字稿内容', { store }, async () => ({
    ok: false,
    status: 500,
    json: async () => ({ error: { message: '模型请求失败' } }),
  }));

  assert.equal(result.modelProvider, 'local-template');
  assert.equal(result.modelName, 'local-template');
  assert.match(result.summaryMarkdown, /模型池测试录音/);
  assert.deepEqual(result.providerErrors.map((error) => error.provider), ['EasyAI GPT-5.5', 'AI 大宜宾 sub2api - GPT-5.5']);
  assert.ok(result.providerErrors.every((error) => error.message === '模型请求失败'));
  assert.match(result.modelError, /EasyAI GPT-5.5: 模型请求失败/);
});

test('provider url helpers preserve configured v1 paths', () => {
  assert.equal(responsesUrl('http://127.0.0.1:8080/v1'), 'http://127.0.0.1:8080/v1/responses');
  assert.equal(chatCompletionsUrl('https://api.kimi.com/coding/v1'), 'https://api.kimi.com/coding/v1/chat/completions');
});
