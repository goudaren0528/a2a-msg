# IM v2 P5-C C0+C1 激活局部增量：限定范围验证（NONRELEASE）

**版本边界：**基线 `9e3bca504f93c2b1f40762e0d582c72bd4bc379d` 加 23 份经最终 QA 核对的源码、测试与契约 overlay；本记录及[路线图](roadmap.md)另行入库。该证据针对提交前的限定候选，**不是**新提交后的 clean commit 重跑，更不是部署、完整 P5 或生产发布验收。[P5-C 行为契约](im-v2-recovery-activation-contract.md)规定冻结的目标及 C2 保留接口；[P5-B 验证](im-v2-p5-prepare-validation.md)记录先决的准备切片。契约中的未交付目标不应被读成 C1 已实现的运行时能力。

## 已交付的边界

- C0 包含纯 seal、activation plan、activation completion、release plan 和 status v2 编解码器，以及私有 hold 读取和 release capability；release capability **仅经 fixture 验证，并非运行时 release writer**。C1 在原有四个 B 方法之外加入 `verifyRecovery`、`previewActivation`、`activateRecovery`，运行时共七个方法；**没有** `releaseRecoveryHold` 或运行时 status v2。
- 验证先封存已关闭的候选文件，再进入任何激活 guard 或时钟 anchor。激活依赖互相独立的管理员授权、activation approval、auth review 与来源隔离/原有 closure proof 复核；这些不是互相替代的许可。active 后仍 `paused`，不创建监听。隔离 fixture 中的授权不代表生产来源隔离或真实审批。
- 所有精确的 active 重试先对照实际 DB 与受保护证明，再仅同步候选文件及其目录、completion 文件及其目录；不改逻辑时钟、epoch、审计或 DB 内容。只读 status 和 B 已完成读取仅观察匹配的可见事实，不执行 resync/修复，也不声称先前 fsync 已成功。缺失 completion 的精确修复和发布不确定时的同步不会递归制造 marker。
- 不授权真实 restore、isolation、activation 或 delete；旧 LAN 行为不变。P5-C C2 release/status v2、P5-D 完整故障矩阵、P6 purge、P7 真实网络及 H1–H3 实际运营确认仍开放；30 天留存期限亦非在此获批。

## 版本绑定的证据

| 检查 | 实际结果与限制 |
| --- | --- |
| Windows Node 24.19，fresh isolated `npm ci` | 安装 95 packages；仅限隔离依赖环境。 |
| Windows 六目标 | 179 total、60 pass、119 skip、0 fail；能力 skip **不是**严格原生恢复成功。 |
| Windows full suite | 1454 total、1056 pass、398 skip、0 fail。 |
| Windows 显式五个 plugin 目标 | 46 pass、0 skip。 |
| 原生 Node 24.19 / ext4 六目标 | 179 total、176 pass、3 skip、0 fail；native 与 outer exit 均为 0。复用与 lock 匹配的 95 个已安装版本，**不是** fresh Linux 安装或 Linux 全仓测试。 |

上述目标、全套及插件计数有重叠，**不可相加**。逻辑证据标签：Windows `c0c1-final-20260925-8953e089`（23 文件 manifest SHA-256 `17aad68da465bd7c700131233cff5ff4b8012461ebae11b61414fe1506766192`，full log SHA-256 `5e978a8d36100bfc5a3732a7802bf75b7df00b12ef5fda3f9a1e21d2e77bc4f7`）；native `c0c1-final-0fe0f63d`（同一文件映射因 CRLF/LF 差异，manifest SHA-256 `6ffebac94eae4418ecae08905cea3e49d181d1de1765c3f70271a743a508fd03`，native log SHA-256 `2265bc209ec96412c9d917b02fea2b146c9921076e41d959f01873924f0c42d4`）。最终 QA 核对了 23 份 overlay，另比较排除这些 overlay 的 303 份基线文件；独立代码、安全、契约忠实度、QA 门禁均 PASS，均只对应上述候选版本。

原生四个跨进程 fsync 故障阶段的注入点均在 native 调用**之前**；恢复重试两次均执行四次真实同步且 DB 逻辑/内容未变。这是软件故障注入及进程退出证据，**不是**硬件掉电证明。历史红色 B 证据 `oft4krdh` 与 C0 poison 证据 `lw3hjt5p` / `xibimixe` 保持原样，新测试并非弱化替代。未将本地 fixture 权威视为生产隔离确认，未执行生产 factory、启动服务、删除、远端操作或推送。
