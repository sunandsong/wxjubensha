const app = getApp();

Page({
  data: {
    current: '',
    options: [
      { uid: 'test-A', nick: '玩家A', gender: 'm' },
      { uid: 'test-B', nick: '玩家B', gender: 'f' },
      { uid: 'test-C', nick: '玩家C', gender: 'm' },
      { uid: 'test-D', nick: '玩家D', gender: 'f' },
      { uid: 'test-E', nick: '玩家E', gender: 'm' },
      { uid: 'test-F', nick: '玩家F', gender: 'f' },
    ],
  },

  onShow() {
    this.setData({ current: app.getTestUid() || '' });
  },

  // 选择一个模拟身份 → 设为当前身份，进入首页
  pick(e) {
    const uid = e.currentTarget.dataset.uid;
    const nick = e.currentTarget.dataset.nick;
    const gender = e.currentTarget.dataset.gender;
    app.runOnce('switchIdentity', () => {
      app.setTestUid(uid);
      wx.setStorageSync('nick', nick);
      wx.setStorageSync('avatar', ''); // 测试身份用字母头像
      wx.setStorageSync('gender', gender || 'm'); // 测试身份预设性别
      wx.reLaunch({ url: '/pages/hub/hub' });
    }, '');
  },

  // 用真实微信账号（清除模拟身份）
  useReal() {
    app.runOnce('switchIdentity', () => {
      app.setTestUid(null);
      // 清掉测试身份留下的昵称/头像，避免真实账号冒名"玩家X"混进房间
      wx.removeStorageSync('nick');
      wx.removeStorageSync('avatar');
      wx.reLaunch({ url: '/pages/hub/hub' });
    }, '');
  },
});
