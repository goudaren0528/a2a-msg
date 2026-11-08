---
type: package
slug: 2026-11-05-nana-cross-device-messaging-P1-enrollment
status: review
updated: 2026-11-08
summary: "执行方案 P1：schema v4 + 邀请码自助注册 + 未认证 /api/v1/enroll + register/migrate CLI"
---

# P1 身份自助注册（执行方案 2026-11-08-a2a-no-install）

- 对应 AC：AC-2、AC-3（执行方案验收）
- 依赖：P0（分支收敛；本包在任务分支上独立实现，未改 main/master）
- 权威：`plans/exec/2026-11-08-a2a-no-install.md` P1 行；基线 `origin/master` `66f1c53`
- 分支：`goudaren0528/11-08-t100039-claude`
- 说明：`packages/P1.md` 是上一轮「最小双端往返」包的记录，本包单独建档，不覆盖旧证据。

## 步骤

- [x] 1 `src/im/schema.js`：`IM_SCHEMA_VERSION=4`、`SUPPORTED=[1,2,3,4]`，新增 `im_enrollment_invites`、`im_contact_requests` 与索引，显式 `migrateImSchemaV4`（fresh/v3→v4/重复；拒绝 v1、v2；失败整体回滚）· 验证：`tests/im-schema.test.js`、`tests/im-schema-identity.test.js` 通过 · 提交 `631968f`
- [x] 2 `src/im/enrollment.js`：公开兑换；校验格式、事务内建身份/收据/凭据、一次性核销、`system/enrollment` 审计 · 验证：`tests/im-enrollment.test.js` 六个用例通过 · 提交 `631968f`
- [x] 3 `src/im/admin.js` + `admin-cli.js`：`createEnrollmentInvite` / `revokeEnrollmentInvite`；只返回一次明文 code，库内只存 SHA-256，审计只含 `{expiresAt}` · 验证：`tests/im-admin-cli.test.js` 与 `tests/im-enrollment.test.js` · 提交 `631968f`
- [x] 4 `src/im/http.js` + `config.js` + `server.js`：`POST /api/v1/enroll` 在 Bearer 之前，默认 `enrollment.enabled=false`；固定错误码；`createImCenter` 仅在策略开启时构造模块 · 验证：`tests/im-http.test.js`、`tests/im-enrollment.test.js` · 提交 `631968f`
- [x] 5 `scripts/im-register.mjs`：Node 24 检查、中心 URL 校验、0600 凭据/identity、stdout 不打印凭据、拒绝覆盖已有身份 · 验证：端到端子进程用例通过 · 提交 `631968f`
- [x] 6 `scripts/im-migrate-v4.mjs`：读中心配置的 `dbPath`，显式 v3→v4，可重复，拒绝 v1/v2 · 验证：子进程用例（v3 迁移 + 重复 + v2 拒绝）通过 · 提交 `631968f`
- [x] 7 legacy 兼容：`migration-runner.js` 与 `backup-publisher.js` 接受 v3/v4 标记；v2 冻结线测试重新钉住本包提交与发布器哈希 · 验证：`tests/im-migration-runner.test.js`、`tests/im-v2-schema.test.js`、`tests/im-v2-backup.test.js`、`tests/im-backup*.test.js` 通过 · 提交见下方「交接」
- [x] 8 文档：新增 `docs/im-enrollment-contract.md`；同步 `im-server`、`im-admin-cli`、`im-api-contract`、`im-http-contract`、`im-identity-contract`、`im-migration`、`CHANGELOG` · 验证：文档路径可点、命令与实际一致 · 提交 `631968f`
- [x] 9 全量自测 + 交接

## 自测

- 新增与相关用例（`TMPDIR=/private/tmp NANAZI_NO_SEND=1 node --test …`）：
  - `tests/im-enrollment.test.js` → 6/6 通过。
  - `tests/im-http.test.js` → 15/15 通过（含新增未认证 `/enroll`、固定错误码、默认关闭）。
  - `tests/im-admin-cli.test.js` → 8/8 通过（含两条新命令的授权与不泄露断言）。
  - `tests/im-schema.test.js` + `tests/im-schema-identity.test.js` → 通过（v4 迁移、回滚、v1/v2 兼容）。
  - `tests/im-v2-schema.test.js` → 102/102；`tests/im-v2-backup.test.js` → 通过。
  - `tests/im-migration-runner.test.js`、`tests/im-backup.test.js`、`tests/im-backup-publisher.test.js`、`tests/im-backup-snapshot.test.js`、`tests/im-restore-rehearsal.test.js` → 72/72 通过、1 skipped。
  - `tests/im-config.test.js`、`im-contracts.test.js`、`im-server.test.js`、`im-core-integration.test.js`、`im-auth.test.js` → 26/26 通过。
- 全量：`TMPDIR=/private/tmp NANAZI_NO_SEND=1 npm test` → 结果见下方「全量结果」。
- 性能 / 安全自查（只看变更路径）：
  - 兑换为单次 `BEGIN IMMEDIATE`，查询均按主键/唯一索引（`code_hash` UNIQUE），无 N+1、无循环 IO；邀请核销与建号同事务。
  - 凭据只以 SHA-256 入库；明文只出现在 201 响应一次；审计、日志、错误正文都不含 code/hash/credential（测试断言）。
  - 输入严格字段、code 43 字符 base64url、显示名 1–255 且无控制字符；未知字段拒绝。
  - 未认证路由仍受 TLS 检查、连接上限与每 IP 每分钟限流；默认关闭；v3 库开启注册会在启动时 fail closed。
  - `im-register.mjs` 复用 `saveProtectedFile`：0600、O_EXCL、O_NOFOLLOW、属主与硬链接检查；不打印凭据。

## 全量结果

（见提交后的进度更新）

## 修复记录

<!-- dev-fix 每轮加一节 -->

## 交接

**提交号**：`631968feacf0f8860024e4d413e7e5108f30d728`（实现、测试与文档；后续钉住/进度提交用 `git log -1 --format=%H -- docs/delivery/2026-11-05-nana-cross-device-messaging/packages/P1-enrollment.md` 唯一解析）；**合入状态**：`branch-only`；**分支名**：`goudaren0528/11-08-t100039-claude`；**核实依据/目标 ref**：`git rev-parse HEAD` 得实现提交 `631968f…`，`git branch --show-current` 为本分支，`git log --oneline origin/master..HEAD` 仅含本包提交（实现 + 钉住/进度），`git merge-base --is-ancestor HEAD origin/master` 退出码 1；**后续工作/责任归属**：交跟进 Agent 派验收 Agent（Codex）；本会话在收到审查/测试报告前无主动后续；合并、推送、VPS 迁移由跟进 Agent/本人决定。

### 做了什么

- schema v4：两张新表 + 两个索引，显式 `migrateImSchemaV4`；v1/v2 仍走原路径，v3/v4 快照与 legacy 绑定迁移均被接受。
- 自助注册：管理员一次性邀请码（TTL 1 分钟–30 天、可撤销、库内只存哈希）；`createImEnrollment.redeem` 原子建号、发凭据、核销邀请；`POST /api/v1/enroll` 位于 Bearer 分流之前，策略默认关闭。
- 设备侧：`scripts/im-register.mjs` 用「中心 URL + 邀请码 + 显示名」注册，0600 落盘、stdout 不含凭据；`scripts/im-migrate-v4.mjs` 显式升级并可重复执行。
- 文档：新增合约并同步六份 IM 文档与 CHANGELOG。

### 怎么验证的

见「自测」：新增/相关套件全通过；兑换、重复、过期、撤销、未知码、默认关闭均有固定错误码断言；审计与错误正文不含凭据/邀请码；CLI 端到端验证凭据可 `GET /api/v1/me`。

### 还剩什么 / 需要跟进 Agent 确认

1. **v2 冻结线测试重新钉住**：`tests/im-v2-schema.test.js` 原来钉住提交 `61052a3` 的 `src/im/schema.js`/`src/im/migration-runner.js` 与 `backup-publisher.js` 哈希。本包按执行方案 P1 文件归属改了这三个源文件，因此把钉住提交改为本包实现提交 `631968f`、发布器哈希改为 `5cf7d087…`；断言强度未放宽（仍逐字节比对），但这是**改动冻结测试**，请验收 Agent 重点复核。
2. **`docs/im-storage-contract.md` 未同步**：它仍写 `IM_SCHEMA_VERSION=3`，但该文件不在 P1 文件归属内，未改；建议 P6/文档包一并更新。
3. **`docs/im-recovery-retention-v2-design.md`** 仍描述「把 legacy 常量改成 4 会破坏 v3 工作流」，现已按 3/4 双接受处理；该设计文档也不在 P1 归属内。
4. **响应丢失即消耗邀请**：兑换成功但 HTTP 响应丢失时邀请已核销、凭据不可恢复；文档已写明需重新发邀请。未做「兑换幂等」因为 PRD 未要求且会扩大范围。
5. **`scripts/im-bootstrap.mjs` / `im-nana-provision.mjs`** 仍只迁到 v3；P1 未改（不在文件归属），新中心需显式跑 `im-migrate-v4.mjs` 才有注册能力。
6. **未覆盖**：真实两设备/VPS 部署（P6）、好友申请状态机（P2）、MCP 挂载（P3）、npx 打包（P4）、附件（P5）。

### 机制问题（nanazi）

1. **派发说明要求「先读 PRD」，但本任务没有 PRD 文件，只有执行方案**：dev-task 第 7 行写「需求已经在 PRD 里定稿，PRD 是唯一基准」，第 21 行要求开工先读 PRD；实际交接包只有 `nanazi/plans/exec/2026-11-08-a2a-no-install.md`，`docs/prd/` 下没有与本需求对应的 PRD。现象：开发需自行判断以执行方案为唯一基准；触发条件：执行方案型任务复用了 PRD 型角色说明；影响：可能误找或自造 PRD；复现：`ls docs/prd/` 与 handoff 目录；初步归因：模板/角色说明（任务类型未区分）；建议：任务说明按「PRD / 执行方案」二选一写明权威文件，或缺 PRD 时明确「以执行方案为准」。
2. **测试说明的 `tests/_isolation.py` 在本仓库不存在**：与上一轮 P1 记录相同，本仓库没有该文件、也没有 `NANAZI_NO_SEND` 读取点；本次仍按约定设置环境变量。建议模板按项目区分测试入口。
