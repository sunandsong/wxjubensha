// 测试身份悬浮切换钮：右侧小圆钮，仅开发/体验版显示（app.testEnabled）
// 注意：wx.showActionSheet 最多 6 项，这里身份 6 个 + 真实账号 = 7 项，所以用自绘面板
const IDS = [
  { uid: 'test-A', nick: '玩家A', gender: 'm' },
  { uid: 'test-B', nick: '玩家B', gender: 'f' },
  { uid: 'test-C', nick: '玩家C', gender: 'm' },
  { uid: 'test-D', nick: '玩家D', gender: 'f' },
  { uid: 'test-E', nick: '玩家E', gender: 'm' },
  { uid: 'test-F', nick: '玩家F', gender: 'f' },
];

Component({
  data: { show: false, label: '', panel: false, options: [], current: '' },

  lifetimes: {
    attached() {
      const app = getApp();
      this.setData({ show: !!(app.testEnabled && app.testEnabled()), label: this._label() });
    },
  },
  pageLifetimes: {
    show() { if (this.data.show) this.setData({ label: this._label() }); },
  },

  methods: {
    _label() {
      const app = getApp();
      const uid = app.getTestUid && app.getTestUid();
      if (!uid) return '真';
      const f = IDS.find((i) => i.uid === uid);
      return f ? f.nick.slice(-1) : uid.slice(-1);   // A / B / C / D / E / F
    },

    openPanel() {
      const app = getApp();
      this.setData({
        panel: true,
        current: (app.getTestUid && app.getTestUid()) || '',
        options: IDS.concat([{ uid: '', nick: '真实账号' }]),
      });
    },
    closePanel() { this.setData({ panel: false }); },

    gotoTest() {
      this.setData({ panel: false });
      wx.navigateTo({ url: '/pages/test/test' });
    },

    pick(e) {
      const uid = e.currentTarget.dataset.uid;
      const app = getApp();
      this.setData({ panel: false });
      if (uid) {
        const t = IDS.find((i) => i.uid === uid);
        app.setTestUid(t.uid);
        wx.setStorageSync('nick', t.nick);
        wx.setStorageSync('avatar', '');          // 测试身份用字母头像
        wx.setStorageSync('gender', t.gender);
      } else {
        app.setTestUid(null);
      }
      wx.reLaunch({ url: '/pages/hub/hub' });     // 以新身份从大厅重进（有房会自动续上）
    },
  },
});
