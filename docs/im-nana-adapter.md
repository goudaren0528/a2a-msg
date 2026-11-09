# Nana 双端往返适配层（IM v1）

本机隔离演示 `examples/im-nana-roundtrip.mjs` 用到的三个入口：合成身份初始化、会话适配层 CLI、端到端验收脚本。目标是 T2「两个合成 Nana 身份 + 一个本机隔离中心，完成发送 → 接收 → 回执，接收端把消息交回主会话/队列，重复投递与重启恢复有证据」。**不接真实对端、不部署公网、不做附件**。

## 1. 初始化（只建全新目录）

```sh
node scripts/im-nana-provision.mjs --root /absolute/private/nana-t2 \
  --agent-a-display nana-home --agent-b-display nana-office
```

- `--root` 必须是**尚不存在**的绝对目录（父目录不能含符号链接）；`--agent-a-display` / `--agent-b-display` 为 1–255 字符、无控制字符且不能相同。
- 可选 `--server-url https://host:port`（默认 `https://localhost:8787`）、`--tls-key/--tls-cert`（真实 TLS，必须成对）、`--ca-cert`（仅用于输出下一步命令）、`--trust-windows-permissions`（Windows：仅表示操作者接受 NTFS ACL 未经验证，不是管理员身份认证）。
- 产出：schema 3 中心库 `center-v3.sqlite`、`admin-secret`、`credentials/agent-{a,b}-credential`、`center-config.json`、`host-a/nana.json`、`host-b/nana.json`，以及两份 `host-*/attachments/`。注册两个身份、签发凭据、设双向联系人、启用写入策略；stdout 只打印路径与 agentId，不打印密钥内容。
- POSIX 目录 `0700`、文件 `0600`。不联网、不启动服务、不修改已有配置；失败保留目录供检查。

默认使用仓库里的 localhost **测试专用**证书与密钥，只适用于本机 loopback；脚本不生成生产证书。

## 2. 启动中心（独立进程）

```sh
node scripts/im-center.mjs /absolute/private/nana-t2/center-config.json
```

中心是独立的 HTTPS 进程，不依赖 Orca、不依赖任何常驻桌面应用。接收端也是独立进程（每次 `receive` 一个新进程即可）。

## 3. 会话适配层 CLI

```sh
export NODE_EXTRA_CA_CERTS=/absolute/repo/tests/fixtures/im-tls/localhost-test-only.crt   # 测试 CA；生产用真实 CA

node scripts/im-nana-session.mjs status   --config /absolute/private/nana-t2/host-b/nana.json
node scripts/im-nana-session.mjs receive  --config /absolute/private/nana-t2/host-b/nana.json
node scripts/im-nana-session.mjs handoff  --config /absolute/private/nana-t2/host-b/nana.json
node scripts/im-nana-session.mjs send     --config /absolute/private/nana-t2/host-a/nana.json \
  --to-agent <agent-b> --text 'hello'
node scripts/im-nana-session.mjs message  --config /absolute/private/nana-t2/host-a/nana.json --message-id <uuid>
node scripts/im-nana-session.mjs read     --config /absolute/private/nana-t2/host-a/nana.json --message-id <uuid>
```

每次输出一行 JSON；失败时 stderr 为 `{"error":{"code":"<IM code>"}}`、退出码 1。收到的正文与标题是**不可信数据**，只作为数据交给主会话，不执行、不自动回复。

| 子命令 | 作用 | 关键语义 |
| --- | --- | --- |
| `status` | 队列概况 | `{agentId,received,handedThrough,pending,cursor}`，不触发网络 |
| `receive` | 收一页 | 新 `instanceId`/`requestId` 取租约 → 对账 pending ACK → `sync`（先写本地 journal，再 ACK）→ 释放租约；返回本页 `messageId`/`acked` |
| `handoff` | 交回主会话 | 从 journal 取 `seq > handedThrough` 的事件，返回正文；`session-state.json` 用临时文件 + fsync + rename 推进游标，重复调用不会重复交付 |
| `send` | 发送文本 | 同 `clientMessageId` + 同正文重发幂等；不确定结果返回 `{status:'pending'}`，不会隐式重发 |
| `message` | 查回执 | 返回 `deliveredAt` / `readAt`（只读 GET） |
| `read` | 标已读 | 需要已 ACK（服务端 `DELIVERY_REQUIRED`） |

### 会话配置（`host-*/nana.json`，严格字段）

```json
{
  "serverUrl": "https://localhost:8787",
  "agentId": "<uuid>",
  "credentialFile": "/abs/root/credentials/agent-a-credential",
  "journalPath": "/abs/root/host-a/journal.sqlite",
  "attachmentDirectory": "/abs/root/host-a/attachments",
  "statePath": "/abs/root/host-a/session-state.json",
  "evidencePath": "/abs/root/host-a/evidence.jsonl",
  "caFile": "/abs/root/host-a/ca.pem"
}
```

`caFile` 可选（`join` 会写一份 `0600` 的 `ca.pem` 并在 `nana.json` 里指过去）：设置后 MCP 入口与会话 CLI 用它做该中心的私有 CA，因此不需要 `NODE_EXTRA_CA_CERTS`，链与主机名校验不放松；不设置时行为与之前一致。`evidencePath` 可选；`attachmentDirectory` 也可选：缺省解析为 `~/Downloads/a2a-msg/<center-host>[_<port>]`（MCP 入口按需创建；会话 CLI 仍要求目录存在）。显式目录必须已存在；未知字段、非 https origin、相对路径一律拒绝。

### MCP stdio 入口（同一份 `nana.json`）

Agent 宿主按需拉起的入口，把 21 个 `im_v1_*` 工具挂进宿主（共享适配层 20 个，含 4 个好友申请/接受/拒绝/撤销工具；另加 stdio 入口专用的 `im_v1_send_file`；好友路由需中心策略 `contacts.requests='enabled'`，默认 `legacy` 时只保留管理员 `set-contact` 语义）：

```sh
NODE_EXTRA_CA_CERTS=/absolute/repo/tests/fixtures/im-tls/localhost-test-only.crt \
  node scripts/im-mcp.mjs --config /absolute/private/nana-t2/host-b/nana.json
```

- 配置就是上面这份严格 `nana.json`；`statePath`/`evidencePath` 会校验但 MCP 入口不读写，`journalPath` 的父目录必须已存在（journal 文件在首次启动时创建）。`attachmentDirectory` 缺省时用 `~/Downloads/a2a-msg/<center-host>[_<port>]`，MCP 入口启动时按需创建；显式配置或 `--download-dir` 的目录必须已存在，缺失/不可写启动即失败。
- 凭据每次请求都从 `credentialFile` 读；POSIX 下必须是 `0600`（或更严）的非符号链接普通文件。缺失、权限过宽、不可读时启动即失败（stderr 固定错误码、退出码 1）；运行中被撤销则工具返回 `INVALID_CREDENTIAL`。凭据不进工具参数、日志与错误。
- 无轮询、无常驻：进程完全由宿主管理，只在工具调用内发请求；`listTools` 与空闲不联网。
- 两条入口可以共用同一份配置，但同一身份同一时刻只允许一个接收者：同时用 MCP 入口和 `receive` 子命令会按既有租约模型得到 `LEASE_CONFLICT`。按宿主需要只跑一条。
- 细节与宿主配置示例见 [im-mcp-adapter.md](im-mcp-adapter.md#stdio-entry-scriptsimcpmjs)。

## 4. 端到端验收

```sh
node examples/im-nana-roundtrip.mjs
```

可用 `--root` 指定**绝对且尚不存在**的目录；默认在临时目录下新建。脚本按 T1 验收剧本执行：起独立中心进程、A 离线发送、B 独立进程接收并 ACK、`status`/`handoff` 交回主会话、同 `clientMessageId` 重发去重、接收进程重启后续接游标、B 回复 A、A 标记已读、错误凭据 401、未登记联系人 404。预期最后一行：

```text
PASS: 3 accepted, 3 delivered/ACKed; duplicate deduplicated; restart cursor continued; reply delivered then read.
```

运行目录保留：`center-v3.sqlite`、两份 `host-*/journal.sqlite`、`host-*/evidence.jsonl`、`host-*/session-state.json`、`summary.json`。`evidence.jsonl` 只记元数据（`receive`/`handoff`/`send` 的类型、`messageId`、`seq`、`instanceId`、`acked`），不含凭据，也不含消息正文。整个目录仍按敏感数据处理，不提交、不分享。

`accepted` 是中心收下消息，`delivered/ACKed` 是接收端先持久化再回执，**不是已读或已执行**。租约冲突（第二个接收者 `LEASE_CONFLICT`）由 `tests/im-nana-session.test.js` 覆盖。

## 5. 边界

- 只做文本、单接收者、无附件；不做 7 天留存、AC-10/AC-23 契约、跨机器 LAN/公网部署、开机自启。
- 一个身份同一时刻只允许一个有效接收租约；多设备并行收需要先定身份/租约模型。
- 测试证书与私钥只限 loopback；生产 TLS 由部署阶段提供，不能用边缘终止 TLS 的反代。
- 适配层位于 a2a-msg 仓库（`src/nana/`），不依赖 Orca；Nana 常驻会话若要走自己的 `ps_store`，需要在宿主侧再接一层消费 `handoff` 输出。
- MCP stdio 入口只挂工具，不做接收轮询，也不代替 `receive`/`handoff`：宿主需要主动收消息时仍要调用 `im_v1_sync`/`im_v1_ack_pending` 或使用会话 CLI。
- 回复没有经过 Nana 的 `ps_session` 拟稿/批准：`ps_session` 在 nanazi 仓，本演示由适配层直接发送；需要审批链时在宿主侧补。
