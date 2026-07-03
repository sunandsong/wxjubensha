const app = getApp();

const IMGS = ['/assets/app1.jpg', '/assets/app2.jpg', '/assets/app3.jpg', '/assets/app4.jpg', '/assets/app5.jpg'];
const TITLES = ['群本杀 · 拉个群开一局，揪出真凶', '谁在说谎？拉群来一局剧本杀 🔍', '一局一故事，一人一面具'];
const rnd = (a) => a[Math.floor(Math.random() * a.length)];

// 游戏图在云存储 games/ 下；包内只留 th_*.jpg 极小缩略图占位，云图 bindload 后淡入替换
const GBASE = 'cloud://cloud1-d6g6wknyy4d198022.636c-cloud1-d6g6wknyy4d198022-1446823337/games';
const gimg = (name) => `${GBASE}/${name}`;
const gth = (name) => `/assets/games/th_${name}`;

Page({
  data: {
    nick: '', avatar: '',
    manShift: '', bgShift: '',   // 陀螺仪视差位移(裸眼3D)
    bg: gimg('hero_bg.jpg'), bgTh: gth('hero_bg.jpg'), bgOk: false,           // 全屏夜幕背景
    heroMan: gimg('hero_man.png'), heroManTh: gth('hero_man.png'), heroOk: false, // 侦探立绘
    games: [
      { id: 'spy',  name: '谁是卧底', ico: '🎩', d1: '隐藏身份', d2: '智胜全场', count: '8.7k', c: '#ff5c8a', img: gimg('chain.jpg'), th: gth('chain.jpg'), ok: false },
      { id: 'wolf', name: '狼人杀',   ico: '🐺', d1: '天黑闭眼', d2: '揪出狼人', count: '5.2k', c: '#ff7a45', img: gimg('spy.jpg'), th: gth('spy.jpg'), ok: false },
      { id: 'soup', name: '海龟汤',   ico: '🥣', d1: '脑洞提问', d2: '神奇汤面', count: '6.3k', c: '#4db8ff', img: gimg('soup.jpg'), th: gth('soup.jpg'), ok: false },
      { id: 'bomb', name: '数字炸弹', ico: '💣', d1: '猜数字',   d2: '别踩雷',   count: '9.1k', c: '#ffce54', img: gimg('bomb.jpg'), th: gth('bomb.jpg'), ok: false },
    ],
  },

  // 云图加载完成 → 淡入盖过缩略图
  onBgLoad() { this.setData({ bgOk: true }); },
  onHeroLoad() { this.setData({ heroOk: true }); },
  onCardLoad(e) { this.setData({ [`games[${e.currentTarget.dataset.i}].ok`]: true }); },

  onShow() {
    this.setData({
      nick: wx.getStorageSync('nick') || '群友',
      avatar: wx.getStorageSync('avatar') || '',
      testTag: app.getTestUid() ? (wx.getStorageSync('nick') || '') : '',
      isDev: app.testEnabled && app.testEnabled(),
    });
    const s = app.getSession && app.getSession();
    if (s && s.roomId) return wx.reLaunch({ url: `/pages/room/room?roomId=${s.roomId}&roomCode=${s.roomCode}` });
  },
  onHide() { this._stopParallax(); },
  onUnload() { this._stopParallax(); },

  // 裸眼3D视差：以进入时的握持姿态为基准，倾斜差驱动立绘正向、背景反向微移
  _startParallax() {
    if (this._pl) return;
    this._pl = true;
    this._plBase = null;
    this._sx = 0; this._sy = 0;   // 低通滤波后的平滑值
    this._onMotion = (res) => {
      if (this._plBase === null) this._plBase = { b: res.beta, g: res.gamma };
      const now = Date.now();
      if (now - (this._plT || 0) < 50) return;   // 节流 ~20fps，配合 CSS transition 平滑
      this._plT = now;
      const clamp = (v) => Math.max(-1, Math.min(1, v));
      const dx = clamp((res.gamma - this._plBase.g) / 25);  // 左右倾
      const dy = clamp((res.beta - this._plBase.b) / 25);   // 前后倾
      // 低通滤波抹掉传感器噪声：只跟随趋势，不跟随手抖
      this._sx = this._sx * 0.75 + dx * 0.25;
      this._sy = this._sy * 0.75 + dy * 0.25;
      // 量化到 1px 步长：静止时数值不变 → 不触发 setData → 画面纹丝不动
      const mx = Math.round(this._sx * 14), my = Math.round(this._sy * 8);
      const manShift = `translate(${mx}px, ${my}px)`;
      if (manShift === this._plLast) return;
      this._plLast = manShift;
      this.setData({
        manShift,
        bgShift: `translate(${-Math.round(this._sx * 6)}px, ${-Math.round(this._sy * 4)}px) scale(1.02)`,
      });
    };
    wx.startDeviceMotionListening({ interval: 'ui' });
    wx.onDeviceMotionChange(this._onMotion);
  },
  _stopParallax() {
    if (!this._pl) return;
    this._pl = false;
    wx.offDeviceMotionChange(this._onMotion);
    wx.stopDeviceMotionListening();
  },

  tapCard(e) {
    e.currentTarget.dataset.main ? this.goScripts() : this.goGame();
  },
  goScripts() { wx.navigateTo({ url: '/pages/index/index' }); },
  goGame(e) {
    const id = e && e.currentTarget && e.currentTarget.dataset.game;
    if (id === 'bomb') return wx.navigateTo({ url: '/pages/bomb/bomb' });
    if (id === 'soup') return wx.navigateTo({ url: '/pages/soup/soup' });
    if (id === 'spy') return wx.navigateTo({ url: '/pages/spy/spy' });
    wx.showToast({ title: '即将上线，敬请期待', icon: 'none' });
  },
  soon() { wx.showToast({ title: '即将上线', icon: 'none' }); },
  gotoTest() { wx.navigateTo({ url: '/pages/test/test' }); },
  goMe() { wx.navigateTo({ url: '/pages/profile/profile' }); },   // 点头像 → 个人资料页

  onShareAppMessage() { return { title: rnd(TITLES), path: '/pages/hub/hub', imageUrl: rnd(IMGS) }; },
  onShareTimeline() { return { title: rnd(TITLES), imageUrl: rnd(IMGS) }; },
});
