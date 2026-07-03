// 数字炸弹：暗抽 1~100 的炸弹数，轮流报数缩小范围，报中的人「爆炸」
Page({
  data: {
    min: 1, max: 100,   // 当前安全范围（含端点）
    val: '',            // 当前输入
    guesses: [],        // 已报过的数
    boom: false,        // 是否踩雷
    bombNum: 0,         // 爆炸后揭晓用
  },

  onLoad() { this.newRound(); },

  newRound() {
    this._bomb = 1 + Math.floor(Math.random() * 100);
    this.setData({ min: 1, max: 100, val: '', guesses: [], boom: false, bombNum: 0 });
  },

  onInput(e) { this.setData({ val: e.detail.value }); },

  guess() {
    const n = parseInt(this.data.val, 10);
    const { min, max } = this.data;
    if (isNaN(n)) return wx.showToast({ title: '先输入一个数字', icon: 'none' });
    if (n < min || n > max) return wx.showToast({ title: `要在 ${min} ~ ${max} 之间`, icon: 'none' });
    if (n === this._bomb) {
      wx.vibrateLong();
      this.setData({ boom: true, bombNum: this._bomb, guesses: [...this.data.guesses, n] });
      return;
    }
    // 没中：砍掉炸弹不在的那一侧
    const upd = { val: '', guesses: [...this.data.guesses, n] };
    if (n < this._bomb) upd.min = n + 1; else upd.max = n - 1;
    this.setData(upd);
    wx.showToast({ title: '安全，传给下一位', icon: 'none' });
  },

  onShareAppMessage() {
    return { title: '数字炸弹 💣 谁猜中谁爆炸！', path: '/pages/bomb/bomb' };
  },
});
