const { buildLocalSummary, buildSummaryPrompt } = require('./templates');

async function generateSummary(config, record, transcriptText, fetchImpl = fetch) {
  const providers = [
    {
      name: 'easyai',
      baseUrl: config.easyAiBaseUrl,
      apiKey: config.easyAiApiKey,
      model: config.easyAiModel || 'gpt-5.5',
    },
    {
      name: 'kimi',
      baseUrl: config.kimiBaseUrl,
      apiKey: config.kimiApiKey,
      model: config.kimiModel || 'kimi-k2.6',
    },
  ].filter((provider) => provider.baseUrl && provider.apiKey && provider.model);

  for (const provider of providers) {
    try {
      const generated = await callChatCompletion(provider, record, transcriptText, fetchImpl);
      return {
        ...generated,
        modelProvider: provider.name,
        modelName: provider.model,
        modelError: '',
      };
    } catch (error) {
      if (provider.name === providers.at(-1)?.name) {
        const fallback = buildLocalSummary(record, transcriptText);
        return {
          ...fallback,
          modelProvider: 'local-template',
          modelName: 'local-template',
          modelError: error.message || String(error),
        };
      }
    }
  }

  return {
    ...buildLocalSummary(record, transcriptText),
    modelProvider: 'local-template',
    modelName: 'local-template',
    modelError: '',
  };
}

async function callChatCompletion(provider, record, transcriptText, fetchImpl) {
  const response = await fetchImpl(`${provider.baseUrl.replace(/\/$/, '')}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${provider.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: provider.model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: buildSummaryPrompt(record, transcriptText),
    }),
  });
  const json = await response.json().catch(() => ({}));
  if (!response.ok || json.error) {
    throw new Error(json.error?.message || json.message || `模型请求失败：HTTP ${response.status}`);
  }
  const content = json.choices?.[0]?.message?.content || '';
  const parsed = parseJsonContent(content);
  if (!parsed.summaryMarkdown) {
    throw new Error('模型返回缺少 summaryMarkdown');
  }
  return {
    summaryMarkdown: parsed.summaryMarkdown,
    structuredJson: parsed.structuredJson || {},
    overviewCard: parsed.overviewCard || {},
    followupMarkdown: parsed.followupMarkdown || '',
    followupFields: parsed.followupFields || {},
    followupStage: parsed.followupStage || '',
    suggestedTag: parsed.suggestedTag || '',
    statusLabel: parsed.statusLabel || '',
    customerName: parsed.customerName || '',
    companyName: parsed.companyName || '',
  };
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

module.exports = {
  generateSummary,
};
