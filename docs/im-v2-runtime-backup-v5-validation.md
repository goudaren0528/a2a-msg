# IM v2 NONRELEASE R1+C1 运行时与纯备份记录验证

**状态：限定范围已接受，非发布、非真实恢复/备份操作批准。**与 [实施计划](im-v2-implementation-plan.md)、[路线图](roadmap.md)及 [schema 5 兼容交接契约](im-v2-schema-v5-compatibility-contract.md)配套。本记录对应提交前的固定候选：基线 `f74b20de1e503e6cc00bf29be0b33d512eabc074` 加下列八份 overlay；后续文档状态修改和未来 clean commit **不是**本次执行输入。历史初始 fixture/oracle/setup 错误的原始证据保留，未覆写或追认其早期结果。

## 固定输入与边界

| overlay | 执行前 SHA-256 |
| --- | --- |
| `src/im/v2/clock.js` | `2dd41a30f216cce0a00a52b2d70ea48c6afed47f819d7eecab254476a4d65f1d` |
| `tests/im-v2-runtime-schema-dispatch.test.js` | `f20e566f7ade43ef311fa0e37a144152e5e9cee836f5c41c1dcf7e1a193c687e` |
| `tests/fixtures/im-v2-runtime-schema-dispatch/helpers.js` | `6fc7aa4c331a5164008d0f0a2b290dfda7e33cfdfdcdbd84c126e9a9a9f09714` |
| `src/im/v2/backup-v5-records.js` | `c51872d40a2fa03972c7a066418ffe8a5b7b4afc55bb731ef84c8a4e4956be51` |
| `tests/im-v2-backup-v5-records.test.js` | `edd278509c63495d785e4ef7fbb05e83f2349ffdce54c91369ca218cec89b8f7` |
| `tests/fixtures/im-v2-backup-v5-records/vectors.json` | `c29f42da70f0790214d4d92e8ca349a75a0cb2731ad52459eec1b8bbc41e11c2` |
| `docs/im-v2-schema-v5-compatibility-contract.md` | `53d9e576116d2bf08cdab0a4909062fbd6a0b3a56a0ff3a50b8390aff0720602` |
| `docs/im-v2-implementation-plan.md`（**测试前版本**） | `f2dc5134014f5c6ba1dc3485e7bf217718ca3efa4d8c5596fc39d2899ebbff93` |

实施计划仅在测试后修改当前 TODO，须单独记录提交后的新 hash；不能将新文档字节冒称执行输入。候选只有这八份 overlay，其余文件从指定 Git 基线取出；未复制离线 runner、HANDOFF、外部 oracle 或其他工作树文件。完整 tracked code/test/package 输入盘点及前后闭包见隔离证据，源码和两候选盘点前后相同。

R1 保持 clock factory API、v4 signature/schema DDL/checksum、旧 wire 与 journal 不变。在构造事务中运行完整 exact4/5 校验，并固定 cookie、已验证版本和 checksum，交叉核对 marker；之后热路径在 callback 或 clock 写入前拒绝漂移，不自动 rebind。v5 检查当前 epoch、head 与实际 chain tip；允许 history 无 head，也不将 epoch 永久固定。head/tip 检查是按索引的 B-tree 查找和**有界返回行数**，不是字面 O(1)，更不构成全历史防篡改。普通业务 clock 写入只触碰 `im_clock`，不修改 maintenance anchor/head/session。既有 auth 最终 refresh 的组合行为保留；任意 callback SQL **没有**被沙箱化。

C1 是纯格式：manifest 3（schema 5，tool `im-v2-backup-2`）、record 4（native-v5）、source 2（registry 4），精确规范字段序、raw canonical JSON SHA-256、时间标量语义及独立 literal vectors 已核；ordinary enumerable data、Proxy-before-reflection、严格 UTF-8、canonical decode、safe integer、`-0` 与 65536-byte 限额均受限定测试覆盖。旧 v4/native-v4 record 3/source 1 字节不变。**内容 hash 不证明来源**；没有 publisher/private registry 接入或可由此推导出的 provenance。新纯 codec 的传递模块加载可能包含 SQL 模块，但不会因此打开 DB。

## 隔离执行结果（计数有重叠，不可相加）

| 平台与组 | 实际结果 | 原始 stdout SHA-256 |
| --- | --- | --- |
| Windows Node 24.19.0 / SQLite 3.53.3，fresh isolated `npm ci --ignore-scripts --no-audit --no-fund` | exit 0；95 个依赖包；与 workspace 的 node_modules 隔离 | 安装日志由证据目录保存 |
| Windows 明确指定十项测试 | exit 0；533 tests / 533 pass / 0 skip / 0 fail | `62e4d8cd33f1a86293498d10faf9ee5c1adfd810c4331893430ef7f46b705f98` |
| Windows 默认 `npm test`（原命令、原并发） | exit 0；2397 total / 1595 pass / 802 skip / 0 fail | `69e805cc2f5aff2bdf0bd2dabe0bc6007365dcd1a730a701a26a99aa40703624` |
| Windows 五项显式绝对路径 OpenCode 插件测试 | exit 0；46 pass / 0 skip / 0 fail | `f9efac23c85f0263e1d19c69570e0f4f151628b9a22a33f8b33da29fa47d3f7d` |
| 原生 ext4 Node 24.19.0 / SQLite 3.53.3，相同十项测试 | native exit 0，独立 Windows 父进程 WSL exit 0；533 tests / 533 pass / 0 skip / 0 fail | `5532a01fbd4d99e253472a7ed53f2d89cdfe38c23c859670a8d27e5575263389` |

十项为 `im-v2-runtime-schema-dispatch`、`im-v2-backup-v5-records`、`im-v2-clock`、`im-v2-auth-acl`、`im-v2-messages`、`im-v2-delivery`、`im-v2-http`、`im-v2-schema`、`im-v2-schema-v5`、`im-v2-migration`（均为 `tests/*.test.js`）。插件项为 `plugin-entry`、`sidebar-setup`、`unread-core`、`unread-detail`、`unread-events`（均为 `integrations/opencode/*.test.mjs`）。原生十项使用 `--unhandled-rejections=throw --test --test-concurrency=1 --test-reporter=tap`。原生隔离目录和 TMP 从一开始为私有 0700，euid 0，记录到的初始 umask 为 022、测试运行前设置为 **077**；根目录的既有模式未改。原生 95 个已装依赖版本以相同 lock 核验后**复用**，不是 fresh install。未运行 Linux 全仓库套件；Windows 802 skip 不等于原生保护 PASS。

隔离证据标签：Windows `r1c1-compat-4fjx44j_`，原生 `r1c1-native-lz66bw49`。证据包含启动 argv、cwd、runtime、输入/输出盘点、原始 stdout/stderr 和退出码；未将原始日志、环境或测试数据提交到仓库。审查接受仅覆盖上述 R1/C1 代码、安全、契约忠实度及独立 QA；不可将重叠测试数合计为独立断言数。

## 下一门禁，非本包交付

- **B2 NEXT：**真实 native4/5 full snapshot、精确版本检验、version-aware publisher/private registry 和真实 source proof 集成；保持既有 drain/timeout/ownership、原始预算、hold 绑定和禁用 cleanup。尚未实现。
- **C2 NOT SOURCE-READY：**新 recovery-family 的逐项精确记录表、source composition、handoff、prepare intent、输入绑定/库存/故障分类与独立向量仍需冻结；不得即席实现 recovery writer。S3/H4/Q5 因依赖未运行，不能宣称完整 v5 restore 或 ACTIVE/PAUSED 往返。
- Operational ownership/time gate、B1 写执行器及 P6 故障矩阵、P7 跨环境真实双机 LAN/公网、H1–H3 人工运营批准仍待独立验收。无 converter rollout、真实恢复/备份操作、实际删除、维护时间 authority、监听或发布权限；整份 PRD 尚未完成。
