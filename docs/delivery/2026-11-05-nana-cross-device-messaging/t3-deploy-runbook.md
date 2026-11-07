---
type: runbook
slug: 2026-11-05-nana-cross-device-messaging-T3
status: active
updated: 2026-11-07
summary: "T3 本机侧交付：小兔云香港 VPS 上部署 a2a-msg IM v1 中心（direct-tls 443 + systemd + ufw），注册 lya-h / lya-o 两个 Nana 身份，本机经真实中心完成派发→回报往返、离线恢复与失败回退，证据在 evidence/t3/。2026-11-07 T1087 修了两处：§7 公司机文件传递改成考虑 22/tcp 白名单的两段式，§8 证据指针按当前脚本重跑结果校正（新增 §8.1）。"
---

# T3 两台真实设备接入 · 本机侧部署与验证手册

## 1. 交付了什么

| 项 | 结果 |
| --- | --- |
| 中心 | 小兔云香港 VPS `114.134.185.39`，a2a-msg **IM v1** 中心，`direct-tls` 监听 `10.0.54.170:443`（1:1 NAT 对外即 `114.134.185.39:443`），systemd 常驻且开机自启 |
| 身份 | 两个 Nana 身份已注册：`lya-h`（本机）= `358a6492-2822-459b-bd30-67678234b4c4`，`lya-o`（公司机占位）= `b35373d6-d694-4430-82a4-8dd24554bfb1`；双方互为联系人 |
| 本机侧往返 | 本机 `lya-h` 经真实中心把任务派发给 `lya-o`，`lya-o` 落盘/ACK/交接后回一条回报，`lya-h` 收到并标已读；`deliveredAt` / `readAt` 均有值 |
| 离线恢复 | 设备侧离线期间消息在中心积压，恢复后按 `seq` 补齐、游标续接、无重复；中心停服期间发送失败（`STORAGE_UNAVAILABLE`），恢复后同 `clientMessageId` 重试不产生重复行 |
| 失败回退 | 假凭据 → `INVALID_CREDENTIAL`；未登记联系人 → `RESOURCE_NOT_FOUND`；凭据被撤销 → `INVALID_CREDENTIAL`；客户端不信任该 CA → `STORAGE_UNAVAILABLE`；中心停服 → `STORAGE_UNAVAILABLE`（不伪造成功） |
| 持久化 | 中心 `systemctl reboot` 后服务自动起来、历史消息与 `stream_epoch`、游标全部保留 |
| 证据 | `docs/delivery/2026-11-05-nana-cross-device-messaging/evidence/t3/`（本地留档，`.git/info/exclude` 已排除，不进 git） |

**不在本包范围**：公司机侧接入（等本人在那台设备执行，步骤见 §7）、域名证书、消息清理/留存策略实现、备份自动化、高可用。

## 2. 代码基线与分支

- 部署的代码基线是 **`origin/master` = `66f1c53f0545b5825868b8722c451259a9d1f961`**（「合入 a2a 最小双端往返（T2，独立验收通过）」）。IM v1 中心（`src/im/`）、Nana 会话适配层（`src/nana/`）、`scripts/im-*.mjs` 只在这条线上；本任务分支 `goudaren0528/11-07-t3-pi` 的基线是 `origin/main`（`7bdf589`），**不含**这些代码。
- 因此本轮**没有在本分支合并或搬运 `src/im/`**：服务器与本地客户端都用 `git archive origin/master` 的同一棵树运行，本分支只提交文档。
- 服务器上 `/opt/a2a-msg/.deployed-ref` 写着部署用的 ref；复跑前先核对：

```sh
git -C <仓库> rev-parse origin/master   # 期望 66f1c53f0545b5825868b8722c451259a9d1f961
```

- 部署/验证完成后，`tests/im-nana-*.test.js` 在部署树上 `8/8` 通过（`evidence/t3/logs/local-suite-im-nana.log`）。

## 3. 服务器事实

| 项 | 值 |
| --- | --- |
| 主机 | `114.134.185.39`（hostname `ser646951040987`），Ubuntu 24.04.2 LTS，2 vCPU / 1.7 GiB / 系统盘 45 GiB 可用 |
| 网卡 | `eth0 = 10.0.54.170/24`，公网 `114.134.185.39` 为 1:1 NAT（**网卡上没有公网地址**，因此中心监听私网地址，禁止按公网地址 bind） |
| Node | `v24.22.2` / `npm 11.19.1`（NodeSource `setup_24.x`） |
| 服务 | `a2a-msg-center.service`，`enabled` + `active` |
| 端口 | `443/tcp` 对外开放；`22/tcp` 只允许 `209.240.29.135`（本人当前出口 IP） |
| 代码 | `/opt/a2a-msg`（root 拥有，只读运行） |
| 实例 | `/srv/a2a-msg/instance`（`a2a:a2a`, `0700`）|
| 证书 | `/etc/a2a-msg/tls`（`root:a2a`, `0750`） |

> **Node 版本**：仓库 `package.json` 的 `engines` 是 `>=24 <25`，中心依赖内置 `node:sqlite`，所以装的是 **Node 24 LTS（v24.22.2）**；派发说明里写的「Node.js 22」是笔误，本人 2026-11-07 已确认按 24（公司机侧也按 24 写说明）。

## 4. 目录与权限

```text
/opt/a2a-msg                      root:root 0755   代码（npm ci 后 26 MB node_modules）
/opt/a2a-msg/.deployed-ref        root:root 0644   部署 ref 标记
/srv/a2a-msg                      a2a:a2a   0700   实例父目录
/srv/a2a-msg/instance             a2a:a2a   0700
  center-v3.sqlite                a2a:a2a   0600   中心库（schema v3）
  center-config.json              a2a:a2a   0600   中心配置（含策略，不含密钥）
  admin-secret                    a2a:a2a   0600   本地管理密钥（64 hex）
  credentials/                    a2a:a2a   0700
    lya-h-credential              a2a:a2a   0600   lya-h 凭据（只在本机另存 0600 副本）
    lya-o-credential              a2a:a2a   0600   lya-o 凭据（公司机接入时交付）
    probe-credential              a2a:a2a   0600   T3 权限验证用探针（已撤销，保留留档）
  lya-h/ lya-o/                   a2a:a2a   0700   provision 生成的示例 host 配置（未用于真实主机）
/etc/a2a-msg                      root:root 0711
/etc/a2a-msg/tls                  root:a2a  0750
  ca-cert.pem                     root:a2a  0644   客户端信任链（可外传）
  ca-key.pem                      root:a2a  0640   **CA 私钥，绝不离机**
  server-key.pem                  root:a2a  0640   中心私钥
  server-cert.pem                 root:a2a  0644   中心证书
```

中心库只存凭据的 SHA-256 哈希（`im_credentials.secret_hash`），明文只存在于上面的 `credentials/*` 文件与各设备本机副本。

## 5. 部署步骤（复现用；已执行）

```sh
# 0) SSH（密钥；口令登录保留但只允许固定来源）
ssh -i ~/.ssh/a2a_vps_ed25519 root@114.134.185.39

# 1) 系统用户与目录
useradd --system --create-home --home-dir /srv/a2a-msg --shell /usr/sbin/nologin a2a
mkdir -p /opt/a2a-msg /etc/a2a-msg/tls
chown -R a2a:a2a /srv/a2a-msg && chmod 700 /srv/a2a-msg

# 2) Node 24（NodeSource）
apt-get update -qq && curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/ns.sh && bash /tmp/ns.sh
apt-get install -y nodejs                     # node -v => v24.22.2

# 3) 代码（本机以 git archive 推送 origin/master，不在服务器 clone 私有仓库）
git -C <本地仓库> archive --format=tar origin/master \
  | ssh -i ~/.ssh/a2a_vps_ed25519 root@114.134.185.39 'tar -xf - -C /opt/a2a-msg'
ssh root@114.134.185.39 'cd /opt/a2a-msg && npm ci --omit=dev --no-audit --no-fund'
echo "66f1c53f0545b5825868b8722c451259a9d1f961 origin/master (T2 merged)" \
  | ssh root@114.134.185.39 'cat > /opt/a2a-msg/.deployed-ref'

# 4) TLS：自签 CA + 含公网/私网 IP SAN 的服务器证书（365 天）
ssh root@114.134.185.39 'cd /opt/a2a-msg && node scripts/im-lan-cert.mjs \
  --out /etc/a2a-msg/tls --host 114.134.185.39 --host 10.0.54.170 --host localhost --days 365'
ssh root@114.134.185.39 'chgrp a2a /etc/a2a-msg/tls /etc/a2a-msg/tls/*; chmod 750 /etc/a2a-msg/tls; \
  chmod 640 /etc/a2a-msg/tls/server-key.pem /etc/a2a-msg/tls/ca-key.pem; \
  chmod 644 /etc/a2a-msg/tls/server-cert.pem /etc/a2a-msg/tls/ca-cert.pem; chmod 711 /etc/a2a-msg'

# 5) 实例：中心库 + 两个身份 + 凭据 + 双向联系人 + 启用写入
ssh root@114.134.185.39 'cd /opt/a2a-msg && sudo -u a2a node scripts/im-nana-provision.mjs \
  --root /srv/a2a-msg/instance \
  --agent-a-display lya-h --agent-b-display lya-o \
  --server-url https://10.0.54.170:443 \
  --tls-key /etc/a2a-msg/tls/server-key.pem --tls-cert /etc/a2a-msg/tls/server-cert.pem \
  --ca-cert /etc/a2a-msg/tls/ca-cert.pem'
# 输出：lya-h agentId 358a6492-…、lya-o agentId b35373d6-…；stdout 不打印密钥内容
```

`center-config.json` 里的 `policy.transport.serverUrl` 必须是**能 bind 的地址**（这里是私网 `10.0.54.170:443`）；客户端配置里用的是公网 `https://114.134.185.39`（注意：**不能带 `:443`**，客户端 `normalizeOrigin` 要求 `serverUrl === URL.origin`，写 `:443` 会被判 `INVALID_REQUEST`）。

### 5.1 systemd 单元（`/etc/systemd/system/a2a-msg-center.service`）

```ini
[Unit]
Description=a2a-msg IM center (Nana cross-device messaging, T3)
Documentation=file:///opt/a2a-msg/docs/im-server.md
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=a2a
Group=a2a
WorkingDirectory=/opt/a2a-msg
Environment=NODE_ENV=production
ExecStart=/usr/bin/node /opt/a2a-msg/scripts/im-center.mjs /srv/a2a-msg/instance/center-config.json
Restart=on-failure
RestartSec=3
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=yes
PrivateTmp=yes
ProtectSystem=strict
ProtectHome=yes
ReadOnlyPaths=/opt/a2a-msg /etc/a2a-msg/tls
ReadWritePaths=/srv/a2a-msg
StandardOutput=journal
StandardError=journal
SyslogIdentifier=a2a-msg-center

[Install]
WantedBy=multi-user.target
```

```sh
systemctl daemon-reload && systemctl enable --now a2a-msg-center
journalctl -u a2a-msg-center -n 20 --no-pager      # 期望 "IM center listening"
```

### 5.2 防火墙（ufw）

```sh
ufw default deny incoming
ufw default allow outgoing
ufw allow 443/tcp comment 'a2a-msg IM center (direct TLS)'
ufw allow from 209.240.29.135 to any port 22 proto tcp comment 'SSH from owner current egress'
ufw --force enable
```

- `443` 必须直连：IM v1 服务端只认**真实 TLS socket**（`src/im/http.js` 检查 `req.socket.encrypted`），不信任 `X-Forwarded-*`，所以**不能用会终止 TLS 的反向代理/隧道**；用反向代理时只能在 TCP 层透传。
- SSH 白名单是**本人当时的出口 IP**。IP 变了会连不上：用服务商控制台（VNC/救援）执行 `ufw allow 22/tcp` 解除，或 `ufw delete allow from <旧IP> to any port 22 proto tcp` 后加新 IP。
- 实测补充：除 443/22 之外的端口，公网 `nc -z` 仍显示「连接成功」（上游有设备应答 SYN），但 `curl` 得到空响应（exit 52），没有服务在交换数据；这是上游行为，不是本机放行。

### 5.3 身份显示名改名（2026-11-07 18:13，本人要求）

provision 时两个身份的显示名是 `nana-home` / `nana-office`；本人随后要求改成 `lya-h`（本机）/ `lya-o`（公司机），理由是 liaison 对外人格叫 Lya、身份跟 agent 走。**agentId、凭据、ACL、消息都不变**，只改显示名与文件名；改名后已复核一次完整派发→回报（§8）。

```sh
# a) 中心注册表：只改 display_name（agentId 与凭据不动）
#    以 a2a 用户跑，SQL：update im_agents set display_name='lya-h' where agent_id='358a6492-…';
#                                 update im_agents set display_name='lya-o' where agent_id='b35373d6-…';
# b) 服务器上的凭据与示例配置改名
cd /srv/a2a-msg/instance/credentials && mv agent-a-credential lya-h-credential && mv agent-b-credential lya-o-credential
cd /srv/a2a-msg/instance && mv host-a lya-h && mv host-b lya-o
sed -i 's|/host-a/|/lya-h/|g; s|/host-b/|/lya-o/|g; s|agent-a-credential|lya-h-credential|g; s|agent-b-credential|lya-o-credential|g' lya-h/nana.json lya-o/nana.json
chmod 600 lya-h/nana.json lya-o/nana.json credentials/lya-h-credential credentials/lya-o-credential

# c) 本机：目录、凭据、配置一起改名（不留两套）
cd ~/.a2a-msg && mv nana-home lya-h && mv nana-office lya-o
mv credentials/nana-home-credential credentials/lya-h-credential
mv credentials/nana-office-credential credentials/lya-o-credential
sed -i '' 's|/nana-home/|/lya-h/|g; s|/nana-office/|/lya-o/|g; s|nana-home-credential|lya-h-credential|g; s|nana-office-credential|lya-o-credential|g' lya-h/nana.json lya-o/nana.json
```

改名的历史痕迹：`evidence/t3/logs/roundtrip-*`、`offline-*`、`acl/`、`server/02-…` 里的旧名字是改名**前**的原始记录（照实留档，没有回改）；改名本身与改名后的复核见 `server/05-agent-rename.json`、`server/06-state-after-rename.json`、`logs/rename-20261107-181322/`。以后重建中心时直接用 `--agent-a-display lya-h --agent-b-display lya-o`，不需要再跑这节。

## 6. 本机（MacBook Air M4）侧

本机配置都放在仓库外的 `~/.a2a-msg/`（`0700`，文件 `0600`）：

```text
~/.a2a-msg/tls/ca-cert.pem                    从服务器 /etc/a2a-msg/tls/ca-cert.pem 复制
~/.a2a-msg/credentials/lya-h-credential       lya-h 凭据（0600）
~/.a2a-msg/credentials/lya-o-credential       lya-o 凭据（本轮本机代跑用，0600）
~/.a2a-msg/credentials/probe-credential       T3 权限验证探针（已撤销）
~/.a2a-msg/lya-h/nana.json                    会话配置
~/.a2a-msg/lya-h/{journal.sqlite,attachments/,session-state.json,evidence.jsonl}
~/.a2a-msg/lya-o/…                            公司机身份的本地代跑副本（用于本轮往返验证）
~/.a2a-msg/probe/…                            探针副本
```

`~/.a2a-msg/lya-h/nana.json`：

```json
{
  "serverUrl": "https://114.134.185.39",
  "agentId": "358a6492-2822-459b-bd30-67678234b4c4",
  "credentialFile": "<HOME>/.a2a-msg/credentials/lya-h-credential",
  "journalPath": "<HOME>/.a2a-msg/lya-h/journal.sqlite",
  "attachmentDirectory": "<HOME>/.a2a-msg/lya-h/attachments",
  "statePath": "<HOME>/.a2a-msg/lya-h/session-state.json",
  "evidencePath": "<HOME>/.a2a-msg/lya-h/evidence.jsonl"
}
```

客户端代码用的是同一棵 `origin/master` 树的本地解包（`evidence/t3/local-tree/`，`npm ci` 过，已排除入库）。日常命令：

```sh
export NODE_EXTRA_CA_CERTS=$HOME/.a2a-msg/tls/ca-cert.pem
node <master树>/scripts/im-nana-session.mjs status  --config $HOME/.a2a-msg/lya-h/nana.json
node <master树>/scripts/im-nana-session.mjs receive --config $HOME/.a2a-msg/lya-h/nana.json
node <master树>/scripts/im-nana-session.mjs handoff --config $HOME/.a2a-msg/lya-h/nana.json
node <master树>/scripts/im-nana-session.mjs send    --config $HOME/.a2a-msg/lya-h/nana.json \
  --to-agent <lya-o agentId> --title '任务派发' --text '…' --correlation t3-corr-1
```

## 7. 公司机接入（等本人操作，本包不代连）

### 7.0 前置：`22/tcp` 只允许 `209.240.29.135`（先选一条路）

服务器 ufw 的 SSH 规则是 `allow from 209.240.29.135 to any port 22 proto tcp`（§3、§5.2）。**公司机的出口 IP 不是这个地址时，在公司机上直接 `scp root@114.134.185.39:…` 会被 ufw 丢弃（表现为超时，不是认证失败）**。所以先选一条：

- **路线 A（默认，推荐）：两段式传递**——在**本机**（出口 IP 已在白名单）从服务器取下两个文件，再把它们传到公司机（AirDrop / 局域网 `scp` / U 盘都行）。不需要改防火墙。
- **路线 B：先给公司机出口 IP 开一条临时 SSH 白名单**——公司机上查自己的出口 IP（`curl -s https://api.ipify.org`），然后在**能连上服务器的那台机器**（本机或服务商控制台 VNC/救援）执行：

  ```sh
  ssh -i ~/.ssh/a2a_vps_ed25519 root@114.134.185.39 \
    "ufw allow from <公司机出口IP> to any port 22 proto tcp comment 'SSH temp: office-mac bootstrap'"
  ```

  公司机接好、凭据与 CA 到位后建议立刻收回：`ufw delete allow from <公司机出口IP> to any port 22 proto tcp`（只删这一条，别动 `209.240.29.135` 那条）。

下面步骤 1–2 走路线 A；走路线 B 时把步骤 1 换成在公司机上直接 `scp root@114.134.185.39:/…`，其余相同。

### 7.1 步骤

1. **本机取文件**（在已白名单的本机执行，不是公司机）：

   ```sh
   mkdir -p /tmp/t3-bootstrap && chmod 700 /tmp/t3-bootstrap
   scp -i ~/.ssh/a2a_vps_ed25519 root@114.134.185.39:/etc/a2a-msg/tls/ca-cert.pem /tmp/t3-bootstrap/ca-cert.pem
   scp -i ~/.ssh/a2a_vps_ed25519 root@114.134.185.39:/srv/a2a-msg/instance/credentials/lya-o-credential /tmp/t3-bootstrap/lya-o-credential
   shasum -a 256 /tmp/t3-bootstrap/ca-cert.pem /tmp/t3-bootstrap/lya-o-credential   # 记下来，传到公司机后复核一致
   ```

   `ca-cert.pem` 可以外传；`lya-o-credential` 是明文凭据，别进聊天记录/仓库，传完删本地暂存：`rm -P /tmp/t3-bootstrap/lya-o-credential`。
2. **传到公司机**：把两个文件放到公司机的 `~/.a2a-msg/`（先建目录，`scp` 不会替你建）：

   ```sh
   # 在公司机（或从本机 ssh 过去）先建目录
   mkdir -p ~/.a2a-msg/tls ~/.a2a-msg/credentials && chmod 700 ~/.a2a-msg ~/.a2a-msg/tls ~/.a2a-msg/credentials
   # 从本机推过去（把 weitian@office-mac 换成公司机的实际地址；没开 SSH 就直接 AirDrop 两个文件再挪到位）
   scp /tmp/t3-bootstrap/ca-cert.pem       weitian@office-mac:~/.a2a-msg/tls/ca-cert.pem
   scp /tmp/t3-bootstrap/lya-o-credential  weitian@office-mac:~/.a2a-msg/credentials/lya-o-credential
   ```

   落到位的两个目标路径必须是：`~/.a2a-msg/tls/ca-cert.pem`（`0644`）、`~/.a2a-msg/credentials/lya-o-credential`（`0600`）：

   ```sh
   chmod 644 ~/.a2a-msg/tls/ca-cert.pem && chmod 600 ~/.a2a-msg/credentials/lya-o-credential
   shasum -a 256 ~/.a2a-msg/tls/ca-cert.pem ~/.a2a-msg/credentials/lya-o-credential   # 与步骤 1 的本机值一致
   ```
3. 准备代码：在公司机 `git archive origin/master` 解包 + `npm ci`（Node **24**，`engines` 是 `>=24 <25`；Node 22 上中心依赖的内置 `node:sqlite` 需要 `--experimental-sqlite` 开关、`npm ci` 也会报 `EBADENGINE`，所以直接装 24，见 §3 注），或用同一棵树的拷贝（`evidence/t3/local-tree/` 那种）。
4. 写 `nana.json`：`serverUrl` 用 `https://114.134.185.39`（**不带 `:443`**，§5 说明了原因）、`agentId` 用 `b35373d6-d694-4430-82a4-8dd24554bfb1`，`credentialFile` / `journalPath` / `attachmentDirectory` / `statePath` / `evidencePath` 全指向公司机本地路径（照 §6 的本机示例改根目录）。
5. 设置 `NODE_EXTRA_CA_CERTS=$HOME/.a2a-msg/tls/ca-cert.pem`，跑 `status` / `receive`：应能拿到中心里发给 `lya-o` 的 `seq 1–5` 共 5 条历史消息（公司机是新的 journal，会从头收；本轮已用清空 journal 的方式验证，见 §8「新设备接同类身份」），之后游标从 `6` 继续。`seq 1–5` 这条来自 2026-11-07 21:43 的只读快照：`im_deliveries` 中 `lya-o` 为 `n=5, seq 1–5`、`im_receive_state.next_seq=6`（`evidence/t3/logs/recheck-20261107-213931/99-center-readonly.json`）。
6. 双向验证：公司机 `send --to-agent 358a6492-…`（`lya-h`），本机 `receive` 收到即算「两台真实设备」闭环。
7. **建议**：公司机接好后撤销 `b35373d6-…` 现凭据并重签一份只给公司机（本轮该凭据在本机留过副本），撤销用 `docs/im-admin-cli.md` 的 `revoke-credential`；撤销后本机 `~/.a2a-msg/lya-o/` 与凭据副本可删除。

## 8. 验收对照（AC → 证据）

> **指针说明（T1087，2026-11-07 21:39–21:50 修正）**：本表原先把 `logs/roundtrip-20261107-180436/summary.txt` 与 `logs/rename-20261107-181322/summary.txt` 当整份证据引用，但这两份 summary 是**旧版脚本**生成的，其中第 21 / 09 步与同目录补跑的 `.err` 不一致。现已按下表更正，逐条对照见 §8.1，**以 §8.1 列出的「权威产物」为准**。

| 验收点 | 结论 | 证据（`evidence/t3/` 下） |
| --- | --- | --- |
| 两台设备各自注册 Nana 身份 | 两个身份（`lya-h` / `lya-o`）已注册、状态 active、凭据哈希入库 | 当前状态：`logs/recheck-20261107-213931/99-center-readonly.json`（`agents` 显示名 `lya-h`/`lya-o`、`credentials` 3 条 `len=64`、探针 `revoked_at` 有值）；改名前后对照：`server/05-agent-rename.json`、`server/06-state-after-rename.json`。注意 `server/02-identity-and-acl.json` 是**改名之前**（`nana-home`/`nana-office`）的存档，不能用来直证现在的显示名 |
| 经真实中心完成一次任务派发与回报 | 本机 ↔ lya-o 经 `114.134.185.39:443` TLS 完成派发（`77c2b60e…`）→ 接收/ACK/交接 → 回报（`a0f30964…`）→ 已读 | `logs/roundtrip-20261107-180436/summary.txt` 的 01–20 步与该目录下 `01`–`20-*.json`（21 步见 §8.1） |
| 身份 | 凭据 Bearer、库内只存 SHA-256 前缀、假凭据被拒 | `logs/roundtrip-20261107-180436/20-send-bad-credential.*`（`INVALID_CREDENTIAL`）、`logs/recheck-20261107-213931/99-center-readonly.json`（`credentials.secret_hash` 长度 64、无明文） |
| 权限 | 未登记联系人 404、撤销后 401、其余身份不受影响 | `logs/acl/01-probe-send.log`（未登记联系人 → `RESOURCE_NOT_FOUND`）、`logs/acl/02-revoke.log`（撤销后 → `INVALID_CREDENTIAL`）、`logs/recheck-20261107-213931/09-probe-send-revoked.*` 与 `10-probe-me.*`（当前脚本重跑：探针 401、`lya-h`/`lya-o` 未撤销） |
| 离线恢复 | 设备离线期间积压、恢复后补齐 2 条、游标 1→3、无重复 | `logs/offline-20261107-180542/02,05,06,07,08-*.json`、`logs/recheck-20261107-213931/99-center-readonly.json`（`deliveries` / `receiveState`：lya-o seq 1–5 / next_seq 6，lya-h seq 1–3 / next_seq 4） |
| 失败回退 | 中心停服 → `STORAGE_UNAVAILABLE`，恢复后同 `clientMessageId` 重试只有 1 行；不信任 CA → `STORAGE_UNAVAILABLE` | `logs/offline-*/03-send-while-center-down.*`、`04-send-after-center-recovery.json`、`logs/recheck-20261107-213931/21-receive-no-ca.*`（当前脚本重跑：`STORAGE_UNAVAILABLE`、exit 1）、`logs/recheck-20261107-213931/99-center-readonly.json`（`messages n=8` 与 `audit.message_sent=8` 相等 → 8 条消息 8 个 `client_message_id`，无重复） |
| 持久化 / 常驻 | reboot 后 `active`+`enabled`，历史与游标保留，新消息 `seq 4` 继续 | `server/03-state-after-reboot.json`、`logs/post-reboot/*`、`server/04-post-reboot-verify.txt` |
| 新设备接同类身份（公司机预演） | 清空 journal 后以同一身份重新收取，拿到 `seq 1–4` 全部历史、`cursor=4`（T3-5 之后新设备会拿到 1–5）| `logs/fresh-device/01-receive-fresh.json`、`02-status-fresh.json`、`logs/recheck-20261107-213931/99-center-readonly.json`（lya-o 现为 seq 1–5、`next_seq=6`） |
| TLS | 自签 CA、SAN 含公网 IP，客户端不信任时失败 | `server/04-post-reboot-verify.txt`（`openssl x509` 段）、`logs/roundtrip-20261107-180436/21-receive-no-ca.err`（18:08 补跑，`STORAGE_UNAVAILABLE`）、`logs/recheck-20261107-213931/21-receive-no-ca.*`（21:39 当前脚本重跑，同上） |
| 部署树自测 | `tests/im-nana-*.test.js` 8/8 通过 | `logs/local-suite-im-nana.log` |
| 身份改名后复核（lya-h / lya-o） | 中心显示名已改；新派发 T3-5（`03869e32…`）→ lya-o 收 seq 5 → 回报（`7a9bd93a…`）→ lya-h 收 seq 3；探针仍 401 | 派发/收取/回报：`logs/rename-20261107-181322/summary.txt` 的 01–08 步与 `01`–`08-*.json`；「探针仍 401」看 `logs/rename-20261107-181322/09-probe-send-revoked.err` 与 `logs/recheck-20261107-213931/09-probe-send-revoked.*`（**不要读该 `summary.txt` 第 09 行**，见 §8.1）；显示名：`server/05-agent-rename.json`、`server/06-state-after-rename.json`、`logs/recheck-20261107-213931/99-center-readonly.json` |

### 8.1 证据指针修正（T1087；旧 summary 的过时行以 `.err`/重跑结果为准）

两份 `summary.txt` 是**旧版脚本**的产物；脚本在 18:13:22 / 18:13:45 改过（步骤改名、no-CA 与探针步骤写全），而 summary 生成于 18:04:41 / 18:13:25。当时只补跑了受影响的那一步（`.err`），没重生成 summary。全部对照如下：

| 位置 | 旧 summary 写的 | 实际（权威产物） | 结论 |
| --- | --- | --- | --- |
| `logs/roundtrip-20261107-180436/summary.txt` 第 21 步（旧名 `21-status-no-ca`） | `exit=0`，打印 agentId（读成「成功」） | `21-receive-no-ca.err`（18:08 补跑，当前脚本：`NODE_EXTRA_CA_CERTS=/dev/null … receive`）→ `{"error":{"code":"STORAGE_UNAVAILABLE"}}`，exit 1 | 不信任 CA 时**失败**（符合预期）；`summary` 那行是旧脚本的 `status`（本地读，本来就不联网），不能当 TLS 证据 |
| `logs/rename-20261107-181322/summary.txt` 第 09 步（旧名 `09-probe-send`） | `{"error":{"code":"INVALID_REQUEST"}}` | `09-probe-send-revoked.err`（18:13:45 补跑，当前脚本：探针凭据打 `send`）→ `{"error":{"code":"INVALID_CREDENTIAL"}}`，exit 1 | 撤销后是 **401 `INVALID_CREDENTIAL`**，不是 400 `INVALID_REQUEST` |

- 两份 summary 的其余步骤与同名 `.json`/`.err` 一致，未发现其他冲突；原 summary **不覆盖、不改写**（保留原始归档），只加并列说明文件 `logs/roundtrip-20261107-180436/summary.STALE-NOTE.md`、`logs/rename-20261107-181322/summary.STALE-NOTE.md`（含 sha256）。
- 2026-11-07 21:39 用当前脚本把这两步**只读重跑**了一遍（不写中心）：`bin/evidence-recheck.sh` → `logs/recheck-20261107-213931/`，结果与上面 `.err` 一致（`21-receive-no-ca` → `STORAGE_UNAVAILABLE`；`09-probe-send-revoked` → `INVALID_CREDENTIAL`；另加只读 `GET /api/v1/me` → 401）。重跑前后中心零变化：`messages n=8`、`distinct client_message_id=8`、`audit.message_sent=8`、`acquire_receiver=11`、`last_accepted_at=1794046404478`（仍是 18:13 那条改名回报），见 `logs/recheck-20261107-213931/99-center-readonly.json`；本机 `status` 为 `lya-h cursor=3` / `lya-o cursor=5`，与 T1082 验收报告里的只读快照一致。
- **为什么没有整脚本重跑**：`roundtrip.sh`、`rename-verify.sh` 会向中心写消息/游标，`offline-recovery.sh` 会 `systemctl stop/start` 中心；T1087 授权是「不碰中心运行态」，所以只做了非写步骤的重跑。等确认可以写中心后，命令如下（会把产物落到新的 `logs/roundtrip-<ts>/`、`logs/rename-<ts>/`，并把新 summary 作为 §8 的首选指针）：

  ```sh
  docs/delivery/2026-11-05-nana-cross-device-messaging/evidence/t3/bin/roundtrip.sh
  docs/delivery/2026-11-05-nana-cross-device-messaging/evidence/t3/bin/rename-verify.sh
  # 只读复核（不写中心，可随时跑）
  docs/delivery/2026-11-05-nana-cross-device-messaging/evidence/t3/bin/evidence-recheck.sh
  ```

  `roundtrip.sh` 用固定 `clientMessageId`（`1111…` / `2222…`），重跑会命中幂等复用同一条任务/回报，不会重复记账；但仍会新增 `acquire_receiver` 审计与 `read` 记录，所以算「写中心」。
- 复核（需 `~/.a2a-msg` 与本机 CA 就位），`offline-recovery.sh` 会真的 `systemctl stop/start` 中心（约 5 秒不可用），跑前确认可以中断：

  ```sh
  docs/delivery/2026-11-05-nana-cross-device-messaging/evidence/t3/bin/offline-recovery.sh
  ```

## 9. 日常运维

```sh
systemctl status a2a-msg-center
journalctl -u a2a-msg-center -f
ss -ltnp | grep 443

# 备份：先停服再整文件拷（保证 WAL 已合并，避免拷到半提交状态）
systemctl stop a2a-msg-center
cp /srv/a2a-msg/instance/center-v3.sqlite /srv/a2a-msg/backup-$(date +%F).sqlite
chown a2a:a2a /srv/a2a-msg/backup-*.sqlite && chmod 600 /srv/a2a-msg/backup-*.sqlite
systemctl start a2a-msg-center
```

本轮没有配置自动备份，需要的话用 cron/systemd timer 加一条上面的停机拷贝或 `im-backup` 相关脚本（见 `docs/im-backup.md`），未在本包验收。

- **证书续期**：自签 CA 有效期 365 天（`notAfter=2027-11-07`）。到期前重跑 §5 第 4 步生成新 CA/证书，**把新的 `ca-cert.pem` 发到每台设备**并重启中心；旧 CA 不再被信任后各设备都要更新。
- **新增/撤销身份**：按 `docs/im-admin-cli.md` 用 `/srv/a2a-msg/instance/admin-secret` 做本地管理（`register-agent` / `issue-credential` / `revoke-credential` / `set-contact`），必须以 `a2a` 用户跑（保护文件校验按 owner）。
- **写入开关**：`im_settings.write_mode` 当前 `enabled`；需要停写时用 admin CLI 的 `write-mode`。
- **留存**：`center-config.json` 里声明 `messageRetentionMs=86400000`（1 天）/ `idempotencyRetentionMs=172800000`（2 天）。IM v1 **本轮没有清理实现**（无 purge 任务），声明值不会真的删消息，库只会随消息增长。长期跑之前要定留存/清理与容量策略并另行验收，不要以为「1 天后自动清」。

## 10. 回滚

```sh
# 停服务（不影响本机与公司机上的凭据文件，但中心不再可用）
systemctl disable --now a2a-msg-center
# 需要彻底撤销客户端访问时，在中心撤销凭据（先停写/停服），或直接关 443：
ufw delete allow 443/tcp
```

中心库在 `/srv/a2a-msg/instance/center-v3.sqlite`，回滚到某个备份＝停服后换文件再启动；换回旧代码要连带恢复旧 DB（参考 `docs/admin.md` 的迁移边界）。

## 11. 已知限制与风险

1. **证书是自签测试 CA**，不是公网可信证书；新增设备都要手工分发 `ca-cert.pem`。要换正式证书得先有域名，并先在客户端信任链上验收。
2. **本机副本里有 lya-o 凭据**（本轮用它代跑公司机侧）。公司机正式接入后建议撤销重签，见 §7.1 第 7 步。
3. **单接收者租约**：同一身份同一时间只能一个接收进程（`LEASE_CONFLICT`）；多设备并行收 / 多主体身份模型仍是 T1 §9.3 的未决问题。
4. **SSH 白名单绑定当前出口 IP**，IP 变化需要从控制台解封（§5.2）；公司机接入时的文件传递要先看 §7.0（公司机出口 IP 不在白名单时不能直接 `scp` 服务器）。
5. **无自动备份、无留存清理、无监控告警**；2C/1.7 GB 的机器只跑这一个中心，SQLite 单写者，10 MiB 附件会短暂占写锁（本轮未传附件）。
6. **公司机侧未接**：§8 的「两台真实设备」闭环还差公司机登录一次；本包只交本机侧证据。
