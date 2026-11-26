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

// 没设过名 → 要提示；设过 → 不提示。注意不能靠昵称长相判断
{
  let { app, storage } = loadApp({ nick: '玩家F' });       // 测试身份残留
  assert.strictEqual(app.isDefaultNick(), true, '测试身份残留的昵称要提示改名');

  ({ app, storage } = loadApp({ nick: '阿强' }));          // 老用户，没打过标记
  assert.strictEqual(app.isDefaultNick(), true, '没确认过的老用户也提示一下');

  ({ app, storage } = loadApp({ nick: '阿强', nickSet: 1 }));
  assert.strictEqual(app.isDefaultNick(), false, '自己设过名就不再提示');
}

// ensureProfile 补的默认资料不能把人算成「设过名」，否则小手引导永远不出来
{
  const { app, storage } = loadApp();
  const { nick, avatar } = app.ensureProfile();
  assert.ok(/^玩家\d+$/.test(nick), `ensureProfile 该补「玩家NN」，实际「${nick}」`);
  assert.strictEqual(app.isDefaultNick(), true, '补完默认资料仍算没设过名');
  assert.ok(avatar, '默认头像不能为空');
}

// ── 3. 资料弹窗不许自动弹，且必须留出口 ──
// 2026-11-23 以「登录环节未提供可取消按钮、强制登录才能体验、反复弹窗」打回；
// 改成「可跳过的一次性弹窗」后 2026-11-27 又被判强制登录。现在彻底不自动弹。
function profileGateHasExit() {
  const wxml = fs.readFileSync(path.join(ROOT, 'pages/hub/hub.wxml'), 'utf8');
  const js = fs.readFileSync(path.join(ROOT, 'pages/hub/hub.js'), 'utf8');

  // 出口可以是叉号也可以是取消按钮，但至少得有一个、且不能挂 wx:if 藏起来
  const exits = wxml.split('\n').filter((l) => /class="(login-close|login-cancel|login-skip)"/.test(l));
  assert.ok(exits.length, '资料弹窗必须有取消出口（login-cancel / login-close / login-skip）');
  for (const line of exits) {
    assert.ok(!/wx:if/.test(line), `取消出口不能挂 wx:if —— 任何情况下都要能关掉：${line.trim()}`);
  }
  // 反过来守一条：弹窗卡片不能挂 catchtap，否则会把 chooseAvatar 按钮和
  // nickname 输入框的点击全吃掉（1.2.7 真这么干过，微信头像昵称直接失灵）
  const card = wxml.split('\n').find((l) => l.includes('class="login-card"')) || '';
  assert.ok(!/catchtap|catch:tap/.test(card), 'login-card 不能挂 catchtap，会吃掉头像/昵称按钮的点击');

  // 2026-11-27 又栽一次：进游戏前弹昵称窗，审核还是判「强制登录」。
  // 现在彻底不自动弹 —— 首页小手引导（needNickTip），只有用户点「Hi，昵称」才弹。
  assert.ok(!/_gate/.test(js), '不许再有 _gate：玩游戏前一律不能弹资料窗（审核两次打回在此）');
  assert.ok(/needNickTip/.test(js) && /needNickTip/.test(wxml), '要用首页小手引导代替弹窗');
  assert.ok(!/起个名字才能进游戏/.test(js), '不能再强制填昵称');
}

profileGateHasExit();
console.log(`✅ wxml 配平 ${wxmls.length} 个文件 · 资料门判断 + 登录出口全部通过`);
