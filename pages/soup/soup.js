// 海龟汤 · 主持人工具：抽汤面 → 分享到群 → 群里问答（主持人长按偷看汤底）→ 揭晓
const SOUPS = require('../../utils/soups.js');

const FLAVORS = { qing: '清汤', hong: '红汤' };

Page({
  data: {
    soup: null,        // 当前汤
    revealed: false,   // 汤底已揭晓
    peeking: false,    // 主持人长按偷看中
    isGuest: false,    // 从分享进来的群友：完全看不到汤底
    flavorName: '',
    stars: '',
  },

  onLoad(query) {
    // 群友点分享卡进来：定位到同一碗汤；带 reveal 的是"汤底卡"，直接公布真相
    if (query && query.soupId) {
      const soup = SOUPS.find((s) => s.id === query.soupId);
      if (soup) return this._show(soup, !!query.guest, !!query.reveal);
    }
    // 主持人正常进入：恢复上次那碗（分享出去后再进来还是原汤），没有才随机抽
    const last = SOUPS.find((s) => s.id === wx.getStorageSync('soupLastId'));
    if (last) return this._show(last);
    this.draw();
  },

  _show(soup, isGuest = false, revealed = false) {
    this.setData({
      soup,
      isGuest,
      revealed,
      peeking: false,
      flavorName: FLAVORS[soup.flavor] || '',
      stars: '★★★'.slice(0, soup.diff) + '☆☆☆'.slice(0, 3 - soup.diff),
    });
    // 记住主持人的当前汤；群友视角不记，防止回头从首页进来偷看汤底
    if (!isGuest) wx.setStorageSync('soupLastId', soup.id);
  },

  // 抽一碗汤（可指定口味，尽量不和当前重复）
  draw(flavor) {
    const { soup } = this.data;
    let pool = !flavor || flavor === 'all' ? SOUPS : SOUPS.filter((s) => s.flavor === flavor);
    if (pool.length > 1 && soup) pool = pool.filter((s) => s.id !== soup.id);
    if (!pool.length) return wx.showToast({ title: '这个口味还没有题', icon: 'none' });
    this._show(pool[Math.floor(Math.random() * pool.length)]);
  },

  // 点「换一碗清汤/红汤」：直接抽对应口味
  drawFlavor(e) {
    this.draw(e.currentTarget.dataset.f);
  },

  // 长按偷看汤底（松手即盖回去）
  peekOn() {
    if (this.data.isGuest || this.data.revealed) return;
    this.setData({ peeking: true });
  },
  peekOff() {
    if (this.data.peeking) this.setData({ peeking: false });
  },

  // 分享到群：汤面卡群友看不到底；「分享汤底」卡片点开直接看真相
  onShareAppMessage(res) {
    const s = this.data.soup;
    if (!s) return { title: '海龟汤 🐢 一起来推理', path: '/pages/soup/soup' };
    const what = res && res.target && res.target.dataset && res.target.dataset.what;
    if (what === 'answer') {
      return {
        title: `💡「${s.title}」汤底揭晓！点开看真相`,
        path: `/pages/soup/soup?soupId=${s.id}&guest=1&reveal=1`,
      };
    }
    return {
      title: `🐢「${s.title}」${FLAVORS[s.flavor]} · 在群里提问，我只答是/不是/无关`,
      path: `/pages/soup/soup?soupId=${s.id}&guest=1`,
    };
  },
});
