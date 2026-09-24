# IM v1 只读留存规划（非清理器）

`planImRetention({db,policy,clock,timeGuard,limits})` 在真实同步 SQLite 连接与可信、无副作用的同步回调下仅进行只读查询及只读一致快照事务，返回 `valid, complete, reason, subjects, candidates, totals, protections`。本模块自身不写业务库；不防御传入回调自行写库等副作用。**TTL 是进入清理候选的门槛，候选绝不可直接拼接为 DELETE。** 候选只涉及 delivery、message 与 attachment；幂等 key、lease/generation、receive state/epoch、审计、联系人撤销/拒绝和 legacy 均不列候选。

显式策略要求扁平对象 `{version:1,enabled:true,writeMode:'enabled',safeRetryWindowMs,attachmentRetentionMs,messageRetentionMs,idempotencyRetentionMs}`，四项时长均为正安全整数，且 `safeRetryWindowMs <= attachmentRetentionMs <= messageRetentionMs <= idempotencyRetentionMs`。缺项、未知项、未知版本、paused/disabled、不可信时钟及存储异常均 fail closed，返回零候选。这里的 planner 策略与数据库持久化 `im_settings.write_mode` 为两套独立状态：planner 不替代写入开关或部署授权；即便持久化 paused，显式 planner 策略也不等于启用物理清理。`parseImConfig({})` 的默认值不是有效 planner 策略。

三类阻塞：① **ACK/连续游标**：未确认或前方有洞的 ACK 不清理，`1 <= retainedFloor <= ackedThrough + 1 <= nextSeq`，`proposedFloor` 仅跨过从 `retainedFloor` 起连续合格的已 ACK 前缀；② **安全重试/幂等**：必须严格晚于原始 `retry_until`，保留关联 replay key，并等待显式幂等留存期；历史 key 不因当前策略窗口变长而被误判材料缺失，本版也不追溯延长历史保护；③ **TTL/可读引用**：消息与附件均必须晚于自己的 TTL。缺失关联材料、身份/时间不匹配、发送端 fingerprint 无法复算（包括原应有附件行缺失）均以 `MATERIAL_UNVERIFIED` 返回零候选；断裂的流同样停止规划。fingerprint 只证明发送时记录的**元数据完整性**，默认不证明附件 BLOB **字节完整性**；`limits.deepVerifyBytes:true` 才扫描附件数据并核 SHA-256，成本更高。`holds` 为逐主体正常阻塞明细，`proposedFloor` 只是模拟值，不得直接持久化。

`clock` 必须为安全、非回退的毫秒时间；`timeGuard(now,lastObservedAt)` 可选且须同步显式返回 `true`。显式 async 函数被拒绝；回调抛错 fail closed；需要调用方保证纯同步回调（伪装同步返回 thenable 的函数不会被等待）。本模块只读取持久 `im_clock`，**不调用会更新 `im_clock` 的 core `runRead`**。快照要求调用时连接没有已打开事务，否则 `INVALID_INPUT`；异常路径回滚只读事务。单次时间安全并不保证跨调用时钟单调。前跳默认 24 小时；`limits.maxScanRows` 默认 10000、`maxScanBytes` 默认 100 MiB：先在同一快照有界读取轻量 ID/UTF-8 内容长度/BLOB 长度并累计，任何超预算正文和附件 BLOB 均不投影加载；预算以内正文逐条读取，深校验附件 BLOB 逐对象读取，非一次性加载全部。扫描上限约束逻辑正文＋附件内容字节，另有少量 SQLite 元数据、驱动内部执行与临时缓冲开销，不是进程内存硬上限。超扫描预算报告 `complete:false` 和零候选；`maxCandidates` 默认 10000、`maxCandidateBytes` 默认 100 MiB，为候选的绝对上限而非相对“激增”。超限停止并标记 `protections`。由于只读规划不会更新时钟锚点，长期未被 core 写入的数据库可能触发前跳保护。`limits.maxRows/maxBytes` 默认每批 100 行 / 10 MiB，均只用于分组报告；同一 message 的 delivery/message/attachment 是不可拆组，超批预算整组列为 `oversized:true`，包含明确 `groups` 边界，绝不执行批量操作。

| 推荐基线（必须显式配置；本实现不会自动启用） | 建议值 |
| --- | ---: |
| 安全重试窗口 | 7 天 |
| 消息、附件、幂等回放材料 | 各 90 天 |
| 审计在线留存 | 180 天 |
| 物理批删预算（未来实现） | 100 行 / 10 MiB，间隔 500 ms，单次 60 s / 100 MiB |

物理清理必须另行追加 tombstone / 内容过期协议、保留发送 key 永久不可复用的语义、可检测 cursor reset、附件/消息历史引用处理、备份与恢复演练及审查。**当前报告不构成生产清理或上线批准。**
