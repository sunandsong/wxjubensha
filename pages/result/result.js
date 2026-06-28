const app = getApp();
const db = wx.cloud.database();
const SCRIPTS = require('../../utils/scriptStore.js');

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
    await SCRIPTS.ensureLoaded();   // 确保剧本数据（云端/缓存/兜底）就绪
    await this.load();
    this.watchReset();
  },
  onHide() { this.closeWatch(); },

  // 主持人：一键复制「投票结果 + 真相 + 那封信」文本，发到群里
  copyTruthLetter() {
    const parts = [];
    const tally = this.data.tally || [];
    if (tally.length) {
      const head = this.data.caught ? '真凶落网！' : '凶手逃脱了…';
      const lines = tally.map((t) => `${t.name}（${t.title}）${t.count}票${t.isMurderer ? ' ←真凶' : ''}`);
      parts.push('【投票结果】' + head + '\n' + lines.join('\n'));
    }
    if (this.data.truth && this.data.truth.text) parts.push('【真相】\n' + this.data.truth.text);
    if (this.data.letter) parts.push('【' + (this.data.victimName || '被害人') + '留下的那封信】\n' + this.data.letter);
    const text = parts.join('\n\n');
    if (!text) return wx.showToast({ title: '暂无内容', icon: 'none' });
    wx.setClipboardData({ data: text, success: () => wx.showToast({ title: '已复制，去群里粘贴', icon: 'none' }) });
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
      myResult = '';  // 主持人不显示胜负卡
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
      victimName: (SCRIPT.victim && SCRIPT.victim.name) || '',
      tally,
      accusedName: accused ? accused.name : '无人得票',
      caught,
      myResult,
      confetti: caught ? this._makeConfetti() : [],
    });
    if (caught) wx.vibrateShort && wx.vibrateShort({ type: 'medium' });
  },

  // 撒花碎片（抓对真凶时）
  _makeConfetti() {
    const colors = ['#ffd9a8', '#7CFFB2', '#c44dff', '#7b5cff', '#ff8a8a', '#ffb347'];
    const arr = [];
    for (let i = 0; i < 18; i++) {
      arr.push({
        i,
        left: Math.round(Math.random() * 100),
        delay: (Math.random() * 0.6).toFixed(2),
        dur: (1.8 + Math.random() * 1.0).toFixed(2),
        color: colors[i % colors.length],
      });
    }
    return arr;
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
    const ok = await new Promise((resolve) => {
      wx.showModal({
        title: '结束游戏',
        content: '真相公布了吗？结束后房间解散，所有人退出，无法再查看。',
        confirmText: '确认结束',
        cancelText: '再等等',
        success: (r) => resolve(r.confirm),
        fail: () => resolve(false),
      });
    });
    if (!ok) return;
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


  onUnload() { this.closeWatch(); },

  gotoTest() { this.closeWatch(); wx.reLaunch({ url: '/pages/test/test' }); },
});
