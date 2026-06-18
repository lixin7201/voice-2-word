const crypto = require('node:crypto');

function isVolatileMediaQueryParam(key) {
  const normalized = String(key || '').toLowerCase();
  return (
    normalized === 'token' ||
    normalized === 'access_token' ||
    normalized === 'auth' ||
    normalized === 'authorization' ||
    normalized === 'signature' ||
    normalized === 'sig' ||
    normalized === 'expires' ||
    normalized === 'expires_at' ||
    normalized === 'expiration' ||
    normalized === 'policy' ||
    normalized === 'credential' ||
    normalized === 'date' ||
    normalized === 'security-token' ||
    normalized.startsWith('x-amz-') ||
    normalized.startsWith('x-oss-') ||
    normalized.startsWith('response-') ||
    normalized.startsWith('_')
  );
}

function normalizeMediaUrlForFingerprint(url) {
  const value = String(url || '').trim();
  if (!value) return '';
  try {
    const parsed = new URL(value);
    parsed.hash = '';
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (isVolatileMediaQueryParam(key)) parsed.searchParams.delete(key);
    }
    parsed.searchParams.sort();
    return parsed.toString();
  } catch {
    return value.split('#')[0];
  }
}

function mediaUrlFingerprint(url) {
  const normalized = normalizeMediaUrlForFingerprint(url);
  return normalized ? sha256(normalized) : '';
}

function rawMediaUrlFingerprint(url) {
  const value = String(url || '').trim();
  return value ? sha256(value) : '';
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

module.exports = {
  isVolatileMediaQueryParam,
  mediaUrlFingerprint,
  normalizeMediaUrlForFingerprint,
  rawMediaUrlFingerprint,
};
