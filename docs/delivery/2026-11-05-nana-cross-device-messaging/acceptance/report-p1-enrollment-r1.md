---
type: acceptance-report
slug: 2026-11-05-nana-cross-device-messaging-P1-enrollment-r1
status: done
updated: 2026-11-08
verdict: 通过
summary: "P1 身份自助注册独立验收：AC-2 / AC-3 P1 范围内 12 条用例全部通过；0 要修；独立探针与基线对照见证据"
---

# 验收报告：P1 身份自助注册（AC-2 / AC-3）第 1 轮

**结论**：通过。P1 范围内 12 条用例、8 项体验清单（5 项适用）全部通过，0 条要修；补偿性全量回归与基线对照未发现新增失败。

**独立性打折**：Codex 本机不可用，验收与开发同在 Claude，**独立性打折**；本报告不把开发自述当证据，所有判据来自本轮实际执行的测试与独立探针。

**被测**：`goudaren0528/a2a-msg` 分支 `goudaren0528/11-08-t100039-claude` HEAD `1e9d1fa`（实现提交 `631968f`），基线 `origin/master` `66f1c53`。
**用例**：`docs/delivery/2026-11-05-nana-cross-device-messaging/cases.md`。

```
VERDICT: PASS passed=12 failed=0 blocked=0 total=12
```

## 一、执行环境

- 工作目录：`/Users/hongweitian/orca/workspaces/a2a-msg/11-08-t100042-claude`
- Node 24.22.2 / npm 11.19.1；`npm ci`（95 包，未改 lock）
- 测试命令：`TMPDIR=/private/tmp NANAZI_NO_SEND=1 node --test …`、`TMPDIR=/private/tmp NANAZI_NO_SEND=1 npm test`
- 被测服务：`createImCenter` + 临时 `node:http`，`local-test` 仅 loopback；SQLite 为 `:memory:` 或 `mkdtemp` 临时目录
- 未连真实中心、未读 `private/`、未推送/合并/改代码

## 二、用例结果

| 用例 | AC | 结果 | 一手证据 |
|---|---|---|---|
| C-1 邀请码兑换建号 | AC-2 | 通过 | 探针 `http_enroll_without_auth`（201、含 credential）、`http_me_after_enroll`（200、同一 agentId）；`tests/im-enrollment.test.js:142` |
| C-2 设备侧注册 CLI | AC-2 | 通过 | 探针 `register_script`：stdout 无凭据/邀请码，state 0700 / identity+credential 0600，`/me` 200；`tests/im-enrollment.test.js:187` |
| C-3 一次性 | AC-3 | 通过 | 探针 `replay` → `INVITE_ALREADY_USED`；`http_concurrent_redeem` → [201,409]，邀请只核销一次、无孤儿身份 |
| C-4 TTL | AC-3 | 通过 | 探针 `ttl_one_ms_before` OK / `ttl_boundary` `INVITE_EXPIRED` / `ttl_validation` 5 个非法值全 `INVALID_REQUEST` |
| C-5 可撤销 | AC-3 | 通过 | 探针 `revoked` → `INVITE_REVOKED`；`revoke_used` / `revoke_twice` / `revoke_missing` → `RESOURCE_NOT_FOUND`；无授权撤销 → `OPERATION_FORBIDDEN`（`tests/im-admin-cli.test.js:50-73`） |
| C-6 固定错误码 | AC-3 | 通过 | 探针 `http_fixed_codes`：未知 404、格式错误 400，正文仅 `code/message/retryable` |
| C-7 默认关闭 | AC-3 | 通过 | 探针 `http_disabled_default`：403 `ENROLLMENT_DISABLED`，0 个身份，邀请未核销；`default_policy_enrollment={enabled:false}` |
| C-8 凭据不落日志/错误/审计 | AC-3 | 通过 | 探针 `invite_stored_only_hash` / `db_has_no_plaintext_secret` / `enroll_audit_has_no_secret` / `register_script.auditHasSecret=false`；代码无请求体日志点 |
| C-9 未认证路由在 Bearer 之前 | AC-3 | 通过 | 探针无 Authorization → 201；无效 Bearer → 201；`/me` 无凭据 → 401 `AUTH_REQUIRED` |
| C-10 v3→v4 显式迁移 | AC-3 | 通过 | 探针 `migrate_script`：from 3→4，重复 from 4，既有行保留，目录只多 config/db；`migrate_reject_v2` → `IM_SCHEMA_MISMATCH` |
| C-11 迁移失败整体回滚 | AC-3 | 通过 | 探针 `migrate_failure_rollback`：version 3、v4 对象 0、事务结束、v3 断言通过 |
| C-12 回滚路径 | AC-3 | 通过 | 执行方案 P1 回滚列 + `docs/im-migration.md:3` 写明「v4 不可逆，恢复升级前备份/旧 ref」；脚本不备份、不建库 |

### 体验清单（X-1…X-8）

| 编号 | 项 | 结果 | 依据 |
|---|---|---|---|
| X-1 | 空态 | 通过 | 新库无邀请码兑换 → `INVITE_NOT_FOUND`，无异常栈 |
| X-2 | 加载 | 不适用 | 无界面、单次短请求 |
| X-3 | 失败 | 通过 | C-6：固定码、可读、不泄露 |
| X-4 | 权限不足 | 通过 | 无管理员授权 → `OPERATION_FORBIDDEN`；`/me` 无凭据 → 401 |
| X-5 | 极端值 | 通过 | 显示名 1/255 OK、256/控制字符/空 → `INVALID_REQUEST`；TTL 边界见 C-4 |
| X-6 | 窄屏 | 不适用 | 无界面 |
| X-7 | 键盘 | 不适用 | 无界面 |
| X-8 | 文案一致性 | 通过 | 5 个错误码在 `src/im/contracts.js`、`docs/im-api-contract.md`、`docs/im-enrollment-contract.md`、测试中一致 |

## 三、回归与基线对照

| 运行 | 命令 | tests | pass | fail | skipped | 退出 |
|---|---|---|---|---|---|---|
| P1 核心相关 | `node --test tests/im-enrollment.test.js tests/im-http.test.js tests/im-admin-cli.test.js tests/im-schema.test.js tests/im-schema-identity.test.js` | 59 | 59 | 0 | 0 | 0 |
| P1 legacy/备份相关 | `node --test tests/im-v2-schema.test.js tests/im-v2-backup.test.js tests/im-migration-runner.test.js tests/im-backup.test.js tests/im-backup-publisher.test.js tests/im-backup-snapshot.test.js tests/im-restore-rehearsal.test.js tests/im-config.test.js tests/im-contracts.test.js tests/im-server.test.js tests/im-core-integration.test.js tests/im-auth.test.js` | 220 | 218 | 0 | 2 | 0 |
| P1 全量 | `npm test`（HEAD `1e9d1fa`） | 2774 | 2570 | 142 | 62 | 1 |
| 基线全量 | `npm test`（`66f1c53`） | 2765 | 2561 | 142 | 62 | 1 |

结论：P1 新增 9 条用例全部通过；失败数 142 与基线完全相同，失败集中在未改动文件（`EADDRNOTAVAIL 127.0.0.2/3` 等本机环境原因），未引入新失败。未删测试、未放宽断言；冻结线测试只重钉提交与哈希，逐字节断言保留。

## 四、合入状态核实

- **提交号**：实现 `631968feacf0f8860024e4d413e7e5108f30d728`；分支 HEAD `1e9d1fa159c3fe01b1f74f3a899229ce4d0a939a`（含 `631968f`、`4dda348`、`ac61aef`、`ee56d96`、`1e9d1fa` 5 个提交）
- **合入状态**：`branch-only`
- **分支名**：`goudaren0528/11-08-t100039-claude`
- **核实依据/目标 ref**：
  - `git rev-parse HEAD` → `1e9d1fa159c3fe01b1f74f3a899229ce4d0a939a`
  - `git branch -a --contains 1e9d1fa` → 仅 `(HEAD detached)` 与 `goudaren0528/11-08-t100039-claude`
  - `git merge-base --is-ancestor 1e9d1fa origin/master` → 退出码 1；`origin/main` → 1；`main` → 1
  - `git rev-parse main origin/main origin/master` → `407254e…` / `407254e…` / `66f1c53…`（本仓库 `main` 是另一条无共同祖先的旧线，P1 的基线是 `origin/master`）
  - `git status --short` → 空
  - 证据：`evidence/p1-merge-state.log`
- **后续工作/责任归属**：本验收会话无代码后续；合并、VPS 迁移、P4/P6 由跟进 Agent / 本人决定。

## 五、未验证项

以下**不算通过**，如实列出：

1. **AC-2「不需要 clone 源码」端到端**：P1 只交付仓库内 `scripts/im-register.mjs`；免 clone 的 npx 入口属 P4（执行方案 P4 依赖 P1/P3），本轮未验证。P1 可验证的注册主流程已通过。
2. **真实两台设备 / VPS 中心**（执行方案 P6）：需兄弟操作第二台设备与 VPS，本轮未做；AC-2 的「第二台设备只凭 URL+邀请码+显示名」只在 loopback 合成中心验证。
3. **生产 TLS / 私有 CA（`NODE_EXTRA_CA_CERTS`）**：未搭 CA、未连真实中心；`im-register.mjs` 的证书分支只做代码核对。
4. **每 IP 限流 429 阈值**：只核对代码路径，未压到 600 次/分钟。
5. **Windows 权限告警分支**：本机 macOS，未实机验证。
6. **v4 中心的备份注册表发布**：`src/im/backup-registry.js` 仍只认 v3（范围外，见审查报告），未验证 v4 发布路径。

## 六、机制问题（nanazi）

1. **角色说明假设存在 PRD，但本任务没有 PRD**：现象：dev/accept 角色说明要求「先读 PRD，PRD 是唯一基准」，实际权威只有 `plans/exec/2026-11-08-a2a-no-install.md`，`docs/prd/` 无对应文件。触发条件：执行方案型任务复用 PRD 型角色说明。影响：开发与验收都要自行推断基准，易误找或自造。复现：`ls docs/prd/` 与 handoff 目录。初步归因：模板/角色说明（任务类型未区分）。建议修法：任务说明按「PRD / 执行方案」明确权威文件，或缺 PRD 时写「以执行方案为准」。
2. **测试说明引用了本仓库不存在的 `tests/_isolation.py`**：现象：任务要求「跑测试必须带 `NANAZI_NO_SEND=1`（测试公共入口 `tests/_isolation.py` 已默认带上）」，但 a2a-msg 无该文件、全仓无 `NANAZI_NO_SEND` 读取点。触发条件：跨项目派发复用 nanazi 仓的测试约定。影响：容易误以为开关已生效。复现：`ls tests/_isolation.py`、`rg NANAZI_NO_SEND`。初步归因：模板/文档（跨仓约定混用）。建议修法：模板按项目区分测试入口，或注明「本项目无此入口，仅设置环境变量」。
3. **运行记录「可以派的角色：无」与执行方案的 accept 授权冲突**：现象：T100039 运行记录写「可以派的角色：无」，执行方案 P6 又授权 accept；跟进 Agent 需先发 N1108-44-347c（中等）等主会话确认才能派验收。触发条件：派发模板与执行方案角色授权不同步。影响：验收派发被延误一轮。复现：对照运行记录与 `plans/exec/2026-11-08-a2a-no-install.md` P6 行。初步归因：机制/派发模板。建议修法：派发前用执行方案的角色授权覆盖模板默认值，或明确以哪一处为准。

## 七、证据清单（本地，不提交）

`docs/delivery/2026-11-05-nana-cross-device-messaging/evidence/`

- `p1-core-tests.log`（59/59）
- `p1-related-tests.log`（220 / 218 pass / 2 skipped）
- `p1-full-suite.log`（2774 / 2570 / 142 / 62）
- `baseline-66f1c53-full-suite.log`（2765 / 2561 / 142 / 62）
- `p1-independent-probe.log`、`p1-independent-probe.json`、`p1-independent-probe.mjs`（独立探针，可复跑）
- `p1-merge-state.log`
- 审查报告：`reviews/P1-enrollment-r1.md`；PRD 缺项：`prd-gaps.md`
