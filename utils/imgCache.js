// 云存储图片三级缓存：本地文件(永久,秒显) > https 临时链接(1小时) > cloud:// 现取
// 首次用临时链接显示并后台下载落盘，之后直接读本地文件，不再重复下载。
// 用法：resolve([fileID...], (map) => { /* map: fileID → 可直接用的本地路径或 https 链接，可能回调 1~2 次 */ })
const CK = 'imgUrlMapV1';    // fileID → https 临时链接（带时间戳，1 小时有效）
const LK = 'imgLocalMapV1';  // fileID → 已落盘的本地文件路径
const DIR = `${wx.env.USER_DATA_PATH}/imgcache`;

function resolve(fids, onUpdate) {
  const fs = wx.getFileSystemManager();
  const local = wx.getStorageSync(LK) || {};
  // 本地文件已被系统清理的，从映射里剔除
  Object.keys(local).forEach((fid) => {
    try { fs.accessSync(local[fid]); } catch (e) { delete local[fid]; }
  });
  const c = wx.getStorageSync(CK);
  const map = (c && c.ts && (Date.now() - c.ts < 3600000) && c.map) || {};
  const best = (fid) => local[fid] || map[fid] || '';

  // 1) 缓存命中的立刻回调
  const hit = {};
  fids.forEach((f) => { const u = best(f); if (u) hit[f] = u; });
  if (Object.keys(hit).length) onUpdate(hit);

  // 2) 后台把还没落盘的下载到本地，下次秒开
  const download = (fid, url) => wx.downloadFile({
    url,
    success: (r) => {
      if (r.statusCode !== 200) return;
      try { fs.mkdirSync(DIR, true); } catch (e) {}
      const dest = `${DIR}/${fid.split('/').pop()}`;
      fs.saveFile({
        tempFilePath: r.tempFilePath, filePath: dest,
        success: () => { local[fid] = dest; wx.setStorageSync(LK, local); },
      });
    },
  });
  const cloudFids = fids.filter((f) => f && f.indexOf('cloud://') === 0);
  const toSave = (m) => cloudFids.filter((f) => !local[f]).forEach((f) => m[f] && download(f, m[f]));

  // 3) 连临时链接都没有的，批量取一次再回调+落盘
  const need = cloudFids.filter((f) => !best(f));
  if (!need.length) { toSave(map); return; }
  wx.cloud.getTempFileURL({ fileList: need }).then((res) => {
    (res.fileList || []).forEach((x) => { if (x.fileID && x.tempFileURL) map[x.fileID] = x.tempFileURL; });
    wx.setStorageSync(CK, { ts: Date.now(), map });
    const fresh = {};
    fids.forEach((f) => { const u = best(f); if (u) fresh[f] = u; });
    if (Object.keys(fresh).length) onUpdate(fresh);
    toSave(map);
  }).catch(() => {});
}

// 某个 fileID 的缓存坏了（链接过期/本地文件损坏）：清掉映射和落盘文件，下次重新取
function invalidate(fid) {
  const local = wx.getStorageSync(LK) || {};
  if (local[fid]) {
    try { wx.getFileSystemManager().unlinkSync(local[fid]); } catch (e) {}
    delete local[fid];
    wx.setStorageSync(LK, local);
  }
  const c = wx.getStorageSync(CK);
  if (c && c.map && c.map[fid]) {
    delete c.map[fid];
    wx.setStorageSync(CK, c);
  }
}

module.exports = { resolve, invalidate };
