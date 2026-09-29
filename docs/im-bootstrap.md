# IM center + bridge 一键初始化

在仓库根目录运行（`--root` 必须是**尚不存在**的绝对目录，`--project` 至少一个，可重复）：

```sh
node scripts/im-bootstrap.mjs --root /absolute/private/im-instance --project 'MyProject=/absolute/project|项目说明'
```

`--project` 的精确形式是 `key=绝对目录` 或 `key=绝对目录|说明`（可以重复，整个参数需加引号以免 shell 解释 `|`）；**不要用冒号分隔说明**，Windows 盘符本身包含冒号。例如 PowerShell：`--project 'demoapi=C:\Users\me\proj|示例项目'`。Windows 使用绝对 Windows 路径，并在**自行检查 NTFS ACL 已严格限制**后才添加 `--trust-windows-permissions`。Node 无法可靠验证 Windows 文件 ACL，默认保护文件检查会失败关闭；此选项仅表示操作者接受 ACL 未验证，并非管理员身份认证；提示仅打印一次。POSIX 目录设为 `0700`，文件设为 `0600`。

脚本仅创建全新目录：迁移后的 `center-v3.sqlite`、`admin-secret`、`credentials/` 下的 upstream/bridge 两份凭据、`center-config.json` 和 `bridge.json`；注册且仅注册两个 Agent，签发凭据、设为联系人、启用完整写入策略。标准输出给出 **Upstream dispatcher agentId** 和 **Bridge agentId**，只显示密钥/凭据路径，绝不显示其内容。失败保留目录以供检查；不会联网、启动服务或修改已有用户配置。

按脚本输出的绝对配置路径启动（示例路径须替换）：

```sh
node scripts/im-center.mjs '/absolute/private/im-instance/center-config.json'
NODE_EXTRA_CA_CERTS='/absolute/path/to/repo/tests/fixtures/im-tls/localhost-test-only.crt' node src/bridge/run.mjs '/absolute/private/im-instance/bridge.json'
```

Windows PowerShell 的桥接命令使用 `$env:NODE_EXTRA_CA_CERTS = '...'; node src/bridge/run.mjs '...'`。桥接运行还需要事先启动并配置 OpenCode 服务。默认 `https://localhost:8787`，可用 `--server-url https://host:port` 指定同一个中心/桥接地址。初始化配置指向仓库现有的 localhost **测试专用**证书与密钥，仅用于本机试运行；脚本**不会生成生产证书**。正式部署必须由操作者提供真实 TLS 证书、密钥与客户端信任链，并相应更新中心配置及客户端 CA 信任设置。不要将测试证书用于生产。

LAN 部署时用 `--tls-key <绝对文件路径>` 和 `--tls-cert <绝对文件路径>` 同时指定中心使用的真实证书密钥；可选 `--ca-cert <绝对文件路径>` 指定要复制到另一台机器的 CA 证书。三个路径都必须指向现有普通文件（不能是符号链接）；CA 路径仅用于输出下一步命令，不写入 `center-config.json`。PowerShell 示例（先自行准备已包含 LAN IP 的证书）：

```powershell
node scripts/im-bootstrap.mjs --root D:\a2a-msg --server-url https://192.168.11.40:8787 --project 'demoapi=D:\projects\demo-api|示例服务' --tls-key D:\a2a-tls\server-key.pem --tls-cert D:\a2a-tls\server-cert.pem --ca-cert D:\a2a-tls\ca-cert.pem --trust-windows-permissions
```

将 `D:\a2a-tls\ca-cert.pem` 复制到另一台机器，并在该机器上将 `NODE_EXTRA_CA_CERTS` 指向复制后的文件；脚本输出的本机桥接命令会使用指定的 CA 路径。仓库测试证书只适用于本机 localhost，其他机器不可使用。

## 人工派发任务

中心和桥接启动后，使用初始化输出的 **Bridge agentId**；`--root` 指向同一个初始化目录。派发器从 `bridge.json` 读取中心地址与上游身份，从 `credentials/upstream-credential` 读取凭据，无需手动拼装。另开终端运行（测试 TLS 证书时，先按上文设置 `NODE_EXTRA_CA_CERTS`）：

```sh
node scripts/im-dispatch.mjs --root '/absolute/private/im-instance' --bridge '<Bridge agentId>' projects
node scripts/im-dispatch.mjs --root '/absolute/private/im-instance' --bridge '<Bridge agentId>' task --id Task1 --project MyProject --requirement-file './requirement.txt'
node scripts/im-dispatch.mjs --root '/absolute/private/im-instance' --bridge '<Bridge agentId>' watch
```

`task` 也支持 `--requirement '文本'` 或 `--requirement -` 从标准输入读取；文件方式可避免 PowerShell 长文本引号问题。`watch` 用于之后观察未完成任务；同一上游身份一次只能运行一个接收者。任务默认等待 600 秒（`--timeout 秒数` 可调整），超时不代表任务失败；`needs_approval` 须在目标机器人工批准，桥接不会自动批准。
