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
          fail: (e) => { wx.hideLoading(); wx.showToast({ title: '生成失败:' + ((e && e.errMsg) || ''), icon: 'none' }); },
        });
      } catch (e) { wx.hideLoading(); wx.showToast({ title: '生成失败:' + ((e && e.message) || ''), icon: 'none' }); }
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
    // 钳制缩放：避免长信在高分屏上超过 ~4096px 画布上限导致生成失败
    let scale = dpr;
    scale = Math.min(scale, 4000 / W, 4000 / H);
    if (scale < 1) scale = 1;
    canvas.width = Math.round(W * scale); canvas.height = Math.round(H * scale);
    ctx.scale(scale, scale);
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

  // 主持人：下载张涛的诊断报告单（图片）
  saveReportImg() {
    wx.showLoading({ title: '生成中', mask: true });
    wx.createSelectorQuery().select('#reportCanvas').fields({ node: true }).exec((res) => {
      const node = res && res[0] && res[0].node;
      if (!node) { wx.hideLoading(); return wx.showToast({ title: '生成失败', icon: 'none' }); }
      try {
        this._drawReport(node);
        wx.canvasToTempFilePath({
          canvas: node,
          success: (r) => { wx.hideLoading(); this._saveFile(r.tempFilePath); },
          fail: (e) => { wx.hideLoading(); wx.showToast({ title: '生成失败:' + ((e && e.errMsg) || ''), icon: 'none' }); },
        });
      } catch (e) { wx.hideLoading(); wx.showToast({ title: '生成失败:' + ((e && e.message) || ''), icon: 'none' }); }
    });
  },

  // 中文逐字折行，返回下一行 y
  _wrapText(ctx, text, x, y, maxW, lineH) {
    let cur = '';
    for (const ch of text) {
      if (ctx.measureText(cur + ch).width > maxW && cur) { ctx.fillText(cur, x, y); y += lineH; cur = ch; }
      else cur += ch;
    }
    if (cur) { ctx.fillText(cur, x, y); y += lineH; }
    return y;
  },

  // 画一张做旧的诊断证明书（关键字永远清晰）
  _drawReport(canvas) {
    const ctx = canvas.getContext('2d');
    const dpr = (wx.getSystemInfoSync().pixelRatio) || 2;
    const W = 720, H = 880;
    let scale = Math.min(dpr, 4000 / W, 4000 / H); if (scale < 1) scale = 1;
    canvas.width = Math.round(W * scale); canvas.height = Math.round(H * scale);
    ctx.scale(scale, scale);
    // 纸白 + 边框
    ctx.fillStyle = '#fbfaf6'; ctx.fillRect(0, 0, W, H);
    ctx.strokeStyle = '#c9c2b2'; ctx.lineWidth = 2; ctx.strokeRect(30, 30, W - 60, H - 60);
    // 医院名 + 标题
    ctx.textAlign = 'center'; ctx.fillStyle = '#2b3a4a'; ctx.font = 'bold 30px sans-serif';
    ctx.fillText('仁济市第一人民医院', W / 2, 92);
    ctx.fillStyle = '#1a1a1a'; ctx.font = 'bold 44px sans-serif';
    ctx.fillText('诊 断 证 明 书', W / 2, 156);
    ctx.strokeStyle = '#2b3a4a'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(60, 178); ctx.lineTo(W - 60, 178); ctx.stroke();
    // 基本信息
    ctx.textAlign = 'left'; ctx.fillStyle = '#222'; ctx.font = '26px sans-serif';
    ctx.fillText('姓名：张涛', 70, 236); ctx.fillText('性别：男', 360, 236); ctx.fillText('年龄：54', 540, 236);
    ctx.fillText('门诊号：2024-0631', 70, 288); ctx.fillText('科别：肿瘤科', 380, 288);
    // 临床诊断（加重红字）
    ctx.font = 'bold 32px sans-serif'; ctx.fillStyle = '#a11';
    ctx.fillText('临床诊断：胃癌（晚期）', 70, 352);
    // 检查所见 / 诊断意见（折行）
    ctx.font = '25px sans-serif'; ctx.fillStyle = '#222';
    let y = this._wrapText(ctx, '检查所见：胃窦部见溃疡型肿物，病理活检为低分化腺癌，伴周围淋巴结肿大及肝内多发转移灶。', 70, 408, W - 140, 42);
    y = this._wrapText(ctx, '诊断意见：胃低分化腺癌 IV 期，已发生远处转移，预后差，建议姑息支持治疗、定期复查。', 70, y + 14, W - 140, 42);
    // 日期 / 医师
    ctx.fillText('报告日期：二〇二四年（案发前不久）', 70, y + 40);
    ctx.fillText('主治医师：（签名）', 70, y + 84);
    // 红章
    ctx.save();
    ctx.strokeStyle = 'rgba(190,30,30,0.7)'; ctx.lineWidth = 4;
    ctx.beginPath(); ctx.arc(560, y + 110, 72, 0, Math.PI * 2); ctx.stroke();
    ctx.fillStyle = 'rgba(190,30,30,0.7)'; ctx.textAlign = 'center'; ctx.font = 'bold 22px sans-serif';
    ctx.fillText('仁济市第一', 560, y + 102); ctx.fillText('人民医院', 560, y + 130);
    ctx.restore();
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
