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

async function putR2Object(config, key, buffer, contentType, fetchImpl = fetch) {
  const url = presignR2Url(config, {
    method: 'PUT',
    key,
    expiresIn: 3600,
  });
  const response = await fetchImpl(url, {
    method: 'PUT',
    headers: contentType ? { 'Content-Type': contentType } : {},
    body: buffer,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`R2 上传失败：HTTP ${response.status}${text ? ` ${text.slice(0, 180)}` : ''}`);
  }
  return { key };
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
  return encodeURIComponent(value).replace(/%2F/g, '/');
}

function encodeObjectKey(key) {
  return String(key)
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

function canonicalQueryString(query) {
  return Object.entries(query)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join('&');
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
  isR2Configured,
  presignR2Url,
  putR2Object,
};
