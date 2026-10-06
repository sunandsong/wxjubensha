// 云函数 jbs —— 群本玩后端的 HTTP 入口（部署在人生清单环境，与它的 api 函数并列、互不干扰）
//   POST /jbs/login  { code }          wx.login 的 code → code2session → openid → 签 JWT
//   POST /jbs/call   { action, ... }   带 Authorization: Bearer <token>，转给 game.js 处理
// 环境变量：WX_APPID / WX_APPSECRET / JWT_SECRET / ADMIN_KEY / CLOUDBASE_ENV_ID
const https = require('https');
const { signJwt, verifyJwt } = require('./jwt');
const { ensureCollections } = require('./cloud');
const game = require('./game');

const { WX_APPID, WX_APPSECRET, JWT_SECRET } = process.env;

const reply = (statusCode, data) => ({
  statusCode,
  headers: { 'content-type': 'application/json; charset=utf-8' },
  body: JSON.stringify(data),
  isBase64Encoded: false,
});

function getJson(url) {
  return new Promise((resolve, reject) => {
    https.get(url, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

function parseBody(event) {
  if (!event.body) return {};
  const text = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  try { return JSON.parse(text) || {}; } catch (e) { return {}; }
}

exports.main = async (event) => {
  if (!JWT_SECRET) return reply(500, { ok: false, msg: '服务未配置 JWT_SECRET' });
  const path = String(event.path || '').split('?')[0].replace(/\/+$/, '');
  const method = String(event.httpMethod || 'GET').toUpperCase();
  if (method !== 'POST') return reply(405, { ok: false, msg: 'method not allowed' });
  const body = parseBody(event);

  if (path.endsWith('/login')) {
    if (!body.code) return reply(400, { ok: false, msg: '缺少 code' });
    const r = await getJson(
      `https://api.weixin.qq.com/sns/jscode2session?appid=${WX_APPID}&secret=${WX_APPSECRET}` +
      `&js_code=${encodeURIComponent(body.code)}&grant_type=authorization_code`
    ).catch(() => null);
    if (!r || !r.openid) return reply(401, { ok: false, msg: '登录失败', errcode: r && r.errcode });
    // 不设过期：openid 永久不变，玩派对游戏没必要踢人重登
    return reply(200, { ok: true, openid: r.openid, token: signJwt({ sub: r.openid }, JWT_SECRET) });
  }

  if (path.endsWith('/call')) {
    const auth = (event.headers && (event.headers.authorization || event.headers.Authorization)) || '';
    const payload = verifyJwt(auth.replace(/^Bearer\s+/i, ''), JWT_SECRET);
    if (!payload || !payload.sub) return reply(401, { ok: false, msg: 'unauthorized' });
    await ensureCollections(['rooms', 'scripts', 'spySecrets']);
    return reply(200, await game.handle(body, payload.sub));
  }

  return reply(404, { ok: false, msg: 'not found' });
};
