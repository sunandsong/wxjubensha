// 云函数 game —— 统一处理剧本杀对局的所有服务端操作
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();
const _ = db.command;
const rooms = db.collection('rooms');

// 各剧本的角色 id 与凶手（需与小程序端 utils/scripts.js 保持一致）
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
    actCount: 4,
    cluesByAct: [['t1'], ['t6', 't2', 't4'], ['t3', 't5'], ['t8']],
    // 按地点搜证：每幕可搜的地点 id（含搜了一无所获的空地点）
    spotsByAct: [['p1a', 'p1b'], ['p2a', 'p2b', 'p2c'], ['p3a', 'p3b', 'p3c'], ['p4a', 'p4b']],
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

    // ── 创建房间 ──
    if (action === 'create') {
      let code, exists;
      do {
        code = genCode();
        exists = await getRoomByCode(code);
      } while (exists);
      const player = { openid: OPENID, nick: event.nick || '玩家', avatar: event.avatar || '', charId: '' };
      const scriptId = SCRIPT_META[event.scriptId] ? event.scriptId : DEFAULT_SCRIPT;
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
      if (room.status !== 'waiting') return { ok: false, msg: '游戏已开始，无法加入' };
      const already = room.players.find((p) => p.openid === OPENID);
      if (already) return { ok: true, roomId: room._id, roomCode: room.roomCode };
      if (room.players.length >= 6) return { ok: false, msg: '房间已满（最多 6 人）' };
      await rooms.doc(room._id).update({
        data: { players: _.push({ openid: OPENID, nick: event.nick || '玩家', avatar: event.avatar || '', charId: '' }) },
      });
      return { ok: true, roomId: room._id, roomCode: room.roomCode, openid: OPENID };
    }

    // ── 离开房间 ──
    if (action === 'leave') {
      const room = await rooms.doc(event.roomId).get().then((r) => r.data).catch(() => null);
      if (!room) return { ok: true };
      const players = room.players.filter((p) => p.openid !== OPENID);
      if (players.length === 0) {
        await rooms.doc(event.roomId).remove();
        return { ok: true, dissolved: true };
      }
      const data = { players };
      if (room.hostOpenid === OPENID) data.hostOpenid = players[0].openid; // 房主退出则转移房主
      await rooms.doc(event.roomId).update({ data });
      return { ok: true };
    }

    // ── 开始游戏：发牌分角色 ──
    if (action === 'start') {
      const room = await rooms.doc(event.roomId).get().then((r) => r.data);
      if (room.hostOpenid !== OPENID) return { ok: false, msg: '只有房主可以开始游戏' };

      const meta = SCRIPT_META[room.scriptId] || SCRIPT_META[DEFAULT_SCRIPT];
      // 房主只主持、不参与，只给其余玩家发牌
      const realPlayers = room.players.filter((p) => p.openid !== room.hostOpenid);
      if (realPlayers.length < 1) return { ok: false, msg: '至少需要 1 名玩家（房主不参与）' };
      if (realPlayers.length > meta.charIds.length) return { ok: false, msg: `该剧本最多 ${meta.charIds.length} 名玩家（房主除外）` };

      const n = realPlayers.length;
      // 凶手角色一定发给真实玩家，其余随机补足
      const others = shuffle(meta.charIds.filter((id) => id !== meta.murderer)).slice(0, Math.max(0, n - 1));
      const dealt = shuffle([meta.murderer, ...others]);
      let i = 0;
      const players = room.players.map((p) =>
        p.openid === room.hostOpenid ? { ...p, charId: '' } : { ...p, charId: dealt[i++] }
      );
      // 未分配出去的角色 → 公开嫌疑人
      const npc = meta.charIds.filter((id) => !dealt.includes(id));

      await rooms.doc(event.roomId).update({
        data: { players, npcChars: npc, status: 'playing', actIndex: 0, votes: {}, searches: {}, ready: {} },
      });
      return { ok: true };
    }

    // ── 玩家标记「本幕任务已完成」（房主无任务）──
    if (action === 'taskDone') {
      const room = await rooms.doc(event.roomId).get().then((r) => r.data);
      if (room.hostOpenid === OPENID) return { ok: false, msg: '主持人没有任务' };
      if (room.status !== 'playing') return { ok: false, msg: '当前不在剧情阶段' };
      const idx = room.actIndex || 0;
      // ready[openid] = 已完成到第几幕（index）；推进后该值 < 新幕，自动变回未完成
      await rooms.doc(event.roomId).update({ data: { ['ready.' + OPENID]: idx } });
      return { ok: true };
    }

    // ── 限次搜证：玩家搜查当前幕的某个地点（房主不参与）──
    if (action === 'search') {
      const room = await rooms.doc(event.roomId).get().then((r) => r.data);
      if (room.hostOpenid === OPENID) return { ok: false, msg: '主持人不参与搜证' };
      if (room.status !== 'playing') return { ok: false, msg: '当前不在剧情阶段' };
      const meta = SCRIPT_META[room.scriptId] || SCRIPT_META[DEFAULT_SCRIPT];
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
      const meta = SCRIPT_META[room.scriptId] || SCRIPT_META[DEFAULT_SCRIPT];
      // 剧情阶段推进前，须全员完成本幕任务（主持人可传 force 强行推进）
      if (room.status !== 'voting' && room.status !== 'finished' && !event.force) {
        const idx = room.actIndex || 0;
        const ready = room.ready || {};
        const notReady = (room.players || []).filter(
          (p) => p.openid !== room.hostOpenid && !((ready[p.openid] != null) && ready[p.openid] >= idx)
        );
        if (notReady.length) {
          return { ok: false, msg: `还有 ${notReady.length} 人未完成本幕任务`, needForce: true };
        }
      }
      const data = {};
      if (room.status === 'voting') {
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

    // ── 投票（房主不参与）──
    if (action === 'vote') {
      const room = await rooms.doc(event.roomId).get().then((r) => r.data);
      if (room.hostOpenid === OPENID) return { ok: false, msg: '主持人不参与投票' };
      const key = 'votes.' + OPENID;
      await rooms.doc(event.roomId).update({ data: { [key]: event.charId } });
      return { ok: true };
    }

    // ── 主持人结束游戏，解散房间 ──
    if (action === 'dissolve') {
      const room = await rooms.doc(event.roomId).get().then((r) => r.data).catch(() => null);
      if (!room) return { ok: true };
      if (room.hostOpenid !== OPENID) return { ok: false, msg: '只有主持人可以结束游戏' };
      await rooms.doc(event.roomId).remove();
      return { ok: true, dissolved: true };
    }

    // ── 重置房间，再来一局 ──
    if (action === 'reset') {
      const room = await rooms.doc(event.roomId).get().then((r) => r.data);
      if (room.hostOpenid !== OPENID) return { ok: false, msg: '只有房主可以重开' };
      const players = room.players.map((p) => ({ ...p, charId: '' }));
      await rooms.doc(event.roomId).update({
        data: { players, status: 'waiting', actIndex: 0, votes: {}, npcChars: [], searches: {}, ready: {} },
      });
      return { ok: true };
    }

    return { ok: false, msg: '未知操作: ' + action };
  } catch (e) {
    return { ok: false, msg: '服务异常: ' + (e && e.message ? e.message : e) };
  }
};
