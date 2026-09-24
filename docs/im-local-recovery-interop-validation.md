# IM 隔离恢复与无宿主互通：本地验证交接（2026-09-24）

**版本边界：**本批次以本地迁移包 `f6e32d2` 为基线，随本次本地提交仅新增[恢复测试](../tests/im-restore-rehearsal.test.js)、[互通测试](../tests/im-clean-crossframework-process.test.js)及其三个[测试 fixture](../tests/fixtures/im-clean-crossframework/)；不预设本次提交 SHA。没有生产源码修改或真实运行数据库变更；本地验证不是生产备份/恢复、服务启动或部署许可。[路线图](roadmap.md)与[迁移包验证](im-migration-validation.md)保留 WP0–WP4 及 A1–A8 的未完成门槛。

## 本批次实际覆盖

- **隔离恢复切片：**受控备份经校验复制为独立可写候选；源写入方关闭后才激活克隆，通过 CA/主机名校验 TLS 续接。本地快照恢复的 RPO 允许候选丢失备份之后的源新增数据，原源数据须保留；没有全局写入 fence 或来源高级 journal 对账保证，不得用旧快照覆盖已 accepted 的原始记录。Windows 仅验证降级备份 primitive，原生严格 registry 在 Windows 不支持。
- **无宿主互通切片：**无 OpenCode 的 Python 标准库 HTTP 与实际 SDK MCP stdio 位于独立进程；验证 TLS CA/主机名、离线文本/二进制接收、附件校验后 journal 持久提交早于 ACK、JS 接收实例顺序重启及游标去重、正确收件人旧 fence 拒绝、相关回复和 Python ACK/read。已检查六个自有子进程退出/关闭，不据此保证全机器无孤儿进程。使用测试凭据/证书和隔离目录，未触及真实服务。

## 分批证据（计数不可累加为互异测试）

| 运行边界 | 实际结果 |
| --- | --- |
| Windows A7 专项 | 7 通过、0 跳过（1 parent + 6 subtests），47,657.5033 ms。 |
| Windows npm 全套 / 单独 plugin | npm：349 通过、57 跳过、0 失败，exit 0，49,442.658 ms；plugin：46 通过、0 跳过，exit 0，403.4859 ms。57 跳过恰为 publisher 6、registry 12、migration-process 6、runner 23、lock 9、严格 restore 1，**不是**缺少 Python。运行标签 `a7-batch-6f2b54d2723540d1946a5f82e4a0bf79`；工作树 135 文件在测试前、后及复核时哈希一致，以基线 HEAD 为对照，并非整个工作树 clean HEAD。 |
| 原生 A7 专项 | Node 24.19、Python 3.12.3、SDK 1.30 ext4；7 通过、0 跳过，exit 0，4,003.14263 ms。运行标签 `a7-acceptance-VIvCeZ55`，52 文件 manifest 全匹配。 |
| 恢复专项 | Windows 1 通过、1 严格模式跳过（降级 primitive），exit 0；原生 2 通过、0 跳过，exit 0，922.296558 ms。原生运行标签 `restore-acceptance-NSopqnDi`，47 文件全匹配；原生 A7/恢复共享 46 文件哈希一致。 |

最终测试文件 SHA-256：恢复 `1ea65b3d5a9d22590326c425092c75ce7a3d48204586b1fc4e070ba71f508e8e`；A7 `5deef65d09f259fa573d996fb838a319e7d2b5eeb57f7e6437ef971bb59b8b4f`。运行日志及 manifest 均为临时本地证据，不是已提交日志或跨机器可移植链接。代码 gen8、PRD exp5、性能/安全 ora3（恢复与 A7）及独立 QA gen9 均 **PASS，仅限上述版本/本地测试范围**；QA 复核实际日志及哈希。文档本次未另跑全套。

**仍未验收：**clean clone / `npm ci`、真实第三方框架认证、Python 崩溃后 journal 恢复、A1 真实双机 LAN、A2 不同网络 TLS、掉电/生产恢复及完整 A3/A5/A7/发布验收。外部审批撤销与 commit 原子性不保证；Windows 严格 registry 不支持；物理 purge 仍待设计。实际生产升级、恢复、资源、安全治理及发布均需另外审批；`private: true` 且无 LICENSE，不宣称已获开源授权。
