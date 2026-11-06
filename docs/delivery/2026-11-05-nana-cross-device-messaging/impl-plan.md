---
type: impl-plan
slug: 2026-11-05-nana-cross-device-messaging
status: active
updated: 2026-11-06
summary: "T2 最小双端往返：本机隔离 IM v1 中心 + 两个合成 Nana 身份 + 接收端队列/主会话交接适配层 + 可复跑验收演示。"
---

# T2 打通最小双端消息往返 · 实现计划

## 需求与权威

- 派发：nanazi `2026-11-05-nana-cross-device-messaging#T2`（主会话 8c23d28b · 11-06），分支 `goudaren0528/11-06-t2-pi`，基线 `origin/master` `d3c5ee4`。
- 权威：`plans/2026-11-05-nana-cross-device-messaging.md#T2`（nanazi）与 T1 报告 `reviews/research/2026-11-05-a2a-msg-reconnect.md` §8「最小双端往返验收剧本」、§9.1 推荐路线。
- 口径（本人 2026-11-05 修正）：身份跟 agent 走、一设备多 agent；通道不依赖 Orca；接收端独立进程；与 Nana 常驻会话解耦，通过适配层对接。

## 目标与非目标

**目标**：在本机起一个隔离的 a2a-msg IM v1 中心，两个合成 Nana 身份完成「发送 → 接收 → 回执」往返；接收端把消息持久化后交回主会话/队列；重复投递与重启恢复有证据。

**非目标**（T1 §9.1 第 6 条）：不做附件、不做真实设备/LAN/公网部署、不做 TLS 证书签发、不改 `src/im/` 与 `src/bridge/`、不接真实对端、不注册开机自启、不做 7 天留存与 AC-10/AC-23 契约。

## 现状与复用

| 能力 | 现有实现 | 本包怎么用 |
| --- | --- | --- |
| 身份 / 凭据 / 联系人 ACL | `src/im/admin.js`、`src/im/keystore.js`、`scripts/im-bootstrap.mjs` | 新脚本按同样写法注册两个身份、双向联系人、0700/0600 保护文件 |
| 中心 | `scripts/im-center.mjs` + `src/im/server.js` | 直接以独立进程启动（验收剧本第 2 步） |
| 发送 / 幂等 / 回执查询 | `src/im/client.js`、`src/im/mcp-adapter.js`（16 个 `im_v1_*` 工具） | 适配层复用未挂载的 MCP adapter 工厂 |
| journal-before-ACK 接收 | `src/im/journal.js`、`im_v1_sync` / `im_v1_ack_pending` | 接收端持久化队列直接用 journal 表，ACK 前落盘 |
| 队列 / 主会话交接 | `src/bridge/run.mjs` 直接读 `im_client_received`（OpenCode 专用） | 抽成与宿主无关的会话适配层 + CLI |
| 验收剧本 | T1 报告 §8 | 新演示脚本按步骤执行并产出 `summary.json` / `evidence.jsonl` |

T1 建议的 Python 适配层（`tools/ps_a2a.py` + `ps_store.ingest`）在 nanazi 仓，本任务工作目录限定在 a2a-msg；本包在 a2a-msg 内实现等价的 Node 适配层，接口与判据不变，见「风险与待定」1。

## 技术方案

1. `scripts/im-nana-provision.mjs`：新建绝对且不存在的 root，迁移 schema 3 中心库，注册两个可配置显示名的合成身份（默认 `nana-home` / `nana-office`），签发凭据、设双向联系人、启用写入策略；产出 `center-config.json`、两份凭据、`host-a/nana.json`、`host-b/nana.json`。stdout 只打印路径与 agentId，不打印密钥内容。
2. `src/nana/config.js`：会话配置严格校验（`serverUrl` https origin、`agentId` UUID、绝对路径、无未知字段）。
3. `src/nana/session.js`：宿主无关适配层。基于 `createImMcpAdapter` + `createImJournal`：
   - `acquire` / `release` / `receive`：`receive` = acquire → `ack_pending` 对账 → `sync`（journal 落盘后 ACK）→ release；每次调用使用新 `instanceId`/`requestId`，游标由 journal 续接。
   - `queue` / `handoff`：读 `im_client_received` 作为持久队列，`handoff` 用独立的 `session-state.json`（临时文件 + fsync + rename）记录已交接游标，返回消息内容给主会话，并把元数据追加到 `evidence.jsonl`。
   - `send` / `message` / `read` / `status`：发送（同 `clientMessageId` 幂等）、查 `deliveredAt`/`readAt`、标已读。
   - 错误只暴露固定 IM 错误码；不打印凭据与远端正文。
4. `scripts/im-nana-session.mjs`：上述适配层的 CLI（`status|receive|handoff|send|message|read`），机器可读 JSON 输出，供常驻会话/宿主调用。
5. `examples/im-nana-roundtrip.mjs`：按 T1 §8 的步骤跑完整闭环（独立中心进程 + 两个身份 + 重复投递 + 重启恢复 + 回复 + 已读 + 负例），保留 `$ROOT`、`summary.json`、两份 `evidence.jsonl`。

## 接口约定

### 会话配置（`host-*/nana.json`，严格字段）

```json
{
  "serverUrl": "https://localhost:8787",
  "agentId": "<uuid>",
  "credentialFile": "/abs/root/credentials/agent-a-credential",
  "journalPath": "/abs/root/host-a/journal.sqlite",
  "attachmentDirectory": "/abs/root/host-a/attachments",
  "statePath": "/abs/root/host-a/session-state.json",
  "evidencePath": "/abs/root/host-a/evidence.jsonl"
}
```

`evidencePath` 可选；`attachmentDirectory` 必须已存在（本包不接收附件）。

### CLI（`scripts/im-nana-session.mjs`）

| 子命令 | 参数 | 输出（stdout JSON） |
| --- | --- | --- |
| `status` | `--config` | `{agentId, received, handedThrough, pending, cursor}` |
| `receive` | `--config`、`--limit?` | `{instanceId, generation, received:[{seq,messageId,senderAgentId,title,recordedAt}], reconciled:[messageId]}` |
| `handoff` | `--config`、`--limit?` | `{handedThrough, items:[{seq,messageId,senderAgentId,title,text,inReplyTo,correlation,acceptedAt,recordedAt,acked}]}` |
| `send` | `--config`、`--to-agent`、`--text`、`--client-message-id?`、`--title?`、`--in-reply-to?`、`--correlation?` | `{status,clientMessageId,messageId,acceptedAt}` |
| `message` | `--config`、`--message-id` | `{messageId,senderAgentId,recipientAgentId,clientMessageId,acceptedAt,deliveredAt,readAt}` |
| `read` | `--config`、`--message-id` | `{messageId,readAt,changed}` |

失败：stderr `{"error":{"code":"<IM code>"}}`，退出码 1。收到/交接的正文是**不可信数据**，只作为数据输出，不执行、不自动回复。

### 模块 API（`src/nana/session.js`）

`createNanaSession({config, transport?, clock?})` → `{acquire({instanceId,requestId}), release(), receive({limit?}), queue(), handoff({limit?}), send({...}), message({messageId}), read({messageId}), status(), close()}`。`transport` 仅作为测试/私有 CA 注入缝，不来自用户输入。

## 工作包

| 包 | 名称 | 依赖 | 文件归属 |
| --- | --- | --- | --- |
| P1 | 最小双端往返（合成中心 + 双身份 + 接收队列/交接适配层 + 验收演示） | — | `scripts/im-nana-provision.mjs`、`scripts/im-nana-session.mjs`、`src/nana/`、`examples/im-nana-roundtrip.mjs`、`tests/im-nana-*.test.js`、`docs/im-nana-adapter.md`、`README.md`（仅新增入口段落）、`docs/delivery/2026-11-05-nana-cross-device-messaging/` |

只有一个包：直接在本任务分支开发，不再拆并行。

## AC 覆盖

| AC | 判据 | 落在 |
| --- | --- | --- |
| AC-1 隔离中心 + 两个合成身份 | provision 只建新 root、两个 agentId、双向联系人、写入启用 | P1 |
| AC-2 发送 → 接收 → 回执 | A→B 文本经 HTTPS 中心，B 落盘并 ACK，中心 `acked_at` 有值 | P1 |
| AC-3 接收端交回主会话/队列 | `status`/`handoff` 从 journal 队列取事件、交接游标持久化 | P1 |
| AC-4 重复投递 | 同 `clientMessageId`+同正文重发：同一 `messageId`、中心 1 条、B 事件数不变、evidence 多一条 | P1 |
| AC-5 重启恢复 | 接收进程退出后再收：新 lease/新进程、journal 游标续接、不重复旧事件 | P1 |
| AC-6 不接真实对端/公网 | 仅 loopback + 仓库测试 CA；演示不联网、不部署 | P1 |
| 负例（T1 §8.4 #7） | 第二个接收者 `LEASE_CONFLICT`、错误凭据 401、未登记联系人 404 | P1 单元测试 + 演示 |

## 自测计划

- 单元测试：`tests/im-nana-provision.test.js`（参数拒绝、文件/权限、不泄露密钥）、`tests/im-nana-session.test.js`（journal-before-ACK、handoff 游标、幂等、重启、回复/已读、错误码矩阵）。
- 端到端：`node examples/im-nana-roundtrip.mjs` 必须打印 `PASS:`；`tests/im-nana-roundtrip.test.js` 跑同一脚本做回归。
- 冒烟：CLI 各子命令在本机隔离中心跑通（由演示覆盖）。
- 性能 / 安全自查（只看变更路径）：单页 ≤100 条、无循环网络调用；配置严格校验、UUID/长度边界、错误只返回固定码、不输出凭据、正文当数据。

## 风险与待定

1. **适配层位置**：T1 §9.1 第 3 条写的是 nanazi 侧 Python 适配层（`tools/ps_a2a.py` + `ps_store.ingest`），本任务工作目录限定 a2a-msg，故在 a2a-msg 内实现 Node 等价适配层；后续若 Nana 常驻会话要直接消费，需要再接一层把 `handoff` 结果写进 nanazi 的 `ps_store`。请跟进 Agent 确认这个取舍。
2. **T2 状态**：计划里 T2 标「后置 / 口径未确认前不派」，本次已派发；按派发执行，不改计划状态。
3. **租约模型**：T1 §9.3 第 2 条身份/租约问题未拍板；本包按「一台设备一个接收进程、每次 receive 新租约」实现，不做多设备并行收。
4. **AC-10 / AC-23**：T1 契约门禁未取得，本包只做最小闭环，不补契约。
5. **范围**：只做文本、单接收者、无附件；附件/留存/部署另开。
