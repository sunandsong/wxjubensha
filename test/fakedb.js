// 内存数据库：实现 cloud.js 暴露的那套接口，让 game.js 不改一行就能在 node 里跑。
// 只覆盖业务实际用到的：等值 where、_.exists、set/inc/push/remove 四个更新操作符、点号路径。
const OP = Symbol('op');
const op = (name, v) => ({ [OP]: name, v });

const command = {
  set: (v) => op('set', v),
  inc: (v) => op('inc', v),
  push: (v) => op('push', v),
  remove: () => op('remove'),
  exists: (v) => op('exists', v),
};

const clone = (x) => (x === undefined ? undefined : JSON.parse(JSON.stringify(x)));
// 业务代码写库时参数都包一层 { data: ... }，cloud.js 会拆掉——假库必须保持一致
const unwrap = (arg) => (arg && Object.prototype.hasOwnProperty.call(arg, 'data') ? arg.data : arg);
const isOp = (x) => x && typeof x === 'object' && x[OP];

// 点号路径写入：'night.seerDone' / 'votes.<openid>'
function applyPath(doc, path, val) {
  const keys = path.split('.');
  let cur = doc;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] == null || typeof cur[keys[i]] !== 'object') cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  const k = keys[keys.length - 1];
  if (!isOp(val)) { cur[k] = clone(val); return; }
  switch (val[OP]) {
    case 'set':    cur[k] = clone(val.v); break;
    case 'inc':    cur[k] = (cur[k] || 0) + val.v; break;
    case 'push':   cur[k] = (cur[k] || []).concat(clone(val.v)); break;
    case 'remove': delete cur[k]; break;
    default: throw new Error('未实现的操作符: ' + val[OP]);
  }
}

function match(doc, cond) {
  return Object.keys(cond).every((k) => {
    const want = cond[k];
    if (isOp(want) && want[OP] === 'exists') return (doc[k] !== undefined) === want.v;
    return JSON.stringify(doc[k]) === JSON.stringify(want);
  });
}

function makeDb() {
  const store = {};                      // { collection: { id: doc } }
  const col = (name) => (store[name] = store[name] || {});
  let seq = 0;

  function query(name, cond = {}) {
    const hits = () => Object.values(col(name)).filter((d) => match(d, cond));
    return {
      where: (c) => query(name, { ...cond, ...c }),
      limit: () => query(name, cond),
      skip: () => query(name, cond),
      orderBy: () => query(name, cond),
      get: async () => ({ data: clone(hits()) }),
      update: async (arg) => {
        const data = unwrap(arg);
        const list = hits();
        list.forEach((d) => Object.keys(data).forEach((k) => applyPath(d, k, data[k])));
        return { stats: { updated: list.length } };
      },
      remove: async () => {
        const list = hits();
        list.forEach((d) => delete col(name)[d._id]);
        return { stats: { removed: list.length } };
      },
    };
  }

  function doc(name, id) {
    return {
      get: async () => {
        const d = col(name)[id];
        if (!d) throw new Error('document not exists');   // 和 cloud.js 的行为一致
        return { data: clone(d) };
      },
      set: async (arg) => { col(name)[id] = { ...clone(unwrap(arg)), _id: id }; },
      update: async (arg) => {
        const data = unwrap(arg);
        const d = col(name)[id];
        if (!d) throw new Error('document not exists');
        Object.keys(data).forEach((k) => applyPath(d, k, data[k]));
      },
      remove: async () => { delete col(name)[id]; },
    };
  }

  return {
    _store: store,
    collection: (name) => ({
      ...query(name),
      doc: (id) => doc(name, id),
      add: async (arg) => {
        const data = unwrap(arg);
        const id = data._id || `id${++seq}`;
        col(name)[id] = { ...clone(data), _id: id };
        return { _id: id };
      },
    }),
    command,
    serverDate: () => new Date(),
  };
}

module.exports = { makeDb };
