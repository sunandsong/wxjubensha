const app = getApp();

Page({
  data: {
    current: '',
    options: [
      { uid: 'test-A', nick: '玩家A' },
      { uid: 'test-B', nick: '玩家B' },
      { uid: 'test-C', nick: '玩家C' },
    ],
  },

  onShow() {
    this.setData({ current: app.getTestUid() || '' });
  },

  // 选择一个模拟身份 → 设为当前身份，进入首页
  pick(e) {
    const uid = e.currentTarget.dataset.uid;
    const nick = e.currentTarget.dataset.nick;
    app.runOnce('switchIdentity', () => {
      app.setTestUid(uid);
      wx.setStorageSync('nick', nick);
      wx.setStorageSync('avatar', ''); // 测试身份用字母头像
      wx.reLaunch({ url: '/pages/index/index' });
    }, '');
  },

  // 用真实微信账号（清除模拟身份）
  useReal() {
    app.runOnce('switchIdentity', () => {
      app.setTestUid(null);
      wx.reLaunch({ url: '/pages/index/index' });
    }, '');
  },
});
