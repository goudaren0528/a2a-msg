# IM v2 P5-D 进程恢复矩阵：限定范围验证（NONRELEASE）

**版本与范围：**基线 `4884b65c0f9848bf2024638295d3f69b4bcc33cf` 加六份 `tests/im-v2-recovery-process.test.js`、`tests/fixtures/im-v2-recovery/{scenarios,fixture,child,processes,barrier}.js` overlay；[路线图](roadmap.md)另行记录阶段进度。下述记录绑定该候选测试文件版本及先前已存在的 P5 实现，不是未来 clean commit 的重跑或生产验收。P5-D test-design 审查 PASS，最终 artifact QA PASS；不要将先前失败的 harness 运行重新标记为通过。

## 有界矩阵与契约

| 分组 | 个数 | 覆盖边界 |
| --- | ---: | --- |
| A | 6 | registered-v3 / snapshot 发布各三个故障点：artifact、manifest、registry record；不完整发布拒绝，完整登记才校验。 |
| B | 13 | locator、source closure、stage、hold、source verified、copy intent、candidate publication、base、normalization intent/normalized、staged、prepare plan/binding。 |
| C | 10 | prepare/verify commit 与 sync、seal、activation plan/anchor、active commit/sync、completion、release marker。 |
| D | 5 | closed-v3 WAL/归一化、enabled pause、registered-v3/fresh P1 commit。 |
| E | 3 | 双链接、部分候选写入、部分候选发布：拒绝不可信或不完整 artifact。 |
| F | 4 | fresh、registered-v3、closed-v3、snapshot 的独立正常退出进程链。 |
| G | 2 | symlink / hardlink alias：拒绝。 |

总计 **43 个指定场景：39 个实际软件 SIGKILL（K）+ 4 条独立进程正常退出链（P）**。进程内 exception、单纯 facade reopen 不算 K；正常退出链也不能改称 SIGKILL。每次只证明观察到的恢复或按契约保守拒绝，绝不意味着所有崩溃都会恢复。源码打开、备份、manifest 与真实有数据的 legacy journal 均作为观察对象；post-backup accepted、ACK、read、credential 事实须保留，不能把未知 RPO 或授权变化变成已证实无损。source-open 测试只是观察，并非证明实际旧 writer 已停止或跨系统全局 fencing。fixture 的 `SEND_OUTCOME_UNKNOWN` 来自真实 server `getSendResult`，该只读 probe 不发送消息，`posts: 0` 仅证明 probe 未 POST；真实 client 不自动重 POST 的证据属于独立 P4 验证，不可由本 stub 推出。

完整 publisher 的部分注册没有 resume API；不完整 artifact 必须拒绝，不能虚构自动 retry。部分归一化或 pause 的候选可能需要人工处理，不会自动接管；anchor 改变使旧 seal 失效，必须重新核验/审批。active 状态仍始终 paused，不启动 listener。release hold 只写持久 marker，**不**删除备份/hold 或许可清理；无已确认的 30 天备份 TTL。软件 SIGKILL 不等于掉电/任意崩溃。已有非阻塞 waiter timeout cleanup 建议尚未修复，不得暗示已解决。

## 分版本证据与可复核性

| 运行 | 结果 | 限制 |
| --- | --- | --- |
| Windows Node 24.19；fresh isolated `npm ci` | 95 packages；新增目标 45 total / 2 pass / 43 Unix skip / 0 fail；full suite 1550 total / 1060 pass / 490 skip / 0 fail；显式五 plugin 目标 46 pass / 0 skip。 | Unix skip 不是 POSIX 恢复证明；目标、全套与 plugin 有重叠，计数不可累加。 |
| 原生 Node 24.19 / ext4 | 新增目标 45 total / 44 pass / 1 Windows skip / 0 fail；native exit 0，manifest 记录 outer exit 0。 | 依赖复用已安装的匹配 lock 的 95 个版本，**不是** native fresh install。Windows skip 不算原生通过。 |

新 Windows 运行逻辑标签 `p5d-qa-4c033b37636e45a6a25701002eeeda85`，manifest SHA-256 `e2830bf2dfd684fbf46b99c8a33442038c05a1d9bbef01304da1144c6e5b1fba`；作者 metadata SHA-256 `4bd81ae5b89ca2c53420621f7f0184997b4af6c5b83b2d0eda50ea16e0aeb688`，作者 summary SHA-256 `3fe588fa6e9a166f9abd8f59b5a255bdfa84ebb9ce2fda7429d4686941006ee0`。新原生 raw log 报告 43 场景通过，但该运行的逐场景目录现已**不再保留**，process audit 为空（0 case / 0 child）；不能独立用这次新运行证明 159 PID / 39 K，也不能断言目录消失由 fixture cleanup 导致（fixture 设计为保留）；原因尚未确定。

另外保留的作者原生逻辑运行 `p5d-matrix-08pcykeh` 含 43 份逐场景文件；独立复核得到 159 条对应 exit/close、39 K 和 120 正常退出，且与本页六份测试文件 SHA-256 一致。这是**先前保留运行**的行为佐证，配合新运行兼容性结果使用，不能冒充新运行的目录审计，也不构成 clean commit 重跑。证据标签是逻辑标识；此文不写个人机器绝对路径、私有运行 artifact 或虚构审计保留。

**剩余门槛：**P5 开发恢复切片 A–D 仅为限定范围已验证，不是整项目发布或生产准备批准。P6 留存 planner/purge 设计及关闭默认值、P7 真实网络验收与 H1–H3 人工确认、30 天备份窗口均待确认；无生产备份恢复许可、物理清理、自动迁移、listener 启用或外部发布授权。上游 [P5-C release 验证记录](im-v2-p5-release-validation.md) 中“P5-D 待完成”保留其当时快照。
