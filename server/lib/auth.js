const crypto = require('node:crypto');

const TOKEN_TTL_SECONDS = 60 * 60 * 12;

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.pbkdf2Sync(password, salt, 120000, 32, 'sha256').toString('hex');
  return `pbkdf2$${salt}$${hash}`;
}

function verifyPassword(password, storedHash) {
  const [method, salt, hash] = String(storedHash || '').split('$');
  if (method !== 'pbkdf2' || !salt || !hash) return false;
  const incoming = hashPassword(password, salt).split('$')[2];
  const left = Buffer.from(incoming, 'hex');
  const right = Buffer.from(hash, 'hex');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function base64Url(input) {
  return Buffer.from(input).toString('base64url');
}

function signToken(payload, secret, ttlSeconds = TOKEN_TTL_SECONDS) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const body = { ...payload, iat: now, exp: now + ttlSeconds };
  const unsigned = `${base64Url(JSON.stringify(header))}.${base64Url(JSON.stringify(body))}`;
  const signature = crypto.createHmac('sha256', secret).update(unsigned).digest('base64url');
  return `${unsigned}.${signature}`;
}

function verifyToken(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [header, body, signature] = parts;
  const unsigned = `${header}.${body}`;
  const expected = crypto.createHmac('sha256', secret).update(unsigned).digest('base64url');
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (payload.exp && payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

module.exports = {
  hashPassword,
  signToken,
  verifyPassword,
  verifyToken,
};
