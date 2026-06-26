const app = getApp();
const SCRIPTS = require('../../utils/scripts.js');

Page({
  data: {
    nick: '',
    avatar: '',     // 头像 fileID（云存储），记住后下次自动带上
    gender: '',     // 'm' / 'f'，决定角色照片；记住后下次自动带上
    loading: false,
    scripts: SCRIPTS.list.map((s) => ({
      id: s.id, title: s.title, subtitle: s.subtitle, tag: s.tag, cover: s.cover,
      players: `${s.minPlayers}-${s.maxPlayers}人`, duration: s.duration,
    })),
    needAuth: false, // 未完善头像昵称 → 强制授权门
    authStep: 1,     // 授权向导步骤：1 头像 / 2 昵称 / 3 性别
    editing: false,  // true=从首页「编辑」进入（按钮显示「确定」）
    picking: false,  // 是否展开剧本封面选择层
    uploading: false,
  },

  onLoad() {
    const nick = wx.getStorageSync('nick') || '';
    const avatar = wx.getStorageSync('avatar') || '';
    const gender = wx.getStorageSync('gender') || '';
    // 首次进入（缺头像/昵称/性别）才弹授权门，从第一步开始
    const needAuth = !(nick && avatar && gender);
    // 弹向导时昵称默认置空，让用户用微信昵称组件重新带出（避免残留旧昵称）
    this.setData({ nick: needAuth ? '' : nick, avatar, gender, needAuth, authStep: 1 });
    app.ensureLogin().catch(() => {});
  },

  // 编辑资料：重新打开三步向导（带出当前头像/昵称/性别，改完再确认）
  editProfile() {
    this.setData({ needAuth: true, authStep: 1, editing: true });
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
  },

  onShow() {
    // 已经在某局里（已入房/已是房主）→ 直接进房间，不停留在选择页
    if (this.data.needAuth) return;
    const s = app.getSession();
    if (s) wx.reLaunch({ url: `/pages/room/room?roomId=${s.roomId}&roomCode=${s.roomCode}` });
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
  // 选中某个剧本封面 → 创建房间
  pickAndCreate(e) {
    if (this.data.loading) return;
    this.setData({ picking: false });
    this.createRoom(e.currentTarget.dataset.id);
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
        this.joinRoom(code);
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
