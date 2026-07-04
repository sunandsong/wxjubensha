// 海龟汤 · 主持人工具：进店空碗 → 点口味端汤 → 分享到群 → 群里问答（主持人长按偷看汤底）→ 揭晓
const SOUPS = require('../../utils/soups.js');
const IMGCACHE = require('../../utils/imgCache.js');

const FLAVORS = { qing: '清汤', hong: '红汤' };

// 酒馆素材（云存储 games/）：外星酒馆底图 / 发光特调杯
const GBASE = 'cloud://cloud1-d6g6wknyy4d198022.636c-cloud1-d6g6wknyy4d198022-1446823337/games';
const BG_FID = GBASE + '/soup_bg.jpg';
const CUP_FID = GBASE + '/soup_cup.png';

Page({
  data: {
    soup: null,        // 当前汤
    revealed: false,   // 汤底已揭晓
    peeking: false,    // 主持人长按偷看中
    isGuest: false,    // 从分享进来的群友：完全看不到汤底
    flavorName: '',
    stars: '',
    served: false,     // 空碗态 → 点口味才端汤
    hasLast: false,    // 有上一碗（分享后回来可一键续上）
    bgUrl: '', bgOk: false, cupUrl: '',   // 酒馆底图 / 特调杯（云端）
  },

  onLoad(query) {
    this._resolveImgs();
    // 群友点分享卡进来：定位到同一碗汤；带 reveal 的是"汤底卡"，直接公布真相
    if (query && query.soupId) {
      const soup = SOUPS.find((s) => s.id === query.soupId);
      if (soup) return this._show(soup, !!query.guest, !!query.reveal);
    }
    // 主持人正常进入：空碗态，点口味才端汤；有上一碗则给"回到上一碗"入口
    this.setData({ hasLast: !!SOUPS.find((s) => s.id === wx.getStorageSync('soupLastId')) });
  },

  // 酒馆素材：本地缓存优先，云图淡入
  _resolveImgs() {
    IMGCACHE.resolve([BG_FID, CUP_FID], (map) => {
      const d = {};
      if (map[BG_FID] && map[BG_FID] !== this.data.bgUrl) d.bgUrl = map[BG_FID];
      if (map[CUP_FID] && map[CUP_FID] !== this.data.cupUrl) d.cupUrl = map[CUP_FID];
      if (Object.keys(d).length) this.setData(d);
    });
  },
  onBgLoad() { this.setData({ bgOk: true }); },
  onBgErr() { IMGCACHE.invalidate(BG_FID); this.setData(this.data.bgUrl !== BG_FID ? { bgUrl: BG_FID, bgOk: false } : { bgUrl: '', bgOk: false }); },
  onCupErr() { IMGCACHE.invalidate(CUP_FID); this.setData({ cupUrl: this.data.cupUrl !== CUP_FID ? CUP_FID : '' }); },

  // 空碗态：回到上一碗（分享出去答题中途退出后续上原汤）
  resumeLast() {
    const last = SOUPS.find((s) => s.id === wx.getStorageSync('soupLastId'));
    if (last) this._show(last);
  },

  _show(soup, isGuest = false, revealed = false) {
    this.setData({
      soup,
      isGuest,
      revealed,
      served: true,
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
