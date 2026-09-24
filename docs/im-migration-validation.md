# IM 迁移本地验证与交接（2026-09-24）

**边界：**实施/验证基线 HEAD `cc00186`；本交接记录随本次自有范围本地提交保存，不预设提交 SHA，亦非生产升级或发布许可。用户批准按 PRD 实施，**未**批准新的服务启动、生产数据库/schema 升级、远端变更或部署；此前旧 `/api/unread-events` 服务恢复属独立的 legacy 运维事实。本页记录本地证据；[路线图](roadmap.md)和 [PRD](prd/a2a-msg-agent-im-v1.md) 的 WP0–WP4 / A1–A8 外部验收门槛继续有效。其他会话的 README、MCP、附件等脏文件不属于此交接的所有权或完成声明。

## 实施范围与版本

- A：受保护的 Unix 备份发布、实际数据库实例身份、registry 独立发现/校验、跨进程协调与撤销；不信任路径 hash 或旧 registry 记录作身份。Windows 原生严格 registry **不支持**，失败关闭。
- B：持久共享时钟守卫与新鲜时间校验；迁移预览、独立审批契约和暂停新写由既有迁移模块及 C 的受信任组合承担，不将其误记为 B 的独立新增能力；旧消息权限不被提升。
- C：受信任迁移服务/runner 将真实 v3 DB 身份、已验证的新 v3 备份、独立审批及新鲜时钟组合；先核实备份，再在锁内进行轻量元数据复核和原子绑定写入/幂等精确重试。完成行集通过 `im_legacy_bindings_run` 索引按批准数量加一有界检验；不在实时写事务内重新哈希整个备份。
- schema v3 仅增加上述索引与版本/checksum 标记，不重建业务表；冻结的 v1/v2 清单和 checksum 保持不变。原 `migrateImSchema` 仍仅支持 fresh→v2、v1→v2 和有效 v2 重复调用；单独显式 `migrateImSchemaV3` 支持 fresh→v3、经验证 v2→v3 和有效 v3 重复调用，**不**直接 v1→v3。详见[存储契约](im-storage-contract.md)、[runner 契约](im-migration-runner.md)。未对真实运行 DB 执行 schema 升级或迁移。

## 版本绑定证据（各批次不可累加为互异测试数）

| 批次 / 范围 | 记录结果与边界 |
| --- | --- |
| Windows 本地整套 npm 测试（最后单测试修订**之前**） | 397 项：341 通过、0 失败、56 跳过，42.521 s；另行 plugin 批次 46 通过、0 跳过。`git diff --check` 为 0，无漂移。证据保存在本机临时运行标签 `team-mailbox-win-validation-20260924`，非仓库日志或可移植链接。 |
| Linux 原生批次（最后单测试修订**之前**） | 11 suites，135 项：133 通过、0 失败、2 项 Windows-only 跳过；6 项真实进程检查全部通过。运行标签 `final-native-dn3qsxdq`，manifest SHA-256 `552b3b2e29d36583116128596d9966d653db32e3e4bc4478abd8cf91338e0f7b`；证据为临时本地材料，不提供虚假的跨环境绝对路径链接。 |
| 最后仅 `tests/im-migration-runner.test.js` 修订 | 添加真正的同步 before-ACK L1 检查；其后原生专项 23 通过、0 失败、0 跳过。43 个生产文件与此前 baseline 相同；专项目标 manifest SHA-256 `83d15b2527d3f6e3d54d92f4fb26fcbc3cdda6de2b7da287d83423d731e26d14`，测试文件 SHA-256 `20b0459db5c9a4262ea80a4ae87e8dd0357b1ee0027a79d2f150de91c66d333d`。前述全套证据可按生产代码未变界限复用，**不是**修订后的全套重跑声明。 |

审查状态：代码审查 gen3 **PASS**（最终 L1 已关闭）；性能/安全 ora3 **PASS**（C1/C2 完成行集采用索引）；PRD 忠实度 exp5 **PASS，仅限 C 切片**；六项进程静态检查 **PASS**；独立最终 QA gen5 **PASS，仅限当前版本的本地迁移包**。QA 核对当前版本与日志哈希，确认原生基线 106 文件中 43 个生产文件保持一致，最后只有 L1 runner 测试增量且原生专项 23 通过；Windows / Linux 全套及专项证据按上述版本界限复用，**未**在最后修订后重跑全套，不推断 PRD 全部验收或发布完成。

## 操作交接与未满足门槛

拟议部署顺序仅为后续**逐项独立审批**的检查点，不是可直接执行的生产 runbook：可恢复备份 → 显式 schema v3 升级 → 发布**新的 v3 备份** → 管理员完整预览与独立审批 → commit。恢复演练、审批系统与准入决策另需授权；不得以旧 v2 备份直接替代升级后的 v3 证据。异常时暂停**新** IM 写，保留 accepted 消息、幂等键、ACK/租约与旧数据；不得用旧快照覆盖已 accepted 数据。备份 registry 锁仅协调其自身撤销/使用，**不保证外部审批撤销与 commit 原子化**。物理 purge 仍延后，不把只读 planner 当清除实现。

A1 真实跨机器 LAN、A2 不同网络 TLS 尚未验收；A3 本地真实进程重启/崩溃证据增加但非完整部署认证；A5 本地迁移切片不等于生产恢复演练或审批子系统；A7 无 OpenCode 的干净环境跨框架路径未完成；A8 `private: true` 且无 LICENSE，未推送/远端 rename、未实际运行 GitHub CI，私密安全报告渠道未完成。旧 `/api/unread-events` 服务恢复可用属于 legacy 运维事实，**不是** IM 验收。
