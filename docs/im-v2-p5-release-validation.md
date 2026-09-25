# IM v2 P5-C C2 release/status v2：限定范围验证（NONRELEASE）

**版本边界：**基线 `02e6f2290aa9a003f0832df22ca58a804fd878a2` 加 14 份限定 overlay；本记录与[路线图](roadmap.md)另行入库。证据仅针对提交前的单一候选版本，**不是**将来 clean commit 的执行结果、完整 P5 或生产发布验收。C0+C1 当时状态见[激活验证记录](im-v2-p5-activation-validation.md)，行为边界见[恢复激活契约](im-v2-recovery-activation-contract.md)。历史段落中的“C2 待完成”是当时快照。

## 已交付的边界

- 运行时恢复 facade 现在有八个同步方法，新增 `releaseRecoveryHold`，并将运行时 status 显式迁移到 status v2 本地契约；旧纯 status 编解码器保留。仅实际 active DB、受保护的实际 completion、真正 hold 派生的 release plan/hash 一致且通过独立审批，才允许发布 release marker。缺失 completion 的 active 候选为 `RETRY_ACTIVATE`、plan/hash 为 null；未释放的 held active 为 `APPROVE_RELEASE_HOLD`；一致的已释放状态为 `NONE` 且保留 plan/hash。fresh/closed 无 hold 不可 release，failed release 不受支持。
- `minimumReleasedAt` 从实际 completion 导出，并在**真实 registry sample** 的 marker 写入之前强制校验。已有精确 marker 的重试不调用时钟，也不更改逻辑 DB、epoch、审计；但候选文件/目录、completion 文件/目录、marker 文件/目录这六处同步仍不可省略。精确重试保持文件时间戳、inode 和字节稳定；锁顺序仍为 source → workspace → candidate。只读 status 和 B 读取只观察证明，不重新同步或修复。
- release 只发布持久 marker，**不**删除 hold 或备份、不启用 TTL；`cleanupAllowed` 始终 false/HOLD。测试中的授权、隔离来源及 fault 注入不等于真实用户审批或真实恢复操作许可；未启动新服务、迁移生产数据、切换恢复、物理删除或发布。旧 LAN 不变。

## 单一候选的版本绑定证据

| 检查 | 实际结果与限制 |
| --- | --- |
| Windows Node 24.19，fresh isolated `npm ci` | 95 packages；仅隔离依赖环境。 |
| Windows 八目标 | 62 pass、172 skip、0 fail；严格原生保护不支持的 Windows skip 不是 pass。 |
| Windows full suite | 1058 pass、447 skip、0 fail。 |
| Windows 显式 plugin 目标 | 46 pass、0 skip。 |
| 原生 Node 24.19 / ext4 八目标 | 230 pass、4 Windows skip、0 fail；native 和 WSL outer exit 均为 0。原生依赖复用已安装版本，已核对 parsed lock 与直接版本；**不是** fresh native 安装或全部依赖字节证明。 |

目标、全套与 plugin 测试有重叠，**不可累加为互异测试**。逻辑证据标签：Windows `c2-compat-final-14f4903a47`（14 文件 manifest SHA-256 `2934d6448d2c1d2bea14130f73d1df424e523d171e0efedd602582b5cdb9aadb`）；native `c2-compat-final-fdfcc162aa`（manifest SHA-256 `4e2731bff73b7f59499764e54361e5cf044bfa27f9c2f8d59aec66bbd4d1676a`，native log SHA-256 `4391bfbd835f75842e7e24df19ee39032dcdd3977a5f15dd1ae1b0e5c462d8b4`）。Windows/native manifest 可因 CRLF/LF 差异而不同，文件映射须以各自候选核对；本记录不包含用户机器绝对路径。限定范围最终代码、安全、契约忠实度审查及独立 QA 均 PASS；这些结论只绑定上述候选，不延伸到后续修改。

原生低时钟拒绝在 marker I/O 前发生；相等时间成功；抛异常时钟的精确重试调用时钟零次且执行六处同步。六个跨进程故障点均在真实 native fsync **之前**注入，另有 21 个精确 BUSY 竞争者；证明仅限软件故障/进程重启，不证明硬件掉电或全局隔离。历史 source clock-skew 和第一轮 C1 错误测试的红色证据保留，不能重标为通过。本轮单一最终候选避免拆分运行结果歧义。

**剩余门槛：**P5-D 完整崩溃矩阵、P6 留存和清理、P7 真实双机 LAN/跨网络验收、H1–H3 实际人工许可及 30 天备份窗口确认均未完成；无真实用户操作获批。不得由本地 PASS 推导出生产恢复、删除、外部网络或发布批准。
