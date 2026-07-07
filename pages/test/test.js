const app = getApp();
const SCRIPTS = require('../../utils/scriptStore.js');
const IMGCACHE = require('../../utils/imgCache.js');
const GBASE = 'cloud://cloud1-d6g6wknyy4d198022.636c-cloud1-d6g6wknyy4d198022-1446823337/games';

Page({
  data: {
    current: '',
    options: [
      { uid: 'test-A', nick: '玩家A', gender: 'm' },
      { uid: 'test-B', nick: '玩家B', gender: 'f' },
      { uid: 'test-C', nick: '玩家C', gender: 'm' },
      { uid: 'test-D', nick: '玩家D', gender: 'f' },
      { uid: 'test-E', nick: '玩家E', gender: 'm' },
      { uid: 'test-F', nick: '玩家F', gender: 'f' },
    ],
  },

  onShow() {
    this.setData({ current: app.getTestUid() || '' });
  },

  // 通用：把包内 assets/games/up_* 上传到云存储 games/（一次性，传完可删本地图）
  async _uploadAssets(files) {
    wx.showLoading({ title: '上传中…', mask: true });
    const fs = wx.getFileSystemManager();
    let done = 0;
    for (const [local, cloudPath] of files) {
      try {
        const src = `/assets/games/${local}`;
        const dest = `${wx.env.USER_DATA_PATH}/${local}`;
        let filePath = '';
        // 包内文件在工具里 getImageInfo 可能拿不到可上传路径，优先 FS 拷贝
        try { fs.copyFileSync(src, dest); filePath = dest; }
        catch (e1) {
          try { fs.copyFileSync(src.replace(/^\//, ''), dest); filePath = dest; }
          catch (e2) {
            const info = await new Promise((res, rej) => wx.getImageInfo({ src, success: res, fail: rej }));
            filePath = info.path;
          }
        }
        await wx.cloud.uploadFile({ cloudPath, filePath });
        IMGCACHE.invalidate(GBASE + '/' + cloudPath.split('/').pop());
        done++;
      } catch (e) { console.error('✘', cloudPath, e); }
    }
    wx.hideLoading();
    wx.showModal({ title: '上传完成', content: `成功 ${done}/${files.length} 张（本地缓存已失效，重新编译生效）`, showCancel: false });
  },

  // 卧底词卡：卡背 + 卡面
  uploadSpyCards() {
    this._uploadAssets([
      ['up_spy_card.jpg', 'games/spy_card_v2.jpg'],
      ['up_spy_card_front.jpg', 'games/spy_card_front.jpg'],
    ]);
  },

  // 测试用：清空云端所有房间（含卧底词/狼人身份等秘密数据）
  async purgeRooms() {
    const ok = await new Promise((res) => wx.showModal({
      title: '清空云端房间',
      content: '将删除 rooms 和 spySecrets 里的全部数据（所有房间立即解散）。仅测试期使用，确定？',
      confirmText: '清空', confirmColor: '#e5484d',
      success: (r) => res(r.confirm), fail: () => res(false),
    }));
    if (!ok) return;
    wx.showLoading({ title: '清理中…', mask: true });
    try {
      const res = await app.callGame({ action: 'purgeRooms' });
      wx.hideLoading();
      const r = res && res.result;
      wx.showModal({ title: '清理完成', content: `删除房间 ${r.rooms} 个、秘密数据 ${r.secrets} 条`, showCancel: false });
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: '清理失败，请重试', icon: 'none' });
    }
  },

  // 狼人杀大厅立绘
  uploadWolfHero() {
    this._uploadAssets([['up_wolf_hero.png', 'games/wolf_hero.png']]);
  },

  // 狼人杀牌面素材（卡背 + 昼夜底图 + 四张角色牌）
  uploadWolfCards() {
    this._uploadAssets([
      ['up_wolf_back.jpg', 'games/wolf_back.jpg'],
      ['up_wolf_bg_n.jpg', 'games/wolf_bg_n.jpg'],
      ['up_wolf_bg_d.jpg', 'games/wolf_bg_d.jpg'],
      ['up_wolf_r3_wolf.jpg', 'games/wolf_r3_wolf.jpg'],
      ['up_wolf_r3_seer.jpg', 'games/wolf_r3_seer.jpg'],
      ['up_wolf_r3_witch.jpg', 'games/wolf_r3_witch.jpg'],
      ['up_wolf_r3_villager.jpg', 'games/wolf_r3_villager.jpg'],
    ]);
  },

  // 选择一个模拟身份 → 设为当前身份，进入首页
  pick(e) {
    const uid = e.currentTarget.dataset.uid;
    const nick = e.currentTarget.dataset.nick;
    const gender = e.currentTarget.dataset.gender;
    app.runOnce('switchIdentity', () => {
      app.setTestUid(uid);
      wx.setStorageSync('nick', nick);
      wx.setStorageSync('avatar', ''); // 测试身份用字母头像
      wx.setStorageSync('gender', gender || 'm'); // 测试身份预设性别
      wx.reLaunch({ url: '/pages/hub/hub' });
    }, '');
  },

  // 用真实微信账号（清除模拟身份）
  useReal() {
    app.runOnce('switchIdentity', () => {
      app.setTestUid(null);
      // 清掉测试身份留下的昵称/头像，避免真实账号冒名"玩家X"混进房间
      wx.removeStorageSync('nick');
      wx.removeStorageSync('avatar');
      wx.reLaunch({ url: '/pages/hub/hub' });
    }, '');
  },

  // 一次性：把 /assets 里的本地封面传到云存储，并把 fileID 写进 scripts 集合的 cover.image。
  // 前提：已先在云函数调过一次 seedScripts（scripts 集合里已有对应文档）。跑完即可删掉本地图。
  async uploadCovers() {
    await SCRIPTS.ensureLoaded();
    const items = SCRIPTS.list().filter((s) => (((s.cover && s.cover.image) || '').indexOf('/assets/') === 0));
    if (!items.length) {
      return wx.showModal({ title: '无可上传封面', content: '没有以 /assets/ 开头的封面（可能已挪到云存储）。', showCancel: false });
    }
    const ok = await new Promise((r) => wx.showModal({
      title: '上传封面到云存储',
      content: `将把 ${items.length} 张本地封面传到云存储 covers/，并写入数据库。\n（需先在云函数调过一次 seedScripts）`,
      success: (m) => r(m.confirm), fail: () => r(false),
    }));
    if (!ok) return;
    wx.showLoading({ title: '上传中…', mask: true });
    const fs = wx.getFileSystemManager();
    const done = [];
    for (const s of items) {
      try {
        // 代码包里的图 getImageInfo 在工具里拿不到可上传路径，优先用 FS 拷到用户目录再传
        const src = s.cover.image;                                  // 如 /assets/shiguang.jpg
        const dest = `${wx.env.USER_DATA_PATH}/cover_${s.id}.jpg`;
        let filePath = '';
        try { fs.copyFileSync(src, dest); filePath = dest; }
        catch (e1) {
          try { fs.copyFileSync(src.replace(/^\//, ''), dest); filePath = dest; }
          catch (e2) {
            // 工具里 FS 读不到包内文件时，退回 getImageInfo（真机有效）
            const info = await new Promise((res, rej) => wx.getImageInfo({ src, success: res, fail: rej }));
            filePath = info.path;
          }
        }
        const up = await wx.cloud.uploadFile({ cloudPath: `covers/${s.id}.jpg`, filePath });
        await app.callGame({ action: 'setCover', scriptId: s.id, fileID: up.fileID });
        console.log('[cover]', s.id, '→', up.fileID);
        done.push(`${s.id} ✓`);
      } catch (e) {
        console.error('[cover-fail]', s.id, e);
        done.push(`${s.id} ✗`);
      }
    }
    wx.hideLoading();
    try { wx.removeStorageSync('scriptsCacheV1'); } catch (e) {}  // 清缓存，下次拉到云端新封面
    wx.showModal({ title: '上传完成', content: done.join('   ') + '\n\nfileID 已打印在 Console（可复制填进 scripts.js）。', showCancel: false });
  },
});
