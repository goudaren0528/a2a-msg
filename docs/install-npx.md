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
4. 把凭据（`0600`）和 `identity.json`（`0600`）写到 `~/.a2a-msg`（`0700`，可用 `--state-dir <绝对路径>` 覆盖）。

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
- 身份目录结构保持不变：只有 `identity.json` 和 `credentials/`；join/CA 结果不落盘。挂 MCP 时私有 CA 仍由宿主进程的 `NODE_EXTRA_CA_CERTS` 提供（见下一节）。

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
  "env": { "NODE_EXTRA_CA_CERTS": "/absolute/path/ca.pem" }
}
```

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

2026-11-09 在同一台 macOS（Node v24.22.2、npm 11.19.1）上补验一行注册（证据：`docs/delivery/2026-11-05-nana-cross-device-messaging/evidence/p6/`）：

- 本地起一个 `direct-tls` 中心（`tls.caCertPath` 已配），`GET /ca.pem` 返回 `200`、`Content-Type: application/x-pem-file`，字节与配置文件一致。
- 从干净临时目录（`HOME` 也指向临时目录）执行 `npx --yes --package=<本地 tarball> a2a-msg join "https://localhost:<port>/join#invite=...&ca=sha256:..."`：退出码 0，空目录内不产生文件；`~/.a2a-msg` 只有 `credentials/` 与 `identity.json`（`0700`/`0600`），`displayName` 为清洗后的主机名。
- 同一 tarball、同一中心，把链接里的 `ca=` 换成全 0 指纹：退出码 1，stderr 为 `{"error":{"code":"CA_FINGERPRINT_MISMATCH"}}`，没有写身份文件。
