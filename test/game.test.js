// 对局逻辑自测：用内存数据库驱动真实的 game.handle，跑完整流程。
// 重点验「中途退出交给机器人托管」那套——这部分改完只做过语法检查，逻辑没跑过。
const assert = require('assert');
const path = require('path');
const Module = require('module');
const { makeDb } = require('./fakedb');

const JBS = path.join(__dirname, '..', 'server', 'functions', 'jbs');

function loadGame() {
  const db = makeDb();
  // 把 game.js 的 require('./cloud') 换成内存实现
  const orig = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === './cloud') return { db, app: {}, ensureCollections: async () => {} };
    return orig.apply(this, arguments);
  };
  delete require.cache[require.resolve(path.join(JBS, 'game.js'))];
  const game = require(path.join(JBS, 'game.js'));
  Module.prototype.require = orig;
  return { game, db };
}

const room = (db) => Object.values(db._store.rooms || {})[0];
const ok = (r, label) => { assert.ok(r && r.ok, `${label} 失败: ${JSON.stringify(r)}`); return r; };

// ── 卧底：4 人开局，一人中途退出 ──
async function spyBotTakeover() {
  const { game, db } = loadGame();
  const H = 'host';
  const P = ['p1', 'p2', 'p3', 'p4'];

  const c = ok(await game.handle({ action: 'create', gameType: 'spy', nick: '房主' }, H), '建房');
  for (const id of P) ok(await game.handle({ action: 'join', roomCode: c.roomCode, nick: id }, id), `${id} 进房`);
  for (const id of P) ok(await game.handle({ action: 'ready', roomId: c.roomId }, id), `${id} 准备`);
  ok(await game.handle({ action: 'start', roomId: c.roomId }, H), '开始');
  assert.strictEqual(room(db).status, 'playing', '开局后应为 playing');

  // 挑一个平民中途退出（退的若是唯一卧底，会触发「威胁方全退 → 平民胜」直接收局，那是另一条用例）
  const sec0 = Object.values(db._store.spySecrets)[0];
  const quitter = P.find((id) => !sec0.spies.includes(id));
  assert.ok(quitter, '本局应至少有一个平民玩家');
  const left = ok(await game.handle({ action: 'leave', roomId: c.roomId }, quitter), `${quitter} 退出`);
  assert.ok(!left.dissolved, '❌ 有人退出就解散了本局');
  assert.ok(room(db), '❌ 房间被删掉了');
  const gone = room(db).players.find((p) => p.openid === quitter);
  assert.strictEqual(gone && gone.bot, true, '退出者应标记为机器人托管');

  // 开投票 → 剩下的真人投票（卧底局房主也发词、也要投）→ 房主公布，机器人不投不该卡住
  ok(await game.handle({ action: 'spyVoteOpen', roomId: c.roomId }, H), '开启投票');
  const voters = [H, ...P].filter((id) => id !== quitter);
  for (const id of voters) {
    ok(await game.handle({ action: 'spyVote', roomId: c.roomId, target: quitter }, id), `${id} 投票`);
  }
  const rev = await game.handle({ action: 'spyReveal', roomId: c.roomId }, H);
  assert.ok(rev.ok, `❌ 机器人不投票导致公布被卡住: ${rev.msg}`);
  console.log('  ✅ 卧底：退出转托管、不解散、公布不被机器人卡住');
}

// ── 狼人杀：6 人开局，狼中途退出，上帝宣布天亮 ──
async function wolfBotTakeover() {
  const { game, db } = loadGame();
  const H = 'god';
  const P = ['w1', 'w2', 'w3', 'w4', 'w5', 'w6'];

  const c = ok(await game.handle({ action: 'create', gameType: 'wolf', nick: '上帝' }, H), '建房');
  for (const id of P) ok(await game.handle({ action: 'join', roomCode: c.roomCode, nick: id }, id), `${id} 进房`);
  for (const id of P) ok(await game.handle({ action: 'ready', roomId: c.roomId }, id), `${id} 准备`);
  ok(await game.handle({ action: 'start', roomId: c.roomId }, H), '开始');
  assert.strictEqual(room(db).status, 'night', '开局应入夜');

  const sec = Object.values(db._store.spySecrets)[0];
  const roleOf = (id) => sec.roles[id];
  const seer = P.find((id) => roleOf(id) === 'seer');
  const witch = P.find((id) => roleOf(id) === 'witch');
  const wolves = P.filter((id) => roleOf(id) === 'wolf');

  // 预言家中途退出 → 托管。神职不行动，不该挡住夜晚结束
  const r = ok(await game.handle({ action: 'leave', roomId: c.roomId }, seer), '预言家退出');
  assert.ok(!r.dissolved && !r.finished, '❌ 神职退出不该结束本局');

  const prey = P.find((id) => id !== seer && roleOf(id) !== 'wolf');
  for (const w of wolves) {   // 狼必须全员选完目标才能确认
    ok(await game.handle({ action: 'wolfNightAct', roomId: c.roomId, act: 'kill', target: prey }, w), `${w} 选刀`);
  }
  ok(await game.handle({ action: 'wolfNightAct', roomId: c.roomId, act: 'killConfirm' }, wolves[0]), '确认刀');
  ok(await game.handle({ action: 'wolfNightAct', roomId: c.roomId, act: 'skip' }, witch), '女巫跳过');

  const dawn = await game.handle({ action: 'wolfForce', roomId: c.roomId }, H);
  assert.ok(dawn.ok, `❌ 预言家是机器人导致天亮被卡住: ${dawn.msg}`);
  assert.ok(['day', 'finished'].includes(room(db).status), '应天亮或已分胜负');

  // 白天投票只等真人：机器人不投也能天黑
  if (room(db).status === 'day') {
    const humans = room(db).players.filter((p) => !p.bot && !p.out && p.openid !== H).map((p) => p.openid);
    for (const id of humans) ok(await game.handle({ action: 'wolfVote', roomId: c.roomId, target: humans[0] }, id), `${id} 投票`);
    const dusk = await game.handle({ action: 'wolfDusk', roomId: c.roomId }, H);
    assert.ok(dusk.ok, `❌ 机器人不投票导致天黑被卡住: ${dusk.msg}`);
  }
  console.log('  ✅ 狼人杀：神职托管不挡天亮、机器人不挡天黑');
}

// ── 结束条件：真人全退光才解散 ──
async function dissolveRules() {
  const { game, db } = loadGame();
  const H = 'host2';
  const P = ['a', 'b', 'c', 'd'];
  const c = ok(await game.handle({ action: 'create', gameType: 'spy', nick: '房主' }, H), '建房');
  for (const id of P) ok(await game.handle({ action: 'join', roomCode: c.roomCode, nick: id }, id), `${id} 进房`);
  for (const id of P) ok(await game.handle({ action: 'ready', roomId: c.roomId }, id), `${id} 准备`);
  ok(await game.handle({ action: 'start', roomId: c.roomId }, H), '开始');

  for (const id of P.slice(0, 3)) {
    const r = await game.handle({ action: 'leave', roomId: c.roomId }, id);
    assert.ok(!r.dissolved, `❌ 第 ${id} 个人退出就解散了`);
    assert.ok(room(db), '❌ 房间提前没了');
  }
  const last = await game.handle({ action: 'leave', roomId: c.roomId }, 'd');
  assert.ok(last.dissolved, '❌ 真人全退光后应自动结束');
  assert.ok(!room(db), '❌ 房间应已删除');
  console.log('  ✅ 结束条件：退到最后一个真人才解散');
}

// ── 威胁方全退出 → 另一方直接获胜，不靠机器人替他们行动 ──
async function autoWinWhenThreatLeaves() {
  // 狼人杀：狼全退出 → 好人胜
  {
    const { game, db } = loadGame();
    const H = 'god2';
    const P = ['x1', 'x2', 'x3', 'x4', 'x5', 'x6'];
    const c = ok(await game.handle({ action: 'create', gameType: 'wolf', nick: '上帝' }, H), '建房');
    for (const id of P) ok(await game.handle({ action: 'join', roomCode: c.roomCode, nick: id }, id), `${id} 进房`);
    for (const id of P) ok(await game.handle({ action: 'ready', roomId: c.roomId }, id), `${id} 准备`);
    ok(await game.handle({ action: 'start', roomId: c.roomId }, H), '开始');
    const sec = Object.values(db._store.spySecrets)[0];
    const wolves = P.filter((id) => sec.roles[id] === 'wolf');
    let last;
    for (const w of wolves) last = await game.handle({ action: 'leave', roomId: c.roomId }, w);
    assert.strictEqual(last.finished, 'good', '❌ 狼全退出应直接判好人胜');
    assert.strictEqual(room(db).status, 'finished', '❌ 本局应结束');
    assert.strictEqual(room(db).reveal.winner, 'good', '❌ 结果应是好人胜');
  }
  // 卧底：卧底全退出 → 平民胜
  {
    const { game, db } = loadGame();
    const H = 'host3';
    const P = ['y1', 'y2', 'y3', 'y4'];
    const c = ok(await game.handle({ action: 'create', gameType: 'spy', nick: '房主' }, H), '建房');
    for (const id of P) ok(await game.handle({ action: 'join', roomCode: c.roomCode, nick: id }, id), `${id} 进房`);
    for (const id of P) ok(await game.handle({ action: 'ready', roomId: c.roomId }, id), `${id} 准备`);
    ok(await game.handle({ action: 'start', roomId: c.roomId }, H), '开始');
    const sec = Object.values(db._store.spySecrets)[0];
    const spies = sec.spies.filter((id) => id !== H);   // 房主也可能是卧底，他退出走的是解散
    if (!spies.length) return console.log('  ⚠️ 本次随机到房主当卧底，跳过该 case');
    let last;
    for (const s2 of spies) last = await game.handle({ action: 'leave', roomId: c.roomId }, s2);
    assert.strictEqual(last.finished, 'civil', '❌ 卧底全退出应直接判平民胜');
    assert.strictEqual(room(db).reveal.winner, 'civil', '❌ 结果应是平民胜');
  }
  console.log('  ✅ 威胁方全退出：狼全退判好人胜、卧底全退判平民胜');
}

(async () => {
  await spyBotTakeover();
  await autoWinWhenThreatLeaves();
  await wolfBotTakeover();
  await dissolveRules();
  console.log('✅ 对局逻辑全部通过');
})().catch((e) => { console.error('❌ ' + e.message); process.exit(1); });
