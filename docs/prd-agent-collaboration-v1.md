# PRD：Agent 协作链路增强（P0–P2）

|字段|内容|
|---|---|
|文档编号|待定|
|版本|v0.3（草案）|
|创建日期|2026-10-08|
|最后更新|2026-10-08|
|负责人|洪伟填|
|状态|评审中（本次交付范围 P0-1/P0-2/P0-5 已确认，D6 按推荐 A 方向推进）|
|适用基线|当前 LAN 版中心（`0.0.0.0:18787`，7 名登记成员）|

> **范围声明**：本 PRD 只针对**现行 LAN 版**（`src/server.js` + `src/mcp.js` + `src/db.js`）的 Agent 协作体验。它**不**改变 WP0–WP4 的既有门槛，**不**宣称 im-v2 任一阶段验收，**不**授权公网部署、物理清除或发布。文中「已实现」一律指仓库内代码事实，**不等于**已验收或已上线。

---

## 1. 背景

### 1.1 现状

team-mailbox 已在内网部署，登记 7 名成员（含 2026-10-08 新增的 `mac-e2e`）。Agent 之间的协作走这条链路：

```Plain Text
派单Agent → [WORK:v1][FIX][TEST][A-1042] + JSON(on-duty.work.v1) → send_message
                     ↓  服务端只落库 id/from/to/title/text/project/read_at
执行Agent → 轮询 get_unread_summary → getmsg → read_message（读完即标已读）→ 执行
                     ↓
          → [RESULT:v1][QA][A-1042][r1] PASS/FAIL + JSON → send_message
```

工单协议 `on-duty.work.v1` 由 Skill `team-mailbox-dispatch` 定义，字段严谨（ticket_id、revision、code.head_commit、constraints.allow_push 等），并设有多道人工确认门禁。

### 1.2 调研结论：断裂发生在「协作状态」层，不是传输层

传输层（文本、附件、权限隔离、未读统计）已够用。真正拖累体验的是三组**自相矛盾**：

|矛盾|一端|另一端|
|---|---|---|
|判重 vs 读取|Skill 要求同 ticket+revision 比对全文判冲突|`getmsg` 只给 80 字摘要，比对全文须 `read_message`，而它**读完即标已读且不可逆**|
|追溯 vs 查证|RESULT 必填 `original_message_id`、`previous_report_id`|发件方**无发件箱**，自己发的附件再下载还会 403|
|自动协作 vs 唤醒|目标是 Agent 间协作|MCP 层无推送，只能盲轮询；宿主会话不会被消息唤醒|

### 1.3 四项关键发现（修正早期判断）

调研中发现**四处能力已建成但未接通**，这直接改变了本 PRD 的性质——多数工作是**接线与选型**，而非**新建**：

|发现|证据|影响|
|---|---|---|
|**`GET /api/unread-metadata` 已实现且已挂载**，返回 `id / from / title / time / attachment`，**不含任何正文**、**不标已读**、支持 `from`/`cursor`/`limit`|`src/server.js:250-266`、`src/db.js:241-264`|`src/mcp.js` **完全没有暴露它**。Agent 拿不到这个能力，只能退回 `getmsg`+`read_message`。这是 1.2 第一组矛盾的现成解|
|**`src/duty/` 是一套完整的工单内核**：`duty_work` 具备 `UNIQUE(member,sender,project,ticket,revision)` 与 `UNIQUE(member,content_digest)`、`PENDING/PROCESSING/AWAITING_UAT/BLOCKED/COMPLETED` 状态机、`lease_until_ms`+`fence` 单消费者租约、`version` 乐观锁、`duty_requests(request_id)` UUID 幂等、`duty_grants` 凭据与会话绑定、`duty_events` 审计|`src/duty/store.js:155-196,285-378`、`src/duty/consumer.js:33-80`、`src/duty/protocol.js:75-79`，测试见 `tests/duty-{store,consumer,integration,protocol}.test.js`，引入于 commit `1c4b4a3`|`src/server.js` 与 `src/mcp.js` 对 `duty` **零引用**（grep 无匹配）。即"工单状态全靠 prompt 约定"这一判断仅对**线上运行路径**成立，对仓库代码并不成立|
|**`src/im/` 是一套完整的 `a2a-msg.im.v1` 实现**（72 个文件）：独立 `agentId`（UUID）、凭据鉴权、会话（conversation）、`clientMessageId` 幂等发送与 `recover_send`、接收租约 `acquire/renew/release`、journal-before-ACK 持久接收、`inReplyTo` 关联、TLS 传输。**并且已有一个现成的 MCP 适配器 `createImMcpAdapter`，暴露 16 个 `im_v1_*` 工具**|`src/im/mcp-adapter.js:10-27,56`、`src/im/client.js`、`docs/im-mcp-adapter.md:3,15-28`|适配器是**未挂载的工厂**（unmounted factory）：无 stdio 入口、无宿主集成、无后台轮询（`im-mcp-adapter.md:3,32`）。`src/mcp.js` 对其**零引用**。本 PRD 原 P1-1（幂等）、P2-2（Agent 身份）、P2-3（ACK）**在该实现中均已存在**|
|**`src/bridge/` 是一套 OpenCode 任务桥接**：接收 IM 任务消息 → 调用本机 OpenCode HTTP API 执行 → 回传终态；含 IM 租约维持、`terminalID` 幂等回复、崩溃后"状态未知不自动重投"、项目白名单与凭据脱敏|`src/bridge/bridge.js:4,16-19,27-54`、`src/bridge/run.mjs:13-50`、`src/bridge/opencode.js:66-110`|这是 `a2a-opencode-task-bridge-v1.md:51` 描述的**目标机侧常驻桥接**，已有实现。入口为手动 `node src/bridge/run.mjs CONFIG`，**未纳入 `package.json` scripts**，未部署。⚠ **注意边界**：该文仍标注"待实现、待验收"的是**上游**侧（派发方记录 `taskId`→会话映射、由宿主适配层把回复投递回原会话）。即**执行侧已通，回灌上游会话这一段仍缺**|

> **重要澄清一**：`src/duty/getPayload` 带有显式注释「INTERNAL ONLY … Never return this object directly via MCP」（`store.js:333-334`），`createDutyConsumer` 默认 `enabled: false`（`consumer.js:33`），`approve()` 硬编码 `sender === '洪伟填' && project === 'tuantuan-rent'`（`store.js:201`）。**未接线是刻意的安全姿态，不是遗漏。**

> **重要澄清二（本 PRD 最关键的结论）**：仓库里**同时存在两条技术路线**——
> - **旧 LAN 版**（`src/server.js` + `src/mcp.js` + `src/db.js`）：**正在运行**，7 名成员在用，但缺幂等、缺 ACK、缺 Agent 身份。
> - **IM v1/v2**（`src/im/`，72 文件）：这些能力**全部已实现并有 MCP 适配器**，但默认未挂载、未部署、按 `docs/roadmap.md:15` 的 A1–A8 快照**尚未通过跨机 LAN、跨网络 TLS、跨框架验收**。
>
> 因此本 PRD 面对的**不是"要不要造这些能力"，而是"往哪条路线投入"**。在旧 LAN 版上自建幂等/身份/ACK，会与 `src/im/` 形成第二套语义，制造长期双轨维护负担。本 PRD 据此把 P0/P1 严格限制为**不与 IM 路线冲突的低风险增量**，并把 P2 重新定义为**路线决策**而非功能开发（见 4.3 与 D6）。

### 1.4 为何现在做

`mac-e2e` 的接入把"同 IP 多 Agent 共享收件箱"从理论风险变成了近在眼前的现实。同时 P0 项里有两项几乎零代码即可缓解长期痛点，性价比窗口明确。

---

## 2. 目标

### 2.1 核心目标

|编号|目标|衡量标准|
|---|---|---|
|G1|第一层判重不再需要读正文|执行 Agent 能在**不触发已读**的前提下拿到候选消息的 id 与完整 title，完成第一层 ticket 判重与路由（`revision` 不在标题中，同 ticket 的 revision 比对仍需正文，属正当比对）|
|G2|取回与确认解耦|调用方可显式选择「读正文但不标已读」，崩溃或误读不再静默吞消息|
|G3|发件方可自证|发件方能查询自己发出的消息 id 与时间，超时后无需追问收件人即可判断是否入库|
|G4|重试安全|携带幂等键的重复 `send_message` 返回原消息 id，不产生重复行|
|G5|多 Agent 规则明确|同机多 Agent 的支持边界被写入文档并有可执行的软隔离方案|
|G6|唤醒链路可用|MCP 侧能感知新消息到达，不必纯靠固定间隔盲轮询（**完整的宿主会话唤醒见 `src/bridge/`，属 P2 评估范围**）|
|G7|**路线清晰**|对「旧 LAN 版自建 vs 迁移 `src/im/`」产出明确决策（D6），避免双轨语义长期并存|

### 2.2 非目标（本次不做）

- 打开 `src/duty/` 的运行时开关、放开其硬编码 sender/project、或经 MCP 暴露 `getPayload`。
- 在生产中心挂载 `createImMcpAdapter`、部署 `src/bridge/run.mjs`、或启用任何 `src/im/` 运行时。
- 对 `src/im/`、`src/duty/`、`src/bridge/` 的既有代码做任何修改。
- 群聊、广播、多附件、断点续传、消息撤回、标记为未读。
- 公网部署、TLS 传输、NAT 穿透。
- im-v2 的留存/清除/备份/时间权威任一子系统的交付或验收。
- 用本 PRD 替代 WP0–WP4 或整份 Agent IM v1 PRD 的验收。
- 为 OpenCode 之外的宿主提供等价插件。

---

## 3. 现状分析

### 3.1 关键问题清单

|编号|问题|证据|业务影响|目标结果|
|---|---|---|---|---|
|Q1|判重与已读语义冲突|`db.js:194`（80 字摘要）、`server.js:299-306`（末页自动标读）|为判重而读，读完消息从未读队列消失；Skill 的判重纪律事实上无法安全执行|提供无副作用的元数据通道|
|Q2|`unread_metadata` 已实现却未暴露|`server.js:250` 有，`mcp.js` 无|现成能力对 Agent 不可见|暴露为 MCP 工具|
|Q3|无发件箱|`server.js:224`、`db.js:199` 硬编码 `to_name = 当前成员`|超时后无法自证；RESULT 必填的 `original_message_id` 无从查起|支持发件箱查询|
|Q4|发件方被自己的附件 403|`server.js:342-344`（决策 C3，发件人同样拒绝）|本地临时文件丢失后无法找回自己刚发的文件|按需放开发件方元数据（见 6.2 取舍）|
|Q5|发送无幂等|`db.js:107-111` 纯 INSERT、无唯一约束；`mcp.js:20` 超时 10s|网络抖动后重试必然重复投递；Skill 因此禁止自动重发，改为人工介入|引入幂等键|
|Q6|同 IP 多 Agent 共享收件箱|`access.js:50-51`（重复 IP 绑定启动失败）、`server.js:129`|A 读走的消息对 B 永久不可见；A 崩溃则消息被静默吞没|明确规则 + project 软隔离|
|Q7|MCP 层无推送|`server.js:242` 有 SSE，`mcp.js` 未消费|只能盲轮询|MCP 侧接入 SSE|
|Q8|SSE 事件不含消息 id|`unread-events.js:28-33` 仅 `cursor/reason/summary`|收到事件后仍需回拉|保持（见 6.2），由 `unread_metadata` 承担增量拉取|
|Q9|工单内核未接线|`src/duty/*` 无任何 server/mcp 引用|线上工单状态仍靠 prompt 自觉|P2 评估（不在本期开启）|
|Q10|**IM v1 全量能力未接线**|`src/im/mcp-adapter.js` 为未挂载工厂（`im-mcp-adapter.md:3`）|Q5/Q6/Q9 的正解已存在却不可用；团队在旧 LAN 版上重复造轮子|P2-2 隔离验证 + D6 决策|
|Q11|**唤醒闭环执行侧已实现，上游回灌侧仍缺**|`src/bridge/` 实现了目标机侧常驻桥接；`a2a-opencode-task-bridge-v1.md:51` 标注待实现的是上游 `taskId`→会话映射与回灌|执行侧能力被低估而重复规划；真正的缺口被这层误解掩盖|P2-3 评估执行侧可用性，并单独识别上游回灌缺口|

### 3.2 已被刻意设计、不应轻易推翻的约束

以下均为有注释或文档支撑的**有意决策**，改动须单独评审：

- `get_unread_summary` 刻意不返回任何消息 id：侧栏常驻可见，返回 id 等于把内容线索暴露在界面上（`db.js:266-270,287-288`）。**本 PRD 不改它**，增量锚点改由 `unread_metadata` 承担。
- 附件对发件人同样 403，是为了让第三方与发件人得到**无差别**的响应，避免探测他人文件（`server.js:340-341`）。
- `read_message` 自动标读是 `prd-unread-notification.md` 的既定破坏性变更，不是 bug。本 PRD 只增加**可选退出**，不回滚默认行为。
- `src/duty/` 的默认关闭与 MCP 暴露禁令（见 1.3 澄清）。

---

## 4. 方案设计

### 4.1 P0：解除矛盾（本期必做）

|编号|改进项|方案|影响范围|
|---|---|---|---|
|P0-1|**暴露 `unread_metadata` MCP 工具**|新增工具 `unread_metadata({from?, cursor?, limit?})`，直通已有 `GET /api/unread-metadata`。返回 `{messages:[{id,from,title,time,attachment}], nextCursor, hasMore}`。工具描述须写明：**本工具不返回正文、不改变已读状态**，用于判重与路由|`src/mcp.js` 新增一个工具；**服务端零改动**。同步项：全仓「10 个工具/十个工具」计数表述（README、docs/tools.md、docs/client.md、integrations/opencode/README.md）与两处工具数测试断言（tests/e2e-mcp.test.js、tests/legacy-lan-compatibility.test.js）|
|P0-2|**「标题即索引」规约**|在 `team-mailbox-dispatch` / `team-mailbox-read` Skill 中规定：接单方先用 `unread_metadata` 的 `title` 解析 `ticket_id`/角色/`mode`（**`revision` 不在标题中**，dispatch 契约标题格式为 `[WORK:v1][FIX|QA][TEST|BUGFIX|TEST_FIX][ticket_id] summary`）完成第一层判重与路由：不同 `ticket_id` 判为不同工单，无需读正文；**同 `ticket_id` 候选**才下钻读正文比对 `revision` 与内容，且该读取属正当内容比对，不是探查|Skill 文档（repo `integrations/opencode/skills/` 与已安装副本同步更新）；**零代码**|
|P0-3|**`read_message` 支持 `mark_read: false`**|查询参数新增可选 `mark_read`（默认 `true`，保持现行行为）。为 `false` 时跳过 `markMessagesRead`，响应 `markedRead: false`。`mark_read` 工具仍是显式确认入口|`src/server.js` 读取分支、`src/mcp.js` 工具 schema|
|P0-4|**发件箱查询**|`getmsg` 新增可选 `box`（`inbox`\|`sent`，默认 `inbox`）。`sent` 时按 `from_name = 当前成员` 过滤，复用既有分页；**`sent` 结果不含 `read` 字段**（他人已读状态不回传给发件方，见 6.2）|`src/db.js` 查询条件、`src/server.js`、`src/mcp.js`|
|P0-5|**多 Agent 运维规则**|文档明确「**一个 member = 一个 Agent 进程**」。确需同机多 Agent 时，为每个 Agent 分配独立 `project` 并只消费本 project（`getmsg` 支持 `project` 与 `from` 过滤；`unread_metadata` 仅支持 `from`，**不支持 `project`**）。这是 v1 下唯一可行的软隔离，**不提供身份隔离保证**|`docs/admin.md`、`docs/client.md`、README 边界章节|

### 4.2 P1：降低摩擦

|编号|改进项|方案|影响范围|
|---|---|---|---|
|P1-1|**发送幂等键**（⚠ 受 D6 路线决策约束）|`send_message` / `send_file` 新增可选 `client_token`（UUID v4）。DB 增列 `client_token TEXT` 并建 `UNIQUE(from_name, client_token)` 部分索引（仅非 NULL）。命中唯一冲突时**返回原消息的 id 与 createdAt**，HTTP 200（区别于新建的 201），响应带 `deduplicated: true`。无 token 时行为完全不变。**注意：`src/im/` 已用 `clientMessageId` 实现等价语义（`mcp-adapter.js:16-17`），本项会形成第二套幂等语义。若 D6 选择迁移 IM 路线，本项应直接取消**|`src/db.js`（增列 + 索引，增量迁移不重建表）、`src/server.js`、`src/mcp.js`|
|P1-2|**MCP 侧接入 SSE**|bridge 订阅 `GET /api/unread-events`，维护本地「有新未读」标志，供工具调用时附带提示；连接失败静默降级为既有轮询。**不**改变 SSE 事件载荷|`src/mcp.js` 或新增 bridge 模块|
|P1-3|**Skill 对齐幂等**|`send_message` 具备 `client_token` 后，放宽 Skill「超时禁止自动重发」为「**携带同一 client_token** 可安全重发一次；仍失败则人工介入」|Skill 文档|
|P1-4|**附件发件方元数据**|`GET /api/attachments/:id` 保持 403 不变；新增**仅元数据**（name/size/sha256，无 `data_base64`）的发件方可读路径，用于自证发出内容。**是否开放须经 6.2 决策**|`src/server.js`（待决）|

> **P1-2 对早期建议的修正**：曾设想让 `get_unread_summary` 返回 `latestId` 作为增量锚点。经核实该字段是被**刻意剥离**的（`db.js:287-288`），不应为省一次往返而破坏常驻面板的隐私契约。增量锚点由 `unread_metadata` 的 `nextCursor` 承担，该建议**作废**。

### 4.3 P2：路线决策（本期只做评估与验证，不写新功能代码）

**P2 的性质已因 1.3 的发现而改变。** 原计划的「Agent 身份」「ACK 断点续收」「工单状态机」**在 `src/im/` 与 `src/duty/` 中均已实现**。因此 P2 不再是开发任务，而是**选型与验证任务**：

|编号|事项|内容|前置门禁|
|---|---|---|---|
|P2-1|**路线评估（D6 的输入）**|对比两条路径的总成本：① 在旧 LAN 版上逐项自建（P1-1 式增量，语义与 `src/im/` 重复）；② 挂载 `createImMcpAdapter` 并迁移到 IM 路线。产出一份包含迁移成本、回滚方案、双轨期长度的评估|无（纯文档）|
|P2-2|**`createImMcpAdapter` 隔离验证**|⚠ **功能可用性已由 14 项测试实测通过（见 6.5），本项不再重复验证功能。** 真正要验的是两项运维门槛：① **Windows ACL 降级**（`--trust-windows-permissions`）是否可接受；② **生产 TLS 证书**的获取、分发与轮换成本|① 不得接触生产 DB 与现行中心；② 不得改动 `src/im/` 代码；③ 需自备 TLS 与凭据（`im-mcp-adapter.md:32`）|
|P2-3|**`src/bridge/` 唤醒链路评估**|评估 `src/bridge/run.mjs`（目标机执行侧）的可行性，并**单独确认上游回灌缺口**（`taskId`→发起会话映射，`a2a-...:51` 仍待实现）。注意它依赖 OpenCode 本地 HTTP API 与 IM 路线，**不能单独嫁接到旧 LAN 版**|① 隔离环境；② 它会真实执行远端任务，安全边界须单独评审；③ 评估须明确区分"执行侧已通"与"上游回灌未通"|
|P2-4|**`src/duty/` 定位澄清**|确认 `duty` 与 `im` 的关系（是否 duty 为旧 LAN 版的工单层、im 为新传输层），避免三套语义并存。若 IM 路线胜出，评估 `duty` 是否应归档|无（纯文档）|

> **本期 P2 不交付任何功能代码，不开启 `duty`，不挂载 `im` 适配器到生产。** 所有验证在隔离环境进行。

---

## 5. 接口与数据契约

### 5.1 新增 MCP 工具 `unread_metadata`（P0-1）

```json
{
  "messages": [
    { "id": 312, "from": "利浩文", "title": "[WORK:v1][FIX][TEST][A-1042] 导出超时", "time": "2026-10-08T06:12:00.000Z",
      "attachment": { "id": 88, "name": "case.json", "size": 2048, "mime": "application/json", "sha256": "..." } }
  ],
  "nextCursor": null,
  "hasMore": false
}
```

契约：无正文、无 project 字段（沿用服务端现状）、**调用不改变任何消息的已读状态**。身份仍由来源 IP 判定，只返回本人收件箱。

### 5.2 `read_message` 新增 `mark_read`（P0-3）

```Plain Text
GET /api/messages/:id?offset=0&limit=2000&mark_read=false
→ { "id": 312, "read": false, "markedRead": false, "hasMore": false, "text": "..." }
```

默认 `true`，与现行行为一致。`false` 时即便读到有效末页也不标读。

### 5.3 `getmsg` 新增 `box`（P0-4）

```Plain Text
getmsg({ box: "sent", limit: 10 })
→ { "messages": [ { "id": 311, "to": "李嘉华", "title": "...", "time": "...", "project": "...", "attachment": null } ], ... }
```

`box="sent"` 时返回 `to` 而非 `from`，**不返回 `read`**。

### 5.4 幂等发送（P1-1）

```Plain Text
POST /api/messages  { "to": "...", "text": "...", "client_token": "f47ac10b-..." }
首次 → 201 { "id": 313, "createdAt": "...", "deduplicated": false }
重放 → 200 { "id": 313, "createdAt": "...", "deduplicated": true }
```

Schema 变更：`ALTER TABLE messages ADD COLUMN client_token TEXT` + `CREATE UNIQUE INDEX ... ON messages(from_name, client_token) WHERE client_token IS NOT NULL`。增量迁移，**不重建 messages 表**，历史行不受影响。

### 5.5 错误分类

|分类|触发|返回|调用方处理|
|---|---|---|---|
|幂等冲突（同 token 不同内容）|`client_token` 已存在但 payload 不同|`409 Idempotency conflict`|**不得**静默覆盖，向人报告（对齐 Skill 冲突纪律）|
|`box=sent` 越权|请求他人发件箱|不提供该参数组合|参数层拒绝|
|`mark_read` 非法值|非布尔|`400`|修正参数|
|SSE 不可用|中心未升级或连接失败|bridge 静默降级|回退轮询，不报错、不阻塞|

---

## 6. 技术约束与风险

### 6.1 向后兼容

- P0-1/P0-3/P0-4、P1-1 均为**新增可选参数或新增工具**，旧 bridge 与旧调用方行为不变。
- P1-1 为 schema 增列 + 部分唯一索引，增量迁移，不重建表，历史消息 id/正文/已读/时间不变。
- 未升级的成员：看不到新工具，`read_message` 仍默认自动标读，不影响收发。
- 与 im-v2 的关系：本 PRD **只动现行 LAN 版**，不触碰 v2 schema/契约/默认关闭状态。若未来 v2 接管，本期的 `client_token` 与 `box` 语义需在 v2 迁移中单独评估。

### 6.2 待决策项（需负责人确认后方可实施）

|编号|事项|选项|倾向|
|---|---|---|---|
|D1|`box=sent` 是否返回对方已读状态|A 不返回（保守）／B 返回|**A**。已读是收件人隐私，且回传会制造"已送达=已处理"的误判|
|D2|P1-4 发件方附件元数据是否开放|A 维持全 403／B 仅发件方可读元数据（无字节）／C 可重新下载|**B**。解决自证需求且不破坏"无差别响应"的探测防护；C 风险最高|
|D3|P0-3 的 `mark_read` 默认值|A 默认 `true` 保持现状／B 默认 `false` 回归旧语义|**A**。`prd-unread-notification.md` 的自动已读是既定决策，不在本期回滚|
|D4|P2-1 是否解除 duty 的硬编码 sender/project|A 本期不动／B 配置化|**A**。P2 本期只出设计，不改代码|
|D5|P0-5 是否需要运行时强制（如同 member 并发连接检测）|A 仅文档约定／B 服务端告警／C 硬拒绝|**A 或 B**。C 会误伤正常的 bridge 重连|
|**D6**|**技术路线：旧 LAN 版自建增量 vs 迁移 `src/im/`**（**本 PRD 最重要的决策，决定 P1-1 与整个 P2 的去留**）|**A** 只做 P0，P1-1 暂缓，先做 P2-1/P2-2 评估再定／**B** P0+P1 全做，IM 路线另行长期推进（接受双轨）／**C** 直接投入 IM 路线，旧 LAN 版只做 P0 止血|**A**（推荐依据见 6.5）。P0 无论如何都值得做且不与任何路线冲突；P1-1 会制造第二套幂等语义，应在 P2-2 隔离验证拿到结论后再决定。选 B 需明确承担双轨维护成本|

### 6.5 D6 推荐依据（2026-10-08 实测）

**推荐：选 A。理由不是「IM 不成熟」，恰恰相反——它比预期成熟，但有一项 Windows 运维硬约束使「立即迁移」不可取。**

**实测证据（本机 Windows 实跑）**：

```Plain Text
node --test tests/im-mcp-adapter.test.js tests/im-client.test.js tests/im-core-integration.test.js
→ tests 14 / pass 14 / fail 0 / duration_ms 867
```

其中直接覆盖本 PRD 痛点的用例：

|用例|对应问题|
|---|---|
|`stage failure precedes network; lost response reuses exact key, no blind resend`|Q5 发送幂等|
|`attachment digest failure never ACKs; saved file survives journal failure and reopen`|接收可靠性|
|`lost ACK leaves durable pending; reopen revalidates fence and retries exact IDs`|崩溃恢复 / 断点续收|
|`real HTTPS handler + CA verified client send, attachment receipt, ACK and reopen`|端到端链路|
|`MCP adapter: real core, scoped identity, strict tools, durable attachment before ACK`|适配器可用性|

**阻碍立即迁移的硬约束（均为 Windows 相关，与功能无关）**：

|约束|证据|
|---|---|
|Node 无法可靠校验 Windows NTFS ACL，受保护文件检查**失败关闭**|`docs/im-bootstrap.md:9`|
|Windows 下须加 `--trust-windows-permissions`，其语义是「操作者接受 ACL 未经验证」，**不是**管理员身份认证|`docs/im-bootstrap.md:9`|
|v2 严格 owner 锁**仅限原生 Unix，Windows 拒绝**|`docs/roadmap.md:27`、`docs/im-migration-validation.md:7`|
|初始化脚本**不生成生产证书**，仓库内为 localhost 测试专用证书|`docs/im-bootstrap.md:20`|

**结论**：现行中心运行在 Windows（`D:\team-mailbox`，`0.0.0.0:18787`）。立即迁移等于主动降低一层文件保护保证，并需自备真实 TLS 证书链。因此 P2-2 隔离验证的**真正目标不是验证功能**（已由 14 项测试覆盖），而是验证 **Windows ACL 降级是否可接受** 与 **生产 TLS 证书的获取与维护成本**。

### 6.3 风险

|风险|影响|应对|
|---|---|---|
|`unread_metadata` 暴露后被误用为"读消息"|Agent 拿 title 当正文，判断失真|工具描述显式声明"仅元数据，判重与路由用，非正文"；Skill 规定下钻时机|
|`mark_read:false` 被滥用|消息永不标读，未读无限堆积|Skill 规定：判重用 `false`，真正处理后必须显式 `mark_read`|
|幂等键由调用方生成|Agent 复用同一 token 发不同内容|服务端对同 token 不同内容返回 409，不静默合并|
|`box=sent` 扩大查询面|发件方可枚举自己历史|仅限本人 `from_name`，与收件箱同等分页限制|
|误把 `src/duty/` / `src/im/` / `src/bridge/` 当成"已上线能力"|对外宣称工单状态机、Agent 身份、ACK 已可用|三者均**已实现但未接线、未部署、未验收**。`src/im/` 的 A1–A8 验收快照见 `docs/roadmap.md:15`；适配器为未挂载工厂见 `docs/im-mcp-adapter.md:3`。任何对外表述必须带此限定|
|**在旧 LAN 版自建 P1-1，与 `src/im/` 形成双轨**|两套幂等语义长期并存，迁移时需二次改造，维护成本翻倍|**这是本 PRD 识别出的最大结构性风险。** 通过 D6 显式决策；倾向先做 P2-2 隔离验证再定 P1-1 去留|
|同机多 Agent 仍会踩共享收件箱|P0-5 只是约定，无强制|在 `mac-e2e` 等新接入点落地时逐个确认；P2-2 才是正解|

### 6.4 技术约束

- 身份仍是 IP 单射，**P0/P1 不改变这一点**；同机多 Agent 的隔离只能到 `project` 粒度。
- SSE 单成员 8 连接、全服 128 连接上限（`unread-events.js:8-9`），bridge 需复用而非每工具一连。
- MCP 请求超时 10s（`mcp.js:20`），幂等键解决的是重试安全，不缩短超时。
- 本期全部改动仍为明文 LAN，不具备公网部署条件。

---

## 7. 实施状态

### 调研 ✅ 已完成

代码层与设计层双线盘点完成，**四项「已建成未接线」能力已核实**（见 1.3）。

### 开发 ⏳ 未开始

P0、P1 全部未实施。P2 的四项均为评估/验证任务，未开始；相关代码（`src/duty/`、`src/im/`、`src/bridge/`）已存在但本 PRD 不修改它们。

### 测试计划

|范围|覆盖|
|---|---|
|`unread_metadata`|返回 id/title 正确；**调用前后 `read_at` 不变**；`from`/`cursor`/`limit` 过滤与分页；只返回本人收件箱|
|`mark_read:false`|末页不标读；`markedRead:false`；随后显式 `mark_read` 仍可标；默认 `true` 行为与现状逐字一致|
|`box=sent`|只返回本人发出；不含 `read`；分页正确；`inbox` 默认行为不变|
|幂等|同 token 同内容返回原 id 且不新增行；同 token 不同内容 409；无 token 行为不变；并发同 token 不产生双行|
|迁移|增列后历史消息 id/正文/已读/附件关联不变；`doctor` 通过|
|SSE 降级|中心未升级、连接中断、超限时 bridge 不抛异常、不阻塞工具调用|
|多 Agent|同 project 过滤下两 Agent 互不消费对方消息（**仅验证软隔离，不验证身份隔离**）|
|回归|现有测试套件全绿；附件、auto_name、403 隔离、自动已读默认行为不变|

---

## 8. 验收标准

|序号|验收项|方法|预期|
|---|---|---|---|
|1|元数据不污染已读|对未读消息调 `unread_metadata` 后查 `get_unread_summary`|计数不变，消息仍未读|
|2|标题可判重|发两条**不同 ticket** 的 WORK|仅凭 `unread_metadata` 的 title 即可判为不同工单并完成路由，无需读正文。同 ticket 不同 revision 仍需读正文比对 revision（属正当比对需求）|
|3|读而不标|`read_message(mark_read:false)` 读到末页|`markedRead:false`，侧栏仍显示|
|4|默认行为不变|`read_message` 不传 `mark_read`|与升级前逐字一致，`markedRead:true`|
|5|发件方自证|发一条消息后 `getmsg({box:"sent"})`|能查到该条 id 与时间|
|6|幂等生效|同 `client_token` 连发两次相同内容|返回同一 id，DB 只有一行，第二次 `deduplicated:true`|
|7|幂等冲突可见|同 token 不同内容|409，不产生新行，调用方收到明确冲突|
|8|迁移无损|升级前后对比消息总数、最大 id、已读数|完全一致|
|9|SSE 降级|停止中心后调用任一 MCP 工具|正常返回错误，不因 SSE 失败而额外失败|
|10|文档一致|检查 README / docs / Skill|多 Agent 规则、`duty` 未接线状态、新工具语义均已写明且无过度承诺|

---

## 9. 上线与验证顺序

**阶段 0 — 基线**：`npm run admin -- backup` 备份 DB；记录消息总数、最大 id、未读数；备份 `access.json`。

**阶段 1 — P0 零风险项**：实施 P0-1（仅 bridge）与 P0-2、P0-5（仅文档）。P0-1 不改服务端，可先行验证。

**阶段 2 — P0 服务端项**：实施 P0-3、P0-4，跑全量测试，本机验证默认行为未变。

**阶段 3 — 中心升级**：停中心 → 升级 → 按 `log/start-center.mjs` 重启 → `doctor` 健康检查 → 对比阶段 0 基线数据。

**阶段 4 — P2 评估先行（顺序已调整）**：先做 P2-1 路线评估与 P2-2 隔离验证，产出 D6 决策依据。**此阶段不碰生产。**

**阶段 5 — P1（以 D6 结论为准）**：
- D6 选 A：只做 P1-2（SSE，与路线无关）；P1-1 按 P2-2 结论再定。
- D6 选 B：按原计划做 schema 迁移（P1-1）→ SSE（P1-2）→ Skill（P1-3）。
- D6 选 C：跳过 P1-1，资源转向 IM 路线。

P1-4 待 D2 决策。

> **顺序调整原因**：P1-1 涉及 schema 变更且与 `src/im/` 语义重复，在 D6 未决前实施会产生难以回滚的双轨成本。P0 全部项与路线无关，可无条件先行。

> 每阶段之间需确认上一阶段验收项通过；任一阶段失败则回滚至阶段 0 备份并停止推进。

---

## 10. 待确认决策汇总

D1–D6 见 6.2，需负责人逐项确认后本 PRD 方可进入实施。

- **D6（技术路线）优先级最高**：它决定 P1-1 与整个 P2 的去留。建议先定 D6，其余决策随之收敛。
- **D2（发件方附件元数据）** 与 **D4（duty 硬编码）** 涉及安全边界，建议单独评审。
- D1/D3/D5 为低风险项，可随 P0 一并确认。

> **给评审者的一句话**：本 PRD 最有价值的产出不是 P0 那几个小改动，而是发现了**团队正准备自建的能力，仓库里已经实现了一整套**（`src/im/` 72 文件 + 16 个 MCP 工具 + 完整 ACK/租约/幂等），且**已实测 14/14 通过**。真正的门槛不在功能，而在 Windows ACL 与生产 TLS（见 6.5）。请优先就 D6 给出方向。

---

## 11. 变更记录

|版本|日期|变更|
|---|---|---|
|v0.1|2026-10-08|初稿：P0–P2 方案、四项「已建成未接线」发现、D1–D6 决策项|
|v0.2|2026-10-08|新增 6.5 D6 推荐依据（IM 核心 14/14 实测通过 + Windows ACL/TLS 硬约束）；P2-2 目标由「验证功能」修正为「验证运维门槛」；D6 标注推荐选项 A|
|v0.3|2026-10-08|交付前事实修正：`unread_metadata` 不支持 `project` 过滤（P0-5 行）；`revision` 不在标题中，第一层判重仅到 `ticket_id` 粒度（G1/P0-2/验收项 2）；P0-1 补充文档计数与测试断言同步项；5.1 示例修正为与实际一致（末页 `nextCursor` 为 `null`）。交付范围经用户确认为 P0-1/P0-2/P0-5|

---

## 附录 A：证据索引

|主张|位置|
|---|---|
|身份为 IP 单射，重复绑定启动失败|`src/access.js:50-51`|
|身份取自 socket 来源 IP|`src/server.js:129`|
|收件箱查询硬编码当前成员|`src/server.js:224`、`src/db.js:199`|
|列表摘要截断 80 字|`src/db.js:194,223`|
|列表返回完整 title|`src/db.js:227`|
|读到有效末页自动标读|`src/server.js:296-313`|
|标读为收件人范围内、仅未读行的原子更新|`src/db.js:303-323`|
|`unread-metadata` 端点已挂载|`src/server.js:250-266`|
|`getUnreadMetadata` 不选取正文|`src/db.js:240-264`|
|未读汇总刻意不返回 id|`src/db.js:266-270,287-288`|
|SSE 端点已挂载|`src/server.js:242-247`|
|SSE 载荷仅 cursor/reason/summary|`src/unread-events.js:28-33`|
|SSE 连接上限 8/128|`src/unread-events.js:8-9`|
|附件对发件人同样 403|`src/server.js:340-344`|
|`reply_to` 已废弃，新消息写 NULL|`src/db.js:105-111`|
|插入无唯一约束、无幂等|`src/db.js:103-132`|
|MCP 超时 10s|`src/mcp.js:20`|
|MCP 未暴露 unread-metadata / duty|`src/mcp.js`（grep 无匹配）|
|duty 工单表与唯一约束|`src/duty/store.js:155-196`|
|duty 租约、fence、幂等请求|`src/duty/store.js:271-378`|
|duty `getPayload` 禁止经 MCP 暴露|`src/duty/store.js:333-334`|
|duty consumer 默认关闭|`src/duty/consumer.js:33,41`|
|duty 硬编码 sender/project|`src/duty/store.js:201`|
|工单协议字段与校验|`src/duty/protocol.js:75-79`、`docs/duty-protocol.md:3-7`|
|IM MCP 适配器 16 个工具与 schema|`src/im/mcp-adapter.js:10-27`、`docs/im-mcp-adapter.md:9-27`|
|IM 适配器为未挂载工厂、无宿主集成|`docs/im-mcp-adapter.md:3,32`|
|IM `clientMessageId` 幂等与 recover_send|`src/im/mcp-adapter.js:15-17`、`src/im/client.js:111`|
|IM journal-before-ACK 接收|`docs/im-mcp-adapter.md:25-28`、`src/im/journal.js:62-65`|
|IM 租约 acquire/renew/release|`src/im/mcp-adapter.js:22-24`|
|IM 协议常量|`src/im/contracts.js:4`|
|bridge 任务执行与终态幂等|`src/bridge/bridge.js:16-19,58-68`|
|bridge 租约维持与崩溃不自动重投|`src/bridge/bridge.js:4,33-54`|
|bridge 手动入口、未入 package scripts|`src/bridge/run.mjs:13-24`、`package.json:9-15`|
|IM A1–A8 验收快照（未通过跨机/跨网/跨框架）|`docs/roadmap.md:15`|
|上游 taskId→会话回灌仍待实现（执行侧已实现）|`docs/prd/a2a-opencode-task-bridge-v1.md:51` vs `src/bridge/bridge.js`|
|工单 Skill 判重与人工门禁|`team-mailbox-dispatch/SKILL.md:23-24,43-44,50,54,63`|
|自动已读为既定决策|`docs/prd-unread-notification.md:107-111`|
|README 自述不支持同 IP 多 Agent|`README.md:22`|
