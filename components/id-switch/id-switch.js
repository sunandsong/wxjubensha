// 测试身份悬浮切换钮：右侧小圆钮，仅开发/体验版显示（app.testEnabled）
const IDS = [
  { uid: 'test-A', nick: '玩家A', gender: 'm' },
  { uid: 'test-B', nick: '玩家B', gender: 'f' },
  { uid: 'test-C', nick: '玩家C', gender: 'm' },
  { uid: 'test-D', nick: '玩家D', gender: 'f' },
];

Component({
  data: { show: false, label: '' },

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
      return f ? f.nick.slice(-1) : uid.slice(-1);   // A / B / C / D
    },

    switchId() {
      const app = getApp();
      wx.showActionSheet({
        itemList: IDS.map((i) => i.nick).concat('真实账号'),
        success: (r) => {
          if (r.tapIndex < IDS.length) {
            const t = IDS[r.tapIndex];
            app.setTestUid(t.uid);
            wx.setStorageSync('nick', t.nick);
            wx.setStorageSync('avatar', '');          // 测试身份用字母头像
            wx.setStorageSync('gender', t.gender);
          } else {
            app.setTestUid(null);
          }
          wx.reLaunch({ url: '/pages/hub/hub' });     // 以新身份从大厅重进（有房会自动续上）
        },
      });
    },
  },
});
