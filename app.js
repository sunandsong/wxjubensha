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
  },

  // ── 统一调用云函数 ──
  callGame(data) {
    return wx.cloud.callFunction({ name: 'game', data });
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
    if (!openid) return;
    this.globalData.openid = openid;
    wx.setStorageSync('openid', openid);
  },

  // ── 会话：记住「当前所在的对局」，切屏/重启后续上 ──
  _sessionKey() {
    return 'session';
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
