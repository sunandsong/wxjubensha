// 随机压力测试：在对局的随机时刻让随机的人退出，看游戏能不能一直走到结束。
// 目的是撞出手写用例想不到的组合——机器人把流程卡死的坑已经出现过 7 次了。
const assert = require('assert');
const path = require('path');
const Module = require('module');
const { makeDb } = require('./fakedb');
const JBS = path.join(__dirname, '..', 'server', 'functions', 'jbs');

function loadGame() {
  const db = makeDb();
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

// 每一步都给一次随机退出的机会；房主不退（房主退出按设计就是解散）
function maybeLeave(game, db, c, H, rnd) {
  const r = room(db);
  if (!r || rnd() > 0.25) return;
  const cands = r.players.filter((p) => !p.bot && !p.spectator && !p.out && p.openid !== H);
  if (cands.length <= 1) return;   // 留一个真人，否则本来就该解散
  const victim = cands[Math.floor(rnd() * cands.length)];
  return game.handle({ action: 'leave', roomId: c.roomId }, victim.openid);
}

// 线性同余随机：种子固定 → 失败能复现
function seeded(seed) {
  let x = seed >>> 0;
  return () => ((x = (x * 1664525 + 1013904223) >>> 0) / 4294967296);
}

async function fuzzWolf(seed) {
  const rnd = seeded(seed);
  const { game, db } = loadGame();
  const H = 'g';
  const P = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7', 'p8'];
  const c = await game.handle({ action: 'create', gameType: 'wolf', nick: '上帝' }, H);
  for (const id of P) await game.handle({ action: 'join', roomCode: c.roomCode, nick: id }, id);
  for (const id of P) await game.handle({ action: 'ready', roomId: c.roomId }, id);
  const st = await game.handle({ action: 'start', roomId: c.roomId }, H);
  assert.ok(st.ok, `开局失败: ${st.msg}`);
  const sec = Object.values(db._store.spySecrets)[0];

  // 最多推 40 步；每步按当前阶段做该做的事，推不动就是卡住了
  for (let step = 0; step < 40; step++) {
    const r = room(db);
    if (!r || r.status === 'finished') return { seed, ended: true, step };
    await maybeLeave(game, db, c, H, rnd);
    const r2 = room(db);
    if (!r2 || r2.status === 'finished') return { seed, ended: true, step };

    const aliveActing = r2.players.filter((p) => !p.out && !p.spectator && !p.bot && p.openid !== H);
    if (r2.status === 'night') {
      for (const p of aliveActing) {
        const role = sec.roles[p.openid];
        const targets = r2.players.filter((q) => !q.out && q.openid !== H && q.openid !== p.openid);
        if (!targets.length) continue;
        const t = targets[Math.floor(rnd() * targets.length)].openid;
        if (role === 'wolf') await game.handle({ action: 'wolfNightAct', roomId: c.roomId, act: 'kill', target: t }, p.openid);
        if (role === 'seer') await game.handle({ action: 'wolfNightAct', roomId: c.roomId, act: 'check', target: t }, p.openid);
      }
      const anyWolf = aliveActing.find((p) => sec.roles[p.openid] === 'wolf');
      if (anyWolf) await game.handle({ action: 'wolfNightAct', roomId: c.roomId, act: 'killConfirm' }, anyWolf.openid);
      const witch = aliveActing.find((p) => sec.roles[p.openid] === 'witch');
      if (witch) await game.handle({ action: 'wolfNightAct', roomId: c.roomId, act: 'skip' }, witch.openid);

      const dawn = await game.handle({ action: 'wolfForce', roomId: c.roomId }, H);
      assert.ok(dawn.ok || !room(db) || room(db).status !== 'night',
        `seed=${seed} step=${step} 天亮卡住: ${dawn.msg}`);
    } else if (r2.status === 'day') {
      const voters = r2.players.filter((p) => !p.out && !p.spectator && !p.bot && p.openid !== H);
      const targets = r2.players.filter((p) => !p.out && p.openid !== H);
      for (const v of voters) {
        await game.handle({ action: 'wolfVote', roomId: c.roomId, target: targets[0].openid }, v.openid);
      }
      const dusk = await game.handle({ action: 'wolfDusk', roomId: c.roomId }, H);
      assert.ok(dusk.ok || !room(db) || room(db).status !== 'day',
        `seed=${seed} step=${step} 天黑卡住: ${dusk.msg}`);
    }
  }
  const r = room(db);
  assert.ok(!r || r.status === 'finished', `seed=${seed} 40 步还没结束，状态=${r && r.status}（疑似死循环）`);
  return { seed, ended: true, step: 40 };
}

async function fuzzSpy(seed) {
  const rnd = seeded(seed);
  const { game, db } = loadGame();
  const H = 'h';
  const P = ['s1', 's2', 's3', 's4', 's5'];
  const c = await game.handle({ action: 'create', gameType: 'spy', nick: '房主' }, H);
  for (const id of P) await game.handle({ action: 'join', roomCode: c.roomCode, nick: id }, id);
  for (const id of P) await game.handle({ action: 'ready', roomId: c.roomId }, id);
  const st = await game.handle({ action: 'start', roomId: c.roomId }, H);
  assert.ok(st.ok, `开局失败: ${st.msg}`);

  for (let step = 0; step < 20; step++) {
    const r = room(db);
    if (!r || r.status === 'finished') return { seed, ended: true, step };
    await maybeLeave(game, db, c, H, rnd);
    const r2 = room(db);
    if (!r2 || r2.status === 'finished') return { seed, ended: true, step };

    await game.handle({ action: 'spyVoteOpen', roomId: c.roomId }, H);
    const r3 = room(db);
    const voters = r3.players.filter((p) => !p.out && !p.spectator && !p.bot);
    const targets = r3.players.filter((p) => !p.out && !p.spectator);
    for (const v of voters) {
      const t = targets.find((x) => x.openid !== v.openid);
      if (t) await game.handle({ action: 'spyVote', roomId: c.roomId, target: t.openid }, v.openid);
    }
    const rev = await game.handle({ action: 'spyReveal', roomId: c.roomId }, H);
    assert.ok(rev.ok || !room(db) || room(db).status === 'finished',
      `seed=${seed} step=${step} 公布卡住: ${rev.msg}`);
  }
  const r = room(db);
  assert.ok(!r || r.status === 'finished', `seed=${seed} 20 步还没结束，状态=${r && r.status}`);
  return { seed, ended: true, step: 20 };
}

(async () => {
  const N = Number(process.argv[2] || 200);
  for (let i = 1; i <= N; i++) { await fuzzWolf(i); await fuzzSpy(i); }
  console.log(`✅ 随机退出压力测试：狼人杀 + 卧底 各 ${N} 局，全部能走到结束，没有卡死`);
})().catch((e) => { console.error('❌ ' + e.message); process.exit(1); });
