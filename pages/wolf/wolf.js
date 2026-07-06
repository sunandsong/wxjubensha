// 狼人杀 · 无上帝自动主持：创建/加入 → 全员准备 → 云端发身份入夜 →
// 夜晚各角色在 App 里行动（云端收齐自动天亮）→ 白天回群里讨论、口头投票后房主点人出局 → 循环至分胜负
const app = getApp();
const IMGCACHE = require('../../utils/imgCache.js');

// 牌面素材（云存储 games/）：图腾卡背 + 四张木刻角色牌
const GBASE = 'cloud://cloud1-d6g6wknyy4d198022.636c-cloud1-d6g6wknyy4d198022-1446823337/games';
const BACK_FID = GBASE + '/wolf_back.jpg';
const BGN_FID = GBASE + '/wolf_bg_n.jpg';   // 松林夜(萤火虫满月)
const BGD_FID = GBASE + '/wolf_bg_d.jpg';   // 同一片松林的清晨
const ROLE_FIDS = {
  wolf: GBASE + '/wolf_r3_wolf.jpg',
  seer: GBASE + '/wolf_r3_seer.jpg',
  witch: GBASE + '/wolf_r3_witch.jpg',
  villager: GBASE + '/wolf_r3_villager.jpg',
};

const ROLE_NAMES = { wolf: '狼人 🐺', seer: '预言家 🔮', witch: '女巫 🧪', villager: '平民 🧑‍🌾', god: '上帝 👁️' };
const ROLE_TEXT = { wolf: '狼人', seer: '预言家', witch: '女巫', villager: '平民', god: '上帝' };   // 牌面用纯文字

Page({
  data: {
    mode: 'lobby',      // lobby=大厅 | room=已在房间
    showJoin: false, joinInput: '',
    resumeId: '', resumeCode: '',   // 有未退出的房间时，大厅显示回去横幅
    roomId: '', roomCode: '', openid: '',
    // 房间态（来自 watch）
    status: 'waiting', round: 0, players: [],
    isHost: false, myReady: false, readyCount: 0, needReady: 0, canStart: false,
    myOut: false,
    // 我的身份
    role: '', roleName: '', matesText: '', peeking: false,
    // 夜晚态（wolfNightState，按角色裁剪）
    night: null, pickPoison: false,
    // 展示
    announceText: '', actTip: '', myTarget: '',
    reveal: null, winnerText: '',
    god: null,          // 上帝面板(仅房主):全员身份+夜晚进度
    killCountdown: 0, myTargetNick: '',   // 双狼定刀倒计时 / 我选的目标昵称
    seerLog: [],        // 预言家查验记录(本地持久,天亮后仍可回看)
    dayTally: {}, myDayVote: '', dayVoted: 0,   // 白天投票:得票/我投的/已投人数
    backUrl: '', roleImg: '',   // 牌背 / 我的角色牌面
    bgN: '', bgD: '',           // 昼夜森林底图(随局势交叉淡入)
    starting: false,
  },

  watcher: null,

  async onLoad(query) {
    this._resolveImgs();
    try { this.setData({ openid: await app.ensureLogin() }); } catch (e) {}
    if (query && query.joinCode) return this._join(query.joinCode);
    // 已在某个房间（没点退出）→ 直接回房间（想换房要先退出）
    const s = app.getWolfSession();
    if (s && s.roomId) return this._enterRoom(s.roomId, s.roomCode);
  },

  resumeRoom() { if (this.data.resumeId) this._enterRoom(this.data.resumeId, this.data.resumeCode); },

  onShow() {
    if (this.data.mode === 'room' && this.data.roomId) {
      this._refresh();
      this._startWatch();
    }
  },
  onHide() { this._closeWatch(); this._clearWolfTimer(); },
  onUnload() { this._closeWatch(); },

  // ── 大厅 ──
  // 牌面素材：本地缓存优先
  _resolveImgs() {
    IMGCACHE.resolve([BACK_FID, BGN_FID, BGD_FID], (m) => {
      const d = {};
      if (m[BACK_FID] && m[BACK_FID] !== this.data.backUrl) d.backUrl = m[BACK_FID];
      if (m[BGN_FID] && m[BGN_FID] !== this.data.bgN) d.bgN = m[BGN_FID];
      if (m[BGD_FID] && m[BGD_FID] !== this.data.bgD) d.bgD = m[BGD_FID];
      if (Object.keys(d).length) this.setData(d);
    });
  },
  _resolveRoleImg(role) {
    const fid = ROLE_FIDS[role];
    if (!fid) return this.setData({ roleImg: '' });
    IMGCACHE.resolve([fid], (m) => { if (m[fid]) this.setData({ roleImg: m[fid] }); });
  },


  // 不再弹框要名字：有昵称直接用；没有就发个代号并记住（资料页随时可改）
  _getNick() {
    let nick = wx.getStorageSync('nick');
    if (!nick) {
      nick = '玩家' + Math.floor(10 + Math.random() * 90);
      wx.setStorageSync('nick', nick);
    }
    return Promise.resolve(nick);
  },

  async createRoom() {
    if (app.blockIfInRoom()) return;
    const nick = await this._getNick();
    let res;
    try {
      res = await app.runOnce('wolfCreate', () => app.callGame({
        action: 'create', gameType: 'wolf',
        nick, avatar: wx.getStorageSync('avatar') || '',
      }), '创建中');
    } catch (e) { return wx.showToast({ title: '网络异常，请重试', icon: 'none' }); }
    const r = res && res.result;
    if (!r || !r.ok) return wx.showToast({ title: (r && r.msg) || '创建失败', icon: 'none' });
    this._enterRoom(r.roomId, r.roomCode);
  },

  showJoinModal() { this.setData({ showJoin: true, joinInput: '' }); },
  hideJoinModal() { this.setData({ showJoin: false }); },
  onJoinInput(e) {
    const v = e.detail.value.replace(/\D/g, '').slice(0, 4);
    this.setData({ joinInput: v });
    if (v.length === 4) {
      this.setData({ showJoin: false });
      this._join(v);
    }
  },

  async _join(code) {
    if (app.blockIfInRoom()) return;
    const nick = await this._getNick();
    let res;
    try {
      res = await app.runOnce('wolfJoin', () => app.callGame({
        action: 'join', roomCode: String(code),
        nick, avatar: wx.getStorageSync('avatar') || '',
      }), '进入中');
    } catch (e) { return wx.showToast({ title: '网络异常，请重试', icon: 'none' }); }
    const r = res && res.result;
    if (!r || !r.ok) return wx.showToast({ title: (r && r.msg) || '加入失败', icon: 'none' });
    if (r.gameType !== 'wolf') return wx.showToast({ title: '这不是狼人杀房间，请从对应游戏页进入', icon: 'none' });
    this._enterRoom(r.roomId, r.roomCode);
  },

  // ── 房间 ──
  _enterRoom(roomId, roomCode) {
    app.saveWolfSession({ roomId, roomCode });
    app.globalData.roomAutoResumed = true;   // 已在房间里，后退回大厅不要再弹回来
    this._nightVer = -1;
    this.setData({ mode: 'room', roomId, roomCode, role: '', roleName: '', matesText: '', night: null, reveal: null });
    this._refresh();
    this._startWatch();
  },

  async _refresh() {
    const db = wx.cloud.database();
    try {
      const res = await db.collection('rooms').where({ _id: this.data.roomId }).get();
      this._render(res.data[0] || null);
    } catch (e) {}
  },

  _startWatch() {
    if (this.watcher) return;
    const db = wx.cloud.database();
    this.watcher = db.collection('rooms').doc(this.data.roomId).watch({
      onChange: (snap) => this._render(snap.docs && snap.docs[0]),
      onError: () => {
        this._closeWatch();
        this._refresh();
        setTimeout(() => {
          if (this.data.mode === 'room' && this.data.roomId && !this.watcher) this._startWatch();
        }, 2000);
      },
    });
  },
  _closeWatch() {
    if (this.watcher) {
      try { this.watcher.close(); } catch (e) {}
      this.watcher = null;
    }
  },

  _backToLobby(toast) {
    app.clearWolfSession();
    this._closeWatch();
    this.setData({ mode: 'lobby', roomId: '', role: '', roleName: '', matesText: '', night: null, reveal: null, peeking: false, pickPoison: false });
    if (toast) wx.showToast({ title: toast, icon: 'none' });
  },

  _render(room) {
    if (!room) return this._backToLobby('房间已解散');
    const me = (room.players || []).find((p) => p.openid === this.data.openid);
    if (this.data.openid && !me) return this._backToLobby('你不在这个房间里');
    const others = (room.players || []).filter((p) => p.openid !== room.hostOpenid);
    const readyCount = others.filter((p) => p.ready).length;
    const players = (room.players || []).map((p) => ({ ...p, isHost: p.openid === room.hostOpenid }));
    const a = room.announce;
    let announceText = '';
    if (a && a.type === 'dawn') {
      announceText = '☀️ 天亮请睁眼——' + (a.peace ? '昨夜是平安夜，无人倒牌' : `昨夜倒牌的是 ${(a.deaths || []).join('、')}`);
    } else if (a && a.type === 'out') {
      announceText = `🪦 ${a.nick} 被放逐出村，TA 是「${a.roleName}」`;
    }
    const rv = room.reveal || null;
    const dayVotes = room.dayVotes || {};
    const dayTally = {};
    Object.values(dayVotes).forEach((tid) => { if (tid) dayTally[tid] = (dayTally[tid] || 0) + 1; });
    this.setData({
      dayTally,
      myDayVote: dayVotes[this.data.openid] || '',
      dayVoted: Object.keys(dayVotes).length,
      status: room.status || 'waiting',
      round: room.round || 0,
      players,
      emptySlots: Array.from({ length: Math.max(0, 6 - others.length) }, (v, i) => i),
      isHost: room.hostOpenid === this.data.openid,
      myReady: !!(me && me.ready),
      myOut: !!(me && me.out),
      readyCount,
      needReady: others.length,
      canStart: others.length >= 6 && readyCount === others.length,   // 上帝不算人数
      announceText,
      reveal: rv,
      winnerText: rv ? (rv.winner === 'wolf' ? '狼人阵营获胜 🐺' : rv.winner === 'good' ? '好人阵营获胜 🎉' : '本局提前结束，身份公开') : '',
    });
    // 回到等待（再来一局）：清掉上一局身份
    if (room.status === 'waiting' && this.data.role) {
      this.setData({ role: '', roleName: '', matesText: '', night: null, reveal: null, peeking: false, pickPoison: false, god: null, seerLog: [] });
      this._godKey = '';
    }
    // 游戏中还没拿到身份 → 拉一次
    if (room.status !== 'waiting' && room.status !== 'finished' && !this.data.role) this._fetchRole();
    // 夜晚数据有更新（nightVer 变化）→ 重新拉角色视角
    const nv = room.nightVer || 0;
    if (room.status === 'night') {
      if (nv !== this._nightVer) { this._nightVer = nv; this._fetchNight(); }
    } else {
      this._nightVer = nv;
      if (this.data.night) this.setData({ night: null, pickPoison: false });
      this._clearWolfTimer();
    }
    // 上帝面板：开局后随状态/夜晚版本刷新
    if (room.hostOpenid === this.data.openid && room.status !== 'waiting') {
      const gk = room.status + ':' + nv;
      if (gk !== this._godKey) { this._godKey = gk; this._fetchGod(); }
    }
    this._deriveTips();
  },

  async _fetchGod() {
    if (this._fetchingGod) return;
    this._fetchingGod = true;
    try {
      const res = await app.callGame({ action: 'wolfGod', roomId: this.data.roomId });
      const r = res && res.result;
      if (r && r.ok) this.setData({ god: r });
    } catch (e) {}
    this._fetchingGod = false;
    this._deriveTips();
  },

  // 顶部操作提示 + 我已选目标的高亮
  _deriveTips() {
    const { status, role, night, isHost, myOut, pickPoison } = this.data;
    let actTip = '';
    if (status === 'night' && !myOut && night) {
      if (pickPoison) actTip = '☠️ 女巫请睁眼——点头像选择下毒目标';
      else if (role === 'wolf' && !night.done) actTip = '🐺 狼人请睁眼——点头像选择今晚的目标（共同决定）';
      else if (role === 'seer' && !night.done) actTip = '🔮 预言家请睁眼——点头像查验一名玩家';
    } else if (status === 'night' && isHost) {
      const g = this.data.god;
      actTip = g && g.night
        ? `🌙 狼人${g.night.wolfDone ? '✓' : '…'} 预言家${g.night.seerDone ? '✓' : '…'} 女巫${g.night.witchDone ? '✓' : '…'}（都行动后点「宣布天亮」）`
        : '🌙 天黑请闭眼，等待各角色行动…';
    } else if (status === 'day' && isHost) {
      actTip = '🗳 大家投票中（' + (this.data.dayVoted || 0) + ' 人已投）· 讨论完点「宣布天黑」统计';
    }
    let myVote = (role === 'wolf' && night && night.myVote) || '';
    // 乐观选中锁：服务端数据还没追上"我刚选的目标"之前,不回退成旧值(消除闪回)
    if (this._pendingTarget) {
      if (myVote === this._pendingTarget) this._pendingTarget = null;   // 已确认
      else myVote = this._pendingTarget;                                 // 未确认,保持新目标
    }
    const mp = (this.data.players || []).find((p) => p.openid === myVote);
    this.setData({ actTip, myTarget: myVote, myTargetNick: mp ? mp.nick : '' });
  },

  async _fetchRole() {
    if (this._fetchingRole) return;
    this._fetchingRole = true;
    try {
      const res = await app.callGame({ action: 'wolfRole', roomId: this.data.roomId });
      const r = res && res.result;
      if (r && r.ok) {
        this.setData({ role: r.role, roleName: ROLE_NAMES[r.role] || r.role, roleText: ROLE_TEXT[r.role] || r.role, matesText: (r.mates || []).join('、') });
        this._resolveRoleImg(r.role);
      }
    } catch (e) {}
    this._fetchingRole = false;
    this._deriveTips();
  },

  async _fetchNight() {
    if (this._fetchingNight) return;
    this._fetchingNight = true;
    try {
      const res = await app.callGame({ action: 'wolfNightState', roomId: this.data.roomId });
      const r = res && res.result;
      if (r && r.ok && r.phase === 'night') {
        const d = { night: r };
        if (r.history && r.history.length >= (this.data.seerLog || []).length) d.seerLog = r.history;
        this.setData(d);
      }
    } catch (e) {}
    this._fetchingNight = false;
    this._deriveTips();
    this._maybeWolfTimer();
  },

  // 狼人选/改目标（可反复改）：点击立即本地高亮,请求后台跑
  async _wolfPick(target) {
    const prev = this.data.myTarget;
    const mp = (this.data.players || []).find((p) => p.openid === target);
    this._pendingTarget = target;   // 锁定,数据追上前不被旧推送覆盖
    this.setData({ myTarget: target, myTargetNick: mp ? mp.nick : '' });   // 乐观更新,秒亮
    this._clearWolfTimer();   // 改了目标先停倒计时,待服务端确认后按 voteSig 重启
    try {
      const res = await app.callGame({ action: 'wolfNightAct', roomId: this.data.roomId, act: 'kill', target });
      const r = res && res.result;
      if (r && !r.ok) {
        this._pendingTarget = null;
        this.setData({ myTarget: prev });   // 失败回滚
        return wx.showToast({ title: r.msg || '操作失败', icon: 'none' });
      }
      this._fetchNight();
    } catch (e) {
      this._pendingTarget = null;
      this.setData({ myTarget: prev });
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    }
  },

  // 单狼点确认 / 双狼倒计时到点：定刀
  // 上帝一键复制主持词发到群里（按当前昼夜生成）
  copyHostScript() {
    const round = this.data.round || 1;
    let text;
    if (this.data.status === 'night') {
      text = `【第 ${round} 夜 · 天黑请闭眼】\n请对应角色打开小程序悄悄行动：\n🐺 狼人——一起选定今晚要刀的人\n🔮 预言家——查验一名玩家的身份\n🧪 女巫——决定是否用解药 / 毒药\n（其余村民请闭眼等待，行动完我会宣布天亮）`;
    } else {
      const dawn = (this.data.announceText || '').replace(/^☀️\s*/, '');
      text = `【第 ${round} 天 · 天亮请睁眼】\n${dawn || '昨夜平安，无人倒牌'}\n\n现在大家自由发言、轮流陈述，说说昨晚的判断和怀疑。\n讨论结束后开始投票：把你要放逐的人报给我，我来统计。`;
    }
    wx.setClipboardData({
      data: text,
      success: () => wx.showToast({ title: '已复制，去群里粘贴', icon: 'none' }),
    });
  },

  confirmKill() { this._killConfirm(); },

  // 白天玩家投票放逐（点头像,可改票,乐观高亮）
  async _dayVote(target, nick) {
    const prev = this.data.myDayVote;
    this.setData({ myDayVote: target });
    try {
      const res = await app.callGame({ action: 'wolfVote', roomId: this.data.roomId, target });
      const r = res && res.result;
      if (r && !r.ok) { this.setData({ myDayVote: prev }); return wx.showToast({ title: r.msg || '投票失败', icon: 'none' }); }
      this._refresh();
    } catch (e) { this.setData({ myDayVote: prev }); wx.showToast({ title: '网络异常，请重试', icon: 'none' }); }
  },

  // 上帝：宣布天亮（结算夜晚）
  wolfDawn() {
    this._confirmAct('宣布天亮？未行动的角色视为放弃，结算昨夜死讯。', 'wolfForce', {}, '结算中');
  },
  // 上帝：宣布天黑（按白天票数放逐最高票）
  wolfDusk() {
    this._confirmAct('宣布天黑？按当前投票放逐得票最高的玩家。', 'wolfDusk', {}, '结算中');
  },
  async _killConfirm() {
    try {
      await app.callGame({ action: 'wolfNightAct', roomId: this.data.roomId, act: 'killConfirm' });
      this._refresh();
      this._fetchNight();
    } catch (e) {}
  },

  // 双狼都选定 → 5 秒倒计时,期间改选(voteSig 变化)则重置;到点自动定刀
  _maybeWolfTimer() {
    const n = this.data.night;
    if (this.data.role !== 'wolf' || !n || n.done || (n.wolfCount || 1) <= 1 || !n.allVoted) {
      return this._clearWolfTimer();
    }
    if (n.voteSig !== this._wolfSig || !this._wolfTimer) {
      this._wolfSig = n.voteSig;
      this._startWolfTimer();
    }
  },
  _startWolfTimer() {
    this._clearWolfTimer();
    let left = 5;
    this.setData({ killCountdown: left });
    this._wolfTimer = setInterval(() => {
      left -= 1;
      if (left <= 0) {
        this._clearWolfTimer();
        this._killConfirm();
      } else {
        this.setData({ killCountdown: left });
      }
    }, 1000);
  },
  _clearWolfTimer() {
    if (this._wolfTimer) { clearInterval(this._wolfTimer); this._wolfTimer = null; }
    this._wolfSig = '';
    if (this.data.killCountdown) this.setData({ killCountdown: 0 });
  },

  // ── 等待阶段 ──
  async toggleReady() {
    try {
      const res = await app.runOnce('wolfReady', () => app.callGame({ action: 'ready', roomId: this.data.roomId }), '');
      const r = res && res.result;
      if (r && !r.ok) return wx.showToast({ title: r.msg || '操作失败', icon: 'none' });
      this._refresh();
    } catch (e) { wx.showToast({ title: '网络异常，请重试', icon: 'none' }); }
  },

  async startGame() {
    if (!this.data.canStart) {
      if (this.data.players.length < 6) return wx.showToast({ title: '至少 6 人才能开始', icon: 'none' });
      return wx.showToast({ title: '等所有玩家点准备', icon: 'none' });
    }
    this.setData({ starting: true });
    let res;
    try {
      res = await app.runOnce('wolfStart', () => app.callGame({ action: 'start', roomId: this.data.roomId }), '发身份中');
    } catch (e) {
      this.setData({ starting: false });
      return wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    }
    this.setData({ starting: false });
    const r = res && res.result;
    if (r && !r.ok) wx.showToast({ title: r.msg || '开始失败', icon: 'none' });
  },

  // ── 身份卡：点击翻转/盖回 ──
  async toggleCard() {
    if (this.data.peeking) return this.setData({ peeking: false });
    if (this.data.role) return this.setData({ peeking: true });
    await this._fetchRole();
    if (this.data.role) this.setData({ peeking: true });
    else wx.showToast({ title: '身份获取失败，再试一次', icon: 'none' });
  },

  // ── 点头像：按当前阶段/角色分发 ──
  onPlayerTap(e) {
    const d = e.currentTarget.dataset;
    const { status, role, night, isHost, myOut, pickPoison, openid } = this.data;
    if (status === 'day') {
      if (d.out) return wx.showToast({ title: 'TA 已出局', icon: 'none' });
      if (isHost) {   // 上帝:平票时手动指定出局(备用)
        return this._confirmAct(`直接让「${d.nick}」出局？（一般用「宣布天黑」按票统计）`, 'wolfDayOut', { target: d.openid }, '执行中');
      }
      if (myOut) return wx.showToast({ title: '你已出局，不能投票', icon: 'none' });
      return this._dayVote(d.openid, d.nick);   // 玩家:投票(可改)
    }
    if (status !== 'night' || myOut || !night) return;
    if (d.out) return wx.showToast({ title: 'TA 已出局', icon: 'none' });
    if (pickPoison) {
      if (d.openid === openid) return wx.showToast({ title: '不能毒自己', icon: 'none' });
      return this._confirmAct(`对「${d.nick}」使用毒药？`, 'wolfNightAct', { act: 'poison', target: d.openid }, '行动中',
        () => this.setData({ pickPoison: false }));
    }
    if (role === 'wolf' && !night.done) {
      if (d.openid === openid) return wx.showToast({ title: '不能刀自己', icon: 'none' });
      return this._wolfPick(d.openid);   // 只提交选择,单狼再点确认/双狼倒计时定刀
    }
    if (role === 'seer' && !night.done) {
      if (d.openid === openid) return wx.showToast({ title: '不用查自己', icon: 'none' });
      return this._seerCheck(d);
    }
  },

  async _confirmAct(content, action, extra, loading, after) {
    const ok = await new Promise((res) => {
      wx.showModal({ title: '确认', content, success: (r) => res(r.confirm) });
    });
    if (!ok) return;
    try {
      const res = await app.runOnce('wolfAct', () => app.callGame({ action, roomId: this.data.roomId, ...extra }), loading || '');
      const r = res && res.result;
      if (r && !r.ok) return wx.showToast({ title: r.msg || '操作失败', icon: 'none' });
      if (after) after();
      this._refresh();
      if (this.data.status === 'night') this._fetchNight();
    } catch (e) { wx.showToast({ title: '网络异常，请重试', icon: 'none' }); }
  },

  async _seerCheck(d) {
    const ok = await new Promise((res) => {
      wx.showModal({ title: '查验', content: `查验「${d.nick}」的身份？`, success: (r) => res(r.confirm) });
    });
    if (!ok) return;
    try {
      const res = await app.runOnce('wolfAct', () => app.callGame({
        action: 'wolfNightAct', roomId: this.data.roomId, act: 'check', target: d.openid,
      }), '查验中');
      const r = res && res.result;
      if (!r || !r.ok) return wx.showToast({ title: (r && r.msg) || '查验失败', icon: 'none' });
      const log = (this.data.seerLog || []).slice();
      if (!log.some((x) => x.round === this.data.round && x.nick === d.nick)) {
        log.push({ round: this.data.round, nick: d.nick, isWolf: r.isWolf });
        this.setData({ seerLog: log });
      }
      wx.showModal({ title: '查验结果', content: `${d.nick} 是${r.isWolf ? '狼人 🐺' : '好人 🙂'}`, showCancel: false });
      this._refresh();
      this._fetchNight();
    } catch (e) { wx.showToast({ title: '网络异常，请重试', icon: 'none' }); }
  },

  // ── 女巫按钮 ──
  witchSave() {
    const n = this.data.night;
    if (!n || !n.canSave) return;
    this._confirmAct(`用解药救「${n.killNick}」？（解药只有一瓶）`, 'wolfNightAct', { act: 'save' }, '行动中');
  },
  witchPoisonToggle() {
    this.setData({ pickPoison: !this.data.pickPoison });
    this._deriveTips();
  },
  witchSkip() {
    this.setData({ pickPoison: false });
    this._confirmAct('今晚不用药，直接睡觉？', 'wolfNightAct', { act: 'skip' }, '');
  },

  // ── 房主控制 ──
  revealAll() {
    this._confirmAct('公开所有人的身份并结束本局？', 'wolfReveal', {}, '揭晓中');
  },

  async playAgain() {
    try {
      const res = await app.runOnce('wolfReset', () => app.callGame({ action: 'reset', roomId: this.data.roomId }), '重开中');
      const r = res && res.result;
      if (r && !r.ok) wx.showToast({ title: r.msg || '重开失败', icon: 'none' });
    } catch (e) { wx.showToast({ title: '网络异常，请重试', icon: 'none' }); }
  },

  async leaveRoom() {
    const isHost = this.data.isHost;
    const ok = await new Promise((res) => {
      wx.showModal({
        title: isHost ? '解散房间' : '退出房间',
        content: isHost ? '你是房主，退出将解散房间，确定吗？' : '游戏中退出会解散本局，确定退出吗？',
        success: (r) => res(r.confirm),
      });
    });
    if (!ok) return;
    this._closeWatch();
    app.clearWolfSession();
    const action = isHost ? 'dissolve' : 'leave';
    await app.callGame({ action, roomId: this.data.roomId }).catch(() => {});
    this.setData({ mode: 'lobby', roomId: '', role: '', roleName: '', matesText: '', night: null, reveal: null, peeking: false, pickPoison: false });
  },

  copyCode() {
    wx.setClipboardData({ data: this.data.roomCode, success: () => wx.showToast({ title: '房间号已复制' }) });
  },

  onShareAppMessage() {
    if (this.data.mode === 'room' && this.data.roomCode) {
      return {
        title: `狼人杀 🐺 房间 ${this.data.roomCode}，点我直接进房`,
        path: `/pages/wolf/wolf?joinCode=${this.data.roomCode}`,
      };
    }
    return { title: '狼人杀 🐺 拉群开一局，无上帝自动主持', path: '/pages/wolf/wolf' };
  },
});
