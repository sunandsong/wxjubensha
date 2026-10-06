// 云存储图片两级缓存：本地文件(永久,秒显) > https 永久链接(存储桶公开可读，直接能用)
// 首次用 https 链接显示并后台下载落盘，之后直接读本地文件，不再重复下载。
// 用法：resolve([url...], (map) => { /* map: url → 可直接用的本地路径或 https 链接 */ })
//
// 历史坑（勿回退）：
// ① 落盘成功后曾把 resolve 开头的旧快照整体写回 storage——并发 resolve 互相覆盖、复活已删除的死路径
//    现在写入前重读最新 storage，只合并当前这一条
// ② 迁移前是 cloud:// fileID + 临时链接三级缓存；换到公开桶后临时链接这一级不需要了
const LK = 'imgLocalMapV2';  // url → 已落盘的本地文件路径（V2：key 从 cloud:// 换成 https，老映射作废）
const DIR = `${wx.env.USER_DATA_PATH}/imgcache`;

const downloading = {};      // 进行中的下载去重（模块级，防并发 resolve 重复拉）

function resolve(fids, onUpdate) {
  const fs = wx.getFileSystemManager();
  const local = wx.getStorageSync(LK) || {};
  // 本地文件已被系统清理的，从映射里剔除（只影响本次快照，不写回）
  Object.keys(local).forEach((fid) => {
    try { fs.accessSync(local[fid]); } catch (e) { delete local[fid]; }
  });
  const isUrl = (f) => f && f.indexOf('https://') === 0;

  // 1) 立刻回调：落过盘的给本地路径，没落盘的直接给 https 链接
  const hit = {};
  fids.forEach((f) => { const u = local[f] || (isUrl(f) ? f : ''); if (u) hit[f] = u; });
  if (Object.keys(hit).length) onUpdate(hit);

  // 2) 后台把还没落盘的下载到本地，下次秒开（写入前重读 storage，只合并这一条）
  fids.filter((f) => isUrl(f) && !local[f] && !downloading[f]).forEach((fid) => {
    downloading[fid] = true;
    wx.downloadFile({
      url: fid,
      success: (r) => {
        if (r.statusCode !== 200) { downloading[fid] = false; return; }
        try { fs.mkdirSync(DIR, true); } catch (e) {}
        const dest = `${DIR}/${fid.split('/').pop()}`;
        try { fs.unlinkSync(dest); } catch (e) {}   // 迁移前的同名旧文件挡路会导致 saveFile 失败
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
  });
}

// 某张图的缓存坏了（本地文件损坏/云端换图）：清掉映射和落盘文件，下次重新取
function invalidate(fid) {
  const local = wx.getStorageSync(LK) || {};
  if (local[fid]) {
    try { wx.getFileSystemManager().unlinkSync(local[fid]); } catch (e) {}
    delete local[fid];
    wx.setStorageSync(LK, local);
  }
}

module.exports = { resolve, invalidate };
