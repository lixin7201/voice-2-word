const { normalizeMindMap } = require('./mind-map');

const TEMPLATE_LABELS = {
  meeting_minutes: '会议纪要',
  business_review: '业务复盘',
  customer_follow_up: '通用客户跟进',
  matchmaker_profile: '红娘客户画像',
  recruitment_followup: '招聘客户跟进',
};

const TEMPLATE_OPTIONS = Object.entries(TEMPLATE_LABELS).map(([value, label]) => ({ value, label }));

const FOLLOWUP_LABELS = {
  none: '不生成跟单',
  general_customer: '通用客户跟单',
  matchmaker: '红娘跟单/画像字段',
  recruitment: '招聘跟单',
};

const FOLLOWUP_OPTIONS = Object.entries(FOLLOWUP_LABELS).map(([value, label]) => ({ value, label }));

const RECRUITMENT_STAGES = {
  initial_effective_followup: '初期有效跟进',
  mid_effective_followup: '中期有效跟进',
  no_hiring_followup: '暂不招人有效跟进',
  mid_late_effective_followup: '中后期有效跟进',
  late_effective_followup: '后期有效跟进',
};

function defaultTemplateForEmployee(employee, departments = []) {
  const names = departments.map((department) => department.name);
  if (names.includes('红娘部门')) return 'matchmaker_profile';
  if (names.includes('招聘部')) return 'recruitment_followup';
  return 'meeting_minutes';
}

function defaultFollowupForEmployee(employee, departments = []) {
  const names = departments.map((department) => department.name);
  if (names.includes('红娘部门')) return 'matchmaker';
  if (names.includes('招聘部')) return 'recruitment';
  return 'none';
}

function followupTypeForTemplate(templateType) {
  if (templateType === 'matchmaker_profile') return 'matchmaker';
  if (templateType === 'recruitment_followup') return 'recruitment';
  if (templateType === 'customer_follow_up') return 'general_customer';
  return 'none';
}

function normalizeFollowupType(value, fallbackTemplateType = '') {
  const type = String(value || '').trim();
  if (FOLLOWUP_LABELS[type]) return type;
  return followupTypeForTemplate(fallbackTemplateType);
}

function shouldGenerateFollowup(record) {
  return normalizeFollowupType(record.followup_type, record.template_type) !== 'none';
}

function followupTemplateForType(followupType, fallbackTemplateType = '') {
  const type = normalizeFollowupType(followupType, fallbackTemplateType);
  if (type === 'matchmaker') return 'matchmaker_profile';
  if (type === 'recruitment') return 'recruitment_followup';
  if (type === 'general_customer') return 'customer_follow_up';
  return fallbackTemplateType || 'meeting_minutes';
}

function buildLocalSummary(record, transcriptText = '') {
  const label = TEMPLATE_LABELS[record.template_type] || TEMPLATE_LABELS.meeting_minutes;
  const title = record.title || record.original_file_name || '录音记录';
  const sourceText = cleanTranscript(transcriptText);
  const titleSuggestion = buildTitleSuggestion(record, sourceText);
  const sections = templateSections(record.template_type, sourceText);
  const wantsFollowup = shouldGenerateFollowup(record);
  const followup = wantsFollowup
    ? buildFollowup(followupTemplateForType(record.followup_type, record.template_type), sourceText)
    : emptyFollowup();
  const summaryMarkdown = [
    `# ${title}`,
    '',
    `模板：${label}`,
    '',
    sourceText ? `> 依据逐字稿自动整理，关键信息仍建议回听核对。` : `> 当前没有可用逐字稿，已按模板生成待填写结构。`,
    '',
    ...sections.flatMap((section) => [
      `## ${section.heading}`,
      '',
      ...section.items.map((item) => `- ${item}`),
      '',
    ]),
    '## 待核对信息',
    '',
    ...followup.pending.map((item) => `- ${item}`),
  ].join('\n');

  return {
    summaryMarkdown,
    structuredJson: {
      templateType: record.template_type,
      followupType: normalizeFollowupType(record.followup_type, record.template_type),
      templateLabel: label,
      generatedMode: sourceText ? 'local_structured' : 'local_empty_template',
      sections,
      fields: wantsFollowup ? followup.fields : {},
      pending: wantsFollowup ? followup.pending : ['人名、金额、日期、承诺内容仍建议回听复核'],
    },
    overviewCard: {
      title,
      badge: label,
      eyebrow: '录音整理',
      heroTitle: title,
      heroSubtitle: sections.map((section) => section.heading).join('、'),
      generatedByLabel: '内容由 AI 生成',
      cards: sections.map((section, index) => ({
        id: `section-${index + 1}`,
        title: section.heading,
        tone: ['blue', 'green', 'orange', 'purple', 'cyan'][index % 5],
        layout: index === 0 ? 'wide' : 'medium',
        iconStyle: 'number',
        items: section.items.slice(0, 3),
        blocks: [{
          title: '重点提炼',
          items: section.items,
          note: index === 0 ? '重要信息仍建议结合录音回听核对。' : '',
        }],
      })),
      keyFields: wantsFollowup ? followup.overview : Object.fromEntries(sections.map((section) => [section.heading, section.items[0] || '待核对'])),
    },
    mindMap: normalizeMindMap(buildLocalMindMap(title, label, sections), title),
    followupMarkdown: followup.markdown,
    followupFields: followup.fields,
    followupStage: followup.stage || '',
    suggestedTag: followup.suggestedTag || '',
    statusLabel: followup.statusLabel || '待核对',
    customerName: followup.customerName || '',
    companyName: followup.companyName || '',
    titleSuggestion,
  };
}

function buildLocalMindMap(title, label, sections) {
  return {
    title: `${title} - 思维导图总结`,
    center: label,
    branches: sections.map((section, index) => ({
      id: `branch-${index + 1}`,
      title: section.heading,
      tone: ['blue', 'green', 'orange', 'purple', 'cyan'][index % 5],
      summary: section.items[0] || '待核对',
      children: section.items.slice(0, 4).map((item, childIndex) => ({
        title: `要点 ${childIndex + 1}`,
        detail: item,
        items: [],
      })),
    })),
  };
}

function buildSummaryPrompt(record, transcriptText, context = {}) {
  const label = TEMPLATE_LABELS[record.template_type] || TEMPLATE_LABELS.meeting_minutes;
  const profileContext = String(context.profileContext || '').trim();
  const followupType = normalizeFollowupType(record.followup_type, record.template_type);
  const wantsFollowup = followupType !== 'none';
  const jsonFields = wantsFollowup
    ? 'summaryMarkdown, overviewCard, mindMap, structuredJson, followupMarkdown, followupFields, followupStage, suggestedTag, statusLabel, customerName, companyName, titleSuggestion'
    : 'summaryMarkdown, overviewCard, mindMap, structuredJson, titleSuggestion';
  return [
    {
      role: 'system',
      content: [
        '你是大宜宾内部录音总结助手，只能依据逐字稿输出，不编造。',
        '必须返回 JSON，不要输出 Markdown 代码块。',
        `JSON 字段：${jsonFields}。`,
        'overviewCard 用于前端卡片展示，mindMap 用于思维导图展示；如果信息不足，也要给出可展示的结构化兜底内容。',
        'overviewCard 必须像知识卡片：包含 badge、eyebrow、heroTitle、heroSubtitle、generatedByLabel、cards。cards 每项包含 id、title、tone、layout、iconStyle、items，并尽量包含 blocks；blocks 可包含 title、items、rows、note。rows 用于负责人、客户、金额、阶段、时间等字段，格式为 {label,value,note}。',
        'titleSuggestion 用中文短标题概括主题，8 到 18 个汉字左右，最长 30 个中文字符；不要含日期、文件扩展名、哈希串；不要泛写“会议纪要”“录音”“转写”。',
        '涉及人名、金额、年龄、地址、岗位、承诺、合同、服务结果等不确定信息必须进入待核对。',
        '员工背景仅用于选择表达重点和字段优先级，不得把背景当作录音事实写入纪要。',
        '红娘场景不做道德评价、不用攻击性标签、不承诺匹配成功。',
        '招聘场景不得虚构意向，不得承诺招聘效果，无效号码/停机/空号不得写成有效跟进。',
      ].join('\n'),
    },
    {
      role: 'user',
      content: [
        `模板：${label}`,
        `跟单生成：${FOLLOWUP_LABELS[followupType] || '不生成跟单'}`,
        `记录标题：${record.title || record.original_file_name || '录音记录'}`,
        profileContext ? `\n${profileContext}` : '',
        '',
        wantsFollowup
          ? '请按需求文档字段输出；招聘客户跟进需自动判断五阶段；红娘客户画像需覆盖报价、成交状态、基础画像、情感经历、择偶条件、风险和下次话术。'
          : '本次只生成录音总结和会议纪要，不要输出跟单内容，也不要生成客户跟进字段。',
        '',
        '逐字稿：',
        transcriptText || '（无逐字稿）',
      ].join('\n'),
    },
  ];
}

function emptyFollowup() {
  return {
    fields: {},
    overview: {},
    pending: [],
    markdown: '',
    stage: '',
    suggestedTag: '',
    statusLabel: '',
    customerName: '',
    companyName: '',
  };
}

function templateSections(templateType, transcriptText) {
  const highlights = extractHighlights(transcriptText);
  if (templateType === 'business_review') {
    return [
      { heading: '沟通背景', items: [firstOrDefault(highlights, '本次沟通背景需人工补充。')] },
      { heading: '核心痛点', items: extractByKeywords(transcriptText, ['问题', '痛点', '麻烦', '困难', '卡']).slice(0, 4) },
      { heading: '优化方向', items: extractByKeywords(transcriptText, ['优化', '方案', '工具', '流程', '下一步']).slice(0, 4) },
    ].map(fillEmptySection);
  }

  if (templateType === 'customer_follow_up') {
    return [
      { heading: '客户基本信息', items: extractByKeywords(transcriptText, ['客户', '公司', '企业', '老板', '联系人']).slice(0, 4) },
      { heading: '当前诉求', items: extractByKeywords(transcriptText, ['需要', '想要', '需求', '顾虑', '预算']).slice(0, 4) },
      { heading: '下一步跟进建议', items: extractByKeywords(transcriptText, ['下次', '明天', '微信', '资料', '跟进']).slice(0, 4) },
    ].map(fillEmptySection);
  }

  if (templateType === 'matchmaker_profile') {
    return [
      { heading: '客户基础画像', items: extractByKeywords(transcriptText, ['年龄', '工作', '收入', '房', '车', '家庭']).slice(0, 5) },
      { heading: '婚恋诉求', items: extractByKeywords(transcriptText, ['对象', '结婚', '离婚', '感情', '择偶', '要求']).slice(0, 5) },
      { heading: '服务建议', items: ['按录音事实整理画像，敏感信息仅作内部服务参考；不承诺匹配结果。'] },
    ].map(fillEmptySection);
  }

  if (templateType === 'recruitment_followup') {
    const stage = detectRecruitmentStage(transcriptText);
    return [
      { heading: '招聘客户状态', items: extractByKeywords(transcriptText, ['招聘', '岗位', '人数', '薪资', '福利', '上班']).slice(0, 5) },
      { heading: '跟进阶段判断', items: [`判断为：${RECRUITMENT_STAGES[stage]}。依据：${stageReason(stage, transcriptText)}`] },
      { heading: '建议标签和下一步', items: recruitmentNextSteps(stage, transcriptText) },
    ].map(fillEmptySection);
  }

  return [
    { heading: '会议背景', items: [firstOrDefault(highlights, '会议背景需人工补充。')] },
    { heading: '关键结论', items: extractByKeywords(transcriptText, ['确定', '决定', '结论', '要做', '先']).slice(0, 5) },
    { heading: '待办事项', items: extractByKeywords(transcriptText, ['下周', '明天', '负责', '跟进', '完成']).slice(0, 5) },
  ].map(fillEmptySection);
}

function buildFollowup(templateType, transcriptText) {
  if (templateType === 'matchmaker_profile') return buildMatchmakerFollowup(transcriptText);
  if (templateType === 'recruitment_followup') return buildRecruitmentFollowup(transcriptText);
  return buildGeneralFollowup(transcriptText);
}

function buildMatchmakerFollowup(transcriptText) {
  const fields = {
    quoteAndDealStatus: valueAfter(transcriptText, ['报价', '价格', '成交', '套餐']) || '待核对',
    firstImpression: valueAfter(transcriptText, ['第一印象', '感觉', '性格']) || '待核对',
    basicProfile: joinHighlights(transcriptText, ['年龄', '身高', '工作', '收入', '家庭']),
    relationshipHistory: joinHighlights(transcriptText, ['恋爱', '前任', '离婚', '感情']),
    hardRequirements: joinHighlights(transcriptText, ['必须', '不能接受', '硬性', '要求']),
    flexiblePreferences: joinHighlights(transcriptText, ['希望', '最好', '可以接受']),
    serviceSuggestion: '建议红娘先核对基础资料和择偶硬性条件，再安排匹配沟通。',
    nextScript: '下次沟通可先复述客户核心诉求，再确认待核对信息和可接受的匹配范围。',
  };
  return {
    fields,
    overview: fields,
    statusLabel: fields.quoteAndDealStatus,
    pending: pendingFromFields(fields),
    markdown: [
      `【报价金额/成交状态】：${fields.quoteAndDealStatus}`,
      '【未成交原因】：待核对',
      `【第一印象】：${fields.firstImpression}`,
      `【个人基本情况】：${fields.basicProfile}`,
      '【工作收入】：见个人基本情况，具体金额待核对',
      '【资产情况】：待核对',
      '【家庭情况】：见个人基本情况',
      '【兴趣爱好】：待核对',
      `【情感经历】：${fields.relationshipHistory}`,
      `【择偶硬性条件】：${fields.hardRequirements}`,
      `【择偶弹性偏好】：${fields.flexiblePreferences}`,
      '【忌讳点】：待核对',
      '【性格优点】：待核对',
      '【性格挑战】：待核对',
      `【服务匹配建议】：${fields.serviceSuggestion}`,
      `【下次跟进话术】：${fields.nextScript}`,
      `【待核对信息】：${pendingFromFields(fields).join('；')}`,
    ].join('\n'),
  };
}

function buildRecruitmentFollowup(transcriptText) {
  const stage = detectRecruitmentStage(transcriptText);
  const fields = {
    companyName: valueAfter(transcriptText, ['公司', '企业', '门店']) || '',
    contactRole: valueAfter(transcriptText, ['老板', '人事', '负责人']) || '待核对',
    hiringRoles: joinHighlights(transcriptText, ['岗位', '招聘', '招', '工种']),
    hiringCount: valueAfter(transcriptText, ['人数', '几个', '多少人']) || '待核对',
    requirements: joinHighlights(transcriptText, ['要求', '经验', '年龄', '学历']),
    salaryBenefits: joinHighlights(transcriptText, ['工资', '薪资', '福利', '社保', '包吃', '休息']),
    nextAction: recruitmentNextSteps(stage, transcriptText).join('；'),
    suggestedTag: suggestedRecruitmentTag(stage, transcriptText),
  };
  const markdown = recruitmentMarkdown(stage, fields);
  return {
    stage,
    fields,
    overview: fields,
    companyName: fields.companyName,
    statusLabel: RECRUITMENT_STAGES[stage],
    suggestedTag: fields.suggestedTag,
    pending: pendingFromFields(fields),
    markdown,
  };
}

function buildGeneralFollowup(transcriptText) {
  const fields = {
    customerStatus: valueAfter(transcriptText, ['客户', '状态', '意向']) || '待核对',
    keyInfo: joinHighlights(transcriptText, ['需要', '需求', '问题', '预算', '时间']),
    concerns: joinHighlights(transcriptText, ['担心', '顾虑', '贵', '不确定', '风险']),
    nextAction: joinHighlights(transcriptText, ['下次', '跟进', '微信', '资料', '确认']),
  };
  return {
    fields,
    overview: fields,
    statusLabel: fields.customerStatus,
    pending: pendingFromFields(fields),
    markdown: [
      `【客户状态】：${fields.customerStatus}`,
      `【沟通关键信息】：${fields.keyInfo}`,
      `【客户顾虑】：${fields.concerns}`,
      `【下一步动作】：${fields.nextAction}`,
      `【待核对信息】：${pendingFromFields(fields).join('；')}`,
    ].join('\n'),
  };
}

function detectRecruitmentStage(text) {
  const value = cleanTranscript(text);
  if (hasAny(value, ['不招', '暂时不招', '招满', '没需求', '暂时无需求'])) return 'no_hiring_followup';
  if (hasAny(value, ['已开通', '续费', '效果', '会员到期', '急招调整'])) return 'late_effective_followup';
  if (hasAny(value, ['套餐', '报价', '合同', '会员', '权益', '价格'])) return 'mid_late_effective_followup';
  if (hasAny(value, ['微信', '入驻', '注册', '发布岗位', '营业执照', '绑定'])) return 'mid_effective_followup';
  return 'initial_effective_followup';
}

function recruitmentMarkdown(stage, fields) {
  if (stage === 'mid_effective_followup') {
    return [
      '中期有效跟进',
      `【当前客户状态】：${fields.suggestedTag}`,
      `【情况】：${fields.hiringRoles || fields.requirements}`,
      `【跟进策略】：${fields.nextAction}`,
    ].join('\n');
  }
  if (stage === 'no_hiring_followup') {
    return [
      '暂不招人有效跟进',
      '【后续计划】：客户当前表达暂时不招人/暂无需求，后续按约定时间轻量跟进。',
      '【人员储备】：待核对',
      '【招聘习惯】：待核对',
      `【其它信息】：${fields.nextAction}`,
    ].join('\n');
  }
  if (stage === 'mid_late_effective_followup') {
    return [
      '中后期有效跟进',
      `【当前客户状态】：${fields.suggestedTag}`,
      `【情况】：${fields.hiringRoles || fields.salaryBenefits}`,
      '【意向套餐进程】：客户已涉及套餐/报价/权益，需人工确认意向档位和决策人。',
    ].join('\n');
  }
  if (stage === 'late_effective_followup') {
    return [
      '后期有效跟进',
      `【当前客户状态】：${fields.suggestedTag}`,
      `【跟进内容】：${fields.nextAction}`,
      '【目前招聘效果】：待核对',
      `【目前急招岗位】：${fields.hiringRoles}`,
    ].join('\n');
  }
  return [
    '初期有效跟进',
    `【当前客户状态】：${fields.suggestedTag}`,
    `【招聘岗位】：${fields.hiringRoles}`,
    `【招聘人数】：${fields.hiringCount}`,
    `【岗位要求】：${fields.requirements}`,
    `【福利待遇】：${fields.salaryBenefits}`,
    `【其他信息】：${fields.nextAction}`,
    '【是否已添加微信】：待核对',
  ].join('\n');
}

function recruitmentNextSteps(stage, text) {
  if (stage === 'no_hiring_followup') return ['标记暂时无需求，不写成强意向；约定下次轻量回访时间。'];
  if (stage === 'mid_late_effective_followup') return ['核对套餐、报价、合同、决策人和会员权益，等待人工确认后推进。'];
  if (stage === 'late_effective_followup') return ['复盘招聘效果，确认急招岗位变化和未使用权益。'];
  if (stage === 'mid_effective_followup') return ['确认是否已添加微信、注册入驻、发布岗位和营业执照资料。'];
  return ['补齐岗位、人数、要求、薪资福利、微信添加情况。'];
}

function stageReason(stage, text) {
  const map = {
    no_hiring_followup: '逐字稿出现暂不招人、招满或无需求相关表达。',
    late_effective_followup: '逐字稿出现已开通、续费或招聘效果复盘相关表达。',
    mid_late_effective_followup: '逐字稿出现套餐、报价、合同或会员权益相关表达。',
    mid_effective_followup: '逐字稿出现微信、入驻、注册或发布岗位相关表达。',
    initial_effective_followup: '逐字稿主要围绕岗位、人数、要求、薪资等基础招聘信息。',
  };
  return map[stage] || '待核对';
}

function suggestedRecruitmentTag(stage, text) {
  if (stage === 'no_hiring_followup') return '暂时无需求';
  if (stage === 'mid_late_effective_followup') return 'C 类，有需求';
  if (stage === 'late_effective_followup') return hasAny(text, ['已报单', '已开通']) ? 'A 类，已报单' : 'B 类，已入驻';
  if (stage === 'mid_effective_followup') return 'B 类，已入驻';
  if (hasAny(text, ['空号', '停机', '打不通', '无人接'])) return '无效通话';
  return 'C 类，有需求';
}

function extractHighlights(text) {
  return cleanTranscript(text)
    .split(/[。！？!?；;\n]/)
    .map((line) => line.trim())
    .filter((line) => line.length >= 8)
    .slice(0, 6);
}

function extractByKeywords(text, keywords) {
  const lines = extractHighlights(text).filter((line) => keywords.some((keyword) => line.includes(keyword)));
  return lines.length ? lines : ['待核对'];
}

function joinHighlights(text, keywords) {
  return extractByKeywords(text, keywords).slice(0, 3).join('；');
}

function valueAfter(text, keywords) {
  const line = extractByKeywords(text, keywords).find((item) => item !== '待核对');
  return line || '';
}

function cleanTranscript(text) {
  return String(text || '').replace(/\s+/g, ' ').trim();
}

function hasAny(text, keywords) {
  return keywords.some((keyword) => String(text || '').includes(keyword));
}

function firstOrDefault(items, fallback) {
  return items.find(Boolean) || fallback;
}

function fillEmptySection(section) {
  return {
    ...section,
    items: section.items?.filter(Boolean).length ? section.items.filter(Boolean) : ['待核对'],
  };
}

function pendingFromFields(fields) {
  const pending = Object.entries(fields)
    .filter(([, value]) => !value || String(value).includes('待核对'))
    .map(([key]) => key);
  return pending.length ? pending.map((key) => `${key} 待核对`) : ['人名、金额、日期、承诺内容仍建议回听复核'];
}

function buildTitleSuggestion(record, transcriptText) {
  const candidates = [
    ...extractHighlights(transcriptText),
    record.source_page_title,
    record.title,
    record.original_file_name,
  ];
  for (const candidate of candidates) {
    const normalized = normalizeTitleSuggestion(candidate);
    if (normalized) return normalized;
  }
  return '';
}

function normalizeTitleSuggestion(value) {
  let text = String(value || '')
    .replace(/^本地开发模式已接收文件[:：]?/, '')
    .replace(/\.(mp3|m4a|wav|aac|flac|ogg|opus|mp4|mov|webm)$/i, '')
    .replace(/[「」"'“”‘’`]/g, '')
    .replace(/\s+/g, '')
    .trim();
  text = text.split(/[。！？!?；;，,\n]/).find(Boolean) || '';
  if (!text || text.length < 2) return '';
  if (/^[a-f0-9_-]{24,}$/i.test(text)) return '';
  if (!/[\u4e00-\u9fa5]/.test(text)) return '';
  text = text.replace(/^(关于|讨论|沟通|记录)/, '');
  if (['网页录音', '录音记录', '会议纪要', '转写结果'].includes(text)) return '';
  return text.slice(0, 30);
}

module.exports = {
  FOLLOWUP_LABELS,
  FOLLOWUP_OPTIONS,
  RECRUITMENT_STAGES,
  TEMPLATE_LABELS,
  TEMPLATE_OPTIONS,
  buildLocalSummary,
  buildSummaryPrompt,
  defaultFollowupForEmployee,
  defaultTemplateForEmployee,
  detectRecruitmentStage,
  followupTemplateForType,
  followupTypeForTemplate,
  normalizeFollowupType,
  normalizeMindMap,
  shouldGenerateFollowup,
};
