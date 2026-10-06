// app.js
// 测试身份总开关：自测多人时改 true，平时 false（彻底隐藏测试入口/角标）
const TEST_ENABLED = false;
// 后端：人生清单 CloudBase 环境里的云函数 jbs（HTTP 访问服务），wx.request 调用，JWT 认身份
const API_BASE = 'https://renshengqingdan-d9fc03opf3bac6ba-1478597699.ap-shanghai.app.tcloudbase.com/jbs';
// 房间轮询间隔（替代原来数据库 watch 的实时推送）：对局中快、等待阶段慢
const POLL_PLAYING = 1500;
const POLL_WAITING = 3000;
// 默认头像：包内图片，任何人的手机上都能显示
const DEFAULT_AVATAR = '/assets/logo_144.png';

App({
  onLaunch() {
    // 迁移前的头像是旧环境的 cloud:// 地址，新环境显示不了：清掉，换回默认头像
    const av = wx.getStorageSync('avatar');
    if (av && av.indexOf('cloud://') === 0) wx.removeStorageSync('avatar');
    this.ensureProfile();   // 一进来就给默认昵称+头像，不弹任何授权
    // 测试身份（仅开发/体验版用，模拟多玩家）：总开关关闭时一律 null
    this.globalData.testUid = TEST_ENABLED ? (wx.getStorageSync('testUid') || null) : null;
    // 启动即从本地缓存恢复身份（必须和 token 配套：没 token 的 openid 是迁移前旧小程序的，作废）
    this.globalData.token = wx.getStorageSync('jbsToken') || null;
    const cached = this.globalData.token && wx.getStorageSync('openid');
    if (cached) this.globalData.openid = cached;
    this.ensureLogin().catch(() => {});
  },

  globalData: {
    userInfo: null,
    openid: null,
    token: null,
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

  // ── HTTP 请求后端（POST JSON），resolve 为 { statusCode, data } ──
  _post(path, data, token) {
    return new Promise((resolve, reject) => {
      wx.request({
        url: API_BASE + path,
        method: 'POST',
        data,
        header: token ? { Authorization: 'Bearer ' + token } : {},
        timeout: 15000,
        success: resolve,
        fail: reject,
      });
    });
  },

  // ── 统一调用后端对局接口：有测试 uid 则带上；返回 { result } 与原 wx.cloud.callFunction 同形 ──
  // token 失效（401）时重新登录再试一次
  async callGame(data) {
    const uid = this.globalData.testUid;
    const body = uid ? { ...data, uid } : data;
    for (let i = 0; i < 2; i++) {
      await this._ensureToken();
      const res = await this._post('/call', body, this.globalData.token);
      if (res.statusCode === 401 && i === 0) { this._dropToken(); continue; }
      if (res.statusCode !== 200) throw new Error('服务异常 ' + res.statusCode);
      return { result: res.data };
    }
  },

  // ── 拉一次房间：不存在返回 null（替代原来前端直连数据库的 get）──
  getRoom(roomId) {
    return this.callGame({ action: 'getRoom', roomId }).then((r) => (r.result && r.result.room) || null);
  },

  // ── 轮询房间：接口与原数据库 watch 相同（onChange 收到 { docs: [room] }，房间没了是 { docs: [] }）──
  // 只在内容变化时回调；网络出错静默重试，不触发 onError（页面原来的「断线重建」逻辑用不上了）
  watchRoom(roomId, { onChange }) {
    let closed = false;
    let last = null;
    let timer = null;
    const tick = async () => {
      let next = POLL_PLAYING;
      try {
        const room = await this.getRoom(roomId);
        if (closed) return;
        const sig = JSON.stringify(room);
        if (sig !== last) { last = sig; onChange({ docs: room ? [room] : [] }); }
        if (!room) return;   // 房间没了：不再轮询
        if (room.status === 'waiting') next = POLL_WAITING;
      } catch (e) {
        next = POLL_WAITING;
      }
      if (!closed) timer = setTimeout(tick, next);
    };
    tick();
    return { close: () => { closed = true; clearTimeout(timer); } };
  },

  // ── 上传图片（头像）：后端发一次性凭证，图片直传云存储(COS)；返回 { fileID: 永久 https 链接 } ──
  async uploadFile({ filePath }) {
    const ext = ((filePath.match(/\.(\w+)$/) || [])[1] || 'png').toLowerCase();
    const r = await this.callGame({ action: 'uploadSign', ext });
    const sign = r.result;
    if (!sign || !sign.ok) throw new Error((sign && sign.msg) || '上传凭证获取失败');
    // 凭证是按 PUT 签的，所以不用 wx.uploadFile（只能 POST 表单），读成二进制用 wx.request PUT
    const data = await new Promise((resolve, reject) => {
      wx.getFileSystemManager().readFile({ filePath, success: (r) => resolve(r.data), fail: reject });
    });
    await new Promise((resolve, reject) => {
      wx.request({
        url: sign.url,
        method: 'PUT',
        data,
        header: sign.headers,
        timeout: 30000,
        success: (res) => (res.statusCode >= 200 && res.statusCode < 300 ? resolve() : reject(new Error('上传失败 ' + res.statusCode))),
        fail: reject,
      });
    });
    return { fileID: sign.fileUrl };
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
    return this._ensureToken().then(() => this.globalData.openid);
  },

  // wx.login 的 code → 后端 code2session → openid + JWT（不过期，存本地）
  _ensureToken() {
    // 测试身份下 setLogin 不写 openid（不污染真实缓存），有 token 就够了
    if (this.globalData.token && (this.globalData.openid || this.globalData.testUid)) return Promise.resolve(this.globalData.token);
    if (this._loginPromise) return this._loginPromise;
    this._loginPromise = new Promise((resolve, reject) => wx.login({ success: resolve, fail: reject }))
      .then((r) => this._post('/login', { code: r.code }))
      .then((res) => {
        const d = res.data || {};
        if (res.statusCode !== 200 || !d.token) throw new Error(d.msg || '登录失败');
        this.globalData.token = d.token;
        wx.setStorageSync('jbsToken', d.token);
        if (this.globalData.testUid) wx.setStorageSync('openid', d.openid);   // 测试身份下只落缓存，切回真实身份时可用
        else this.setLogin(d.openid);
        this._loginPromise = null;
        return d.token;
      })
      .catch((e) => {
        this._loginPromise = null;
        throw e;
      });
    return this._loginPromise;
  },

  _dropToken() {
    this.globalData.token = null;
    wx.removeStorageSync('jbsToken');
  },

  // 默认资料：不弹任何资料框，缺昵称/头像就补「玩家XX」+ 包内默认头像（所有人都能显示），想改去「我的」自己改
  ensureProfile() {
    let nick = wx.getStorageSync('nick');
    if (!nick) {
      nick = '玩家' + Math.floor(10 + Math.random() * 90);
      wx.setStorageSync('nick', nick);
    }
    let avatar = wx.getStorageSync('avatar');
    if (!avatar) {
      avatar = DEFAULT_AVATAR;
      wx.setStorageSync('avatar', avatar);
    }
    return { nick, avatar, gender: wx.getStorageSync('gender') || '' };
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
