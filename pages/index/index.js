const app = getApp();
const SCRIPTS = require('../../utils/scriptStore.js');

Page({
  data: {
    nick: '',
    avatar: '',     // 头像 fileID（云存储），记住后下次自动带上
    gender: '',     // 'm' / 'f'，决定角色照片；记住后下次自动带上
    loading: false,
    scripts: SCRIPTS.list().map((s) => ({
      id: s.id, title: s.title, subtitle: s.subtitle, tag: s.tag, cover: s.cover,
      players: `${s.minPlayers}-${s.maxPlayers}人`, duration: s.duration,
      cat: (s.tag || '').split('·')[0].trim() || '其他',   // 主分类：取标签第一段（悬疑/奇幻/欢乐…）
    })),
    filteredScripts: [],   // 当前分类 + 关键词过滤后的剧本（onLoad 初始化）
    categories: [],        // 分类标签：全部 + 各主分类（onLoad 初始化）
    activeCat: '全部',     // 当前选中的分类
    keyword: '',           // 搜索关键词
    needAuth: false, // 未完善头像昵称 → 强制授权门
    authStep: 1,     // 授权向导步骤：1 头像 / 2 昵称 / 3 性别
    editing: false,  // true=从首页「编辑」进入（按钮显示「确定」）
    picking: false,  // 是否展开剧本封面选择层
    showDetail: false, // 是否展开剧本详情页（确认后才建房）
    detail: null,      // 当前查看的剧本详情
    uploading: false,
  },

  onLoad(options) {
    // 从分享卡片进入：带 joinCode → 资料就绪后自动加入该房间
    if (options && options.joinCode) this.pendingJoinCode = options.joinCode;
    const nick = wx.getStorageSync('nick') || '';
    const avatar = wx.getStorageSync('avatar') || '';
    const gender = wx.getStorageSync('gender') || '';
    // 浏览免登录：进来先随便逛，开本/进房时再弹授权向导
    this.setData({
      nick, avatar, gender, needAuth: false, authStep: 1,
      testTag: app.getTestUid() ? nick : '', isDev: app.testEnabled(),
    });
    app.ensureLogin().catch(() => {});
    this.initCategories();
    // 云端剧本就绪后重建卡片（首屏先用兜底/缓存，秒开不白屏）
    SCRIPTS.ensureLoaded().then(() => this._reloadScripts());
  },

  // 用最新剧本数据重建首页卡片 + 分类
  _reloadScripts() {
    const scripts = SCRIPTS.list().map((s) => ({
      id: s.id, title: s.title, subtitle: s.subtitle, tag: s.tag, cover: s.cover,
      players: `${s.minPlayers}-${s.maxPlayers}人`, duration: s.duration,
      cat: (s.tag || '').split('·')[0].trim() || '其他',
    }));
    this.setData({ scripts }, () => { this.initCategories(); this.applyFilter(); });
  },

  // 初始化分类标签 + 默认展示全部剧本
  initCategories() {
    const cats = [];
    this.data.scripts.forEach((s) => { if (cats.indexOf(s.cat) < 0) cats.push(s.cat); });
    this.setData({ categories: ['全部'].concat(cats), filteredScripts: this.data.scripts });
  },

  // 按分类 + 关键词过滤剧本
  applyFilter() {
    const { scripts, activeCat, keyword } = this.data;
    const kw = (keyword || '').trim().toLowerCase();
    const filteredScripts = scripts.filter((s) => {
      const okCat = activeCat === '全部' || s.cat === activeCat;
      const okKw = !kw || `${s.title} ${s.subtitle} ${s.tag} ${s.players}`.toLowerCase().indexOf(kw) >= 0;
      return okCat && okKw;
    });
    this.setData({ filteredScripts });
  },

  // 点选分类标签
  selectCat(e) {
    this.setData({ activeCat: e.currentTarget.dataset.cat }, () => this.applyFilter());
  },

  // 搜索框输入
  onSearchInput(e) {
    this.setData({ keyword: e.detail.value }, () => this.applyFilter());
  },

  // 清空搜索框
  clearSearch() {
    this.setData({ keyword: '' }, () => this.applyFilter());
  },

  // 编辑资料：重新打开三步向导（带出当前头像/昵称/性别，改完再确认）
  editProfile() {
    this._orig = { avatar: this.data.avatar, nick: this.data.nick, gender: this.data.gender };
    this.setData({ needAuth: true, authStep: 1, editing: true });
  },

  // 需要资料才能做的动作（开本/进房）：没资料先弹向导，完成后自动执行
  _requireAuth(fn) {
    if (app.getTestUid() || (this.data.nick && this.data.avatar && this.data.gender)) return fn();
    this._pendingAuthAction = fn;
    this._orig = null;
    this.setData({ needAuth: true, authStep: 1, editing: false, nick: '' });
  },

  // 取消编辑 / 取消授权：还原原值与缓存，关闭向导
  cancelEdit() {
    this._pendingAuthAction = null;
    const o = this._orig || {};
    wx.setStorageSync('avatar', o.avatar || '');
    wx.setStorageSync('nick', o.nick || '');
    wx.setStorageSync('gender', o.gender || '');
    this.setData({
      avatar: o.avatar || '', nick: o.nick || '', gender: o.gender || '',
      needAuth: false, editing: false,
    });
  },

  // 授权向导：下一步
  stepNext() {
    const step = this.data.authStep;
    if (step === 1) {
      if (this.data.uploading) return wx.showToast({ title: '头像上传中…', icon: 'none' });
      if (!this.data.avatar) return wx.showToast({ title: '请先选择头像', icon: 'none' });
      this.setData({ authStep: 2 });
    } else if (step === 2) {
      const nick = (this.data.nick || '').trim().slice(0, 8);
      if (!nick) return wx.showToast({ title: '请填写昵称', icon: 'none' });
      wx.setStorageSync('nick', nick);
      this.setData({ nick, authStep: 3 });
    }
  },

  // 授权向导：上一步
  stepBack() {
    if (this.data.authStep > 1) this.setData({ authStep: this.data.authStep - 1 });
  },

  // 选择性别（决定角色照片）
  pickGender(e) {
    const gender = e.currentTarget.dataset.g;
    this.setData({ gender });
    wx.setStorageSync('gender', gender);
  },

  // 选择微信头像 → 上传云存储，得到可被他人加载的 fileID 并记住
  async onChooseAvatar(e) {
    const tmp = e.detail.avatarUrl;
    this.setData({ avatar: tmp, uploading: true });   // 先本地预览
    try {
      const openid = await app.ensureLogin();
      const up = await wx.cloud.uploadFile({
        cloudPath: `avatars/${openid}_${Date.now()}.png`,
        filePath: tmp,
      });
      this.setData({ avatar: up.fileID });
      wx.setStorageSync('avatar', up.fileID);
    } catch (err) {
      wx.showToast({ title: '头像上传失败，可重试', icon: 'none' });
    } finally {
      this.setData({ uploading: false });
    }
  },

  // 第三步完成：三项齐全才能进入（缺哪步回哪步）
  confirmAuth() {
    if (!this.data.avatar) return this.setData({ authStep: 1 });
    const nick = (this.data.nick || '').trim().slice(0, 8);
    if (!nick) return this.setData({ authStep: 2 });
    if (!this.data.gender) return wx.showToast({ title: '请选择性别', icon: 'none' });
    wx.setStorageSync('nick', nick);
    this.setData({ nick, needAuth: false, editing: false });
    // 资料完善后，执行刚才被挡下的动作（开本/进房）
    const fn = this._pendingAuthAction; this._pendingAuthAction = null;
    if (fn) fn(); else this._tryPendingJoin();
  },

  onShow() {
    if (this.data.needAuth) return;           // 先完善资料
    if (this._tryPendingJoin()) return;        // 分享卡片进入 → 自动加入
    // 已经在某局里（已入房/已是房主）→ 直接进房间，不停留在选择页
    const s = app.getSession();
    if (s) wx.reLaunch({ url: `/pages/room/room?roomId=${s.roomId}&roomCode=${s.roomCode}` });
  },

  // 有待加入的房间号（来自分享卡片）→ 加入
  _tryPendingJoin() {
    if (!this.pendingJoinCode) return false;
    const code = this.pendingJoinCode;
    this.pendingJoinCode = '';
    this._requireAuth(() => this.joinRoom(code));
    return true;
  },

  noop() {},
  onNick(e) { this.setData({ nick: e.detail.value }); },
  // 首页改完昵称即记住，下次自动带上
  saveNick(e) {
    const nick = (e.detail.value || '').trim().slice(0, 8);
    this.setData({ nick });
    if (nick) wx.setStorageSync('nick', nick);
  },

  // 「我是房主」→ 打开剧本封面卡片选择层
  becomeHost() {
    if (this.data.loading) return;
    this.setData({ picking: true });
  },
  closePicker() { this.setData({ picking: false }); },

  // 点剧本封面 → 先看详情，不直接建房
  openDetail(e) {
    if (this.data.loading) return;
    const s = SCRIPTS.byId(e.currentTarget.dataset.id);
    if (!s) return;
    this.setData({
      showDetail: true,
      detail: {
        id: s.id, title: s.title, subtitle: s.subtitle, tag: s.tag, cover: s.cover,
        players: `${s.minPlayers}-${s.maxPlayers}人`, duration: s.duration,
        intro: s.intro || '',
        worldview: s.worldview || '',
        victim: s.victim && s.victim.name ? s.victim.name : '',
        // 角色顺序随机打乱：避免「列表第一个永远是凶手」的规律泄底
        roster: (s.characters || []).map((c) => ({ name: c.name, title: c.title })).sort(() => Math.random() - 0.5),
        relations: s.relations || [],
      },
    });
  },
  closeDetail() { this.setData({ showDetail: false }); },

  // 详情页确认 → 用这个本创建房间（没资料先弹向导）
  confirmCreate() {
    if (this.data.loading || !this.data.detail) return;
    const id = this.data.detail.id;
    this.setData({ showDetail: false, picking: false });
    this._requireAuth(() => this.createRoom(id));
  },

  // 「进入房间」→ 弹窗输入房间号再加入
  enterRoom() {
    if (this.data.loading) return;
    wx.showModal({
      title: '进入房间',
      editable: true,
      placeholderText: '输入 4 位房间号',
      success: (res) => {
        if (!res.confirm) return;
        const code = (res.content || '').trim();
        if (!/^\d{4}$/.test(code)) return wx.showToast({ title: '请输入 4 位房间号', icon: 'none' });
        this._requireAuth(() => this.joinRoom(code));
      },
    });
  },

  async createRoom(scriptId) {
    const nick = (this.data.nick || '神秘玩家').slice(0, 8);
    const avatar = this.data.avatar;
    const gender = this.data.gender;
    this.setData({ loading: true });
    let res;
    try {
      res = await app.runOnce('create', () => app.callGame({ action: 'create', nick, avatar, gender, scriptId }), '创建中');
    } catch (e) {
      this.setData({ loading: false });
      return wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    }
    this.setData({ loading: false });
    const r = res && res.result;
    if (!r) return;                         // 被防抖忽略
    if (!r.ok) return wx.showToast({ title: r.msg || '创建失败', icon: 'none' });
    app.setLogin(r.openid);
    app.saveSession({ roomId: r.roomId, roomCode: r.roomCode });
    wx.reLaunch({ url: `/pages/room/room?roomId=${r.roomId}&roomCode=${r.roomCode}` });
  },

  async joinRoom(code) {
    const nick = (this.data.nick || '神秘玩家').slice(0, 8);
    const avatar = this.data.avatar;
    const gender = this.data.gender;
    this.setData({ loading: true });
    let res;
    try {
      res = await app.runOnce('join', () => app.callGame({ action: 'join', roomCode: code, nick, avatar, gender }), '加入中');
    } catch (e) {
      this.setData({ loading: false });
      return wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    }
    this.setData({ loading: false });
    const r = res && res.result;
    if (!r) return;                         // 被防抖忽略
    if (!r.ok) return wx.showToast({ title: r.msg || '加入失败', icon: 'none' });
    app.setLogin(r.openid);
    app.saveSession({ roomId: r.roomId, roomCode: r.roomCode });
    wx.reLaunch({ url: `/pages/room/room?roomId=${r.roomId}&roomCode=${r.roomCode}` });
  },
});
