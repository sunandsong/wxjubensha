const app = getApp();
const db = wx.cloud.database();
const SCRIPTS = require('../../utils/scripts.js');

Page({
  data: {
    roomId: '',
    roomCode: '',
    openid: '',
    testTag: '',
    status: 'playing',
    actIndex: 0,
    actNum: 1,
    actTotal: 1,
    actTitle: '',
    actLabel: '',
    actNarration: '',
    worldview: '',
    relations: [],
    actHostPrompts: [],
    actHostStory: '',
    actHostActivities: [],
    isLastAct: false,
    isHost: false,
    script: null,
    myChar: null,       // 我的角色对象
    myActStory: '',     // 我这一幕的私密剧情
    roster: [],         // 全部角色公开名册（含是否NPC）
    autoClues: false,   // 是否随幕自动公开线索（咖啡馆用，关闭搜证）
    clues: [],          // 自动公开模式下已公开的线索
    spots: [],          // 当前幕的搜查点
    myClues: [],        // 我亲自搜到的线索（跨幕累积，仅我可见）
    searchLimit: 1,     // 每幕搜证次数上限
    searchLeft: 1,      // 本幕剩余搜证次数
    myVote: '',
    votedCount: 0,
    totalPlayers: 0,
  },

  watcher: null,

  onLoad(query) {
    this.setData({ roomId: query.roomId, roomCode: query.roomCode });
    app.saveSession({ roomId: query.roomId, roomCode: query.roomCode });
  },

  async onShow() {
    this.setData({ testTag: app.getTestUid() ? wx.getStorageSync('nick') : '' });
    try {
      this.setData({ openid: await app.ensureLogin() });
    } catch (e) {}
    // 每次进入都重新请求最新数据（不依赖缓存），带 Loading
    wx.showLoading({ title: '加载中', mask: true });
    try {
      // 用 where 查询：房间不存在时返回空数组（不会 reject）
      const res = await db.collection('rooms').where({ _id: this.data.roomId }).get();
      const room = res.data[0] || null;
      if (room) this.render(room);
      else { wx.hideLoading(); return this.onDissolved(); }   // 房间已解散 → 退出
    } catch (e) {
      wx.showToast({ title: '加载失败，请重试', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
    this.startWatch();
  },

  onHide() { this.closeWatch(); },

  // 主持人：复制文字（提示/问题/线索）到剪贴板，粘到群里
  copyText(e) {
    const text = e.currentTarget.dataset.text || '';
    if (!text) return;
    wx.setClipboardData({ data: text, success: () => wx.showToast({ title: '已复制', icon: 'success' }) });
  },

  // 主持人：把线索/角色图片保存到相册，再发到群里
  saveImg(e) {
    const src = e.currentTarget.dataset.src;
    if (!src) return;
    wx.showLoading({ title: '保存中', mask: true });
    wx.getImageInfo({
      src,
      success: (res) => this._saveToAlbum(res.path),
      fail: () => { wx.hideLoading(); wx.showToast({ title: '图片加载失败', icon: 'none' }); },
    });
  },

  // 保存到相册（含权限引导），各处复用
  _saveToAlbum(filePath) {
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

  // 主持人：生成「现场平面图」并保存到相册，发群讨论
  saveMap() {
    wx.showLoading({ title: '生成中', mask: true });
    wx.createSelectorQuery().select('#mapCanvas').fields({ node: true }).exec((res) => {
      const node = res && res[0] && res[0].node;
      if (!node) { wx.hideLoading(); return wx.showToast({ title: '生成失败', icon: 'none' }); }
      try {
        this._drawMap(node);
        wx.canvasToTempFilePath({
          canvas: node,
          success: (r) => this._saveToAlbum(r.tempFilePath),
          fail: () => { wx.hideLoading(); wx.showToast({ title: '生成失败', icon: 'none' }); },
        });
      } catch (e) { wx.hideLoading(); wx.showToast({ title: '生成失败', icon: 'none' }); }
    });
  },

  // 画 930咖啡馆 现场平面图（中文标签永远清晰）
  _drawMap(canvas) {
    const ctx = canvas.getContext('2d');
    const dpr = (wx.getSystemInfoSync().pixelRatio) || 2;
    const W = 720, H = 800;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.scale(dpr, dpr);
    // 纸底
    ctx.fillStyle = '#f5efe2'; ctx.fillRect(0, 0, W, H);
    // 标题
    ctx.textAlign = 'center';
    ctx.fillStyle = '#3b2c16'; ctx.font = 'bold 38px sans-serif';
    ctx.fillText('930咖啡馆 · 现场平面图', W / 2, 58);
    ctx.fillStyle = '#7a6a4a'; ctx.font = '22px sans-serif';
    ctx.fillText('讨论用：你坐哪 · 去过哪 · 案发时在哪', W / 2, 92);
    // 画房间小工具
    const room = (x, y, w, h, label, sub, fill) => {
      ctx.fillStyle = fill || '#fff8ec';
      ctx.strokeStyle = '#b89a6a'; ctx.lineWidth = 3;
      ctx.fillRect(x, y, w, h); ctx.strokeRect(x, y, w, h);
      ctx.textAlign = 'center'; ctx.fillStyle = '#3b2c16';
      ctx.font = 'bold 30px sans-serif';
      ctx.fillText(label, x + w / 2, y + h / 2 + (sub ? -8 : 10));
      if (sub) { ctx.font = '21px sans-serif'; ctx.fillStyle = '#9a5a28'; ctx.fillText(sub, x + w / 2, y + h / 2 + 26); }
    };
    // 外框，右墙开一个口当入口
    ctx.strokeStyle = '#8a6a3a'; ctx.lineWidth = 5;
    ctx.strokeRect(40, 120, 640, 660);           // 40..680 / 120..780
    ctx.fillStyle = '#f5efe2'; ctx.fillRect(672, 490, 16, 56);  // 右墙门口开口
    // 顶部：后厨 / 厕所
    room(60, 150, 280, 140, '后　厨', '');
    room(380, 150, 280, 140, '厕　所', '');
    // 吧台（案发现场客观事实，不标人物）
    ctx.fillStyle = '#fbe4c8'; ctx.strokeStyle = '#b89a6a'; ctx.lineWidth = 3;
    ctx.fillRect(60, 320, 580, 140); ctx.strokeRect(60, 320, 580, 140);
    ctx.textAlign = 'center'; ctx.fillStyle = '#3b2c16'; ctx.font = 'bold 30px sans-serif';
    ctx.fillText('吧　台', 350, 376);
    ctx.font = '21px sans-serif'; ctx.fillStyle = '#9a5a28';
    ctx.fillText('☕ 杯子在台上　☠ 老板倒在台后', 350, 414);
    // 过道：座位区标题（左）+ 入口（右·吧台与座位区之间）
    ctx.textAlign = 'left'; ctx.fillStyle = '#3b2c16'; ctx.font = 'bold 26px sans-serif';
    ctx.fillText('座位区（你坐哪？）', 60, 515);
    room(450, 488, 190, 64, '入　口', '（右侧进门）', '#e9e0cf');
    // 座位区：桌1~4
    room(60, 565, 130, 110, '桌 1', '');
    room(210, 565, 130, 110, '桌 2', '');
    room(360, 565, 130, 110, '桌 3', '');
    room(510, 565, 130, 110, '桌 4', '');
    // 座位区下方：临窗一长条
    ctx.fillStyle = '#e8f0ff'; ctx.strokeStyle = '#b89a6a'; ctx.lineWidth = 3;
    ctx.fillRect(60, 690, 580, 56); ctx.strokeRect(60, 690, 580, 56);
    ctx.textAlign = 'center'; ctx.fillStyle = '#3b2c16'; ctx.font = 'bold 26px sans-serif';
    ctx.fillText('窗（座位区临窗）', 350, 726);
  },

  gotoTest() { this.closeWatch(); wx.reLaunch({ url: '/pages/test/test' }); },


  // 玩家搜查某个地点（地点不一定有线索）
  async search(e) {
    const spotId = e.currentTarget.dataset.id;
    if (this.data.searchLeft <= 0) return wx.showToast({ title: '本幕搜证次数已用完', icon: 'none' });
    const ok = await this.confirm('确定搜查这里吗？本幕搜证次数有限、未必有发现，搜到的线索只有你自己能看到。');
    if (!ok) return;
    let res;
    try {
      res = await app.runOnce('search', () => app.callGame({ action: 'search', roomId: this.data.roomId, spotId }), '搜查中');
    } catch (err) {
      return wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    }
    if (res && res.result && !res.result.ok) wx.showToast({ title: res.result.msg || '搜证失败', icon: 'none' });
  },

  startWatch() {
    if (this.watcher) return;
    this.watcher = db.collection('rooms').doc(this.data.roomId).watch({
      onChange: (snap) => {
        const room = snap.docs && snap.docs[0];
        if (!room) { this.onDissolved(); return; } // 主持人结束了游戏
        this.render(room);
      },
      onError: (e) => console.error(e),
    });
  },

  closeWatch() {
    if (this.watcher) { this.watcher.close(); this.watcher = null; }
  },

  render(room) {
    this.lastRoom = room;   // 记住最近一次完整房间数据，供推进后即时渲染
    const SCRIPT = SCRIPTS.byId(room.scriptId);
    const openid = this.data.openid;
    const players = room.players || [];
    const me = players.find((p) => p.openid === openid);
    const srcChar = me && me.charId ? SCRIPT.characters.find((c) => c.id === me.charId) : null;

    // 名字替换：剧本里的角色名统一换成玩家昵称（NPC 保留原名）
    const namer = SCRIPTS.makeNamer(SCRIPT, players);
    const ap = (s) => namer.apply(s);
    const apList = (arr) => (arr || []).map(ap);

    const acts = SCRIPT.acts || [];
    const actIndex = Math.min(room.actIndex || 0, Math.max(0, acts.length - 1));
    const act = acts[actIndex] || null;
    const actHost = act && act.host ? act.host : null;  // 主持人专属：小说式剧情 + 群活动
    const isLastAct = actIndex >= acts.length - 1;
    const myActStory = ap(srcChar && srcChar.actStories ? (srcChar.actStories[actIndex] || '') : '');

    // 我的角色卡：名字用昵称，正文里的角色名也一并替换
    const myChar = srcChar ? {
      id: srcChar.id, title: srcChar.title, gender: srcChar.gender,
      name: namer.name(srcChar.id),
      persona: ap(srcChar.persona),
      timeline: apList(srcChar.timeline),
      objective: ap(srcChar.objective),
      secret: ap(srcChar.secret),
    } : null;

    // 公开名册：所有角色，名字用昵称，标注是否为「公开嫌疑人」(NPC)
    const roster = SCRIPT.characters.map((c) => {
      const owner = players.find((p) => p.charId === c.id);
      return {
        id: c.id, name: namer.name(c.id), title: c.title, gender: c.gender,
        isNpc: !owner,
        avatar: owner ? owner.avatar : '',
        isMe: owner && owner.openid === openid,
      };
    });

    const isHost = room.hostOpenid === openid;
    const findClue = (id) => SCRIPT.clues.find((c) => c.id === id);
    const autoClues = !!SCRIPT.autoClues;

    // ── 线索：autoClues=随幕自动公开（公开）；否则=限次搜证 ──
    let clues = [];                 // 自动公开模式：累积到当前幕的公开线索
    let spots = [], myClues = [], searchLimit = 0, searchLeft = 0;
    if (autoClues) {
      // 只展示当前这一幕的新线索（主持人逐幕发群，不重复旧线索）
      clues = ((act && act.clueIds) || []).map(findClue).filter(Boolean)
        .map((c) => ({ id: c.id, name: c.name, icon: c.icon, text: ap(c.text), img: c.img || '' }));
    } else {
      const searches = room.searches || {};
      const mySearch = searches[openid] || [];
      searchLimit = SCRIPT.searchPerAct || 1;
      const spotsOfAct = (a) => a
        ? (a.spots || (a.clueIds || []).map((id, i) => ({ id, clueId: id, place: (findClue(id) || {}).place || ('搜查点' + (i + 1)) })))
        : [];
      const curSpots = spotsOfAct(act);
      spots = curSpots.map((sp) => {
        const c = sp.clueId ? (findClue(sp.clueId) || null) : null;
        const mineFound = mySearch.includes(sp.id);
        const reveal = mineFound || isHost;
        const searchers = players
          .filter((p) => p.openid !== room.hostOpenid && (searches[p.openid] || []).includes(sp.id))
          .map((p) => p.nick);
        return {
          id: sp.id, place: sp.place || '某处',
          icon: c ? (c.icon || '🔍') : '🔍', empty: !c, mineFound, reveal,
          name: reveal ? (c ? c.name : '一无所获') : '',
          text: reveal ? (c ? ap(c.text) : '这里没找到有用的东西。') : '',
          searchedCount: searchers.length, searchedBy: searchers.join('、'),
        };
      });
      const usedThisAct = curSpots.map((sp) => sp.id).filter((id) => mySearch.includes(id)).length;
      searchLeft = Math.max(0, searchLimit - usedThisAct);
      const spotToClue = {};
      acts.forEach((a) => spotsOfAct(a).forEach((sp) => { if (sp.clueId) spotToClue[sp.id] = sp.clueId; }));
      myClues = mySearch.map((sid) => (spotToClue[sid] ? findClue(spotToClue[sid]) : null))
        .filter(Boolean)
        .map((c) => ({ id: c.id, name: c.name, icon: c.icon, place: c.place || '', text: ap(c.text) }));
    }


    // 我的角色照片：按我自己选的性别取（玩家第一幕展示）
    const myGenderRaw = (me && me.gender) || wx.getStorageSync('gender') || '';
    const myGender = myGenderRaw === 'f' ? 'f' : (myGenderRaw === 'm' ? 'm' : '');
    const myPhoto = (srcChar && myGender) ? `/assets/avatars/${srcChar.id}_${myGender}.jpg` : '';

    const votes = room.votes || {};
    const myVote = votes[openid] || '';

    // 兼容旧房间：除 voting/finished 外的状态都按「逐幕剧情」渲染
    const status = (room.status === 'voting' || room.status === 'finished') ? room.status : 'playing';

    this.setData({
      status,
      actIndex,
      actNum: actIndex + 1,
      actLabel: '第' + (['一', '二', '三', '四', '五', '六', '七', '八'][actIndex] || actIndex + 1) + '幕',
      actTotal: acts.length,
      actTitle: act ? act.title : '',
      actNarration: ap(act ? act.narration : ''),
      worldview: ap(SCRIPT.worldview || ''),
      relations: apList(SCRIPT.relations),
      actHostPrompts: apList(act && act.hostPrompts ? act.hostPrompts : []),
      // 主持人剧情：每幕一整块故事（第一幕的故事本身已含世界观背景，不再拼接）
      actHostStory: ap(actHost ? actHost.story : ''),
      actHostActivities: apList(actHost ? actHost.activities : []),
      isLastAct,
      isHost,
      myPhoto,
      script: SCRIPT,
      myChar,
      myActStory,
      roster,
      autoClues,
      clues,
      spots,
      myClues,
      searchLimit,
      searchLeft,
      myVote,
      votedCount: Object.keys(votes).length,
      totalPlayers: players.filter((p) => p.openid !== room.hostOpenid).length,
    });

    if (room.status === 'finished') {
      this.closeWatch();
      wx.redirectTo({ url: `/pages/result/result?roomId=${this.data.roomId}&roomCode=${this.data.roomCode}` });
    }
  },

  onDissolved() {
    this.closeWatch();
    app.clearSession();
    wx.showModal({ title: '提示', content: '主持人已结束游戏', showCancel: false, success: () => wx.reLaunch({ url: '/pages/index/index' }) });
  },

  // 主持人结束游戏：解散房间，所有人退出
  async endGame() {
    const ok = await this.confirm('确定结束本局并解散房间吗？');
    if (!ok) return;
    await app.runOnce('dissolve', async () => {
      this.closeWatch();
      app.clearSession();
      await app.callGame({ action: 'dissolve', roomId: this.data.roomId }).catch(() => {});
      wx.reLaunch({ url: '/pages/index/index' });
    }, '结束中');
  },

  async vote(e) {
    const charId = e.currentTarget.dataset.id;
    let res;
    try {
      res = await app.runOnce('vote', () => app.callGame({ action: 'vote', roomId: this.data.roomId, charId }), '');
    } catch (err) {
      return wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    }
    if (!res) return; // 被防抖忽略
    if (res.result && !res.result.ok) return wx.showToast({ title: res.result.msg || '投票失败', icon: 'none' });
    wx.showToast({ title: '已投票', icon: 'success' });
  },

  // 主持人推进：下一幕 / 进入投票 / 公布真相
  async advance() {
    if (this.data.status === 'voting') {
      const ok = await this.confirm('确定公布真相？投票将结束。');
      if (!ok) return;
    }
    let res;
    try {
      res = await app.runOnce('advance', () => app.callGame({ action: 'advance', roomId: this.data.roomId }), '推进中');
    } catch (err) {
      return wx.showToast({ title: '网络异常，请重试', icon: 'none' });
    }
    if (!res || !res.result) return;        // 被防抖忽略
    const r = res.result;
    if (!r.ok) return wx.showToast({ title: r.msg || '推进失败', icon: 'none' });
    // 即时渲染新一幕，不等实时推送（watch 稍后会再同步一次，幂等）
    if (this.lastRoom && typeof r.actIndex !== 'undefined') {
      this.render({ ...this.lastRoom, actIndex: r.actIndex, status: r.status });
    }
  },

  confirm(content) {
    return new Promise((resolve) => {
      wx.showModal({ title: '提示', content, success: (r) => resolve(r.confirm) });
    });
  },

  onUnload() { this.closeWatch(); },
});
