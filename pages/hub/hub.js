const app = getApp();

const IMGS = ['/assets/app1.jpg', '/assets/app2.jpg', '/assets/app3.jpg', '/assets/app4.jpg', '/assets/app5.jpg'];
const TITLES = ['群本杀 · 拉个群开一局，揪出真凶', '谁在说谎？拉群来一局剧本杀 🔍', '一局一故事，一人一面具'];
const rnd = (a) => a[Math.floor(Math.random() * a.length)];

Page({
  data: {
    nick: '', avatar: '',
    games: [
      { id: 'spy',  name: '谁是卧底', en: 'SPY GAME',    d1: '隐藏身份', d2: '找出破绽', count: '1897', img: '/assets/games/spy.png' },
      { id: 'bomb', name: '数字炸弹', en: 'NUMBER BOMB', d1: '猜数字',   d2: '别踩雷',   count: '1531', img: '/assets/games/bomb.png' },
      { id: 'soup', name: '海龟汤',   en: 'TURTLE SOUP', d1: '脑洞推理', d2: '神奇反转', count: '1442', img: '/assets/games/soup.png' },
      { id: 'chain', name: '成语接龙', en: 'IDIOM CHAIN', d1: '接不上',   d2: '就出局',   count: '1789', img: '/assets/games/chain.png' },
    ],
  },

  onShow() {
    this.setData({ nick: wx.getStorageSync('nick') || '群友', avatar: wx.getStorageSync('avatar') || '' });
    const s = app.getSession && app.getSession();
    if (s && s.roomId) wx.reLaunch({ url: `/pages/room/room?roomId=${s.roomId}&roomCode=${s.roomCode}` });
  },

  tapCard(e) {
    e.currentTarget.dataset.main ? this.goScripts() : this.goGame();
  },
  goScripts() { wx.navigateTo({ url: '/pages/index/index' }); },
  goGame() { wx.showToast({ title: '即将上线，敬请期待', icon: 'none' }); },
  soon() { wx.showToast({ title: '即将上线', icon: 'none' }); },
  goMe() { wx.navigateTo({ url: '/pages/index/index' }); },   // 暂时进剧本页（内有编辑资料）

  onShareAppMessage() { return { title: rnd(TITLES), path: '/pages/hub/hub', imageUrl: rnd(IMGS) }; },
  onShareTimeline() { return { title: rnd(TITLES), imageUrl: rnd(IMGS) }; },
});
