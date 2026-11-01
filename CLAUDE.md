# 群本玩（微信小程序）

- 回复用中文。
- 交接文档：[docs/开发进度与交接.md](docs/开发进度与交接.md)，开工前先看。
- **每次会话开始时**，如果交接文档里还有「⏳ 上线待办」一节，先把其中没打勾的项列给用户提醒一下。

## 改完代码先跑测试，再说「改好了」

```bash
node test/selftest.js    # wxml 标签配平（12 个文件）+ 资料门判断
node test/game.test.js   # 对局逻辑：内存数据库驱动真实 action 跑完整对局
```

两条都要过。`node --check` 只管 JS 语法，**管不了 wxml，也管不了逻辑**。

对局逻辑是随机发牌的，改了狼人杀/卧底的流程就**连跑 5-10 次**再下结论：

```bash
for i in $(seq 1 10); do node test/game.test.js >/dev/null || echo "第 $i 次失败"; done
```

这两个脚本已经抓到过的真问题（都是只看代码没看出来的）：
- 多余的 `</view>` —— 整个页面编译失败
- 资料门靠昵称长相判断，漏过测试身份留下的「玩家F」
- 女巫等「狼人动手」，狼全是机器人就永远等不到 → 整局死锁
- `leave` 分支引用后面声明的 `const` → TDZ，`WOLF_NAMES is not defined`

改了 `server/functions/jbs/` 要**部署**才生效（`cd server && tcb fn code update jbs`），
光发小程序版本没用；改了页面要**重新上传发版**，光部署云函数没用。
