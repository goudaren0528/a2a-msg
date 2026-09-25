# IM v2 P6-B0.1 schema 5 验证记录（NONRELEASE）

**证据绑定：**本地基线 `65d0727cde532f6909a5166c5028b3998e54d6a7` 加 14 份限定 overlay；逻辑运行标识 `p6-b01-final-compat-ce9346a70bb84bb4960c3fca348a78ec`，原生标识 `p6-b01-final-cf3c9787b2c044ffa8be116efe4c574c`。这是提交前候选版本的测试与最终 artifact QA，不是未来 clean commit 的重新执行；不代表部署、生产迁移或发布批准。参阅 [路线图](roadmap.md)、[schema 5/时间契约](im-v2-maintenance-schema-v5-contract.md)、[维护交接契约](im-v2-maintenance-contract.md)和 [P6-A 验证](im-v2-p6-preview-validation.md)。

## 本包范围和精确工件

- 新 schema 5 精确 manifest 共 **58 个 SQLite 对象**，checksum `80eba5e6ce61261d31ec495216c3b6eb8c7a8f0c87edcbb1440372353f495435`；新增 DDL golden 的 SHA-256 为 `a3e6b496ffcdc1d5863bacf56af261ec53c2892de44199b796f71a6abdf4a552`。冻结 v4 checksum `c950eb40692a72f918c8976d4bef8cab0b9e357495b01df75e0ab2d1b0b5f216`、公开导出和 fresh4/import4 行为不变。新增 golden 经独立语义审查及哈希比对，不以哈希相等单独替代语义审查。
- 从 v4 内部校验器机械提取继承的业务校验逻辑：v4 仍单独检查自己的精确 marker、manifest、预算及完整业务事实，不接受 v5；新 dispatcher 对 4/5 均作完整验证，绝非仅凭版本标记放行。没有消费者 rollout。
- v5 增加类型化转换历史、数据库全局连续（跨 epoch）时间锚历史与可选且必须属于当前 epoch 的链 tip head。无 head 不生成可信时间会话。五种独立规范纯记录为 `timeProposal`、`anchorEvidence`、`conversionPlan`、`conversionProof`、`conversionComplete`；严格形状、字节与哈希校验只是数据一致性，不是授权或维护会话。
- sanitizer 在任何 reflection 前拒绝 Proxy，验证零 trap 调用及固定安全错误。普通非 Proxy 自有 DATA 属性触发的预算代码有意保留为重新净化过的错误，以维持历史预算兼容性；两种代码均拒绝验证，不赋予权限。

## 绑定的验证结果

| 验证范围 | 本次候选结果及边界 |
| --- | --- |
| Windows 隔离环境 | Node 24.19 / SQLite 3.53.3；新隔离 `npm ci` 安装 95 个包。明确指定五组 schema/codec/v4/migration/clock 测试：413 pass、0 skip。全量：2086 total、1484 pass、602 skip、0 fail；另五个明确插件组：46 pass、0 skip。全量与明确组重叠，不能相加当作互异测试。全量 stdout SHA-256 `b2effaee4c23ec056fb233db80f841347f90b9b085ece0d400de1f60caffb2d1`。|
| 原生 Unix 与独立 WSL 外层 | 11 个指定目标：563 total、560 pass、3 个 Windows 专属 skip、0 fail；原生加独立 WSL 外层结果 0。原生 stdout SHA-256 `34d7a0dd49abe8a0da09c17834786af87087d8bc8f983dd7b8445fa48182f7e2`。ext4、私有 0700 TMP、umask 0077 在运行前捕获元数据；匹配的原生依赖是**复用**，不是 fresh install。三个 skip 不证明 Windows 严格保护路径获得原生支持；没有运行完整 Linux 仓库测试。|
| 最终 artifact 绑定 | overlay manifest SHA-256 `7d72dbb96e7507315c169840b0dc27ee8403980901c47988f2b446f2b3a97a61`；`RESULT.json` SHA-256 `aef38985d0856a75f72cd58742049546dd2e87e69b74f38b5ce188eb8544417f`。实际测试前后 286 份候选文件和 14 份源码 hash 匹配；全部 346 份非 overlay 基线文件未变化。生成的 Python `__pycache__` 不属于输入或提交。source/security、纯 codec、DDL/golden、回归及最终 artifact QA 均为限定范围 PASS。|

QA 的隔离 foreign-instance anchor（处于有效 identity transition 时）和重新哈希但未注册的 policy 负例通过。历史一次 **401 total / 398 pass / 3 fail** 运行仍为红色，裁定为额外预期断言不匹配；它没有被隐藏或改记为 PASS，最终版本测试及 hash 绑定取代它作为当前证据。合成 conversion-shaped DB fixture 只验证读侧形状，并非真实迁移证明；进程级原生 SQLite 验证也不是硬件掉电保证。

## 未交付及安全门槛

本包**没有**候选转换器、私有所有权桥、时间权威、实际维护写执行器、v5 runtime/backup/registry/versioned recovery/facade 兼容或真实 v5 backup→restore→activation roundtrip。B0.2 必须先取得 genuine private ownership bridge；B0.3 必须先取得 independently owned-v5 target/time seam。后续仍须按 schema→runtime→backup→registry→versioned recovery→facade 完成兼容、验证并保持恢复后的 paused 状态，才可考虑转换器 rollout；P6 真正 enable/delete、P7 与 H1–H3 人工批准仍未完成。

P6-A 的 v4 计划始终是 `SCHEMA_UPGRADE_REQUIRED` 且不可执行；备份预览只作配置诊断，备份 TTL 尚未确认。默认 expiry/purge/backup cleanup 仍关闭；不授权启动服务、修改生产数据、迁移、恢复切换、删除或发布。
