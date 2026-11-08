---
type: test-report
slug: 2026-11-05-nana-cross-device-messaging-t3-r2
status: done
updated: 2026-11-07
verdict: 通过
summary: "T1087 两条文档修复复验通过：§8/§8.1 能读出「不信任 CA → STORAGE_UNAVAILABLE」与「改名后探针 401」两条结论，旧 summary 有 STALE 标记；§7 公司机接入按 22/tcp 白名单写了可执行的两段式与 ufw 白名单路线；中心审计与 T1082 快照一致、未代连公司机。公司机实测与整份重跑不在本轮范围。"
---

# T3 文档修复复验（第 2 轮，T1089）

**结论：通过（范围内 0 条要修；3 条范围外观察）**

```
VERDICT: PASS passed=3 failed=0 blocked=0 total=3
```

- 派发：nanazi `2026-11-05-nana-cross-device-messaging#T1089`；来源 T1082 报告 `report-t3-r1.md` 的 2 条「范围内要修」。
- 验收对象：T1087 的 6 个提交 `05a0873..2fa257e`，只改 `t3-deploy-runbook.md` 与 `packages/T3-P1.md`（`git diff --name-only` 2 个文件），没有产品代码。
- 基准：T1082 报告 `docs/delivery/2026-11-05-nana-cross-device-messaging/acceptance/report-t3-r1.md`（T1082 分支提交 `bb8906b`）第「二、范围内要修」1/2 条；runbook `f8ae75b..2fa257e` 的 diff。
- 平台独立性：开发 T1087 用 `pi`，本轮验收 `codex`（`python tools/squad.py resolve accept` → `accept：平台 codex（squad.yaml）`）；`independence_reduced: false`，不打折。
- 体验环境：**没有界面，不需要体验环境**（部署手册 + CLI/接口证据）。
- 证据根：本 worktree 没有 evidence 副本；下文路径以 `/Users/hongweitian/orca/workspaces/a2a-msg/11-07-t1087-pi/docs/delivery/2026-11-05-nana-cross-device-messaging/evidence/t3/` 为根（本地留档、不入库）。原始归档在 `11-07-t3-pi` 同路径，多一份 `local-tree/`；两份 `diff -r --exclude=local-tree` 只差 T1087 副本 README 的「本目录是副本」说明。

## 一、核对结果

| # | 核对项 | 结论 | 一手证据 |
| --- | --- | --- | --- |
| C1 | §8/§8.1 证据指针能读出结论；旧 summary 已标 STALE | **通过** | `logs/roundtrip-20261107-180436/summary.txt:60` 与 `21-receive-no-ca.err`；`logs/rename-20261107-181322/summary.txt:24` 与 `09-probe-send-revoked.err`；两份 `summary.STALE-NOTE.md`（sha256 相符）；`logs/recheck-20261107-213931/`；runbook §8/§8.1；本会话 22:37 独立复跑两条负例 |
| C2 | §7.0/§7.1 公司机接入可执行（两段式或 ufw 白名单），写明 `22/tcp` 限制 | **通过** | runbook §7.0/§7.1；`server/07-company-bootstrap-preflight.txt`（ufw 第 2 条、两个源文件与权限）；本会话用文档里的密钥从本机只读 SSH 成功；522/81 字节源文件与目标权限一致 |
| C3 | 未代连公司机、未改中心运行态 | **通过** | `logs/recheck-20261107-213931/99-center-readonly.json`（21:43）与本会话 22:37 只读查询逐项相同：`messages n=8/cids=8/last_accepted_at=1794046404478`、`acquire_receiver=11/release_receiver=11/message_sent=8`、lya-h seq 1–3 / lya-o seq 1–5；服务 `active`/`enabled`/`NRestarts=0`；当天 sshd 会话 59 条全部来自 `209.240.29.135`，无其他来源 |

本轮 3 个在范围内的核对项全部通过；公司机实测与整份重跑属于范围外未验证项，见第四节，不影响上面结论。

## 二、逐条复验

### C1 §8/§8.1 证据指针与 STALE 标记

**旧 summary 的过时行与权威产物对得上。**

本项按 T1082 指出的两处争议行（`roundtrip` 第 21 步 / `rename` 第 09 步）判定；§8 其余行的指针也逐条核过，其中「权限」行有一个子句的指针不够直接，见 O1，不影响本项结论。

1. `roundtrip` 第 21 步：`summary.txt:60` 是旧名 `21-status-no-ca (exit=0)`，内容是本机 `status` 的 agentId；同目录 `21-receive-no-ca.err` 是 18:08 补跑的 no-CA `receive`（命令与当前脚本第 21 步一致），内容为 `{"error":{"code":"STORAGE_UNAVAILABLE"}}`。runbook §8 的 TLS 行已改为直接指 `21-receive-no-ca.err` 与 `logs/recheck-20261107-213931/21-receive-no-ca.*`，不再拿旧 summary 当 TLS 证据。
2. `rename` 第 09 步：`summary.txt:24` 是旧名 `09-probe-send (exit=1)`，输出 `{"error":{"code":"INVALID_REQUEST"}}`；同目录 `09-probe-send-revoked.err` 输出 `{"error":{"code":"INVALID_CREDENTIAL"}}`（文件末还有 `exit=1`）。runbook §8 的改名行明确写「**不要读该 `summary.txt` 第 09 行**」，并把 401 指到 `.err` 与 21:39 重跑目录。
3. 两份 `summary.STALE-NOTE.md` 都写清了旧行、权威 `.err`、实际值、脚本版本与背景；sha256 与实物一致：

```text
596dd254ea9f07151c09047523497b30ea0df173714ed31295581e9e6b7a1f50  logs/roundtrip-20261107-180436/summary.txt
19cd6a854ecfe6bbbd299f67195580cc846a35957cc0a1bbb2b794a5a69a4bf6  logs/roundtrip-20261107-180436/21-receive-no-ca.err
45a081a85638da70c7b6563fc7a6bf0a969d9011d5235f0d7c467272920751c7  logs/rename-20261107-181322/summary.txt
bcfe04cd709cd9750b53d347843bd0146eb8a1a473867b9b7a91f326edea51fc  logs/rename-20261107-181322/09-probe-send-revoked.err
```

4. `logs/recheck-20261107-213931/summary.txt` 用当前脚本重跑两步，结果与补跑 `.err` 一致：`21-receive-no-ca (exit=1)` → `STORAGE_UNAVAILABLE`；`09-probe-send-revoked (exit=1)` → `INVALID_CREDENTIAL`；另加只读 `GET /api/v1/me` → `http_code=401`。
5. 本会话不采信开发自述，按当前客户端树（`11-07-t3-pi/.../local-tree`）在 22:37 独立重跑：

```text
NANAZI_NO_SEND=1 NODE_EXTRA_CA_CERTS=/dev/null node … receive --config ~/.a2a-msg/lya-h/nana.json
  → {"error":{"code":"STORAGE_UNAVAILABLE"}}  exit=1
NANAZI_NO_SEND=1 NODE_EXTRA_CA_CERTS=~/.a2a-msg/tls/ca-cert.pem node … send \
  --config ~/.a2a-msg/probe/nana.json --to-agent b35373d6-… --text …
  → {"error":{"code":"INVALID_CREDENTIAL"}}  exit=1
```

6. STALE 标记的可发现性：原 `summary.txt` 按「保留原始归档」不改写；同目录 `summary.STALE-NOTE.md`、证据根 `README.md`、runbook §8 顶部「指针说明」与 §8.1 对照表四处都能读到「第 21/09 步过时、以 `.err` 为准」。这与 T1082 建议的「README.md 与 §8 标注」一致，故按「已标 STALE」通过。
7. 指针可解析性：§8 表里 `logs/…`/`server/…` 的引用逐条存在（`roundtrip` 21 步的 json/err、`rename` 9 步的 json/err、`offline`、`post-reboot`、`fresh-device`、`acl`、`recheck`、`server/03–07` 均已核对）；`server/04-post-reboot-verify.txt` 的 `openssl x509` 段含 `IP Address:114.134.185.39 / 10.0.54.170 / DNS:localhost`、`notAfter=Nov 7 10:02:22 2027 GMT`。

### C2 §7.0/§7.1 公司机接入

1. `22/tcp` 限制写在三个地方且与服务器现状一致：§3 服务器事实（第 45 行）、§5.2 防火墙、§7.0 前置（第 236 行）。§7.0 原文点明「公司机出口 IP 不是这个地址时，直接 `scp root@114.134.185.39:…` 会被 ufw 丢弃（超时，不是认证失败）」。
2. 只读核实（`server/07-company-bootstrap-preflight.txt`，22:09；本会话 22:31 复核得到同一 ruleset）：

```text
[ 1] 443/tcp    ALLOW IN    Anywhere        # a2a-msg IM center (direct TLS)
[ 2] 22/tcp     ALLOW IN    209.240.29.135  # SSH from owner current egress
-rw-r--r-- root a2a 522 /etc/a2a-msg/tls/ca-cert.pem
-rw------- a2a  a2a  81 /srv/a2a-msg/instance/credentials/lya-o-credential
```

3. 路线 A（默认）确为两段式：§7.1 第 1 步在**本机**（已白名单）执行 `mkdir -p /tmp/t3-bootstrap`、两条带 `-i ~/.ssh/a2a_vps_ed25519` 的 `scp` → `shasum -a 256`；第 2 步把两个文件送到公司机 `~/.a2a-msg/tls/`、`~/.a2a-msg/credentials/`，给出 `0644`/`0600` 与 sha256 复核。第 1 步的 SSH 连接、密钥、两个源路径与权限，本会话已从本机实连核实（`ssh -i ~/.ssh/a2a_vps_ed25519 root@114.134.185.39` 成功；`ls -l` 与 preflight 一致）；`scp` 本身未执行（避免在本机落下明文凭据副本），但走的同一 SSH 通道、源路径已确认可读。
4. 路线 B 给的是 `curl -s https://api.ipify.org` 查公司机出口 IP、`ufw allow from <IP> to any port 22 proto tcp` 加临时白名单、接好后 `ufw delete allow from <IP> to any port 22 proto tcp` 收回；命令语法与 §5.2 的现有规则同形，且提醒别动 `209.240.29.135` 那条。
5. 公司机目标路径是绝对路径（`weitian@office-mac:~/.a2a-msg/...`），不再是 T1082 指出的「目的路径缺 `host:`」；`serverUrl` 仍是 `https://114.134.185.39`（不带 `:443`），`agentId` 是 `b35373d6-…`，与 §6 示例一致。
6. 第 5 步「新设备拿到 `seq 1–5`、游标从 6 继续」有当前只读快照支持：`99-center-readonly.json` 的 lya-o `n=5, seq 1–5`、`next_seq=6`。原文把依据写在同一句里，读者不用猜。

### C3 未代连公司机、未改中心运行态

1. 中心状态三次快照一致：T1082 报告 A2/A4（18:50 前）为 8 条消息 / 8 个 `client_message_id`、lya-o acquire 8 次 + lya-h 3 次；T1087 的 `99-center-readonly.json`（21:43）与本会话 22:37 只读查询都是：

```text
messages: n=8, cids=8, last_accepted_at=1794046404478（18:13 改名回报）
deliveries: lya-h n=3 seq 1–3；lya-o n=5 seq 1–5
receiveState: lya-h next_seq=4 acked=3；lya-o next_seq=6 acked=5；probe next_seq=1
audit: message_sent=8, message_read=2, acquire_receiver=11, release_receiver=11
credentials: lya-h/lya-o revoked_at=null；probe revoked_at=1794045921674
settings.write_mode=enabled；agents 显示名 lya-h/lya-o/probe-unregistered
```

2. 服务侧在本会话两次 SSH 复核时都是 `ActiveState=active`、`SubState=running`、`UnitFileState=enabled`、`NRestarts=0`；ufw ruleset 与 22:09 preflight 完全相同（未被改动）。
3. 「未代连公司机」：当天 sshd 的 59 条 `Accepted publickey` 全部来自 `209.240.29.135`（本机当前出口，也是唯一白名单来源），没有第二个来源 IP；中心没有新的 `acquire_receiver`（仍 11 次）、没有新消息、没有新设备游标，lya-o 的 journal 仍 `cursor=5`。结合 §7 明确「公司机等本人操作、本包不代连」，没有代连痕迹。
4. 本会话自己做的只读/负例操作之后（22:37）再查中心，数字仍与 21:43 完全一致，证明 no-CA `receive` 与撤销探针 `send` 都没有写中心。

## 三、范围外观察（不要求本次修）

以下不属于 T1082 的 2 条争议项，只记录，不要求本轮修。

- **O1（证据指针精度，建议）**：§8「权限」行把「`lya-h`/`lya-o` 未撤销」挂在 `09-probe-send-revoked.*` 与 `10-probe-me.*` 后面，但这两个文件只证明探针 401，不含 lya-h/lya-o 的凭据状态；直接证据是同表其他行已引用的 `99-center-readonly.json`（`credentials[].revoked_at` 对 lya-h/lya-o 为 null）和 01/02 status。结论本身为真，也不影响 C1 的两处争议行；建议下次编辑把该子句指向 99 快照。
- **O2（版本标签，轻微）**：§8.1 把 18:08 的 `21-receive-no-ca.err` 标为「当前脚本」；`bin/roundtrip.sh` 的 mtime 是 18:13:22，严格说 18:08 那次用的文件版本无法从归档证明（很可能只是 18:13 的改名改动）。命令语义与当前脚本一致，且 21:39、22:37 用当前脚本复跑都是 `STORAGE_UNAVAILABLE`，结论不依赖这个标签；建议改成「18:08 补跑，脚本版本未留档，结果已用 21:39 当前脚本复跑复核」。
- **O3（步骤顺序/路线 B 清晰度，轻微）**：§7.1 第 1 步末尾的 `rm -P /tmp/t3-bootstrap/lya-o-credential` 在文字上位于第 2 步传输之前，虽然同句写了「传完删」，按顺序执行仍可能先删掉待传凭据；建议移到第 2 步 sha256 复核之后。路线 B 的「其余相同」也应注明「跳过第 2 步的两段式拷贝」；VNC 场景是在服务器上直接跑 `ufw allow`，不需要 `ssh -i`。路线 A 默认路径不受影响。

## 四、未验证项

| 项 | 状态 | 原因 | 尚缺证据 | 下一步 |
| --- | --- | --- | --- | --- |
| U1 公司机侧真实接入（T3 计划级「两台真实设备」） | 待实机（范围外） | 本包/本轮不代连公司机；本轮只验证 §7 的步骤与前置事实，第二段「传到公司机」未执行 | 公司机 `receive` 取得 seq 1–5、`send --to-agent 358a6492-…` 到 lya-h、本机收到；公司机本地 `nana.json` 与 journal | 由 weitian 在公司机按 §7.0/§7.1 操作；本轮无法代做 |
| U2 整份 `roundtrip.sh`/`rename-verify.sh` 重跑并生成新 summary | 未测（需写中心授权） | 两个脚本会写中心消息/游标/`acquire_receiver` 审计，`offline-recovery.sh` 还会停服；T1087 与本轮授权都是「不碰中心运行态」 | 一份同一次运行生成的完整新 `summary.txt`（21 步 / 09 步都不再有旧脚本行） | 授权「可写中心」后按 §8.1 命令跑；在此之前以 §8.1 对照 + 21:39/22:37 只读复跑为准 |
| U3 路线 B 的临时 ufw 规则实际生效/收回 | 未测（会改防火墙） | 不知道公司机出口 IP，且改 ufw 不在本轮只读授权内 | `ufw allow from <公司机IP> to any port 22` 后公司机可连、`ufw delete` 后收回，ruleset 只剩 443 与 `209.240.29.135` 的 22 | 由 weitian 在公司机按 §7.0 路线 B 操作；本轮只核了现有 ruleset 与命令语法 |

**关于未验证项的边界**：U1–U3 都不是本轮 T1089 的核对对象（本轮只复核 T1087 的两条文档修复与「未代连/未改运行态」）。C1–C3 的通过结论不依赖 U1–U3；其中 U1 是 T3 计划级闭环，T1082 已同样列为待实机。

## 五、合入状态核实

- 被审提交：`f8ae75b37f241685d5d7b03394f0e64b50d00143`（修复主体，runbook §7/§8 + T3-P1 修复记录）；同分支后续文档提交 `a80b58fb71054afc358d0e93476b0e25c55136b0`、`c9da4f077b7a5a4d3447c26bd5592ce4cae4250b`、`b30defe2940094a45c3483c9e6ebcaf560ff4816`、`8a6707c39dd07a42a3cb7e7594e835d82633a145`、`2fa257e93fb1b17dd0607d6f2240613a2c790385`；`git diff --name-only 05a0873..HEAD` 只有 `t3-deploy-runbook.md` 与 `packages/T3-P1.md`，没有产品代码。
- 分支名：被审 `goudaren0528/11-07-t1087-pi`；本报告在 `goudaren0528/11-07-t1089-codex`。
- 目标 ref / 核实命令（2026-11-07 22:31–22:37，本机）：

```text
git ls-remote origin refs/heads/main refs/heads/master
  7bdf589dcea10b1a1ce53e668c6687905a1cce43  refs/heads/main
  66f1c53f0545b5825868b8722c451259a9d1f961  refs/heads/master
git merge-base --is-ancestor 2fa257e origin/main   → exit 1
git merge-base --is-ancestor 2fa257e origin/master → exit 1
git branch -a --contains 2fa257e
  goudaren0528/11-07-t1087-pi
  goudaren0528/11-07-t1089-codex
git ls-remote origin 'refs/heads/goudaren0528/*'   → 无输出（分支未推送）
```

- 合入状态：**branch-only**（未入 main，也未入 master；远程没有该任务分支）。`in-main` 不成立，未冒称。
- 本报告提交号：本文件提交后按 `git log -1 --format=%H -- docs/delivery/2026-11-05-nana-cross-device-messaging/acceptance/report-t3-r2.md` 唯一解析。
- 后续工作/责任归属：本会话（T1089）报告提交后**无后续工作**；U1 由 weitian 在公司机按 §7 操作，U2 需「可写中心」授权后跑，合并/推送由跟进 Agent 与 weitian 决定；O1–O3 是范围外观察，不要求本轮修。

## 六、机制问题

以下三条在 T1082/T1087 已出现过，本轮再次遇到，按条目模板补记，供跟进 Agent 去重：

1. **派发说明的测试入口在本仓库不存在（重复 T3-P1 #3 / T1082 #1 / T1087 #6）**。现象：说明写「跑测试必须带 `NANAZI_NO_SEND=1`（测试公共入口 `tests/_isolation.py` 已默认带上）」，a2a-msg 仓没有 `tests/_isolation.py`，全仓无 `NANAZI_NO_SEND` 引用。触发条件：nanazi 模板跨仓套用。影响：验收/开发要自己判断开关是否适用；本轮是文档复验，负例 CLI 已按说明带变量，但它对 Node 无作用。复现：`ls tests/_isolation.py`、`rg NANAZI_NO_SEND` 均无结果。初步归因：模板/文档。建议：模板按项目区分测试入口，或派发时注明「本项目无此入口」。
2. **证据根目录不在派发说明里（重复 T1087 #4）**。现象：`files:` 只列 runbook，但两条修复的权威证据（`21-receive-no-ca.err`、`summary.STALE-NOTE.md`、`recheck-20261107-213931/`、`server/07-company-bootstrap-preflight.txt`）都在 `evidence/t3/`，而本 worktree 一开始没有这个目录；验收只能去 `11-07-t1087-pi` / `11-07-t3-pi` 找，且要确认哪份是原始归档。触发条件：证据类需求在新 worktree 复审。影响：复审可能打开相对路径失败，或拿到不含 `local-tree` 的副本后复跑失败。复现：`ls docs/delivery/2026-11-05-nana-cross-device-messaging/`（本 worktree 只有 `packages/` 与 runbook）。初步归因：模板/派发。建议：派发说明固定写「证据根目录：<绝对路径>（本地留档、不入库）」并注明是否已复制到本 worktree。
3. **副作用授权没有枚举（沿用 T1087 #5）**。现象：本轮 U2「整份重跑」仍只能列为待授权，因为模板没有「可写中心：是/否」「可停服：是/否」字段；T1082 的「优先整份重跑」与「不碰中心运行态」在文字上仍冲突。触发条件：验收建议涉及写中心脚本。影响：执行会话要猜边界，猜错就写中心/停服或漏做验收。复现：对比 `report-t3-r1.md` 二.1「优先重跑」与 T1087/T1089 派发的「不碰中心运行态」。初步归因：模板。建议：派发模板加副作用枚举，冲突时以派发枚举为准并在说明里点名。

## 七、证据与命令（本会话）

- 只读 SSH（22:31、22:32、22:37；来源 IP `209.240.29.135`）：
  - `ssh -i ~/.ssh/a2a_vps_ed25519 root@114.134.185.39 'ufw status numbered; systemctl show -p ActiveState -p SubState -p NRestarts -p UnitFileState a2a-msg-center; ls -l /etc/a2a-msg/tls/ca-cert.pem /srv/a2a-msg/instance/credentials/lya-o-credential'` → 见 C2/C3。
  - `cat logs/recheck-20261107-213931/99-center-readonly.mjs | ssh … 'node --input-type=module'`（`readOnly: true` 的 `node:sqlite` 查询；不改表）→ 22:33:06 与 22:37:17 两次结果与 21:43 快照相同。
  - `journalctl -u ssh --no-pager --since '2026-11-07 00:00' | grep -o 'Accepted publickey for root from [0-9.]*' | awk '{print $NF}' | sort | uniq -c` → `59 209.240.29.135`（无其他来源）。
- 客户端负例（22:37，`11-07-t3-pi/.../local-tree`，带 `NANAZI_NO_SEND=1`）：
  - `status --config ~/.a2a-msg/lya-h/nana.json` → `{"received":3,"handedThrough":3,"pending":0,"cursor":3}`，exit 0。
  - `NODE_EXTRA_CA_CERTS=/dev/null … receive --config ~/.a2a-msg/lya-h/nana.json` → `STORAGE_UNAVAILABLE`，exit 1。
  - `NODE_EXTRA_CA_CERTS=… … send --config ~/.a2a-msg/probe/nana.json --to-agent b35373d6-…` → `INVALID_CREDENTIAL`，exit 1。
- 证据文件逐项核对：`logs/roundtrip-20261107-180436/`（21 步 + `summary.STALE-NOTE.md`）、`logs/rename-20261107-181322/`（09 步 + `summary.STALE-NOTE.md`）、`logs/recheck-20261107-213931/`（`summary.txt`、`README.md`、`99-center-readonly.json`）、`logs/offline-20261107-180542/`、`logs/post-reboot/`、`logs/fresh-device/`、`logs/acl/`、`server/03–07`、`logs/local-suite-im-nana.log`（`tests 8 / pass 8 / fail 0`）。
- 没有跑单测/全量：本轮只改文档，产品代码零改动；负例是真实客户端 CLI 的 e2e。没有读 `private/` 下的 webhook 文件，没有改 ufw、没有拷凭据、没有停服、没有写中心、没有连公司机。
