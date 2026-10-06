// SDK 适配层：把 @cloudbase/node-sdk 包成 wx-server-sdk 的用法，game.js 业务代码一行不用改。
// 两个 SDK 只有这几处不一样：
//   doc(id).get()      wx: res.data 是对象        node: res.data 是数组 → 取 [0]
//   add/set/update     wx: 参数包一层 { data }    node: 直接传对象
//   add() 返回         wx: { _id }                node: { id }
//   where().remove()   wx: { stats: { removed } } node: { deleted }
// db.command（_.set/inc/push/remove/exists）和 db.serverDate() 两边完全一致，直接透传。
const cloudbase = require('@cloudbase/node-sdk');

const app = cloudbase.init({ env: process.env.CLOUDBASE_ENV_ID || cloudbase.SYMBOL_CURRENT_ENV, throwOnCode: true });
const rawDb = app.database();

const unwrap = (arg) => (arg && Object.prototype.hasOwnProperty.call(arg, 'data') ? arg.data : arg);

function wrapQuery(q) {
  return {
    where: (cond) => wrapQuery(q.where(cond)),
    limit: (n) => wrapQuery(q.limit(n)),
    skip: (n) => wrapQuery(q.skip(n)),
    orderBy: (f, d) => wrapQuery(q.orderBy(f, d)),
    get: () => q.get(),
    update: (arg) => q.update(unwrap(arg)),
    remove: () => q.remove().then((r) => ({ ...r, stats: { removed: r.deleted || 0 } })),
  };
}

function wrapDoc(d) {
  return {
    get: () => d.get().then((r) => {
      const doc = Array.isArray(r.data) ? r.data[0] : r.data;
      // wx-server-sdk 文档不存在时直接抛错，业务代码靠 .catch(() => null) 兜；这里保持一致
      if (!doc) throw new Error('document not exists');
      return { ...r, data: doc };
    }),
    set: (arg) => d.set(unwrap(arg)),
    update: (arg) => d.update(unwrap(arg)),
    remove: () => d.remove(),
  };
}

function collection(name) {
  const c = rawDb.collection(name);
  return {
    ...wrapQuery(c),
    doc: (id) => wrapDoc(c.doc(id)),
    add: (arg) => c.add(unwrap(arg)).then((r) => ({ ...r, _id: r.id || r._id })),
  };
}

const db = {
  collection,
  command: rawDb.command,
  serverDate: (...a) => rawDb.serverDate(...a),
};

// 集合不存在时 node-sdk 的写入会直接失败（wx 那边开发者工具里手动建过）；冷启动时补建一次，已存在则忽略
let ensured = null;
function ensureCollections(names) {
  if (!ensured) {
    ensured = Promise.all(names.map((n) => rawDb.createCollection(n).catch(() => {})));
  }
  return ensured;
}

module.exports = { app, db, ensureCollections };
