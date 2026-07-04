// 数字炸弹 · 抽数器：主持人点一下暗抽 1~100 的炸弹数，可存成带时间戳+防伪码的图片留证
const IMGCACHE = require('../../utils/imgCache.js');

// 页面素材（云存储 games/）：氛围底图 / 炸弹立绘 / 留证卡底
const GBASE = 'cloud://cloud1-d6g6wknyy4d198022.636c-cloud1-d6g6wknyy4d198022-1446823337/games';
const BG_FID = GBASE + '/bomb_bg.jpg';
const HERO_FID = GBASE + '/bomb_hero.png';
const PROOF_FID = GBASE + '/bomb_proof.jpg';

Page({
  data: {
    num: 0,          // 0 = 还没抽（显示 ?）
    ts: '',          // 生成时刻（图片上也印这个）
    code: '',        // 防伪码：由数字+时刻推算，改数字就对不上
    saving: false,
    bgUrl: '', bgOk: false,   // 氛围底图（云端，淡入）
    heroUrl: '',              // 炸弹立绘（没到位前显示 💣）
  },

  onLoad() {
    IMGCACHE.resolve([BG_FID, HERO_FID], (map) => {
      const d = {};
      if (map[BG_FID] && map[BG_FID] !== this.data.bgUrl) d.bgUrl = map[BG_FID];
      if (map[HERO_FID] && map[HERO_FID] !== this.data.heroUrl) d.heroUrl = map[HERO_FID];
      if (Object.keys(d).length) this.setData(d);
    });
  },
  onBgLoad() { this.setData({ bgOk: true }); },
  // 缓存坏了退回 cloud:// 原地址；再失败就隐藏（纯色底兜底）
  onBgErr() { IMGCACHE.invalidate(BG_FID); this.setData(this.data.bgUrl !== BG_FID ? { bgUrl: BG_FID, bgOk: false } : { bgUrl: '', bgOk: false }); },
  onHeroErr() { IMGCACHE.invalidate(HERO_FID); this.setData({ heroUrl: this.data.heroUrl !== HERO_FID ? HERO_FID : '' }); },

  // 防伪码：数字与时间戳绑定的校验串（改图上任意一处就对不上）
  _makeCode(num, tsMs) {
    let h = tsMs % 1000000007;
    h = (h * 131 + num * 7919) % 1000000007;
    h = (h * 131 + 88888883) % 1000000007;
    return h.toString(36).toUpperCase().padStart(7, '0');
  },

  _fmt(d) {
    const p = (n) => (n < 10 ? '0' + n : '' + n);
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
  },

  gen() {
    if (this.data.booming) return;
    this.setData({ booming: true, num: 0 });   // 先点火爆炸，数字清空
    setTimeout(() => {
      wx.vibrateLong();   // 长震兼容性最好；确认有震感后可换回 vibrateShort
      const num = 1 + Math.floor(Math.random() * 100);
      const now = new Date();
      this.setData({ booming: false, num, ts: this._fmt(now), code: this._makeCode(num, now.getTime()) });
    }, 620);
  },

  // 生成留证图片并保存到相册
  async save() {
    if (!this.data.num || this.data.saving) return;
    this.setData({ saving: true });
    wx.showLoading({ title: '生成图片中', mask: true });
    try {
      const filePath = await this._draw();
      await new Promise((resolve, reject) => {
        wx.saveImageToPhotosAlbum({
          filePath,
          success: resolve,
          fail: (e) => {
            // 用户拒绝过授权 → 引导去设置页打开
            if (e.errMsg && e.errMsg.indexOf('auth') > -1) {
              wx.showModal({
                title: '需要相册权限',
                content: '请在设置中允许保存到相册',
                confirmText: '去设置',
                success: (r) => { if (r.confirm) wx.openSetting(); },
              });
            }
            reject(e);
          },
        });
      });
      wx.hideLoading();
      wx.showToast({ title: '已保存到相册', icon: 'success' });
    } catch (e) {
      wx.hideLoading();
      if (!(e.errMsg && e.errMsg.indexOf('auth') > -1)) {
        wx.showToast({ title: '保存失败，请重试', icon: 'none' });
      }
    }
    this.setData({ saving: false });
  },

  // 证书底图：云端取（本地缓存优先）；失败返回 null 走纯色兜底
  _loadProofImg(canvas) {
    if (this._proofImg) return Promise.resolve(this._proofImg);
    return new Promise((resolve, reject) => {
      let settled = false;
      const ok = (img) => { if (!settled) { settled = true; this._proofImg = img; resolve(img); } };
      const bad = (e) => { if (!settled) { settled = true; reject(e); } };
      IMGCACHE.resolve([PROOF_FID], (map) => {
        const src = map[PROOF_FID];
        if (!src) return;
        const draw = (path) => {
          const img = canvas.createImage();
          img.onload = () => ok(img);
          img.onerror = bad;
          img.src = path;
        };
        if (src.indexOf('http') === 0) {
          wx.downloadFile({
            url: src,
            success: (r) => (r.statusCode === 200 ? draw(r.tempFilePath) : bad(new Error('dl ' + r.statusCode))),
            fail: bad,
          });
        } else draw(src);
      });
      setTimeout(() => bad(new Error('proof img timeout')), 6000);
    });
  },

  // 画留证卡：证书底图 + 大数字 + 时间戳 + 防伪码 + 满版斜向水印（PS 单处必露馅）
  _draw() {
    const W = 900, H = 1200;
    return new Promise((resolve, reject) => {
      wx.createSelectorQuery()
        .in(this)
        .select('#proof')
        .fields({ node: true })
        .exec(async (res) => {
          try {
            const canvas = res[0].node;
            const ctx = canvas.getContext('2d');
            canvas.width = W;
            canvas.height = H;

            const { num, ts, code } = this.data;
            const mark = `💣${num} · ${ts} · ${code}`;

            // 底：金边证书卡（云端图）；拿不到退回深紫渐变
            const proof = await this._loadProofImg(canvas).catch((e) => { console.error('留证底图加载失败,用纯色兜底:', e); return null; });
            if (proof) {
              ctx.drawImage(proof, 0, 0, W, H);
            } else {
              const bg = ctx.createLinearGradient(0, 0, W, H);
              bg.addColorStop(0, '#241a3e');
              bg.addColorStop(0.55, '#1c1631');
              bg.addColorStop(1, '#2b1a3a');
              ctx.fillStyle = bg;
              ctx.fillRect(0, 0, W, H);
            }

            // 满版斜向水印：内容含数字+时刻+防伪码，改哪一处都会和水印对不上
            ctx.save();
            ctx.translate(W / 2, H / 2);
            ctx.rotate(-Math.PI / 7);
            ctx.fillStyle = 'rgba(255,255,255,0.05)';
            ctx.font = '28px sans-serif';
            ctx.textAlign = 'center';
            for (let y = -H; y < H; y += 96) ctx.fillText(mark, 0, y, W * 1.6);
            ctx.restore();

            // 标题（蜡封徽章下方）
            ctx.textAlign = 'center';
            ctx.fillStyle = '#ffd98a';
            ctx.font = '900 52px sans-serif';
            ctx.fillText('数字炸弹 · 本局炸弹数', W / 2, 430);

            // 大数字
            const ng = ctx.createLinearGradient(0, 480, 0, 780);
            ng.addColorStop(0, '#ffffff');
            ng.addColorStop(1, '#ffce54');
            ctx.fillStyle = ng;
            ctx.font = '900 300px sans-serif';
            ctx.fillText(String(num), W / 2, 760);

            // 范围说明
            ctx.fillStyle = 'rgba(255,255,255,0.6)';
            ctx.font = '30px sans-serif';
            ctx.fillText('范围 1 ~ 100 · 报中此数者爆炸 💥', W / 2, 850);

            // 时间戳 + 防伪码
            ctx.fillStyle = 'rgba(255,255,255,0.88)';
            ctx.font = '34px sans-serif';
            ctx.fillText(`生成时刻  ${ts}`, W / 2, 950);
            ctx.fillStyle = '#8be0c9';
            ctx.font = '700 34px monospace';
            ctx.fillText(`防伪码  ${code}`, W / 2, 1010);

            ctx.fillStyle = 'rgba(255,255,255,0.4)';
            ctx.font = '24px sans-serif';
            ctx.fillText('群本杀 · 数字炸弹抽数凭证', W / 2, 1085);

            wx.canvasToTempFilePath({
              canvas,
              success: (r) => resolve(r.tempFilePath),
              fail: reject,
            });
          } catch (e) {
            reject(e);
          }
        });
    });
  },

  onShareAppMessage() {
    return { title: '数字炸弹 💣 谁猜中谁爆炸！', path: '/pages/bomb/bomb' };
  },
});
