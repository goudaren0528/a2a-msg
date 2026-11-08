---
type: acceptance-report
slug: 2026-11-05-nana-cross-device-messaging-P5-r1
status: done
updated: 2026-11-08
verdict: 通过
summary: "P5 附件与下载目录独立验收：AC-10 / AC-11 的 12 条用例全部通过；独立探针 23/23；全量失败集合与基线相比无新增；0 条范围内要修"
---

# 验收报告：P5 附件与下载目录（AC-10 / AC-11）第 1 轮

**结论**：通过。AC-10 / AC-11 范围内 12 条用例全部通过，**0 条范围内要修**；独立探针 23/23 通过；全量回归失败集合与基线逐条比对，本分支没有新增失败。本 verdict 只覆盖 AC-10 / AC-11 的本地范围；范围外的真实两设备（P6 / AC-12）与 npx 形态（P4）列在「未验证项」，**不算通过**。

**独立性打折**：本次派发 `exec:claude`，被审的开发会话（T100043）也是 `exec:claude`；Codex 本机不可用，验收与开发同在 Claude，**独立性打折：验收与开发同在 Claude**。本报告不以开发自述为证据，所有判据来自本轮实际执行的测试、独立探针与代码核对。

**被测**：仓库 `goudaren0528/a2a-msg`，分支 `goudaren0528/11-08-t100043-claude`，HEAD `506e50133dc2e8cbb3440080dcbbb83ca9c58536`，基线 `feat/a2a-no-install` 的 `8213213df5da85b9ab793ce75d261cafe09e13b3`；实现主提交 `83a554222b1ba121786802c525ec02451a05ca2d`（派发说明中的 `83a5542`），自基线起共 8 个提交（与派发说明一致）。
**基准**：`plans/exec/2026-11-08-a2a-no-install.md` 的 AC-10 / AC-11（本需求没有 `prd.md`，以执行方案为唯一基准）。

```
VERDICT: PASS passed=12 failed=0 blocked=0 total=12 (P5 local scope; P6/npx listed as unverified)
```

## 一、执行环境

- 工作目录：`/Users/hongweitian/orca/workspaces/a2a-msg/11-08-t100046-claude`；测试时在该 worktree 内 `git switch --detach goudaren0528/11-08-t100043-claude`（不切换别的 worktree、不改分支），跑完切回验收分支提交本报告。
- Node 24.22.2 / npm 11.19.1；`npm ci` 95 包（未改 `package.json` / lock）。
- 测试命令统一带 `TMPDIR=/private/tmp NANAZI_NO_SEND=1`（macOS `tmpdir()` 是 `/var` 符号链接，落盘目录校验要求 realpath 一致；不设 `TMPDIR` 会让既有附件用例误报，与本包改动无关）。
- 被测服务：真实 `https` 监听 `localhost:0`（仓库测试证书，仅 loopback）；SQLite 为 `:memory:` 或 `mkdtemp` 临时目录；两个真实 `@modelcontextprotocol/sdk` `StdioClientTransport` 子进程拉起 `scripts/im-mcp.mjs`。
- 未连真实中心、未读 `private/`、未推送/合并/改业务代码；测试数据全部为合成身份。

## 二、用例结果

用例直接从执行方案 AC-10 / AC-11 派生（本轮是已实现包的独立验收，未另建 `cases.md`，避免与 P2 验收分支上尚未合入的 `cases.md` 冲突）。

| 用例 | AC | 结果 | 一手证据 |
|---|---|---|---|
| C-1 发送端读本地文件（绝对路径、普通文件、非符号链接）并映射到既有 `im_v1_send` | AC-10 | 通过 | 探针 10 MiB 发送；`tests/im-mcp-local-files.test.js` 第 1、6 条 |
| C-2 大小边界：正好 10 MiB 成功，10 MiB+1 字节拒绝 | AC-10 | 通过 | 探针「exactly 10 MiB」两条 + `PAYLOAD_TOO_LARGE`；实测 `size=10485760`，`10485761` 报 `PAYLOAD_TOO_LARGE` 且中心消息数不变 |
| C-3 接收落盘，SHA-256 与大小和发送端一致，字节逐字节相等 | AC-10 | 通过 | 探针 10 MiB / 1 KiB 两条；测试第 1 条 |
| C-4 默认目录为 `~/Downloads/a2a-msg/<center-host>[_<port>]`，不落 npx 缓存，启动按需创建 0700 | AC-10 | 通过 | 探针隔离 `HOME` 实测路径 `.../Downloads/a2a-msg/localhost_<port>`，mode `0700`，路径不含 `npx`/`_cacache`/`node_modules`/`.npm` |
| C-5 `--download-dir` 覆盖 `nana.json` 的 `attachmentDirectory` | AC-10 | 通过 | 探针：文件落 `override/`，`configured/` 保持为空；测试第 3 条 |
| C-6 显式目录不存在时启动 fail closed | AC-11 | 通过 | 探针：退出码 1、stdout 空、stderr `{"error":{"code":"INVALID_REQUEST"}}`；测试第 4 条 |
| C-7 运行中目录被删：`im_v1_sync` 返回固定 `INVALID_ATTACHMENT`，`deliveredAt` 仍为 `null`，不 ACK、不标已收 | AC-11 | 通过 | 探针两条；测试第 4 条 |
| C-8 目录不可写（`chmod 0500`）：同上，且不留下文件 | AC-11 | 通过 | 探针两条（以 uid 501 运行，未跳过）；测试第 4 条 |
| C-9 附件字节损坏：固定 `STORAGE_UNAVAILABLE`，不 ACK、不标已收、无残留文件 | AC-11 | 通过 | 探针三条（篡改中心 `im_attachments.data`）；测试第 5 条 |
| C-10 失败恢复后重试只交付一次；再 `sync` 返回 0 条；中心消息数不增 | AC-11 | 通过 | 探针「retry ... exactly once」各两条 + 「further sync returns nothing new」 |
| C-11 幂等：同 `clientMessageId` + 同字节返回同一 `messageId`；同 key 不同字节 `IDEMPOTENCY_CONFLICT` | AC-10 / AC-11 | 通过 | 探针两条；测试第 1 条 |
| C-12 源文件错误族：相对路径 `INVALID_REQUEST`；缺失/目录/符号链接/空文件/非法名 `INVALID_ATTACHMENT`；超限 `PAYLOAD_TOO_LARGE` | AC-10 / AC-11 | 通过 | `tests/im-mcp-local-files.test.js` 第 6 条（本轮实跑 6/6） |

**独立探针**：本轮自写 `evidence/p5-independent-probe.mjs`（不提交），用真实 loopback HTTPS 中心 + 真实 stdio 子进程重跑上述判据，**23/23 PASS**（`evidence/p5-independent-probe.log`）。探针不复用开发测试的断言，重点补了开发用例没有覆盖的**正好 10 MiB** 边界与发送结果不回显 base64 两项。

代码核对（一手）：`src/im/mcp-local-files.js:44-78` 本地读取用 `lstat` + `O_NOFOLLOW`、读取前后比对 `dev/ino/size/mtime` 并自行算 SHA-256；`src/nana/config.js:36-45` 默认目录取 `homedir()/Downloads/a2a-msg/<host>[_<port>]`；`src/im/mcp-stdio.js:102-116` 显式目录 `requireDirectory`、默认目录按需 `mkdir 0700`；接收落盘与 SHA-256/大小校验走既有的 `src/im/client-files.js:74-103`，未改。

## 三、回归与基线对照

| 运行 | 命令 | tests | pass | fail | skipped | 退出 |
|---|---|---|---|---|---|---|
| P5 新增用例 | `node --test tests/im-mcp-local-files.test.js` | 6 | 6 | 0 | 0 | 0 |
| P5 相关 8 套件 | `node --test tests/im-mcp-stdio.test.js tests/im-mcp-adapter.test.js tests/im-nana-session.test.js tests/im-nana-roundtrip.test.js tests/im-client.test.js tests/im-contracts.test.js tests/im-config.test.js tests/im-mcp-local-files.test.js` | 36 | 36 | 0 | 0 | 0 |
| P5 全量 | `npm test`（HEAD `506e501`） | 2795 | 2591 | 142 | 62 | 1 |
| 基线全量 | `npm test`（`8213213`，`git archive` 解到 `/private/tmp/p5-baseline-accept`，复用同一 `node_modules`） | 2789 | 2583 | 144 | 62 | 1 |

失败集合逐条比对（`evidence/p5-full-suite.log`、`evidence/p5-baseline-full-suite.log`）：

- **本分支没有基线之外的失败**：`comm -23`（只在 P5 分支失败）无输出。
- 基线多出的 2 个失败是 `F1: public exports exact...`（`tests/attachment-save.test.js`）与 `module-root downloads is lazy...`，原因是对照目录由 `git archive` 解出、没有 `.git`，用例里的 `git show` 报 `fatal: not a git repository`；属对照环境差异，不是本包改动。
- 142 个既有失败与基线同量同集合，集中在 `127.0.0.2/3` 的 `EADDRNOTAVAIL`、v2 实验线等未改动文件；未删测试、未放宽业务断言（`tests/im-mcp-stdio.test.js` 仅工具数 20 → 21 的预期产品变更）。

## 四、合入状态核实

- **提交号**：`506e50133dc2e8cbb3440080dcbbb83ca9c58536`（P5 分支 HEAD；范围 `8213213..506e501`，8 个提交；实现 `83a554222b1ba121786802c525ec02451a05ca2d`）
- **合入状态**：`branch-only`
- **分支名**：`goudaren0528/11-08-t100043-claude`
- **核实依据/目标 ref**（`evidence/p5-merge-state.log`）：
  - `git rev-parse goudaren0528/11-08-t100043-claude` → `506e50133dc2e8cbb3440080dcbbb83ca9c58536`
  - `git branch -a --contains goudaren0528/11-08-t100043-claude` → 仅该分支
  - `git merge-base --is-ancestor <P5 HEAD> origin/feat/a2a-no-install` → 1；`origin/main` → 1；`origin/master` → 1；`main` → 1（均未包含）
  - `feat/a2a-no-install` / `origin/feat/a2a-no-install` → `8213213df5da85b9ab793ce75d261cafe09e13b3`；`origin/main` / `main` → `407254e84401cf62d3a3d3ab4d95a0517eb373b1`；`origin/master` → `b23dd2681f4f5dcf49717bee6e463c8d3611bb6e`
- **本验收交付提交**：分支 `goudaren0528/11-08-t100046-claude` 上包含本报告的提交（`git log -1 --format=%H -- docs/delivery/2026-11-05-nana-cross-device-messaging/acceptance/report-p5-r1.md` 唯一解析）；`branch-only`，未入 `feat/a2a-no-install` / `main`。
- **后续工作/责任归属**：本验收会话无业务后续；合并到 `feat/a2a-no-install`、P4 npx bin 转发 `--download-dir`、P6 真实两设备验收由跟进 Agent / 本人决定。

## 五、未验证项

以下**不算通过**，逐项列出：

1. **真实两设备 / VPS 中心（AC-12 / P6）**：本轮全部在 loopback 合成中心验证，未在两台真实设备、未在 VPS 中心跑「发附件 → 对端落盘 → 双向 SHA-256 对照」；不能据此宣称跨设备链路已验收。
2. **npx 形态（P4）**：`bin/a2a-msg.mjs` 在本分支不存在（属 P4），`--download-dir` 只在现有 `scripts/im-mcp.mjs` 上验证；npx bin 是否转发同一参数未验证。默认目录本身不依赖入口，已在入口层验证。
3. **平台**：只在 macOS（Darwin 25.6.0，uid 501）验证；Windows 的 `O_NOFOLLOW`、不可写目录语义、路径分隔未验证。
4. **真实 MCP 宿主**：用真实 MCP SDK `StdioClientTransport` 拉起子进程（与宿主行为等价），但未在 Claude Desktop / 其他实际宿主里从工具列表点到 `im_v1_send_file`。
5. **越界改动的“已获跟进确认”**：`scripts/im-mcp.mjs`、`tests/im-mcp-stdio.test.js`、`docs/im-nana-adapter.md` 不在 P5 计划归属，开发自述“已获跟进确认”；本轮未见到确认记录，只按行为验收，不影响 AC-10/AC-11 判定。

### 界面状态表（固定 8 项）

| 项 | 用例 | 基准是否写了 | 实测结果 | 证据 | 结论 |
|---|---|---|---|---|---|
| X-1…X-8 | X-1…X-8 | 未覆盖 | 不适用：交付物是 stdio 工具 + 落盘行为，没有页面、没有可点的界面 | — | 不适用 |

## 六、范围外观察（只记录，不要求本包修）

- **O-1 显式目录与默认目录同值时的行为**：`src/im/mcp-stdio.js:109-113` 用 `directory === defaultAttachmentDirectory(config.serverUrl)` 判断是否按需创建；`parseNanaConfig` 已把缺省值填成同一个字符串（`src/nana/config.js:52`），因此用户**显式**写 `attachmentDirectory: ~/Downloads/a2a-msg/<center-host>` 且目录不存在时，会被自动创建，而不是像文档说的“显式目录必须已存在”。影响低（目录 0700、无数据丢失），但 `docs/im-mcp-adapter.md` 的“explicitly configured directory is never created”在该边界上不准确。建议保留“是否显式提供”的来源信息，或在文档写明该例外。
- **O-2 跨包文件归属**：P5 计划把 `bin/a2a-msg.mjs`（P4 新建，基线不存在）列进本包，却没列实际必须改的 `scripts/im-mcp.mjs`；开发做了归属外最小改动并在 `packages/P5.md` 说明。建议计划把共享入口单列或注明替代关系。
- **O-3 下载目录的可配置面**：本轮只验证 `~` 下的默认目录与命令行覆盖，未支持 `XDG_DOWNLOAD_DIR` 等平台约定（执行方案也没要求）。按现状记录，不算缺陷。

## 七、机制问题（nanazi）

1. **再次引用本仓库不存在的 `tests/_isolation.py`**（P1 / P2 / P3 报告已重复）：现象：任务说明写“测试公共入口 `tests/_isolation.py` 已默认带上 `NANAZI_NO_SEND=1`”，a2a-msg 仓库无此文件。触发条件：跨项目派发复用 nanazi 仓的测试约定。影响：执行方容易误以为开关已生效。复现：`ls tests/_isolation.py` 无结果。初步归因：模板 / 文档。建议修法：按项目注入测试入口，或写明“本项目无此入口，仅设置环境变量”。
2. **角色说明假设存在 PRD，但本需求只有执行方案**（P1 / P2 已报）：现象：accept 角色以“PRD 为唯一基准”，实际权威是 `plans/exec/2026-11-08-a2a-no-install.md`，`docs/prd/` 无对应文件。触发条件：执行方案型任务复用 PRD 型角色说明。影响：验收需自行确认基准。初步归因：模板 / 角色说明。建议修法：派发时明确“PRD / 执行方案”及路径。
3. **P5 计划文件归属与基线不一致**（与开发 `P5.md` 的机制问题同一件，验收侧复核为真）：`bin/a2a-msg.mjs` 由 P4 新建，P5 却列为归属；`--download-dir` 又必须落在 P3 的 `scripts/im-mcp.mjs`。现象：开发只能越界改或停工等确认。触发条件：并行包共享入口且新文件归属重叠。复现：`git show 8213213:bin/a2a-msg.mjs` 无此文件。初步归因：计划。建议修法：共享入口拆 P0 契约包，或在 P5 行写明基线不存在时改哪个入口。

## 八、PRD / 执行方案缺项

只记录，不要求本包修、不计入通过 / 失败、不改变 verdict：

- **G-P5-1**：AC-11 只说“返回固定错误码”，没有逐一钉死各失败模式的码；实现为启动期 `INVALID_REQUEST`、运行期目录问题 `INVALID_ATTACHMENT`、中心字节损坏 `STORAGE_UNAVAILABLE`。本轮按“固定且可区分”判通过，但执行方案未写死映射。
- **G-P5-2**：AC-10 没写默认目录在 Windows / 非 `~/Downloads` 习惯下怎么取，也没写“显式配置与默认值同值”时是否算显式；实现取 `homedir()/Downloads` 且把同值视为默认（见 O-1）。

## 九、体验准备

**没有界面，不需要体验环境**（交付物是 MCP stdio 工具与落盘行为，无页面）。

## 十、证据清单（本地，不提交；`.git/info/exclude` 的 `docs/delivery/*/evidence/` 已核实生效）

- `docs/delivery/2026-11-05-nana-cross-device-messaging/evidence/p5-independent-probe.mjs` — 本轮独立探针（23 条检查）
- `docs/delivery/2026-11-05-nana-cross-device-messaging/evidence/p5-independent-probe.log` — `PROBE PASS 23`
- `docs/delivery/2026-11-05-nana-cross-device-messaging/evidence/p5-new-tests.log` — 6/6
- `docs/delivery/2026-11-05-nana-cross-device-messaging/evidence/p5-related-tests.log` — 36/36
- `docs/delivery/2026-11-05-nana-cross-device-messaging/evidence/p5-full-suite.log` — 全量 2795 / 2591 / 142 / 62
- `docs/delivery/2026-11-05-nana-cross-device-messaging/evidence/p5-baseline-full-suite.log` — 基线全量 2789 / 2583 / 144 / 62
- `docs/delivery/2026-11-05-nana-cross-device-messaging/evidence/p5-merge-state.log` — 合入状态命令与结果
- `docs/delivery/2026-11-05-nana-cross-device-messaging/evidence/p5-commit-inventory.log` — 8 个提交与改动文件清单
