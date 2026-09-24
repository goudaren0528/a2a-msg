# IM v2 NONRELEASE 实施计划（P0–P7）

本计划对应 [恢复与留存契约](im-recovery-retention-v2-design.md)，源码核对基线`9b5ef8f`，本轮HEAD为`61052a3`（旧兼容测试独立提交）。**用户已批准开发，Oracle最终要求的v3_import备份/RPO修正已落实，`P1/P2-FROZEN-1`生效。未授权真实服务、迁移、恢复、切换或删除。**这是冻结的实施契约，不代表功能已实现或交付；父会话阅读修正章节后分派P1。

## 1. 范围、所有权和停机门禁

- 本轮 contractauthor 只修改 `docs/im-recovery-retention-v2-design.md`、`docs/im-v2-implementation-plan.md`。父会话负责核对和冻结；Oracle 裁决不由实现者临场重定义。
- **父会话当前 job board 指定的兼容 lane 独占** `tests/legacy-lan-compatibility.test.js`、`fixtures/legacy-lan-compatibility/*`（及其实际 tests 子目录版本）和相关 harness。本文不固化过期job编号；本lane不编辑这些路径，接收其最终证据。
- 已有工作树改动是其他工作，不能还原/覆盖。后续文件清单是父会话可分配的**提案 write-set**，不是本文授予现在写源码的许可。
- 不改原 PRD/roadmap、历史 v1–v3 DDL/checksum、原 exports、旧18787/DB/API/config、包名、LICENSE、Git远端；不自动 commit/push。
- 实现优先新增 `src/im/v2/` 和 `tests/im-v2-*.test.js`，避免“全局换版本”影响原 v3 publisher/runner。每个包一个 writer；测试 reviewer 只读/独立证据，不与实现者抢写。
- 同一个包失败则阻断其后继。T1–T7已裁决，剩余具体门禁仅为P4完整journal DDL、P5 seal/hold与版本化adapter故障验证、P6 planner/hash/forward-jump实现细节。H1–H3仍是实际操作授权，缺失不影响隔离测试，阻止真实操作。

## 2. 有序工作包

### P0：契约门禁（当前包）

**依赖：**已批准 NONRELEASE 方向、只读 Oracle 基线、本地源码核查。

**独占写集合：**上述两份新文档。

- [x] 核对 schema/config/contracts/messages/delivery/client/journal/http/retention/backup/registry/publisher/runner 与相关 PRD。
- [x] 提出 v4 增量实体、索引、canonical operation 映射、attachment reservation、严格 DTO/错误与状态前置条件。
- [x] 将用户已批准、技术待审、人工操作待确认分别标注；明确无强制旧入口下线。
- [x] 纳入Oracle T1–T7裁决，修订准确schema、wire、候选nullable/双审批与阶段门禁。
- [x] 按Oracle最终条件修正v3_import：真实备份四字段全有/全无、始终RPO/隔离、持久完整preparePlan；`P1/P2-FROZEN-1`生效。
- [ ] 父会话阅读修正章节后分派P1单写者，生成固定DDL/checksum golden，不能伪造未计算checksum。

**验证/完成：**UTF-8、相对文档链接、`git diff --check`及定点约束核对；只修两份文档，不跑测试、不创建运行数据。本轮不实施P1，由父会话另行分派。

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

### P5：备份版本分派与恢复候选状态机

**依赖：**P1/P3/P4；P5实现前冻结seal/hold/release规范编码、sourceEvidence与持久计划证据、v3/v4 adapter故障矩阵。三种candidate kind与双审批已裁决，不阻塞P1表定义。

**提案写集合：**`src/im/v2/backup.js`、`backup-registry.js`、`recovery.js`、`recovery-plan.js`；`tests/im-v2-backup.test.js`、`tests/im-v2-recovery.test.js`、`tests/im-v2-recovery-process.test.js`、`tests/fixtures/im-v2-recovery/*`。

- [ ] 版本化v4 verifier/publisher，v3 source采用原v3验证；不能修改旧全局version或把旧registry格式当v4支持。
- [ ] 三种candidate kind准确绑定preparation/真实来源；fresh无假backup/isolation/RPO；v3_import始终有RPO/隔离且old_epoch=NULL，真实备份四字段全有/确无备份时全无，拒绝partial。可信管理层判定来源，调用者不得把备份来源降格NULL；snapshot只接有epoch的v4来源。
- [ ] v3_import未知差异status=unknown、计数NULL不是0；备份来源snapshotCompletedAt取真实completedAt，无备份且未知快照时间才可NULL。无备份实际关闭源仍需protected persisted sourceEvidence，不冒充注册备份。
- [ ] prepare approval绑定完整来源/candidate/RPO/隔离，整份preparePlan含sourceEvidence受保护持久保存并可读回验证hash=approved_plan_hash；第二份activation plan绑定runId/preparePlanHash/sealHash/candidate/newEpoch/authReview/isolation/时间/activationRef，active记录保存activation_plan_hash/activation_approval_ref；verify不能activate。
- [ ] 所有备份支持候选（含v3_import）执行artifact验证、copy前持久hold、源隔离、exclusive copy与修改前basehash验证；candidate_base_hash=已验证原备份file hash。原备份immutable，无备份源不伪造backup/hold。
- [ ] prepared→verified→active、candidate_base_hash与外部closed-DB seal分工；写verified后成功checkpoint WAL→main、关全部连接；BUSY/不明WAL或SHM拒绝seal，不删除未知侧文件。
- [ ] 先exclusive控制再验sealHash/DB hash，reopen后小状态+activation事务仍paused；active exact retry匹配完成记录，不再要求active DB hash等于旧seal；监听另一步。
- [ ] registry→candidate锁顺序；copy前no-replace/fsync持久hold，显式durable release marker，completed/failed不自动release；坏hold拒绝cleanup。旧v3 cleanup不认识hold，必须可信源保护或新protected registry copy，不能作为v4清理路由。
- [ ] 每个状态边界可故障注入、同runId/activationRef幂等；状态不确定时保留证据，禁止自动删锁/覆盖源。

**必须验证：**backup/manifest/candidate hash任一篡改拒绝；candidate路径已存在/别名/软硬链接拒绝；旧writer关闭前无candidate mutation；prepare/verify/seal/activate前后kill/crash可续查且不换epoch；activation响应丢失无第二activation；verify后候选变化失败；source不可得报告RPO unknown不作0；备份后新增凭据/撤销无法证明时activation需manual review；原备份与原源accepted行未覆盖；本地竞争锁失败。跨机器旧writer隔离只能报告人工边界，不通过测试宣称global fencing。

**平台门禁：**Windows原生严格registry失败是预期，不得改为best-effort成功；Linux/WSL原生ext4执行真实保护/fsync/no-replace/跨进程锁测试。未支持平台写明unsupported，skip不能计为PASS。

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

- 父会话若发现具体字段/约束与裁决冲突，先修两份契约再交P1单写者；不重新泛化讨论T1–T7，也不让fixer临场改PK/CHECK/版本目标。P4/P5/P6各自后续门禁按准确产物关闭。
- schema/manifest、候选hash、权限或clock不可信：fail closed，保存源与候选证据；不能“修好再说”原运行DB。
- 停止新功能时：停新写/新监听器/维护，保留全部新accepted、key、ACK/receipt、journal、完成证明。旧服务独立继续不是把新DB回滚成旧DB。
- 技术实现全部通过仍只是NONRELEASE；真实LAN双机/公网不同网络、恢复切换、实际删除、TLS资源/DNS/费用、备份保留窗口、许可证/仓库治理仍各有人工门禁。
- 本轮交付只修改两份文档，报告字段/章节核对与具体剩余阶段门禁；不commit/push、不请求立即执行真实运维操作。
