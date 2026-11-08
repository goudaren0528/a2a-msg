# npx 轻量接入（IM v1，不 clone、不手工 npm ci）

新设备可以只凭「Node.js 24 + 中心 URL + 邀请码（+ 私有 CA）」使用 IM v1：`npx` 从**固定 Git commit** 拉起 MCP stdio 入口或注册身份，不需要 clone 源码，也不需要手工安装依赖。本文只覆盖 npx 这一层；配置字段、凭据与工具语义仍以 [IM MCP 适配器](im-mcp-adapter.md#stdio-entry-scriptsimcpmjs) 和 [注册契约](im-enrollment-contract.md#device-side-registration) 为准。

> 本包**没有发布到 npm**（`package.json` 仍是 `private: true`）。`npx a2a-msg` 从公共 registry 拉包不是支持路径；只支持下面的 Git commit 或本地 tarball 两种来源。

## 前置

- **Node.js 24.x**（`engines: ">=24 <25"`，`node:sqlite` 依赖 24）。版本不符时入口在 stderr 输出固定错误码 `NODE_VERSION_UNSUPPORTED` 并以退出码 1 结束，不会继续解析参数。
- 中心已开启邀请码注册（`policy.enrollment.enabled=true`），并持有一次性邀请码与中心 URL。
- 中心使用私有 CA 时，运行进程需要 `NODE_EXTRA_CA_CERTS=<ca.pem 绝对路径>`；没有跳过证书校验的开关。
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
```

Git 仓库是公开的，因此无需发布 npm；`npx` 会自动安装该 ref 的生产依赖到 npm 缓存，不会在仓库或当前目录创建 `node_modules`。

## 注册身份

```sh
NODE_EXTRA_CA_CERTS=/absolute/path/ca.pem \
  npx --yes github:goudaren0528/a2a-msg#<COMMIT> register \
  --center https://<center-host> \
  --invite <one-time-code> \
  --display-name <display-name>
```

- 默认把凭据（`0600`）和 `identity.json`（`0600`）写到 `~/.a2a-msg`（`0700`），可用 `--state-dir <绝对路径>` 覆盖。
- 只输出 `agentId`、`displayName`、`centerUrl` 与文件路径，**不打印凭据**；邀请码只消费一次，已有 `identity.json` 时直接 `IDENTITY_EXISTS`，不会浪费邀请码。
- 明文 HTTP 只接受 loopback 中心；其他地址必须 HTTPS。

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

本地 tarball 用 `--package=<tarball> a2a-msg` 形式；直接把 `.tgz` 当命令传给 `npx` 会被当成可执行文件并报 `Permission denied`。tarball 里包含 `bin/`、`src/`、`scripts/`，`--help` 路径不加载 `node_modules`，所以解包后即使没有依赖也能自检入口。

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
- 注册 CLI：`node scripts/im-register.mjs --center ... --invite ... --display-name ...`。

三条路径使用同一份实现；npx 入口只做 Node 版本检查与参数转发。

## 本次验证

2026-11-08 在 macOS（Node v24.22.2、npm 11.19.1）上按上述命令验证：

- `npx --yes --package=<本地 tarball> a2a-msg mcp --help` / `register --help`：退出码 0，空目录内不产生文件。
- `npx --yes git+file://<本地仓库> mcp --help`（等价于固定 Git ref 的直连形式）：退出码 0。
- 同一 tarball 用 Node 22 运行入口：退出码 1，stderr 为 `NODE_VERSION_UNSUPPORTED`。
