const PLACEHOLDER_PATTERNS = [
  '待核对',
  '暂无',
  '需补充',
  '未提及',
  '不明确',
  '待确认',
  '人工确认',
];

function assessSummaryQuality(summary = {}, transcriptText = '') {
  const cleanTranscript = stripWhitespace(transcriptText);
  const cleanSummary = stripWhitespace(stripMarkdown(summary.summaryMarkdown || summary.summary_markdown || ''));
  const placeholderCount = countPlaceholders(cleanSummary);
  const modelProvider = String(summary.modelProvider || summary.model_provider || '');
  const modelError = String(summary.modelError || summary.model_error || '');

  const metrics = {
    inputTranscriptChars: cleanTranscript.length,
    summaryChars: cleanSummary.length,
    placeholderCount,
  };

  if (!cleanSummary || cleanSummary.length < 15) {
    return {
      ...metrics,
      qualityStatus: 'invalid',
      qualityReason: '总结正文为空或过短',
    };
  }

  if (modelProvider === 'local-template' && modelError) {
    return {
      ...metrics,
      qualityStatus: 'fallback_template',
      qualityReason: '真实总结模型全部失败，系统仅生成临时模板',
    };
  }

  if (cleanTranscript.length >= 300 && cleanSummary.length < 120) {
    return {
      ...metrics,
      qualityStatus: 'low_information',
      qualityReason: '逐字稿较长，但总结正文过短',
    };
  }

  if (placeholderCount >= 3 && cleanSummary.length < 240) {
    return {
      ...metrics,
      qualityStatus: 'low_information',
      qualityReason: '总结主要由待核对占位内容组成',
    };
  }

  return {
    ...metrics,
    qualityStatus: 'ai_ok',
    qualityReason: '',
  };
}

function inferLegacySummaryQuality(summary = {}, transcriptText = '') {
  if (summary.quality_status) {
    return {
      qualityStatus: summary.quality_status,
      qualityReason: summary.quality_reason || '',
      inputTranscriptChars: Number(summary.input_transcript_chars || 0),
      summaryChars: Number(summary.summary_chars || 0),
      placeholderCount: Number(summary.placeholder_count || 0),
    };
  }
  return assessSummaryQuality({
    summaryMarkdown: summary.summary_markdown,
    modelProvider: summary.model_provider,
    modelError: summary.model_error,
  }, transcriptText);
}

function isSummaryUsable(summary = {}) {
  const status = String(summary.quality_status || summary.qualityStatus || '');
  if (status === 'fallback_template' || status === 'invalid') return false;
  return Boolean(summary.summary_markdown || summary.summaryMarkdown || summary.overview_card_json || summary.overviewCard);
}

function stripMarkdown(value) {
  return String(value || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/!\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/\[[^\]]*]\([^)]*\)/g, ' ')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^>\s?/gm, '')
    .replace(/^[\s>*+-]*\d+[.)]\s*/gm, '')
    .replace(/^[\s>*+-]+/gm, '')
    .replace(/[*_~#|[\]]/g, ' ');
}

function stripWhitespace(value) {
  return String(value || '').replace(/\s+/g, '');
}

function countPlaceholders(value) {
  const text = String(value || '');
  return PLACEHOLDER_PATTERNS.reduce((total, pattern) => {
    const matches = text.match(new RegExp(escapeRegExp(pattern), 'g'));
    return total + (matches ? matches.length : 0);
  }, 0);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

module.exports = {
  assessSummaryQuality,
  inferLegacySummaryQuality,
  isSummaryUsable,
  stripMarkdown,
};
