# IM v2 P5-B 恢复准备：限定范围验证（NONRELEASE）

**版本边界：**基线 `2085da6f3400e7202710de0005575f1a9a290e85` + 经核验的 27 文件 overlay，另有本验证记录与[路线图](roadmap.md)；此处的计数针对该版本证据，不能冒充已部署版本、P5 全部验收或生产授权。[冻结的准备契约](im-v2-recovery-prepare-contract.md)规定四个管理方法、证据格式与冲突处理；[P5-A 验证](im-v2-p5-backup-validation.md)是独立先决切片。提交后的版本以本记录随同的提交为准；审查运行时不是一个预先干净的最终提交。

## 范围与安全界限

- `stageCandidate`、`previewRecovery`、`prepareRecovery` 和 `getRecoveryStatus` 完成本地 P5-B 切片。四条来源路线为 fresh bootstrap、注册 v3 备份、隔离的真实 closed-v3 源、注册 v4 snapshot；来源 locator/真实证明、stage → 持久 hold → 候选复制的顺序受约束。候选始终隔离并 prepared/paused；无监听、自动启用、切换或 release writer。
- 非 fresh 源保留原始来源 hash 与完整 closure proof。规范 copy intent → base v2 → normalization →（v3 时）pause v2 链约束仅候选的 WAL→DELETE 转换；完整类型化逻辑证据校验，不直接删除原始来源 sidecar。未知的部分归一化拒绝自动认领并要求人工对账；已完成但 base 发布有缺口时只按原 intent/run 身份重试；P1 已完成而 staged 缺失时以实际持久 ID 恢复，不重造身份。
- RPO 报告为 **unknown**，绝非零损失或已完成权限对账。新 prepare 的过期检查在 fresh-clock 事务中执行并持久记录时钟 floor；回拨拒绝。权威持久 hold/plan binding 冲突（包括 staged）不替换、不重铸 plan，转为人工核对。已完成的精确重试与 status 为只读观察，不重新执行写入。Windows 严格原生保护不支持，不能用 skip 掩盖成原生通过。
- P5-C verify/seal/activate/release、P5-D 全故障矩阵、P6 purge、P7 双机 LAN/真实互联网与外部跨平台验收未交付；H1 来源隔离/真实 RPO 与权限审查/生产切换、H2 留存和实际删除、H3 网络部署等批准均未获得。30 天备份留存仍未确认；旧 LAN 行为与原 WP0–WP4 发布门槛不变。

## 版本绑定证据与限制

| 检查 | 实际结果 |
| --- | --- |
| Windows fresh isolated `npm ci` | 95；只证明该隔离安装及对应依赖锁版本。 |
| Windows 八个目标 | 170 total、67 pass、103 skip、0 fail；原生保护 skip 不计作通过。 |
| Windows full suite | 1367 total、1042 pass、325 skip、0 fail。 |
| Windows explicit plugin 五文件 | 46 pass、0 skip。 |
| 原生 Unix/Linux 八目标（Node 24.19 / ext4） | 170 total、166 pass、4 Windows-specific skip、0 fail；native 与 outer 检查均为 0 exit。使用匹配 lock 的既有 native 依赖，**不是** fresh native `npm ci`；没有完成 Linux 全仓测试。 |

上述目标、全套和插件计数有重叠，**不可相加**。最终更正的逻辑证据标签为 `p5b-final-corrected-4ab5789793e9`；`overlay-final.json` SHA-256 `4c4bfeb8544d32192a89dded7c07a681b7e5c6f5846b6002ea5d73ea2ae392c9`，`artifact-hashes.json` SHA-256 `3e5814d23cb39c4aea826f304dbbbf36cf4b5019f158a4bb6aed1b92829038d1`。独立 QA gen87 PASS；Oracle B1–B4 source PASS，gen85 digest/code/test corrections PASS。旧标签 `p5b-independent-6bfff43e6888` 的失败证据保留为历史，**并非**最后修正版本的结果：测试时钟 fixture 与过期旧合并测试分别更正；digest 的完整 framing/budget 源实现与 VM `Uint8Array` oracle 修正没有放松业务限制。函数级 B14501/B-1 digest 测试不等于公开 normalization budget 路径覆盖；实际原生 normalization 另有验证。

本地原生 fault/SIGKILL fixture 不是硬件掉电、全局来源隔离证明或生产授权。A 备份 producer 的 v4 输出归一到 DELETE，**不声称**存在真实 WAL-v4 producer 路线。工作树中未纳入 27 文件 overlay 的 fixture runner/证据文档及其他并行变更不属于本次提交，非候选运行时 import 依赖；不要把提交范围表述为整个工作树干净。没有启动生产服务、迁移、删除、发布、推送或发起 P5-C 实现。
