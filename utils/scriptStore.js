// 剧本数据层：优先云数据库（云函数 getScripts），失败/未配时回退打包的 scripts.js。
// 用法：页面 require 本文件代替 scripts.js；byId/list/makeNamer 同步可用（先返回兜底，
// ensureLoaded() 后升级为云端数据）。makeNamer 是纯函数，直接复用 scripts.js 的实现。
const bundled = require('./scripts.js');

let _cloud = null;     // 云端拉到的剧本数组（null=未加载）
let _loading = null;   // 进行中的加载 Promise
const CACHE_KEY = 'scriptsCacheV1';

function _data() {
  return (_cloud && _cloud.length) ? _cloud : bundled.list;
}

function _fetch() {
  const app = getApp();
  if (!app || !app.callGame) return Promise.resolve(_data());
  return app.callGame({ action: 'getScripts' }).then((res) => {
    const list = res && res.result && res.result.ok && res.result.list;
    if (list && list.length) {
      _cloud = list;
      try { wx.setStorageSync(CACHE_KEY, list); } catch (e) {}
    }
    return _data();
  }).catch(() => _data());
}

module.exports = {
  // 确保剧本就绪：有缓存先秒回并后台刷新；否则拉云端；全失败兜底 scripts.js
  ensureLoaded() {
    if (_cloud && _cloud.length) return Promise.resolve(_cloud);
    if (_loading) return _loading;
    try {
      const cached = wx.getStorageSync(CACHE_KEY);
      if (cached && cached.length) {
        _cloud = cached;
        _fetch();            // 后台静默刷新，不阻塞
        return Promise.resolve(_cloud);
      }
    } catch (e) {}
    _loading = _fetch().then((d) => { _loading = null; return d; });
    return _loading;
  },
  list() { return _data(); },
  byId(id) { return _data().find((s) => s.id === id) || bundled.byId(id); },
  makeNamer: bundled.makeNamer,
  ready() { return !!(_cloud && _cloud.length); },
};
