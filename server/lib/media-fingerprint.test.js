const test = require('node:test');
const assert = require('node:assert/strict');
const {
  isVolatileMediaQueryParam,
  mediaUrlFingerprint,
  normalizeMediaUrlForFingerprint,
} = require('./media-fingerprint');

test('normalizes signed media URLs before fingerprinting', () => {
  const first = 'https://a.com/audio?id=1&token=aaa';
  const second = 'https://a.com/audio?token=bbb&id=1';

  assert.equal(normalizeMediaUrlForFingerprint(first), 'https://a.com/audio?id=1');
  assert.equal(normalizeMediaUrlForFingerprint(second), 'https://a.com/audio?id=1');
  assert.equal(mediaUrlFingerprint(first), mediaUrlFingerprint(second));
});

test('keeps business query params that identify different recordings', () => {
  assert.notEqual(
    mediaUrlFingerprint('https://a.com/audio?id=1'),
    mediaUrlFingerprint('https://a.com/audio?id=2')
  );
});

test('classifies volatile media query params', () => {
  assert.equal(isVolatileMediaQueryParam('X-Amz-Signature'), true);
  assert.equal(isVolatileMediaQueryParam('response-content-disposition'), true);
  assert.equal(isVolatileMediaQueryParam('_t'), true);
  assert.equal(isVolatileMediaQueryParam('recordId'), false);
  assert.equal(isVolatileMediaQueryParam('audioId'), false);
});
