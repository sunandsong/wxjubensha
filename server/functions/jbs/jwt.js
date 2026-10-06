// 极简 HS256 JWT（Node crypto，无外部依赖）。照人生清单 backend/src/jwt.ts 的 JS 版。
const { createHmac, timingSafeEqual } = require('crypto');

const b64url = (input) => Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const b64urlDecode = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');

function signJwt(payload, secret, expiresInSec) {
  const now = Math.floor(Date.now() / 1000);
  const body = expiresInSec == null ? { ...payload, iat: now } : { ...payload, iat: now, exp: now + expiresInSec };
  const data = `${b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))}.${b64url(JSON.stringify(body))}`;
  return `${data}.${b64url(createHmac('sha256', secret).update(data).digest())}`;
}

function verifyJwt(token, secret) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts;
  const expected = b64url(createHmac('sha256', secret).update(`${h}.${p}`).digest());
  if (s.length !== expected.length || !timingSafeEqual(Buffer.from(s), Buffer.from(expected))) return null;
  try {
    const payload = JSON.parse(b64urlDecode(p));
    if (payload.exp && Math.floor(Date.now() / 1000) > payload.exp) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

module.exports = { signJwt, verifyJwt };
