// 谁是卧底 · 房间模式：创建/加入 → 全员准备 → 云端发词（房主也参与）→ 群里描述+口头投票 → 揭晓
const app = getApp();
const IMGCACHE = require('../../utils/imgCache.js');

// 页面素材（云存储 games/）：聚光灯审讯室底图 / 礼帽面具立绘 / 机密卡卡面
const GBASE = 'cloud://cloud1-d6g6wknyy4d198022.636c-cloud1-d6g6wknyy4d198022-1446823337/games';
const BG_FID = GBASE + '/spy_bg.jpg';
const HERO_FID = GBASE + '/spy_hero.png';
const CARD_FID = GBASE + '/spy_card.jpg';

Page({
  data: {
    mode: 'lobby',      // lobby=大厅 | room=已在房间
    spyCountSel: 1,     // 建房选项：卧底人数
    showJoin: false,    // 加入弹框
    resumeId: '', resumeCode: '',   // 有未退出的房间时，大厅显示回去横幅
    joinInput: '',
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
    bgUrl: '', bgOk: false, heroUrl: '', cardUrl: '',   // 云端素材
  },

  watcher: null,

  async onLoad(query) {
    this._resolveImgs();
    try { this.setData({ openid: await app.ensureLogin() }); } catch (e) {}
    // 分享链接直接进房
    if (query && query.joinCode) return this._join(query.joinCode);
    const s = app.getSpySession();
    if (s && s.roomId) {
      // 悬浮钮/启动续房（带 resume=1）→ 直达房间；普通进入 → 停在大厅，显示"回去"横幅
      if (query && query.resume) return this._enterRoom(s.roomId, s.roomCode);
      this.setData({ resumeId: s.roomId, resumeCode: s.roomCode });
    }
  },

  resumeRoom() { if (this.data.resumeId) this._enterRoom(this.data.resumeId, this.data.resumeCode); },

  // 云端素材：本地缓存优先,云图淡入
  _resolveImgs() {
    IMGCACHE.resolve([BG_FID, HERO_FID, CARD_FID], (map) => {
      const d = {};
      if (map[BG_FID] && map[BG_FID] !== this.data.bgUrl) d.bgUrl = map[BG_FID];
      if (map[HERO_FID] && map[HERO_FID] !== this.data.heroUrl) d.heroUrl = map[HERO_FID];
      if (map[CARD_FID] && map[CARD_FID] !== this.data.cardUrl) d.cardUrl = map[CARD_FID];
      if (Object.keys(d).length) this.setData(d);
    });
  },
  onBgLoad() { this.setData({ bgOk: true }); },
  onBgErr() { IMGCACHE.invalidate(BG_FID); this.setData(this.data.bgUrl !== BG_FID ? { bgUrl: BG_FID, bgOk: false } : { bgUrl: '', bgOk: false }); },
  onHeroErr() { IMGCACHE.invalidate(HERO_FID); this.setData({ heroUrl: this.data.heroUrl !== HERO_FID ? HERO_FID : '' }); },
  onCardErr() { IMGCACHE.invalidate(CARD_FID); this.setData({ cardUrl: this.data.cardUrl !== CARD_FID ? CARD_FID : '' }); },


  onShow() {
    if (this.data.mode === 'room' && this.data.roomId) {
      this._refresh();   // 回到前台先手动同步一次，watch 断线期间的变化（如已开局）别漏掉
      this._startWatch();
    }
  },
  onHide() { this._closeWatch(); },
  onUnload() { this._closeWatch(); },

  // ── 大厅 ──
  pickSpyCount(e) { this.setData({ spyCountSel: Number(e.currentTarget.dataset.n) }); },

  // 昵称：优先用资料页存的，没有就弹框补一个
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
  onJoinInput(e) {
    const v = e.detail.value.replace(/\D/g, '').slice(0, 4);
    this.setData({ joinInput: v });
    // 输满 4 位直接进房，不用再点「进入」
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
    app.saveSpySession({ roomId, roomCode });
    app.globalData.roomAutoResumed = true;   // 已在房间里，后退回大厅不要再弹回来
    this.setData({ mode: 'room', roomId, roomCode, word: '' });
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
        // 监听断了：先手动拉一次兜底，稍后重建监听
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

  _render(room) {
    if (!room) {
      // 房间没了：回大厅
      app.clearSpySession();
      this._closeWatch();
      this.setData({ mode: 'lobby', roomId: '', word: '', reveal: null, peeking: false });
      wx.showToast({ title: '房间已解散', icon: 'none' });
      return;
    }
    const me = (room.players || []).find((p) => p.openid === this.data.openid);
    // 我不在玩家列表里 → 这不是我的房间（脏的本地记录）→ 回大厅
    if (this.data.openid && !me) {
      app.clearSpySession();
      this._closeWatch();
      this.setData({ mode: 'lobby', roomId: '', word: '', reveal: null, peeking: false });
      wx.showToast({ title: '你不在这个房间里', icon: 'none' });
      return;
    }
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
      emptySlots: Array.from({ length: Math.max(0, 4 - (room.players || []).length) }, (v, i) => i),
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
    // 回到等待中（再来一局）→ 清掉上一局的词，否则下一局不会去取新词
    if (room.status === 'waiting' && this.data.word) this.setData({ word: '', peeking: false });
    // 游戏中且还没拿到词 → 拉自己的词
    if (room.status === 'playing' && !this.data.word) this._fetchWord();
  },

  async _fetchWord(showErr) {
    if (this._fetchingWord) return '';
    this._fetchingWord = true;
    let word = '';
    try {
      const res = await app.callGame({ action: 'myWord', roomId: this.data.roomId });
      const r = res && res.result;
      if (r && r.ok) word = r.word;
      else if (showErr) wx.showToast({ title: (r && r.msg) || '取词失败，再试一次', icon: 'none' });
    } catch (e) {
      if (showErr) wx.showToast({ title: '网络异常，再长按一次', icon: 'none' });
    }
    this._fetchingWord = false;
    if (word) this.setData({ word });
    return word;
  },

  async toggleReady() {
    try {
      const res = await app.runOnce('spyReady', () => app.callGame({ action: 'ready', roomId: this.data.roomId }), '');
      const r = res && res.result;
      if (r && !r.ok) return wx.showToast({ title: r.msg || '操作失败', icon: 'none' });
      this._refresh();   // 不等 watch 推送，立即拉一次，防监听断线时界面无反应
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

  // 长按看词，松手盖回；本地还没词就现场补取一次（此前取词失败会卡在"长按没反应"）
  async peekOn() {
    if (this.data.word) return this.setData({ peeking: true });
    wx.showLoading({ title: '取词中' });
    const word = await this._fetchWord(true);
    wx.hideLoading();
    if (word) this.setData({ peeking: true });
  },
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
    app.clearSpySession();
    const action = isHost ? 'dissolve' : 'leave';
    await app.callGame({ action, roomId: this.data.roomId }).catch(() => {});
    this.setData({ mode: 'lobby', roomId: '', word: '', reveal: null, peeking: false });
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
