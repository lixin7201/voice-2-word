const test = require('node:test');
const assert = require('node:assert/strict');
const {
  candidateKey,
  candidateFromUrl,
  getDiagnostics,
  headerValue,
  isVolatileQueryParam,
  mergeCandidates,
  resetListeningState,
  sizeFromResponseHeaders,
  stripQuery,
  totalSizeFromContentRange,
} = require('../background');

test('detects direct and signed audio candidates from URL or content type', () => {
  const direct = candidateFromUrl('https://example.com/records/call.mp3?token=abc', 'audio');
  assert.equal(direct.type, 'mp3');
  assert.equal(direct.uploadable, true);
  assert.equal(stripQuery(direct.url), 'https://example.com/records/call.mp3');

  const signed = candidateFromUrl('https://example.com/download?id=42', 'network:xmlhttprequest', {
    contentType: 'audio/mpeg; charset=binary',
    size: 1024,
  });
  assert.equal(signed.type, 'mp3');
  assert.equal(signed.name, 'download.mp3');
  assert.equal(signed.uploadable, true);
});

test('detects Plaud-style binary downloads and disposition filenames', () => {
  const disposition = candidateFromUrl('https://web.plaud.cn/api/file?id=abc', 'network:xmlhttprequest', {
    contentType: 'application/octet-stream',
    contentDisposition: 'attachment; filename="0ba0d1558bd6dcd2723bcab64a3c9799.mp3"',
    size: 2 * 1024 * 1024,
  });
  assert.equal(disposition.type, 'mp3');
  assert.equal(disposition.uploadable, true);
  assert.equal(disposition.name, '0ba0d1558bd6dcd2723bcab64a3c9799.mp3');

  const binary = candidateFromUrl('https://web.plaud.cn/api/object?id=recording-1', 'network:xmlhttprequest', {
    contentType: 'application/octet-stream',
    size: 2 * 1024 * 1024,
  });
  assert.equal(binary.type, 'media');
  assert.equal(binary.uploadable, true);
});

test('ignores Plaud account APIs that are not recording media', () => {
  assert.equal(candidateFromUrl('https://api.plaud.cn/user/me', 'performance:fetch', {
    size: 256 * 1024,
  }), null);
  assert.equal(candidateFromUrl('https://api.plaud.cn/user-app/profile/account/me', 'performance:fetch', {
    size: 256 * 1024,
  }), null);
});

test('detects page-level recording hints without standard file extensions', () => {
  const plaudHint = candidateFromUrl('https://web.plaud.cn/api/file?id=abc', 'page-link');
  assert.equal(plaudHint.type, 'media');
  assert.equal(plaudHint.uploadable, false);
  assert.equal(plaudHint.lowConfidence, true);
  assert.match(plaudHint.unsupportedReason, /缺少可确认的音频文件信息/);

  const downloadHint = candidateFromUrl('https://example.com/api/download?recordId=42', 'page-link');
  assert.equal(downloadHint.type, 'media');
  assert.equal(downloadHint.uploadable, false);
  assert.equal(downloadHint.lowConfidence, true);

  const genericResource = candidateFromUrl('https://example.com/api/resource?id=42', 'page-link');
  assert.equal(genericResource, null);
});

test('ignores tiny hint-only media responses before they can become primary recordings', () => {
  const tinyNetworkHint = candidateFromUrl('https://web.plaud.cn/api/file?id=tiny', 'network:media', {
    size: 2 * 1024,
  });
  assert.equal(tinyNetworkHint, null);

  const largerUnknownMedia = candidateFromUrl('https://example.com/media?id=maybe', 'network:media', {
    size: 2 * 1024 * 1024,
  });
  assert.equal(largerUnknownMedia.uploadable, true);
  assert.equal(largerUnknownMedia.lowConfidence, false);
});

test('uses Content-Range totals for partial media responses', () => {
  assert.equal(totalSizeFromContentRange('bytes 0-2047/73400320'), 73400320);
  assert.equal(totalSizeFromContentRange('bytes */73400320'), 73400320);
  assert.equal(totalSizeFromContentRange('bytes 0-2047/*'), 0);

  const size = sizeFromResponseHeaders([
    { name: 'Content-Length', value: '2048' },
    { name: 'Content-Range', value: 'bytes 0-2047/73400320' },
  ]);
  assert.equal(size.size, 73400320);
  assert.equal(size.contentLength, 2048);
  assert.equal(size.rangeSize, 73400320);

  const partial = candidateFromUrl('https://web.plaud.cn/api/file?id=thirty-minutes', 'network:media', {
    size: size.size,
    rangeSize: size.rangeSize,
  });
  assert.equal(partial.uploadable, true);
  assert.equal(partial.size, 73400320);
  assert.equal(partial.rangeSize, 73400320);
});

test('prioritizes the current page recording candidate', () => {
  const current = candidateFromUrl('https://web.plaud.cn/api/file?id=current', 'network:xmlhttprequest', {
    contentType: 'audio/mpeg',
    recordingTitle: '2026-06-12 11:14:48',
    current: true,
    size: 1024,
  });
  const old = candidateFromUrl('https://web.plaud.cn/api/file?id=old', 'network:xmlhttprequest', {
    contentType: 'audio/mpeg',
    size: 8 * 1024 * 1024,
  });
  const merged = mergeCandidates([old, current]);
  assert.equal(merged[0].url, current.url);
  assert.equal(merged[0].recordingTitle, '2026-06-12 11:14:48');
});

test('marks playlists and blob URLs as detected but not directly uploadable', () => {
  const playlist = candidateFromUrl('https://example.com/live/audio.m3u8', 'network:media', {
    contentType: 'application/vnd.apple.mpegurl',
  });
  assert.equal(playlist.type, 'm3u8');
  assert.equal(playlist.uploadable, false);
  assert.match(playlist.unsupportedReason, /播放列表/);

  const blob = candidateFromUrl('blob:https://example.com/123', 'video');
  assert.equal(blob.type, 'blob');
  assert.equal(blob.uploadable, false);
  assert.match(blob.unsupportedReason, /blob/);
});

test('ignores static assets and media segments that are not standalone recordings', () => {
  assert.equal(candidateFromUrl('https://example.com/logo.png', 'network:other'), null);
  assert.equal(candidateFromUrl('https://example.com/chunk/file.m4s', 'network:media'), null);
  assert.equal(candidateFromUrl('https://example.com/page', 'network:xmlhttprequest', {
    contentType: 'text/html',
  }), null);
});

test('keeps meaningful query params so multiple recordings are not collapsed', () => {
  const first = candidateFromUrl('https://example.com/audio?id=1', 'network:media', {
    contentType: 'audio/mpeg',
    size: 1,
  });
  const second = candidateFromUrl('https://example.com/audio?id=2', 'network:media', {
    contentType: 'audio/mpeg',
    size: 2,
  });
  const merged = mergeCandidates([first, second]);
  assert.equal(merged.length, 2);
  assert.notEqual(candidateKey(first.url), candidateKey(second.url));
});

test('merges volatile signed URL variants and prefers richer network responses', () => {
  const pageCandidate = candidateFromUrl('https://example.com/audio?id=1&token=old', 'page-link');
  const networkCandidate = candidateFromUrl('https://example.com/audio?X-Amz-Signature=abc&id=1&X-Amz-Expires=300', 'network:media', {
    contentType: 'audio/mpeg',
    size: 2,
  });
  const merged = mergeCandidates([pageCandidate, networkCandidate]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].source, 'network:media');
  assert.equal(merged[0].type, 'mp3');
  assert.equal(candidateKey(pageCandidate.url), 'https://example.com/audio?id=1');
  assert.equal(candidateKey(networkCandidate.url), 'https://example.com/audio?id=1');
});

test('reads response headers case-insensitively', () => {
  assert.equal(headerValue([{ name: 'Content-Type', value: 'audio/mpeg' }], 'content-type'), 'audio/mpeg');
});

test('classifies volatile query params used by signed media URLs', () => {
  assert.equal(isVolatileQueryParam('X-Amz-Signature'), true);
  assert.equal(isVolatileQueryParam('token'), true);
  assert.equal(isVolatileQueryParam('id'), false);
  assert.equal(isVolatileQueryParam('recordId'), false);
});

test('background diagnostics expose listener and scan state fields', () => {
  resetListeningState();
  const diagnostics = getDiagnostics();
  assert.equal(Object.prototype.hasOwnProperty.call(diagnostics, 'listeningTabId'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(diagnostics, 'listeningTabUrl'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(diagnostics, 'activeTabUrl'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(diagnostics, 'globalStatePhase'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(diagnostics, 'candidatesCount'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(diagnostics, 'networkCandidateCountForTab'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(diagnostics, 'lastCandidateAt'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(diagnostics, 'lastContentScriptError'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(diagnostics, 'lastScanAction'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(diagnostics, 'lastScanError'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(diagnostics, 'serviceWorkerStartedAt'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(diagnostics, 'extensionVersion'), true);
  assert.equal(Object.prototype.hasOwnProperty.call(diagnostics, 'manifestHostPermissions'), true);
});

test('resetting the listener clears candidate diagnostics', () => {
  resetListeningState();
  const diagnostics = getDiagnostics();
  assert.equal(diagnostics.globalStatePhase, 'idle');
  assert.equal(diagnostics.candidatesCount, 0);
  assert.equal(diagnostics.lastCandidateAt, '');
});
