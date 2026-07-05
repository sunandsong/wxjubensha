const app = getApp();
const db = wx.cloud.database();
const SCRIPTS = require('../../utils/scriptStore.js');
const IMGCACHE = require('../../utils/imgCache.js');

// 光影素材（云存储 games/）：星空底图（候场=星座连线,玩家逐个就位点亮）
const GBASE = 'cloud://cloud1-d6g6wknyy4d198022.636c-cloud1-d6g6wknyy4d198022-1446823337/games';
const BG_FID = GBASE + '/room_bg.jpg';

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
    shareImg: '',     // 分享卡片缩略图：当前本封面的 https 临时链接（cloud:// 不能直接当分享图）
    bgUrl: '', bgOk: false,   // 星空底图
  },

  watcher: null,

  onLoad(query) {
    IMGCACHE.resolve([BG_FID], (m) => { if (m[BG_FID] && m[BG_FID] !== this.data.bgUrl) this.setData({ bgUrl: m[BG_FID] }); });
    this.setData({ roomId: query.roomId, roomCode: query.roomCode });
    // 记住当前对局，切屏/重启后可在首页续上
    app.saveSession({ roomId: query.roomId, roomCode: query.roomCode });
    app.globalData.roomAutoResumed = true;   // 已在房间里，回大厅不要再弹回来
  },

  // 每次回到前台都确保身份就绪并重连监听（切屏后 watch 会断开）
  async onShow() {
    this._hidden = false;
    this.setData({ testTag: app.getTestUid() ? wx.getStorageSync('nick') : '', isDev: app.testEnabled() });
    try {
      this.setData({ openid: await app.ensureLogin() });
    } catch (e) {}
    await SCRIPTS.ensureLoaded();   // 确保剧本数据（云端/缓存/兜底）就绪
    // 每次进入都重新请求最新数据（不依赖缓存），带 Loading
    wx.showLoading({ title: '加载中', mask: true });
    try {
      // 用 where 查询：房间不存在时返回空数组（不会 reject），可与网络错误区分
      const res = await db.collection('rooms').where({ _id: this.data.roomId }).get();
      this.renderRoom(res.data[0] || null);   // null → 按「房间已解散」处理
    } catch (e) {
      wx.showToast({ title: '加载失败，请重试', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
    this.startWatch();
  },

  onHide() { this._hidden = true; this.closeWatch(); },


  // 分享小程序卡片到群：群友点卡片 → 打开小程序 → 自动加入本房间
  onShareAppMessage() {
    const code = this.data.roomCode;
    return {
      title: `「${this.data.scriptTitle || '剧本杀'}」房间 ${code}，点我直接进房`,
      path: `/pages/index/index?joinCode=${code}`,
      imageUrl: this.data.shareImg || '/assets/app1.jpg',   // 本封面优先，没拿到回退通用图
    };
  },

  // 解析当前本封面为分享缩略图：cloud:// → https 临时链接；本地路径直接用
  _resolveShareImg(script) {
    if (this.data.shareImg) return;                    // 一局内剧本固定，取一次即可
    const img = (script && script.cover && script.cover.image) || '';
    if (!img) return;
    if (img.indexOf('cloud://') === 0) {
      wx.cloud.getTempFileURL({ fileList: [img] })
        .then((r) => {
          const url = r.fileList && r.fileList[0] && r.fileList[0].tempFileURL;
          if (url) this.setData({ shareImg: url });
        })
        .catch(() => {});
    } else {
      this.setData({ shareImg: img });
    }
  },

  renderRoom(room) {
    if (!room) {
      app.clearSession();
      this.closeWatch();
      wx.showModal({ title: '提示', content: '房间已解散', showCancel: false, success: () => wx.reLaunch({ url: '/pages/hub/hub' }) });
      return;
    }
    const raw = room.players || [];
    const script = SCRIPTS.byId(room.scriptId);
    // 标注主持人（房主），统计真实玩家（房主、吃瓜群众不算）
    const players = raw.map((p) => ({ ...p, isModerator: p.openid === room.hostOpenid }));
    const realPlayers = raw.filter((p) => p.openid !== room.hostOpenid && !p.spectator);
    const realCount = realPlayers.length;
    const needPlayers = (script.characters || []).length;
    const readyCount = realPlayers.filter((p) => p.ready).length;
    const allReady = realCount > 0 && readyCount === realCount;
    const me = raw.find((p) => p.openid === this.data.openid);
    this.setData({
      players,
      realCount,
      needPlayers,
      readyCount,
      allReady,
      myReady: !!(me && me.ready),
      iAmSpectator: !!(me && me.spectator),
      isHost: room.hostOpenid === this.data.openid,
      canStart: realCount >= needPlayers && allReady,   // 人齐 且 全员准备
      scriptTitle: script.title,
      scriptSub: script.subtitle,
    });
    this._resolveShareImg(script);   // 备好分享缩略图（本封面）
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
      onError: (e) => {
        // 监听断了（网络/超时）：先手动拉一次兜底，稍后重建监听
        console.error('watch error', e);
        this.closeWatch();
        db.collection('rooms').where({ _id: this.data.roomId }).get()
          .then((res) => this.renderRoom(res.data[0] || null)).catch(() => {});
        setTimeout(() => {
          if (!this._hidden && this.data.roomId && !this.watcher) this.startWatch();
        }, 2000);
      },
    });
  },

  closeWatch() {
    if (this.watcher) { try { this.watcher.close(); } catch (e) {} this.watcher = null; }
  },

  // 玩家：准备 / 取消准备
  async toggleReady() {
    wx.vibrateShort && wx.vibrateShort({ type: 'light' });
    try {
      await app.runOnce('ready', () => app.callGame({ action: 'ready', roomId: this.data.roomId }), '');
    } catch (e) {
      wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    }
  },

  async startGame() {
    if (this.data.starting) return;
    if (this.data.realCount < this.data.needPlayers) return wx.showToast({ title: `还差 ${this.data.needPlayers - this.data.realCount} 名玩家（需 ${this.data.needPlayers} 人，房主不参与）`, icon: 'none' });
    if (this.data.realCount > this.data.needPlayers) return wx.showToast({ title: `该本最多 ${this.data.needPlayers} 名玩家，现在多了 ${this.data.realCount - this.data.needPlayers} 人`, icon: 'none' });
    if (!this.data.allReady) return wx.showToast({ title: `还有 ${this.data.realCount - this.data.readyCount} 人未点「准备好了」`, icon: 'none' });
    wx.vibrateShort && wx.vibrateShort({ type: 'medium' });
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

  onBgLoad() { this.setData({ bgOk: true }); },
  onBgErr() { IMGCACHE.invalidate(BG_FID); this.setData(this.data.bgUrl !== BG_FID ? { bgUrl: BG_FID, bgOk: false } : { bgUrl: '', bgOk: false }); },

  // 一次性：上传星空底图（成功后删本函数与按钮）
  async uploadLightAssets() {
    const files = [['up_room_bg.jpg', 'games/room_bg.jpg']];
    wx.showLoading({ title: '上传中…', mask: true });
    let done = 0;
    for (const [local, cloudPath] of files) {
      try {
        const info = await new Promise((res, rej) => wx.getImageInfo({ src: `/assets/games/${local}`, success: res, fail: rej }));
        await wx.cloud.uploadFile({ cloudPath, filePath: info.path });
        IMGCACHE.invalidate(GBASE + '/' + cloudPath.split('/').pop());
        done++;
      } catch (e) { console.error('✘', cloudPath, e); }
    }
    wx.hideLoading();
    wx.showModal({ title: '上传完成', content: `成功 ${done}/${files.length} 张`, showCancel: false });
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
      wx.reLaunch({ url: '/pages/hub/hub' });
    }, '结束中');
  },

  async leaveRoom() {
    const ok = await new Promise((res) => {
      wx.showModal({ title: '退出房间', content: '确定退出当前房间吗？', success: (r) => res(r.confirm) });
    });
    if (!ok) return;
    await app.runOnce('leave', async () => {
      this.closeWatch();
      app.clearSession();   // 主动离开 → 不再续局
      await app.callGame({ action: 'leave', roomId: this.data.roomId }).catch(() => {});
      wx.reLaunch({ url: '/pages/hub/hub' });
    }, '退出中');
  },

  onUnload() {
    this.closeWatch();
  },
});
