const crypto = require('node:crypto');

const REGION = 'auto';
const SERVICE = 's3';

function isR2Configured(config) {
  return Boolean(
    config.r2AccountId &&
    config.r2AccessKeyId &&
    config.r2SecretAccessKey &&
    config.r2Bucket
  );
}

function r2Endpoint(config) {
  return (config.r2Endpoint || `https://${config.r2AccountId}.r2.cloudflarestorage.com`).replace(/\/$/, '');
}

async function putR2Object(config, key, body, contentType, fetchImpl = fetch, options = {}) {
  const url = presignR2Url(config, {
    method: 'PUT',
    key,
    expiresIn: 3600,
  });
  const headers = {};
  if (contentType) headers['Content-Type'] = contentType;
  if (Number.isFinite(options.contentLength)) headers['Content-Length'] = String(options.contentLength);
  const requestOptions = {
    method: 'PUT',
    headers,
    body,
  };
  if (body && typeof body.pipe === 'function') requestOptions.duplex = 'half';
  const response = await fetchImpl(url, {
    ...requestOptions,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`R2 上传失败：HTTP ${response.status}${text ? ` ${text.slice(0, 180)}` : ''}`);
  }
  return { key };
}

async function deleteR2Object(config, key, fetchImpl = fetch) {
  if (!key) return { key, skipped: true };
  const url = presignR2Url(config, {
    method: 'DELETE',
    key,
    expiresIn: 3600,
  });
  const response = await fetchImpl(url, { method: 'DELETE' });
  if (!response.ok && response.status !== 404) {
    const text = await response.text().catch(() => '');
    throw new Error(`R2 删除失败：${key} HTTP ${response.status}${text ? ` ${text.slice(0, 180)}` : ''}`);
  }
  return { key };
}

async function deleteR2Objects(config, keys, fetchImpl = fetch) {
  const results = [];
  for (const key of [...new Set((keys || []).filter(Boolean))]) {
    results.push(await deleteR2Object(config, key, fetchImpl));
  }
  return results;
}

function presignR2Url(config, options) {
  if (!isR2Configured(config)) throw new Error('R2 环境变量未配置完整');
  const method = options.method || 'GET';
  const expiresIn = Math.min(Math.max(Number(options.expiresIn || 7200), 1), 604800);
  const now = options.now || new Date();
  const amzDate = toAmzDate(now);
  const dateStamp = amzDate.slice(0, 8);
  const credentialScope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const endpoint = new URL(r2Endpoint(config));
  const objectPath = `/${encodePathSegment(config.r2Bucket)}/${encodeObjectKey(options.key)}`;
  const query = {
    'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
    'X-Amz-Credential': `${config.r2AccessKeyId}/${credentialScope}`,
    'X-Amz-Date': amzDate,
    'X-Amz-Expires': String(expiresIn),
    'X-Amz-SignedHeaders': 'host',
  };
  const canonicalQuery = canonicalQueryString(query);
  const canonicalRequest = [
    method,
    objectPath,
    canonicalQuery,
    `host:${endpoint.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256Hex(canonicalRequest),
  ].join('\n');
  const signature = hmac(signingKey(config.r2SecretAccessKey, dateStamp), stringToSign, 'hex');
  return `${endpoint.origin}${objectPath}?${canonicalQuery}&X-Amz-Signature=${signature}`;
}

function toAmzDate(date) {
  return date.toISOString().replace(/[:-]|\.\d{3}/g, '');
}

function encodePathSegment(value) {
  return awsUriEncode(value).replace(/%2F/g, '/');
}

function encodeObjectKey(key) {
  return String(key)
    .split('/')
    .map((segment) => awsUriEncode(segment))
    .join('/');
}

function canonicalQueryString(query) {
  return Object.entries(query)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${awsUriEncode(key)}=${awsUriEncode(value)}`)
    .join('&');
}

function awsUriEncode(value) {
  return encodeURIComponent(String(value))
    .replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

function signingKey(secret, dateStamp) {
  const dateKey = hmac(`AWS4${secret}`, dateStamp);
  const regionKey = hmac(dateKey, REGION);
  const serviceKey = hmac(regionKey, SERVICE);
  return hmac(serviceKey, 'aws4_request');
}

function hmac(key, value, encoding) {
  return crypto.createHmac('sha256', key).update(value).digest(encoding);
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

module.exports = {
  deleteR2Object,
  deleteR2Objects,
  isR2Configured,
  presignR2Url,
  putR2Object,
};
