# a2a-msg：中文入口

**[主 README（当前为中文）](README.md)** 是本仓库唯一维护的产品定位、实际能力、快速开始、部署边界及文档导航。本文保留历史中文入口，不再复制一套容易过期的安装步骤；英文完整版本尚未提供，不标注已具备双语文档。

a2a-msg 的目标是独立 AI Agent 互为联系人，跨框架、机器、网络与时间进行私聊、交换消息与附件。**当前 `team-mailbox` 0.1.0 仍是基于真实来源 IP→member 的可信 LAN 实现**：不能区分同 IP 多 Agent，没有独立凭据、持久接收 ACK 或发送幂等，不能将现有部署直接暴露公网。当前仅原收件人可读旧消息；目标中的新私聊双方可读不扩展旧数据权限。a2a 只表示 agent-to-agent，不承诺已兼容官方 A2A 协议；收到消息不授权执行。

## 本机 A2A IM 隔离演示

仓库现可运行**独立的 IM v1 本机演示**，验证新通道的部分能力；这不是旧版 IP 身份 MCP 消息通道，也不是生产部署或默认替代品。主 README 中的 `npm start` **仍启动旧版 LAN 中心**；完整 v1 部署、初始化与验收尚未交付。详见[本机演示说明](docs/im-local-demo.md)。

前提：Node.js 24、Python 3.8+（`python` 或 `python3`）以及已安装的项目依赖。在仓库根目录运行：

```sh
node examples/im-local-demo.mjs
```

演示使用全新隔离的 schema 3 数据库，注册两个 Agent ID、凭据和双向联系人；在随机端口的 loopback HTTPS 上，两端均校验测试 CA 与主机名。Python 标准库发送方与独立的 MCP/JS 接收方交换文本及二进制附件；以相同 `clientMessageId` 重发验证去重。接收方离线时再次发送，重启接收进程后沿用**同一持久 SQLite journal 和游标**续接并 ACK，不重复第一条消息。预期最终显示 `PASS: 2 accepted, 2 delivered/ACKed`，其中一条含附件；accepted 是中心接受，delivered/ACKed 是接收端持久化并回执，**不是已读或已执行**。持久 journal 属于 JS 接收方，并非 Python 发送方崩溃恢复保证。

命令默认创建并保留新的临时目录（含 `summary.json`、中心数据库、接收 journal 和附件），请视整个目录为敏感数据；输出摘要不打印凭据。可用 `--root` 指定**绝对且尚不存在**的路径，已有路径不会覆盖。命令会关闭自身启动的客户端与 HTTPS listener，不留下常驻服务。仓库内公开的测试证书和私钥**仅限 loopback 演示，绝不能用于生产**；不代表跨机器 LAN、公网或完整 v1 已验收。

## 远程 OpenCode 任务桥接（本机验证）

桥接已实现：授权 Agent 可通过 a2a-msg 向目标机器的 OpenCode 派发任务，再通过 IM 回传结果。实现位于 `src/bridge/`，常驻入口 `src/bridge/run.mjs` 由桥接配置文件驱动；参见[任务桥接 PRD](docs/prd/a2a-opencode-task-bridge-v1.md)。

- 稳定的 `projectKey` 由目标机器白名单映射到本地目录，上游无需知道绝对路径。
- OpenCode 真实工具权限规则集先拒绝再显式放行；桥接不自动批准。待批准时报 `needs_approval`，项目保持阻塞直至处理。
- 需要已有运行中的本地 OpenCode v2 服务；桥接只读发现，不启动或重启服务。
- 在仓库根运行 `node examples/im-bridge-demo.mjs` 体验隔离演示，见[演示说明](docs/im-bridge-demo.md)。

已通过 60 项单元测试及一次连接真实本地 OpenCode v2 服务的端到端运行：以 `completed` 结束并取得模型生成的真实摘要；项目列表查询不泄露目录，未知 `projectKey` 被拒绝，重复 `taskId` 不重复执行。仅在单机、演示自带隔离 IM 中心与临时项目验证；跨机器派发、长期运行/离线租约及上游会话唤醒适配器尚未验证，不代表生产就绪，也不保证任意模型输出不会泄露凭据。

### 目标机器环境准备

- 安装 Node.js 24，用 git clone 获取本仓库完整源码（含 lockfile）。
- 在仓库根运行 `npm ci` 安装现有依赖；不改已有配置、不覆盖 `access.json`。
- 在目标机器安装 OpenCode 并确认可运行，保持机器开机联网。
- 仅运行**本机隔离演示**时另需 Python 3.8+（`python` 或 `python3`）。

完成上述运行前提后，可在仓库根运行 `node examples/im-local-demo.mjs` 自检 IM 本机演示环境；桥接隔离演示使用上面的 `im-bridge-demo.mjs`，均不验证跨机器派发。

- 从[主 README 的当前能力与快速开始](README.md#当前能力与边界)进入；现有 `team-mailbox` 包、命令与 MCP 配置名称保持不变。
- [路线图](docs/roadmap.md)与[待评审 v1 PRD](docs/prd/a2a-msg-agent-im-v1.md)描述未来私聊、单接收实例、离线同步及 LAN / 互联网 TLS 双模式，**均未交付**。
- 宿主无 OpenCode 插件也可使用现有通用 [MCP 接入契约](docs/client.md)；OpenCode 用户按[其独立集成说明](integrations/opencode/README.md)核对 V2 目录安装及 SSE 升级状态，不得再用旧 `tui.json` 或平铺文件命令。
- 中心操作、旧数据保护及附件行为分别见[管理员指南](docs/admin.md)、[工具参考](docs/tools.md)与[排障指南](docs/troubleshooting.md)。

此前此页记录的旧版 OpenCode 插件安装、固定个人机器路径与研发工单提示词不再是通用项目快速开始；特定集成与场景应查对应文档，并独立核实版本与授权。修改已有安装、中心或用户数据须另行批准。
