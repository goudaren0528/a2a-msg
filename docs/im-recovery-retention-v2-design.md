# IM v2 恢复与留存实施契约（P1/P2-FROZEN-1）

| 项 | 状态 |
| --- | --- |
| 基线 | 源码核对基线 `9b5ef8f`；本轮文档修订时 HEAD 为 `61052a3`，旧兼容测试由独立 lane 提交；不构成本契约实现 |
| 责任 | contractauthor 编写；Oracle 独立架构门禁；父会话控制范围、冻结和后续分配 |
| 授权层级 | **NONRELEASE 开发方案已批准**；Oracle 最终条件裁决要求的 v3_import 备份/RPO 修正已落实，`P1/P2-FROZEN-1` 生效；这是冻结的实施契约，不是已交付功能 |
| 配套 | [有序实施与验证计划](im-v2-implementation-plan.md) |

## 1. 决策层级与边界

**A：用户已批准的规范性边界。**旧 LAN `18787`、原 DB、配置、API 继续运行，无强制下线期限；新 IM 独立 TLS 端口、DB、配置。恢复使用人工控制；消息内容及附件 90 天，安全重试窗口 7 天，普通审计 180 天；内容过期、物理删除默认关闭。生产恢复、切换、实际删除，以及公网暴露、DNS、成本、资源须分别确认。此次文档不授权 push、rename、LICENSE、服务启动或运行配置变更。

**T：Oracle 已裁决的实施契约。**T1–T7 及最终 v3_import 备份/RPO 修正已落实，`P1/P2-FROZEN-1` 生效；父会话阅读修正章节后分派 P1 单写者，无需再开通用 Oracle 评审。冻结不表示实现或上线。第 10 节保留 P4/P5/P6 的具体后续实现门禁；这些不扩大已批准开发范围，也不代替人工操作许可。

**H：人工运维待确认。**真实恢复候选、备份来源、RPO 接受、旧写入方隔离、凭据复核/轮换、监听器切换、每个物理删除批次、备份保留窗口、平台生产支持均需独立确认。备份“超过 30 天”只是 **UNCONFIRMED 建议，不进入默认配置**。开发授权不代替这些操作授权。

仅实现单中心、双人会话与现有单附件模型。没有 broker、自动 HA、全局写入 fence、三套 SDK 或新审批平台。旧 LAN 兼容测试及 harness 归父会话当前 job board 指定的独立 lane，本 lane 不修改，见配套计划。

## 2. 已核本地约束与最小依赖图

| 本地证据 | 对 v2 的直接约束 |
| --- | --- |
| [schema.js](../src/im/schema.js)、[存储契约](im-storage-contract.md) | v1/v2/v3 的完整 sqlite_master manifest 与 checksum 均受校验；额外 im_ 表也会使旧断言失败。历史 DDL/checksum 不可修改。 |
| [backup-publisher.js](../src/im/backup-publisher.js)、[migration-runner.js](../src/im/migration-runner.js) | 两者直接比较全局 `IM_SCHEMA_VERSION`；将旧常量改成 4 会破坏现有 v3 工作流。 |
| [contracts.js](../src/im/contracts.js)、[messages.js](../src/im/messages.js) | 旧 fingerprint 含 v1 protocol；旧 key PK 为 `(sender_id,client_message_id)`，message_id UNIQUE。不能把 epoch 直接塞入旧 wire UUID 或重算旧 hash。 |
| [delivery.js](../src/im/delivery.js) | 旧游标依赖连续 delivery、acked_through；JOIN 漏行即损坏。过期不得删除 delivery skeleton，也不能冒充 ACK。 |
| [journal.js](../src/im/journal.js)、[client.js](../src/im/client.js) | 旧 journal v1 严格 manifest，outgoing 没有 centerEpoch；旧 recover 遇到 404 才重 POST。不能沿用该分支处理恢复后的未知发送。 |
| [http.js](../src/im/http.js)、[acl.js](../src/im/acl.js) | 旧入口仅 /api/v1；下载按块重验 ACL。v2 需要独立 tombstone-aware ACL/读取。 |
| [clock-guard.js](../src/im/clock-guard.js) | 旧 guard 在业务事务前持久 anchor，并支持 fresh 写事务/savepoint；不能先用其 anchor 更新巨大正跳，再用新值判断留存计划安全。v2 必须保留业务回滚不降低 clock floor 的保证。 |
| [retention.js](../src/im/retention.js) | 现有函数只是只读 advisory，依赖可重建旧正文 fingerprint、连续 ACK，扫描策略不能作为 v2 purge executor。 |
| [backup.js](../src/im/backup.js)、[registry 契约](im-backup-registry.md) | 备份 manifest、注册证据及哈希缺一不可；registry 原生 Windows 严格保护不支持；锁是本地目录协调，不是跨机器 HA。 |
| [PRD](prd/a2a-msg-agent-im-v1.md)、[恢复验证](im-local-recovery-interop-validation.md) | 已有本地恢复实验不等于真实恢复操作；保留已 accepted 源数据；真实网络/全新克隆等证据不能借用为已完成。 |

**冻结的 P1 模块边界：**`src/im/v2/schema.js` 导出 `IM_V2_SCHEMA_VERSION = 4`、`SUPPORTED_IM_V2_SCHEMA_VERSIONS = Object.freeze([4])`、`assertImSchemaV4`；`src/im/v2/migration.js` 导出第3.4节的 `initializeImSchemaV4`、`migrateImSchemaV4`；`src/im/v2/schema-history.js` 仅供内部历史 manifest 校验。旧 `src/im/schema.js` 的 `IM_SCHEMA_VERSION = 3`、`SUPPORTED_IM_SCHEMA_VERSIONS = [1,2,3]` 及所有旧 exports/默认目标不变。

依赖方向：v2 server → v2 HTTP/auth/ACL/messages/delivery → v2 schema/clock/contracts；v2 client → v2 contracts/journal + 安全文件落盘；v2 maintenance/recovery → v2 schema + 独立版本化备份适配。只直接共享经核实无 schema/protocol 耦合的 [transaction.js](../src/im/transaction.js)；其他旧模块默认不可注入 v4 DB。P1 的历史 manifest 固定副本须与旧版本逐对象交叉测试，不为复用而暴露或改写旧私有常量。现有 auth/ACL/clock 错误类型和 schema 断言均耦合 v1，不能假设仅换 server import 就可复用。

| 进程/入口 | DB | 允许协议 | 行为 |
| --- | --- | --- | --- |
| 旧 LAN | 原 legacy DB | 原 LAN API | 18787/配置/权限/末页阅读语义不变 |
| 独立旧 IM v1 | v1–v3 按原入口约束 | /api/v1、a2a-msg.im.v1 | 继续原行为，无强制截止 |
| 新 IM v2 | 完整 v4 | /api/v2、a2a-msg.im.v2 | /api/v1 返回固定升级错误；无转发或降级 |
| 旧 IM 模块误接 v4 | v4 | 任意 | 构造时 IM_SCHEMA_MISMATCH，绝不把 scrub 后的空正文当正常消息 |
| 新 IM v2 模块误接 v3 | v3 | 任意 | 拒绝，只有显式候选迁移可升级 |

## 3. P1：冻结的 schema 实施契约

### 3.1 类型、DDL 生成与版本规则

下表为冻结的完整**增量字段定义**。未列旧表沿用 v3 DDL 原文。所有新字段默认 `NOT NULL`，只有带 `?` 的字段为可空；不使用隐式 SQLite TEXT PK 可空行为，所有新 PK 列显式 NOT NULL。没有 ON DELETE CASCADE。表名/索引名为准确目标。P1 从以下约束生成 DDL 字节与 checksum 并固定 golden，不在本文伪造未计算 checksum。

约束缩写必须逐列展开，不能只靠 JavaScript 校验：

- `U` = TEXT，`typeof(c)='text'`，36 字符小写十六进制 UUID，四段连字符位置及每段长度精确校验（沿用 v3 identityUuid 的 GLOB 形状）；新生成值使用 `randomUUID()`。
- `I` = TEXT，typeof text，长度 1..255，无控制字符的操作引用；SQL 至少 enforce typeof/length，服务层拒绝 U+0000..001F/007F。历史 FK 标识用 `I`，不强改旧表宽松 ID CHECK。
- `H` = TEXT，64 位小写 hex，typeof/length/NOT GLOB 校验。
- `N` = INTEGER，`typeof(c)='integer' AND c BETWEEN 0 AND 9007199254740991`；`N+` 同时 ≥1。时间为 Unix 毫秒；加法必须预先检查溢出。
- `B` = INTEGER 且 typeof integer、IN (0,1)。`J` = TEXT、typeof text、`json_valid(c)`、长度 2..65536，JSON 精确 DTO 由服务验证。`E(a,b)` = TEXT 且 IN 给定枚举。
- 可空字段 CHECK 写成 `c IS NULL OR (...)`。跨行、当前 epoch、状态转换等规则不能用 CHECK 伪装成已受数据库保证，须在同一个 `BEGIN IMMEDIATE` 中验证。

`im_schema` 替换为 `version INTEGER NOT NULL PRIMARY KEY CHECK(version=4), migration_checksum TEXT NOT NULL CHECK(length(migration_checksum)=64)`；v4 校验器比较自己的全对象 manifest（含旧继承表和下列所有索引），拒绝未知 trigger/view、缺表、伪 checksum、FK 损坏。旧 v1–v3 校验独立存在，不扩大其支持集。

### 3.2 新增实体

| 表 | 精确列、主外键、CHECK |
| --- | --- |
| `im_center_epochs` | `center_epoch U PK`, `created_at N`, `origin E('fresh','v3_import','recovery')`, `recovery_counter N`；保存已知 epoch 身份，永不复用；counter 只对当前分支单调，不能证明跨机器全局顺序。 |
| `im_center_state` | `singleton INTEGER PK CHECK(singleton=1)`, `center_epoch U UNIQUE FK im_center_epochs(center_epoch)`, `recovery_counter N`, `status E('prepared','verified','active')`, `activation_ref I?`, `recovery_run_id I? FK im_recovery_runs(run_id)`, `updated_at N`；CHECK `(status='active' AND activation_ref IS NOT NULL) OR (status<>'active' AND activation_ref IS NULL)`；CHECK `status='prepared' OR recovery_run_id IS NOT NULL`。stable instanceId 继续来自 im_instance_identity。verified/active 必须绑定本候选 run，prepared 可以尚未有 run。 |
| `im_schema_preparations` | `preparation_ref I PK`, `kind E('fresh','v3_import')`, `input_hash H`, `source_version INTEGER?`, `source_schema_checksum H?`, `import_epoch U? FK im_center_epochs(center_epoch)`, `initial_epoch U UNIQUE FK im_center_epochs(center_epoch)`, `policy_hash H FK im_retention_policies(policy_hash)`, `created_at N`；精确 kind CHECK 见下文。记录初始化/迁移身份，重试返回已持久化 ID。 |
| `im_recovery_runs` | `run_id I PK`, `candidate_kind E('fresh_bootstrap','v3_import','snapshot_recovery')`, `preparation_ref I? FK im_schema_preparations(preparation_ref)`, `backup_id U?`, `backup_file_hash H?`, `manifest_hash H?`, `candidate_base_hash H?`, `candidate_reference I`, `old_epoch U? FK im_center_epochs(center_epoch)`, `new_epoch U UNIQUE FK im_center_epochs(center_epoch)`, `approved_plan_hash H`, `approval_ref I`, `isolation_ack_ref I?`, `rpo_report_json J?`, `auth_review_ref I?`, `activation_plan_hash H?`, `activation_approval_ref I?`, `status E('prepared','verified','active','failed')`, `created_at N`, `verified_at N?`, `activated_at N?`, `activation_ref I?`, `failure_code I?`。approved_plan_hash/approval_ref 仅指 prepare 审批；candidate kind、状态与 nullable 的精确 CHECK 见下文。candidate_reference 是受控引用不是调用者路径。 |
| `im_retention_policies` | `policy_hash H PK`, `version INTEGER CHECK(version=2)`, `effective_at N`, `message_retention_ms N+ CHECK(=7776000000)`, `attachment_retention_ms N+ CHECK(=7776000000)`, `safe_retry_window_ms N+ CHECK(=604800000)`, `audit_retention_ms N+ CHECK(=15552000000)`, `canonical_json J`；hash 必须等于规范序列化的完整策略 hash。变更时插入新版本策略，不 UPDATE 已引用策略。 |
| `im_content_state` | `message_id I PK FK im_messages`, `state E('live','expired')`, `expires_at N`, `expired_at N?`, `scrubbed_at N?`, `policy_hash H FK im_retention_policies`, `expiry_run_id I? FK im_maintenance_runs`, `scrub_run_id I? FK im_maintenance_runs`；CHECK live 时 expired_at/expiry_run_id/scrubbed_at/scrub_run_id 均 NULL；expired 时 expired_at 与 expiry_run_id 必须显式非空且 expired_at≥expires_at；scrubbed_at 与 scrub_run_id 同空/同非空，非空时 scrubbed_at≥expired_at。deadline = accepted_at+90d，不能在查询时静默换策略。 |
| `im_attachment_reservations` | `attachment_id I PK`, `message_id I UNIQUE FK im_messages`, `size INTEGER CHECK(typeof(size)='integer' AND size BETWEEN 1 AND 10485760)`, `sha256 H`；不存 name/mime/bytes。live 或 expired 但未 scrub 时，reservation 与 payload 必须一对一且 ID/message/size/hash 全相等；scrubbed 时有 reservation 的消息必须无 payload 行且 message 的 text/title/correlation 已 scrub。其他缺 payload、payload 无 reservation 均为损坏。无到 im_attachments 的 FK。 |
| `im_send_operation_keys` | `sender_id I FK im_agents`, `origin_epoch U FK im_center_epochs`, `client_message_id U`, `storage_client_message_id I`, `source_protocol E('a2a-msg.im.v1','a2a-msg.im.v2')`, `message_id I UNIQUE FK im_messages`；PK `(sender_id,origin_epoch,client_message_id)`；UNIQUE `(sender_id,storage_client_message_id)`；复合 FK `(sender_id,storage_client_message_id) REFERENCES im_send_keys(sender_id,client_message_id)`；准确拼接 CHECK 见下面SQL。message_id 与目标 key 的 message_id 一致由事务校验。 |
| `im_sync_progress` | `recipient_id I FK im_receive_state(agent_id)`, `center_epoch U FK im_center_epochs`, `stream_epoch U`, `handled_through N`, `updated_at N`；PK `(recipient_id,center_epoch,stream_epoch)`；handled_through < receive_state.next_seq，由事务校验。 |
| `im_expiry_receipts` | `recipient_id I`, `center_epoch U`, `stream_epoch U`, `seq N+`, `message_id I FK im_messages`, `recorded_at N`；PK `(recipient_id,center_epoch,stream_epoch,seq)`；UNIQUE `(recipient_id,center_epoch,stream_epoch,message_id)`；复合 FK `(recipient_id,center_epoch,stream_epoch) REFERENCES im_sync_progress`；复合 FK `(recipient_id,seq) REFERENCES im_deliveries(recipient_id,seq)`。事务核对 delivery.message_id、内容 expired 及当前 lease。 |
| `im_maintenance_runs` | `run_id I PK`, `center_epoch U FK im_center_epochs`, `kind E('expire','scrub','audit')`, `execution_policy_hash H FK im_retention_policies(policy_hash)`, `plan_hash H UNIQUE`, `approved_batch_hash H?`, `approval_ref I?`, `executor_id I`, `status E('previewed','approved','completed','rejected')`, `candidate_json J`, `result_json J`, `previewed_at N`, `expires_at N`, `completed_at N?`, `scan_rows N`, `scan_bytes N`, `changed_rows N`, `changed_bytes N`；CHECK expires_at≥previewed_at；completed 当且仅当 completed_at 非空；approved/completed 必须 approval_ref/approved_batch_hash 非空；其他状态可保留已有审批证据；完成证明永久保留。candidate_json 的65536字符上限独立于行数/bytes预算。 |

**kind/state CHECK 的精确展开：**以下条件均与字段类型 CHECK 同时成立；显式 `IS NULL/IS NOT NULL` 避免 SQL NULL 使 CHECK 漏过。

```sql
-- im_send_operation_keys
CHECK ((source_protocol='a2a-msg.im.v2' AND storage_client_message_id='v2:'||origin_epoch||':'||client_message_id)
 OR (source_protocol='a2a-msg.im.v1' AND storage_client_message_id=client_message_id))
-- im_schema_preparations
CHECK (
 (kind='fresh' AND source_version IS NULL AND source_schema_checksum IS NULL AND import_epoch IS NULL)
 OR
 (kind='v3_import' AND source_version IS NOT NULL AND typeof(source_version)='integer'
  AND source_version=3 AND source_schema_checksum IS NOT NULL AND import_epoch IS NOT NULL
  AND import_epoch<>initial_epoch)
)
-- im_recovery_runs: import 始终有隔离/RPO；真实备份四字段必须全有或全无
CHECK (
 (candidate_kind='snapshot_recovery' AND preparation_ref IS NULL
  AND backup_id IS NOT NULL AND backup_file_hash IS NOT NULL AND manifest_hash IS NOT NULL
  AND candidate_base_hash IS NOT NULL AND old_epoch IS NOT NULL
  AND isolation_ack_ref IS NOT NULL AND rpo_report_json IS NOT NULL)
 OR
 (candidate_kind='fresh_bootstrap' AND preparation_ref IS NOT NULL
  AND backup_id IS NULL AND backup_file_hash IS NULL AND manifest_hash IS NULL
  AND candidate_base_hash IS NULL AND old_epoch IS NULL AND isolation_ack_ref IS NULL AND rpo_report_json IS NULL)
 OR
 (candidate_kind='v3_import' AND preparation_ref IS NOT NULL
  AND old_epoch IS NULL AND isolation_ack_ref IS NOT NULL AND rpo_report_json IS NOT NULL
  AND ((backup_id IS NULL AND backup_file_hash IS NULL AND manifest_hash IS NULL AND candidate_base_hash IS NULL)
    OR (backup_id IS NOT NULL AND backup_file_hash IS NOT NULL AND manifest_hash IS NOT NULL AND candidate_base_hash IS NOT NULL)))
)
CHECK (old_epoch IS NULL OR old_epoch<>new_epoch)
CHECK (status NOT IN ('verified','active') OR verified_at IS NOT NULL)
CHECK (status<>'prepared' OR verified_at IS NULL)
CHECK (
 (status='active' AND activated_at IS NOT NULL AND activation_ref IS NOT NULL
  AND auth_review_ref IS NOT NULL AND activation_plan_hash IS NOT NULL AND activation_approval_ref IS NOT NULL)
 OR
 (status<>'active' AND activated_at IS NULL AND activation_ref IS NULL
  AND activation_plan_hash IS NULL AND activation_approval_ref IS NULL)
)
CHECK ((status='failed' AND failure_code IS NOT NULL) OR (status<>'failed' AND failure_code IS NULL))
CHECK (verified_at IS NULL OR verified_at>=created_at)
CHECK (activated_at IS NULL OR (verified_at IS NOT NULL AND activated_at>=verified_at))
```

同事务跨行核对：bootstrap/import run 的 preparation.kind 必须分别是 fresh/v3_import，new_epoch=preparation.initial_epoch，引用不可改成其他候选；center epoch/activation_ref 与所绑定run一致，counter与对应im_center_epochs行及批准prepare plan一致（run没有第二份counter列）；prepared/verified/active的正常转换同时更新两表。failed run只允许对应不可服务的prepared center（同事务退回prepared、activation_ref为空），不得将active run改failed或抹除active事实；active后的操作失败以原完成记录对账。snapshot_recovery要求来源已有真实centerEpoch（v4）；v3输入走v3_import且old_epoch=NULL，不伪造epoch。备份支持的v3_import必须保留真实backup_id/file_hash/manifest_hash/candidate_base_hash，base hash等于候选任何修改前已验证的原备份file hash；直接来自已关闭实际源、确无备份时四字段才全NULL，但仍必须有受保护持久sourceEvidence、RPO及隔离证据，不能冒充注册备份。可信管理层决定来源类别，调用者不能把备份来源降格成NULL以绕过验证。

创建顺序允许先声明尚未创建的 SQLite FK 目标，但 commit 前必须所有表齐备、foreign_key_check 为空。插入顺序为 policy/epochs→schema preparation（若适用）→prepared center（run 可空）→prepared run→center 绑定 run；verify/activate 在各自事务同时转换 run 与 center。maintenance 则先插 run 再更新 content。不存在“先 active 才能插 run”的循环前置条件。

**索引精确目标：**

```sql
CREATE INDEX im_content_expiry ON im_content_state(state,expires_at,message_id);
CREATE INDEX im_content_scrub ON im_content_state(state,scrubbed_at,expires_at,message_id);
CREATE INDEX im_content_policy ON im_content_state(policy_hash,message_id);
CREATE INDEX im_content_expiry_run ON im_content_state(expiry_run_id);
CREATE INDEX im_content_scrub_run ON im_content_state(scrub_run_id);
CREATE INDEX im_maintenance_completed ON im_maintenance_runs(status,completed_at,run_id);
CREATE INDEX im_maintenance_policy ON im_maintenance_runs(execution_policy_hash,run_id);
CREATE INDEX im_maintenance_epoch ON im_maintenance_runs(center_epoch,run_id);
CREATE INDEX im_recovery_backup ON im_recovery_runs(backup_id,run_id);
CREATE INDEX im_recovery_old_epoch ON im_recovery_runs(old_epoch,run_id);
CREATE INDEX im_recovery_preparation ON im_recovery_runs(preparation_ref,run_id);
CREATE INDEX im_preparation_import_epoch ON im_schema_preparations(import_epoch,preparation_ref);
CREATE INDEX im_preparation_policy ON im_schema_preparations(policy_hash,preparation_ref);
CREATE INDEX im_center_recovery ON im_center_state(recovery_run_id);
CREATE INDEX im_operation_epoch ON im_send_operation_keys(origin_epoch,sender_id,client_message_id);
CREATE INDEX im_sync_epoch ON im_sync_progress(center_epoch,recipient_id,stream_epoch);
CREATE INDEX im_expiry_delivery ON im_expiry_receipts(recipient_id,seq);
CREATE INDEX im_expiry_message ON im_expiry_receipts(message_id);
```

其余 FK 查询由上述索引或 PK/UNIQUE 的左前缀覆盖；`new_epoch`、message_id 与附件 message_id 的 UNIQUE 自带索引。迁移验证需 EXPLAIN 实证 expiry/scrub keyset SEARCH，不能仅凭列名宣称无全扫。审计扫描沿用 `im_audit_occurred(occurred_at,id)`，按有限行过滤保护 action，达到扫描上限就返回 incomplete。

### 3.3 旧表不重建的 key 与附件方案（T1 已裁决）

新 v2 operation 的逻辑键为 `(认证 sender, originEpoch, clientMessageId)`。wire 两个 UUID 均小写规范形式；storage key 为精确 ASCII `v2:<originEpoch>:<clientMessageId>`，长度 **76**（3+36+1+36），一一编码、不截断、不用 hash 代替唯一键，映射表 CHECK 必须检查准确拼接结果。写入旧 `im_messages.client_message_id` 和 `im_send_keys.client_message_id` 的是 storage key；wire DTO 从映射表回投真实 clientMessageId，绝不暴露 storage key。旧列允许 1..255 字符，因此无需改历史 DDL；内部 key 不能复用旧 UUID validator。新增 sender/epoch 相同 key 不得生成第二 message。

v2 fingerprint 的 UTF-8 JSON 数组固定为：

```text
["a2a-msg.im.v2", originEpoch, conversationId, recipientAgentId,
 clientMessageId, titleOrNull, textOrEmpty,
 attachmentOrNull && [name,mimeOrNull,size,sha256], inReplyToOrNull, correlationOrNull]
```

`centerEpoch` 为请求所针对的当前中心，不加入内容 hash；originEpoch 加入。既存 v1 key/hash 原样保留，映射 `source_protocol='a2a-msg.im.v1'`，storage key 为原 client UUID。v3 import 生成独立 `origin='v3_import'` epoch 作为导入 operation 命名空间，另生成 initial/current 候选 epoch（origin 仍为 v3_import，二者不同，counter 均0）；候选仅 prepared。旧客户端 journal 的归属只能人工对账。导入必须验证全部 wire IDs（包括 agent/conversation/message/reply/attachment/client/stream/lease 中将用于协议的 ID）、正文/title/correlation、附件 name/mime/size/hash，按第4节的准确 wire 界限验证，不能只验证 client ID。`v2:` 前缀占用、孤立 key/message、错主体、重复映射、非规范ID或超界字段均拒绝整个迁移，不截断/清理/重写。这比历史存储 CHECK 更严格，预检报告须显式列阻断码与计数。

90 天 scrub 保留消息 ID、conversation、sender/recipient、acceptedAt、原 key/hash/retry_until、reply 关系、delivery seq 与真实 ACK/read。`text=''`、`title=NULL`、`correlation=NULL` 合法；**附件不能 UPDATE data=x'' 或 size=0**。先有 reservation，再在同一 scrub 事务 DELETE `im_attachments` 的 live payload 行；它同时移除 name/mime/bytes，ID/hash/size 仍在 reservation。v4 ACL 先查 reservation→message 权限再检查 content state；hash/size 只作历史证据，不代表可下载。旧 v1 模块在 schema 门禁处拒绝 v4，绝不能依赖“清空后旧客户端恰好不报错”。

### 3.4 显式迁移与初始化

1. 唯一公开 fresh API 为 `initializeImSchemaV4(db,{policy,creationRef,limits})`；只接受空 IM schema、离线独占候选。实现内部生成 stable identity/initial epoch，原子持久化 preparation 与完整 v4；write_mode=paused、center.status=prepared、recovery_counter=0、recovery_run_id=NULL，绝不打开监听器或跳过 activation。
2. 唯一公开迁移 API 为 `migrateImSchemaV4(db,{expectedVersion:3,policy,migrationRef,limits})`；只接受原 v3 完整断言、真实已初始化 stable identity、paused 离线独占候选。保留实际源 instanceId/createdAt，实现内部生成 import/current epochs。上述 API 不接受任何调用者自报身份/epoch 参数；API 自身不能证明旧源已关闭，该证据由受信管理流程负责。v1/v2、错误 marker、部分 v4、无 identity 一律拒绝。
3. preparation_ref=creationRef/migrationRef，input_hash=`SHA256(UTF8(JSON.stringify([kind,sourceVersionOrNull,sourceSchemaChecksumOrNull,fullPolicyObject,preparationRef])))`；fullPolicyObject 按第7.1节固定字段顺序规范化。hash 不含未持久随机ID或可变 limits。首次调用在事务中保存记录；exact retry 必须验证完整 v4、对应 preparation.kind/ref/input_hash 和实际 identity/initial/import epochs，返回持久 ID，不再次生成、不把已verified/active状态退回prepared。v4 retry 的 source schema 取 preparation 中的原始值，不拿当前4替换源3。输入不同或缺少 preparation 拒绝，不收养不明 v4。
4. limits 默认且最大 `{maxMessages:10000,maxVerifiedContentBytes:104857600,maxOtherRecords:10000,maxElapsedMs:10000}`，仅可降低；maxOtherRecords 计所有旧 im_ 表行但不重复计 im_messages/im_attachments 的行。先投影计数与 UTF-8 内容长度（正文/title/correlation/name/mime 加 BLOB），超预算即拒绝；单事务 streaming 验证完整 fingerprint/hash、一次最多一个附件入内存。10秒为单调计时软预算，语句间检查，不能中断单个SQLite调用。超限回滚全部DDL/backfill/marker，不分阶段大迁移、不静默调高预算。
5. retained_floor>1、seq缺口、孤立message/key、错主体、重复映射、ID/内容/整数不合界均拒绝。**v3 导入前检查**逐条核对 acked_through 等于实际最大连续 ACK 前缀，不能补写ACK凑游标；逐条建立 content/reservations/operation mappings，初始 progress 只继承该已验证的最大真实 ACK 前缀。**v4 运行候选**的持久 acked_through 可因每次至多推进1000 seq而落后于最大真实 ACK 前缀，但0..acked_through必须逐条有真实 ACK 证明，不可跨缺口/未ACK，且仍须满足 handled_through≥持久 acked_through；handled 前缀另须真实 ACK 或当前 epoch/stream 精确 expired receipt，不能要求其达到最大真实 ACK 前缀。一个原子事务提交 preparation/backfill/v4 marker，状态/行验证不能由 manifest 替代。
6. 源 v3 与原备份不修改。prepared→verified→active 必须第6节候选 run 与双审批，active 后仍 paused；启写与监听器单独批准。普通构造函数和旧入口不触发迁移。

两个API的返回字段精确相同：`{preparationRef,instanceId,instanceCreatedAt,initialEpoch,importEpoch,schemaVersion:4,status,writeMode}`。preparationRef/initialEpoch/importEpoch从preparation记录读取；fresh的importEpoch=null，import返回持久import_epoch；instanceId/instanceCreatedAt从实际im_instance_identity读取。首次成功status='prepared'、writeMode='paused'；exact retry返回当前持久center.status及im_settings.write_mode，不新建epoch，不把verified/active降级，也不把当前writeMode伪报为paused。API重试本身不改变状态或启写。

## 4. P2：冻结的 v2 wire 实施契约

### 4.1 共通规则与 DTO

base `/api/v2`。所有 JSON 对象 strict、未知键拒绝；UUID 为小写 canonical，时间/seq/generation 为安全整数；数组最多 100 且不重复。保留 v1 正文 32000 UTF-16 code units、标题 100、correlation 200、文件名 200（拒绝控制字符、路径分隔符、`..`）、mime 100、单文件 1..10485760 bytes、规范 base64/SHA-256 验证与 64KiB/16MiB HTTP body 上限。查询参数单值、不重复；禁止未知 query、重复认证/版本/epoch/fence 头、路径编码歧义。严格 TLS，local-test 只限双端 loopback；不信任转发头替代 TLS。

所有 /api/v2 请求要求 `X-A2A-Protocol: a2a-msg.im.v2`；除初次身份探测 `/me`，还要求 `X-A2A-Center-Epoch: UUID`。POST JSON 必含 `protocol`、`centerEpoch`，必须与头相等，缺失/不一致 INVALID_REQUEST。GET 不带 body。/me 可省 epoch；携带旧 epoch 则仍显式报 reconciliation。其他 GET（含旧 origin 发送查询）必须绑定**当前** centerEpoch。只有 /me 返回中心身份，客户端记录变化后停止业务，不能自动覆盖旧 journal 分区。

JSON 成功 envelope 固定 `{protocol,centerEpoch,data}`；错误固定 `{protocol,error:{code,message,retryable},requestId}`，仅认证成功后的 RECOVERY_RECONCILIATION_REQUIRED 可增加 `currentCenterEpoch`，不附业务 ID/计数。二进制下载成功头含 protocol/centerEpoch、no-store、nosniff；错误仍 JSON，已发 headers 则断流。

以下类型是准确 wire 字段集（`?` 为请求可省，响应 nullable 必出现）：

```text
Scope = {protocol:"a2a-msg.im.v2", centerEpoch:UUID}
Fence = {instanceId:UUID, generation:int>=1}
Operation = {originEpoch:UUID, clientMessageId:UUID}
Attachment = {attachmentId:UUID,name:string,mime:string|null,size:int,sha256:hex64}
Message = {messageId:UUID,conversationId:UUID,senderAgentId:UUID,
 recipientAgentId:UUID,originEpoch:UUID,clientMessageId:UUID,
 title:string|null,text:string,inReplyTo:UUID|null,correlation:string|null,
 acceptedAt:ms,expiresAt:ms,deliveredAt:ms|null,readAt:ms|null,
 attachment:Attachment|null}
Tombstone = {messageId:UUID,conversationId:UUID,acceptedAt:ms,
 expiresAt:ms,expiredAt:ms}
HistoryItem = {kind:"message",message:Message}
            | {kind:"content_expired",tombstone:Tombstone}
SyncItem = {kind:"message",centerEpoch:UUID,streamEpoch:UUID,seq:int>=1,message:Message}
         | {kind:"content_expired",centerEpoch:UUID,streamEpoch:UUID,seq:int>=1,tombstone:Tombstone}
DeliveryRef = {seq:int>=1,messageId:UUID}
```

Tombstone 不含正文、标题、correlation、附件名称/mime、key/hash 或参与方列表；这些内部 skeleton 不等于对外可见字段。附件 hash/size 只在 live Message 和受限内部审计使用。`expiresAt` 为策略期限；expiryEnabled=false 时过了期限仍是 live，不能从期限推断已删除。

### 4.2 路径、输入、返回 data

| 方法与路径 | 输入（POST 加 Scope） | 成功 data / HTTP |
| --- | --- | --- |
| GET `/me` | 认证、版本头；可选 epoch 头 | `{agentId,instanceId,centerEpoch,recoveryCounter,state:'active'}` /200；instanceId 是 stable center ID，不是 receiver instanceId |
| GET `/contacts` | `after?`, `limit?` 1..100 默认20 | `{items:[{peerAgentId,displayName}],nextCursor:string|null}` /200 |
| GET `/conversations` | 同上 | `{items:[{conversationId,peerAgentId,createdAt}],nextCursor}` /200 |
| POST `/conversations` | `{...Scope,peerAgentId}` | `{conversationId,peerAgentId,createdAt}` /200 |
| POST `/messages` | `{...Scope,...Operation,conversationId,recipientAgentId,title?:string|null,text?:string,attachment?:{name,mime?:string|null,sha256,dataBase64}|null,inReplyTo?:UUID|null,correlation?:string|null}` | `{message:Message,replayed:boolean}` /201 新接受，/200 合法重放 |
| GET `/sends/:originEpoch/:clientMessageId` | 无 query；当前 epoch 头 | `{originEpoch,clientMessageId,messageId,acceptedAt,payloadHash,sourceProtocol,contentState,retryUntil}` /200；contentState枚举live/expired，无正文，过retry window仍可读接受事实 |
| GET `/conversations/:id/messages` | `after?`, `limit?` 默认20 | `{items:HistoryItem[],nextCursor}` /200；先会话 ACL |
| GET `/messages/:id` | 无 query | `Message` /200；expired 为 410 CONTENT_EXPIRED |
| GET `/attachments/:id` | 无 query | live 二进制 /200；先 reservation/message ACL，再 expired→410 |
| POST `/messages/:id/read` | `{...Scope}` | `{messageId,readAt,changed}` /200；live、当前 epoch、recipient、已有真实 ACK |
| POST `/receiver/lease` | `{...Scope,instanceId,requestId}` | `{centerEpoch,instanceId,generation,expiresAt,historical,streamEpoch}` /200 |
| POST `/receiver/lease/renew` | `{...Scope,...Fence}` | `{centerEpoch,instanceId,generation,expiresAt,streamEpoch}` /200 |
| POST `/receiver/lease/release` | `{...Scope,...Fence}` | `{instanceId,generation,released:true}` /200 |
| GET `/sync` | fence 头沿用 X-A2A-Instance-Id / X-A2A-Generation；query `streamEpoch` 必填、`after?`、`limit?` 默认20 | `{streamEpoch,handledThrough,ackedThrough,progressPending:boolean,items:SyncItem[],pageAfter,hasMore}` /200 |
| POST `/acks` | `{...Scope,...Fence,streamEpoch,items:DeliveryRef[]}`，1..100项 | `{streamEpoch,handledThrough,ackedThrough,progressPending:boolean}` /200；每项必须 live 或已真实 ACK 的幂等重放 |
| POST `/expiry-receipts` | `{...Scope,...Fence,streamEpoch,items:DeliveryRef[]}`，1..100项 | `{streamEpoch,handledThrough,ackedThrough,progressPending:boolean}` /200；只记录 expired 事实 |

P2/P3 不提供新 SSE durable 能力；HTTP `/events` 在此版本未定义，返回 RESOURCE_NOT_FOUND，客户端以同步为准。接入旧 SSE 不是完成 v2 必需条件。管理员恢复/维护不是公网端点，第 6/7 节为进程内能力接口。

分页 cursor 为 base64url 的 UTF-8 JSON 数组：`[2,kind,centerEpoch,agentId,scope,key]`，kind 为 contacts/conversations/history；前两者 scope=agentId、key=peerId/conversationId，history scope=conversationId、key=[acceptedAt,messageId]。最长 1024 字节 canonical base64url；解析后逐字段验证并重做 ACL，不把 cursor 当授权。epoch 不同报 reconciliation；scope 不符 INVALID_REQUEST。history 仍按 acceptedAt/messageId 排序，tombstone 占据原位置。

### 4.3 前置条件与错误

判断次序：TLS/请求上限/版本→认证→当前 epoch→active/写入门禁→资源 ACL→内容状态/lease/key。**每一个业务事务都必须在其快照/写锁内核验 centerEpoch**，不能仅在 HTTP 中间件检查；直接进程内调用也不能绕过。资源 ACL 不通过统一 RESOURCE_NOT_FOUND，不能通过 CONTENT_EXPIRED、key 冲突、seq 计数探测他人资源。sync 内任一项 ACL 不可见时整页 SYNC_BLOCKED，不跳过该项，不暴露其 ID。

v2 acquire 在旧 im_lease_requests.request_id 内存精确 `v2:<centerEpoch>:<requestId>`，两个 canonical lowercase UUID 一一拼接为76字符，不经过旧UUID validator；wire requestId 仍是UUID。request_hash=SHA256(UTF8(JSON.stringify([centerEpoch,instanceId,credentialId])))；result_json 包含 centerEpoch，重放时先核验当前 epoch、持久结果 epoch 与请求一致。旧 v3 lease_requests 全部保留但永不命中 v2 命名空间；恢复失效旧 leases，不依靠删除 lease_requests 保证正确性。

沿用旧错误的 HTTP/retryable 语义但在 v2 contracts 中独立定义；新增固定值如下：

| code | HTTP / retryable | 含义 |
| --- | --- | --- |
| PROTOCOL_UPGRADE_REQUIRED | 426 /false | **只在新 v4 中心**命中 /api/v1 前缀时，固定文案 `Use /api/v2 with a2a-msg.im.v2`，无重定向、不读业务数据；TLS 门禁仍在 |
| UNSUPPORTED_VERSION | 400 /false | /api/v2 中 protocol 不匹配；不是自动协商 |
| RECOVERY_RECONCILIATION_REQUIRED | 409 /false | center epoch 不符、客户端待人工对账；不得自动 reset/retry |
| SEND_OUTCOME_UNKNOWN | 409 /false | 非当前 origin 的 key 在恢复快照中缺失；不能证明未接受 |
| CONTENT_EXPIRED | 410 /false | 授权资源已过期；拒绝 GET payload、新 reply parent、read；首次 ACK 的错误使用下一行 |
| EXPIRY_RECEIPT_REQUIRED | 409 /false | ACK 批次包含尚未真实 ACK 的 expired 项，整批无修改，转专用流程 |
| CONTENT_NOT_EXPIRED | 409 /false | 对 live 项提交 expiry receipt；整批无修改 |
| MAINTENANCE_DISABLED | 503 /false | 所需 expiry/purge gate 未启用，执行改变行数必须为零 |
| PLAN_STALE | 409 /false | 计划过期、clock jump、候选/策略/epoch/hold 改变，需要重新预览和审批 |
| CAPACITY_EXHAUSTED | 503 /false | 永久 key/skeleton 容量阈值触发，停止新接受，不回收 ID/key |

`RESOURCE_NOT_FOUND 404/false` 对**当前 origin**且本身份确实无 key 才可用于发送结果查询；旧/未知 origin 缺 key 返回 SEND_OUTCOME_UNKNOWN，即使该 origin 根本不在 im_center_epochs 中，也不能先返回 epoch不存在/404。已有 key 仍先执行其 message ACL，拒绝时404。POST 必须 originEpoch=centerEpoch；恢复后旧 epoch POST 总拒绝 reconciliation，即使旧 key 存在；只读结果查询允许旧 origin。当前 epoch 重复 POST：ACL→既有 key 的 hash 冲突→retry_until<=now 报 IDEMPOTENCY_WINDOW_EXPIRED→返回同 message；永不新接受旧 key。7 天过后不删除 reservation；恢复后缺失的旧 key 不可能通过数据库推理找回，只能保守 unknown。

known key 的结果查询先验证 sender 与 message ACL，再返回 hash/accepted 事实，即使内容过期、重试窗口结束也可查询；v1 导入 key 返回 sourceProtocol=v1，客户端按原 v1 fingerprint 验证，不将其当 v2 重发材料。已本地记为 accepted 的 outgoing 若远端查不到，保留 accepted 本地证据并标“中心恢复后不可证实”，不可降级为可重发。

## 5. 处理游标、journal 与竞态

`handledThrough` 与 `ackedThrough` 分离。当前 `(recipient,centerEpoch,streamEpoch)` 的一个 seq，只有真实 `acked_at!=NULL` **或**匹配的 im_expiry_receipts 才算 handled；只取连续前缀。ackedThrough 仍只取全为真实 ACK 的连续前缀，可永久停在已过期未投递项之前。不得为推进 handled 写 acked_at/read_at。sync 默认 after=handledThrough，允许 `retained_floor-1 <= after <= handledThrough` 重放，不允许客户端任意向前跳；页必须连续且与 next_seq 匹配，缺行 STORAGE_UNAVAILABLE。当前版不提升 retained_floor、不删除 delivery/message skeleton。

ACK/expiry receipt 均要求当前 epoch、当前 stream、有效且凭据绑定的 lease；逐项验证 seq/message 对应与 ACL，全部合法才一次提交。首次 ACK 遇到 expired 项整批 EXPIRY_RECEIPT_REQUIRED；已真实 ACK 后再过期的 ACK 重放可返回既有结果而不改时间。expiry receipt 幂等相同 tuple；message 不匹配 INVALID_REQUEST，stream 不同 CURSOR_RESET_REQUIRED。迟到 receipt 用当前有效 lease 重试可接受，同一旧 lease/epoch 不可接受；它不能补写 delivered/read。read 对 expired 拒绝，即使已 ACK；既有 read_at 保留为事实。

ACK/expiry 每请求最多100项。每次前缀推进最多检查1000个 seq（ACK与handled合并按不同seq计数），剩余可连续推进时 `progressPending=true`；sync/ACK/expiry 三种响应都必须包含此布尔值，hasMore 仍只表示消息页是否还有数据。客户端可用**刚处理批次的原 items**精确重放 ACK/expiry，继续幂等推进，不造新 ACK/receipt；一次用户调用最多10轮，仍 pending 时显式返回 pending，由后续显式调用继续，无无限后台循环。sync 只观察持久前缀与pending，不以GET补写ACK；服务器已确认但本地无相应 durable facts 时客户端必须从本地可信位置重新 sync，不能把server watermark直接赋成本地cursor。前缀尽头只做有界存在性探测以确定pending，不全流扫描。

新 journal 使用**单独文件与版本 2 manifest**，不把旧 v1 表原地升级。P4 schema 的键精确绑定如下（业务字段界限按 wire；DDL 在 P4 契约测试固定）：

- meta `(version=2,checksum)` 唯一行。
- partitions PK `(centerOrigin,stableInstanceId,agentId,centerEpoch)`，status=`active|reconciliation_required|archived`，manualDecisionRef nullable；相同 URL 的不同 stable instance 同样需人工决定。
- outgoing PK `(partition,originEpoch,clientMessageId)`，immutable payload/fingerprint、createdAt、可空 accepted messageId/acceptedAt；两个独立字段 `acceptance_state='pending'|'accepted'` 和 `reconciliation_state='none'|'required'|'remote_unknown'`。accepted 要求 messageId/acceptedAt 非空且不可抹除；remote_unknown 可以与 accepted 同时成立，不回退 acceptance_state。
- received PK `(partition,streamEpoch,seq,kind)`，kind=`message|content_expired`；同一 seq 不同 kind 是**并存事实**，不是覆盖旧 JSON；UNIQUE `(partition,streamEpoch,messageId,kind)`；message payload、附件 receipt 与 expiry tombstone 各自 hash，recordedAt、serverConfirmed 标志。
- receiver PK `(partition,streamEpoch)`，handledCursor、真实 ACK cursor、lease；本地 cursor 只能越过已持久事实且服务器已确认的连续前缀。

对任一 epoch mismatch，冻结原分区自动网络 mutation，保留 outgoing/received/附件回执；人工 `reconcileEpoch({oldEpoch,newEpoch,decisionRef})` 只建立新的分区并登记旧分区引用，不删除、不重新归属旧 operation。新 operation 只能在人工明确接受业务重复可能性后以新 client ID 建立；不自动复制 pending 到新 epoch。新分区重复收到旧 messageId 可显示已有事实，但不得仅凭 ID 自动 ACK，须重新验证当前授权与内容/附件。

附件下载每个 64KiB chunk 前及发送 headers 前重验 epoch、ACL、content live；到期/撤权发生在 headers 后则断流，客户端只在完整 length+SHA-256 验证、安全落盘且 journal durable 后 ACK。已发出的字节无法撤回；客户端已有完整文件时服务端随后过期，首次 ACK 仍走 expired receipt，而不是谎称本次已投递。流程为重新 sync 获取 tombstone→持久记录 expiry fact→专用 receipt→推进 handled；旧 message/attachment receipt 不擦除。不把 hash/ACL/下载错误一概当 expired，只有经过授权的 CONTENT_EXPIRED +重新 sync 才能转分支。journal 提交前、后及 receipt 响应丢失均须可幂等恢复。

## 6. 人工恢复：prepare → verify → activate

### 6.1 管理能力输入、候选类型与双审批

恢复不开放普通 HTTP。独立本地 admin authority 与 plan approval authority 注入，均须同步返回 literal true；审批人身份取可信 adapter，不能取调用者自报。**prepare 与 activation 是两份分别批准的计划**，不能拿 prepare approval 代替 activation。没有新增审批平台。能力形状如下，计划里的身份/epoch由可信读取或内部生成，调用者提交计划仅用于完整性校验，不能任意指定新身份：

```text
previewRecovery({candidateKind,preparationRef,backupId,candidateReference}, adminContext)
  -> {preparePlan,preparePlanHash}
prepareRecovery({preparePlan,preparePlanHash,approvalRef}, adminContext)
  -> {runId,candidateReference,newEpoch,status:"prepared"}
verifyRecovery({runId,preparePlanHash}, adminContext)
  -> {runId,status:"verified",sealReference,sealHash}
previewActivation({runId,sealReference,authReviewRef,isolationAckRef,activationRef}, adminContext)
  -> {activationPlan,activationPlanHash}
activateRecovery({activationPlan,activationPlanHash,activationApprovalRef,sealReference}, adminContext)
  -> {runId,newEpoch,status:"active",writeMode:"paused"}
```

preparePlan 字段顺序固定：`{version:1,runId,candidateKind,preparationRef,instanceId,instanceCreatedAt,backupId,backupFileHash,manifestHash,sourceSchemaVersion,sourceSchemaChecksum,candidateReference,oldEpoch,newEpoch,recoveryCounter,policyHash,rpoReport,sourceEvidence,sourceClosedEvidenceRef,isolationAckRef,createdAt,expiresAt}`。不适用字段显式null。preparePlanHash=SHA256(UTF8 固定字段序 JSON)，TTL 300000ms，`now<expiresAt`；prepare approval 绑定全部字段。**整份preparePlan（包括完整sourceEvidence）必须受保护持久保存、可读回，读回hash必须等于im_recovery_runs.approved_plan_hash**；仅保存hash而丢失来源证明不合格。sourceEvidence是不含路径/凭据的已验证来源证据，完整编码仍为P5门禁，不阻塞P1表定义；不能用任意字符串伪装来源。sourcekind由可信管理层验证，不接受调用者通过删字段将备份来源降为无备份来源。

- fresh_bootstrap：读取 kind=fresh 的 preparation；preparationRef 非空，newEpoch=initial_epoch，sourceSchemaVersion/sourceSchemaChecksum、全部备份字段、oldEpoch、rpoReport、sourceEvidence、sourceClosedEvidenceRef、isolationAckRef 均null。不得伪造备份/源隔离/RPO证明。
- v3_import：读取kind=v3_import的preparation，保留实际stable identity，newEpoch=initial_epoch，sourceSchemaVersion=3/sourceSchemaChecksum来自preparation；oldEpoch始终null，rpoReport/sourceEvidence/sourceClosedEvidenceRef/isolationAckRef始终必填。备份支持的导入在preparePlan保留真实backupId/backupFileHash/manifestHash与RPO，在run保留相同三字段及修改前candidate_base_hash；后者必须等于已验证原backupFileHash。来自实际已关闭源且确无备份的导入，plan三备份字段和run四备份字段可分别全null，仍需受保护持久sourceEvidence与RPO/隔离，不能冒充注册备份。schema preparation本身不证明源已停。
- snapshot_recovery：preparationRef=null，来源为已验证v4快照，sourceSchemaVersion=4；全部备份字段、oldEpoch、rpoReport、sourceEvidence/sourceClosedEvidenceRef/isolationAckRef 非空；newEpoch内部新生成。来源无epoch的v3快照必须先走 v3_import 候选类型，不混用 nullable 条件。

activationPlan 精确字段顺序为 `{runId,preparePlanHash,sealHash,candidateReference,newEpoch,authReviewRef,isolationAckRef,createdAt,expiresAt,activationRef}`；activationPlanHash同样对固定序列JSON求SHA256，TTL 300000ms，`now<expiresAt`。authReviewRef 三种候选均必填；isolationAckRef 仅fresh为null，其他须与prepare及当前隔离核验一致。批准该计划后，在 active 事务中写入 activation_plan_hash/activation_approval_ref，不能仅写一份笼统approval_ref。两次审批都由可信 authority验证，verify没有activate权限。

`rpoReport`精确形状：`{status:'measured'|'unknown',snapshotCompletedAt:null|ms,sourceObservedAt:null|ms,missingAcceptedCount:null|int,missingAckCount:null|int,missingReadCount:null|int,comparisonEvidenceHash:null|hex64,authChanges:'unknown'|'reviewed',notesCode:'SOURCE_UNAVAILABLE'|'BOUNDED_COMPARISON_COMPLETE'|'COMPARISON_INCOMPLETE'}`。v3_import不论有无备份均须RPO报告。备份支持的候选snapshotCompletedAt必须为真实备份completedAt；仅无备份来源且没有已知快照时间时可null。差异不可知或比对不完整时status='unknown'，三项missing计数及comparisonEvidenceHash均null，不用0伪装无损失；仅完整经验证比对可measured。sourceObservedAt与snapshot时间差是观察区间，不是精确丢失量。

### 6.2 不可破坏的执行顺序

以下copy/artifact验证、持久hold、源隔离、exclusive copy与修改前base hash规则适用于**所有备份支持的候选，包括v3_import**，不能只用于snapshot_recovery；这些步骤先于候选迁移/任何修改。无备份v3_import使用已验证关闭实际源的受控复制与持久sourceEvidence，仍需隔离/RPO与exclusive候选，但不伪造backup/hold。bootstrap/import按第3.2节绑定preparation后仍须verify与独立activation；fresh不要求不存在的旧源证据。

1. 锁顺序固定 **registry→candidate**。registry 锁内验证来源、manifest/文件 hash、identity/schema、未撤销；在任何copy前持久化 hold `{version:1,holdId,backupId,recoveryRunId,preparePlanHash,createdAt}`，no-replace发布并fsync。hold不能只存在进程Map；release是另行显式操作写durable release marker，completed/failed都不自动release；坏hold或不明release拒绝cleanup。旧v3 cleanup不识别hold，不能充当v4清理入口：必须由可信源保护排除它，或复制至新的受保护registry后才使用。具体seal/hold/release编码与adapter故障矩阵在P5冻结，不阻塞P1的表结构。原备份不改写，真实源关闭/隔离确认先于候选写；源失联不证明已隔离。
2. exclusive-create 新候选，拒绝已存在路径/别名/硬链接/符号链接，私有本地目录且不覆盖 accepted 原 DB。先完成只读复制/hash，`candidate_base_hash` 定义为**复制后、任何 prepare 修改前**的完整 DB hash，应等于 backupFileHash。保留它不宣称它等于迁移后候选 hash。
3. snapshot候选断言v4；一个事务插计划已绑定的新epoch、recovery run、center prepared，递增分支counter、write_mode=paused、失效旧leases；**保留全部旧lease_requests**，v2 epoch命名空间阻止旧重放。旧epoch send mappings、ACK/read和progress/receipts保留。当前epoch progress继承实际连续ACK前缀，旧epoch expiry receipt不自动算新handled，须新接收者明确确认。stream_epoch保留，不靠generation回滚后的数值防护。
4. verify 在暂停exclusive状态验证integrity/FK/manifest、skeleton/mapping/receipt、授权、scrub一致性、RPO/clock；同事务写run/center verified。成功checkpoint WAL→main后关闭**全部**候选连接；BUSY、无法解释的残留WAL/SHM或不明writer均拒绝seal，不静默删除侧文件。保持候选exclusive控制，hash关闭的DB，no-replace+fsync发布外部seal `{version:1,runId,preparePlanHash,newEpoch,candidateReference,candidateFileHash,schemaChecksum,verifiedAt,verification:{integrity:true,foreignKeys:true,schema:true,invariants:true}}`。sealHash为其规范编码字节SHA256，编码细节P5冻结。外部seal避免自引用整库hash，hash不在业务write transaction内；verify不activate。
5. activate **先取得候选exclusive控制，再检查sealHash及关闭候选DB hash**；锁次序仍registry→candidate。重新验证独立activation审批、prepare绑定、hold、隔离和auth review，再打开DB，检查小状态和run/epoch/schema，事务同时写run/center active、activation字段及最小审计，write_mode仍paused。不能在验hash后才争抢exclusive控制。activation改变DB hash是预期；精确重试先在exclusive控制下识别completed active记录、核对activationPlanHash/approvalRef/activationRef并返回原结果，不再要求activeDB等于旧verified seal hash，不换epoch。未active则必须完整seal验证。
6. 独立监听器启用/路由切换/启写必须另确认。构造 v2 center 只接受 active，写操作还须配置与 im_settings 双 enabled。旧源即使启动也不能靠本地 lock 全局 fencing；人工隔离失效时可能双中心，必须在报告显式承认。

prepared 未 seal、verified 未 seal、seal 发布失败、activation commit 前后崩溃分别保留现状、按原 runId 对账；不自动删除不明候选/锁文件，不自动重试成新 epoch。旧备份恢复可能撤销掉备份后新增凭据/禁用信息，不能“认证成功就安全”：activation 前要求管理员复核/轮换，无法复核则停止 activation；具体轮换材料不写本文或日志。

Windows 原生严格 registry 尚不支持，默认 fail closed；Windows 仅允许明确标注的隔离测试能力，不能注入 fake platform 绕过生产保护。WSL 证据必须来自原生 Linux 文件系统，不能用挂载 Windows/网络盘冒充 POSIX 保护。目录 singleton lock 只保证参与该本地目录锁协议的进程互斥，不能证明另机旧 writer 停止。

## 7. 留存、批次和备份清理

### 7.1 完整配置与默认关闭

v2 独立 config，不交给旧 parseImConfig。必填策略完整形状：

```json
{
  "version": 2,
  "effectiveAt": 0,
  "messageRetentionMs": 7776000000,
  "attachmentRetentionMs": 7776000000,
  "safeRetryWindowMs": 604800000,
  "auditRetentionMs": 15552000000,
  "keyReservation": "indefinite",
  "expiryEnabled": false,
  "purgeEnabled": false,
  "backupCleanupEnabled": false,
  "backupRetentionMs": null
}
```

示例 effectiveAt=0 只是类型示例，真实生效时间必须显式填写并受 clock 校验。`policyHash` 对以上固定序列字段序 JSON 求 SHA256，作为 config 的独立必填校验字段；enabled gates 改变必须新增policy记录/hash与审批，不能UPDATE原策略/deadline。新接收策略生效时间须≤acceptedAt；导入旧数据的 deadline=原 acceptedAt+90d，effectiveAt 是采用策略的时间，不延长历史内容寿命。`im_content_state.policy_hash` 永远绑定生成deadline的**历史策略**；`im_maintenance_runs.execution_policy_hash` FK绑定本次当前执行策略；每个candidate.contentPolicyHash核对原内容策略，执行时executionPolicyHash必须等于当前配置hash。

新 config 根字段为 `{enabled:false,writeMode:'paused',transport,retention:{policy,policyHash},lease:{ttlMs,renewalMs},limits,maintenance}`；transport/limits 沿用已核数值边界而独立校验；lease 两值为正安全整数且 renewal<ttl，不替用户选生产值。maintenance 完整字段为 `{maxRows:100,maxBytes:10485760,maxScanRows:10000,maxScanBytes:104857600,maxScanMs:1000,maxWriteMs:1000,planTtlMs:300000,maxForwardJumpMs:86400000,maxKeyReservations}`。maxKeyReservations 必须部署方显式给正安全整数，无无限容量假设；报告 count/headroom，阈值触发仅阻止新 send 接受，查询、已接受 key 重放、收件处理仍可用。这些已裁决预算不能被调用者提升。

expiryEnabled=false：不转 tombstone。purgeEnabled=false：不 scrub payload、不 DELETE audit/备份。expiry 可独立 enabled 而 purge=false：只置 state/expiredAt/run，隐藏 payload，物理 bytes 保留；报告区分 `expired` 与 `scrubbed`。若两个 gate 均 true 且对应批次已批准，则内容状态转换+scrub+完成审计同事务；已有 expired 内容可另 approved scrub。无 ACK 条件，未 ACK 内容可到期并通过 receipt 处理。

所有到期边界统一：时间有效当且仅当 `now<expiresAt`，相等已到期；内容deadline到期表示可进入已启用、已批准的expiry流程，不绕过默认OFF及持久状态事务。租约、prepare/activation/maintenance计划均在相等时拒绝继续使用；retry窗口同样仅now<retryUntil有效。

### 7.2 预览与原子执行

进程内接口 `previewMaintenance({kind,after?,limit},adminContext) -> {plan,planHash,complete,nextCursor}`；`applyMaintenance({plan,planHash,approvalRef},adminContext) -> {runId,status,changedRows,changedBytes,replayed}`。所有 apply 都要独立 plan approval；physical scrub/audit 每批 approval 不可由启用配置代替。

plan 固定字段 `{version:1,runId,centerEpoch,kind,executionPolicyHash,createdAt,expiresAt,clockObservedAt,candidates,budget,scan}`。candidate 每项 `{messageId:null|UUID,auditId:null|int,contentPolicyHash:null|hex64,expectedState:null|'live'|'expired',expiresAt:null|ms,expectedFingerprint:hex64,expectedBytes:int,expectedRows:int}`，按主键/扫描键稳定排序；expiry/scrub 使用 messageId，audit 使用 auditId，不同时非空。expectedFingerprint 是精确受影响行的规范 metadata hash，含 key payload_hash/附件 hash/size/state；不能读取已 scrub 正文重建旧 send fingerprint。审批绑定完整候选 ID、当前/历史策略 hash、原状态、bytes/rows，不允许 apply 时查询一批新的“同条件候选”。

索引 keyset 预览先投影length/ID再受预算读取内容；最多scan 10000 rows、100MiB、1000ms，超出任何扫描预算complete=false且**零apply**。candidate_json规范序列化≤65536字符单独限制批次，即使行数/bytes未满也不能超长。每批≤100 **受影响业务行**（content、message、attachment、key状态、audit删除逐行计数）加最多2条证明行（run与完成审计），≤10MiB **logical scrub bytes**，不声称限制实际WAL/pages写入量。事务1000ms为软预算，迭代/语句间检查单调计时器，超时rollback；不保证单个SQLite调用可中断或硬实时。

一个message+attachment为不可拆group。bytes计BLOB+正文/标题/correlation/附件name/mime的UTF-8长度。**恰好10MiB附件加非空名称已超限**：整组OVERSIZED_GROUP hold，不拆组、不自动提高预算；本版本没有大组例外执行路径。正常小组填满即结束一个完整有界批次；不因前一大组不可执行而在同一批准批次偷偷换后面的组。

apply 前fresh guard检查now≥持久clock且正跳≤24h、**now<plan.expiresAt**、epoch/审批/全部候选/holds未变；事务中再验，时钟回退CLOCK_UNSAFE、计划到期/大跳PLAN_STALE。不能先observe巨大now再拿已刷新clock放行。事务同步更新状态、scrub、key status（reservation保留）、im_maintenance_runs completed/result与最小im_audit证明；失败全部回滚。重复completed planHash精确返回原结果，不再次删除；不同候选必须新planHash。whole-DB hash、备份、VACUUM不放write transaction。planner具体查询、candidate fingerprint序列化、forward-jump与clock anchor交互在P6实现前冻结。

普通审计以 occurred_at+180d 到期；migration、recovery、purge/expiry completion、activation、backup provenance 的证明 action 采用固定 allow/exclude 分类，未知 action 默认 hold。`im_migration_runs`、`im_recovery_runs`、`im_maintenance_runs` 与 referenced 最小审计不能随普通审计过期。最小证明迁移方案未实现前宁可 retain，不以删除 FK 证据换容量。key/skeleton 永久保留；容量告警和 fail-closed 新写门禁，不循环使用身份或 seq。

### 7.3 物理边界与备份

SQLite UPDATE/DELETE 只是**应用可见内容移除**，不是安全擦除；WAL、freelist、文件系统快照、既有备份与客户端副本可能仍有旧内容。不自动 checkpoint/VACUUM。离线空间回收或安全擦除需要另行权限、停机与容量评估；90 天不承诺所有备份同一时刻消失。

备份清理只经受保护 registry、同目录锁、精确审批批次执行；保留 newest valid backup、in-use/recovery/migration holds，无法判定 hold 时拒绝。现有 registry cleanup 只要求 revoke，不具有这些新 hold 规则，不能直接当 v2 自动清理器。P6 只做到 disabled guard、预览/hold 设计与候选验证；实际 TTL 无用户批准则无可执行删除计划。v4 备份必须独立 verifier/publisher 支持 v4 manifest；旧 v3 publisher/runner 保持原常量检查。原 v3 registry 格式不能静默把 v4 数据当已支持，适配须明确版本分派并验证原接口行为。

## 8. 状态不变量与回滚

- stable instanceId 不随恢复改变；centerEpoch 每次获批恢复更换，UUID 永不复用；counter 不是 global fencing。
- 新接受事务包括 message、live附件+reservation、key+operation映射、content_state、delivery seq 和审计；任何失败不得半条可见。
- expired 一旦成立不恢复 live。仅恢复备份可能重新出现内容，因此新 epoch 验证须重新应用已知保护记录/报告未知留存差异；不声称快照能知道备份之后的所有过期/撤销。
- 清理不得删 send reservation、消息/附件 identity、delivery skeleton 或伪造 ACK/read；缺口即故障。
- 回滚是停新写、停止新监听器、保留全部已 accepted v4 DB/journal/证据；不把旧快照覆盖新 accepted，不把 v4 降级供旧 v1 读取。需要再次恢复时重新计划、审批并新 epoch。

## 9. 文档验证范围

本次只修订本文及配套计划，检查相对文件链接、UTF-8、diff whitespace，并核对新字段/CHECK/FK/index和API剩余旧参数。未创建/删除备份、未读运行数据或凭据、未改source/test/config、未运行完整测试。后续证据按配套P0–P7执行；历史验证报告的通过结果不算本契约的实现结果。

## 10. 裁决落点与剩余阶段门禁

T1：第3.2/3.3节准确编码CHECK、导入wire验证、payload/reservation不变量。T2：第3.2/3.4节preparation持久幂等、内部ID生成、有界单事务。T3：第3.2/7.1节execution_policy_hash与历史policy分离。T4：第7.2节100业务行+最多2证明行、10MiB逻辑bytes、JSON独立上限和soft预算。T5：第6节双审批、exclusive-before-hash、closedDB seal、持久hold。T6：第4.2/5节独立journal双状态、100/1000/10预算与progressPending。T7：第3.2/6节三种candidate kind、准确nullable与prepared无自动激活。上述决定已采纳，不再作为通用待决项。

| gate / owner | 剩余精确产物 | 阻断范围 |
| --- | --- | --- |
| DISPATCH / 父会话 | 最终v3_import修正已落实，`P1/P2-FROZEN-1`已生效；阅读修正章节后分派P1单写者 | 无需新增Oracle循环；冻结的是实施契约，不宣称已实现 |
| P4 / journal单写者+review | 完整version2 journal DDL/manifest、复合FK、payload与receipt JSON bounds，落实accepted与remote_unknown共存 | P4实现前；不阻断P1/P2 |
| P5 / recovery单写者+review | seal/hold/release marker规范编码、prepare sourceEvidence和持久计划证据、版本化v3/v4备份adapter、WAL/目录durability/进程故障矩阵 | P5实现前；不阻断P1表定义。旧v3无epoch走v3_import，不伪造snapshot旧epoch |
| P6 / maintenance单写者+review | planner确切indexed查询、candidate fingerprint规范序列、forward-jump与clock anchor交互、soft预算实证 | P6实现前；不重开100+2和10MiB裁决 |
| H1 / 用户运维 | 真实源隔离、RPO及身份变化复核、实际activation/切换 | 单次操作确认，未确认不执行，不宣称跨机器fencing |
| H2 / 用户运维 | 启用expiry/purge、逐批实删、备份TTL/窗口、生产容量阈值 | 全部默认OFF；30天UNCONFIRMED；本版无自动大组预算例外 |
| H3 / 用户运维 | 新TLS端口、DB/config位置、公网/DNS/资源成本、真实平台部署 | 另行确认，不触旧18787，不开真实服务 |

本轮只修改两份契约文档，父会话技术核对无需立即向用户提问。若P1单写者发现字段/CHECK仍欠定义，应列出具体缺口交技术决策，不能自行改历史schema或填入未定义字段。
