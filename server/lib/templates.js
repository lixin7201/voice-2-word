const TEMPLATE_LABELS = {
  meeting_minutes: '会议纪要',
  business_review: '业务复盘',
  customer_follow_up: '通用客户跟进',
  matchmaker_profile: '红娘客户画像',
  recruitment_followup: '招聘客户跟进',
};

const TEMPLATE_OPTIONS = Object.entries(TEMPLATE_LABELS).map(([value, label]) => ({ value, label }));

function defaultTemplateForEmployee(employee, departments = []) {
  const names = departments.map((department) => department.name);
  if (names.includes('红娘部门')) return 'matchmaker_profile';
  if (names.includes('招聘部')) return 'recruitment_followup';
  return 'meeting_minutes';
}

function buildLocalSummary(record) {
  const label = TEMPLATE_LABELS[record.template_type] || TEMPLATE_LABELS.meeting_minutes;
  const title = record.title || record.original_file_name || '录音记录';
  const sections = templateSections(record.template_type);
  const summaryMarkdown = [
    `# ${title}`,
    '',
    `模板：${label}`,
    '',
    ...sections.flatMap((section) => [
      `## ${section.heading}`,
      '',
      ...section.items.map((item) => `- ${item}`),
      '',
    ]),
    '## 待核对信息',
    '',
    '- 当前为本地开发模式生成的结构化占位结果；接入 DashScope 和模型后会替换为真实录音内容。',
  ].join('\n');

  const followupMarkdown = buildFollowupMarkdown(record.template_type);
  return {
    summaryMarkdown,
    structuredJson: {
      templateType: record.template_type,
      generatedMode: 'local_development',
      sections,
    },
    overviewCard: {
      title,
      template: label,
      status: '本地开发模式',
    },
    followupMarkdown,
  };
}

function templateSections(templateType) {
  if (templateType === 'business_review') {
    return [
      { heading: '沟通背景', items: ['梳理业务流程、当前痛点和参与角色。'] },
      { heading: '核心痛点', items: ['记录条件限制、风险点和需要进一步确认的信息。'] },
      { heading: '优化方向', items: ['沉淀工具方案、后续安排和负责人。'] },
    ];
  }

  if (templateType === 'customer_follow_up') {
    return [
      { heading: '客户基本信息', items: ['客户称呼、来源渠道、当前阶段。'] },
      { heading: '当前诉求', items: ['核心需求、顾虑、决策限制。'] },
      { heading: '下一步跟进建议', items: ['建议动作、跟进时间、待补资料。'] },
    ];
  }

  if (templateType === 'matchmaker_profile') {
    return [
      { heading: '客户基础画像', items: ['基础情况、工作收入、家庭情况、生活习惯。'] },
      { heading: '婚恋诉求', items: ['择偶硬性条件、弹性偏好、忌讳点。'] },
      { heading: '服务建议', items: ['匹配方向、潜在风险、下次跟进话术。'] },
    ];
  }

  if (templateType === 'recruitment_followup') {
    return [
      { heading: '招聘客户状态', items: ['企业名称、联系人、招聘岗位和人数。'] },
      { heading: '跟进阶段判断', items: ['初期、中期、暂不招人、中后期、后期五阶段之一。'] },
      { heading: '建议标签和下一步', items: ['客户标签依据、跟进频率、人工确认项。'] },
    ];
  }

  return [
    { heading: '会议背景', items: ['会议目标、参会角色、讨论主题。'] },
    { heading: '关键结论', items: ['核心决定、已讨论方案、待办事项。'] },
    { heading: '待确认问题', items: ['人名、金额、时间、承诺等需要回听复核。'] },
  ];
}

function buildFollowupMarkdown(templateType) {
  if (templateType === 'matchmaker_profile') {
    return [
      '【报价金额/成交状态】：',
      '【未成交原因】：',
      '【第一印象】：',
      '【个人基本情况】：',
      '【工作收入】：',
      '【资产情况】：',
      '【家庭情况】：',
      '【兴趣爱好】：',
      '【情感经历】：',
      '【择偶硬性条件】：',
      '【择偶弹性偏好】：',
      '【忌讳点】：',
      '【性格优点】：',
      '【性格挑战】：',
      '【服务匹配建议】：',
      '【下次跟进话术】：',
      '【待核对信息】：',
    ].join('\n');
  }

  if (templateType === 'recruitment_followup') {
    return [
      '初期有效跟进',
      '【当前客户状态】：',
      '【招聘岗位】：',
      '【招聘人数】：',
      '【岗位要求】：',
      '【福利待遇】：',
      '【其他信息】：',
      '【是否已添加微信】：',
      '',
      '【建议标签】：待核对',
      '【标签依据】：需根据真实转写内容由 AI 生成',
      '【建议跟进频率】：需人工确认',
    ].join('\n');
  }

  return [
    '【客户状态】：',
    '【沟通关键信息】：',
    '【客户顾虑】：',
    '【下一步动作】：',
    '【待核对信息】：',
  ].join('\n');
}

module.exports = {
  TEMPLATE_LABELS,
  TEMPLATE_OPTIONS,
  buildLocalSummary,
  defaultTemplateForEmployee,
};
