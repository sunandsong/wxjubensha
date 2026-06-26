const app = getApp();
const db = wx.cloud.database();
const SCRIPTS = require('../../utils/scripts.js');

Page({
  data: {
    roomId: '',
    roomCode: '',
    openid: '',
    isHost: false,
    truth: null,
    letter: '',         // 遗书：仅主持人可见，发到群里
    letterImg: '',      // 遗书图片（可选，留给 AI 生成的信件图）
    murdererName: '',
    tally: [],          // [{name, count, isMurderer}]
    accusedName: '',    // 得票最多者
    caught: false,      // 群众是否抓对凶手
    myResult: '',       // 我赢了 / 我输了
  },

  watcher: null,

  onLoad(query) {
    this.setData({ roomId: query.roomId, roomCode: query.roomCode });
    app.saveSession({ roomId: query.roomId, roomCode: query.roomCode });
  },

  // 每次进入都重新请求最新数据（不依赖缓存）
  async onShow() {
    this.setData({ testTag: app.getTestUid() ? wx.getStorageSync('nick') : '' });
    try {
      this.setData({ openid: await app.ensureLogin() });
    } catch (e) {}
    await this.load();
    this.watchReset();
  },
  onHide() { this.closeWatch(); },

  // 主持人：把这封信下载成图片（发到群里）
  // 有现成信图(letterImg)就直接存；否则把信文渲染成一张信纸图片
  saveLetterImg() {
    if (this.data.letterImg) return this._saveSrc(this.data.letterImg);
    const text = this.data.letter;
    if (!text) return;
    wx.showLoading({ title: '生成中', mask: true });
    wx.createSelectorQuery().select('#letterCanvas').fields({ node: true }).exec((res) => {
      const node = res && res[0] && res[0].node;
      if (!node) { wx.hideLoading(); return wx.showToast({ title: '生成失败', icon: 'none' }); }
      try {
        this._drawLetter(node, text);
        wx.canvasToTempFilePath({
          canvas: node,
          success: (r) => { wx.hideLoading(); this._saveFile(r.tempFilePath); },
          fail: () => { wx.hideLoading(); wx.showToast({ title: '生成失败', icon: 'none' }); },
        });
      } catch (e) { wx.hideLoading(); wx.showToast({ title: '生成失败', icon: 'none' }); }
    });
  },

  // 把信文画到 canvas 信纸上
  _drawLetter(canvas, text) {
    const ctx = canvas.getContext('2d');
    const dpr = (wx.getSystemInfoSync().pixelRatio) || 2;
    const W = 720, padX = 56, padTop = 72, padBottom = 90;
    const fontSize = 30, lineH = 56;
    const maxW = W - padX * 2;
    const font = `${fontSize}px "Kaiti SC","STKaiti","KaiTi",serif`;
    ctx.font = font;
    // 按段落折行（中文逐字测宽）
    const lines = [];
    text.split('\n').forEach((para) => {
      if (para === '') { lines.push(''); return; }   // 段落间空行
      let cur = '';
      for (const ch of para) {
        if (ctx.measureText(cur + ch).width > maxW && cur) { lines.push(cur); cur = ch; }
        else cur += ch;
      }
      lines.push(cur);
    });
    const H = padTop + lines.length * lineH + padBottom;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.scale(dpr, dpr);
    // 背景：暖黄做旧信纸
    const g = ctx.createLinearGradient(0, 0, 0, H);
    g.addColorStop(0, '#f7eedc'); g.addColorStop(0.55, '#f1e4ca'); g.addColorStop(1, '#ecdcbe');
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // 左侧装订暗边
    ctx.fillStyle = 'rgba(150,110,55,0.18)'; ctx.fillRect(0, 0, 8, H);
    // 文字
    ctx.fillStyle = '#3b2c16';
    ctx.font = font; ctx.textBaseline = 'top';
    let y = padTop;
    lines.forEach((ln) => { if (ln) ctx.fillText(ln, padX, y); y += lineH; });
  },

  // 通过 src（已有图片）取本地路径后保存
  _saveSrc(src) {
    wx.showLoading({ title: '保存中', mask: true });
    wx.getImageInfo({
      src,
      success: (res) => this._saveFile(res.path),
      fail: () => { wx.hideLoading(); wx.showToast({ title: '图片加载失败', icon: 'none' }); },
    });
  },

  // 保存到相册（含权限引导）
  _saveFile(filePath) {
    wx.saveImageToPhotosAlbum({
      filePath,
      success: () => { wx.hideLoading(); wx.showToast({ title: '已存到相册', icon: 'success' }); },
      fail: (err) => {
        wx.hideLoading();
        const m = String((err && err.errMsg) || '');
        if (m.indexOf('auth') >= 0 || m.indexOf('deny') >= 0) {
          wx.showModal({ title: '需要相册权限', content: '请在设置里允许保存到相册', confirmText: '去设置', success: (r) => { if (r.confirm) wx.openSetting(); } });
        } else if (m.indexOf('cancel') < 0) {
          wx.showToast({ title: '保存失败', icon: 'none' });
        }
      },
    });
  },

  async load() {
    wx.showLoading({ title: '加载中', mask: true });
    let room;
    try {
      // 用 where 查询：房间不存在时返回空数组（不会 reject）
      const res = await db.collection('rooms').where({ _id: this.data.roomId }).get();
      room = res.data[0] || null;
    } catch (e) {
      wx.hideLoading();
      return wx.showToast({ title: '加载失败，请重试', icon: 'none' });
    }
    wx.hideLoading();
    if (!room) {                          // 房主已结束游戏、房间解散 → 退出
      this.closeWatch();
      app.clearSession();
      wx.showModal({ title: '提示', content: '主持人已结束游戏', showCancel: false, success: () => wx.reLaunch({ url: '/pages/index/index' }) });
      return;
    }
    const SCRIPT = SCRIPTS.byId(room.scriptId);
    const players = room.players || [];
    const votes = room.votes || {};
    const murderer = SCRIPT.truth.murderer;

    // 名字替换：角色名统一换成玩家昵称（NPC 保留原名）
    const namer = SCRIPTS.makeNamer(SCRIPT, players);

    // 统计每个角色得票，名字用昵称
    const counts = {};
    Object.values(votes).forEach((cid) => { counts[cid] = (counts[cid] || 0) + 1; });
    const tally = SCRIPT.characters
      .map((c) => {
        const owner = players.find((p) => p.charId === c.id);
        return {
          id: c.id, name: namer.name(c.id), title: c.title,
          playerNick: owner ? '' : '公开嫌疑人',
          count: counts[c.id] || 0, isMurderer: c.id === murderer,
        };
      })
      .sort((a, b) => b.count - a.count);

    const top = tally[0];
    const accused = top && top.count > 0 ? top : null;
    const caught = accused && accused.isMurderer && tally.filter((t) => t.count === top.count).length === 1;

    // 我的胜负
    const me = players.find((p) => p.openid === this.data.openid);
    let myResult = '';
    if (room.hostOpenid === this.data.openid) {
      myResult = caught ? '主持人视角 · 玩家成功揪出真凶' : '主持人视角 · 凶手逃脱了';
    } else if (me && me.charId) {
      const iAmMurderer = me.charId === murderer;
      if (iAmMurderer) myResult = caught ? '你（凶手）被抓住了，平民阵营获胜' : '你（凶手）成功逃脱，凶手获胜！';
      else myResult = caught ? '成功揪出真凶，你所在的平民阵营获胜！' : '凶手逃脱了，平民阵营惜败';
    }

    this.setData({
      isHost: room.hostOpenid === this.data.openid,
      truth: { title: namer.apply(SCRIPT.truth.title), text: namer.apply(SCRIPT.truth.text) },
      letter: namer.apply(SCRIPT.truth.letter || ''),
      letterImg: SCRIPT.truth.letterImg || '',
      murdererName: namer.name(murderer),
      tally,
      accusedName: accused ? accused.name : '无人得票',
      caught,
      myResult,
    });
  },

  watchReset() {
    if (this.watcher) return;
    this.watcher = db.collection('rooms').doc(this.data.roomId).watch({
      onChange: (snap) => {
        const room = snap.docs && snap.docs[0];
        if (!room) {                       // 房主结束游戏、房间被解散
          this.closeWatch();
          app.clearSession();
          wx.showModal({ title: '提示', content: '主持人已结束游戏', showCancel: false, success: () => wx.reLaunch({ url: '/pages/index/index' }) });
          return;
        }
        if (room.status === 'waiting') {   // 房主点了「再来一局」
          this.closeWatch();
          wx.redirectTo({ url: `/pages/room/room?roomId=${this.data.roomId}&roomCode=${this.data.roomCode}` });
        }
      },
      onError: () => {},
    });
  },

  closeWatch() {
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
  },

  async replay() {
    let res;
    try {
      res = await app.runOnce('reset', () => app.callGame({ action: 'reset', roomId: this.data.roomId }), '重开中');
    } catch (e) {
      return wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    }
    if (res && res.result && !res.result.ok) wx.showToast({ title: res.result.msg || '重开失败', icon: 'none' });
  },

  // 房主：结束本局、解散房间，让所有玩家一起退出
  async endGame() {
    await app.runOnce('dissolve', async () => {
      this.closeWatch();
      app.clearSession();
      await app.callGame({ action: 'dissolve', roomId: this.data.roomId }).catch(() => {});
      wx.reLaunch({ url: '/pages/index/index' });
    }, '结束中');
  },

  // 玩家：自己返回首页（房间仍在，主持人可继续/解散）
  backHome() {
    app.runOnce('backHome', () => {
      this.closeWatch();
      app.clearSession();   // 回到首页 → 结束续局
      wx.reLaunch({ url: '/pages/index/index' });
    }, '');
  },

  gotoTest() { this.closeWatch(); wx.reLaunch({ url: '/pages/test/test' }); },

  onUnload() { this.closeWatch(); },
});
