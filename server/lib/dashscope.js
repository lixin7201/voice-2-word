const DEFAULT_BASE_URL = 'https://dashscope.aliyuncs.com/api/v1';

function isDashScopeConfigured(config) {
  return Boolean(config.dashscopeApiKey);
}

async function transcribeWithDashScope(config, fileUrl, fetchImpl = fetch) {
  const baseUrl = (config.dashscopeBaseUrl || DEFAULT_BASE_URL).replace(/\/$/, '');
  const submit = await fetchImpl(`${baseUrl}/services/audio/asr/transcription`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${config.dashscopeApiKey}`,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable',
    },
    body: JSON.stringify({
      model: config.dashscopeModel || 'fun-asr',
      input: { file_urls: [fileUrl] },
      parameters: {
        channel_id: [0],
        diarization_enabled: true,
        language_hints: ['zh', 'en'],
        vocabulary_id: config.dashscopeVocabularyId || undefined,
      },
    }),
  });
  const submitJson = await submit.json().catch(() => ({}));
  if (!submit.ok) {
    throw new Error(`DashScope 提交失败：${submitJson.message || submit.status}`);
  }
  const taskId = submitJson.output?.task_id;
  if (!taskId) throw new Error('DashScope 未返回 task_id');

  const queried = await waitForDashScopeTask(config, baseUrl, taskId, fetchImpl);
  const result = firstDashScopeResult(queried);
  if (!result || result.subtask_status === 'FAILED') {
    throw new Error(`DashScope 转写失败：${result?.message || queried.output?.message || '未知错误'}`);
  }
  if (!result.transcription_url) {
    throw new Error('DashScope 未返回 transcription_url');
  }

  const transcriptionResponse = await fetchImpl(result.transcription_url);
  const transcriptionJson = await transcriptionResponse.json().catch(() => ({}));
  if (!transcriptionResponse.ok) {
    throw new Error(`DashScope 结果下载失败：HTTP ${transcriptionResponse.status}`);
  }

  return {
    taskId,
    ...normalizeDashScopeTranscription(transcriptionJson),
    raw: transcriptionJson,
  };
}

async function waitForDashScopeTask(config, baseUrl, taskId, fetchImpl) {
  const timeoutMs = Number(config.dashscopeTimeoutMs || 20 * 60 * 1000);
  const intervalMs = Number(config.dashscopePollIntervalMs || 5000);
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const response = await fetchImpl(`${baseUrl}/tasks/${taskId}`, {
      headers: { Authorization: `Bearer ${config.dashscopeApiKey}` },
    });
    const json = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`DashScope 查询失败：${json.message || response.status}`);
    const status = json.output?.task_status;
    if (status === 'SUCCEEDED' || status === 'FAILED' || status === 'CANCELED') return json;
    await delay(intervalMs);
  }
  throw new Error('DashScope 转写超时');
}

function firstDashScopeResult(queryJson) {
  return queryJson.output?.results?.[0] || null;
}

function normalizeDashScopeTranscription(resultJson) {
  const transcripts = Array.isArray(resultJson.transcripts) ? resultJson.transcripts : [];
  const sentences = transcripts.flatMap((transcript) =>
    Array.isArray(transcript.sentences)
      ? transcript.sentences.map((sentence, index) => ({
        id: `seg-${sentence.sentence_id || index + 1}`,
        startMs: sentence.begin_time,
        endMs: sentence.end_time,
        speaker: sentence.speaker_id !== undefined ? `Speaker ${sentence.speaker_id}` : undefined,
        text: sentence.text || '',
      }))
      : []
  ).filter((sentence) => sentence.text);
  const rawText = transcripts.map((transcript) => transcript.text).filter(Boolean).join('\n');
  const durationMs = Number(resultJson.properties?.original_duration_in_milliseconds || 0);
  return {
    rawText,
    correctedText: rawText,
    segments: sentences,
    durationMs,
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = {
  isDashScopeConfigured,
  normalizeDashScopeTranscription,
  transcribeWithDashScope,
};
