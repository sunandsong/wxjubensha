// 谁是卧底 · 房间模式：创建/加入 → 全员准备 → 云端发词（房主也参与）→ 群里描述+口头投票 → 揭晓
const app = getApp();

Page({
  data: {
    mode: 'lobby',      // lobby=大厅 | room=已在房间
    spyCountSel: 1,     // 建房选项：卧底人数
    showJoin: false,    // 加入弹框
    joinInput: '',
    lastSession: null,  // 上次未退出的房间 {roomId, roomCode}，大厅顶部提示可回去
    // 房间态（来自 watch）
    roomId: '', roomCode: '', openid: '',
    status: 'waiting', players: [], round: 0,
    isHost: false, myReady: false, readyCount: 0, needReady: 0, canStart: false,
    reveal: null,       // finished 后云端公布 {civilWord, spyWord, spies}
    spyNicks: '',       // 卧底昵称串
    iAmSpy: false,
    // 我的词
    word: '', peeking: false,
    starting: false,
  },

  watcher: null,

  async onLoad(query) {
    try { this.setData({ openid: await app.ensureLogin() }); } catch (e) {}
    // 分享链接直接进房
    if (query && query.joinCode) return this._join(query.joinCode);
    // 有上次未退出的卧底局：不自动进房，在大厅顶部提示可回去
    const s = wx.getStorageSync('spySession');
    if (s && s.roomId) this.setData({ lastSession: s });
  },

  onShow() {
    if (this.data.mode === 'room' && this.data.roomId) this._startWatch();
  },
  onHide() { this._closeWatch(); },
  onUnload() { this._closeWatch(); },

  // ── 大厅 ──
  pickSpyCount(e) { this.setData({ spyCountSel: Number(e.currentTarget.dataset.n) }); },

  resumeRoom() {
    const s = this.data.lastSession;
    if (!s) return;
    this.setData({ lastSession: null });
    this._enterRoom(s.roomId, s.roomCode);
  },
  dismissResume() {
    wx.removeStorageSync('spySession');
    this.setData({ lastSession: null });
  },

  // 昵称：优先用资料页存的，没有就弹框补一个
  _getNick() {
    const nick = wx.getStorageSync('nick');
    if (nick) return Promise.resolve(nick);
    return new Promise((resolve) => {
      wx.showModal({
        title: '起个名字',
        placeholderText: '群友们怎么称呼你？',
        editable: true,
        success: (r) => {
          const v = (r.confirm && r.content || '').trim();
          if (v) wx.setStorageSync('nick', v);
          resolve(v || '玩家');
        },
        fail: () => resolve('玩家'),
      });
    });
  },

  async createRoom() {
    const nick = await this._getNick();
    let res;
    try {
      res = await app.runOnce('spyCreate', () => app.callGame({
        action: 'create', gameType: 'spy', spyCount: this.data.spyCountSel,
        nick, avatar: wx.getStorageSync('avatar') || '',
      }), '创建中');
    } catch (e) { return wx.showToast({ title: '网络异常，请重试', icon: 'none' }); }
    const r = res && res.result;
    if (!r || !r.ok) return wx.showToast({ title: (r && r.msg) || '创建失败', icon: 'none' });
    this._enterRoom(r.roomId, r.roomCode);
  },

  showJoinModal() { this.setData({ showJoin: true, joinInput: '' }); },
  hideJoinModal() { this.setData({ showJoin: false }); },
  onJoinInput(e) { this.setData({ joinInput: e.detail.value.replace(/\D/g, '').slice(0, 4) }); },
  joinConfirm() {
    if (this.data.joinInput.length !== 4) return wx.showToast({ title: '输入 4 位房间号', icon: 'none' });
    this.setData({ showJoin: false });
    this._join(this.data.joinInput);
  },

  async _join(code) {
    const nick = await this._getNick();
    let res;
    try {
      res = await app.runOnce('spyJoin', () => app.callGame({
        action: 'join', roomCode: String(code),
        nick, avatar: wx.getStorageSync('avatar') || '',
      }), '进入中');
    } catch (e) { return wx.showToast({ title: '网络异常，请重试', icon: 'none' }); }
    const r = res && res.result;
    if (!r || !r.ok) return wx.showToast({ title: (r && r.msg) || '加入失败', icon: 'none' });
    if (r.gameType && r.gameType !== 'spy') return wx.showToast({ title: '这是剧本杀房间，请从剧本页进入', icon: 'none' });
    this._enterRoom(r.roomId, r.roomCode);
  },

  // ── 房间 ──
  _enterRoom(roomId, roomCode) {
    wx.setStorageSync('spySession', { roomId, roomCode });
    this.setData({ mode: 'room', roomId, roomCode, word: '', lastSession: null });
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
      onError: () => {},
    });
  },
  _closeWatch() {
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
  },

  _render(room) {
    if (!room) {
      // 房间没了：回大厅
      wx.removeStorageSync('spySession');
      this._closeWatch();
      this.setData({ mode: 'lobby', roomId: '', word: '', reveal: null });
      wx.showToast({ title: '房间已解散', icon: 'none' });
      return;
    }
    const me = (room.players || []).find((p) => p.openid === this.data.openid);
    const others = (room.players || []).filter((p) => p.openid !== room.hostOpenid);
    const readyCount = others.filter((p) => p.ready).length;
    const players = (room.players || []).map((p) => ({
      ...p,
      isHost: p.openid === room.hostOpenid,
      isSpy: !!(room.reveal && room.reveal.spies && room.reveal.spies.includes(p.openid)),
    }));
    const spyNicks = room.reveal
      ? players.filter((p) => p.isSpy).map((p) => p.nick).join('、')
      : '';
    this.setData({
      status: room.status || 'waiting',
      players,
      round: room.round || 0,
      isHost: room.hostOpenid === this.data.openid,
      myReady: !!(me && me.ready),
      readyCount,
      needReady: others.length,
      canStart: (room.players || []).length >= 4 && readyCount === others.length,
      reveal: room.reveal || null,
      spyNicks,
      iAmSpy: !!(room.reveal && room.reveal.spies && room.reveal.spies.includes(this.data.openid)),
    });
    // 游戏中且还没拿到词 → 拉自己的词
    if (room.status === 'playing' && !this.data.word) this._fetchWord();
  },

  async _fetchWord() {
    if (this._fetchingWord) return;
    this._fetchingWord = true;
    try {
      const res = await app.callGame({ action: 'myWord', roomId: this.data.roomId });
      const r = res && res.result;
      if (r && r.ok) this.setData({ word: r.word });
    } catch (e) {}
    this._fetchingWord = false;
  },

  async toggleReady() {
    try {
      await app.runOnce('spyReady', () => app.callGame({ action: 'ready', roomId: this.data.roomId }), '');
    } catch (e) { wx.showToast({ title: '网络异常，请重试', icon: 'none' }); }
  },

  async startGame() {
    if (!this.data.canStart) {
      if (this.data.players.length < 4) return wx.showToast({ title: '至少 4 人才能开始', icon: 'none' });
      return wx.showToast({ title: '等所有玩家点准备', icon: 'none' });
    }
    this.setData({ starting: true });
    let res;
    try {
      res = await app.runOnce('spyStart', () => app.callGame({ action: 'start', roomId: this.data.roomId }), '发词中');
    } catch (e) {
      this.setData({ starting: false });
      return wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    }
    this.setData({ starting: false });
    const r = res && res.result;
    if (r && !r.ok) wx.showToast({ title: r.msg || '开始失败', icon: 'none' });
  },

  // 长按看词，松手盖回
  peekOn() { if (this.data.word) this.setData({ peeking: true }); },
  peekOff() { if (this.data.peeking) this.setData({ peeking: false }); },

  async revealAll() {
    const ok = await new Promise((res) => {
      wx.showModal({ title: '揭晓', content: '公布词语和卧底身份，结束本局？', confirmText: '揭晓', success: (r) => res(r.confirm) });
    });
    if (!ok) return;
    try {
      const res = await app.runOnce('spyRevealAct', () => app.callGame({ action: 'spyReveal', roomId: this.data.roomId }), '揭晓中');
      const r = res && res.result;
      if (r && !r.ok) wx.showToast({ title: r.msg || '揭晓失败', icon: 'none' });
    } catch (e) { wx.showToast({ title: '网络异常，请重试', icon: 'none' }); }
  },

  async playAgain() {
    try {
      const res = await app.runOnce('spyReset', () => app.callGame({ action: 'reset', roomId: this.data.roomId }), '重开中');
      const r = res && res.result;
      if (r && r.ok) this.setData({ word: '', peeking: false });
      else if (r) wx.showToast({ title: r.msg || '重开失败', icon: 'none' });
    } catch (e) { wx.showToast({ title: '网络异常，请重试', icon: 'none' }); }
  },

  async leaveRoom() {
    const isHost = this.data.isHost;
    const ok = await new Promise((res) => {
      wx.showModal({
        title: isHost ? '解散房间' : '退出房间',
        content: isHost ? '你是房主，退出将解散房间，确定吗？' : '确定退出当前房间吗？',
        success: (r) => res(r.confirm),
      });
    });
    if (!ok) return;
    this._closeWatch();
    wx.removeStorageSync('spySession');
    const action = isHost ? 'dissolve' : 'leave';
    await app.callGame({ action, roomId: this.data.roomId }).catch(() => {});
    this.setData({ mode: 'lobby', roomId: '', word: '', reveal: null });
  },

  copyCode() {
    wx.setClipboardData({ data: this.data.roomCode, success: () => wx.showToast({ title: '房间号已复制' }) });
  },

  onShareAppMessage() {
    if (this.data.mode === 'room' && this.data.roomCode) {
      return {
        title: `谁是卧底 🎩 房间 ${this.data.roomCode}，点我直接进房`,
        path: `/pages/spy/spy?joinCode=${this.data.roomCode}`,
      };
    }
    return { title: '谁是卧底 🎩 拉群开一局', path: '/pages/spy/spy' };
  },
});
