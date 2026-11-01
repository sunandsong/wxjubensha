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

// ── 正常局：没人退出，流程必须和加机器人之前完全一样 ──
async function normalSpyGame() {
  const { game, db } = loadGame();
  const H = 'nh';
  const P = ['n1', 'n2', 'n3', 'n4'];
  const c = ok(await game.handle({ action: 'create', gameType: 'spy', nick: '房主' }, H), '建房');
  for (const id of P) ok(await game.handle({ action: 'join', roomCode: c.roomCode, nick: id }, id), `${id} 进房`);
  for (const id of P) ok(await game.handle({ action: 'ready', roomId: c.roomId }, id), `${id} 准备`);
  ok(await game.handle({ action: 'start', roomId: c.roomId }, H), '开始');

  const sec = Object.values(db._store.spySecrets)[0];
  const all = [H, ...P];
  assert.strictEqual(Object.keys(sec.words).length, all.length, '每人都该发到词（房主也参与）');

  // 全员投同一个平民出局，然后公布
  const victim = all.find((id) => !sec.spies.includes(id));
  ok(await game.handle({ action: 'spyVoteOpen', roomId: c.roomId }, H), '开启投票');
  for (const id of all.filter((x) => x !== victim)) {
    ok(await game.handle({ action: 'spyVote', roomId: c.roomId, target: victim }, id), `${id} 投票`);
  }
  ok(await game.handle({ action: 'spyVote', roomId: c.roomId, target: all.find((x) => x !== victim) }, victim), '被投者也投票');
  ok(await game.handle({ action: 'spyReveal', roomId: c.roomId }, H), '公布结果');
  const r = room(db);
  assert.ok(r.players.find((p) => p.openid === victim).out, '最高票应出局');
  assert.ok(!r.players.some((p) => p.bot), '正常局不该出现机器人');
  console.log('  ✅ 卧底正常局：全员发词、投票、公布、出局都正常');
}

async function normalWolfGame() {
  const { game, db } = loadGame();
  const H = 'ng';
  const P = ['m1', 'm2', 'm3', 'm4', 'm5', 'm6'];
  const c = ok(await game.handle({ action: 'create', gameType: 'wolf', nick: '上帝' }, H), '建房');
  for (const id of P) ok(await game.handle({ action: 'join', roomCode: c.roomCode, nick: id }, id), `${id} 进房`);
  for (const id of P) ok(await game.handle({ action: 'ready', roomId: c.roomId }, id), `${id} 准备`);
  ok(await game.handle({ action: 'start', roomId: c.roomId }, H), '开始');

  const sec = Object.values(db._store.spySecrets)[0];
  const roleOf = (id) => sec.roles[id];
  const wolves = P.filter((id) => roleOf(id) === 'wolf');
  const seer = P.find((id) => roleOf(id) === 'seer');
  const witch = P.find((id) => roleOf(id) === 'witch');
  assert.ok(wolves.length >= 2 && seer && witch, '6 人局应有 2 狼 + 预言家 + 女巫');

  const prey = P.find((id) => roleOf(id) === 'villager');
  for (const w of wolves) ok(await game.handle({ action: 'wolfNightAct', roomId: c.roomId, act: 'kill', target: prey }, w), `${w} 选刀`);
  ok(await game.handle({ action: 'wolfNightAct', roomId: c.roomId, act: 'killConfirm' }, wolves[0]), '确认刀');
  ok(await game.handle({ action: 'wolfNightAct', roomId: c.roomId, act: 'check', target: wolves[0] }, seer), '预言家查验');
  ok(await game.handle({ action: 'wolfNightAct', roomId: c.roomId, act: 'skip' }, witch), '女巫跳过');
  ok(await game.handle({ action: 'wolfForce', roomId: c.roomId }, H), '宣布天亮');

  const r1 = room(db);
  assert.strictEqual(r1.status, 'day', '应进入白天');
  assert.ok(r1.players.find((p) => p.openid === prey).out, '被刀的人应出局');
  assert.ok(!r1.players.some((p) => p.bot), '正常局不该出现机器人');

  const alive = r1.players.filter((p) => !p.out && p.openid !== H).map((p) => p.openid);
  for (const id of alive) ok(await game.handle({ action: 'wolfVote', roomId: c.roomId, target: wolves[0] }, id), `${id} 投票`);
  ok(await game.handle({ action: 'wolfDusk', roomId: c.roomId }, H), '宣布天黑');
  assert.ok(['night', 'finished'].includes(room(db).status), '天黑后应入夜或已分胜负');
  console.log('  ✅ 狼人杀正常局：刀/查/药、天亮出局、白天投票、天黑都正常');
}

async function normalScriptGame() {
  const { game, db } = loadGame();
  const H = 'sh';
  const P = ['s1', 's2', 's3'];
  const c = ok(await game.handle({ action: 'create', scriptId: 'test', nick: '主持人' }, H), '建房');
  for (const id of P) ok(await game.handle({ action: 'join', roomCode: c.roomCode, nick: id }, id), `${id} 进房`);
  for (const id of P) ok(await game.handle({ action: 'ready', roomId: c.roomId }, id), `${id} 准备`);
  ok(await game.handle({ action: 'start', roomId: c.roomId }, H), '开始');
  assert.ok(room(db).players.filter((p) => p.openid !== H).every((p) => p.charId), '每个玩家都该发到角色');

  for (let i = 0; i < 10 && room(db).status !== 'voting'; i++) {
    ok(await game.handle({ action: 'advance', roomId: c.roomId }, H), '推进');
  }
  assert.strictEqual(room(db).status, 'voting', '末幕后应进入投票');

  const chars = room(db).players.filter((p) => p.openid !== H).map((p) => p.charId);
  for (const id of P) ok(await game.handle({ action: 'vote', roomId: c.roomId, charId: chars[0] }, id), `${id} 投票`);
  ok(await game.handle({ action: 'advance', roomId: c.roomId }, H), '公布真相');
  assert.strictEqual(room(db).status, 'finished', '应公布真相结束');
  console.log('  ✅ 剧本杀正常局：发角色、逐幕推进、投票、公布真相都正常');
}

// 剧本杀有人退出后，主持人仍能公布真相（机器人不该把投票数卡住）
async function scriptBotDoesNotBlockReveal() {
  const { game, db } = loadGame();
  const H = 'sh2';
  const P = ['t1', 't2', 't3'];
  const c = ok(await game.handle({ action: 'create', scriptId: 'test', nick: '主持人' }, H), '建房');
  for (const id of P) ok(await game.handle({ action: 'join', roomCode: c.roomCode, nick: id }, id), `${id} 进房`);
  for (const id of P) ok(await game.handle({ action: 'ready', roomId: c.roomId }, id), `${id} 准备`);
  ok(await game.handle({ action: 'start', roomId: c.roomId }, H), '开始');
  ok(await game.handle({ action: 'leave', roomId: c.roomId }, 't3'), 't3 退出');

  for (let i = 0; i < 10 && room(db).status !== 'voting'; i++) {
    ok(await game.handle({ action: 'advance', roomId: c.roomId }, H), '推进');
  }
  const chars = room(db).players.filter((p) => p.openid !== H).map((p) => p.charId);
  for (const id of ['t1', 't2']) ok(await game.handle({ action: 'vote', roomId: c.roomId, charId: chars[0] }, id), `${id} 投票`);
  const rev = await game.handle({ action: 'advance', roomId: c.roomId }, H);
  assert.ok(rev.ok, `❌ 机器人把公布真相卡住了: ${rev.msg}`);
  assert.strictEqual(room(db).status, 'finished', '应公布真相结束');
  console.log('  ✅ 剧本杀：有人托管也能公布真相');
}

// 两狼中一只托管：剩下的真人狼必须还能正常刀人（否则夜晚死锁）
async function oneWolfLeavesStillKills() {
  const { game, db } = loadGame();
  const H = 'g3';
  const P = ['k1', 'k2', 'k3', 'k4', 'k5', 'k6'];
  const c = ok(await game.handle({ action: 'create', gameType: 'wolf', nick: '上帝' }, H), '建房');
  for (const id of P) ok(await game.handle({ action: 'join', roomCode: c.roomCode, nick: id }, id), `${id} 进房`);
  for (const id of P) ok(await game.handle({ action: 'ready', roomId: c.roomId }, id), `${id} 准备`);
  ok(await game.handle({ action: 'start', roomId: c.roomId }, H), '开始');

  const sec = Object.values(db._store.spySecrets)[0];
  const roleOf = (id) => sec.roles[id];
  const wolves = P.filter((id) => roleOf(id) === 'wolf');
  assert.ok(wolves.length >= 2, '6 人局应有 2 狼');
  const seer = P.find((id) => roleOf(id) === 'seer');
  const witch = P.find((id) => roleOf(id) === 'witch');

  ok(await game.handle({ action: 'leave', roomId: c.roomId }, wolves[0]), '一只狼退出');
  assert.strictEqual(room(db).status, 'night', '只走一只狼不该结束本局');

  const prey = P.find((id) => roleOf(id) === 'villager');
  ok(await game.handle({ action: 'wolfNightAct', roomId: c.roomId, act: 'kill', target: prey }, wolves[1]), '剩下的狼选刀');
  const conf = await game.handle({ action: 'wolfNightAct', roomId: c.roomId, act: 'killConfirm' }, wolves[1]);
  assert.ok(conf.ok, `❌ 托管的狼把确认刀卡住了: ${conf.msg}`);
  ok(await game.handle({ action: 'wolfNightAct', roomId: c.roomId, act: 'check', target: wolves[1] }, seer), '预言家查验');
  ok(await game.handle({ action: 'wolfNightAct', roomId: c.roomId, act: 'skip' }, witch), '女巫跳过');
  ok(await game.handle({ action: 'wolfForce', roomId: c.roomId }, H), '宣布天亮');
  assert.ok(room(db).players.find((p) => p.openid === prey).out, '被刀的人应出局');
  console.log('  ✅ 狼人杀：两狼走一只，剩下的狼照常刀人');
}

// ── 再来一局：上一局退出的人（机器人）不该占着座位 ──
async function resetClearsBots() {
  const { game, db } = loadGame();
  const H = 'rh';
  const P = ['r1', 'r2', 'r3', 'r4'];
  const c = ok(await game.handle({ action: 'create', gameType: 'spy', nick: '房主' }, H), '建房');
  for (const id of P) ok(await game.handle({ action: 'join', roomCode: c.roomCode, nick: id }, id), `${id} 进房`);
  for (const id of P) ok(await game.handle({ action: 'ready', roomId: c.roomId }, id), `${id} 准备`);
  ok(await game.handle({ action: 'start', roomId: c.roomId }, H), '开始');

  const sec = Object.values(db._store.spySecrets)[0];
  const quitter = P.find((id) => !sec.spies.includes(id));   // 退平民，避免触发「卧底全退」收局
  ok(await game.handle({ action: 'leave', roomId: c.roomId }, quitter), `${quitter} 退出`);
  ok(await game.handle({ action: 'reset', roomId: c.roomId }, H), '再来一局');

  const ps = room(db).players;
  assert.ok(!ps.some((p) => p.bot), '❌ 再来一局后机器人还占着座位');
  assert.ok(!ps.some((p) => p.openid === quitter), '❌ 已退出的人不该留在房间里');

  // 剩下的人准备后必须能正常开下一局（机器人不点准备会把开局卡死）
  for (const id of P.filter((x) => x !== quitter)) ok(await game.handle({ action: 'ready', roomId: c.roomId }, id), `${id} 准备`);
  const st = await game.handle({ action: 'start', roomId: c.roomId }, H);
  assert.ok(st.ok, `❌ 上一局的机器人把下一局开局卡住了: ${st.msg}`);
  console.log('  ✅ 再来一局：上局退出的人被清掉，能正常开下一局');
}

// ── 主持人退出 = 全场散场（游戏中、等待阶段都一样）──
async function hostLeaveDissolves() {
  // 游戏中
  {
    const { game, db } = loadGame();
    const H = 'hh';
    const P = ['h1', 'h2', 'h3'];
    const c = ok(await game.handle({ action: 'create', scriptId: 'test', nick: '主持人' }, H), '建房');
    for (const id of P) ok(await game.handle({ action: 'join', roomCode: c.roomCode, nick: id }, id), `${id} 进房`);
    for (const id of P) ok(await game.handle({ action: 'ready', roomId: c.roomId }, id), `${id} 准备`);
    ok(await game.handle({ action: 'start', roomId: c.roomId }, H), '开始');

    const r = ok(await game.handle({ action: 'leave', roomId: c.roomId }, H), '主持人退出');
    assert.strictEqual(r.dissolved, true, '❌ 主持人退出应解散整局');
    assert.ok(!room(db), '❌ 房间应已删除');
  }
  // 等待阶段
  {
    const { game, db } = loadGame();
    const H = 'hw';
    const c = ok(await game.handle({ action: 'create', gameType: 'spy', nick: '房主' }, H), '建房');
    ok(await game.handle({ action: 'join', roomCode: c.roomCode, nick: 'w1' }, 'w1'), 'w1 进房');
    const r = ok(await game.handle({ action: 'leave', roomId: c.roomId }, H), '房主退出');
    assert.strictEqual(r.dissolved, true, '❌ 等待阶段房主退出也应解散');
    assert.ok(!room(db), '❌ 房间应已删除');
  }
  // 普通玩家退出不受影响：等待阶段只是移除自己
  {
    const { game, db } = loadGame();
    const H = 'hp';
    const c = ok(await game.handle({ action: 'create', gameType: 'spy', nick: '房主' }, H), '建房');
    for (const id of ['a1', 'a2']) ok(await game.handle({ action: 'join', roomCode: c.roomCode, nick: id }, id), `${id} 进房`);
    const r = ok(await game.handle({ action: 'leave', roomId: c.roomId }, 'a1'), 'a1 退出');
    assert.ok(!r.dissolved, '❌ 普通玩家退出不该解散');
    assert.ok(room(db) && !room(db).players.some((p) => p.openid === 'a1'), '❌ 退出者应被移除');
  }
  console.log('  ✅ 主持人退出：游戏中/等待阶段都解散，普通玩家退出不受影响');
}

// ── 旁观者：不占座、不准备、不投票；等待阶段可上桌 ──
async function spectatorFlow() {
  const { game, db } = loadGame();
  const H = 'ph';
  const P = ['q1', 'q2'];   // 卧底局房主也算玩家：房主+2=3，差一个才够 4
  const c = ok(await game.handle({ action: 'create', gameType: 'spy', nick: '房主' }, H), '建房');
  for (const id of P) ok(await game.handle({ action: 'join', roomCode: c.roomCode, nick: id }, id), `${id} 进房`);
  ok(await game.handle({ action: 'join', roomCode: c.roomCode, nick: '吃瓜', spectator: true }, 'spec'), '旁观进房');

  const spec = room(db).players.find((p) => p.openid === 'spec');
  assert.strictEqual(spec.spectator, true, '应标记为旁观');
  assert.strictEqual(await game.handle({ action: 'ready', roomId: c.roomId }, 'spec').then((x) => x.ok), false, '旁观者不该能准备');

  // 人不够（房主+2 个玩家=3，旁观不算）：开局应被拒
  for (const id of P) ok(await game.handle({ action: 'ready', roomId: c.roomId }, id), `${id} 准备`);
  const bad = await game.handle({ action: 'start', roomId: c.roomId }, H);
  assert.ok(!bad.ok, '❌ 旁观者被算进人数了，3 人不该能开局');

  // 上桌后人数够了
  ok(await game.handle({ action: 'setSpectator', roomId: c.roomId, spectator: false }, 'spec'), '上桌');
  assert.strictEqual(room(db).players.find((p) => p.openid === 'spec').spectator, false, '应变成玩家');
  ok(await game.handle({ action: 'ready', roomId: c.roomId }, 'spec'), '上桌后能准备');
  ok(await game.handle({ action: 'start', roomId: c.roomId }, H), '开局');
  console.log('  ✅ 旁观者：不占座、不能准备、上桌后计入人数');
}

// ── 开局后进来的人自动旁观，再来一局转为玩家 ──
async function lateJoinBecomesPlayer() {
  const { game, db } = loadGame();
  const H = 'lh';
  const P = ['l1', 'l2', 'l3', 'l4'];
  const c = ok(await game.handle({ action: 'create', gameType: 'spy', nick: '房主' }, H), '建房');
  for (const id of P) ok(await game.handle({ action: 'join', roomCode: c.roomCode, nick: id }, id), `${id} 进房`);
  for (const id of P) ok(await game.handle({ action: 'ready', roomId: c.roomId }, id), `${id} 准备`);
  ok(await game.handle({ action: 'start', roomId: c.roomId }, H), '开始');

  const j = ok(await game.handle({ action: 'join', roomCode: c.roomCode, nick: '迟到' }, 'late'), '开局后进房');
  assert.strictEqual(j.spectator, true, '开局后进来的应自动旁观');
  assert.strictEqual(await game.handle({ action: 'spyVote', roomId: c.roomId, target: P[0] }, 'late').then((x) => x.ok), false, '旁观者不该能投票');

  ok(await game.handle({ action: 'reset', roomId: c.roomId }, H), '再来一局');
  const after = room(db).players.find((p) => p.openid === 'late');
  assert.strictEqual(after.spectator, false, '❌ 迟到的人下一局应转为玩家');
  console.log('  ✅ 旁观者：开局后进来自动旁观，下一局转玩家');
}

(async () => {
  await normalSpyGame();
  await normalWolfGame();
  await normalScriptGame();
  await scriptBotDoesNotBlockReveal();
  await oneWolfLeavesStillKills();
  await resetClearsBots();
  await hostLeaveDissolves();
  await spectatorFlow();
  await lateJoinBecomesPlayer();
  await spyBotTakeover();
  await autoWinWhenThreatLeaves();
  await wolfBotTakeover();
  await dissolveRules();
  console.log('✅ 对局逻辑全部通过');
})().catch((e) => { console.error('❌ ' + e.message); process.exit(1); });
