const app = getApp();
const SCRIPTS = require('../../utils/scriptStore.js');

// 首页分享：5 张图 + 标题池，分享时随机组合（图固定打包；以后可换云存储）
const HOME_SHARE_IMGS = ['/assets/app1.jpg', '/assets/app2.jpg', '/assets/app3.jpg', '/assets/app4.jpg', '/assets/app5.jpg'];
const HOME_SHARE_TITLES = [
  '群本杀 · 拉个群开一局，揪出真凶',
  '谁在说谎？拉群来一局剧本杀 🔍',
  '一局一故事，一人一面具',
  '今晚谁是凶手？进来抓一个 🕵️',
  '三五好友，一桩命案，你敢来吗',
];
const pick = (arr) => arr[Math.floor(Math.random() * arr.length)];

// 剧本 → 首页卡片数据；coverFid 留住原始 cloud:// 以便转 https 直链
const toCard = (s) => ({
  id: s.id, title: s.title, subtitle: s.subtitle, tag: s.tag,
  cover: { ...(s.cover || {}) },
  coverFid: (s.cover && s.cover.image) || '',
  players: `${s.minPlayers}-${s.maxPlayers}人`, duration: s.duration,
  cat: (s.tag || '').split('·')[0].trim() || '其他',
});

Page({
  data: {
    nick: '',
    avatar: '',     // 头像 fileID（云存储），记住后下次自动带上
    gender: '',     // 'm' / 'f'，决定角色照片；记住后下次自动带上
    loading: false,
    scripts: SCRIPTS.list().map(toCard),
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
    showGuide: false,  // 新手指引弹层
    showJoin: false,   // 进入房间弹层
    joinInput: '',     // 房间号输入
    uploading: false,
  },

  // 新手指引：打开 / 关闭（关闭即记住，不再自动弹）
  openGuide() { this.setData({ showGuide: true }); },
  closeGuide() { this.setData({ showGuide: false }); wx.setStorageSync('seenGuide', 1); },

  // 转发给好友/群：在详情页则分享该本，否则分享整个小程序（随机图+随机标题）
  onShareAppMessage() {
    const d = this.data.showDetail && this.data.detail;
    if (d) {
      const titles = [
        `「${d.title}」${d.subtitle} — 来一局？`,
        `敢挑战《${d.title}》吗？找出真凶 🔍`,
        `《${d.title}》开局了，就差你一个`,
      ];
      return { title: pick(titles), path: `/pages/index/index?scriptId=${d.id}`, imageUrl: pick(HOME_SHARE_IMGS) };
    }
    return { title: pick(HOME_SHARE_TITLES), path: '/pages/index/index', imageUrl: pick(HOME_SHARE_IMGS) };
  },

  // 分享到朋友圈（随机图+随机标题）
  onShareTimeline() {
    return { title: pick(HOME_SHARE_TITLES), imageUrl: pick(HOME_SHARE_IMGS) };
  },

  onLoad(options) {
    // 从分享卡片进入：带 joinCode → 自动加入；带 scriptId → 自动打开该本详情
    if (options && options.joinCode) this.pendingJoinCode = options.joinCode;
    if (options && options.scriptId) this.pendingScriptId = options.scriptId;
    const nick = wx.getStorageSync('nick') || '';
    const avatar = wx.getStorageSync('avatar') || '';
    const gender = wx.getStorageSync('gender') || '';
    // 浏览免登录：进来先随便逛，开本/进房时再弹授权向导
    this.setData({
      nick, avatar, gender, needAuth: false, authStep: 1,
      showGuide: !wx.getStorageSync('seenGuide'),   // 首次进入自动弹一次新手指引
    });
    app.ensureLogin().catch(() => {});
    this.initCategories();
    this._resolveCovers();   // 首屏先用缓存的封面直链秒显
    // 云端剧本就绪后重建卡片（首屏先用兜底/缓存，秒开不白屏）
    SCRIPTS.ensureLoaded().then(() => { this._reloadScripts(); this._tryOpenPendingDetail(); });
  },

  // 分享链接带 scriptId → 自动打开该本详情
  _tryOpenPendingDetail() {
    if (!this.pendingScriptId) return;
    const id = this.pendingScriptId; this.pendingScriptId = '';
    this.openDetail({ currentTarget: { dataset: { id } } });
  },

  // 用最新剧本数据重建首页卡片 + 分类
  _reloadScripts() {
    const scripts = SCRIPTS.list().map(toCard);
    this.setData({ scripts }, () => { this.initCategories(); this.applyFilter(); this._resolveCovers(); });
  },

  // 封面三级缓存：本地文件(永久,秒显) > https 临时链接(1小时) > cloud:// 现取
  // 首次用临时链接显示并后台下载落盘，之后每次直接读本地文件，不再重复下载
  _resolveCovers() {
    const CK = 'coverUrlMapV1';    // fileID → https 临时链接
    const LK = 'coverLocalMapV1';  // fileID → 已落盘的本地文件路径
    const fs = wx.getFileSystemManager();
    const dir = `${wx.env.USER_DATA_PATH}/covers`;
    const local = wx.getStorageSync(LK) || {};
    // 0) 本地文件已被系统清理的，从映射里剔除
    Object.keys(local).forEach((fid) => {
      try { fs.accessSync(local[fid]); } catch (e) { delete local[fid]; }
    });
    const c = wx.getStorageSync(CK);
    const map = (c && c.ts && (Date.now() - c.ts < 3600000) && c.map) || {};
    const best = (fid) => local[fid] || map[fid] || '';
    // 1) 本地/链接缓存命中的立刻替换
    const apply = () => this.data.scripts.map((s) => {
      const u = s.coverFid && best(s.coverFid);
      return u ? { ...s, cover: { ...s.cover, image: u } } : s;
    });
    this.setData({ scripts: apply() }, () => this.applyFilter());
    // 2) 后台把还没落盘的封面下载到本地，下次秒开
    const download = (fid, url) => wx.downloadFile({
      url,
      success: (r) => {
        if (r.statusCode !== 200) return;
        try { fs.mkdirSync(dir, true); } catch (e) {}
        const dest = `${dir}/${fid.split('/').pop()}`;
        fs.saveFile({
          tempFilePath: r.tempFilePath, filePath: dest,
          success: () => { local[fid] = dest; wx.setStorageSync(LK, local); },
        });
      },
    });
    const toSave = (m) => [...new Set(this.data.scripts
      .filter((s) => s.coverFid && s.coverFid.indexOf('cloud://') === 0 && !local[s.coverFid])
      .map((s) => s.coverFid))].forEach((fid) => m[fid] && download(fid, m[fid]));
    // 3) 连临时链接都没有的，批量取一次再显示+落盘
    const need = [...new Set(this.data.scripts
      .filter((s) => s.coverFid && s.coverFid.indexOf('cloud://') === 0 && !best(s.coverFid))
      .map((s) => s.coverFid))];
    if (!need.length) { toSave(map); return; }
    wx.cloud.getTempFileURL({ fileList: need }).then((res) => {
      (res.fileList || []).forEach((f) => { if (f.fileID && f.tempFileURL) map[f.fileID] = f.tempFileURL; });
      wx.setStorageSync(CK, { ts: Date.now(), map });
      this.setData({ scripts: apply() }, () => this.applyFilter());
      toSave(map);
    }).catch(() => {});
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
    const id = e.currentTarget.dataset.id;
    const s = SCRIPTS.byId(id);
    if (!s) return;
    // 复用列表里已转好的 https 封面，避免详情页又拉一次 cloud://
    const card = this.data.scripts.find((c) => c.id === id);
    const cover = (card && card.cover) || { ...(s.cover || {}) };
    this.setData({
      showDetail: true,
      detail: {
        id: s.id, title: s.title, subtitle: s.subtitle, tag: s.tag, cover,
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
    this.setData({ showJoin: true, joinInput: '' });
  },
  closeJoin() { this.setData({ showJoin: false }); },
  onJoinInput(e) {
    this.setData({ joinInput: (e.detail.value || '').replace(/\D/g, '').slice(0, 4) });
  },
  confirmJoin() {
    const code = (this.data.joinInput || '').trim();
    if (!/^\d{4}$/.test(code)) return wx.showToast({ title: '请输入 4 位房间号', icon: 'none' });
    this.setData({ showJoin: false });
    this._requireAuth(() => this.joinRoom(code));
  },

  async createRoom(scriptId) {
    if (app.blockIfInRoom()) return;
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
    if (app.blockIfInRoom()) return;
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
