---
type: acceptance-report
slug: 2026-11-05-nana-cross-device-messaging-P2-friends-r1
status: done
updated: 2026-11-08
verdict: 通过
summary: "P2 好友申请/接受独立验收：AC-4 / AC-5 / AC-6 的 13 条用例（P0 7 条）全部通过；独立探针 27/27；全量失败集合与基线逐条相同；0 要修"
---

# 验收报告：P2 好友申请/接受（AC-4 / AC-5 / AC-6）第 1 轮

**结论**：通过。P2 范围内 13 条用例（P0 7 条）全部通过，0 条要修；独立探针 27/27；全量回归未引入新失败。

**独立性打折**：Codex 本机不可用，验收与开发同在 Claude，**独立性打折**；本报告不把开发自述当证据，所有判据来自本轮实际执行的测试、独立探针与代码核对。

**被测**：`goudaren0528/a2a-msg` 分支 `goudaren0528/11-08-t100041-claude`，HEAD `2e2886542f3f40c432d50f0e49ceae8d6ef148ee`，基线 `feat/a2a-no-install` `532b2d1`。
**用例**：`docs/delivery/2026-11-05-nana-cross-device-messaging/cases.md`（P2 部分）。

```
VERDICT: PASS passed=13 failed=0 blocked=0 total=13
```

## 一、执行环境

- 工作目录：`/Users/hongweitian/orca/workspaces/a2a-msg/11-08-t100045-claude`（报告与用例提交在这里）
- 被测代码：`git archive goudaren0528/11-08-t100041-claude` 解到 `/private/tmp/a2a-p2-t100045`；验收分支不切换
- Node 24.22.2 / npm 11.19.1；`npm ci`（95 包，未改 lock）
- 测试命令：`TMPDIR=/private/tmp NANAZI_NO_SEND=1 node --test …`、`TMPDIR=/private/tmp NANAZI_NO_SEND=1 npm test`
- 被测服务：`createImCenter` + 真实 `https` 监听 `localhost:0`（仓库测试证书，仅 loopback）；SQLite 为 `mkdtemp` 临时目录或 `:memory:`
- 未连真实中心、未读 `private/`、未推送/合并/改业务代码；测试数据全部为合成身份

## 二、用例结果

| 用例 | AC | 结果 | 一手证据 |
|---|---|---|---|
| C-1 非好友没有联系人、不能建会话/发正文 | AC-4/AC-6 | 通过 | 探针 `AC-4.1`（items=0）、`AC-4.3`（conversation 404 / message 404） |
| C-2 申请后 B 看到 pending | AC-4 | 通过 | 探针 `AC-4.2`：201、pending、outgoing、version=1；incoming 命中同一 requestId |
| C-3 只有 target 能接受；重复请求幂等 | AC-4 | 通过 | 探针 `AC-4.4`（outsider/self 404）、`AC-4.8`（同 requestId/version） |
| C-4 接受后双方 contacts accepted，A 能发正文 | AC-4 | 通过 | 探针 `AC-4.5`（accepted、version=2、双方 contacts）、`AC-4.6`（201 + B 读到同一 messageId） |
| C-5 反向 pending 即互相接受 | AC-4 | 通过 | 探针 `AC-4.7`：reverse=accepted/version=2，一行、allowed=1 |
| C-6 拒绝后立即不能收发 | AC-5 | 通过 | 探针 `AC-5.1`：rejected、建会话 404、再 accept 409 `CONTACT_REQUEST_CONFLICT` |
| C-7 撤销后立即不能收发，旧历史与旧正文不可读 | AC-5 | 通过 | 探针 `AC-5.2`（双方发送/历史/单条均 404）、`AC-5.3`（撤销前已读，撤销后 404）、`AC-5.8`（附件 200→404）、`AC-5.4`（`SYNC_BLOCKED`） |
| C-8 撤销双方生效 | AC-5 | 通过 | 探针 `AC-5.6`：requester 撤销后发送 404 |
| C-9 撤销 pending 只有 requester 能取消 | AC-5 | 通过 | 探针 `AC-5.5`：target 409，requester 200 revoked |
| C-10 拒绝后可重新申请 | AC-4/AC-5 | 通过 | 探针 `AC-5.7`：复用同一 requestId、version=3；第三方列表为空 |
| C-11 非好友 HTTP 直发被服务端拒绝 | AC-6 | 通过 | 探针 `AC-6.4`：同 conversationId 撤销前 201、撤销后 404 |
| C-12 MCP `im_v1_send` 同样被强制 | AC-6 | 通过 | 探针 `AC-6.1`（好友 200 messageId）、`AC-6.3`（撤销后 RESOURCE_NOT_FOUND）、`AC-6.2`（20 个工具） |
| C-13 legacy 与管理员直授 | AC-4/P2 回滚列 | 通过 | 探针 `legacy policy`：503/503，管理员 set-contact 后建会话成功 |

补充判据（同一批探针）：无 Bearer 401；自请求/非 UUID/多余字段/direction 非法/limit=101 均 400；未知 peer 404；分页跨作用域游标 400；审计 13 行不含凭据与显示名；v3 库 + `contacts.requests='enabled'` 时 `createImCenter` 抛 `POLICY_NOT_CONFIGURED`（fail closed）。

### 界面状态表（固定 8 项）

| 项 | 用例 | PRD 是否写了 | 实测结果 | 证据 | 结论 |
|---|---|---|---|---|---|
| X-1 空态 | X-1 | 未覆盖 | 通过：无联系人/无申请返回空列表 | 探针 `AC-4.1`，`/private/tmp/.../p2-independent-probe.log` | 通过 |
| X-2 加载 | X-2 | 未覆盖 | 不适用：无界面、单次短请求 | — | 不适用 |
| X-3 失败 | X-3 | 写了固定错误码 | 通过：400/404/409/503 与固定 `{code,message,retryable}` | 探针 `state machine`、`AC-5.1/5.2` | 通过 |
| X-4 权限不足 | X-4 | 未覆盖（下限） | 通过：无 Bearer 401；非参与者 404；非好友发送 404 | 探针 `security`、`AC-4.4`、`AC-6.4` | 通过 |
| X-5 极端值 | X-5 | 未覆盖（下限） | 通过：自身/非 UUID/多余字段/direction/limit/未知 peer | 探针 `state machine`、`pagination` | 通过 |
| X-6 窄屏 | X-6 | 未覆盖 | 不适用：无界面 | — | 不适用 |
| X-7 键盘 | X-7 | 未覆盖 | 不适用：无界面 | — | 不适用 |
| X-8 文案一致性 | X-8 | 未覆盖 | 通过：`CONTACT_REQUEST_CONFLICT` 在 contracts/client/mcp/文档一致 | `src/im/contracts.js:17`、`docs/im-api-contract.md`、`docs/im-http-contract.md` | 通过 |

## 三、回归与基线对照

| 运行 | 命令 | tests | pass | fail | skipped | 退出 |
|---|---|---|---|---|---|---|
| P2 相关 12 套件 | `node --test tests/im-contacts.test.js tests/im-http.test.js tests/im-messages.test.js tests/im-core-integration.test.js tests/im-client.test.js tests/im-mcp-adapter.test.js tests/im-mcp-stdio.test.js tests/im-config.test.js tests/im-contracts.test.js tests/im-server.test.js tests/im-events.test.js tests/im-enrollment.test.js` | 85 | 85 | 0 | 0 | 0 |
| 跨框架进程 | `node --test tests/im-clean-crossframework-process.test.js` | 7 | 7 | 0 | 0 | 0 |
| P2 全量 | `npm test`（HEAD `2e28865`） | 2789 | 2583 | 144 | 62 | 1 |
| 基线全量 | `npm test`（`532b2d1`） | 2777 | 2571 | 144 | 62 | 1 |

结论：P2 新增 12 条用例全部通过；失败数 144 与同机基线相同，失败集合逐条 diff 完全一致（`diff` 无输出），集中在未改动文件（macOS 无 `127.0.0.2/3` 别名的 `EADDRNOTAVAIL`、v2 实验线既有抖动等）。未删测试、未放宽断言；仅两处工具数 16 → 20 的精确计数联动。

## 四、合入状态核实

- **提交号**：`2e2886542f3f40c432d50f0e49ceae8d6ef148ee`（P2 分支 HEAD；范围 `53e6ef0`…`2e28865` 共 9 个提交）
- **合入状态**：`branch-only`
- **分支名**：`goudaren0528/11-08-t100041-claude`
- **核实依据/目标 ref**：
  - `git rev-parse goudaren0528/11-08-t100041-claude` → `2e2886542f3f40c432d50f0e49ceae8d6ef148ee`
  - `git branch -a --contains 2e28865` → 仅 `goudaren0528/11-08-t100041-claude`
  - `git merge-base --is-ancestor 2e28865 origin/feat/a2a-no-install` → 退出码 1；`origin/master` → 1；`main` → 1
  - `git rev-parse feat/a2a-no-install origin/feat/a2a-no-install` → 均为 `532b2d1…`；`origin/master` → `b23dd26…`；`main` → `407254e…`
  - 证据：`evidence/p2-merge-state.log`
- **本验收交付提交**：分支 `goudaren0528/11-08-t100045-claude` HEAD（`git log -1 --format=%H -- docs/delivery/2026-11-05-nana-cross-device-messaging/` 可唯一解析），只含 `cases.md`、`prd-gaps.md`、`reviews/P2-friends-r1.md`、`acceptance/report-p2-friends-r1.md`；`branch-only`，未入 `feat/a2a-no-install` / `main`
- **后续工作/责任归属**：本验收会话无业务后续；合并到 `feat/a2a-no-install`、T3 中心策略切换（`contacts.requests='enabled'`）与 P6 真实两设备由跟进 Agent / 本人决定。

## 五、未验证项

以下**不算通过**，如实列出：

1. **真实两设备 / VPS 中心（执行方案 P6）**：需本人在另一台设备与 VPS 操作，本轮未做；AC-4/AC-5/AC-6 只在 loopback 合成中心验证。
2. **真实 MCP stdio 宿主逐个调用 4 个好友工具**：`tests/im-mcp-stdio.test.js` 只验证 20 个工具可列出与 `im_v1_me`/`im_v1_send` 等既有工具；好友工具的服务端强制已用「真实中心 + 真实适配器 + loopback https」验证（探针 `AC-6.1/6.3`），但未在 `scripts/im-mcp.mjs` 的 stdio 传输下逐个调用。stdio 入口属 P3（AC-7/AC-8），不计入 P2 失败。
3. **SSE 实时提示在撤销后的表现**：SSE 只是无正文的提示，`sync` 已被 `SYNC_BLOCKED` 阻断；本轮未单独演练撤销瞬间的提示时序。
4. **附件经 MCP `im_v1_attachment` 下载在撤销后的表现**：HTTP `/attachments/:id` 已验证撤销后 404（探针 `AC-5.8`），MCP 下载走同一 ACL，但未单独跑 MCP 下载分支。
5. **重启后的状态机/撤销持久性**：本轮所有场景在同一进程内完成；持久化由 SQLite 事务保证，未做「撤销后重启、再读取」的进程级复测（核心集成测试已覆盖文件库场景）。

## 六、机制问题（nanazi）

1. **角色说明假设存在 PRD，但本任务没有 PRD**（重复 P1 报告）：现象：accept 角色要求「以 PRD 为唯一基准」，实际权威只有 `plans/exec/2026-11-08-a2a-no-install.md`，`docs/prd/` 无对应文件。触发条件：执行方案型任务复用 PRD 型角色说明。影响：验收需自行确认基准。复现：`ls docs/prd/` 与 handoff 目录。初步归因：模板 / 角色说明。建议修法：任务说明按「PRD / 执行方案」明确权威文件，或缺 PRD 时写「以执行方案为准」。
2. **测试说明引用了本仓库不存在的 `tests/_isolation.py`**（重复 P1 报告）：现象：要求「跑测试必须带 `NANAZI_NO_SEND=1`（测试公共入口 `tests/_isolation.py` 已默认带上）」，a2a-msg 无该文件、全仓无 `NANAZI_NO_SEND` 读取点。触发条件：跨项目派发复用 nanazi 仓的测试约定。影响：容易误以为开关已生效。复现：`ls tests/_isolation.py`、`rg NANAZI_NO_SEND`。初步归因：模板 / 文档。建议修法：模板按项目区分测试入口，或注明「本项目无此入口，仅设置环境变量」。
3. **P1 验收的 `cases.md`/`prd-gaps.md` 没有随 P1 报告合入 `feat/a2a-no-install`**：现象：`532b2d1` 只带 `report-p1-enrollment-r1.md`，`cases.md` 与 `prd-gaps.md` 仍在 `goudaren0528/11-08-t100042-claude` 分支；本包验收只能另建 P2 用例与 PRD 缺项清单。触发条件：验收报告先合、用例后合或未合。影响：同一需求出现两份 `cases.md` / `prd-gaps.md`，后续合并易冲突，跨包缺项清单不连续。复现：`git log --all -- docs/delivery/2026-11-05-nana-cross-device-messaging/cases.md`。初步归因：机制（验收产物提交范围/合并顺序）。建议修法：验收产物随验收报告一起合入需求分支，或在派发时明确由谁把 `cases.md`/`prd-gaps.md` 收口到需求分支。

## 七、PRD 缺项

只记录，不要求本包修、不计入通过 / 失败、不改变 verdict（详见 `prd-gaps.md`）：

- **G-P2-1**：撤销后重新加好友，旧历史是否应重新可见——实测重新 accepted 后旧正文/附件恢复可读。
- **G-P2-2**：管理员 `set-contact` 与申请状态的优先级——实测管理员直授优先，reject 不解除直授。
- **G-P2-3**：reject/revoke 后复用同一 `requestId` 还是新建——实测复用并递增 `version`。
- **G-P2-4**：pending 的 target 能否 revoke——实测只有 requester 能取消，target 返回 409。

## 八、体验准备

**没有界面，不需要体验环境**（交付物是 HTTP + MCP 接口，无页面）。

## 九、证据清单（本地，不提交）

`docs/delivery/2026-11-05-nana-cross-device-messaging/evidence/`

- `p2-core-tests.log`（85/85）
- `p2-crossframework-process.log`（7/7）
- `p2-full-suite.log`（2789 / 2583 pass / 144 fail / 62 skipped）
- `baseline-532b2d1-full-suite.log`（2777 / 2571 / 144 / 62）
- `p2-independent-probe.log`、`p2-independent-probe.mjs`（独立探针，27/27；复跑：把 `p2-independent-probe.mjs` 放在 P2 代码树根目录，`TMPDIR=/private/tmp NANAZI_NO_SEND=1 node p2-independent-probe.mjs`）
- `p2-prev4-fail-closed.log`（v3 库 + enabled 策略的 fail-closed 行为）
- `p2-merge-state.log`
- 审查报告：`reviews/P2-friends-r1.md`；PRD 缺项：`prd-gaps.md`
