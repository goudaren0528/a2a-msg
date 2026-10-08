# 管理员：部署、映射、迁移与恢复

## 单中心、直接 Node 优先

团队只运行一份中心，所有消息保存在其 SQLite。Node.js **24**、ESM JavaScript、内置 node:sqlite 和官方 MCP SDK；源码根目录 `npm ci`，启动 `npm start`。成员只需要源码依赖与 bridge，不需要本地 DB。

| 环境变量 | 默认 |
| --- | --- |
| `MSG_HOST` | `127.0.0.1` |
| `MSG_PORT` | `8787` |
| `MSG_DB_PATH` | 当前工作目录下 `data/msg.sqlite` |
| `MSG_ACCESS_CONFIG` | 当前工作目录下 `access.json` |
| `MSG_MAX_ATTACHMENT_BYTES` | `10485760`（10 MiB）单个附件原始字节上限 |

推荐 DB 和配置均使用绝对路径。`.env` 不自动加载；PowerShell `$env:变量 = '值'` 只影响当前终端及后续子进程。原生中心前台 Ctrl+C 停止；下节提供仅供人工审核的 Windows 计划任务安装脚本。

## Windows 开机启动：人工审核后注册（当前尚未注册）

`scripts/run-center-foreground.mjs` 在**同一个 Node 进程**中动态加载 `src/server.js`，用 `createServer().start()` 前台服务，不生成 detached 子进程、不改旧 `log/server.pid`；缺失或零字节 DB、缺 access、端口占用立即拒绝且绝不接管旧服务。启动日志追加在根目录 `log/server.stdout.log` / `log/server.stderr.log`；不记录消息或凭据。默认参数与本机现部署一致：根目录 `D:\team-mailbox`、Node `C:\nvm4w\nodejs\node.exe`、原有 DB `D:\team-mailbox\data\msg.sqlite`、access `D:\team-mailbox\access.json`、`0.0.0.0:18787`；可经安装脚本参数调整。**不得让现有 Startup 快捷方式 `log/launch-center.vbs` 与新任务同时启用**；旧入口检查 `server.pid`，而新入口不更新它，混用会导致冲突。禁用旧 Startup 项需另行明确批准，先备份再操作，本文不授权自动处理。

在目标账户（目前是 ttx）先用普通 PowerShell 预览，之后由**同一个账户**手动提升为管理员审核并运行 `-Apply`：

```powershell
Set-Location -LiteralPath 'D:\team-mailbox'
powershell.exe -NoProfile -File .\scripts\install-center-startup.ps1
# 审核固定盘、实际 Node 可执行文件目标、父目录/文件 ACL、旧 Startup 冲突及任务预览后，在同一账户的提升终端：
powershell.exe -NoProfile -File .\scripts\install-center-startup.ps1 -Apply
# 不会立即启动任务；管理员另行核验：
Export-ScheduledTask -TaskName TeamMailboxCenter
```

安装器预览不写任务；若同名任务已存在则拒绝覆盖，不获取密码、不自动提升、不修改 ACL。任务计划为 `AtStartup` 加 30 秒随机延迟（不是恰好 30 秒）、当前账户 S4U 无密码登录、`Limited` 权限、`IgnoreNew` 并发策略、无限执行时限、最多 3 次间隔 1 分钟的失败重启，允许电池运行且切换电池不停服，不要求 idle。S4U 是否允许访问 DB/日志目录须管理员检查实际权限；失败重试有限，不保证卡死恢复或任何时间都在线。XML 中核对 `LogonType=S4U`、`RunLevel=LeastPrivilege`、`BootTrigger`/延迟、`MultipleInstancesPolicy=IgnoreNew`、`ExecutionTimeLimit=PT0S`、电池及 restart 字段。不要用 SYSTEM 账户或别人的账户来“绕过”权限。

安装器拒绝网络盘、EFS、检测到的 reparse point 以及对 Everyone / Authenticated Users / Users / Interactive 的宽泛写 ACL；该检查不是完整有效权限证明，管理员仍必须确认 Node 实际解析目标、代码及其可替换父目录、DB/access/log 目录的继承与写入权限和未来 ACL 变化。若预览被 ACL 阻塞，停止并报告；不应自动调整权限或默认绕过。当前部署若已有旧服务占据 18787，新任务不能接管或停止它。禁用旧 Startup、停服、手工启动任务或无人登录的真实重启验收各需单独授权；本轮隔离测试只证明入口可在临时 DB 上工作，不证明计划任务已安装或重启后成功。

## JSON 映射

`access.example.json` 只提供 loopback 单人成员 A 演示。团队示意（IP 仅为文档示例）：

```json
{
  "allowedCidrs": ["192.168.50.0/24", "127.0.0.0/8", "::1/128"],
  "members": [
    { "name": "A", "ips": ["192.168.50.21"] },
    { "name": "B", "ips": ["192.168.50.22", "192.168.50.23"] },
    { "name": "Admin", "ips": ["127.0.0.1", "::1"] }
  ]
}
```

一个成员可对应多 IP；所有这些 IP 共享同一收件箱和已读。成员名经 trim 后允许 Unicode 字母/数字、下划线、连字符，1–32 个 UTF-16 码元。没有 displayName 配置字段，API 为兼容工具结果返回 displayName=name。

校验采用成熟 `ipaddr.js` 解析和 CIDR 匹配，使用 Node `net.isIP` 拒绝缩写/八进制 IPv4。IPv4-mapped IPv6 规范化到 IPv4，因此 `127.0.0.1` 与 `::ffff:127.0.0.1` 不能重复绑定；同一成员内重复也失败。无 zone 的标准 IPv6 可用；mapped CIDR 必须至少 /96，再换算为 IPv4 前缀。配置字段严格校验，不接受任意额外身份字段。

缺文件、坏 JSON、空 allowedCidrs/members、非法 CIDR/IP、重复 name、重复规范 IP、空 ips 或任何成员 IP 超出白名单，均**在打开 DB 前启动失败**。没有默认放行或凭据回退。

```powershell
Set-Location -LiteralPath '<仓库路径>'
$env:MSG_ACCESS_CONFIG = '<仓库路径>\access.json'
npm run admin -- validate-config
npm run admin -- list-members
```

这两个命令只读配置，不创建 DB；list-members 列出当前文件的规范 IP。中心加载的是启动快照：修改后先校验，再重启中心。停止前在途请求可能仍完成，撤销操作应考虑停服边界。

### 添加、修改、删除成员

- **添加**：给 JSON members 增加唯一 name/ips，确保 IP 在白名单内；校验、重启。
- **换 IP/增加设备**：修改同一成员 ips；校验、重启，旧 IP 若删除则不能再访问。
- **撤销**：删除整个成员项或其 IP（不能留下空 ips）；校验、重启。该成员不再有新收件资格，历史数据保留。
- **重新加入/改名**：同名会重新获得原收件箱；改名是新身份，不迁移历史。不要把旧 name 复用给另一个人。

使用固定 IP 或 DHCP 保留，并管理 IPv6 地址稳定性；IP 被租给另一台设备可能导致误认。IP 是网络访问约定，**不是强身份认证**。同一 NAT/代理/共享电脑 IP 之后的用户无法区分。

### 一个成员 = 一个 Agent 进程

成员的所有 IP 与设备共享同一收件箱和已读状态。**运维规则：同一成员同一时间只应有一个 Agent 宿主进程消费该收件箱。** 两个 Agent 进程共用一个成员时，先读正文的一方会把消息标记已读，另一方的未读队列随之清空且无法追溯——这不是故障，是共享已读语义的必然结果。

确需在同一台机器运行多个 Agent 时，只能做**约定级软隔离**：每个 Agent 使用不同的 `project` 标签，消费时用 `getmsg` 的 `project` 过滤只取自己的消息（`unread_metadata` 仅支持 `from` 过滤，**不支持 `project`**）。软隔离不提供身份保证：同一成员下的任意进程仍可按 id 读取任意收件消息。需要真正隔离时应为每个 Agent 分配独立成员映射（独立 IP）。

## 显式开放 LAN（由管理员操作，本轮未执行）

1. 确定真实成员来源地址、白名单、服务网卡以及限定来源的防火墙规则，禁止公网入口。
2. 编辑并校验 access.json；保留管理员来源以便从其机器运行 health/doctor。CIDR 通过仍需有成员映射，health 也不例外。
3. 停止中心，在启动终端设置实际网卡地址，例如 `$env:MSG_HOST = '192.168.50.10'`。若选 `0.0.0.0` 会监听全部 IPv4 网卡，只应在防火墙范围确认后选择。
4. 使用同一 DB 绝对路径重启。向同事提供实际服务 URL，不是 `0.0.0.0`。
5. **每台成员机器**运行 doctor，确认服务识别的 member 正确后才进行双方同意的测试收发。

服务只用 `req.socket.remoteAddress`，不采信 Forwarded/X-Forwarded-For/Authorization/自报名字；即使在代理后也不会改变此规则。HTTP 明文仅可信 LAN；若需要 TLS，应采用经验证保留来源的传输部署，普通 TLS 反向代理会让中心看到代理 IP，不能简单放行代理并假定身份已区分。本次没有修改网络、防火墙或客户端配置。

## 旧数据库迁移与升级

旧版采用个人凭据表。升级后源码没有旧认证/成员创建轮换撤销 CLI，没有凭据环境变量或认证 fallback。

1. **升级前先备份**现有 DB 和部署参数，创建并校验新 access.json。为需要保留收件箱的成员使用原 name；新配置是唯一授权来源，旧数据库的 revoked_at 不再决定访问权限。
2. 停止旧服务、替换源码和 lockfile、Node 24 下 `npm ci`，设置同一 DB 路径及新 access.json。
3. 新中心启动时先验证配置，再开启 DB；schema 初始化/迁移在事务中执行，**删除旧 tokens 表及其索引**，保留 members 历史行与 messages。消息 id、文本、项目、reply_to、read_at、创建时间和自增序列不重写。新配置缺少的旧成员仍保留用于外键，但不能访问或成为新收件人。启用附件的版本还会在同一事务中新建 `attachments` 表（`CREATE TABLE IF NOT EXISTS`）；**`messages` 表定义本身不变**，历史行逐行保持原状。
4. 将新配置成员 INSERT OR IGNORE 到历史 members 表；当前 peers 从配置返回。旧 display_name/revoked_at 只作历史兼容列，不当授权。
5. 核对 doctor、当前成员、历史消息以及受控收发。未来未知 schema 升级不能据此保证自动兼容；当前只明确支持仓库旧版到本 IP 方案的迁移。

迁移不丢消息，但不能直接用旧程序回滚到已删除凭据表的新 DB。要回滚旧版本，须停服后恢复**升级前备份及旧代码**，会失去备份后的新消息；先确认业务接受该回退边界。不要让旧、新中心同时打开同一 DB。

## 附件存储与容量

附件二进制**直接存在 SQLite 的 `attachments` 表 BLOB 列**，不落地为独立文件，也不依赖对象存储或文件服务器。表结构 `attachments(id, message_id, name, size, mime, sha256, data, created_at)`，`message_id` 外键指向 `messages(id)` 并带唯一约束，因此**一条消息最多一个附件**。

升级采用 `CREATE TABLE IF NOT EXISTS` 增量建表：**不重建 `messages`、不迁移历史数据**，旧库的消息、id、已读状态、回复关系全部原样保留；`messages.text` 仍是 `NOT NULL`，纯文件消息写入空字符串。

**容量会随附件增长。** 每 100 个 10 MiB 附件约 1 GB，直接反映为 DB 文件体积、备份耗时和备份占用空间。部署前确认数据盘余量，并定期检查 DB 大小：

```powershell
Get-Item -LiteralPath '<仓库路径>\data\msg.sqlite' | Select-Object Length
```

**一期永久保留附件，没有任何自动清理。** 也没有 `list-attachments` / `prune-attachments` 等 admin 附件命令——admin 只有 `validate-config`、`list-members`、`backup` 三个命令。需要回收空间只能由管理员人工介入（停服、备份后用 SQL 删除并 VACUUM），本文不提供该流程，操作前须自行验证。

`MSG_MAX_ATTACHMENT_BYTES` **只能调小，不能调大**：超过默认 10 MiB 的值，以及 0、负数、非整数、无法解析的值，都会**静默回退到 10 MiB 默认值**而不是报错。这是刻意设计——含附件的请求体上限固定为 16 MiB（10 MiB 原文 base64 后约 13.4 MiB 加 JSON 开销），放大附件上限会超出该预算。需要更严格时可下调，例如限制为 1 MiB：

```powershell
$env:MSG_MAX_ATTACHMENT_BYTES = '1048576'
```

该值在进程启动时读取，修改后需重启中心。它只约束新上传，不影响已入库附件。

单写者 SQLite 下，10 MiB 附件写入期间会短暂占用写锁（busy timeout 5 秒），多人同时传大文件可能拖慢文本消息；一期靠团队规模自然限流，没有并发限制。单次上传的中心内存峰值约为原始文件的 3 倍（原始 + base64 + JSON 字符串）。

附件与消息同权限：只有收件人可下载，**发送人请求自己发出的附件也返回 403**。DB 备份含全部附件明文，和消息一样必须限制文件访问。

## 备份：VACUUM INTO

```powershell
$env:MSG_DB_PATH = '<仓库路径>\data\msg.sqlite'
npm run admin -- backup 'D:\msg-backups\msg-20260920-01.sqlite'
```

admin backup 只读打开既有源 DB，不初始化/迁移；实际执行 SQLite `VACUUM INTO ?` 创建一致的独立数据库文件。目标必须不存在（拒绝覆盖），缺父目录会创建。可在线备份，注意空闲空间、权限和锁等待，繁忙时可失败后选择低峰重试。不是热复制运行中的主 DB。

因为附件存在 BLOB 列里，**`VACUUM INTO` 仍然是单文件备份，一个文件即含全部附件**，没有需要另行同步的附件目录。代价是**备份文件体积随附件增长、备份耗时变长、所需空闲空间变大**——`VACUUM INTO` 期间源库和目标文件同时存在，预留空间应按 DB 当前体积再加一份估算。繁忙或附件较多时优先安排低峰执行。

备份 JSON 映射和部署参数需单独保存，DB 备份不包含 access.json。所有备份含明文消息，应限制文件访问。用以下命令检查产物：

```powershell
npm run doctor -- --db-path 'D:\msg-backups\msg-20260920-01.sqlite' --skip-server
```

首次迁移前也可使用新 admin backup 备份旧库；它不会执行 DROP TABLE。完整恢复演练仍需在隔离环境完成。

## 恢复：停服务并隔离旧 WAL

没有 restore CLI。恢复目标必须明确，禁止通配/递归清空数据目录。

1. 验证备份可打开、完整性与 schema 正确，确定 DB 目标绝对路径、代码版本和对应映射配置。
2. 停止中心，关闭所有 admin/doctor/SQLite 进程，确认没有其他进程/容器访问同一 DB。
3. 创建一个全新空隔离目录，逐一移走旧 `msg.sqlite` 和存在时的 `msg.sqlite-wal`、`msg.sqlite-shm`，保留为同一旧状态集合。任一步失败就停下调查。
4. 确认目标位置无旧主库/WAL/SHM，再将独立备份复制为目标 `msg.sqlite`；不要复制旧 WAL/SHM 回去。
5. 使用 doctor 的显式只读 DB 检查，核对恢复的 access.json 和成员分配，再启动中心。身份取决于 JSON，不从旧备份自动恢复；旧消息重新出现时同事应刷新缓存的 id 选择。

若目标是 `<仓库路径>\data\msg.sqlite`，只处理这三个精确路径：

```text
<仓库路径>\data\msg.sqlite
<仓库路径>\data\msg.sqlite-wal
<仓库路径>\data\msg.sqlite-shm
```

旧文件在恢复确认前保留，不能仅覆盖主文件混用旧 WAL。定期在独立目录演练，避免首次故障时才验证流程。

## Docker：受限参考，不推荐默认团队身份部署

**当前 Docker 不可用，本轮未执行构建、部署或恢复。** NAT/桌面 Docker/端口转发可能替换来源 IP。当前实现不信任代理头，Docker 启动成功也不证明能够区分成员；不能把网关 IP 映射为某人后宣称所有同事已接入。

Dockerfile 基于 `node:24-alpine`、镜像内 `npm ci --omit=dev`、工作目录 `/app`。Compose 将 `/data` 挂到命名卷 `msg-data`，物理卷名由项目名决定；只读绑定宿主 `access.json` 为 `/app/access.json`，缺文件拒绝创建目录代替。宿主默认只发布 `127.0.0.1:8787:8787`，容器内监听 `0.0.0.0`。

先由管理员在隔离环境证明来源保真，再考虑部署。源码目录下参考命令：

```powershell
docker compose build msg-server
docker compose up -d msg-server
docker compose ps
docker compose logs --tail 100 msg-server
docker compose exec msg-server node src/admin.js validate-config
docker compose exec msg-server node src/admin.js list-members
```

逐条检查退出码。Compose 固定 MSG_ACCESS_CONFIG/MSG_DB_PATH/MSG_HOST/MSG_PORT，不自动加载宿主 `.env` 同名值。更新 bind 配置文件后应重建服务容器以确保映射文件更新，例如 `docker compose up -d --force-recreate msg-server`；不要假定容器内 loopback doctor 代表宿主/成员路径。

备份仍使用相同卷中的 VACUUM INTO 产物：

```powershell
docker compose exec msg-server node src/admin.js backup /data/backups/msg-20260920-01.sqlite
docker compose cp msg-server:/data/backups/msg-20260920-01.sqlite 'D:\msg-backups\msg-20260920-01.sqlite'
```

导出前确认宿主父目录存在、目标不存在。只留在原卷的备份不能应对卷损坏。

### Docker 停服恢复参考

保持同一 Compose 项目及原服务容器，不删除卷。停止所有同卷访问者：

```powershell
docker compose stop msg-server
docker compose run --rm --no-deps --entrypoint sh msg-server
```

下列是维护容器内的 **Linux sh**，不是 PowerShell；每步成功后继续，隔离目录必须全新：

```sh
mkdir /data/pre-restore-20260920-01
mv /data/msg.sqlite /data/pre-restore-20260920-01/msg.sqlite
if [ -e /data/msg.sqlite-wal ]; then mv /data/msg.sqlite-wal /data/pre-restore-20260920-01/msg.sqlite-wal; fi
if [ -e /data/msg.sqlite-shm ]; then mv /data/msg.sqlite-shm /data/pre-restore-20260920-01/msg.sqlite-shm; fi
exit
```

回到 PowerShell，确认无旧 WAL/SHM，再复制到仍存在的已停服务容器的挂载卷：

```powershell
docker compose cp 'D:\msg-backups\msg-20260920-01.sqlite' msg-server:/data/msg.sqlite
docker compose run --rm --no-deps msg-server node src/doctor.js --db-path /data/msg.sqlite --skip-server
docker compose start msg-server
```

核对所有者/权限、JSON 映射和来源保真后再允许成员访问。升级镜像前保留旧版本/镜像标识，不能只记 latest；同一项目 `build` 后 `up -d` 保留命名卷。来源问题未验证前，不将 Docker 示例作为团队可用方案。
