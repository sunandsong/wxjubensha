const app = getApp();
const db = wx.cloud.database();
const SCRIPTS = require('../../utils/scripts.js');

Page({
  data: {
    roomId: '',
    roomCode: '',
    openid: '',
    isHost: false,
    truth: null,
    murdererName: '',
    tally: [],          // [{name, count, isMurderer}]
    accusedName: '',    // 得票最多者
    caught: false,      // 群众是否抓对凶手
    myResult: '',       // 我赢了 / 我输了
  },

  watcher: null,

  onLoad(query) {
    this.setData({ roomId: query.roomId, roomCode: query.roomCode });
    app.saveSession({ roomId: query.roomId, roomCode: query.roomCode });
  },

  // 每次进入都重新请求最新数据（不依赖缓存）
  async onShow() {
    this.setData({ testTag: app.getTestUid() ? wx.getStorageSync('nick') : '' });
    try {
      this.setData({ openid: await app.ensureLogin() });
    } catch (e) {}
    await this.load();
    this.watchReset();
  },
  onHide() { this.closeWatch(); },

  async load() {
    wx.showLoading({ title: '加载中', mask: true });
    let room;
    try {
      room = await db.collection('rooms').doc(this.data.roomId).get().then((r) => r.data);
    } catch (e) {
      wx.hideLoading();
      return wx.showToast({ title: '加载失败，请重试', icon: 'none' });
    }
    wx.hideLoading();
    const SCRIPT = SCRIPTS.byId(room.scriptId);
    const players = room.players || [];
    const votes = room.votes || {};
    const murderer = SCRIPT.truth.murderer;
    const murdererChar = SCRIPT.characters.find((c) => c.id === murderer);

    // 统计每个角色得票，并带上扮演的玩家名字
    const counts = {};
    Object.values(votes).forEach((cid) => { counts[cid] = (counts[cid] || 0) + 1; });
    const tally = SCRIPT.characters
      .map((c) => {
        const owner = players.find((p) => p.charId === c.id);
        return {
          name: c.name, title: c.title,
          playerNick: owner ? owner.nick : '公开嫌疑人',
          count: counts[c.id] || 0, isMurderer: c.id === murderer,
        };
      })
      .sort((a, b) => b.count - a.count);

    const top = tally[0];
    const accused = top && top.count > 0 ? top : null;
    const caught = accused && accused.isMurderer && tally.filter((t) => t.count === top.count).length === 1;

    // 我的胜负
    const me = players.find((p) => p.openid === this.data.openid);
    let myResult = '';
    if (room.hostOpenid === this.data.openid) {
      myResult = caught ? '主持人视角 · 玩家成功揪出真凶' : '主持人视角 · 凶手逃脱了';
    } else if (me && me.charId) {
      const iAmMurderer = me.charId === murderer;
      if (iAmMurderer) myResult = caught ? '你（凶手）被抓住了，平民阵营获胜' : '你（凶手）成功逃脱，凶手获胜！';
      else myResult = caught ? '成功揪出真凶，你所在的平民阵营获胜！' : '凶手逃脱了，平民阵营惜败';
    }

    this.setData({
      isHost: room.hostOpenid === this.data.openid,
      truth: SCRIPT.truth,
      murdererName: murdererChar.name,
      tally,
      accusedName: accused ? accused.name : '无人得票',
      caught,
      myResult,
    });
  },

  watchReset() {
    if (this.watcher) return;
    this.watcher = db.collection('rooms').doc(this.data.roomId).watch({
      onChange: (snap) => {
        const room = snap.docs && snap.docs[0];
        if (room && room.status === 'waiting') {
          this.closeWatch();
          wx.redirectTo({ url: `/pages/room/room?roomId=${this.data.roomId}&roomCode=${this.data.roomCode}` });
        }
      },
      onError: () => {},
    });
  },

  closeWatch() {
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
  },

  async replay() {
    await app.callGame({ action: 'reset', roomId: this.data.roomId });
  },

  backHome() {
    this.closeWatch();
    app.clearSession();   // 回到首页 → 结束续局
    wx.reLaunch({ url: '/pages/index/index' });
  },

  gotoTest() { this.closeWatch(); wx.reLaunch({ url: '/pages/test/test' }); },

  onUnload() { this.closeWatch(); },
});
