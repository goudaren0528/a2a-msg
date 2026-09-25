# IM v2 P5-A 备份仓库本地验证（NONRELEASE）

**版本边界：**提交基线 `f3d17094106c1833a2d0019a4c3cb19b25918fe7` 加 23 份经审核的源码、测试、fixture 与契约 overlay；以下结果是该候选的独立隔离运行证据，不是未来整洁提交的重新执行，也不是生产恢复、启用或发布许可。具体编码与接口见 [P5-A 存储契约](im-v2-recovery-storage-contract.md)，依赖与剩余门禁见 [v2 实施计划](im-v2-implementation-plan.md)。

## 本切片及边界

- 仅实现独立 v4 原生 SQLite 备份和私有 record-v3 仓库、可信且真实注册的旧 v3 备份在锁内独立复制、受保护规范元数据、持久 stage hold / prepare 绑定及精确幂等重试。清理检查始终禁用；没有公开 release writer、自动删除或 TTL 执行器。旧 LAN `18787` 不变。
- 默认及硬上限为 128 MiB 文件、10,000 个元数据目录项，并有消息、内容、其他记录和时间预算；受信选项只能降低限制，嵌套扫描共用预算。时间验证是软边界：同步 SQLite 调用和 fsync 无法中途取消，须在操作前后检查。异步原生 backup 超时也不取消 SQLite，关闭源连接前必须 drain。
- 原生 Unix/ext4 严格检验私有目录、权限、inode、no-replace 和文件/目录 fsync；故障注入仅模拟受控 fsync/IPC 失效，**不证明掉电恢复或生产部署**。已有 coordination inode 不经不受控原始 close。
- 窄范围旧 backup、publisher、registry 的 artifact 读取修正只用于**已完成且关闭的独立快照**：immutable URI 只读打开；只要已有 WAL、SHM 或 journal，哪怕空文件也拒绝，不 checkpoint、不删除旧残留、不改哈希、manifest、原始 main 字节或 live source 日志模式。历史 v1–v3 schema 常量及校验和不变。publisher 保留原身份对比，只有经审查的 WAL adapter 差异获例外：LF 规范化源码 SHA-256 固定为 `bb37b40b891e7a17716ab0d25524ac27ba36649b6d9cc4358545272f181ebc37`；旧 schema 和 migration runner 仍按 `61052a3` 原文锁定。已有旧侧文件不会自动修复。

## 独立验证记录

| 隔离批次（仅逻辑运行标签） | 结果 | 边界 |
| --- | --- | --- |
| `p5-final-a557b9b0811c4723877139f7b9111f67`（W0） | 独立 Windows `npm ci --ignore-scripts --no-audit --no-fund` 安装 95 packages 成功；显式五个 OpenCode plugin 文件 46 通过、0 跳过，exit 0。初次全套 1,197 总计、974 通过、1 失败、222 跳过，exit 1，日志保留。 | 唯一失败是旧测试将 publisher 与 `61052a3` 逐字比较，不容许已审核的 WAL artifact-read 差异；不能抹去此失败。 |
| `p5-schema-followup-7590195d96ed4ca7ac20020204e2b1f5`（W1） | 仅修正测试的 publisher 基线断言后，Windows schema 专项 102/102 通过、0 跳过，exit 0；全量 `npm test` 1,197 总计、975 通过、0 失败、222 跳过，exit 0。全套结果 manifest SHA-256 `65951933386edb91ea7c1b812eab75cc84ab1e7b38a43cc16e7f7e22ee3d164a`；23 文件 allowlist SHA-256 `a5ce02e44fe79ee72b9b0883cdd98264e164b6379ef7ad27c9da57c98a36df51`。 | 复用 W0 同锁隔离依赖副本，非新一轮 npm 安装；旧 schema/runner 对照及导出、v1–v4 manifest/checksum 断言保留。Windows 跳过的严格 P5 项不是成功证明。 |
| `p5-final-independent-gi2m4xsb` | 新 ext4 克隆原生 Linux/Node 24.19.0 显式六个 backup 套件：100 总计、97 通过、3 跳过、0 失败，native/outer exit 均 0。包括已提交 WAL 正例、已有 side-WAL 拒绝、旧 v1/v2/v3 不变验证及 durability/hold 限界。 | 原生依赖复用先前相同 lock 的隔离安装，非新安装；只跑六个套件，不是 Linux 全项目测试。 |
| `p5-schema-independent-satlmwu8` | 新 ext4 克隆仅执行修正后的 schema 专项：102/102 通过、0 跳过，native/outer exit 均 0。 | 同锁原生依赖复用，未重跑六套件；该次仅测试断言发生变化，七份生产文件哈希在前后保持一致。 |

各批次计数有重叠，**不可相加**为互异覆盖；便携旧备份测试的 Windows 最佳努力结果不能替代严格原生 Unix 证明。原始 stdout/stderr、原生和外层退出码、argv、时长、各文件 SHA-256、前后哈希及候选 status 均由以上批次 manifest 保存；原失败证据未覆盖。无生产数据库、服务或远端操作。

## 待完成门禁

P5-B 的 stage/plan/prepare/status、P5-C 的 verify/seal/activate/release、P5-D 的崩溃矩阵均**未交付**。P6 留存策略/物理清理、P7 真正双机网络与外部互通、H1–H3 人工权限仍独立开放；30 天备份保留尚未确认。此记录不授权生产恢复/切换、启用 listener、物理删除、推送或发布。
