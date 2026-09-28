# IM v2 NONRELEASE 实施计划（P0–P7）

本计划对应 [恢复与留存契约](im-recovery-retention-v2-design.md)，原源码基线 `9b5ef8f`；本次 P5 文档交接核对 HEAD `f3d17094106c1833a2d0019a4c3cb19b25918fe7`。**用户已批准继续 NONRELEASE 开发，P5 技术裁决已批准、尚未完成；`P1/P2-FROZEN-1` 与已批准 P1–P4 语义保持。**生产恢复/activation/源隔离、实际删除、公网/DNS/成本、push 均未授权。父会话阅读本交接后分派 P5-A；本轮不重新评定 P1–P4 历史完成证据，旧复选框不是当前完成账本。

## 1. 范围、所有权和停机门禁

- 本轮 contractauthor 只修改 `docs/im-recovery-retention-v2-design.md`、`docs/im-v2-implementation-plan.md`。父会话负责核对和冻结；Oracle 裁决不由实现者临场重定义。
- **父会话当前 job board 指定的兼容 lane 独占** `tests/legacy-lan-compatibility.test.js`、`fixtures/legacy-lan-compatibility/*`（及其实际 tests 子目录版本）和相关 harness。本文不固化过期job编号；本lane不编辑这些路径，接收其最终证据。
- 已有工作树改动是其他工作，不能还原/覆盖。后续文件清单是父会话可分配的**提案 write-set**，不是本文授予现在写源码的许可。
- 不改原 PRD/roadmap、历史 v1–v3 DDL/checksum、既有 exports 语义、旧18787/DB/API/config、包名、LICENSE、Git远端；P5-A 最小 capability 扩展仅按下条范围，不自动 commit/push。
- 实现优先新增 `src/im/v2/` 和 `tests/im-v2-*.test.js`，避免“全局换版本”影响原 v3 publisher/runner。P5-A 唯一旧文件例外是 `src/im/backup-registry.js` 的最小 protected-copy capability；不是本次文档 lane 的写权限。每个包一个 writer；测试 reviewer 只读/独立证据，不与实现者抢写。
- 同一个包失败则阻断其后继。T1–T7及 P5 技术决定已裁决；P5 剩余是 A/B 精确 capability/完整记录编码交接与 C/D 实现故障证据，详见下文，不笼统重开 P5 方案。P4 历史 journal 门禁和 P6 planner/hash/forward-jump 范围保持。H1–H3 仍阻止未经授权的真实操作。

## 2. 有序工作包

### P0：原契约门禁（历史工作包）

**依赖：**已批准 NONRELEASE 方向、只读 Oracle 基线、本地源码核查。

**独占写集合：**上述两份新文档。

- [x] 核对 schema/config/contracts/messages/delivery/client/journal/http/retention/backup/registry/publisher/runner 与相关 PRD。
- [x] 提出 v4 增量实体、索引、canonical operation 映射、attachment reservation、严格 DTO/错误与状态前置条件。
- [x] 将用户已批准、技术待审、人工操作待确认分别标注；明确无强制旧入口下线。
- [x] 纳入Oracle T1–T7裁决，修订准确schema、wire、候选nullable/双审批与阶段门禁。
- [x] 按Oracle最终条件修正v3_import：真实备份四字段全有/全无、始终RPO/隔离、持久完整preparePlan；`P1/P2-FROZEN-1`生效。
- [ ] 原 P0 交接要求：父会话阅读修正章节后分派 P1 单写者，生成固定 DDL/checksum golden；本次 P5 交接不以此历史条目要求重新分派 P1。

**文档验证/完成：**UTF-8、相对文档链接、`git diff --check` 及定点约束核对；当前交接仍只修两份文档，不跑运行测试、不创建运行数据、不 stage/commit/push。下一实施包是 P5-A。

### P1：独立 v4 schema 与显式候选迁移

**依赖：**已生效的`P1/P2-FROZEN-1`及父会话单写者分派；不等待P4/P5/P6后续格式细节。

**P1唯一写集合：**`src/im/v2/schema.js`、`src/im/v2/schema-history.js`、`src/im/v2/migration.js`；`tests/im-v2-schema.test.js`、`tests/im-v2-migration.test.js`、`fixtures/im-v2-schema/*`。仅新增，旧schema常量3及全部exports/manifests不改。

- [ ] `src/im/v2/schema.js`仅导出公共 `IM_V2_SCHEMA_VERSION=4`、`SUPPORTED_IM_V2_SCHEMA_VERSIONS=Object.freeze([4])`、`assertImSchemaV4`；schema-history.js为内部模块，历史常量3/exports不改。
- [ ] 从冻结字段表生成完整 DDL、indexes、CHECK/PK/FK、marker golden；历史 manifest 固定副本与原1/2/3逐对象交叉校验。
- [ ] `src/im/v2/migration.js`公开 `initializeImSchemaV4(db,{policy,creationRef,limits})`、`migrateImSchemaV4(db,{expectedVersion:3,policy,migrationRef,limits})`；内部生成身份/epochs，preparation记录固定input_hash与持久ID，不接收public identity/epoch参数。
- [ ] 两API精确返回 `{preparationRef,instanceId,instanceCreatedAt,initialEpoch,importEpoch,schemaVersion:4,status,writeMode}`；fresh importEpoch=null；exact retry读取持久ID和真实当前status/writeMode，不生成epoch、不降级verified/active、不伪报paused。
- [ ] fresh-v4与explicit v3→v4首次成功只在paused离线独占候选生成prepared/run可空状态；无自动监听/激活，API不能证明旧源关闭。
- [ ] 验证所有导入wire IDs、text/title/correlation/attachment metadata、canonical prefix、fingerprint/hash、FK、真实连续ACK前缀、seq/subject、retained_floor=1；不截断、不修复。
- [ ] 迁移默认上限10000messages/100MiB verified content/10000 other records/10s soft，先投影count/length，再stream验证且一次最多一个附件；预算超限回滚全部DDL/backfill/marker，不分阶段或调高。
- [ ] backfill content/reservations/operation mappings；旧 key/hash不改，stable identity保留，新 epoch明确生成并持久。
- [ ] 所有 backfill+marker同事务，重复匹配参数幂等，任意中途 fault不留下部分v4。

**必须验证：**fresh4/v3→4成功；v1/v2/partial/unknown拒绝；foreign_keys关闭拒绝；manifest额外trigger/index拒绝；非UUID/前缀碰撞拒绝；历史hash不变；attachment空blob违反旧CHECK而reservation+删除live行可行；100%新FK满足；EXPLAIN expiry/scrub索引；旧所有业务构造器误接v4拒绝；旧v3 publisher/runner目标仍3。仅隔离临时数据库。

P1额外固定：mapping准确拼接CHECK、旧v1 storage UUID/hash不变；live/expired未scrub的reservation↔payload一对一，scrub后无payload且message字段已清空；payload无reservation/应有却缺payload拒绝。覆盖preparation kind nullable CHECK、run三种candidate kind CHECK、verified/active必须run、active双审批字段必填、prepared无激活要求，验证插入/转换顺序无循环依赖。

**回滚：**事务回滚/保留失败候选供检查；不写原源、备份或运行DB。P1不能打开监听器。

### P2：v2 contracts/config 与最小 auth/ACL/clock 边界

**依赖：**P1、P0 wire冻结。

**提案写集合：**`src/im/v2/contracts.js`、`config.js`、`auth.js`、`acl.js`、`clock.js`（均在该 v2 目录）；`tests/im-v2-contracts.test.js`、`tests/im-v2-auth-acl.test.js`、`tests/im-v2-clock.test.js`。

- [ ] 实现strict Scope/Fence/Operation、Message/Tombstone/SyncItem、分页cursor、固定errors；sync/ACK/expiry response必有progressPending；schema与wire版本分开。
- [ ] fingerprint固定序列、originEpoch包含而current centerEpoch不包含；76字符canonical storage key不可截断/哈希替代唯一性。
- [ ] 完整90d/7d/180d策略+version/hash/effectiveAt；enabled/expiry/purge/backupCleanup默认false，writeMode默认paused；缺失生产容量/lease设置不可启写。
- [ ] v2独立active principal/联系人ACL；reservation→message→conversation检查先于expired；原 credential验证算法与撤销语义保持，不把新的schema断言注入旧模块。
- [ ] 每一业务事务内核epoch，不仅HTTP；trusted clock守护回退/溢出，到期统一now<expiresAt有效、相等到期。具体maintenance forward-jump/anchor算法仍在P6冻结。

**必须验证：**版本错/epoch缺失/重复参数/大小/规范base64/hash错误；title null与仅附件合法；双空拒绝；陌生ID和已撤联系人均404、不泄漏tombstone；策略缺字段/hash不符/日期溢出/clock回退拒绝；config未启用零新业务写入。API测试凭据仅由fixture运行时生成，不落提交文件。

### P3：发送、delivery 与 HTTP 中心

**依赖：**P2。按已裁决的candidate run状态契约测试center；实际bootstrap/recovery能力在P5实现，P3不得以快捷activation绕过其门禁。

**提案写集合：**`src/im/v2/messages.js`、`delivery.js`、`http.js`、`server.js`；`tests/im-v2-messages.test.js`、`tests/im-v2-delivery.test.js`、`tests/im-v2-http.test.js`。

- [ ] 新接受事务原子写message/attachment+reservation/key+mapping/content/delivery/audit；capacity满只阻止新send，已接受事实可查。
- [ ] 当前epoch相同key重放、冲突、7天到期不复用；旧origin可查结果、snapshot缺失返回SEND_OUTCOME_UNKNOWN、旧origin POST拒绝。
- [ ] lease内部requestId使用76字符 `v2:<centerEpoch>:<requestId>`；request hash含epoch/instance/credential，result含epoch并复核；旧lease_requests保留但不重用，恢复失效旧leases。
- [ ] 独立handled与真实ACK前缀；expiry receipt不能写acked_at/read_at；每批≤100项、每次推进≤1000seq，progressPending必返；精确重放只继续已证实前缀，不造ACK。
- [ ] v4持久 ACK cursor 可落后于最大真实连续 ACK 前缀（≤1000 seq推进预算），但自身每一序号必须有真实ACK证明且不得超过持久 handled；v3导入前仍必须等于最大真实连续ACK前缀，初始backfill使用该验证结果，既不更改旧源也不放松导入检查。
- [ ] trusted internal `auth.withWrite(principal, scope, callback, finalCheck?)`：可选同步 finalCheck(result) 在业务回调和最终刷新时钟、身份/不可变入口scope/active/policy/write gate全部通过之后运行且只运行一次；使用 `guard.current()` 的最终观察时间，不再刷新；仅抛错表示失败，返回值不作为授权输入（thenable拒绝），不是HTTP/body参数。回调不得再刷新时钟或控制事务；其抛错回滚业务并保留安全时钟floor。P3 delivery 后续仅对 ACK/receipt/renew/new acquire 使用当前lease校验；release精确released tuple/历史查询不因此变成新lease授权。
- [ ] /api/v2严格header/body绑定；**新v4中心** /api/v1固定426；旧独立v1服务仍原行为；不fallback到LAN。
- [ ] history tombstone保留位置；expiry GET/reply/read拒绝；下载每块重验ACL/epoch/live，已发headers故障断流。
- [ ] center factory要求active，监听器生命周期仍归调用者；没有自动迁移、自动启动或自动启写。

**必须验证：**真实SQLite备份前后两笔发送（后笔不在候选）→新epoch对旧后笔查询UNKNOWN且0重POST；旧已知key过期仍可查接受事实；客户端不能以404安全重试旧epoch；恢复后seq数值重复不能跨epoch ACK；[live,expired,live]连续页及混合receipt处理；删除中间delivery造成明确gap失败；late receipt/current lease成功、旧fence失败；expired正常ACK整批零变更；未授权资源不泄漏expired；下载过期/撤权/hash错误不交付。HTTP listen仅临时loopback测试，非真实服务。

追加错误断言：epoch表中不存在的旧/未知origin缺key仍UNKNOWN；当前origin缺key可404。payload GET/新reply/read expired为CONTENT_EXPIRED；包含未ACK expired项的ACK整批EXPIRY_RECEIPT_REQUIRED；已ACK expired精确重试保留旧时间。测试超1000前缀progressPending与重放，不能只测100项小页。

### P4：独立 journal v2 与客户端对账

**P4 journal API 增补（不改 schema / 旧接口）：** `getReceivedFact(partitionId,{streamEpoch,seq,kind})` 读取经校验的隔离事实快照（缺失返回 null，不推断 delivered/read，也不读取附件文件）；`listBatches(partitionId,{state,after?,limit?})` 分页读取 pending/confirmed，包括原始批次与由同分区同流同序号 expiry fact 推导的 ACK disposition：`liveItems`、`expiryRequired`、`expiryConfirmed`、`replayAllowed`。只要有 expiry fact 就不可原样重放 ACK；该布尔值仅表示本地资格，不证明远端新鲜度或附件文件。后续剩余 ACK/expiry 必须按正常配额分别创建新 canonical 批次，不覆盖旧批次。分页沿 `(partition_id,state,created_at,batch_id)` 索引，最多读取 limit+1（limit 默认 20、最大 100），cursor 为规范 base64url 编码的 `[2,"batches",partitionId,state,createdAt,batchId]`，绑定查询范围；每页短快照，不保证跨页快照一致。`clearLease(partitionId,{streamEpoch,instanceId,generation})` 只在活动分区内匹配本地 fence 并清空租约三个字段；全 NULL 返回 `cleared:false`，不证明曾释放该 tuple，也不执行远端释放。`findOutgoing({centerOrigin,agentId,originEpoch,clientMessageId})` 只在该 origin/agent 的活动和历史分区内有界查找；两个匹配为歧义冲突，未命中不证明远端安全 404。上述接口在旧 storage PASS 时尚不存在；client 待独立审查后再接入。

**P4 client 续跑与 HTTP 契约澄清：** 将来本地 `ackPending` continuation 可用 `{partitionId,pendingAfter,confirmedAfter,phase}`，固定扫描预算、不得无限后台轮询，且此结构不是网络字段。JSON 响应以 envelope 内 protocol/epoch 为权威；响应 headers 可选，但如存在必须一致；二进制响应必须具备相应 headers。P3 HTTP 源码无需因该澄清修改。

**P4 storage stamp 前置条件（仅开发，client 后续独立实现）：** journal 同步 `getChangeStamp()` 返回冻结 `{connectionId:string,localChanges:bigint,externalVersion:bigint}`；connectionId 仅同一进程的同一实际 DB 连接共享，不持久化、不是密钥，也不进入 wire/JSON。`total_changes()` 包含本连接原生及 journal 写入（回滚也可能增长，保守失效）；`PRAGMA data_version` 只比较同连接存活期内其他连接提交，不可跨连接比版本。两次 externalVersion 夹住 localChanges，期间不同则固定 `STORAGE_UNAVAILABLE`，不循环、不启读事务；调用必须无外部事务且 FK ON、同步 FULL/EXTRA。SQLite 有限计数器不构成永久密码学变更证明。未来私有 continuation 必须保留四字段 `{partitionId,pendingAfter,confirmedAfter,phase}` 与 stamp；相同值 JSON 副本可接收，伪造、过期或重启后的 token 拒绝。扫描读操作用匹配 stamp 前后夹持；漂移返回 `PLAN_STALE`，不自动无界重启。仅当同一 connectionId 且 externalVersion 不变时，调用方自己的同步 journal 写入可吸收 localChanges 增长，不得吸收外部提交。最后同 stamp 检查是完成判定的线性化点；返回后新工作不包含在本次结果。同步 journal 回调必须纯粹且不得重入或触发无关写入。最多 10 个 list 页及 10 个 mutation 调用；stamp 常量查询单独计费、不算页数，但不宣称整体扫描为 O(1)。本段只准 storage stamp，不授权 client 接入、服务或真实 DB 操作。

**依赖：**P3；P4实现前固定完整journal DDL/FK/manifest/payload bounds。100项/1000seq/10轮预算已裁决，不再待选。

**提案写集合：**`src/im/v2/journal.js`、`client.js`、`client-files.js`；`tests/im-v2-journal.test.js`、`tests/im-v2-client.test.js`、`tests/im-v2-client-recovery.test.js`。

- [ ] 单独journal文件、version2 manifest；centerOrigin/stableInstanceId/agentId/centerEpoch完整partition。
- [ ] `acceptance_state=pending|accepted` 与 `reconciliation_state=none|required|remote_unknown` 独立；remote_unknown不擦除accepted messageId/time。新旧kind收件事实并存，serverConfirmed之前本地cursor不前进。
- [ ] exact replay刚处理批次最多10轮继续前缀，仍progressPending则显式返回pending，不无限后台循环；server confirmed但本地facts缺失必须resync，不跳cursor；/me epoch变化不得自动切journal。
- [ ] epoch变化立即暂停自动发送/ACK/receipt；manual reconcile仅新增分区和决定引用，不清空旧outgoing/receipt。
- [ ] 新operation要显式用户决定（包含可能业务重复），不把旧pending搬新key；旧key查询结果按sourceProtocol验证fingerprint。
- [ ] 附件持久化和hash验证后journal先于ACK；过期race重新sync、持久expiry fact、专用receipt，保留旧file receipt。
- [ ] 下载地址和落盘子目录绑定当前partition，防同URL不同中心/agent串用；旧client-files若有protocol错误耦合则独立适配，不能改旧导出。

**必须验证：**commit前/后/ACK响应丢失/expiry receipt响应丢失的重启；文件被替换/长度hash不符不ACK；同message后变tombstone不覆盖旧事实；本地accepted远端UNKNOWN仍保留accepted；重复seq/message跨epoch不碰撞；scope forged拒绝；manual reconcile前零mutation；新分区历史已知ID不自动ACK；旧v1 journal文件字节/manifest不变。

### P5：技术已批准的备份与恢复交接（未完成）

**依赖与顺序：**沿用 P1/P3/P4 前置成果，不改其 schema、wire/journal 或旧 LAN。严格 **P5-A → P5-B → P5-C → P5-D**；父会话确认上一 owner terminal、阅读完成契约/证据后才分派下一 owner。同一 recovery.js 的 B/C 必须顺序单写者。具体契约以 [设计文档](im-recovery-retention-v2-design.md)第 6 节为准。

#### P5-A：保护层 + 版本化 backup + 私有 registry + v3 bridge（单一 owner）

**提案写集合：**`src/im/v2/backup.js`、`src/im/v2/backup-registry.js`；`src/im/backup-registry.js` 仅最小 protected-copy capability；`tests/im-v2-backup.test.js` 及对应批准的 recovery fixtures。需要额外保护层文件时由父会话先明确文件归属，不默认扩写旧模块。

- [ ] 先冻结 A 的完整 manifest `formatVersion:2`、registry `recordVersion:3` 编码和 bridge capability 签名/生命周期；与 B 明确 sourceCatalog capability shape，不能让后续按猜测写 consumer。sourceId/createdAt 来自实际 DB，manifest 绑定 schema/hash/time/approval metadata；record 字段和 publicationKind 按设计第 6.3 节。
- [ ] root 0700、files 0600、euid/可信祖先、无 symlink/稳定普通文件单链接；`coordination.sqlite` 与 `registry/{artifacts,records,holds,releases}` 布局；同 inode 持 SQLite 锁时禁止 raw fd close，允许 coarse lock。全程顺序旧 source verified scope→新 registry→candidate→业务事务。
- [ ] canonical metadata：固定字段序普通对象 JSON.stringify、UTF-8 无 BOM/格式空白/尾换行、≤64KiB、严格 shape+重编码 bytes 相等、SHA-256 raw canonical bytes。exclusive pending→file sync→hard-link no-replace→owned temp unlink→dir sync；不确定失败保留证据，不假称干净回滚。
- [ ] 真实 v4 snapshot 用 P1 full validator；旧 backup 支持 1–3、旧 publisher current=3 不变。新 writer 私有闭包，只能实际 snapshot/verified bridge mint provenance，无 public registerArtifact/path accessor。
- [ ] registered v3 只能经旧 registry 真实 withVerifiedBackup/withDiscoveredBackup 锁内 protected copy，锁持续至独立 bytes 副本验证完成；禁止跨 root hardlink/泄露源路径与 writer。新副本进新 registry 后再持有 recovery hold；旧 cleanup 可删旧 artifact，不能删新副本。未注册 v3 只作为 closed-source，不能冒充注册 provenance。
- [ ] 实现/交付 durable stageHold、不可变 prepareBinding 和 releaseMarker 存储能力；未绑定 hold 同样阻 cleanup；不自动释放/删除 hold、不引入 P5 TTL/cleanup executor。

**A 前置接缝与交接：**当前旧 registry callback 仅 metadata/recheck，protected-copy 尚不存在，正是本包唯一批准的旧模块扩展。须明确 importedRecordHash/sourceEvidenceHash 的原始取证字节及无自引用生成顺序；完整 manifest approval metadata、stage/binding/terminal proof 文件编码不能临场发明。P1 公共 validator 无 limits 参数，较低预算接入核实已有内部 validator/budget，不改 P1 public API。以上有限冻结可由 A 作者随包完成；没有要求改旧 schema 或等待整项 P5 重新批准的冲突。

**A 验证：**真实 v4 snapshot/validator、registered v3 bridge、hash/manifest/identity 不符拒绝；real lock 中跨进程 old cleanup 不能越过 copy；old cleanup 后新副本仍有效；权限/链接/no-replace/fsync 失败保留正确证据；legacy 常量与 publisher/registry 原行为回归。与 D 合并的进程证据必须绑定实际源码树，不提前标 PASS。

#### P5-B：plan / stage / prepare / status（依赖 A）

**提案写集合：**`src/im/v2/recovery-plan.js`、`src/im/v2/recovery.js`；`tests/im-v2-recovery.test.js`、对应 recovery fixtures。承接 A 实际产物后，先冻结 sourceCatalog/admin/approval/evidence capability 精确参数、stage/status/release DTO、stage intent/比较证据/terminal proof 编码与 sourceClosedEvidenceRef 绑定，再实现消费方。

- [ ] 冻结 facade `createImV2RecoveryServices({root,sourceCatalog,authority,approvalAuthority,evidenceAuthority,policy,clock,limits})` 和八个方法；操作不接 raw paths/自报来源 metadata/预选 IDs。admin、prepare|activate|release-hold approvals、isolation/authReview adapters 同步 literal true，refs 不替代授权；内部所有 candidate/coordinator/只读 source DB 生命周期，无 network admin/listener/autowrite。
- [ ] stageCandidate({requestRef,sourceRef,kind,isolationAckRef},ctx)：fresh sourceRef/isolation=null，非 fresh 要可信隔离；唯一 durable intent+内部 runId/candidateReference，exact requestRef 幂等、不同参数冲突。backup 先独立复制到新 registry→hold 新副本→candidate copy；hold 绑定 stageHash 不预需 prepare hash。
- [ ] fresh 真实 P1 initializer；v3 只暂停新 candidate（记录动作）后显式 P1 migration，使用内部生成持久 initial/import epochs；snapshot 关闭保留旧 marker 到 prepare。staged 为外部状态，不能改 P1 DB enum；fresh 无假 backup。
- [ ] previewRecovery({runId}) 只有 snapshot 生成内部新 epoch并持久完整 canonical plan；prepareRecovery({runId,preparePlanHash,approvalRef}) 读 protected plan/校验审批，DB approved_plan_hash 绑定完整计划。所有 sourceEvidence 严格按设计 tagged unions；v3 真实备份四字段全有、closed v3 才全 null。
- [ ] RPO 只有完整稳定且有界 messages/key/ACK/read 身份事实集合比较可 measured；禁止 count subtraction。不可得/不稳定/超预算→unknown/null counts+comparison hash；authChanges 默认 unknown、独立 manual review。上限 10000 messages/100MiB/10000 other/10s soft，只可降。
- [ ] prepare 绑定 immutable hold binding；fresh/import 使用 P1 initial epoch；snapshot 安全更高 counter/new epoch，保留旧 epochs/requests、失效 leases，progress 取真实 ACK 最大连续前缀，不借旧 expiry receipts。source messages/keys/ACK/read 不改。
- [ ] status 对账持久 refs/state/holds/nextAction，无 paths/secrets，显式 staged/prepared/verified/active/failed/indeterminate；仅本地 RECOVERY_* 错误，准确集合见设计第 6.9 节，不增加 wire codes。

**B 验证：**四类 source 分派、request exact retry/冲突/跨重启、source kind 降格拒绝、无 fake bootstrap 证据、stage hold 先于 candidate copy、enabled v3 仅新副本 pause、snapshot staged 不提前改旧 marker、prepare hash/expiry/审批篡改、RPO 等行数不同身份也能检测、源不可用/预算耗尽 unknown、只读 status 不泄密。P1 内部 Date.now/随机 ID 按实际结果取值，不假装 facade clock 能预选 P1 身份时间。

#### P5-C：seal / activation / release（同 recovery 文件顺序 owner，依赖 B）

**提案写集合：**承接 `src/im/v2/recovery.js`、必要的 `src/im/v2/recovery-plan.js` 与 `tests/im-v2-recovery.test.js`；A/B owner 必须 terminal，无并行写同文件。

- [ ] 锁内核验 prepared/run/hold/P1 content，同事务 run+center verified/paused；checkpoint BUSY 或不明 writers 拒绝，关闭全部候选连接，main 数据完整且 file/dir sync 后 closed-file hash；不手删 WAL/SHM。
- [ ] seal 按设计完整字段/verification 四个 true canonical 编码，文件名 sealHash；外部 no-replace durable 发布，不把 sealHash 写回 DB。
- [ ] previewActivation({runId,sealReference,authReviewRef,isolationAckRef,activationRef},ctx) 持久独立 activation plan，绑定最终 sealHash/refs/newEpoch/TTL；activateRecovery({activationPlanHash,activationApprovalRef,sealReference},ctx) 只读回 protected plan，不收调用者 plan。
- [ ] 先 exclusive lock，再 closed seal/file hash，之后才任何 clock anchor/guard write；open 点查后 fresh transaction 重验 approval/epoch/state/expiry，active fields/audit 原子，最终 expiry check 后 commit、close/persist，write_mode 仍 paused。
- [ ] anchor 已提交但 activation 失败→RECOVERY_REVERIFY_REQUIRED，重新 verify+新 seal/plan+新 approval；不忽略 hash、不回退 clock。active commit 响应丢失→exclusive 只读 completed proof exact retry 原结果，无旧 preactivation hash 要求，无第二 epoch/activation；不得 active→failed 或擦 active fact。
- [ ] releaseRecoveryHold 必须 admin+独立 release-hold approval+candidate active/failed stateEvidenceHash；持久 release marker，不删 hold、不自动释放，坏/不明证据 fail closed；未确定状态保持 indeterminate。

**C 验证：**seal replace/候选改变/错误审批拒绝；hash 校验前零 guard write；anchor 后失败必须新审批；最终 expiry rollback；commit lost response 正确重放；verify/seal 中断可对账；release 无 candidate proof/错 terminal/hash/批准均拒绝，失败 hold 仍保留。

#### P5-D：四来源真实进程 fault matrix（依赖 A–C）

**提案写集合：**`tests/im-v2-recovery-process.test.js`、`tests/fixtures/im-v2-recovery/*`，必要专项由父会话明确归属。实现修改须退回所属 owner 顺序处理，不抢写 recovery.js。

| 来源 | 必须证明 |
| --- | --- |
| fresh | 无 source/backup/hold 假证明；P1 initial epoch；完整 stage→active 仍 paused |
| registered v3 | old verified lock 内 bridge、new independent registry、hold 后 copy；enabled artifact 不改而新 candidate pause/import |
| closed v3 | 真实 closed-source evidence/隔离、无伪 registered backup、RPO unknown/measured 合法边界 |
| registered v4 snapshot | 保留 stage 旧 marker，prepare 新 epoch/counter；备份后 source 新增接受/ACK/read/凭据变化不被覆盖，旧未知发送仍 UNKNOWN |

- [ ] 每个持久化阶段真实进程 crash/kill 与响应丢失：intent、独立 artifact/manifest/record、stage hold、candidate copy/pause/migration、prepare plan/binding/commit、verified commit、checkpoint/close/sync、seal publish、activation plan/anchor/commit/close、release marker。记录进程重启对账结果与 no-replace/file/dir sync fault；无不明文件自动清除。
- [ ] 跨进程未绑定/已绑定 hold 均阻 cleanup；source copy 锁和新 registry 锁竞争；seal replacement、candidate 别名/软硬链接/文件调包；coordination inode fd 生命周期不会使锁失效。
- [ ] 原 source 的备份后更新、原 backup bytes/manifest/registry 证据、旧 journals 保持原事实，候选变更只在新工作区；old cleanup 后新独立副本不受影响。生产源隔离与跨机器全局 fencing 不由测试证明。
- [ ] Windows native strict **UNSUPPORTED** 为预期，不能 best-effort/fake platform 转 PASS；WSL/Linux **原生 ext4** 提供真实权限、fsync/no-replace、跨进程持久 hold/恢复证据，挂载 Windows/网络盘不算。skip/NOT RUN 不计 PASS；进程崩溃测试不称硬件断电证明。

**P5 完成门禁：**A/B 完整编码/API 交接已落定、C 行为与 D 四来源 fault matrix 有真实证据并审查通过，父会话才可称 P5 NONRELEASE 完成。无 P5 TTL/自动清理，P6 旧备份 30 天仍未确认；生产恢复、activation、源隔离、旧 LAN 18787/runtime 均未由此授权。

### P6：留存预览与原子维护

**依赖：**P3/P5；P6实现前固定indexed planner查询、candidate hash准确编码、forward-jump与clock anchor算法。T3/T4数值与字段裁决已定。

**提案写集合：**`src/im/v2/retention.js`、`maintenance.js`、`backup-cleanup.js`；`tests/im-v2-retention.test.js`、`tests/im-v2-maintenance.test.js`、`tests/im-v2-backup-cleanup.test.js`。

- [ ] indexed keyset有限预览；content.policy_hash留历史deadline，maintenance.execution_policy_hash FK当前策略，candidate.contentPolicyHash绑原策略；开关改变新增policy，不改原deadline。
- [ ] expiry与physical gates分开且默认false；未启用apply改变行数**零**；每批独立批准，expired未ACK可处理。
- [ ] content状态+scrub+run/audit事务原子，永久key/消息/附件reservation/delivery保留；正真ACK/read不改。
- [ ] ≤100业务行+最多2证明行、≤10MiB logical scrub bytes（非WAL/pages）、candidate_json≤65536独立限额；10MiB附件+metadata超限整组hold，不提高预算；complete=false零apply；1000ms软预算不保证中断单SQL。
- [ ] fresh clock与plan TTL、候选漂移/approval撤销/hold新增都失败；已completed精确幂等。
- [ ] audit180d只处理明确普通action，保护migration/recovery/purge证据，未知action hold。
- [ ] backupCleanup默认false、无已批准retention就无执行计划；newest/in-use/recovery/migration hold检查。30天不进入默认参数。

**必须验证：**关闭时content/attachment/audit/backup零删除；logical-only expired但bytes仍在；scrub删除live附件行且reservation仍可ACL识别expired；完全10MiB附件+metadata超限不拆；混合未ACK过期后handled推进而ACK仍NULL；审批精确批次防换候选、事务中fault全rollback、completed重试零二次删除；回退/巨大正跳/长时间停机plan stale；EXPLAIN和限额实测不全库hash、不VACUUM；普通审计可到期且completion证明仍在；容量满停新接受而不回收key。

**回滚：**停止维护与新写，保留当前DB与完成证明。不能以旧备份覆盖已accepted/已过期事实；SQLite可见删除不称secure erase，离线checkpoint/VACUUM另许可。

### P7：有界集成、跨平台与交付门禁

**依赖：**P1–P6全部专项通过、父会话当前job board的兼容lane提供旧LAN证据。

**提案写集合：**`tests/im-v2-integration.test.js`、`tests/im-v2-clean-process.test.js`、`tests/fixtures/im-v2-interop/*`；只更新本计划和配套契约中的状态/证据段。若需要新的package script、CI、入口示例，父会话先单独确认write-set；不顺带改旧README/PRD/roadmap。

- [ ] Windows Node24基础/HTTP/journal/无宿主互通；将严格registry unsupported与其余失败分开。
- [ ] WSL原生Linux文件系统Node24，真实严格备份/registry/恢复process验收；清楚记录平台、版本、命令、退出码、pass/fail/skip、源码hash。
- [ ] 真正fresh clone/clean checkout的批准测试环境，`npm ci`后运行与当前版本匹配的专项；不借现有node_modules、runtime config、用户凭据。未获得外部clone环境则写NOT RUN，不虚报。
- [ ] 通用JS client/MCP薄适配与Python标准HTTP两个独立进程最小互通，不建设多套SDK；scope若需v2 MCP单文件适配，先由父会话明确归属。
- [ ] 集成场景包含发送响应丢失、恢复旧epoch UNKNOWN、内容过期与附件race、跨重启receipt恢复、旧v1固定升级错误和旧独立v1仍工作。
- [ ] 检查changed-files/import graph无旧入口自动upgrade、无宿主/工单依赖进入core；父会话兼容lane的测试/fixtures/harness不被本lane修改。
- [ ] 在一次适当专项通过后执行现有`npm test`作为兼容门禁；不无故重复full suite。若后续修改发生在相关路径，重跑相关专项与必要回归。
- [ ] Oracle审查实际diff/故障证据，独立QA按场景复核，再由父会话给NONRELEASE完成结论；不把本地PASS称生产或公开发布。

## 3. 必须留存的验证矩阵

| 编号 | 风险 / 断言 | 最小可信证据 | owner阶段 |
| --- | --- | --- | --- |
| V01 | 旧v3 publisher/runner不能被常量4破坏 | 原exports/version golden、旧专项通过；v4被旧模块拒绝 | P1/P7 |
| V02 | key不复用、不碰撞 | canonical编码边界、同sender同UUID跨epoch两映射；旧source hash不改；冲突事务零新增 | P1/P3 |
| V03 | 真实恢复导致旧send unknown | 实际snapshot前后写入、复制候选、换epoch、抓HTTP调用计数无自动重POST | P3/P5/P7 |
| V04 | expiry不得伪造delivery | 未ACK过期、receipt与ACK分别查DB、handled跨连续页且acked_at/read_at NULL | P3/P6 |
| V05 | 连续性与迟到receipt | 页间过期、gap故障、重复页/receipt、旧fence拒绝、有效新lease重交 | P3/P4 |
| V06 | 下载/ACL/hash竞态 | chunk间撤权/过期、长度/sha失败、journal与ACK顺序可观测 | P3/P4 |
| V07 | 默认OFF是真零删除 | 内容/附件/audit/backup前后计数与hash，apply拒绝且原文件仍在 | P6 |
| V08 | 批次有界且准确批准 | 候选调包、预算满/超、clock跳变、fault rollback、completed replay | P6 |
| V09 | 恢复crash与幂等 | process kill各边界、seal匹配、同run重入、无源覆盖/无新epoch重生 | P5 |
| V10 | 隔离能力不能夸大 | 同目录并发锁测试；手工ack与跨机器无法证明的声明分别呈现 | P5/P7 |
| V11 | fresh clone与平台真实性 | 干净输入manifest、npm ci命令与exit、Windows/WSL原生路径类型及skip原因 | P7 |
| V12 | 旧LAN不变 | 父会话当前job board兼容lane最终结果与所有权确认；本lane不改其tests/fixtures/harness | 兼容lane / P7汇总 |

每次证据绑定准确source tree/hash与命令，不把不同版本pass相加；日志仅保留随机测试ID、状态、聚合计数，正文/附件/凭据不作为提交物。动态runtime文件放隔离测试目录，进程关闭后按测试自身所有权清理，不能扫删用户data/downloads。

## 4. 失败与退出准则

- 父会话若发现具体字段/约束与裁决冲突，先列出准确接缝并修这两份契约，再交对应单写者；不重开 T1–T7、不临场改 PK/CHECK/版本目标。当前先交 P5-A，A/B 编码与 capability 交接按本节关闭；P4/P6 历史门禁范围保持。
- schema/manifest、候选hash、权限或clock不可信：fail closed，保存源与候选证据；不能“修好再说”原运行DB。
- 停止新功能时：停新写/新监听器/维护，保留全部新accepted、key、ACK/receipt、journal、完成证明。旧服务独立继续不是把新DB回滚成旧DB。
- 技术实现全部通过仍只是NONRELEASE；真实LAN双机/公网不同网络、恢复切换、实际删除、TLS资源/DNS/费用、备份保留窗口、许可证/仓库治理仍各有人工门禁。
- 本轮交付只修改两份文档，报告字段/章节核对与具体剩余阶段门禁；不commit/push、不请求立即执行真实运维操作。

## 5. 当前执行账本（2026-09-28；B0.3 限定范围收口）

本节追加记录当前进度，**第 1–4 节及其复选框、顺序和优先级保留为历史交接**；其中“下一包 P5-A”“P5 未完成”和旧 write-set 不是本次任务状态或新增写权限。当前已核本地 HEAD 为 `cc5bed7bb18eac36ee3cc2a412ac47fb29c1b96e`；用户已要求更新 TODO 并继续按 PRD 推进 NONRELEASE 开发。原 [PRD](prd/a2a-msg-agent-im-v1.md)、[路线图](roadmap.md)的发布与外部验收门禁仍独立存在。

### 5.1 已接受与当前包

| 工作包 | 当前状态 | 证据及边界 |
| --- | --- | --- |
| P1–P5 | 已接受并本地提交 | 分阶段限定范围验收；P5 A–D 收口见 [进程恢复验证](im-v2-p5-process-validation.md)及其上游记录。不代表生产恢复或整份 PRD 发布验收。 |
| P6-A | 已接受并本地提交（`65d0727`） | [只读预览验证](im-v2-p6-preview-validation.md)；v4 预览不可执行，备份预览仅配置诊断。 |
| P6-B0.1 | 已接受并本地提交（`7c98249`） | [schema 5 验证](im-v2-p6-schema-v5-validation.md)；存储、完整校验和纯记录不授予写权限。 |
| P6-B0.2a | 已接受并本地提交（`d9d0907`） | [转换所有权桥验证](im-v2-p6-conversion-bridge-validation.md)。 |
| P6-B0.2b | 已接受并本地提交（`cc5bed7`） | [候选转换引擎验证](im-v2-p6-conversion-engine-validation.md)；隔离转换通过不等于 converter rollout。 |
| P6-B0.3 | 限定范围代码、安全、PRD 忠实度、独立 QA 与完整兼容门禁已接受；本次提交收口 | 以 [最终时间契约](im-v2-maintenance-time-contract.md)及 [B0.3 验证记录](im-v2-p6-time-validation.md)为准；仅内部时间权威，不代表整个 P6 或生产启用。 |

B0.3 当前仅为**内部 synthetic ACTIVE / PAUSED schema 5 时间引擎**：可信 fixture owner 关闭构造连接后独占目标；不是生产 ownership 集成，也不是未完成或已完成 recovery conversion candidate 的 writer。精确三个内部导出、factory-only 薄转导出、三个 facade 方法及私有会话检查的语义按最终时间契约执行；未接 server/MCP/CLI/recovery 运营入口，未复用转换候选，未交付 maintenance executor。

最终 B0.3 审查绑定 SHA-256（基于 `cc5bed7` 加限定 overlay，而非提交后 clean-commit 重跑）：

- `src/im/v2/maintenance-time-internal.js`：`605e1f74191160b708514f0212b9674637c78d7069e4bb6c7bcd4992ed5956f9`。
- `src/im/v2/maintenance-time-authority.js`：`b28b969f2be8d9419b2069e91ad0e4d0ff5fa3f48d6da67b00938403a10dbe6e`。
- `docs/im-v2-maintenance-time-contract.md`：`e66097355cbd15ba8f51aafe4486be2c9184c4fbddec24ac97d577fb67fb0855`。
- 原生生命周期 fixture `error-lifecycle.js`：`2df8a2b29328eb0103a02f99eb2a05d132193a5b6fcca2026394202151db58f6`；schema 5 契约的过时生命周期句仅在最终测试**之后**作本文档收口修订，新文档 hash 不冒充当时测试输入。

最终固定输入证据：Windows Node 24.19 / SQLite 3.53.3，专项 115 total / 3 pass / 112 skip，关联专项分别 133 / 33 / 25 pass；全量 2338 total / 1536 pass / 802 skip / 0 fail，五个显式插件测试 46 pass / 0 skip。原生专项 115 total / 114 pass / 1 skip，关联专项分别 133 / 33 / 25 pass；原生套件与独立 WSL 外层均退出 0。各范围重叠，**不得求和**；详细输入与环境限制见验证记录。旧 104/1 与 3/102 是先前快照，不是最终结果。

### 5.2 接下来按依赖推进的 TODO

1. [x] 完成 B0.3 最终代码、安全、PRD 忠实度与独立 QA 的限定范围合并裁决，并取得固定输入的完整兼容证据；四线及源码/测试 hash、平台和 skip 边界见 [验证记录](im-v2-p6-time-validation.md)。
2. [x] 补齐 B0.3 验证文档并在本次提交收口；专项 PASS 不标记整个 P6 完成，提交哈希由提交交接报告记录。
3. [ ] **当前兼容链：R1/C1 限定范围已接受；下一门禁 B2 未实现。**按 [schema 5 兼容门禁](im-v2-maintenance-schema-v5-contract.md#7-backuprecovery-compatibility-and-rollout-gate)、[v5 兼容交接契约](im-v2-schema-v5-compatibility-contract.md)及 [R1+C1 验证记录](im-v2-runtime-backup-v5-validation.md)推进。固定执行输入为基线 HEAD `f74b20de1e503e6cc00bf29be0b33d512eabc074` + 八份 overlay，不是将来的 clean commit 重跑；上方 B0.3 历史证据保留，不扩大为 v5 恢复/备份运营就绪。
   - [x] **R1 — 限定范围已接受：**现有 clock factory API 不变；构造 BEGIN 内完整 exact4/5 dispatcher 校验并固定 cookie + validated version/checksum、交叉核 marker；热路径漂移在 callback/clock write 前以 `STORAGE_UNAVAILABLE` 拒绝，不自动采用/rebind。v5 head 有界核 current epoch + actual chain tip，允许 history 无 head，不永久 pin epoch、不热扫全历史；普通 clock 只写 `im_clock`，不刷新维护锚/head/session。范围仅 `clock.js` + 新 runtime tests；代码、安全、契约忠实度、独立 QA 与隔离兼容证据已接受，见验证记录；不证明全历史防篡改。
   - [x] **C1 — 限定范围已接受：**新增纯 `backup-v5-records.js` 的三个精确 encode/decode/hash 导出及 manifest/record/source 三种记录；manifest3/schema5/tool `im-v2-backup-2`、record4/native-v5、source2/registry4，固定字段序见新契约。严格 ordinary enumerable data、Proxy-before-reflection、fatal UTF-8、canonical decode、safeint/-0、65536 bytes；hash 是 raw canonical JSON bytes，无 domain prefix；旧 v4/native-v4 record3/source1 bytes 不变。四线审查与独立 literal vectors/隔离兼容 QA 已接受；纯 hash 不产生 provenance，也未接 publisher/registry。
   - [ ] **B2 — NEXT / 当前契约与集成门禁，尚未实现：**factory/调用 DTO 不变；真实 full snapshot 选 native4/5，分别 exact inspector 后选旧/新编码；private registry writer 只消费真实 version-aware proof。保持 native timeout/drain/source ownership、imported-v3 和原 authentic budget；hold/binding/release 仅在 hash chain 绑定实际正确 source 的验证成立时沿用，cleanup 始终 false，无 TTL/删除。
   - [ ] **C2 — PENDING 文档门禁，无 recovery writer：**冻结新 target5-only recovery family 的 stage/locator/staged/closure/copy/base/normalize/intake union/handoff/prepare intent/result/plan/seal/activation/completion/release/status 精确记录，以及 API inputs/source bindings/inventories/crash classifications/3–5 digest tables 和独立 literal vectors；未冻结前 recovery source work 为 NOT READY，不临场编字段序/DTO。
   - [ ] **S3 — FUTURE，依赖 B2 + C2：**实现显式 3/4/5 source、digest 与 candidate validators，保留旧 3/4 byte algorithms；包含全部 v5 metadata、count/length-before-fetch 和同一个预算。native5 snapshot→5 保留 sole conversion；registered4/fresh/v3 显式5 必须 genuine owned conversion→protected handoff→recover5；raw closed5/caller path 不支持。
   - [ ] **H4 — FUTURE，依赖 S3：**独立 proposed internal `createImV5RecoveryServices` 保留八个 operation names、仅 target5，新严格 family 显式 source/target schema/hash 和独立 recovery-v5 domain，seal2 明确 schema5；旧 target4 不变。source→workspace→candidate 下验证完成链/posthash，sync/no-replace 建立独立非 hardlink archive + immutable handoff，durable 后才移交 mutable candidate；converter 在 obsolete current-posthash 检查前拒绝，旧 facade 永久排除。首个 clock floor/prepare write 前 durable prepare intent；中断仅 exact committed projection 或 manual reconcile。v5 prepare 原子 epoch/counter/run/center/progress/lease revocation/paused + DELETE HEAD ONLY，保留 anchors/sole transition并 full v5 validate before commit，不降 floor/重置 generation、不转移维护 session。
   - [ ] **Q5 — FUTURE / NOT RUN，依赖 H4：**native5 与 converted4 的 backup→register→restore→verify→ACTIVE/PAUSED roundtrips，验证保留历史/head-only removal、archive 不变、无旧 seal reuse 和 native faults；准确区分 Linux strict 与 Windows portable/UNSUPPORTED，无 power-loss 声称。仅未来测试/审查通过后可使用限定审计表述“isolated schema 5 runtime + versioned backup/restore verified; ACTIVE/PAUSED, maintenance unanchored, no operational time authority”。
   - [ ] **独立 operational ownership/time gate — FUTURE：**生产真实归属与时间审批组合仍须单独冻结/验收；不得复用 synthetic-time opener 或 recovery-conversion target。通过 Q5 不建立维护 authority/session，不能据此开放 converter rollout 或 B1 执行。
4. [ ] 单独批准并冻结 B1 maintenance writer 的目标/事务、逐批审批、拒绝时 floor、持久结果/status 契约，再实现 expire、scrub、audit 原子执行及独立 P6 故障/预算矩阵；B0.3 时间就绪证据不替代删除批准。
5. [ ] 完成 P7 跨平台、clean 环境、跨框架和真实双机 LAN / 不同网络互联网验收；H1 真实恢复/来源隔离/RPO/切换、H2 启用与逐批删除/备份窗口/容量、H3 TLS/部署位置/公网资源与成本分别取得人工确认。原 WP0–WP4 治理和发布门禁继续保留。

历史发现（B0.3-CR-01）：内部锁存错误与抛给回调的 Error 对象曾共享身份；回调改写 `code` 可使后续分类执行外来 getter。旧快照专项 PASS 不覆盖此反例；该反例不被追认。

后续历史复审又发现回滚失败的 `MAINTENANCE_DURABILITY_UNCERTAIN` 被先前 fault 遮蔽、构造失败未确认关闭异常缺乏全新安全边界。最终 `605e1f74…` 修正与 `2df8a2b2…` 生命周期回归、独立复审已关闭三项；最终固定输入 QA 另证实可变错误隔离、回滚拒绝、构造清理及 cross-target/restart 路径。回调抛出外来 public Error 的分类视实际路径而定：事后抛出是 `MAINTENANCE_APPROVAL_DENIED`，被捕获的重入是 `MAINTENANCE_INVALID`；并非一切外来错误都归为 INVALID。原生测试所有权下清理未确认资源，不证明产品回滚、物理断电或全局 fencing。

### 5.3 持续边界与独立运维记录

- 默认 `enabled=false`、`writeMode=paused`，expiry/purge/backup cleanup 全部 OFF；内容/重试/普通审计策略仍为 90/7/180 天，备份 TTL 为 null/未确认，30 天不进入默认值。备份 cleanup 保持 configuration-only preview，无枚举或删除执行器。
- MCP 缺失依赖修复属于**另获用户批准且已完成的独立操作**，不列为本 PRD 功能 TODO，也不把其他 MCP 工作树改动并入 B0.3 范围。
- 本次仅更新本节现时 TODO、路线图并新增 R1+C1 验证记录；第 1–4 节历史交接仍为当时快照。未配置项目/父目录 `.sybermem`，不创建或声称记忆索引 PASS；仓库验证文档是持久记录。生产操作、服务、配置、真实删除和 push 不由本账本授予权限。
