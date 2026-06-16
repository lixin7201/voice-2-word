const test = require('node:test');
const assert = require('node:assert/strict');
const {
  candidateKey,
  candidateFromUrl,
  headerValue,
  isVolatileQueryParam,
  mergeCandidates,
  stripQuery,
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
  const pageCandidate = candidateFromUrl('https://example.com/audio?id=1&token=old', 'page-link', { size: 1 });
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
