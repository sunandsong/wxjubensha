// app.js
// 测试身份总开关：自测多人时改 true，平时 false（彻底隐藏测试入口/角标）
const TEST_ENABLED = true;

App({
  onLaunch() {
    if (!wx.cloud) {
      console.error('请使用 2.2.3 或以上的基础库以使用云能力');
      return;
    }
    wx.cloud.init({
      env: 'cloud1-d6g6wknyy4d198022',
      traceUser: true,
    });
    // 测试身份（仅开发/体验版用，模拟多玩家）：总开关关闭时一律 null
    this.globalData.testUid = TEST_ENABLED ? (wx.getStorageSync('testUid') || null) : null;
    // 启动即从本地缓存恢复身份，随后静默向云端校验一次
    const cached = wx.getStorageSync('openid');
    if (cached) this.globalData.openid = cached;
    this.ensureLogin().catch(() => {});
  },

  globalData: {
    userInfo: null,
    openid: null,
    testUid: null,
    roomAutoResumed: false,   // 启动后首页只自动续房一次，点 home 回大厅不再被弹回
  },

  // ── 测试身份（仅开发/体验版）──
  getTestUid() {
    return this.globalData.testUid;
  },
  setTestUid(uid) {
    this.globalData.testUid = uid || null;
    if (uid) wx.setStorageSync('testUid', uid);
    else wx.removeStorageSync('testUid');
    this.globalData.roomAutoResumed = false;   // 切身份后允许再次自动续房
  },
  // 测试入口是否启用：总开关 且 非正式版
  testEnabled() {
    if (!TEST_ENABLED) return false;
    try {
      return wx.getAccountInfoSync().miniProgram.envVersion !== 'release';
    } catch (e) {
      return false;
    }
  },

  // ── 统一调用云函数：有测试 uid 则带上 ──
  callGame(data) {
    const uid = this.globalData.testUid;
    return wx.cloud.callFunction({ name: 'game', data: uid ? { ...data, uid } : data });
  },

  // ── 防抖执行：同一 key 正在执行时忽略重复点击，并显示 loading；结束自动解锁 ──
  // loading 传字符串则显示带遮罩的 loading；传空串则只防抖不显示
  runOnce(key, fn, loading = '请稍候') {
    if (!this._busy) this._busy = {};
    if (this._busy[key]) return Promise.resolve();
    this._busy[key] = true;
    if (loading) wx.showLoading({ title: loading, mask: true });
    return (async () => {
      try {
        return await fn();
      } finally {
        if (loading) wx.hideLoading();
        this._busy[key] = false;
      }
    })();
  },

  // ── 登录：拿到稳定的身份标识，缓存到本地，重启后仍可用 ──
  ensureLogin() {
    if (this.globalData.testUid) return Promise.resolve(this.globalData.testUid);
    if (this.globalData.openid) return Promise.resolve(this.globalData.openid);
    if (this._loginPromise) return this._loginPromise;
    this._loginPromise = wx.cloud
      .callFunction({ name: 'game', data: { action: 'whoami' } })
      .then((res) => {
        const openid = res.result.openid;
        this.setLogin(openid);
        this._loginPromise = null;
        return openid;
      })
      .catch((e) => {
        this._loginPromise = null;
        throw e;
      });
    return this._loginPromise;
  },

  setLogin(openid) {
    if (!openid || this.globalData.testUid) return; // 测试身份不污染真实 openid 缓存
    this.globalData.openid = openid;
    wx.setStorageSync('openid', openid);
  },

  // ── 全局单房间守门：已在任一对局（剧本杀/卧底/狼人杀）中，就不能再建/进新房 ──
  // 在创建/加入入口处调用：返回 true = 已拦截（弹窗引导回原房间），调用方直接 return
  blockIfInRoom() {
    const jb = this.getSession();
    const sp = this.getSpySession();
    const wf = this.getWolfSession();
    const cur =
      (jb && jb.roomId && { name: '剧本杀', code: jb.roomCode, go: () => wx.reLaunch({ url: `/pages/room/room?roomId=${jb.roomId}&roomCode=${jb.roomCode}` }) }) ||
      (sp && sp.roomId && { name: '谁是卧底', code: sp.roomCode, go: () => wx.reLaunch({ url: '/pages/spy/spy?resume=1' }) }) ||
      (wf && wf.roomId && { name: '狼人杀', code: wf.roomCode, go: () => wx.reLaunch({ url: '/pages/wolf/wolf?resume=1' }) });
    if (!cur) return false;
    wx.showModal({
      title: '已有进行中的对局',
      content: `你还在「${cur.name}」房间${cur.code ? ' ' + cur.code : ''}里。同一时间只能在一个房间，先回去退出那局，再开新局。`,
      confirmText: '回到那局',
      cancelText: '取消',
      success: (r) => { if (r.confirm) cur.go(); },
    });
    return true;
  },

  // ── 会话：按身份隔离，记住「当前所在的对局」，切屏/重启/切身份后续上 ──
  _sessionKey() {
    return 'session' + (this.globalData.testUid ? '_' + this.globalData.testUid : '');
  },
  saveSession(session) {
    wx.setStorageSync(this._sessionKey(), session);
  },
  getSession() {
    return wx.getStorageSync(this._sessionKey()) || null;
  },
  clearSession() {
    wx.removeStorageSync(this._sessionKey());
  },

  // ── 卧底局会话：同样按身份隔离，防止切测试身份后进了别人的房间 ──
  _spySessionKey() {
    return 'spySession' + (this.globalData.testUid ? '_' + this.globalData.testUid : '');
  },
  saveSpySession(session) {
    wx.setStorageSync(this._spySessionKey(), session);
  },
  getSpySession() {
    return wx.getStorageSync(this._spySessionKey()) || null;
  },
  clearSpySession() {
    wx.removeStorageSync(this._spySessionKey());
  },

  // ── 狼人杀会话：同样按身份隔离 ──
  _wolfSessionKey() {
    return 'wolfSession' + (this.globalData.testUid ? '_' + this.globalData.testUid : '');
  },
  saveWolfSession(session) {
    wx.setStorageSync(this._wolfSessionKey(), session);
  },
  getWolfSession() {
    return wx.getStorageSync(this._wolfSessionKey()) || null;
  },
  clearWolfSession() {
    wx.removeStorageSync(this._wolfSessionKey());
  },
});
