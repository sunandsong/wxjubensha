const app = getApp();

const IMGS = ['/assets/app1.jpg', '/assets/app2.jpg', '/assets/app3.jpg', '/assets/app4.jpg', '/assets/app5.jpg'];
const TITLES = ['群本杀 · 拉个群开一局，揪出真凶', '谁在说谎？拉群来一局剧本杀 🔍', '一局一故事，一人一面具'];
const rnd = (a) => a[Math.floor(Math.random() * a.length)];

Page({
  data: {
    nick: '', avatar: '',
    games: [
      { id: 'spy',  name: '谁是卧底', ico: '🎩', d1: '隐藏身份', d2: '智胜全场', count: '8.7k', c: '#ff5c8a', img: '/assets/games/chain.jpg' },
      { id: 'bomb', name: '数字炸弹', ico: '💣', d1: '猜数字',   d2: '别踩雷',   count: '5.2k', c: '#ff7a45', img: '/assets/games/spy.jpg' },
      { id: 'soup', name: '海龟汤',   ico: '🥣', d1: '脑洞提问', d2: '神奇汤面', count: '6.3k', c: '#4db8ff', img: '/assets/games/soup.jpg' },
      { id: 'chain', name: '成语接龙', ico: '🔠', d1: '妙语连珠', d2: '接不上出局', count: '9.1k', c: '#ffce54', img: '/assets/games/bomb.jpg' },
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
