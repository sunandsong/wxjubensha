// 狼人杀 · 无上帝自动主持：创建/加入 → 全员准备 → 云端发身份入夜 →
// 夜晚各角色在 App 里行动（云端收齐自动天亮）→ 白天回群里讨论、口头投票后房主点人出局 → 循环至分胜负
const app = getApp();

const ROLE_NAMES = { wolf: '狼人 🐺', seer: '预言家 🔮', witch: '女巫 🧪', villager: '平民 🧑‍🌾' };

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
    starting: false,
  },

  watcher: null,

  async onLoad(query) {
    try { this.setData({ openid: await app.ensureLogin() }); } catch (e) {}
    if (query && query.joinCode) return this._join(query.joinCode);
    const s = app.getWolfSession();
    if (s && s.roomId) {
      // 悬浮钮/启动续房（带 resume=1）→ 直达房间；普通进入 → 停在大厅，显示"回去"横幅
      if (query && query.resume) return this._enterRoom(s.roomId, s.roomCode);
      this.setData({ resumeId: s.roomId, resumeCode: s.roomCode });
    }
  },

  resumeRoom() { if (this.data.resumeId) this._enterRoom(this.data.resumeId, this.data.resumeCode); },

  onShow() {
    if (this.data.mode === 'room' && this.data.roomId) {
      this._refresh();
      this._startWatch();
    }
  },
  onHide() { this._closeWatch(); },
  onUnload() { this._closeWatch(); },

  // ── 大厅 ──
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
      announceText = `☀️ 第 ${a.round} 天亮了：` + (a.peace ? '平安夜，无人倒牌' : `昨夜 ${(a.deaths || []).join('、')} 倒牌`);
    } else if (a && a.type === 'out') {
      announceText = `🗳 ${a.nick} 被投票出局，TA 是「${a.roleName}」`;
    }
    const rv = room.reveal || null;
    this.setData({
      status: room.status || 'waiting',
      round: room.round || 0,
      players,
      isHost: room.hostOpenid === this.data.openid,
      myReady: !!(me && me.ready),
      myOut: !!(me && me.out),
      readyCount,
      needReady: others.length,
      canStart: (room.players || []).length >= 6 && readyCount === others.length,
      announceText,
      reveal: rv,
      winnerText: rv ? (rv.winner === 'wolf' ? '狼人阵营获胜 🐺' : rv.winner === 'good' ? '好人阵营获胜 🎉' : '本局提前结束，身份公开') : '',
    });
    // 回到等待（再来一局）：清掉上一局身份
    if (room.status === 'waiting' && this.data.role) {
      this.setData({ role: '', roleName: '', matesText: '', night: null, reveal: null, peeking: false, pickPoison: false });
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
    }
    this._deriveTips();
  },

  // 顶部操作提示 + 我已选目标的高亮
  _deriveTips() {
    const { status, role, night, isHost, myOut, pickPoison } = this.data;
    let actTip = '';
    if (status === 'night' && !myOut && night) {
      if (pickPoison) actTip = '☠️ 点头像选择下毒目标';
      else if (role === 'wolf' && !night.done) actTip = '🔪 点头像选择今晚的目标（狼人共同决定）';
      else if (role === 'seer' && !night.done) actTip = '🔮 点头像查验一名玩家';
    } else if (status === 'day' && isHost) {
      actTip = '🗳 群里口头投票后，点头像让 TA 出局';
    }
    this.setData({ actTip, myTarget: (role === 'wolf' && night && night.myVote) || '' });
  },

  async _fetchRole() {
    if (this._fetchingRole) return;
    this._fetchingRole = true;
    try {
      const res = await app.callGame({ action: 'wolfRole', roomId: this.data.roomId });
      const r = res && res.result;
      if (r && r.ok) {
        this.setData({ role: r.role, roleName: ROLE_NAMES[r.role] || r.role, matesText: (r.mates || []).join('、') });
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
      if (r && r.ok && r.phase === 'night') this.setData({ night: r });
    } catch (e) {}
    this._fetchingNight = false;
    this._deriveTips();
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

  // ── 身份卡：长按看，松手盖回 ──
  async peekOn() {
    if (this.data.role) return this.setData({ peeking: true });
    await this._fetchRole();
    if (this.data.role) this.setData({ peeking: true });
    else wx.showToast({ title: '身份获取失败，再试一次', icon: 'none' });
  },
  peekOff() { if (this.data.peeking) this.setData({ peeking: false }); },

  // ── 点头像：按当前阶段/角色分发 ──
  onPlayerTap(e) {
    const d = e.currentTarget.dataset;
    const { status, role, night, isHost, myOut, pickPoison, openid } = this.data;
    if (status === 'day') {
      if (!isHost) return;
      if (d.out) return wx.showToast({ title: 'TA 已出局', icon: 'none' });
      return this._confirmAct(`让「${d.nick}」出局？（按群里投票结果执行）`, 'wolfDayOut', { target: d.openid }, '执行中');
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
      return this._confirmAct(`今晚刀「${d.nick}」？`, 'wolfNightAct', { act: 'kill', target: d.openid }, '行动中');
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
  forceDawn() {
    this._confirmAct('把还没行动的角色视为无操作，直接天亮？', 'wolfForce', {}, '结算中');
  },
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
