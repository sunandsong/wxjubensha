const app = getApp();
const SCRIPTS = require('../../utils/scriptStore.js');

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
