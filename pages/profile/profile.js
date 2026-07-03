const app = getApp();

Page({
  data: {
    nick: '',
    avatar: '',      // 云存储 fileID（他人可加载）
    gender: '',      // 'm' / 'f'，决定对局里的角色照片
    uploading: false,
  },

  onLoad() {
    const avatar = wx.getStorageSync('avatar') || '';
    this.setData({
      nick: wx.getStorageSync('nick') || '',
      avatar,
      gender: wx.getStorageSync('gender') || '',
      avLoading: avatar.indexOf('cloud://') === 0,   // 云端头像要下载，先转 loading
    });
  },

  // 头像图加载完成/失败 → 收起 loading
  onAvatarLoad() { this.setData({ avLoading: false }); },
  onAvatarError() { this.setData({ avLoading: false }); },

  // 选择微信头像 → 上传云存储换成 fileID（先本地预览）
  async onChooseAvatar(e) {
    const tmp = e.detail.avatarUrl;
    this.setData({ avatar: tmp, uploading: true });
    try {
      const openid = await app.ensureLogin();
      const up = await wx.cloud.uploadFile({
        cloudPath: `avatars/${openid}_${Date.now()}.png`,
        filePath: tmp,
      });
      this.setData({ avatar: up.fileID });
    } catch (err) {
      this.setData({ avatar: wx.getStorageSync('avatar') || '' });
      wx.showToast({ title: '头像上传失败，可重试', icon: 'none' });
    } finally {
      this.setData({ uploading: false });
    }
  },

  onNick(e) { this.setData({ nick: (e.detail.value || '').slice(0, 8) }); },

  pickGender(e) { this.setData({ gender: e.currentTarget.dataset.g }); },

  // 保存：三项齐全才落缓存，回上一页
  save() {
    if (this.data.uploading) return wx.showToast({ title: '头像上传中…', icon: 'none' });
    if (!this.data.avatar) return wx.showToast({ title: '请先选择头像', icon: 'none' });
    const nick = (this.data.nick || '').trim();
    if (!nick) return wx.showToast({ title: '请填写昵称', icon: 'none' });
    if (!this.data.gender) return wx.showToast({ title: '请选择性别', icon: 'none' });
    wx.setStorageSync('avatar', this.data.avatar);
    wx.setStorageSync('nick', nick);
    wx.setStorageSync('gender', this.data.gender);
    wx.showToast({ title: '已保存', icon: 'success' });
    setTimeout(() => wx.navigateBack(), 400);
  },
});
