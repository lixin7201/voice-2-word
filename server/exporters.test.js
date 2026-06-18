const test = require('node:test');
const assert = require('node:assert/strict');
const { buildExportSvg, buildExportText, buildSummaryExportHtml, createSummaryDocxBuffer, createSummaryPdfBuffer } = require('./lib/exporters');

function fakeStore(tables) {
  return {
    table(name) {
      return tables[name] || [];
    },
    findById(name, id) {
      return (tables[name] || []).find((item) => item.id === id);
    },
  };
}

test('transcript export uses timestamped segments and speaker aliases', () => {
  const record = {
    id: 'record-1',
    owner_employee_id: 'employee-1',
    owner_department_id: 'department-1',
    title: '客户沟通录音',
    created_at: '2026-06-17T08:00:00.000Z',
    source_type: 'manual_upload',
    template_type: 'meeting_minutes',
    followup_type: 'none',
  };
  const store = fakeStore({
    employees: [{ id: 'employee-1', display_name: '离心' }],
    departments: [{ id: 'department-1', name: '运营部' }],
    transcripts: [{
      audio_record_id: 'record-1',
      corrected_text: '旧文本',
      segments_json: [
        { id: 'seg-1', startMs: 12345, endMs: 15000, speaker: 'Speaker 1', text: '第一段重点' },
        { id: 'seg-2', startMs: 18000, endMs: 21000, speaker: '同事', text: '第二段行动项' },
      ],
      speaker_aliases_json: { 'Speaker 1': '离心' },
    }],
    summaries: [],
    followup_forms: [],
  });

  const markdown = buildExportText(record, store, 'transcript', true);
  assert.match(markdown, /## 逐字稿/);
  assert.match(markdown, /\[00:12\] \*\*离心\*\*：第一段重点/);
  assert.match(markdown, /\[00:18\] \*\*同事\*\*：第二段行动项/);
  assert.doesNotMatch(markdown, /旧文本/);

  const plain = buildExportText(record, store, 'transcript', false);
  assert.match(plain, /00:12 离心：第一段重点/);
});

test('overview card and mind map exports can be downloaded separately', () => {
  const record = {
    id: 'record-2',
    owner_employee_id: 'employee-1',
    owner_department_id: 'department-1',
    title: '产品会议',
    created_at: '2026-06-17T08:00:00.000Z',
    source_type: 'manual_upload',
    template_type: 'meeting_minutes',
    followup_type: 'none',
  };
  const store = fakeStore({
    employees: [{ id: 'employee-1', display_name: '离心' }],
    departments: [{ id: 'department-1', name: '运营部' }],
    summaries: [{
      audio_record_id: 'record-2',
      summary_markdown: '# 文字总结\n- 不应出现在独立卡片导出',
      overview_card_json: {
        heroTitle: '产品会议重点卡片',
        cards: [{ title: '关键结论', items: ['继续优化录音助手'] }],
      },
      mind_map_json: {
        title: '产品会议思维导图',
        center: '录音助手',
        branches: [{ title: '体验', children: [{ title: '逐字稿对照', items: ['点击跳转'] }] }],
      },
    }],
    transcripts: [{
      audio_record_id: 'record-2',
      corrected_text: '不应出现在独立导出',
      segments_json: [{ startMs: 0, speaker: 'Speaker 1', text: '逐字稿内容' }],
      speaker_aliases_json: {},
    }],
    followup_forms: [],
  });

  const card = buildExportText(record, store, 'overview_card', true);
  assert.match(card, /## 总结卡片/);
  assert.match(card, /产品会议重点卡片/);
  assert.doesNotMatch(card, /文字重点总结|逐字稿|思维导图/);

  const mindMap = buildExportText(record, store, 'mind_map', true);
  assert.match(mindMap, /## 思维导图/);
  assert.match(mindMap, /产品会议思维导图/);
  assert.doesNotMatch(mindMap, /## 总结卡片|## 逐字稿/);

  const cardSvg = buildExportSvg(record, store, 'overview_card');
  assert.match(cardSvg, /^<\?xml version="1\.0"/);
  assert.match(cardSvg, /<svg[^>]+width="1200"/);
  assert.match(cardSvg, /产品会议重点卡片/);
  assert.match(cardSvg, /继续优化录音助手/);

  const mindMapSvg = buildExportSvg(record, store, 'mind_map');
  assert.match(mindMapSvg, /<svg[^>]+width="1400"/);
  assert.match(mindMapSvg, /产品会议思维导图/);
  assert.match(mindMapSvg, /中心主题/);
});

test('summary docx and pdf combine visual card, text summary, and mind map', () => {
  const record = {
    id: 'record-3',
    owner_employee_id: 'employee-1',
    owner_department_id: 'department-1',
    title: '产品会议',
    created_at: '2026-06-17T08:00:00.000Z',
    source_type: 'manual_upload',
    template_type: 'meeting_minutes',
    followup_type: 'none',
  };
  const store = fakeStore({
    employees: [{ id: 'employee-1', display_name: '离心' }],
    departments: [{ id: 'department-1', name: '运营部' }],
    summaries: [{
      audio_record_id: 'record-3',
      summary_markdown: '# 文字重点总结\n- 继续优化录音助手',
      overview_card_json: {
        heroTitle: '产品会议重点卡片',
        cards: [{ title: '关键结论', items: ['继续优化录音助手'] }],
      },
      mind_map_json: {
        title: '产品会议思维导图',
        center: '录音助手',
        branches: [{ title: '体验', children: [{ title: '逐字稿对照', items: ['点击跳转'] }] }],
      },
    }],
    transcripts: [],
    followup_forms: [],
  });
  const markdown = buildExportText(record, store, 'summary', true);
  const html = buildSummaryExportHtml(record, store);
  assert.match(html, /data-section="overview-card"/);
  assert.match(html, /data-section="summary-markdown"/);
  assert.match(html, /data-section="mind-map"/);
  assert.match(html, /产品会议重点卡片/);
  assert.match(html, /产品会议思维导图/);

  const docx = createSummaryDocxBuffer(record, store, markdown);
  assert.equal(docx.subarray(0, 2).toString(), 'PK');
  assert.ok(docx.includes(Buffer.from('word/media/summary-card.svg')));
  assert.ok(docx.includes(Buffer.from('word/media/mind-map.svg')));
  assert.ok(docx.includes(Buffer.from('rIdImage1')));
  assert.ok(docx.includes(Buffer.from('rIdImage2')));

  const pdf = createSummaryPdfBuffer(record, store, markdown);
  assert.equal(pdf.subarray(0, 5).toString(), '%PDF-');
  assert.ok(pdf.byteLength > 1000);
});

test('legacy topic children mind map exports without regeneration', () => {
  const record = {
    id: 'record-4',
    owner_employee_id: 'employee-1',
    owner_department_id: 'department-1',
    title: '家具广告合作沟通',
    created_at: '2026-06-17T08:00:00.000Z',
    source_type: 'web_capture',
    template_type: 'meeting_minutes',
    followup_type: 'none',
  };
  const store = fakeStore({
    employees: [{ id: 'employee-1', display_name: '离心' }],
    departments: [{ id: 'department-1', name: '运营部' }],
    summaries: [{
      audio_record_id: 'record-4',
      summary_markdown: '# 文字纪要',
      overview_card_json: {},
      mind_map_json: { topic: '家具广告合作沟通', children: [] },
    }],
    transcripts: [],
    followup_forms: [],
  });

  const markdown = buildExportText(record, store, 'mind_map', true);
  assert.match(markdown, /家具广告合作沟通/);
  assert.doesNotMatch(markdown, /暂无思维导图/);

  const svg = buildExportSvg(record, store, 'mind_map');
  assert.match(svg, /家具广告合作沟通/);

  const html = buildSummaryExportHtml(record, store);
  assert.match(html, /家具广告合作沟通/);
  assert.doesNotMatch(html, /暂无思维导图/);
});
