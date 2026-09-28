# IM v2 B2 schema 5 备份发布/注册验证（NONRELEASE）

**限定范围接受、本地提交收口；不是发布/生产许可。**执行输入为已提交基线 `981cc158565434864a3ccf00b4143b8fe375781f` 加九份固定源码/测试 overlay，而不是本次提交后 clean commit 重跑。另行审查的 [v5 兼容交接契约](im-v2-schema-v5-compatibility-contract.md)不作为执行 overlay；[当前 TODO](im-v2-implementation-plan.md)与[路线图](roadmap.md)记录后续门禁。

## 范围与行为

- 真实已完成 full snapshot 在 native4/native5 之间按 exact inspector 选择编码；native5 采用 manifest3、record4、source2 的相关联证据，私有 registry4 仅基于真实 version-aware proof 注册。artifact、manifest、source、record 各自文件/目录共八次同步完成后才建立 registered proof。原 native4、导入注册 v3 行为继续支持；旧 P5 target4 对 native5 的 admission/release 在复制、hold、binding 或 terminal publication 前明确 `UNSUPPORTED`。
- 保留原共享认证预算、原审批捕获和异步后检查；`copyTo` 的本地及逃逸原始 Error/假值返回身份与后续 consumer exception 分离，thenable/reentry poison 继续生效。真实 post-callback artifact revalidation 与进程屏障属于本次限定证据。
- snapshot 保留 head/history/原 transition；这些数据不授予私有 maintenance session authority。`cleanupAllowed` 始终 false；不开放 TTL、删除或默认备份清理。默认 10 MiB metadata 情景为合法 800 anchors 的预算拒绝、投影 635 行，**不是**默认全量验证接受或容量保证。

## 固定输入与独立执行证据

| 运行输入（相对仓库根目录） | SHA-256 |
| --- | --- |
| `src/im/v2/backup.js` | `d6863d221298a5519fbb0291023d6d305e46d2c9f5aebddf043e1cb9cb9eb63f` |
| `src/im/v2/backup-registry.js` | `b217eac823680392d33d8c5f0e69751e6723d0a55350c58d25155a59ffbe0aeb` |
| `src/im/v2/recovery-source.js` | `d4d1aeafcae601745d51fb7da16d7be7fb38eff50b5e59d7b2f42f8b5d3269ca` |
| `tests/im-v2-backup-v5.test.js` | `0129e21433090ff490d29ed2ca1b21c348c37b0fde6e400f87b599ef7a2b344d` |
| `tests/im-v2-backup-registry-v5.test.js` | `661f0fbd670b004de8dc64d2677efc8ba4287858fa40263ddc28355605e824fb` |
| `tests/im-v2-backup-v5-boundaries.test.js` | `331c531dc533f2adb91538419f59310e6fe8a15237a2219e033894fd155ae025` |
| `tests/fixtures/im-v2-backup-v5/helpers.js` | `fd48a0b06aef23fe5c9100ae4f781a35ce2bdbb01c214b491135e20935be9d75` |
| `tests/fixtures/im-v2-backup-v5/children.js` | `2a02f1b072abe81d14278595ce5280e7edb8c2acef4af8858f20c8aa4aa719e2` |
| `tests/fixtures/im-v2-backup-v5/worker.js` | `782e87cd577457717cdb7418a7e789c810e9377c1664e9d8ff024b5bae1cba11` |

| 隔离运行（逻辑标签） | 实际结果与限定 |
| --- | --- |
| Windows `b2-independent-c2032cd6505047dc9352a70b57dd70d4` | Node 24.19 / SQLite 3.53.3；新候选隔离 `npm ci` exit 0；五文件目标 109 total / 4 pass / 105 skip / 0 fail；原默认 `npm test` 2473 total / 1596 pass / 877 skip / 0 fail；五个显式 OpenCode 集成文件 46 pass / 0 skip / 0 fail。Windows 严格 Unix skip **不是**原生保护通过；集合重叠不得相加。 |
| 原生 `b2-supplement-93kMC8Au` | 明确 19 文件：409 total / 400 pass / 9 skip / 0 fail；Node 24.19 / SQLite 3.53.3 / ext4，原生 Node exit 0、独立 wait 的外层 WSL exit 0。运行前实测私有 `0700` TMP/祖先（candidate `0755` 位于私有 `0700` 运行目录内）、euid 0、umask `077`，运行后重新核对。复制隔离依赖前确认 lock 与安装版本/哈希一致；**不是**新原生安装。 |

原生补充的外层证据标签 `b2-native-supplement-ab0f7d3d51204df7b32de5ca27b7775f`，evidence-index SHA-256 `4358946969b9e7b6c1eda104413c12ff67ca1346115a74e43c97ebdd9ae5b71e`；原生 stdout SHA-256 `296616d35973813e518ebfc3b114a7665c9e1188942bf28e324d83834ba9449e`。前/后环境、完整 tracked code/test/package 哈希、九份 source/candidate overlay 哈希、原生与外层独立退出及原始流均归档于该标签。A–F 源绑定检查及 callback identity/post-return 屏障、默认 metadata 拒绝由该次真实运行支撑，不借旧日志充当新结果。没有执行 Linux 全仓库测试。

历史记录不追认：最初 399 total / 388 pass / 2 fail / 9 skip 的 RED 仍是 RED；此前最终原生运行的 `runtimeBefore` 实际在运行后采样，且缺少外层 parent-wait 实现。新补充在 test launch **之前**持久化实测环境并独立等待 WSL，仅关闭本次限定门禁；不改旧证据时间或标签。

## 未获授权与下一门禁

本次没有 target5 restore/handoff、新 recovery family、实际清理或删除准备度；不证明硬件掉电、全局 fencing、实际运营隔离或真实 ownership/time authority。**NEXT C2** 只冻结新恢复家族的精确记录、API、清单与崩溃契约；未冻结不得将 S3/H4/Q5 写成 source-ready。B1 writer、P6 fault、P7 外部环境和 H1–H3 人工门禁继续待办。未确认备份保留窗口、不启动实际服务/恢复/迁移/删除、不授权生产发布；旧 LAN 与默认 OFF 保持不变。
