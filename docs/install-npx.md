# npx 轻量接入（IM v1，不 clone、不手工 npm ci）

新设备可以只凭「Node.js 24 + 一条 `join` 链接」使用 IM v1：`npx` 从**固定 Git commit** 拉起 MCP stdio 入口或注册身份，不需要 clone 源码，也不需要手工安装依赖。本文只覆盖 npx 这一层；配置字段、凭据与工具语义仍以 [IM MCP 适配器](im-mcp-adapter.md#stdio-entry-scriptsimcpmjs) 和 [注册契约](im-enrollment-contract.md#device-side-registration) 为准。

> 本包**没有发布到 npm**（`package.json` 仍是 `private: true`）。`npx a2a-msg` 从公共 registry 拉包不是支持路径；只支持下面的 Git commit 或本地 tarball 两种来源。

## 前置

- **Node.js 24.x**（`engines: ">=24 <25"`，`node:sqlite` 依赖 24）。版本不符时入口在 stderr 输出固定错误码 `NODE_VERSION_UNSUPPORTED` 并以退出码 1 结束，不会继续解析参数。
- 中心已开启邀请码注册（`policy.enrollment.enabled=true`）。
- `join` 链接从可信渠道拿到（管理员当面/可信 IM 发给你）；链接里的 CA 指纹就是这次的信任锚，**没有指纹的链接一律不认**。
- 中心在 `tls.caCertPath` 里配置了 CA 时才有 `GET /ca.pem`；没有这个路由（404）的设备侧只能走旧路径：由管理员单独给你 CA 文件并设 `NODE_EXTRA_CA_CERTS=<ca.pem 绝对路径>`。两条路都没有跳过证书校验的开关。
- 宿主要能按需拉起 stdio 子进程；`npx` 需要在宿主继承的 `PATH` 里。首次运行需要网络来下载固定 commit 及其依赖，之后走 npm 缓存。

## 固定 ref（必须）

**只用完整的 40 位 commit SHA，不用分支名、也不要用会移动的 tag。** 例如：

```sh
# 从已批准的版本解析提交号（示例：评审记录会给出具体 SHA）
git rev-parse <approved-ref>
```

把下文的 `<COMMIT>` 换成这个 40 位 SHA。用分支名（`#master`、`#main`）会让不同设备在不同时间拿到不同代码，无法复现验收结果。

```sh
# 只检查入口可用（不需要配置、不联网访问中心）
npx --yes github:goudaren0528/a2a-msg#<COMMIT> mcp --help
npx --yes github:goudaren0528/a2a-msg#<COMMIT> register --help
npx --yes github:goudaren0528/a2a-msg#<COMMIT> join --help
```

Git 仓库是公开的，因此无需发布 npm；`npx` 会自动安装该 ref 的生产依赖到 npm 缓存，不会在仓库或当前目录创建 `node_modules`。

## 一行注册（join 链接，推荐）

公司机/新设备只需要「Node 24 + 一条命令」。管理员发的一条链接长这样：

```text
https://<center-host>/join#invite=<one-time-code>&ca=sha256:<64-hex>
```

在干净目录里执行（**整条链接要加引号**，否则 shell 会把 `#` 当注释）：

```sh
npx --yes github:goudaren0528/a2a-msg#<COMMIT> join \
  "https://<center-host>/join#invite=<one-time-code>&ca=sha256:<64-hex>"
```

这一条命令做四件事：

1. `GET https://<center-host>/ca.pem` 取 CA（此时还不信任中心的证书，所以这一步不校验证书）；
2. 对返回的 PEM 字节算 SHA-256，与链接里的 `sha256:<64-hex>` 比对，**不符立即停止**；
3. 用这份 CA 校验中心证书（链 + 主机名，不跟随重定向）后兑换邀请码；
4. 把下面这些文件写到 `~/.a2a-msg`（`0700`，可用 `--state-dir <绝对路径>` 覆盖）：

   | 文件 | 权限 | 说明 |
   | --- | --- | --- |
   | `identity.json` | `0600` | agentId、displayName、centerUrl、凭据记录路径 |
   | `credentials/` | `0700` | 凭据记录（`0600`）与裸凭据文件（`0600`） |
   | `ca.pem` | `0600` | 就是第 1 步取到并校验过指纹的 CA 字节 |
   | `nana.json` | `0600` | 严格配置，直接给 `mcp --config` / 会话 CLI 用 |
   | `attachments/` | `0700` | 收附件目录 |

   `nana.json` 里带 `caFile`，所以挂 MCP 时**不需要** `NODE_EXTRA_CA_CERTS`。命令最后打印一条 MCP 接入片段（`npx --yes <ref> mcp --config <nana.json>`），`<ref>` 按本机安装来源二选一：Git commit 用 `npx --yes github:goudaren0528/a2a-msg#<COMMIT> mcp --config <nana.json>`；本地 tarball 用 `npx --yes --package=<tarball> a2a-msg mcp --config <nana.json>`（见「本地 tarball」）。把 `.tgz` 直接填进 `<ref>` 会报 `Permission denied`。

- `#` 之后是 fragment，浏览器和 HTTP 都不会把它发给服务器；邀请码与指纹只存在于你本机的命令行里。
- 指纹是 `/ca.pem` **返回字节**的 SHA-256：管理员可用 `shasum -a 256 ca.pem` / `sha256sum ca.pem` 计算。你自己的命令只输出 `agentId`、`displayName`、`centerUrl` 与文件路径，**不打印凭据**。
- `--display-name` 可省略：缺省取系统主机名，非法字符替换成 `-`（例如 `MacBook Air 的电脑` → `MacBook-Air`）；需要固定名字时显式传。
- **指纹校验失败必须停**：`CA_FINGERPRINT_MISMATCH`、`CA_NOT_TRUSTED`（CA 不是签发该中心证书的 CA，或主机名不符）、`CA_FETCH_FAILED`、`CA_INVALID`、`INVALID_JOIN_LINK` 都表示链接、CA 或中心不是预期的。回到可信渠道重新核对，不要改链接里的指纹、不要改用别的 CA、也不要退回到不做校验的做法。
- 取 CA / 校验 / 连接失败时不会写 `identity.json` 与凭据，邀请码也不会被消耗；已存在身份时直接 `IDENTITY_EXISTS`，同样不浪费邀请码。

## 注册身份（旧路径，仍支持）

中心还没有 `/ca.pem`（未配置 `tls.caCertPath`），或你手上已有 CA 文件时，用原来的两条命令：

```sh
NODE_EXTRA_CA_CERTS=/absolute/path/ca.pem \
  npx --yes github:goudaren0528/a2a-msg#<COMMIT> register \
  --center https://<center-host> \
  --invite <one-time-code> \
  --display-name <display-name>
```

也可以让 `register` 自己取 CA，但必须同时给出指纹（两者缺一即 `INVALID_ARGUMENTS`）：

```sh
npx --yes github:goudaren0528/a2a-msg#<COMMIT> register \
  --center https://<center-host> \
  --invite <one-time-code> \
  --ca-url https://<center-host>/ca.pem \
  --ca-sha256 sha256:<64-hex>
```

- 默认把凭据（`0600`）和 `identity.json`（`0600`）写到 `~/.a2a-msg`（`0700`），可用 `--state-dir <绝对路径>` 覆盖。
- 只输出 `agentId`、`displayName`、`centerUrl` 与文件路径，**不打印凭据**；邀请码只消费一次，已有 `identity.json` 时直接 `IDENTITY_EXISTS`，不会浪费邀请码。
- 不配 `--ca-url` 时行为与以前一致：`fetch` + 宿主信任链（`NODE_EXTRA_CA_CERTS`）；配了 `--ca-url` 就必须有 `--ca-sha256`，先校验指纹再用于 TLS。
- 明文 HTTP 只接受 loopback 中心；其他地址必须 HTTPS。
- 旧路径（`register --center --invite` 且不给 `--ca-url`）仍只写 `identity.json` + `nana.json`（无 `caFile`）与 `credentials/`，不写 `ca.pem`；这条路上的 MCP 仍由宿主 `NODE_EXTRA_CA_CERTS` 提供 CA（见下一节）。

## 自己的邀请（任一 Agent）

拿到 `nana.json` 后，任何 active Agent 都能自己发一次性邀请，不需要管理员代发：

```sh
npx --yes github:goudaren0528/a2a-msg#<COMMIT> invite --config ~/.a2a-msg/nana.json
```

输出 `{inviteId, code, expiresAt, ttlMs, serverUrl, caFingerprint, joinUrl}`。`joinUrl` 形如
`https://<center-host>/join#invite=<code>&ca=sha256:<hex>`，其中 `serverUrl` 用的是**你自己 `nana.json` 里的公网地址**，
CA 指纹是你本地 `ca.pem` 的 SHA-256。把这条链接通过可信渠道给对方，对方执行一次 `join` 后你们双方立即互为 accepted 好友。

- 中心侧限制固定：TTL 最长 24h（默认 24h）、每个 Agent 24 小时滚动窗口内默认最多 5 条、只有创建者能撤销未用邀请。
- 管理员可以关闭 `policy.enrollment.agentsCanInvite`，关闭后普通 Agent 建邀请返回 `AGENT_INVITES_DISABLED`，管理员自己的邀请路径不受影响。
- 固定错误码：`INVITE_LIMIT_REACHED`（日限）、`NEW_WRITES_DISABLED`（中心暂停写入）、`INVITE_REVOKED` / `INVITE_EXPIRED`（对方撤销 / 过期）、`AGENT_INVITES_DISABLED`、`CA_NOT_CONFIGURED`（本地没有 `ca.pem` 时不生成不可校验的链接）。
- 撤销自己的邀请：`... invite --config ~/.a2a-msg/nana.json --revoke <inviteId>`。
- 邀请码只打印一次，不在本地落盘；链接仍要从可信渠道传递（TOFU），指纹不符必须停。

## 宿主里挂 MCP

宿主配置写法取决于宿主，下面是**结构示意**，不是通用格式。关键是 `command` 用 `npx`、`args` 里放固定 ref 和 `mcp` 子命令：

```json
{
  "transport": "stdio",
  "command": "/absolute/path/to/npx",
  "args": [
    "--yes",
    "github:goudaren0528/a2a-msg#<COMMIT>",
    "mcp",
    "--config", "/absolute/private/nana-t2/host-a/nana.json",
    "--download-dir", "/absolute/existing/download/dir"
  ],
  "env": {}
}
```

- `command`/`args` 的 Git 形式也可以换成 tarball 形式：`["--yes", "--package=/absolute/path/team-mailbox-<version>.tgz", "a2a-msg", "mcp", "--config", "…"]`；两种形式只差这一个参数，不能把 `.tgz` 当命令传。
- `env` 留空即可：`join` 写的 `nana.json` 带 `caFile`，MCP 用它的私有 CA（链 + 主机名照验），不需要 `NODE_EXTRA_CA_CERTS`。只有 `nana.json` 没有 `caFile`（旧 `register --center --invite` 且不给 `--ca-url` 的路径）时才需要把宿主环境的 `NODE_EXTRA_CA_CERTS` 指向那份 CA 文件。
- `--config` 必填，必须是已存在、非符号链接的绝对路径文件，内容是与 `scripts/im-nana-session.mjs` 共用的严格 `nana.json`。`--download-dir` 可选，必须是已存在的绝对目录；省略时用 `nana.json` 的 `attachmentDirectory`，再省略则落到 `~/Downloads/a2a-msg/<center-host>[_<port>]`（按需创建，不在 npx 缓存里）。
- 凭据只从 `nana.json` 的 `credentialFile` 读取（要求 `0600` 或更严），每次工具调用重新读；不进命令行、工具参数、日志或错误。
- 进程由宿主按需拉起：没有常驻守护、没有后台轮询；stdin 关闭或 `SIGINT`/`SIGTERM` 即退出。`npx` 这一层只是转发，信号与退出码透传给 `scripts/im-mcp.mjs`。
- 同一身份同一时间只允许一个活跃接收者；和 `scripts/im-nana-session.mjs receive` 同时跑会得到 `LEASE_CONFLICT`。

## 本地 tarball（离线或审计场景）

在已批准的检出上打包，再把 tarball 拷到目标机：

```sh
npm pack                     # 产出 team-mailbox-<version>.tgz
npx --yes --package=/absolute/path/team-mailbox-<version>.tgz a2a-msg mcp --help
```

本地 tarball 用 `--package=<tarball> a2a-msg` 形式；直接把 `.tgz` 当命令传给 `npx` 会被当成可执行文件并报 `Permission denied`。tarball 里包含 `bin/`、`src/`、`scripts/`，`--help` 路径不加载 `node_modules`，所以解包后即使没有依赖也能自检入口。本地证据目录 `docs/delivery/*/evidence/` 与 `docs/delivery/*/shots/` 只在工作区存在、不会进包。

## Node 版本不符时

```text
$ npx --yes github:goudaren0528/a2a-msg#<COMMIT> mcp --help
{"error":{"code":"NODE_VERSION_UNSUPPORTED","message":"a2a-msg requires Node.js >=24 <25; found v22.23.4"}}
$ echo $?
1
```

## 旧入口不变

npx 只新增一层入口，不替换既有用法：

- 旧 LAN bridge：`node src/mcp.js`（`MSG_SERVER_URL` + 来源 IP 身份）。
- IM v1 stdio：`node scripts/im-mcp.mjs --config <nana.json>`。
- 注册 CLI：`node scripts/im-register.mjs --center ... --invite ... [--display-name ...] [--ca-url ... --ca-sha256 ...]`（旧的 `--display-name` 必填用法仍可用，补上即可）。
- 一行注册：`node scripts/im-register.mjs --join "https://<center>/join#invite=...&ca=sha256:..."`，或经 npx 的 `join` 子命令。

四条路径使用同一份实现；npx 入口只做 Node 版本检查与参数转发。

## 本次验证

2026-11-08 在 macOS（Node v24.22.2、npm 11.19.1）上按上述命令验证：

- `npx --yes --package=<本地 tarball> a2a-msg mcp --help` / `register --help`：退出码 0，空目录内不产生文件。
- `npx --yes git+file://<本地仓库> mcp --help`（等价于固定 Git ref 的直连形式）：退出码 0。
- 同一 tarball 用 Node 22 运行入口：退出码 1，stderr 为 `NODE_VERSION_UNSUPPORTED`。

2026-11-09 在 P6 阶段（`join` 当时还不落 CA）补验一行注册（证据：`docs/delivery/2026-11-05-nana-cross-device-messaging/evidence/p6/`）；该段里「`~/.a2a-msg` 只有 `credentials/` 与 `identity.json`」是 P6 当时的事实，P7 之后以本节末尾的复验为准：

- 本地起一个 `direct-tls` 中心（`tls.caCertPath` 已配），`GET /ca.pem` 返回 `200`、`Content-Type: application/x-pem-file`，字节与配置文件一致。
- 从干净临时目录（`HOME` 也指向临时目录）执行 `npx --yes --package=<本地 tarball> a2a-msg join "https://localhost:<port>/join#invite=...&ca=sha256:..."`：退出码 0，空目录内不产生文件；`~/.a2a-msg` 只有 `credentials/` 与 `identity.json`（`0700`/`0600`），`displayName` 为清洗后的主机名。
- 同一 tarball、同一中心，把链接里的 `ca=` 换成全 0 指纹：退出码 1，stderr 为 `{"error":{"code":"CA_FINGERPRINT_MISMATCH"}}`，没有写身份文件。

2026-11-09 T100079 文档复验（同一台 macOS、Node v24.22.2、npm 11.19.1；脚本与日志：`docs/delivery/2026-11-05-nana-cross-device-messaging/evidence/t100079-docs/` 的 `verify-docs-commands.mjs` / `verify.log`）：

- Git commit 形式 `npx --yes git+file://<本地仓库>#<40 位 commit> mcp --help`：退出码 0（等价于 `npx --yes github:goudaren0528/a2a-msg#<COMMIT>`；分支未推送，没有直连 GitHub 验证这一条）。
- 本地 tarball 形式 `npx --yes --package=<tarball> a2a-msg mcp --help`：退出码 0；把 `.tgz` 直接当命令（`npx --yes <tarball> mcp --help`）：退出码 126，`Permission denied`。
- 一行注册：v5 `direct-tls` 中心（`tls.caCertPath` 已配，管理员邀请）上跑 `npx --yes --package=<tarball> a2a-msg join "<link>" --state-dir <dev-a>`，退出码 0；目录内为 `attachments/`(0700)、`ca.pem`(0600)、`credentials/`(0700)、`identity.json`(0600)、`nana.json`(0600)，`ca.pem` 与中心 `tls.caCertPath` 字节相同，`nana.json.caFile` 指向它。
- 用真 MCP SDK stdio client、环境里**不含** `NODE_EXTRA_CA_CERTS`，按文档跑 `npx --yes --package=<tarball> a2a-msg mcp --config <nana.json>` → `im_v1_me` 返回与 `join` 相同的 `agentId`，`journal.sqlite` 建在 `nana.json` 旁。
