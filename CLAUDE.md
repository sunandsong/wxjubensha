# 群本玩（微信小程序）

- 回复用中文。
- 交接文档：[docs/开发进度与交接.md](docs/开发进度与交接.md)，开工前先看。
- **每次会话开始时**，如果交接文档里还有「⏳ 上线待办」一节，先把其中没打勾的项列给用户提醒一下。

## 改完代码先跑测试，再说「改好了」

```bash
node test/selftest.js        # wxml 标签配平（12 个文件）+ 资料门判断
node test/game.test.js       # 对局逻辑：内存数据库驱动真实 action 跑完整对局
node test/fuzz.test.js 300   # 随机退出压力测试：600 局，0.7 秒，断言永不卡死
node test/api.test.js        # 33 个 action 全打一遍：不抛异常、权限挡得住、新接口必须补用例
```

四条都要过。`node --check` 只管 JS 语法，**管不了 wxml，也管不了逻辑**。

对局逻辑是随机发牌的，改了狼人杀/卧底的流程就**连跑 5-10 次**再下结论：

```bash
for i in $(seq 1 10); do node test/game.test.js >/dev/null || echo "第 $i 次失败"; done
```

这两个脚本已经抓到过的真问题（都是只看代码没看出来的）：
- 多余的 `</view>` —— 整个页面编译失败
- 资料门靠昵称长相判断，漏过测试身份留下的「玩家F」
- 女巫等「狼人动手」，狼全是机器人就永远等不到 → 整局死锁
- `leave` 分支引用后面声明的 `const` → TDZ，`WOLF_NAMES is not defined`
- 剧本杀公布真相 / 狼人确认刀 / 天黑投票：都把机器人算进「人齐了吗」→ 卡死
- `reset` 漏清机器人 → 再来一局永远开不了，房间废掉
- 「真人是否走光」没排除死人 → 活人全退后天黑卡在「还没有人投票」

**加了阻塞条件就想一下机器人**：凡是「还有 N 人没投票 / 没行动」这类判断，
机器人（`p.bot`）永远不会满足它。fuzz 跑 300 局能把这类问题撞出来，
失败会打印 `seed=N step=M`，固定种子可复现。

改了 `server/functions/jbs/` 要**部署**才生效（`cd server && tcb fn code update jbs`），
光发小程序版本没用；改了页面要**重新上传发版**，光部署云函数没用。

## 云环境是跟「人生清单」共用的，新建集合必须带 `jbs` 前缀

`renshengqingdan-d9fc03opf3bac6ba` 这个 CloudBase 环境里同时跑着另一个项目。
埋点集合当初叫 `events`，结果人生清单早就占了这个名字（字段 `uid/event/props/at`，
事件名如 `wish_add`），两套数据差点混进一个集合——赶在写数据之前才发现。

**新建集合前先查一下有没有被占**：

```bash
cd server && npx -y -p @cloudbase/cli cloudbase db nosql execute \
  -e renshengqingdan-d9fc03opf3bac6ba \
  --command '[{"TableName":"XXX","CommandType":"COMMAND","Command":"{\"find\":\"XXX\",\"limit\":1}"}]'
```

现有集合：`rooms` / `scripts` / `spySecrets` 是我们的（历史遗留，没冲突），
`jbsEvents` 是埋点流水。再加新的一律 `jbs` 开头。

部署只用 `fn code update`，**绝不用 `fn deploy`**——后者会重置环境变量，
把 `WX_APPSECRET` / `JWT_SECRET` / `ADMIN_KEY` 冲掉。
