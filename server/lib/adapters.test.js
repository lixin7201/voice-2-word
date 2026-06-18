const test = require('node:test');
const assert = require('node:assert/strict');
const { DEFAULT_TASK_TIMEOUT_MS, normalizeDashScopeTranscription, waitForDashScopeTask } = require('./dashscope');
const { chatCompletionsUrl } = require('./llm');
const { presignR2Url } = require('./r2');
const { detectRecruitmentStage } = require('./templates');
const { normalizeMindMap } = require('./mind-map');

test('detects recruitment follow-up stages from transcript wording', () => {
  assert.equal(detectRecruitmentStage('客户说暂时不招人，招满了，下个月再看看。'), 'no_hiring_followup');
  assert.equal(detectRecruitmentStage('已经添加微信，营业执照也发了，准备发布岗位。'), 'mid_effective_followup');
  assert.equal(detectRecruitmentStage('客户问会员套餐报价和合同权益。'), 'mid_late_effective_followup');
  assert.equal(detectRecruitmentStage('已开通会员，现在复盘招聘效果和续费。'), 'late_effective_followup');
});

test('normalizes DashScope transcription result into transcript fields', () => {
  const normalized = normalizeDashScopeTranscription({
    properties: { original_duration_in_milliseconds: 2500 },
    transcripts: [
      {
        text: '你好，这里是大宜宾。',
        sentences: [
          { begin_time: 0, end_time: 1200, text: '你好。', sentence_id: 1, speaker_id: 0 },
          { begin_time: 1300, end_time: 2500, text: '这里是大宜宾。', sentence_id: 2, speaker_id: 1 },
        ],
      },
    ],
  });

  assert.equal(normalized.rawText, '你好，这里是大宜宾。');
  assert.equal(normalized.durationMs, 2500);
  assert.deepEqual(normalized.segments.map((segment) => segment.speaker), ['Speaker 0', 'Speaker 1']);
});

test('queries DashScope task with the default fetch implementation', async () => {
  const originalFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return {
      ok: true,
      json: async () => ({
        output: {
          task_status: 'SUCCEEDED',
          results: [
            {
              subtask_status: 'SUCCEEDED',
              transcription_url: 'https://dashscope.example/result.json',
            },
          ],
        },
      }),
    };
  };

  try {
    const result = await waitForDashScopeTask({
      dashscopeApiKey: 'test-key',
      dashscopeTimeoutMs: 100,
      dashscopePollIntervalMs: 1,
    }, 'https://dashscope.example/api/v1', 'task-1');

    assert.equal(result.output.task_status, 'SUCCEEDED');
    assert.equal(calls[0].url, 'https://dashscope.example/api/v1/tasks/task-1');
    assert.equal(calls[0].options.headers.Authorization, 'Bearer test-key');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('DashScope default task timeout covers long recordings', () => {
  assert.ok(DEFAULT_TASK_TIMEOUT_MS >= 13 * 60 * 60 * 1000);
});

test('creates Cloudflare R2 presigned S3-compatible URLs', () => {
  const url = presignR2Url({
    r2AccountId: 'account-id',
    r2AccessKeyId: 'access-key',
    r2SecretAccessKey: 'secret-key',
    r2Bucket: 'voice-bucket',
  }, {
    method: 'GET',
    key: 'audio/2026-06-16/测试 文件.mp3',
    now: new Date('2026-06-16T00:00:00.000Z'),
    expiresIn: 7200,
  });

  assert.ok(url.startsWith('https://account-id.r2.cloudflarestorage.com/voice-bucket/audio/2026-06-16/'));
  assert.ok(url.includes('X-Amz-Algorithm=AWS4-HMAC-SHA256'));
  assert.ok(url.includes('X-Amz-Expires=7200'));
  assert.ok(url.includes('X-Amz-Signature='));
});

test('accepts LLM base URLs with or without /v1', () => {
  assert.equal(chatCompletionsUrl('https://api.moonshot.cn'), 'https://api.moonshot.cn/v1/chat/completions');
  assert.equal(chatCompletionsUrl('https://api.moonshot.cn/v1'), 'https://api.moonshot.cn/v1/chat/completions');
});

test('normalizes legacy mind map shapes into internal branches', () => {
  const topicMap = normalizeMindMap({ topic: '家具广告合作沟通', children: [] }, '录音');
  assert.equal(topicMap.center, '家具广告合作沟通');
  assert.equal(topicMap.branches.length, 1);
  assert.equal(topicMap.branches[0].title, '家具广告合作沟通');

  const nodesMap = normalizeMindMap({ center: '中心', nodes: [{ label: '分支', nodes: ['要点'] }] });
  assert.equal(nodesMap.branches[0].title, '分支');
  assert.equal(nodesMap.branches[0].children[0].title, '要点');
});
