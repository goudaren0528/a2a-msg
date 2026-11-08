---
type: acceptance-report
slug: 2026-11-05-nana-cross-device-messaging-P4-r1
status: done
updated: 2026-11-08
verdict: 通过
summary: "P4 npx 轻量接入独立验收：AC-9 全部 6 项实测通过；打包清单、Node<24 版本门、空目录 npx（tarball 与 git ref）、不发布 npm、旧入口不变均有真实命令证据；全量失败集合与基线逐条相同，0 条范围内要修"
---

# 验收报告：P4 npx 轻量接入（AC-9）第 1 轮

**结论**：通过。AC-9 在本包可执行的 6 项全部实测通过，**0 条范围内要修**；全量回归失败集合与基线 `d501c77` 逐条相同，唯一新增的 7 个用例全部通过。本 verdict 只覆盖 AC-9 的 npx 分发层；远端 `npx github:...#<SHA>`、Windows、真实 MCP 宿主与真实中心注册列在「未验证项」，**不算通过**。

**独立性打折**：本次派发 `exec:claude`，被审的开发会话（T100047）也是 `exec:claude`；验收与开发同在 Claude，按要求写明 **独立性打折：验收与开发同在 Claude**。本报告不以开发自述为证据，所有判据来自本轮实际执行的命令、测试与代码核对。

**被测**：仓库 `goudaren0528/a2a-msg`，分支 `goudaren0528/11-08-t100047-claude`，HEAD `350591b05987f9fdd340d3ded400a5f8ef493241`（与派发说明的 `350591b` 一致）；基线 `feat/a2a-no-install` 的 `d501c77960eee2d7403dbcef6c63d24f38732be3`；自基线起 6 个提交（`c436b36..350591b`），实现主提交 `98ef303`，打包排除证据修正 `bc0d55d`。
**基准**：`plans/exec/2026-11-08-a2a-no-install.md` 的 AC-9（本需求没有对应 `prd.md`，以执行方案为唯一基准）。验收用例直接由 AC-9 派生（与 P5 验收同一做法，未另建 `cases.md`）。

```
VERDICT: PASS passed=6 failed=0 blocked=0 total=6 (AC-9 local scope)
```

## 一、执行环境与隔离

- 验收工作区：`/Users/hongweitian/orca/workspaces/a2a-msg/11-08-t100049-claude`（分支 `goudaren0528/11-08-t100049-claude`，基于 `d501c77`）。**未切换分支**：用 `git archive 350591b` 把被审代码解到 `/private/tmp/p4-accept-20261108/src`，另用 `git clone --shared` 到 `/private/tmp/p4-accept-20261108/gitcheck` 做需要真实 `.git` 的复核。
- Node 24.22.2 / npm 11.19.1（`/Users/hongweitian/.local/node24`）；Node 22.23.4（`/Users/hongweitian/.local/node`）用于版本门。
- 测试统一带 `NANAZI_NO_SEND=1 TMPDIR=/private/tmp`；未连真实中心、未读 `private/`、未推送/合并/发布、未改业务代码。
- 证据目录：`docs/delivery/2026-11-05-nana-cross-device-messaging/evidence/`（本地、已由 `.git/info/exclude` 排除，未入库）。

## 二、AC-9 用例结果

| 用例 | AC-9 子项 | 结果 | 一手证据 |
|---|---|---|---|
| C-1 干净临时目录用**本地 tarball** 跑 `mcp --help` / `register --help` | 干净目录 npx 可运行，不需要 clone/npm ci | 通过 | 空目录 `/private/tmp/p4-accept-20261108/empty` 执行 `npx --yes --package=<tgz> a2a-msg mcp --help`、`register --help`、`--help`，三者均退出 0、打印各自 Usage；执行后目录内文件数 0（`evidence/p4-npx-tarball.log`） |
| C-2 干净临时目录用**固定 git ref** 跑同样命令 | 同上（tarball 或 git ref） | 通过 | 空目录执行 `npx --yes git+file://<worktree>#350591b mcp --help`、`register --help`，均退出 0；目录文件数 0（`evidence/p4-npx-git-ref.log`） |
| C-3 解包后的 tarball 无 `node_modules` 也能自检入口 | 不需要 clone/npm ci | 通过 | `tests/package.test.js` 第 7 条实际 `npm pack` → `tar` 解包 → 直接跑三个 `--help`，7/7 通过（`evidence/p4-package-tests.log`） |
| C-4 Node < 24 固定报错 | Node <24 明确报错 | 通过 | Node 22.23.4 直接跑 bin 与通过 npx 跑 `mcp --help`/`register --help`/`--help`/未知子命令，全部退出 1，stderr 固定 `{"error":{"code":"NODE_VERSION_UNSUPPORTED",...}}`，版本检查先于参数解析（`evidence/p4-node22-gate.log`、`evidence/p4-node22-npx.log`） |
| C-5 `npm pack --dry-run` 含 `bin/`、`src/`、`scripts/` | 打包清单 | 通过 | 213 个文件、913044 B；`bin/` 1/1、`src/` 99/99、`scripts/` 11/11 全部在包内；我另放了 `docs/delivery/probe/evidence/*.log` 与 `shots/*.png` 探针，包内 0 条命中（`evidence/p4-pack-dry-run.json`、`evidence/p4-pack-analysis.txt`） |
| C-6 不发布 npm、不改旧入口 | 派发补充验收项 | 通过 | `private:true`、无 `publishConfig`/`NPM_TOKEN`/`NODE_AUTH_TOKEN` 引用；公共 registry `npm view team-mailbox version` 返回 404（不存在该包）；`bin` 在 tarball 内为 `-rwxr-xr-x`；`git diff d501c77 350591b -- src/mcp.js scripts/im-mcp.mjs scripts/im-register.mjs src/im/mcp-stdio.js` 为空；旧入口冒烟 `node scripts/im-mcp.mjs` → `INVALID_REQUEST`、`node scripts/im-register.mjs` → `INVALID_ARGUMENTS`（`evidence/p4-publish-gate.log`、`evidence/p4-pack-meta.log`、`evidence/p4-old-entries.log`） |

补充代码核对（一手）：`bin/a2a-msg.mjs:1-9` 只导入 `node:child_process`/`node:fs`/`node:url`；`main()` 在任何子命令前调用 `nodeVersionError()`（`bin/a2a-msg.mjs:104-110`）；`mcp`/`register` 的 `--help` 在 `runScript` 之前直接返回（`bin/a2a-msg.mjs:118-125`），因此帮助路径不加载 `scripts/`、也不需要 `node_modules`；`runScript` 用 `spawn(process.execPath, ...)` + `stdio:'inherit'` 并转发 `SIGINT`/`SIGTERM`、透传退出码（`bin/a2a-msg.mjs:80-100`），没有复制业务逻辑。

## 三、回归与基线对照

| 运行 | 命令 | tests | pass | fail | skipped | 退出 |
|---|---|---|---|---|---|---|
| P4 新增用例 | `node --test tests/package.test.js` | 7 | 7 | 0 | 0 | 0 |
| P4 相关 8 套件 | `node --test tests/im-mcp-stdio.test.js tests/im-mcp-local-files.test.js tests/im-mcp-adapter.test.js tests/im-client.test.js tests/im-nana-session.test.js tests/im-nana-roundtrip.test.js tests/im-register.test.js tests/package.test.js` | 34 | 34 | 0 | 0 | 0 |
| P4 全量 | `npm test`（HEAD `350591b`） | 2802 | 2596 | 144 | 62 | 1 |
| 基线全量 | `npm test`（`d501c77`，`git archive` 解出、复用同一 `node_modules`） | 2795 | 2589 | 144 | 62 | 1 |

失败集合逐条比对（`evidence/p4-failures.txt`、`evidence/p4-baseline-failures.txt`）：

- P4 与基线各 289 条 `✖` 行，`comm -23` / `comm -13` 均为空：**没有任何新增失败**。
- 144 个失败与基线同量同集合，集中在 `tests/im-v2-*`、`tests/unread*` 等未改动文件；主因是本机 `127.0.0.2/3/4` loopback 别名不可用（`EADDRNOTAVAIL`）与 `git archive` 目录无 `.git` 导致 `git check-ignore` 报错，均为环境问题。
- 打包敏感套件 `tests/legacy-lan-compatibility.test.js tests/attachment-save.test.js` 在解包目录下 21/23 通过、1 跳过、1 失败；失败项是 `git check-ignore` 需要真实 `.git`（`fatal: not a git repository`）。我用 `git clone --shared` 到真实检出后单跑 `tests/attachment-save.test.js`：**17/17 通过**，确认是环境差异而非本包引入（`evidence/p4-pack-sensitive-tests.log`、`evidence/p4-attachment-save-gitcheckout.log`）。
- 未删测试、未放宽业务断言；P4 只新增 7 个用例。

## 四、合入状态核实

- **提交号**：`350591b05987f9fdd340d3ded400a5f8ef493241`（被审分支 HEAD；范围 `d501c77..350591b`，6 个提交）
- **合入状态**：`branch-only`
- **分支名**：`goudaren0528/11-08-t100047-claude`
- **核实依据/目标 ref**（`evidence/p4-merge-state.log`）：
  - `git rev-parse goudaren0528/11-08-t100047-claude` → `350591b05987f9fdd340d3ded400a5f8ef493241`
  - `git branch -a --contains goudaren0528/11-08-t100047-claude` → 仅 `+ goudaren0528/11-08-t100047-claude`（无远端分支）
  - `git merge-base --is-ancestor <P4 HEAD> <ref>` → `feat/a2a-no-install` 1、`origin/feat/a2a-no-install` 1、`main` 1、`master` 1、`origin/main` 1、`origin/master` 1（均未包含）
  - 目标 ref：`feat/a2a-no-install` / `origin/feat/a2a-no-install` → `d501c77960eee2d7403dbcef6c63d24f38732be3`；`main` / `origin/main` → `407254e84401cf62d3a3d3ab4d95a0517eb373b1`；`master` / `origin/master` → `b23dd2681f4f5dcf49717bee6e463c8d3611bb6e`
- **本验收交付提交**：分支 `goudaren0528/11-08-t100049-claude` 上包含本报告的提交（`git log -1 --format=%H -- docs/delivery/2026-11-05-nana-cross-device-messaging/acceptance/report-p4-r1.md` 唯一解析）；`branch-only`，未入 `feat/a2a-no-install` / `main` / `master`。
- **后续工作/责任归属**：本验收会话无业务后续；P4 分支如何合入 `feat/a2a-no-install`、是否先推送再补远端 `npx github:...#<SHA>` 验证，由跟进 Agent / weitian 决定。

## 五、未验证项

以下**不算通过**，逐项列出：

1. **远端 `npx github:goudaren0528/a2a-msg#<SHA>`**：P4 分支未推送，`350591b` 在 GitHub 上不可达；本轮用等价的 `git+file://<worktree>#350591b`（同一 npx/bin 选择机制）与本地 tarball 覆盖。推送后需补一条真实远端命令。
2. **Windows**：本轮只在 macOS（Darwin 25.6.0）验证；`bin` 可执行位、`spawn` 信号、路径分隔在 Windows 的语义未验证。
3. **Node 25+ / 非 24 的其它主版本**：只实测 Node 22 与 24；其它主版本仅由 `nodeVersionError()` 单测覆盖，未实机起 npx。
4. **真实 MCP 宿主与真实中心**：本轮只验证 `--help` 与入口转发；未在 Claude Desktop 等实际宿主里从工具列表调用 `im_v1_*`，也未用真实邀请码向中心 `register`（属 P6 / 真实两设备范围）。
5. **信号与退出码透传的完整路径**：实测了帮助/缺参/错误族的退出码，未对运行中的 `mcp` 子进程发送 `SIGTERM`/`SIGINT` 验证信号转发；AC-9 未要求，但开发自述的“信号透传”只做了代码核对。

## 六、范围外观察（只记录，不要求本包修）

- **O-1 文档“离线”措辞偏强**：`docs/install-npx.md` 把本地 tarball 一节标为「离线或审计场景」，同一文档前面又写首次运行需要网络下载依赖。实测 `npx --yes --offline --cache <空目录> --package=<tgz> a2a-msg mcp --help` 以 `ENOTCACHED` 退出 1：宿主机仍需 registry 或已填充的 npm 缓存提供生产依赖（`evidence/p4-pack-lock-and-offline.log`）。AC-9 未要求离线，建议把该节改成「不 clone、不手工 npm ci；首次仍需 registry 或缓存」，避免读者误解。
- **O-2 `files` 列出 `package-lock.json` 但 npm 实际不打包**：这是基线已有的条目（`d501c77` 即如此），P4 未改变；不影响 AC-9 的 `bin/src/scripts` 判定。

## 七、机制问题（nanazi）

1. **再次引用本仓库不存在的 `tests/_isolation.py`**（P1/P2/P3/P5 已重复）：任务说明写“测试公共入口 `tests/_isolation.py` 已默认带上 `NANAZI_NO_SEND=1`”，a2a-msg 仓库无此文件（`ls tests/_isolation.py` 无结果）。现象：执行方容易误以为开关已生效，需自行在每条命令前设环境变量。触发条件：跨项目派发复用 nanazi 仓的测试约定。影响范围：所有 a2a-msg 派发。初步归因：模板 / 文档。建议修法：按项目注入测试入口，或写明“本项目无此入口，仅设置环境变量”。
2. **AC-9 的 tarball 命令写法不可直接执行**（与开发 `P4.md` 机制问题 2 同一件，验收侧复核为真）：验收原文 `npx <tarball 或 git ref> mcp --help` 中的本地 tarball 形式会被 npx 当成可执行文件，实测 `npx --yes <tgz> mcp --help` → `sh: ... Permission denied`（退出 126）；正确形式是 `npx --yes --package=<tgz> a2a-msg mcp --help`。现象：照 AC 原文跑 tarball 分支会误判失败。触发条件：用本地 tarball 验收。影响范围：P4 及后续 npx/tarball 验收。初步归因：计划 / 验收文案未区分 npm 的「命令」与「package spec」。建议修法：AC 写全两种形式，或链接 `docs/install-npx.md`。
3. **角色说明假设存在 PRD，但本需求只有执行方案**（P1/P2/P5 已报）：`docs/prd/` 无该需求文件，权威是 `plans/exec/2026-11-08-a2a-no-install.md`。影响：验收需自行确认基准。建议派发时明确“PRD / 执行方案”及路径。

## 八、执行方案 / PRD 缺项

只记录，不要求本包修、不计入通过 / 失败、不改变 verdict：

- **G-P4-1**：AC-9 没有规定本地 tarball 与 Git ref 两种形式分别怎么写，也没规定 `--help` 是否必须在无 `node_modules` 时可用；本轮按“tarball + git ref 任一可运行”与“帮助路径无依赖”判通过，建议回填执行方案。
- **G-P4-2**：AC-9 未写 Node 主版本必须是 24（其余主版本一律拒绝）还是 `>=24`；实现按 `engines: >=24 <25` 固定 24，与执行方案「Node 版本按 `engines >=24 <25`」一致，但 AC 文本可更明确。

### 界面状态表（固定 8 项）

| 项 | 用例 | 基准是否写了 | 实测结果 | 证据 | 结论 |
|---|---|---|---|---|---|
| X-1…X-8 | X-1…X-8 | 未覆盖 | 不适用：交付物是 CLI / npx 分发层，没有页面、没有可点的界面 | — | 不适用 |

## 九、体验准备

**没有界面，不需要体验环境**（交付物是 npx/CLI 入口与打包清单，无页面）。
