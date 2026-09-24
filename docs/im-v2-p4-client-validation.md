# IM v2 NONRELEASE P4 client 限定范围验证（2026-09-25）

本记录只覆盖基于 `7f0d0f68c382ef391356d1d2c9b87e0cd3f3ba85` 的 16 文件 client/journal stamp/测试/fixture/实施计划 overlay；不替代 [P4 存储](im-v2-p4-storage-validation.md)、[P4 owner](im-v2-journal-owner-validation.md)的证据，也不代表整份 PRD、P5–P7 或生产发布验收。原先实施计划中的“未来 client”文字是阶段性前置条件，不能拿它替代本切片的实际验证。四轮限定范围审查结论 PASS，附带下列限制；没有授权任何真实业务 DB、服务、迁移、删除或发布操作。

## 已交付的本地边界

- 独占 owner 在工作开始之前获取；可信离线打开及显式 journal 注册是严格新客户端的必需条件。原生 Unix 才支持严格 owner；Windows 的严格新客户端拒绝，旧 Windows LAN 入口不变。构造客户端本身不激活、不监听、不迁移、不清理。
- 发送先持久保存不可变 operation 再 POST；响应不确定时只按原 key 查询结果，不能把查询 404 当成恢复后的重 POST 授权。旧 epoch 的 UNKNOWN 不擦除本地 accepted message ID、时间和历史事实。epoch 变化停止 mutation，显式 reconcile 才创建新分区与决策引用，旧证据保留；新 operation 是否可能业务重复需人工决定。
- 附件验证、文件及接收事实和批次先持久化，再允许 ACK；不以模拟 ACK 代替服务器证明。pending/confirmed 扫描总预算最多 10 页、10 次 mutation；continuation 记录最后已发页及同一实际连接的 BigInt journal stamp。游标后方新写导致 `PLAN_STALE`，不自动补偿或无限重扫；当前水位缺口与 sticky expiry 分别处理。
- 关闭时 abort/wait 工作后才释放 owner。释放结果不确定会报错，不能据此保证远端租约已修复或所有待确认工作已结束。

## 版本绑定证据与未测范围

基线 manifest SHA-256：`d1845d86ac8748d4a397b819fefab52954c1100c995faf3522961adceca5a7b6`。基线 Windows 定向测试 **81 total / 5 pass / 76 POSIX skip**，完整套件 **1140 total / 953 pass / 187 skip / 0 fail**，插件 **46 pass**；基线 Linux **81 pass / 0 skip**。这些是各自版本及平台的计数，不可相加为独立测试。基线 Windows `npm ci` 退出码 0，耗时 95 秒；原生 Linux Node 24.19、ext4，依赖为复用且与 lockfile 匹配，**不是**原生 Linux fresh install。

最终仅两份测试文件相对基线变化：`tests/im-v2-client-process.test.js` SHA-256 `e22071581dbf9ebda932807785c9dfeafe85626b92280f5e5c661bf5da2479da`；`tests/fixtures/im-v2-client-process/harness.js` SHA-256 `148ec909a2c51ce31eef3096995367781fc0f124334be79c971a2eb6341e95b4`。补充批次在原生环境 **15 项 process/fault PASS**，另有两个实际 ACK/expiry 场景的定向 TAP **3 total**（含一个空的过滤文件）；最终补充批次**没有重新运行完整套件**。补充批次 manifest SHA-256：`9b1c7a2eb76d97cf7eb1be7733821ddf71dc7a5f064d82c5a1f6268f123ca7ea`；核对的 75 份生产/依赖相关文件 hash 全部一致，另有基线 242 份非 overlay 受跟踪源码，仅 Windows CRLF 规范化差异。以上是逻辑批次标识和摘要，不包含工作站证据目录或凭据。

补充故障场景的 `SIGKILL` 不是断电或持久介质掉电证明；SQL expiry/restored candidate 场景也不是 P5 恢复或 P6 清理验收。错误主机名即使 CA 受信仍须拒绝；不确定 release 不能视为成功。103→104 重放的 receipt/delivery/audit 时间不变。既有审查 PASS 仅限所审源码和测试版本，不证明跨机网络、第三方框架或生产稳健性。

**剩余门禁：**P5 恢复、来源证明及激活控制；P6 保留/物理清理；P7 真实双机 LAN、不同网络互联网 TLS、外部跨平台验收；H1–H3 人工许可。30 天备份清理窗口未确认，不得默认启用或执行。旧 LAN 与上层 WP0–WP4 的剩余要求保持独立；本记录不授权推送或发布。
