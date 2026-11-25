// 接口自测：把 game.js 里的每个 action 都真打一遍，确认
//   1) 没有谁会抛异常（抛了会被兜底成「服务异常: xxx」）
//   2) 没有谁走到「未知操作」（名字拼错 / 分支没接上）
//   3) 管理员三件套没钥匙打不动
//   4) game.js 里新增 action 必须在这里加用例，否则最后那条覆盖断言会失败
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const Module = require('module');
const { makeDb } = require('./fakedb');

const JBS = path.join(__dirname, '..', 'server', 'functions', 'jbs');

function loadGame() {
  const db = makeDb();
  const app = {
    // uploadSign 要的签名接口，给个假的就行——这里只验它不炸
    getUploadMetadata: async ({ cloudPath }) => ({
      data: { url: 'https://x/' + cloudPath, token: 't', authorization: 'a', cosFileId: 'f' },
    }),
  };
  const orig = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === './cloud') return { db, app, ensureCollections: async () => {} };
    return orig.apply(this, arguments);
  };
  delete require.cache[require.resolve(path.join(JBS, 'game.js'))];
  const game = require(path.join(JBS, 'game.js'));
  Module.prototype.require = orig;
  return { game, db };
}

const CALLED = new Set();
function caller(game) {
  return async (ev, who) => {
    CALLED.add(ev.action);
    const r = await game.handle(ev, who);
    const msg = (r && r.msg) || '';
    assert.ok(r && typeof r === 'object', `${ev.action} 没返回对象`);
    assert.ok(!/服务异常/.test(msg), `❌ ${ev.action} 抛异常：${msg}`);
    assert.ok(!/未知操作/.test(msg), `❌ ${ev.action} 没有对应分支`);
    return r;
  };
}
const ok = (r, label) => { assert.ok(r && r.ok, `${label} 失败: ${JSON.stringify(r)}`); return r; };

// ── 1. 不依赖房间的接口 ──
async function standalone() {
  const { game, db } = loadGame();
  const call = caller(game);

  const me = ok(await call({ action: 'whoami' }, 'u1'), 'whoami');
  assert.strictEqual(me.openid, 'u1', 'whoami 应回自己的 openid');

  const sc = ok(await call({ action: 'getScripts' }, 'u1'), 'getScripts');
  assert.ok(Array.isArray(sc.list) && sc.list.length, 'getScripts 应有剧本');

  const up = ok(await call({ action: 'uploadSign', ext: 'png' }, 'u1'), 'uploadSign');
  assert.ok(up.url && up.headers && up.fileUrl, 'uploadSign 该回直传凭证');

  // 房间不存在时也不能炸
  const g = await call({ action: 'getRoom', roomId: 'nope' }, 'u1');
  assert.ok(g.ok && !g.room, 'getRoom 拿不到房间应回 room 为空');

  // 埋点：写一行流水，并确认那三道防撑爆的限制是真生效的
  ok(await call({ action: 'track', name: 'game_enter', data: { game: 'spy', n: 3 } }, 'u1'), 'track');
  const rows = Object.values(game && db && db._store ? db._store.jbsEvents || {} : {});
  assert.strictEqual(rows.length, 1, 'track 应写下一行');
  assert.strictEqual(rows[0].openid, 'u1', '流水要记是谁上报的');
  assert.deepStrictEqual(rows[0].data, { game: 'spy', n: 3 }, '数字保持数字，字符串保持字符串');

  assert.ok(!(await call({ action: 'track' }, 'u1')).ok, '没事件名应被拒');

  const many = {};
  for (let i = 0; i < 30; i++) many['k' + i] = 'v';
  many.obj = { a: 1 };                      // 对象要被丢掉
  many.long = 'x'.repeat(500);              // 超长值要被截断
  ok(await call({ action: 'track', name: 'z'.repeat(100), data: many }, 'u1'), 'track 超限参数');
  const last = Object.values(db._store.jbsEvents).pop();
  assert.ok(last.name.length <= 40, '事件名要截到 40');
  assert.ok(Object.keys(last.data).length <= 10, '参数最多 10 个键');
  Object.values(last.data).forEach((v) => {
    assert.ok(typeof v !== 'object', '对象参数要被丢掉');
    assert.ok(String(v).length <= 100, '超长值要截断');
  });

  console.log('  ✅ 无房接口：whoami / getScripts / uploadSign / getRoom / track');
}

// ── 2. 管理员三件套：ADMIN_KEY 把门 ──
async function adminGuard() {
  const { game } = loadGame();
  const call = caller(game);
  const admin = ['seedScripts', 'setCover', 'purgeRooms'];

  delete process.env.ADMIN_KEY;
  for (const action of admin) {
    const r = await call({ action }, 'u1');
    assert.ok(!r.ok && r.msg === '无权限', `❌ 没配 ADMIN_KEY 时 ${action} 居然放行了：${JSON.stringify(r)}`);
  }

  process.env.ADMIN_KEY = 'k';
  for (const action of admin) {
    const r = await call({ action, adminKey: 'wrong' }, 'u1');
    assert.ok(!r.ok && r.msg === '无权限', `❌ 错钥匙也能调 ${action}`);
  }
  ok(await call({ action: 'seedScripts', adminKey: 'k' }, 'u1'), 'seedScripts');
  const noArg = await call({ action: 'setCover', adminKey: 'k' }, 'u1');
  assert.ok(!noArg.ok, 'setCover 少参数应拒绝');
  ok(await call({ action: 'setCover', adminKey: 'k', scriptId: 'test', fileID: 'cloud://x' }, 'u1'), 'setCover');
  ok(await call({ action: 'purgeRooms', adminKey: 'k' }, 'u1'), 'purgeRooms');
  delete process.env.ADMIN_KEY;

  console.log('  ✅ 管理员接口：无钥匙/错钥匙一律挡住，带钥匙能跑');
}

// ── 3. 剧本杀：建房 → 搜证 → 推进 → 投票 → 回退 → 重开 → 解散 ──
async function jbsRoom() {
  const { game, db } = loadGame();
  const call = caller(game);
  const H = 'host';

  const c = ok(await call({ action: 'create', scriptId: 'test', nick: '主持人' }, H), '建房');
  for (const id of ['a', 'b', 'c']) ok(await call({ action: 'join', roomCode: c.roomCode, nick: id }, id), `${id} 进房`);

  const got = ok(await call({ action: 'getRoom', roomId: c.roomId }, H), 'getRoom');
  assert.strictEqual(got.room.players.length, 4, 'getRoom 应看到 4 人');

  ok(await call({ action: 'setSpectator', roomId: c.roomId, spectator: true }, 'c'), 'c 转旁观');
  ok(await call({ action: 'setSpectator', roomId: c.roomId, spectator: false }, 'c'), 'c 回桌');

  for (const id of ['a', 'b', 'c']) ok(await call({ action: 'ready', roomId: c.roomId }, id), `${id} 准备`);
  ok(await call({ action: 'start', roomId: c.roomId }, H), '开局');

  // 搜证：拿本幕第一个地点；参数不对也只能是业务拒绝，不能炸
  const meta = JSON.parse(fs.readFileSync(path.join(JBS, 'scriptsSeed.json'), 'utf8'))
    .find((s) => (s._id || s.id) === 'test');
  const spots = (meta.spotsByAct && meta.spotsByAct[0]) || (meta.cluesByAct && meta.cluesByAct[0]) || [];
  if (spots.length) ok(await call({ action: 'search', roomId: c.roomId, spotId: spots[0] }, 'a'), 'a 搜证');
  const bad = await call({ action: 'search', roomId: c.roomId, spotId: '不存在的地点' }, 'a');
  assert.ok(!bad.ok, '搜不存在的地点应被拒');
  const hostSearch = await call({ action: 'search', roomId: c.roomId, spotId: spots[0] || 'x' }, H);
  assert.ok(!hostSearch.ok, '主持人不该能搜证');

  // 推进到投票
  for (let i = 0; i < (meta.actCount || 1) + 2; i++) {
    const r = await call({ action: 'advance', roomId: c.roomId }, H);
    if (!r.ok) break;
    if (db._store.rooms[c.roomId].status === 'voting') break;
  }
  assert.strictEqual(db._store.rooms[c.roomId].status, 'voting', '应推进到投票阶段');

  ok(await call({ action: 'vote', roomId: c.roomId, target: 'b' }, 'a'), 'a 投票');
  ok(await call({ action: 'rewind', roomId: c.roomId }, H), 'rewind 退回最后一幕');
  assert.strictEqual(db._store.rooms[c.roomId].status, 'playing', 'rewind 后应回到 playing');
  assert.deepStrictEqual(db._store.rooms[c.roomId].votes, {}, 'rewind 应清空选票');

  const notHost = await call({ action: 'rewind', roomId: c.roomId }, 'a');
  assert.ok(!notHost.ok, '非主持人不该能 rewind');

  ok(await call({ action: 'reset', roomId: c.roomId }, H), 'reset 再来一局');
  assert.strictEqual(db._store.rooms[c.roomId].status, 'waiting', 'reset 后应回等待');

  const notHostKill = await call({ action: 'dissolve', roomId: c.roomId }, 'a');
  assert.ok(!notHostKill.ok, '非主持人不该能解散');
  ok(await call({ action: 'dissolve', roomId: c.roomId }, H), 'dissolve 解散');
  assert.ok(!db._store.rooms[c.roomId], '解散后房间该没了');

  console.log('  ✅ 剧本杀接口：建房/进房/旁观切换/搜证/推进/投票/回退/重开/解散');
}

// ── 4. 卧底：发词 / 我的词 / 上帝视角 / 投票 ──
async function spyRoom() {
  const { game, db } = loadGame();
  const call = caller(game);
  const H = 'host';
  const P = ['p1', 'p2', 'p3'];

  const c = ok(await call({ action: 'create', gameType: 'spy', nick: '房主' }, H), '建房');
  for (const id of P) ok(await call({ action: 'join', roomCode: c.roomCode, nick: id }, id), `${id} 进房`);
  ok(await call({ action: 'join', roomCode: c.roomCode, nick: '吃瓜', spectator: true }, 'sp'), '旁观者进房');
  for (const id of P) ok(await call({ action: 'ready', roomId: c.roomId }, id), `${id} 准备`);
  ok(await call({ action: 'start', roomId: c.roomId }, H), '开局');

  const w = ok(await call({ action: 'myWord', roomId: c.roomId }, 'p1'), 'myWord');
  assert.ok(w.word, 'myWord 应回自己的词');
  const outsider = await call({ action: 'myWord', roomId: c.roomId }, '路人');
  assert.ok(!outsider.ok, '不在局里的人不该拿到词');

  const god = ok(await call({ action: 'spyGod', roomId: c.roomId }, 'sp'), 'spyGod');
  assert.ok(god.list.length >= 4 && god.spyWord && god.civilWord, 'spyGod 应回全员词表');
  assert.strictEqual(god.list.filter((x) => x.isSpy).length, 1, '本局应正好 1 个卧底');
  const peek = await call({ action: 'spyGod', roomId: c.roomId }, 'p1');
  assert.ok(!peek.ok, '❌ 玩家能看上帝视角');

  ok(await call({ action: 'spyVoteOpen', roomId: c.roomId }, H), '开启投票');
  const early = await call({ action: 'spyReveal', roomId: c.roomId }, H);
  assert.ok(!early.ok, '没投满就公布应被拒');
  // 房主在卧底局里也是玩家，一样要投
  for (const id of [H, ...P]) {
    const t = id === 'p2' ? 'p1' : 'p2';   // 不能投自己
    ok(await call({ action: 'spyVote', roomId: c.roomId, target: t }, id), `${id} 投票`);
  }
  assert.ok(!(await call({ action: 'spyReveal', roomId: c.roomId }, 'p1')).ok, '非房主不该能公布');
  const rev = ok(await call({ action: 'spyReveal', roomId: c.roomId }, H), 'spyReveal');
  assert.ok(db._store.rooms[c.roomId].lastVote, 'spyReveal 应写下本轮结果');

  console.log('  ✅ 卧底接口：myWord / spyGod（玩家看不到）/ spyVoteOpen / spyVote / spyReveal');
}

// ── 5. 狼人杀：身份 / 夜晚状态 / 上帝台 / 白天出局 / 揭晓 ──
// 开一局狼人杀并返回常用句柄（身份是随机发的，所以每处都现查）
async function startWolf(call, db, H, P) {
  const c = ok(await call({ action: 'create', gameType: 'wolf', nick: '上帝' }, H), '建房');
  for (const id of P) ok(await call({ action: 'join', roomCode: c.roomCode, nick: id }, id), `${id} 进房`);
  for (const id of P) ok(await call({ action: 'ready', roomId: c.roomId }, id), `${id} 准备`);
  ok(await call({ action: 'start', roomId: c.roomId }, H), '开局');

  const sec = db._store.spySecrets[c.roomId];
  const roleOf = (id) => sec.roles[id];
  const st = () => db._store.rooms[c.roomId].status;
  // 上帝在 players 里但不算玩家，投票/出局都要把他排除
  const aliveIds = () => db._store.rooms[c.roomId].players.filter((p) => !p.out && p.openid !== H).map((p) => p.openid);

  async function playNight(tag) {
    const live = aliveIds();
    const wolves = live.filter((id) => roleOf(id) === 'wolf');
    const victim = live.find((id) => roleOf(id) !== 'wolf');
    for (const id of wolves) ok(await call({ action: 'wolfNightAct', act: 'kill', roomId: c.roomId, target: victim }, id), `${tag} ${id} 刀人`);
    ok(await call({ action: 'wolfNightAct', act: 'killConfirm', roomId: c.roomId }, wolves[0]), `${tag} 确认刀`);
    const seer = live.find((id) => roleOf(id) === 'seer');
    if (seer) ok(await call({ action: 'wolfNightAct', act: 'check', roomId: c.roomId, target: wolves[0] }, seer), `${tag} 预言家查验`);
    const witch = live.find((id) => roleOf(id) === 'witch');
    if (witch) ok(await call({ action: 'wolfNightAct', act: 'skip', roomId: c.roomId }, witch), `${tag} 女巫空过`);
    ok(await call({ action: 'wolfForce', roomId: c.roomId }, H), `${tag} wolfForce 天亮`);
  }
  return { c, sec, roleOf, st, aliveIds, playNight };
}

async function wolfRoom() {
  const { game, db } = loadGame();
  const call = caller(game);
  const H = 'host';
  const P = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'];
  const { c, roleOf, st, aliveIds, playNight } = await startWolf(call, db, H, P);
  const liveIds = aliveIds;

  // wolfRole：上帝 / 玩家 / 局外人
  assert.strictEqual(ok(await call({ action: 'wolfRole', roomId: c.roomId }, H), 'wolfRole 上帝').role, 'god');
  const mine = ok(await call({ action: 'wolfRole', roomId: c.roomId }, 'w1'), 'wolfRole 玩家');
  assert.strictEqual(mine.role, roleOf('w1'), 'wolfRole 回的身份要对得上');
  if (mine.role === 'wolf') assert.ok(mine.mates.length >= 1, '狼应看到队友');
  assert.ok(!(await call({ action: 'wolfRole', roomId: c.roomId }, '路人')).ok, '局外人不该有身份');

  // wolfNightState：每个人都能拿，且不该炸
  for (const id of P) {
    const ns = ok(await call({ action: 'wolfNightState', roomId: c.roomId }, id), `wolfNightState ${id}`);
    assert.strictEqual(ns.phase, 'night', '开局应是夜晚');
    assert.strictEqual(ns.role, roleOf(id), '夜晚状态里的身份要对');
  }

  // wolfGod：只有上帝和旁观者能看
  const gd = ok(await call({ action: 'wolfGod', roomId: c.roomId }, H), 'wolfGod');
  assert.ok(gd.night && gd.potions, 'wolfGod 应回夜晚实况和药');
  assert.ok(!(await call({ action: 'wolfGod', roomId: c.roomId }, 'w1')).ok, '❌ 玩家能看上帝台');

  // 走完一夜：狼刀 → 预言家 → 女巫 → 天亮
  // 行动参数不对只能是业务拒绝，不能炸
  assert.ok(!(await call({ action: 'wolfNightAct', act: '乱填', roomId: c.roomId }, P[0])).ok, '无效 act 应被拒');
  assert.ok(!(await call({ action: 'wolfNightAct', act: 'kill', roomId: c.roomId, target: 'x' }, P[0])).ok, '无效目标应被拒');
  await playNight('第一夜');
  assert.strictEqual(db._store.rooms[c.roomId].status, 'day', '应该天亮了');

  // 白天① 全员投票 → wolfDusk 天黑
  const day1 = aliveIds();
  assert.ok(!(await call({ action: 'wolfDusk', roomId: c.roomId }, H)).ok, '没投完票不该能天黑');
  assert.ok(!(await call({ action: 'wolfDusk', roomId: c.roomId }, P[0])).ok, '非上帝不该能宣布天黑');
  for (const id of day1) ok(await call({ action: 'wolfVote', roomId: c.roomId, target: day1[0] }, id), `${id} 投票`);
  assert.ok(!(await call({ action: 'wolfVote', roomId: c.roomId, target: day1[0] }, H)).ok, '上帝不该能投票');
  ok(await call({ action: 'wolfDusk', roomId: c.roomId }, H), 'wolfDusk');
  assert.ok(db._store.rooms[c.roomId].players.find((p) => p.openid === day1[0]).out, '票选的人应出局');

  // leave 收尾
  ok(await call({ action: 'leave', roomId: c.roomId }, liveIds()[0]), 'leave');

  // wolfDayOut / wolfReveal 各开一局单独测——上面那局可能已经分出胜负，
  // 身份是随机发的，不能指望它一定还活着能走到这两步
  {
    const r = await startWolf(call, db, H, P);
    await r.playNight('第一夜');
    assert.strictEqual(r.st(), 'day', '第一夜后应天亮');
    const target = r.aliveIds()[0];
    assert.ok(!(await call({ action: 'wolfDayOut', roomId: r.c.roomId, target }, P[0])).ok, '非房主不该能执行出局');
    assert.ok(!(await call({ action: 'wolfDayOut', roomId: r.c.roomId, target: H }, H)).ok, '上帝不能被出局');
    assert.ok(!(await call({ action: 'wolfDayOut', roomId: r.c.roomId, target: '路人' }, H)).ok, '目标不在局里应被拒');
    ok(await call({ action: 'wolfDayOut', roomId: r.c.roomId, target }, H), 'wolfDayOut');
    assert.ok(db._store.rooms[r.c.roomId].players.find((p) => p.openid === target).out, '目标应已出局');
  }
  {
    const r = await startWolf(call, db, H, P);   // 开局即夜晚，直接揭晓
    assert.ok(!(await call({ action: 'wolfReveal', roomId: r.c.roomId }, P[0])).ok, '非房主不该能揭晓');
    ok(await call({ action: 'wolfReveal', roomId: r.c.roomId }, H), 'wolfReveal');
    assert.strictEqual(r.st(), 'finished', '揭晓后应结束');
  }

  console.log('  ✅ 狼人杀接口：wolfRole / wolfNightState / wolfGod / wolfNightAct / wolfForce / wolfVote / wolfDayOut / wolfDusk / wolfReveal');
}

// ── 6. 覆盖率：game.js 里的 action 必须一个不落 ──
function coverage() {
  const src = fs.readFileSync(path.join(JBS, 'game.js'), 'utf8');
  const all = [...new Set([...src.matchAll(/action === '([a-zA-Z]+)'/g)].map((m) => m[1]))].sort();
  const missed = all.filter((a) => !CALLED.has(a));
  assert.strictEqual(missed.length, 0, `❌ 这些 action 没被测到（新增接口请在本文件补用例）：${missed.join(' ')}`);
  const ghost = [...CALLED].filter((a) => !all.includes(a));
  assert.strictEqual(ghost.length, 0, `❌ 测了 game.js 里不存在的 action：${ghost.join(' ')}`);
  console.log(`  ✅ 覆盖率：${all.length} 个 action 全部打到`);
}

(async () => {
  await standalone();
  await adminGuard();
  await jbsRoom();
  await spyRoom();
  await wolfRoom();
  coverage();
  console.log('✅ 所有接口通过');
})().catch((e) => { console.error('❌', e.message); process.exit(1); });
