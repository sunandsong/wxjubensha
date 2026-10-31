// 小程序自测：不依赖开发者工具，node test/selftest.js 直接跑。
// 覆盖两类我实际踩过的坑：wxml 标签没配平、资料门判断漏过某些昵称。
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ROOT = path.join(__dirname, '..');

// ── 1. wxml 标签配平（node --check 只管 JS，管不了 wxml）──
function checkWxml(file) {
  let s = fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->/g, '');
  const SELF = new Set(['image', 'input', 'icon', 'br', 'hr', 'import', 'include', 'wxs']);
  const stack = [];
  const bad = [];
  for (const m of s.matchAll(/<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g)) {
    const [, close, tag, , self] = m;
    const line = s.slice(0, m.index).split('\n').length;
    if (self || SELF.has(tag)) continue;
    if (close) {
      if (stack.length && stack[stack.length - 1][0] === tag) stack.pop();
      else bad.push(`${path.relative(ROOT, file)}:${line} 多余的 </${tag}>`);
    } else stack.push([tag, line]);
  }
  for (const [t, l] of stack) bad.push(`${path.relative(ROOT, file)}:${l} <${t}> 未闭合`);
  return bad;
}

const wxmls = [];
(function walk(d) {
  for (const f of fs.readdirSync(d)) {
    const p = path.join(d, f);
    if (f === 'node_modules' || f.startsWith('.')) continue;
    if (fs.statSync(p).isDirectory()) walk(p);
    else if (f.endsWith('.wxml')) wxmls.push(p);
  }
})(ROOT);
const tagErrors = wxmls.flatMap(checkWxml);
assert.deepStrictEqual(tagErrors, [], '\n' + tagErrors.join('\n'));

// ── 2. 资料门：加载 app.js，用内存 storage 跑判断 ──
function loadApp(storage = {}) {
  let captured = null;
  global.wx = {
    getStorageSync: (k) => (k in storage ? storage[k] : ''),
    setStorageSync: (k, v) => { storage[k] = v; },
    removeStorageSync: (k) => { delete storage[k]; },
    request: () => {}, login: () => {}, cloud: {},
    env: { USER_DATA_PATH: '/tmp' },
    getFileSystemManager: () => ({}),
  };
  global.App = (o) => { captured = o; };
  global.getApp = () => captured;
  delete require.cache[require.resolve(path.join(ROOT, 'app.js'))];
  require(path.join(ROOT, 'app.js'));
  return { app: captured, storage };
}

// 自动补的占位昵称都要认出来，否则门会被绕过
{
  const { app } = loadApp();
  for (const n of ['', '玩家37', '玩家99', '玩家F', '玩家A']) {
    assert.strictEqual(app.isAutoNick(n), true, `「${n}」应判为系统占位昵称`);
  }
  for (const n of ['阿强', '小美', '张松', 'Bob']) {
    assert.strictEqual(app.isAutoNick(n), false, `「${n}」是真名，不该判成占位`);
  }
}

// 没设过名 → 必须拦；设过 → 放行。注意不能靠昵称长相判断
{
  let { app, storage } = loadApp({ nick: '玩家F' });       // 测试身份残留
  assert.strictEqual(app.isDefaultNick(), true, '测试身份残留的昵称必须拦住');

  ({ app, storage } = loadApp({ nick: '阿强' }));          // 老用户，没打过标记
  assert.strictEqual(app.isDefaultNick(), true, '没确认过的老用户要问一次');

  ({ app, storage } = loadApp({ nick: '阿强', nickSet: 1 }));
  assert.strictEqual(app.isDefaultNick(), false, '确认过就不再问');
}

// ensureProfile 补的默认昵称，自己必须认得出来（否则门永远不触发）
{
  const { app, storage } = loadApp();
  const { nick, avatar } = app.ensureProfile();
  assert.ok(app.isAutoNick(nick), `ensureProfile 补的「${nick}」必须被 isAutoNick 认出`);
  assert.strictEqual(app.isDefaultNick(), true, '补完默认资料仍算没设过名');
  assert.ok(avatar, '默认头像不能为空');
}

console.log(`✅ wxml 配平 ${wxmls.length} 个文件 · 资料门判断全部通过`);
