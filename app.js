// app.js
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
    // 测试身份（模拟多玩家）：A/B/C 等，存在则覆盖真实 openid
    this.globalData.testUid = wx.getStorageSync('testUid') || null;
    // 启动即从本地缓存恢复身份，随后静默向云端校验一次
    const cached = wx.getStorageSync('openid');
    if (cached) this.globalData.openid = cached;
    this.ensureLogin().catch(() => {});
    // 冷启动后允许首页自动续上未结束的对局（仅一次）
    this._autoResumePending = true;
  },

  globalData: {
    userInfo: null,
    openid: null,
    testUid: null,
  },

  // ── 测试身份 ──
  getTestUid() {
    return this.globalData.testUid;
  },
  setTestUid(uid) {
    this.globalData.testUid = uid || null;
    if (uid) wx.setStorageSync('testUid', uid);
    else wx.removeStorageSync('testUid');
  },

  // ── 统一调用云函数：自动带上测试 uid（若有）──
  callGame(data) {
    const uid = this.globalData.testUid;
    return wx.cloud.callFunction({ name: 'game', data: uid ? { ...data, uid } : data });
  },

  // ── 登录：拿到稳定的身份标识，缓存到本地，重启后仍可用 ──
  ensureLogin() {
    // 测试身份直接用模拟 uid，不走云端
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
});
