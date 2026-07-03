// 云函数 game —— 统一处理剧本杀对局的所有服务端操作
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const rooms = db.collection('rooms');
const scriptsCol = db.collection('scripts');   // 剧本内容集合（后台可配；首次以种子兜底）
const secrets = db.collection('spySecrets');   // 卧底局的词与身份（仅云函数可读，防 watch 泄底）
const SEED = require('./scriptsSeed.json');     // 打包种子：灌库 + 兜底
const SPY_PAIRS = require('./spywords.json');   // 谁是卧底词对库

// 各剧本的角色 id 与凶手（旧硬编码，作为 getMeta 的最终兜底，逐步由数据库取代）
// cluesByAct / searchPerAct 用于「限次搜证」：每幕可搜的线索点，及每人每幕的搜证次数上限
const SCRIPT_META = {
  tongxuehui: {
    charIds: ['chenhao', 'suting', 'wanglei', 'zhouqing', 'gaoqiang', 'limeng'],
    murderer: 'wanglei',
    actCount: 3,
    cluesByAct: [['c1', 'c4', 'c5'], ['c6', 'c2', 'c3'], ['c7', 'c8', 'c9']],
    searchPerAct: 2,
  },
  bohezhen: {
    charIds: ['gulan', 'qianwei', 'suwan', 'zhouwanqing', 'hehushi', 'linchen'],
    murderer: 'qianwei',
    actCount: 3,
    cluesByAct: [['b7', 'b8', 'b1'], ['b2', 'b3', 'b5'], ['b4', 'b6', 'b9']],
    searchPerAct: 2,
  },
  test: {
    charIds: ['xiaomei', 'aqiang', 'laoli'],
    murderer: 'xiaomei',
    actCount: 1, // 巷往咖啡馆已合成 1 幕：读卡+公开线索+讨论 → 投票
    // 咖啡馆走 autoClues（随幕自动公开，不搜证），cluesByAct 仅作参照、不参与发牌
    cluesByAct: [['t1', 't6', 't7']],
    searchPerAct: 1,
  },
  shiguang: {
    charIds: ['amay', 'dapeng', 'xiaoyu'],
    murderer: 'dapeng',
    actCount: 1, // 拾光·打烊之后：单幕，autoClues 自动公开
    cluesByAct: [['s1', 's2', 's3']],
    searchPerAct: 1,
  },
  langlangshan: {
    charIds: ['xiaohuan', 'huangpi', 'hama'],
    murderer: 'xiaohuan',
    actCount: 1, // 浪浪山·巡山日志：单幕，autoClues 自动公开
    cluesByAct: [['l1', 'l2', 'l3']],
    searchPerAct: 1,
  },
  yidaimi: {
    charIds: ['miaoshi', 'laoyang', 'zhaohuolang'],
    murderer: 'miaoshi',
    actCount: 1, // 1942·一袋米：单幕，autoClues 自动公开（凶手=告密者）
    cluesByAct: [['y1', 'y2', 'y3']],
    searchPerAct: 1,
  },
  nanji: {
    charIds: ['pangdun', 'afei', 'erleng'],
    murderer: 'pangdun',
    actCount: 1, // 南极悬案·企鹅送错了石头：3 人动物欢乐本，单幕，autoClues（「凶手」=偷石贼胖墩）
    cluesByAct: [['q1', 'q2', 'q3']],
    searchPerAct: 1,
  },
  shiqian: {
    charIds: ['dacan', 'ahuo', 'yaya'],
    murderer: 'ahuo',
    actCount: 1, // 史前悬案·圣火偷烤案：3 人史前欢乐本，单幕，autoClues（「凶手」=偷烤贼阿火）
    cluesByAct: [['h1', 'h2', 'h3']],
    searchPerAct: 1,
  },
};
const DEFAULT_SCRIPT = 'tongxuehui';

function genCode() {
  return String(Math.floor(1000 + Math.random() * 9000));
}
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

async function getRoomByCode(code) {
  const res = await rooms.where({ roomCode: code }).limit(1).get();
  return res.data[0];
}

// 从一份完整剧本对象派生发牌所需的元数据
function deriveMeta(s) {
  if (!s) return null;
  const acts = s.acts || [];
  return {
    charIds: (s.characters || []).map((c) => c.id),
    murderer: s.truth ? s.truth.murderer : undefined,
    actCount: acts.length || 1,
    cluesByAct: acts.map((a) => a.clueIds || []),
    spotsByAct: acts.map((a) => a.spots || null),
    searchPerAct: s.searchPerAct || 1,
  };
}

// 取某剧本的发牌元数据：云数据库 → 种子 JSON → 旧硬编码 三重兜底
async function getMeta(scriptId) {
  if (!scriptId) return null;
  try {
    const doc = await scriptsCol.doc(scriptId).get().then((r) => r.data).catch(() => null);
    if (doc) return deriveMeta(doc);
  } catch (e) {}
  const seed = SEED.find((s) => s.id === scriptId || s._id === scriptId);
  if (seed) return deriveMeta(seed);
  return SCRIPT_META[scriptId] || null;
}

exports.main = async (event) => {
  const { OPENID: realOpenid } = cloud.getWXContext();
  // 测试用：客户端传 uid 可模拟不同玩家身份；不传则用真实 openid
  const OPENID = event.uid || realOpenid;
  const { action } = event;

  try {
    // ── 获取自己的 openid ──
    if (action === 'whoami') {
      return { ok: true, openid: OPENID };
    }

    // ── 拉取剧本列表（客户端用）：云数据库优先，空则回退种子 ──
    if (action === 'getScripts') {
      let docs = [];
      try {
        const r = await scriptsCol.where({ shown: true }).limit(100).get();
        docs = r.data || [];
      } catch (e) {}
      if (!docs.length) docs = SEED.filter((s) => s.shown !== false);
      return { ok: true, list: docs };
    }

    // ── 写封面：把云存储 fileID 写进某剧本的 cover.image（配合 dev 页一键上传）──
    if (action === 'setCover') {
      if (!event.scriptId || !event.fileID) return { ok: false, msg: '缺少参数' };
      await scriptsCol.doc(event.scriptId).update({ data: { 'cover.image': event.fileID } }).catch(() => {});
      return { ok: true };
    }

    // ── 灌库：把打包种子写入 scripts 集合（首次配库时手动调一次；幂等）──
    if (action === 'seedScripts') {
      let seeded = 0;
      for (const s of SEED) {
        const id = s._id || s.id;
        const { _id, ...rest } = s;
        await scriptsCol.doc(id).set({ data: rest }).then(() => { seeded++; }).catch(() => {});
      }
      return { ok: true, seeded };
    }

    // ── 创建房间 ──
    if (action === 'create') {
      let code, exists;
      do {
        code = genCode();
        exists = await getRoomByCode(code);
      } while (exists);
      // 派对房间（谁是卧底/狼人杀）：无剧本，房主也是玩家
      if (event.gameType === 'spy' || event.gameType === 'wolf') {
        const data = {
          roomCode: code,
          hostOpenid: OPENID,
          gameType: event.gameType,
          status: 'waiting',
          players: [{ openid: OPENID, nick: event.nick || '玩家', avatar: event.avatar || '', ready: false, out: false }],
          round: 0,
          createdAt: db.serverDate(),
        };
        if (event.gameType === 'spy') data.spyCount = event.spyCount === 2 ? 2 : 1;
        const add = await rooms.add({ data });
        return { ok: true, roomId: add._id, roomCode: code, openid: OPENID };
      }
      const player = { openid: OPENID, nick: event.nick || '玩家', avatar: event.avatar || '', gender: event.gender || '', charId: '' };
      const scriptId = (await getMeta(event.scriptId)) ? event.scriptId : DEFAULT_SCRIPT;
      const add = await rooms.add({
        data: {
          roomCode: code,
          hostOpenid: OPENID,
          scriptId,
          status: 'waiting',
          players: [player],
          revealedClues: [],
          votes: {},
          createdAt: db.serverDate(),
        },
      });
      return { ok: true, roomId: add._id, roomCode: code, openid: OPENID };
    }

    // ── 加入房间 ──
    if (action === 'join') {
      const room = await getRoomByCode(event.roomCode);
      if (!room) return { ok: false, msg: '房间不存在' };
      const already = room.players.find((p) => p.openid === OPENID);
      if (already) return { ok: true, roomId: room._id, roomCode: room.roomCode, gameType: room.gameType || '', spectator: !!already.spectator };
      // 派对房（卧底/狼人杀）：开局后不能进（身份已发完），最多 12 人
      if (room.gameType === 'spy' || room.gameType === 'wolf') {
        if (room.status !== 'waiting') return { ok: false, msg: '本局已开始，等下一局再来' };
        if (room.players.length >= 12) return { ok: false, msg: '房间已满（最多 12 人）' };
        await rooms.doc(room._id).update({
          data: { players: _.push({ openid: OPENID, nick: event.nick || '玩家', avatar: event.avatar || '', ready: false, out: false }) },
        });
        return { ok: true, roomId: room._id, roomCode: room.roomCode, gameType: room.gameType, openid: OPENID };
      }
      // 游戏开始后进来的，一律作为「吃瓜群众」：只能看第一幕、不参与搜证/投票
      const asSpectator = !!(room.status && room.status !== 'waiting');
      if (!asSpectator && room.players.length >= 6) return { ok: false, msg: '房间已满（最多 6 人）' };
      if (asSpectator && room.players.length >= 30) return { ok: false, msg: '围观人数已满' };
      await rooms.doc(room._id).update({
        data: { players: _.push({ openid: OPENID, nick: event.nick || '玩家', avatar: event.avatar || '', gender: event.gender || '', charId: '', spectator: asSpectator }) },
      });
      return { ok: true, roomId: room._id, roomCode: room.roomCode, openid: OPENID, spectator: asSpectator };
    }

    // ── 离开房间 ──
    if (action === 'leave') {
      const room = await rooms.doc(event.roomId).get().then((r) => r.data).catch(() => null);
      if (!room) return { ok: true };
      const meLeaving = (room.players || []).find((p) => p.openid === OPENID);
      // 吃瓜群众退出：只移除自己，不影响本局（不解散）
      if (meLeaving && meLeaving.spectator) {
        await rooms.doc(event.roomId).update({ data: { players: room.players.filter((p) => p.openid !== OPENID) } });
        return { ok: true };
      }
      // 游戏已开始（非等待）：真实玩家退出 → 直接解散，本局结束
      if (room.status && room.status !== 'waiting') {
        await rooms.doc(event.roomId).remove();
        if (room.gameType === 'spy') await secrets.doc(event.roomId).remove().catch(() => {});
        return { ok: true, dissolved: true };
      }
      const players = room.players.filter((p) => p.openid !== OPENID);
      if (players.length === 0) {
        await rooms.doc(event.roomId).remove();
        if (room.gameType === 'spy') await secrets.doc(event.roomId).remove().catch(() => {});
        return { ok: true, dissolved: true };
      }
      const data = { players };
      if (room.hostOpenid === OPENID) data.hostOpenid = players[0].openid; // 房主退出则转移房主
      await rooms.doc(event.roomId).update({ data });
      return { ok: true };
    }

    // ── 玩家准备 / 取消准备（仅等待阶段）──
    if (action === 'ready') {
      const room = await rooms.doc(event.roomId).get().then((r) => r.data).catch(() => null);
      if (!room) return { ok: false, msg: '房间不存在' };
      if (room.status && room.status !== 'waiting') return { ok: false, msg: '游戏已开始' };
      const players = (room.players || []).map((p) =>
        p.openid === OPENID ? { ...p, ready: !p.ready } : p
      );
      await rooms.doc(event.roomId).update({ data: { players } });
      return { ok: true };
    }

    // ── 开始游戏：发牌分角色 ──
    if (action === 'start') {
      const room = await rooms.doc(event.roomId).get().then((r) => r.data);
      if (room.hostOpenid !== OPENID) return { ok: false, msg: '只有房主可以开始游戏' };

      // 卧底局：随机词对+随机卧底，词写入 spySecrets（不进 room 文档，防 watch 泄底）
      if (room.gameType === 'spy') {
        if (room.status !== 'waiting') return { ok: false, msg: '游戏已开始' };
        const ps = room.players || [];
        if (ps.length < 4) return { ok: false, msg: `至少 4 人才能开始（现在 ${ps.length} 人）` };
        const notReady = ps.filter((p) => p.openid !== room.hostOpenid && !p.ready);
        if (notReady.length) return { ok: false, msg: `还有 ${notReady.length} 名玩家未点准备` };
        let spyCount = room.spyCount === 2 ? 2 : 1;
        if (spyCount === 2 && ps.length < 6) spyCount = 1;   // 人少时兜底 1 卧底
        const pair = SPY_PAIRS[Math.floor(Math.random() * SPY_PAIRS.length)];
        const flip = Math.random() < 0.5;
        const civilWord = pair[flip ? 0 : 1];
        const spyWord = pair[flip ? 1 : 0];
        const spies = shuffle(ps.map((p) => p.openid)).slice(0, spyCount);
        const words = {};
        ps.forEach((p) => { words[p.openid] = spies.includes(p.openid) ? spyWord : civilWord; });
        await secrets.doc(event.roomId).set({ data: { words, spies, civilWord, spyWord, createdAt: db.serverDate() } });
        const players = ps.map((p) => ({ ...p, out: false }));
        await rooms.doc(event.roomId).update({ data: { players, status: 'playing', round: 1 } });
        return { ok: true };
      }

      // 狼人杀：随机发身份入夜（无上帝，夜晚 App 收集行动自动结算）
      if (room.gameType === 'wolf') {
        if (room.status !== 'waiting') return { ok: false, msg: '游戏已开始' };
        const ps = room.players || [];
        if (ps.length < 6) return { ok: false, msg: `至少 6 人才能开始（现在 ${ps.length} 人）` };
        const notReady = ps.filter((p) => p.openid !== room.hostOpenid && !p.ready);
        if (notReady.length) return { ok: false, msg: `还有 ${notReady.length} 名玩家未点准备` };
        const wolves = ps.length >= 10 ? 3 : 2;   // 6–9人=2狼，10–12人=3狼；神职固定：预言家+女巫
        const deck = shuffle(ps.map((p) => p.openid));
        const roles = {};
        deck.forEach((id, i) => {
          roles[id] = i < wolves ? 'wolf' : i === wolves ? 'seer' : i === wolves + 1 ? 'witch' : 'villager';
        });
        await secrets.doc(event.roomId).set({
          data: { roles, potions: { save: true, poison: true }, night: { wolfVotes: {} }, checks: [], createdAt: db.serverDate() },
        });
        const players = ps.map((p) => ({ ...p, out: false }));
        await rooms.doc(event.roomId).update({
          data: { players, status: 'night', round: 1, nightVer: 1, announce: _.remove(), reveal: _.remove() },
        });
        return { ok: true };
      }

      const meta = (await getMeta(room.scriptId)) || (await getMeta(DEFAULT_SCRIPT));
      // 房主只主持、不参与；吃瓜群众也不发牌，只给真实玩家发牌
      const realPlayers = room.players.filter((p) => p.openid !== room.hostOpenid && !p.spectator);
      if (realPlayers.length < meta.charIds.length) return { ok: false, msg: `需要 ${meta.charIds.length} 名玩家才能开始（房主不参与）` };
      if (realPlayers.length > meta.charIds.length) return { ok: false, msg: `该剧本最多 ${meta.charIds.length} 名玩家（房主除外）` };
      const notReady = realPlayers.filter((p) => !p.ready);
      if (notReady.length) return { ok: false, msg: `还有 ${notReady.length} 名玩家未点准备` };

      const n = realPlayers.length;
      // 凶手角色一定发给真实玩家，其余随机补足
      const others = shuffle(meta.charIds.filter((id) => id !== meta.murderer)).slice(0, Math.max(0, n - 1));
      const dealt = shuffle([meta.murderer, ...others]);
      let i = 0;
      const players = room.players.map((p) =>
        (p.openid === room.hostOpenid || p.spectator) ? { ...p, charId: '' } : { ...p, charId: dealt[i++] }
      );
      // 未分配出去的角色 → 公开嫌疑人
      const npc = meta.charIds.filter((id) => !dealt.includes(id));

      await rooms.doc(event.roomId).update({
        data: { players, npcChars: npc, status: 'playing', actIndex: 0, votes: {}, searches: {} },
      });
      return { ok: true };
    }

    // ── 限次搜证：玩家搜查当前幕的某个地点（房主不参与）──
    if (action === 'search') {
      const room = await rooms.doc(event.roomId).get().then((r) => r.data);
      if (room.hostOpenid === OPENID) return { ok: false, msg: '主持人不参与搜证' };
      if (room.status !== 'playing') return { ok: false, msg: '当前不在剧情阶段' };
      const meta = (await getMeta(room.scriptId)) || (await getMeta(DEFAULT_SCRIPT));
      const idx = room.actIndex || 0;
      // 优先用按地点的 spotsByAct；没有则退回老的 cluesByAct（地点 id = 线索 id）
      const actSpots = (meta.spotsByAct && meta.spotsByAct[idx]) || (meta.cluesByAct && meta.cluesByAct[idx]) || [];
      const spotId = event.spotId || event.clueId; // 兼容旧端
      if (!actSpots.includes(spotId)) return { ok: false, msg: '只能搜查当前幕的地点' };

      const searches = room.searches || {};
      const mine = searches[OPENID] || [];
      if (mine.includes(spotId)) return { ok: true }; // 已搜过，幂等
      const usedThisAct = mine.filter((id) => actSpots.includes(id)).length;
      if (usedThisAct >= (meta.searchPerAct || 1)) {
        return { ok: false, msg: '本幕搜证次数已用完' };
      }
      await rooms.doc(event.roomId).update({
        data: { ['searches.' + OPENID]: mine.concat(spotId) },
      });
      return { ok: true };
    }

    // ── 主持人逐幕推进：playing(逐幕) → voting → finished ──
    if (action === 'advance') {
      const room = await rooms.doc(event.roomId).get().then((r) => r.data);
      if (room.hostOpenid !== OPENID) return { ok: false, msg: '只有主持人可以推进流程' };
      const meta = (await getMeta(room.scriptId)) || (await getMeta(DEFAULT_SCRIPT));
      const data = {};
      if (room.status === 'voting') {
        // 必须全部玩家投完才能公布真相（房主不参与）
        const voted = Object.keys(room.votes || {}).length;
        const total = (room.players || []).filter((p) => p.openid !== room.hostOpenid && !p.spectator).length;
        if (voted < total) return { ok: false, msg: `还有 ${total - voted} 人没投票` };
        data.status = 'finished';                              // 公布真相
      } else if (room.status !== 'finished') {
        // playing 及旧状态(reading/searching)都按逐幕推进
        const idx = room.actIndex || 0;
        if (idx < meta.actCount - 1) data.actIndex = idx + 1;  // 进入下一幕
        else data.status = 'voting';                           // 末幕 → 投票
        if (room.status !== 'playing') data.status = data.status || 'playing'; // 修正旧状态
      }
      await rooms.doc(event.roomId).update({ data });
      // 返回推进后的最新状态，便于主持人端即时渲染、不必等实时推送
      return {
        ok: true,
        actIndex: data.actIndex !== undefined ? data.actIndex : (room.actIndex || 0),
        status: data.status !== undefined ? data.status : room.status,
      };
    }

    // ── 主持人回退：voting → playing（退回剧情，作废本轮投票）──
    if (action === 'rewind') {
      const room = await rooms.doc(event.roomId).get().then((r) => r.data);
      if (room.hostOpenid !== OPENID) return { ok: false, msg: '只有主持人可以操作' };
      if (room.status !== 'voting') return { ok: false, msg: '当前不在投票阶段' };
      const meta = (await getMeta(room.scriptId)) || (await getMeta(DEFAULT_SCRIPT));
      const actIndex = Math.max(0, meta.actCount - 1);
      await rooms.doc(event.roomId).update({ data: { status: 'playing', actIndex, votes: {} } });
      return { ok: true, status: 'playing', actIndex };
    }

    // ── 投票（房主不参与）──
    if (action === 'vote') {
      const room = await rooms.doc(event.roomId).get().then((r) => r.data);
      if (room.hostOpenid === OPENID) return { ok: false, msg: '主持人不参与投票' };
      const voter = (room.players || []).find((p) => p.openid === OPENID);
      if (voter && voter.spectator) return { ok: false, msg: '吃瓜群众不能投票' };
      const key = 'votes.' + OPENID;
      await rooms.doc(event.roomId).update({ data: { [key]: event.charId } });
      return { ok: true };
    }

    // ── 卧底：拉自己的词（只回自己的，不说是不是卧底）──
    if (action === 'myWord') {
      const sec = await secrets.doc(event.roomId).get().then((r) => r.data).catch(() => null);
      if (!sec) return { ok: false, msg: '本局还没发词' };
      const word = sec.words && sec.words[OPENID];
      if (!word) return { ok: false, msg: '你不在本局中' };
      return { ok: true, word };
    }

    // ═══════════ 狼人杀（无上帝：夜晚收集行动自动结算，白天群里讨论、房主点人出局） ═══════════
    const WOLF_NAMES = { wolf: '狼人', seer: '预言家', witch: '女巫', villager: '平民' };
    const wolfAliveOf = (room) => (room.players || []).filter((p) => !p.out);
    // 夜晚是否收集完毕：狼刀已定 && 预言家已查(或已死) && 女巫已动(或已死)
    const wolfNightComplete = (room, sec) => {
      const night = sec.night || {};
      const alive = wolfAliveOf(room);
      const seerAlive = alive.some((p) => sec.roles[p.openid] === 'seer');
      const witchAlive = alive.some((p) => sec.roles[p.openid] === 'witch');
      return night.wolfKill !== undefined && (night.seerDone || !seerAlive) && (night.witchDone || !witchAlive);
    };
    const wolfRevealData = (sec, players, winner) => ({
      winner,
      roles: (players || []).map((p) => ({
        openid: p.openid, nick: p.nick,
        role: sec.roles[p.openid] || 'villager',
        roleName: WOLF_NAMES[sec.roles[p.openid]] || '平民',
      })),
    });
    // 天亮结算：救/毒/刀 → 死讯 → 判胜负或进入白天（条件更新保证只结算一次）
    const wolfSettleNight = async (roomId, room, sec) => {
      const night = sec.night || {};
      const kill = night.witchSave ? null : (night.wolfKill || null);
      const deaths = [];
      if (kill) deaths.push(kill);
      if (night.witchPoison && deaths.indexOf(night.witchPoison) < 0) deaths.push(night.witchPoison);
      const players = (room.players || []).map((p) => (deaths.indexOf(p.openid) >= 0 ? { ...p, out: true } : p));
      const deadNicks = players.filter((p) => deaths.indexOf(p.openid) >= 0).map((p) => p.nick);
      const alive = players.filter((p) => !p.out);
      const wolvesAlive = alive.filter((p) => sec.roles[p.openid] === 'wolf').length;
      const announce = { type: 'dawn', round: room.round, deaths: deadNicks, peace: !deaths.length };
      let data;
      if (wolvesAlive === 0) data = { players, status: 'finished', announce, reveal: wolfRevealData(sec, players, 'good') };
      else if (wolvesAlive * 2 >= alive.length) data = { players, status: 'finished', announce, reveal: wolfRevealData(sec, players, 'wolf') };
      else data = { players, status: 'day', announce };
      data.nightVer = _.inc(1);
      await rooms.where({ _id: roomId, status: 'night', round: room.round }).update({ data });
    };
    // 每次夜间行动后：收齐则结算，否则 bump nightVer 让端上刷新
    const wolfAfterAct = async (roomId, room) => {
      const sec = await secrets.doc(roomId).get().then((r) => r.data).catch(() => null);
      if (!sec) return;
      if (wolfNightComplete(room, sec)) return wolfSettleNight(roomId, room, sec);
      await rooms.doc(roomId).update({ data: { nightVer: _.inc(1) } }).catch(() => {});
    };

    // ── 狼人杀：我的身份（狼人附带队友昵称）──
    if (action === 'wolfRole') {
      const room = await rooms.doc(event.roomId).get().then((r) => r.data).catch(() => null);
      if (!room || room.gameType !== 'wolf') return { ok: false, msg: '房间不存在' };
      const sec = await secrets.doc(event.roomId).get().then((r) => r.data).catch(() => null);
      if (!sec) return { ok: false, msg: '本局还没发身份' };
      const role = sec.roles[OPENID];
      if (!role) return { ok: false, msg: '你不在本局中' };
      const mates = role === 'wolf'
        ? (room.players || []).filter((p) => sec.roles[p.openid] === 'wolf' && p.openid !== OPENID).map((p) => p.nick)
        : [];
      return { ok: true, role, mates };
    }

    // ── 狼人杀：夜晚状态（只回自己角色可见的信息）──
    if (action === 'wolfNightState') {
      const room = await rooms.doc(event.roomId).get().then((r) => r.data).catch(() => null);
      if (!room || room.gameType !== 'wolf') return { ok: false, msg: '房间不存在' };
      if (room.status !== 'night') return { ok: true, phase: room.status };
      const sec = await secrets.doc(event.roomId).get().then((r) => r.data).catch(() => null);
      if (!sec) return { ok: false, msg: '本局数据异常' };
      const role = sec.roles[OPENID];
      if (!role) return { ok: false, msg: '你不在本局中' };
      const nickOf = (id) => { const p = (room.players || []).find((x) => x.openid === id); return p ? p.nick : ''; };
      const night = sec.night || {};
      const alive = wolfAliveOf(room);
      const wolvesDone = night.wolfKill !== undefined;
      const meOut = !alive.some((p) => p.openid === OPENID);
      const base = { ok: true, phase: 'night', role, meOut };
      if (meOut) return base;
      if (role === 'wolf') {
        const votes = alive.filter((p) => sec.roles[p.openid] === 'wolf')
          .map((p) => ({ nick: p.nick, target: nickOf((night.wolfVotes || {})[p.openid]) }));
        return { ...base, myVote: (night.wolfVotes || {})[OPENID] || '', votes, done: wolvesDone, kill: wolvesDone && night.wolfKill ? nickOf(night.wolfKill) : '' };
      }
      if (role === 'seer') {
        const history = (sec.checks || []).map((c) => ({ round: c.round, nick: nickOf(c.target), isWolf: c.isWolf }));
        return { ...base, done: !!night.seerDone, history };
      }
      if (role === 'witch') {
        if (!wolvesDone) return { ...base, unlocked: false, done: false };
        return {
          ...base, unlocked: true, done: !!night.witchDone,
          killId: night.wolfKill || '', killNick: night.wolfKill ? nickOf(night.wolfKill) : '',
          canSave: !!(sec.potions && sec.potions.save) && !!night.wolfKill,
          canPoison: !!(sec.potions && sec.potions.poison),
        };
      }
      return { ...base, done: true };
    }

    // ── 狼人杀：夜晚行动（狼刀/查验/用药），收齐自动天亮 ──
    if (action === 'wolfNightAct') {
      const room = await rooms.doc(event.roomId).get().then((r) => r.data).catch(() => null);
      if (!room || room.gameType !== 'wolf') return { ok: false, msg: '房间不存在' };
      if (room.status !== 'night') return { ok: false, msg: '现在不是夜晚' };
      const sec = await secrets.doc(event.roomId).get().then((r) => r.data).catch(() => null);
      if (!sec) return { ok: false, msg: '本局数据异常' };
      const role = sec.roles[OPENID];
      const meP = (room.players || []).find((p) => p.openid === OPENID);
      if (!role || !meP) return { ok: false, msg: '你不在本局中' };
      if (meP.out) return { ok: false, msg: '你已出局' };
      const night = sec.night || {};
      const aliveIds = wolfAliveOf(room).map((p) => p.openid);
      const nickOf = (id) => { const p = (room.players || []).find((x) => x.openid === id); return p ? p.nick : ''; };

      // 狼人提刀：全员提交后定刀（多数票，平票取最后提交）
      if (role === 'wolf' && event.act === 'kill') {
        if (night.wolfKill !== undefined) return { ok: false, msg: '刀口已确定' };
        if (event.target === OPENID) return { ok: false, msg: '不能刀自己' };
        if (aliveIds.indexOf(event.target) < 0) return { ok: false, msg: '目标无效' };
        await secrets.doc(event.roomId).update({ data: { ['night.wolfVotes.' + OPENID]: event.target } });
        const s2 = await secrets.doc(event.roomId).get().then((r) => r.data).catch(() => null);
        if (!s2) return { ok: false, msg: '本局数据异常' };
        const n2 = s2.night || {};
        const aliveWolves = wolfAliveOf(room).filter((p) => s2.roles[p.openid] === 'wolf');
        if (n2.wolfKill === undefined && aliveWolves.every((p) => (n2.wolfVotes || {})[p.openid])) {
          const cnt = {};
          aliveWolves.forEach((p) => { const t = n2.wolfVotes[p.openid]; cnt[t] = (cnt[t] || 0) + 1; });
          let kill = event.target, max = 0;
          Object.keys(cnt).forEach((t) => { if (cnt[t] > max) { max = cnt[t]; kill = t; } });
          if (Object.keys(cnt).filter((t) => cnt[t] === max).length > 1) kill = event.target;  // 平票取最后提交
          await secrets.doc(event.roomId).update({ data: { 'night.wolfKill': kill } });
        }
        await wolfAfterAct(event.roomId, room);
        return { ok: true };
      }

      // 预言家查验：立刻返回结果
      if (role === 'seer' && event.act === 'check') {
        if (night.seerDone) return { ok: false, msg: '今晚已查验过' };
        if (event.target === OPENID) return { ok: false, msg: '不用查自己' };
        if (aliveIds.indexOf(event.target) < 0) return { ok: false, msg: '目标无效' };
        const isWolf = sec.roles[event.target] === 'wolf';
        await secrets.doc(event.roomId).update({
          data: { 'night.seerDone': true, checks: _.push({ round: room.round, target: event.target, isWolf }) },
        });
        await wolfAfterAct(event.roomId, room);
        return { ok: true, isWolf, nick: nickOf(event.target) };
      }

      // 女巫：救 / 毒 / 不用药（需等狼人定刀后）
      if (role === 'witch') {
        if (night.wolfKill === undefined) return { ok: false, msg: '狼人还没动手，再等等' };
        if (night.witchDone) return { ok: false, msg: '今晚已行动过' };
        const upd = { 'night.witchDone': true };
        if (event.act === 'save') {
          if (!(sec.potions && sec.potions.save)) return { ok: false, msg: '解药已用完' };
          if (!night.wolfKill) return { ok: false, msg: '今晚没人被刀' };
          upd['night.witchSave'] = true;
          upd['potions.save'] = false;
        } else if (event.act === 'poison') {
          if (!(sec.potions && sec.potions.poison)) return { ok: false, msg: '毒药已用完' };
          if (event.target === OPENID) return { ok: false, msg: '不能毒自己' };
          if (aliveIds.indexOf(event.target) < 0) return { ok: false, msg: '目标无效' };
          upd['night.witchPoison'] = event.target;
          upd['potions.poison'] = false;
        } else if (event.act !== 'skip') {
          return { ok: false, msg: '无效操作' };
        }
        await secrets.doc(event.roomId).update({ data: upd });
        await wolfAfterAct(event.roomId, room);
        return { ok: true };
      }
      return { ok: false, msg: '无效操作' };
    }

    // ── 狼人杀：房主强制天亮（未行动一律视为无操作）──
    if (action === 'wolfForce') {
      const room = await rooms.doc(event.roomId).get().then((r) => r.data).catch(() => null);
      if (!room || room.gameType !== 'wolf') return { ok: false, msg: '房间不存在' };
      if (room.hostOpenid !== OPENID) return { ok: false, msg: '只有房主可以强制天亮' };
      if (room.status !== 'night') return { ok: false, msg: '现在不是夜晚' };
      const sec = await secrets.doc(event.roomId).get().then((r) => r.data).catch(() => null);
      if (!sec) return { ok: false, msg: '本局数据异常' };
      const night = sec.night || {};
      const upd = {};
      if (night.wolfKill === undefined) upd['night.wolfKill'] = null;   // 空刀
      if (!night.seerDone) upd['night.seerDone'] = true;
      if (!night.witchDone) upd['night.witchDone'] = true;
      if (Object.keys(upd).length) await secrets.doc(event.roomId).update({ data: upd });
      const s2 = await secrets.doc(event.roomId).get().then((r) => r.data).catch(() => null);
      if (s2) await wolfSettleNight(event.roomId, room, s2);
      return { ok: true };
    }

    // ── 狼人杀：白天出局（群里口头投票后房主执行），出局亮身份 ──
    if (action === 'wolfDayOut') {
      const room = await rooms.doc(event.roomId).get().then((r) => r.data).catch(() => null);
      if (!room || room.gameType !== 'wolf') return { ok: false, msg: '房间不存在' };
      if (room.hostOpenid !== OPENID) return { ok: false, msg: '只有房主可以执行出局' };
      if (room.status !== 'day') return { ok: false, msg: '现在不是白天' };
      const t = (room.players || []).find((p) => p.openid === event.target);
      if (!t || t.out) return { ok: false, msg: '目标无效' };
      const sec = await secrets.doc(event.roomId).get().then((r) => r.data).catch(() => null);
      if (!sec) return { ok: false, msg: '本局数据异常' };
      const players = (room.players || []).map((p) => (p.openid === event.target ? { ...p, out: true } : p));
      const alive = players.filter((p) => !p.out);
      const wolvesAlive = alive.filter((p) => sec.roles[p.openid] === 'wolf').length;
      const announce = {
        type: 'out', round: room.round, nick: t.nick,
        roleName: WOLF_NAMES[sec.roles[event.target]] || '平民',
      };
      let data;
      if (wolvesAlive === 0) data = { players, status: 'finished', announce, reveal: wolfRevealData(sec, players, 'good') };
      else if (wolvesAlive * 2 >= alive.length) data = { players, status: 'finished', announce, reveal: wolfRevealData(sec, players, 'wolf') };
      else {
        data = { players, status: 'night', round: room.round + 1, announce };
        await secrets.doc(event.roomId).update({ data: { night: _.set({ wolfVotes: {} }) } });  // 重置夜晚
      }
      data.nightVer = _.inc(1);
      await rooms.where({ _id: event.roomId, status: 'day', round: room.round }).update({ data });
      return { ok: true };
    }

    // ── 狼人杀：房主提前揭晓（公开身份，结束本局）──
    if (action === 'wolfReveal') {
      const room = await rooms.doc(event.roomId).get().then((r) => r.data).catch(() => null);
      if (!room || room.gameType !== 'wolf') return { ok: false, msg: '房间不存在' };
      if (room.hostOpenid !== OPENID) return { ok: false, msg: '只有房主可以揭晓' };
      if (room.status !== 'night' && room.status !== 'day') return { ok: false, msg: '当前不在游戏中' };
      const sec = await secrets.doc(event.roomId).get().then((r) => r.data).catch(() => null);
      if (!sec) return { ok: false, msg: '本局数据异常' };
      await rooms.doc(event.roomId).update({
        data: { status: 'finished', reveal: wolfRevealData(sec, room.players, ''), nightVer: _.inc(1) },
      });
      return { ok: true };
    }

    // ── 卧底：房主揭晓（公布词对与卧底名单，进入 finished）──
    if (action === 'spyReveal') {
      const room = await rooms.doc(event.roomId).get().then((r) => r.data).catch(() => null);
      if (!room) return { ok: false, msg: '房间不存在' };
      if (room.gameType !== 'spy') return { ok: false, msg: '不是卧底局' };
      if (room.hostOpenid !== OPENID) return { ok: false, msg: '只有房主可以揭晓' };
      if (room.status !== 'playing') return { ok: false, msg: '当前不在游戏中' };
      const sec = await secrets.doc(event.roomId).get().then((r) => r.data).catch(() => null);
      if (!sec) return { ok: false, msg: '本局数据异常' };
      await rooms.doc(event.roomId).update({
        data: { status: 'finished', reveal: { civilWord: sec.civilWord, spyWord: sec.spyWord, spies: sec.spies } },
      });
      return { ok: true };
    }

    // ── 主持人结束游戏，解散房间 ──
    if (action === 'dissolve') {
      const room = await rooms.doc(event.roomId).get().then((r) => r.data).catch(() => null);
      if (!room) return { ok: true };
      if (room.hostOpenid !== OPENID) return { ok: false, msg: '只有主持人可以结束游戏' };
      await rooms.doc(event.roomId).remove();
      if (room.gameType === 'spy') await secrets.doc(event.roomId).remove().catch(() => {});
      return { ok: true, dissolved: true };
    }

    // ── 重置房间，再来一局 ──
    if (action === 'reset') {
      const room = await rooms.doc(event.roomId).get().then((r) => r.data);
      if (room.hostOpenid !== OPENID) return { ok: false, msg: '只有房主可以重开' };
      // 派对局重开（卧底/狼人杀）：清准备/出局状态，删上局的秘密数据
      if (room.gameType === 'spy' || room.gameType === 'wolf') {
        const players = room.players.map((p) => ({ ...p, ready: false, out: false }));
        await rooms.doc(event.roomId).update({
          data: { players, status: 'waiting', round: 0, reveal: _.remove(), announce: _.remove(), nightVer: _.remove() },
        });
        await secrets.doc(event.roomId).remove().catch(() => {});
        return { ok: true };
      }
      // 再来一局：清空发牌，并把吃瓜群众转为正常等待玩家
      const players = room.players.map((p) => ({ ...p, charId: '', spectator: false }));
      await rooms.doc(event.roomId).update({
        data: { players, status: 'waiting', actIndex: 0, votes: {}, npcChars: [], searches: {} },
      });
      return { ok: true };
    }

    return { ok: false, msg: '未知操作: ' + action };
  } catch (e) {
    return { ok: false, msg: '服务异常: ' + (e && e.message ? e.message : e) };
  }
};
