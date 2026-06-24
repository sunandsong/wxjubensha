const app = getApp();
const db = wx.cloud.database();
const SCRIPTS = require('../../utils/scripts.js');

Page({
  data: {
    roomId: '',
    roomCode: '',
    openid: '',
    testTag: '',
    status: 'playing',
    actIndex: 0,
    actNum: 1,
    actTotal: 1,
    actTitle: '',
    actNarration: '',
    isLastAct: false,
    isHost: false,
    script: null,
    myChar: null,       // 我的角色对象
    myActStory: '',     // 我这一幕的私密剧情
    roster: [],         // 全部角色公开名册（含是否NPC）
    clues: [],          // 已随幕公开的线索
    myVote: '',
    votedCount: 0,
    totalPlayers: 0,
  },

  watcher: null,

  onLoad(query) {
    this.setData({ roomId: query.roomId, roomCode: query.roomCode });
    app.saveSession({ roomId: query.roomId, roomCode: query.roomCode });
  },

  async onShow() {
    this.setData({ testTag: app.getTestUid() ? wx.getStorageSync('nick') : '' });
    try {
      this.setData({ openid: await app.ensureLogin() });
    } catch (e) {}
    // 每次进入都重新请求最新数据（不依赖缓存），带 Loading
    wx.showLoading({ title: '加载中', mask: true });
    try {
      const room = await db.collection('rooms').doc(this.data.roomId).get().then((r) => r.data);
      if (room) this.render(room);
    } catch (e) {
      wx.showToast({ title: '加载失败，请重试', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
    this.startWatch();
  },

  onHide() { this.closeWatch(); },

  gotoTest() { this.closeWatch(); wx.reLaunch({ url: '/pages/test/test' }); },

  startWatch() {
    if (this.watcher) return;
    this.watcher = db.collection('rooms').doc(this.data.roomId).watch({
      onChange: (snap) => {
        const room = snap.docs && snap.docs[0];
        if (!room) { this.onDissolved(); return; } // 主持人结束了游戏
        this.render(room);
      },
      onError: (e) => console.error(e),
    });
  },

  closeWatch() {
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
  },

  render(room) {
    const SCRIPT = SCRIPTS.byId(room.scriptId);
    const openid = this.data.openid;
    const players = room.players || [];
    const me = players.find((p) => p.openid === openid);
    const myChar = me && me.charId ? SCRIPT.characters.find((c) => c.id === me.charId) : null;

    const acts = SCRIPT.acts || [];
    const actIndex = Math.min(room.actIndex || 0, Math.max(0, acts.length - 1));
    const act = acts[actIndex] || null;
    const isLastAct = actIndex >= acts.length - 1;
    const myActStory = myChar && myChar.actStories ? (myChar.actStories[actIndex] || '') : '';

    // 公开名册：所有角色，标注是否为「公开嫌疑人」(NPC)
    const roster = SCRIPT.characters.map((c) => {
      const owner = players.find((p) => p.charId === c.id);
      return {
        id: c.id, name: c.name, title: c.title, gender: c.gender,
        isNpc: !owner,
        playerNick: owner ? owner.nick : '',
        avatar: owner ? owner.avatar : '',
        isMe: owner && owner.openid === openid,
      };
    });

    // 线索随幕公开：累积第 0..actIndex 幕的 clueIds
    const revealedIds = [];
    for (let i = 0; i <= actIndex && i < acts.length; i++) {
      (acts[i].clueIds || []).forEach((id) => { if (!revealedIds.includes(id)) revealedIds.push(id); });
    }
    const clues = revealedIds.map((id) => SCRIPT.clues.find((c) => c.id === id)).filter(Boolean);

    const votes = room.votes || {};
    const myVote = votes[openid] || '';

    // 兼容旧房间：除 voting/finished 外的状态都按「逐幕剧情」渲染
    const status = (room.status === 'voting' || room.status === 'finished') ? room.status : 'playing';

    this.setData({
      status,
      actIndex,
      actNum: actIndex + 1,
      actTotal: acts.length,
      actTitle: act ? act.title : '',
      actNarration: act ? act.narration : '',
      isLastAct,
      isHost: room.hostOpenid === openid,
      script: SCRIPT,
      myChar,
      myActStory,
      roster,
      clues,
      myVote,
      votedCount: Object.keys(votes).length,
      totalPlayers: players.filter((p) => p.openid !== room.hostOpenid).length,
    });

    if (room.status === 'finished') {
      this.closeWatch();
      wx.redirectTo({ url: `/pages/result/result?roomId=${this.data.roomId}&roomCode=${this.data.roomCode}` });
    }
  },

  onDissolved() {
    this.closeWatch();
    app.clearSession();
    wx.showModal({ title: '提示', content: '主持人已结束游戏', showCancel: false, success: () => wx.reLaunch({ url: '/pages/index/index' }) });
  },

  // 主持人结束游戏：解散房间，所有人退出
  async endGame() {
    const ok = await this.confirm('确定结束本局并解散房间吗？');
    if (!ok) return;
    this.closeWatch();
    app.clearSession();
    await app.callGame({ action: 'dissolve', roomId: this.data.roomId }).catch(() => {});
    wx.reLaunch({ url: '/pages/index/index' });
  },

  async vote(e) {
    const charId = e.currentTarget.dataset.id;
    const res = await app.callGame({ action: 'vote', roomId: this.data.roomId, charId });
    if (res.result && !res.result.ok) return wx.showToast({ title: res.result.msg || '投票失败', icon: 'none' });
    wx.showToast({ title: '已投票', icon: 'success' });
  },

  // 主持人推进：下一幕 / 进入投票 / 公布真相
  async advance() {
    if (this.data.status === 'voting') {
      const ok = await this.confirm('确定公布真相？投票将结束。');
      if (!ok) return;
    }
    try {
      const res = await app.callGame({ action: 'advance', roomId: this.data.roomId });
      if (!res.result.ok) wx.showToast({ title: res.result.msg || '推进失败', icon: 'none' });
    } catch (err) {
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    }
  },

  confirm(content) {
    return new Promise((resolve) => {
      wx.showModal({ title: '提示', content, success: (r) => resolve(r.confirm) });
    });
  },

  onUnload() { this.closeWatch(); },
});
