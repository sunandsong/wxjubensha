// 数字炸弹 · 抽数器：主持人点一下暗抽 1~100 的炸弹数，可存成带时间戳+防伪码的图片留证
Page({
  data: {
    num: 0,          // 0 = 还没抽（显示 ?）
    ts: '',          // 生成时刻（图片上也印这个）
    code: '',        // 防伪码：由数字+时刻推算，改数字就对不上
    saving: false,
  },

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

  // 画留证卡：深色底 + 大数字 + 时间戳 + 防伪码 + 满版斜向水印（PS 单处必露馅）
  _draw() {
    const W = 750, H = 1000;
    return new Promise((resolve, reject) => {
      wx.createSelectorQuery()
        .in(this)
        .select('#proof')
        .fields({ node: true })
        .exec((res) => {
          try {
            const canvas = res[0].node;
            const ctx = canvas.getContext('2d');
            canvas.width = W;
            canvas.height = H;

            const { num, ts, code } = this.data;
            const mark = `💣${num} · ${ts} · ${code}`;

            // 底：深紫渐变
            const bg = ctx.createLinearGradient(0, 0, W, H);
            bg.addColorStop(0, '#241a3e');
            bg.addColorStop(0.55, '#1c1631');
            bg.addColorStop(1, '#2b1a3a');
            ctx.fillStyle = bg;
            ctx.fillRect(0, 0, W, H);

            // 满版斜向水印：内容含数字+时刻+防伪码，改哪一处都会和水印对不上
            ctx.save();
            ctx.translate(W / 2, H / 2);
            ctx.rotate(-Math.PI / 7);
            ctx.fillStyle = 'rgba(255,255,255,0.055)';
            ctx.font = '26px sans-serif';
            ctx.textAlign = 'center';
            for (let y = -H; y < H; y += 86) {
              ctx.fillText(mark, 0, y, W * 1.6);
            }
            ctx.restore();

            // 标题
            ctx.textAlign = 'center';
            ctx.fillStyle = '#ffce54';
            ctx.font = '900 56px sans-serif';
            ctx.fillText('数字炸弹 · 本局炸弹数', W / 2, 150);

            // 大数字
            const ng = ctx.createLinearGradient(0, 320, 0, 620);
            ng.addColorStop(0, '#ffffff');
            ng.addColorStop(1, '#ffce54');
            ctx.fillStyle = ng;
            ctx.font = '900 300px sans-serif';
            ctx.fillText(String(num), W / 2, 560);

            // 范围说明
            ctx.fillStyle = 'rgba(255,255,255,0.55)';
            ctx.font = '30px sans-serif';
            ctx.fillText('范围 1 ~ 100 · 报中此数者爆炸 💥', W / 2, 660);

            // 时间戳 + 防伪码
            ctx.fillStyle = 'rgba(255,255,255,0.85)';
            ctx.font = '34px sans-serif';
            ctx.fillText(`生成时刻  ${ts}`, W / 2, 790);
            ctx.fillStyle = '#8be0c9';
            ctx.font = '700 34px monospace';
            ctx.fillText(`防伪码  ${code}`, W / 2, 850);

            ctx.fillStyle = 'rgba(255,255,255,0.35)';
            ctx.font = '24px sans-serif';
            ctx.fillText('群本杀 · 数字炸弹抽数凭证', W / 2, 940);

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
