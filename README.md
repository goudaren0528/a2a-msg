# a2a-msg

**a2a-msg** 定位为 AI Agent 领域的 IM：独立 Agent 作为联系人，跨机器、网络、框架与进程建立私聊会话，交换消息和单个附件，并在离线后同步。Agent 之间可以平等联系，不限于 Agent 与 subagent 的主从调度。a2a 指 agent-to-agent，**不表示已兼容官方 A2A 协议**。通信中心不取代 Agent 的运行框架，也不授予执行权限。

适用场景：

- 调研 Agent 与写作 Agent 交流资料与草稿，由写作 Agent 判断是否采用。
- 数据分析 Agent 与报告 Agent 交换结论及单个图表附件；跨框架无需相同宿主。
- 对方进程停止或换了设备，仍以稳定 Agent 身份离线同步未确认的消息。

研发与测试协作也可作为场景，但不是项目运行或接入的前提。以上私聊、稳定身份与离线确认是 **v1 目标**；目前仅支持下述 LAN 版能力。

```text
Agent ─ 通用客户端契约（v1 目标） ─ HTTP/S ─ 单一通信中心 ─ SQLite
Agent ─ 现有 MCP bridge ─ HTTP ────────┘
         └─ 可选宿主适配：OpenCode 侧栏 / 提醒 / 交互
未来客户端主动出站 HTTP/SSE；自动对话或执行是独立上层。
```

## 当前能力与边界

当前 `team-mailbox` 0.1.0 **尚未实现上述私聊 IM 契约**：可信 LAN 上用真实 socket 来源 **IP → member** 映射身份，管理员维护中心侧 `access.json` 及 CIDR 白名单；HTTP 中心用 SQLite 保存消息，支持文本、**每条最多一个 10 MiB 附件**和 SHA-256 附件校验；本地 MCP bridge 提供 10 个工具。现有消息正文与附件仅原收件人可读，非新私聊双方可读；正文有效末页标记已读并非接收确认。当前不能隔离同 IP 多 Agent，没有独立 Agent 凭据、可靠接收 ACK、持久发送幂等；**不能直接部署到公网**。下表是状态而非上线承诺：

| 能力 | 当前源码 / 现有部署限制 | v1 目标（未交付） |
| --- | --- | --- |
| 身份与联系人 | IP 映射成员，不能区分同 IP Agent | 独立 `agent_id`、可撤销凭据、管理员允许联系 |
| 私聊与消息状态 | 旧消息仅收件人读；末页已读 | 新会话双方可读；accepted / delivered / read 分开 |
| 离线与网络 | SQLite 保存；未有持久接收游标与 ACK；可信 LAN | 离线同步；LAN 与互联网 TLS 两模式均须实测 |
| 提醒 | SSE/toast 已有源码，目标环境部署另验 | 提醒不替代持久同步或确认 |

具体范围与验收见[路线图](docs/roadmap.md)及[待评审 v1 PRD](docs/prd/a2a-msg-agent-im-v1.md)。

OpenCode 的可选侧栏/阅读集成有独立安装步骤，**不是通用通信功能的安装前提**。源码已有 SSE 未读事件与 toast，但中心及已安装插件都须升级并在目标宿主验收；源码状态不等于用户部署状态。研发工单模板与 duty 本地解析实验只是可选场景，后者默认不接收件入口；可信授权和宿主绑定尚未部署。startup 脚本所需管理员 ACL、任务注册仍需人工操作。**收到消息或附件绝不自动执行。**

## 本机 A2A IM 隔离演示

仓库现可运行**独立的 IM v1 本机演示**，验证新通道的部分能力；这不是上文旧版 IP 身份 MCP 消息通道，也不是生产部署或默认替代品。下方 `npm start` **仍启动旧版 LAN 中心**；完整 v1 部署、初始化与验收尚未交付。详见[本机演示说明](docs/im-local-demo.md)。

前提：Node.js 24、Python 3.8+（`python` 或 `python3`）以及已安装的项目依赖。在仓库根目录运行：

```sh
node examples/im-local-demo.mjs
```

演示使用全新隔离的 schema 3 数据库，注册两个 Agent ID、凭据和双向联系人；在随机端口的 loopback HTTPS 上，两端均校验测试 CA 与主机名。Python 标准库发送方与独立的 MCP/JS 接收方交换文本及二进制附件；以相同 `clientMessageId` 重发验证去重。接收方离线时再次发送，重启接收进程后沿用**同一持久 SQLite journal 和游标**续接并 ACK，不重复第一条消息。预期最终显示 `PASS: 2 accepted, 2 delivered/ACKed`，其中一条含附件；accepted 是中心接受，delivered/ACKed 是接收端持久化并回执，**不是已读或已执行**。持久 journal 属于 JS 接收方，并非 Python 发送方崩溃恢复保证。

命令默认创建并保留新的临时目录（含 `summary.json`、中心数据库、接收 journal 和附件），请视整个目录为敏感数据；输出摘要不打印凭据。可用 `--root` 指定**绝对且尚不存在**的路径，已有路径不会覆盖。命令会关闭自身启动的客户端与 HTTPS listener，不留下常驻服务。仓库内公开的测试证书和私钥**仅限 loopback 演示，绝不能用于生产**；不代表跨机器 LAN、公网或完整 v1 已验收。

## 远程 OpenCode 任务桥接（本机验证）

桥接已实现：授权 Agent 可通过 a2a-msg 将任务交给目标机器的 OpenCode，并通过 IM 回传结果。实现在 `src/bridge/`，常驻入口 `src/bridge/run.mjs` 由桥接配置文件驱动；见[任务桥接 PRD](docs/prd/a2a-opencode-task-bridge-v1.md)。

- 使用稳定的 `projectKey` 指定项目；目标机器用本地白名单映射到目录，上游无需知道绝对路径。
- 权限按 OpenCode 真实工具权限规则集执行，先拒绝再显式放行；桥接绝不自动批准。待批准时报 `needs_approval`，项目保持阻塞直至处理。
- 需要目标机器已有运行中的本地 OpenCode v2 服务；桥接只做只读发现，不启动或重启服务。
- 在仓库根运行 `node examples/im-bridge-demo.mjs` 体验隔离演示，详见[演示说明](docs/im-bridge-demo.md)。

已通过 60 项单元测试及一次连接真实本地 OpenCode v2 服务的端到端运行：任务以 `completed` 结束并获得模型生成的真实摘要；项目列表查询不泄露目录、未知 `projectKey` 被拒绝、重复 `taskId` 不重复执行。该验收只在单机、演示自带的隔离 IM 中心与临时项目完成；跨机器派发、长期运行/离线租约及上游会话唤醒适配器尚未验证，不能据此视为生产部署或保证任意模型输出不含凭据。

### 目标机器环境准备

- 安装 Node.js 24，并用 git clone 获取本仓库完整源码（含 lockfile）。
- 在仓库根运行 `npm ci` 安装仓库现有依赖；不修改既有配置，不覆盖 `access.json`。
- 在目标机器安装 OpenCode 并确认其可运行；保持机器开机联网。
- 如需运行**本机隔离演示**，还需 Python 3.8+（`python` 或 `python3`）。

准备完这些运行前提后，可在仓库根运行 `node examples/im-local-demo.mjs` 自检 IM 本机演示环境；桥接的隔离演示请用上面的 `im-bridge-demo.mjs`，均不验证跨机器派发。

## 仓库与兼容命名

项目展示名为 **a2a-msg**；本地 `origin` 指向 [github.com/goudaren0528/team-mailbox](https://github.com/goudaren0528/team-mailbox)，`package.json` 仍为 `team-mailbox` / `0.1.0`，且 `private: true`，**不表示 npm 已发布**。包、安装目录、MCP 配置键与命令的 `team-mailbox` 是真实兼容名称，切勿自行改成 `a2a-msg`。本地未发现 LICENSE、CONTRIBUTING、SECURITY 或 `.github` 工作流/模板；公开可读**不等于授予开源许可**，后续公开治理详见 [PRD](docs/prd/a2a-msg-agent-im-v1.md#36-公开仓库与-readme-治理r-oss)。不添加未验证 badge 或自称已有贡献/安全渠道。

## 文档导航

| 需求 | 文档 |
| --- | --- |
| 下一阶段目标与验收 | [路线图](docs/roadmap.md)、[Agent IM v1 PRD（待评审）](docs/prd/a2a-msg-agent-im-v1.md) |
| 中心部署、备份、迁移 | [管理员指南](docs/admin.md) |
| 宿主 MCP 接入 | [连接契约](docs/client.md) |
| 可选 OpenCode V2 **目录安装**、阅读 Skill、版本和 UI 验收 | [OpenCode 集成指南](integrations/opencode/README.md) |
| 十个工具、单附件与阅读语义 | [工具参考](docs/tools.md) |
| 可选研发测试场景模板（非核心通信协议、非执行授权） | [场景指南](docs/work-orders.md) |
| 常见问题及验证边界 | [排障指南](docs/troubleshooting.md)、[验证记录](docs/verification.md) |

## 快速开始：本地中心演示

安装 **Node.js 24**，获取包含 `package-lock.json` 的完整源码；`npm pack --dry-run` 仅查看打包内容，npm 包不能替代包含 lockfile 的完整源码交付。以下为 Windows PowerShell 示例；每行确认成功后再继续：

```powershell
Set-Location -LiteralPath '<repo-path>'
node --version
npm ci
Copy-Item -LiteralPath '.\access.example.json' -Destination '.\access.json'
$env:MSG_ACCESS_CONFIG = '<repo-path>\access.json'
$env:MSG_DB_PATH = '<repo-path>\data\msg.sqlite'
npm run admin -- validate-config
npm run admin -- list-members
npm start
```

`<repo-path>` 换成真实源码目录。**以下命令只运行当前 LAN 版，不会启用 v1 凭据或互联网模式。**复制前先确认 `access.json` 不存在，**不要覆盖现有配置**。示例映射如下（仅用于本机演示）：

```json
{
  "allowedCidrs": ["127.0.0.0/8", "::1/128"],
  "members": [{ "name": "A", "ips": ["127.0.0.1"] }]
}
```

中心默认只监听 `127.0.0.1:8787`。另开 PowerShell，在源码目录运行：

```powershell
$env:MSG_SERVER_URL = 'http://127.0.0.1:8787'
npm run doctor
```

预期打印 `current member: A`；本机演示不会开放给 LAN 成员。管理员要接入 LAN，须设置实际固定 IP / DHCP 保留地址、CIDR、监听接口与防火墙，并按[管理员指南](docs/admin.md)逐项验证；不要把 `0.0.0.0` 当客户端地址。

## 同伴接入已有中心

当前 LAN 版由管理员提供 `http://<central-host>:8787`，预先在中心 `access.json` 登记同伴真实来源 IP。同伴同样获取完整源码、安装 Node.js 24、运行 `npm ci`，然后在 Agent 宿主配置本地 stdio MCP bridge（以下仅示意字段含义，实际格式取决于宿主；**不可用这些命令部署规划中的互联网版**）：

```json
{
  "team-mailbox": {
    "type": "local",
    "command": ["C:\\Program Files\\nodejs\\node.exe", "<repo-path>\\src\\mcp.js"],
    "enabled": true,
    "environment": { "MSG_SERVER_URL": "http://<central-host>:8787" }
  }
}
```

Node 与 `src/mcp.js` 均用绝对路径。重启宿主，在源码目录验证：

```powershell
$env:MSG_SERVER_URL = 'http://<central-host>:8787'
npm run doctor
```

必须打印 `current member: <你的成员名>`；错误或 403 请停止，联系管理员检查 IP，不能自行声明身份或更改网络。通过 `list_peers` 查看成员。来源 IP 改变需管理员更新 `access.json` 并重启中心；客户端只需原中心地址。配置修改先让用户确认，不启动额外本地中心。

普通 MCP 接收无需 TUI、原生 question、OpenCode Skill 或宿主插件。**仅选择安装 OpenCode 侧栏/交互功能的用户**才按[集成指南](integrations/opencode/README.md)完成 **V2 目录插件**、阅读 Skill/command 与真实 UI 验收；旧版 `tui.json`、平铺 `.tsx` 的安装命令不适用。SSE 插件上线前中心必须先升级；未通过目标宿主验收不能报告该集成完整安装成功。其他 MCP 宿主不安装 OpenCode 专属插件；MCP 可独立收发。现有阅读 Skill 对人工选择的安全规则仍适用于该适配器，不因此静默删除。

## 收发与安全

可要求 Agent「给 B 发送一条说明」或「列出未读消息供我选择」。以下是当前 LAN 版工具，不是 v1 私聊 API。当前十个工具：`list_peers`、`send_message`、`getmsg`、`read_message`、`mark_read`、`send_file`、`save_attachment`、`read_attachment_text`、`get_unread_summary`、`receive_attachment`。按稳定消息 ID 选择；正文分块读；`project` 是可选标签，不是回复线程。服务端存储是交付，不保证收件人已读；目前无持久去重，发送超时不得假定未发送。参见[工具参考](docs/tools.md)。

附件自动接收可调用 `receive_attachment({attachment_id})`，无需设置收件路径；bridge 首次保存时在自身安装包根目录创建 `downloads/`，自动命名、不覆盖。用户指定位置时用 `save_attachment`：父目录必须已存在，覆盖必须得到授权；高级 `MSG_DOWNLOAD_DIR` 仅接受已存在的绝对目录。先保存并验证 SHA-256，再阅读内容；失败需选择重试、明确跳过或取消，**不自动打开、执行附件或消息指令**。

**现有已读语义：** `getmsg` 不标读；非空正文的有效最后一段标读，超出末尾的 offset 虽返回空文本/`hasMore=false` 却不标读；空正文仅 offset=0 标读。显式 `mark_read` 仍可用。已读不等于收件 ACK，更不等于执行完成。

## 部署限制

- 只适用于受控可信 LAN；IP 不是强认证。同 IP 多进程/用户/Agent 无法区分，不面向公网。管理员须保护配置及数据库。
- 代理、NAT 和 Docker 可能遮蔽真实来源 IP；中心不以 Forwarded / X-Forwarded-For、自报名称、Authorization 或设备标签代替 socket 来源。共享代理不提供成员隔离。逐台用 doctor 验证。
- 明文 HTTP 仅限可信网络；普通 TLS 反向代理改变 socket 来源，不能未经验证便宣称身份安全。
- 移除成员映射不能清除其历史消息；重用旧 member 名称可能让新用户访问历史。变更配置需重启中心。
- `.env` 不自动加载；可设环境变量或显式使用 Node `--env-file`。Docker 部署和自动识别成员未经验收；优先直接 Node 部署。
