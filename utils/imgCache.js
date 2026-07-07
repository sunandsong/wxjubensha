// 云存储图片三级缓存：本地文件(永久,秒显) > https 临时链接(每条各自 50 分钟) > cloud:// 现取
// 首次用临时链接显示并后台下载落盘，之后直接读本地文件，不再重复下载。
// 用法：resolve([fileID...], (map) => { /* map: fileID → 可直接用的本地路径或 https 链接，可能回调 1~2 次 */ })
//
// 历史坑（勿回退）：
// ① 临时链接曾共用一个全局时间戳——任何新图刷新链接会把所有旧链接"续命"，过期链接被当新鲜的发出去 → 图片时好时坏
//    现在每条链接各自记 ts，过期只影响自己
// ② 落盘成功后曾把 resolve 开头的旧快照整体写回 storage——并发 resolve 互相覆盖、复活已删除的死路径
//    现在写入前重读最新 storage，只合并当前这一条
const CK = 'imgUrlMapV2';    // fileID → { url, ts }（每条各自计时；V2：老格式作废自然重建）
const LK = 'imgLocalMapV1';  // fileID → 已落盘的本地文件路径
const DIR = `${wx.env.USER_DATA_PATH}/imgcache`;
const TTL = 50 * 60 * 1000;  // 临时链接按 50 分钟算过期（官方 1 小时，留余量）

const downloading = {};      // 进行中的下载去重（模块级，防并发 resolve 重复拉）

function resolve(fids, onUpdate) {
  const fs = wx.getFileSystemManager();
  const local = wx.getStorageSync(LK) || {};
  // 本地文件已被系统清理的，从映射里剔除（只影响本次快照，不写回）
  Object.keys(local).forEach((fid) => {
    try { fs.accessSync(local[fid]); } catch (e) { delete local[fid]; }
  });
  const urls = (wx.getStorageSync(CK) || {});
  const freshUrl = (fid) => {
    const e = urls[fid];
    return e && e.url && (Date.now() - e.ts < TTL) ? e.url : '';
  };
  const best = (fid) => local[fid] || freshUrl(fid) || '';

  // 1) 缓存命中的立刻回调
  const hit = {};
  fids.forEach((f) => { const u = best(f); if (u) hit[f] = u; });
  if (Object.keys(hit).length) onUpdate(hit);

  // 2) 后台把还没落盘的下载到本地，下次秒开（写入前重读 storage，只合并这一条）
  const download = (fid, url) => {
    if (downloading[fid]) return;
    downloading[fid] = true;
    wx.downloadFile({
      url,
      success: (r) => {
        if (r.statusCode !== 200) { downloading[fid] = false; return; }
        try { fs.mkdirSync(DIR, true); } catch (e) {}
        const dest = `${DIR}/${fid.split('/').pop()}`;
        fs.saveFile({
          tempFilePath: r.tempFilePath, filePath: dest,
          success: () => {
            const latest = wx.getStorageSync(LK) || {};
            latest[fid] = dest;
            wx.setStorageSync(LK, latest);
            downloading[fid] = false;
          },
          fail: () => { downloading[fid] = false; },
        });
      },
      fail: () => { downloading[fid] = false; },
    });
  };
  const cloudFids = fids.filter((f) => f && f.indexOf('cloud://') === 0);
  const toSave = () => cloudFids.filter((f) => !local[f]).forEach((f) => {
    const u = freshUrl(f);
    if (u) download(f, u);
  });

  // 3) 没有新鲜链接的，批量取一次再回调+落盘
  const need = cloudFids.filter((f) => !best(f));
  if (!need.length) { toSave(); return; }
  wx.cloud.getTempFileURL({ fileList: need }).then((res) => {
    const latest = wx.getStorageSync(CK) || {};
    (res.fileList || []).forEach((x) => {
      if (x.fileID && x.tempFileURL) {
        latest[x.fileID] = { url: x.tempFileURL, ts: Date.now() };
        urls[x.fileID] = latest[x.fileID];
      }
    });
    wx.setStorageSync(CK, latest);
    const fresh = {};
    fids.forEach((f) => { const u = best(f); if (u) fresh[f] = u; });
    if (Object.keys(fresh).length) onUpdate(fresh);
    toSave();
  }).catch(() => {});
}

// 某个 fileID 的缓存坏了（链接过期/本地文件损坏/云端换图）：清掉映射和落盘文件，下次重新取
function invalidate(fid) {
  const local = wx.getStorageSync(LK) || {};
  if (local[fid]) {
    try { wx.getFileSystemManager().unlinkSync(local[fid]); } catch (e) {}
    delete local[fid];
    wx.setStorageSync(LK, local);
  }
  const urls = wx.getStorageSync(CK) || {};
  if (urls[fid]) {
    delete urls[fid];
    wx.setStorageSync(CK, urls);
  }
}

module.exports = { resolve, invalidate };
