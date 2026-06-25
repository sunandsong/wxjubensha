const app = getApp();
const db = wx.cloud.database();
const SCRIPTS = require('../../utils/scripts.js');

Page({
  data: {
    roomId: '',
    roomCode: '',
    openid: '',
    players: [],
    realCount: 0,
    isHost: false,
    canStart: false,
    starting: false,
    scriptTitle: '',
    scriptSub: '',
  },

  watcher: null,

  onLoad(query) {
    this.setData({ roomId: query.roomId, roomCode: query.roomCode });
    // 记住当前对局，切屏/重启后可在首页续上
    app.saveSession({ roomId: query.roomId, roomCode: query.roomCode });
  },

  // 每次回到前台都确保身份就绪并重连监听（切屏后 watch 会断开）
  async onShow() {
    this.setData({ testTag: app.getTestUid() ? wx.getStorageSync('nick') : '' });
    try {
      this.setData({ openid: await app.ensureLogin() });
    } catch (e) {}
    // 每次进入都重新请求最新数据（不依赖缓存），带 Loading
    wx.showLoading({ title: '加载中', mask: true });
    try {
      const room = await db.collection('rooms').doc(this.data.roomId).get().then((r) => r.data);
      if (room) this.renderRoom(room);
    } catch (e) {
      wx.showToast({ title: '加载失败，请重试', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
    this.startWatch();
  },

  gotoTest() { this.closeWatch(); wx.reLaunch({ url: '/pages/test/test' }); },

  onHide() { this.closeWatch(); },

  renderRoom(room) {
    if (!room) {
      app.clearSession();
      this.closeWatch();
      wx.showModal({ title: '提示', content: '房间已解散', showCancel: false, success: () => wx.reLaunch({ url: '/pages/index/index' }) });
      return;
    }
    const raw = room.players || [];
    const script = SCRIPTS.byId(room.scriptId);
    // 标注主持人（房主），统计真实玩家数（房主不参与）
    const players = raw.map((p) => ({ ...p, isModerator: p.openid === room.hostOpenid }));
    const realCount = raw.filter((p) => p.openid !== room.hostOpenid).length;
    this.setData({
      players,
      realCount,
      isHost: room.hostOpenid === this.data.openid,
      canStart: realCount >= 1,
      scriptTitle: script.title,
      scriptSub: script.subtitle,
    });
    // 游戏已开始 → 进入游戏页
    if (room.status && room.status !== 'waiting') {
      this.closeWatch();
      wx.redirectTo({ url: `/pages/game/game?roomId=${this.data.roomId}&roomCode=${this.data.roomCode}` });
    }
  },

  startWatch() {
    if (this.watcher) return;
    this.watcher = db.collection('rooms').doc(this.data.roomId).watch({
      onChange: (snap) => this.renderRoom(snap.docs && snap.docs[0]),
      onError: (e) => console.error('watch error', e),
    });
  },

  closeWatch() {
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
  },

  async startGame() {
    if (!this.data.canStart) return wx.showToast({ title: '至少需要 1 名玩家（房主不参与）', icon: 'none' });
    this.setData({ starting: true });
    let res;
    try {
      res = await app.runOnce('start', () => app.callGame({ action: 'start', roomId: this.data.roomId }), '开始中');
    } catch (e) {
      this.setData({ starting: false });
      return wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    }
    this.setData({ starting: false });
    if (res && res.result && !res.result.ok) wx.showToast({ title: res.result.msg || '开始失败', icon: 'none' });
  },

  copyCode() {
    wx.setClipboardData({ data: this.data.roomCode, success: () => wx.showToast({ title: '房间号已复制' }) });
  },

  // 主持人结束游戏：解散房间，所有人退出
  async endGame() {
    const ok = await new Promise((res) => {
      wx.showModal({ title: '结束游戏', content: '确定结束本局并解散房间吗？', success: (r) => res(r.confirm) });
    });
    if (!ok) return;
    await app.runOnce('dissolve', async () => {
      this.closeWatch();
      app.clearSession();
      await app.callGame({ action: 'dissolve', roomId: this.data.roomId }).catch(() => {});
      wx.reLaunch({ url: '/pages/index/index' });
    }, '结束中');
  },

  async leaveRoom() {
    await app.runOnce('leave', async () => {
      this.closeWatch();
      app.clearSession();   // 主动离开 → 不再续局
      await app.callGame({ action: 'leave', roomId: this.data.roomId }).catch(() => {});
      wx.reLaunch({ url: '/pages/index/index' });
    }, '退出中');
  },

  onUnload() {
    this.closeWatch();
  },

  onShareAppMessage() {
    return {
      title: `快来玩剧本杀《同学会之夜》，房间号 ${this.data.roomCode}`,
      path: `/pages/index/index`,
    };
  },
});
