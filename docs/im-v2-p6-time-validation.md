# IM v2 P6-B0.3 隔离时间权威验证（NONRELEASE）

2026-09-28。本记录仅对应 [最终时间契约](im-v2-maintenance-time-contract.md)、[schema 5 契约](im-v2-maintenance-schema-v5-contract.md)及 [实施账本](im-v2-implementation-plan.md)的内部切片；四线代码、安全、契约忠实度和独立 QA 限定范围门禁已接受。输入是基线 `cc5bed7bb18eac36ee3cc2a412ac47fb29c1b96e` + 测试 overlay，**不是未来 clean commit 的运行结果**，更不是生产或整项 P6 验收。

## 输入与可追溯性

最终逻辑证据标签 `b03-final-fixed-cfbdbf4f008f4627ad227e4c0358e0b6`，原生标签 `b03-final-native-2uc9bypd`。14 份 QA 输入由 source overlay manifest（SHA-256 `a4b90d935fb537c57a698794dc3edc9e8f47437a824bf88bfc632b4d52f93588`）固定；证据 manifest SHA-256 `1943fc13f6f0400ee8e22bb5b666f7f931a65824cc790f67b781d390a7356a77`。14 输入及 326 份 source/candidate 的 run-bound 前后 hash 匹配；下表的两份契约是测试参考输入，**不是**运行时授权来源。

| 输入 | SHA-256 |
| --- | --- |
| `src/im/v2/maintenance-time-internal.js` | `605e1f74191160b708514f0212b9674637c78d7069e4bb6c7bcd4992ed5956f9` |
| `src/im/v2/maintenance-time-authority.js` | `b28b969f2be8d9419b2069e91ad0e4d0ff5fa3f48d6da67b00938403a10dbe6e` |
| `tests/im-v2-maintenance-time.test.js` | `1395b7aefc452753a916e6bc32c1923009693ec6a9dfad3daf4431a822ddcfe8` |
| `tests/fixtures/im-v2-maintenance-time/owner.js` | `2b3cb83ab6efa8210eab46f66d0f0411bf38d153a9ac6d617abdb14f4374adc0` |
| `tests/fixtures/im-v2-maintenance-time/observer.js` | `9b299e4f266c34875a9688488e5c88f4a51a113999cca86599eafec498c8010e` |
| `tests/fixtures/im-v2-maintenance-time/scenarios.js` | `18ff39eb9a653d4d36f1cb3cdc8de97b609727558bbb9727151ff72850ba1cde` |
| `tests/fixtures/im-v2-maintenance-time/cross-target.js` | `f181cff61456555322dc68f71e0b80ee47b35fd4fcb866987e1a20543b6fb038` |
| `tests/fixtures/im-v2-maintenance-time/escaped-error.js` | `f5b00ad45981ff9d0463414a43cd79b3eab8a8b7834049e40581a157292d5f73` |
| `tests/fixtures/im-v2-maintenance-time/error-lifecycle.js` | `2df8a2b29328eb0103a02f99eb2a05d132193a5b6fcca2026394202151db58f6` |
| `tests/fixtures/im-v2-maintenance-time/error-lifecycle-child.js` | `4c25916a3ee4d5033cb753f416a0b94af267a86f03005a1cbc433fc0134595c6` |
| `tests/fixtures/im-v2-maintenance-time/child.js` | `aee9abf93befddbcf9d1c8d5f78ce6841438fb0d712532a2319baa850d04025d` |
| `tests/fixtures/im-v2-maintenance-time/restart-child.js` | `6a771f6ee0ac43f28e84828f7a9143742d18db766b40577ebec299da0826d6d5` |
| `docs/im-v2-maintenance-time-contract.md` | `e66097355cbd15ba8f51aafe4486be2c9184c4fbddec24ac97d577fb67fb0855` |
| `docs/im-v2-maintenance-schema-v5-contract.md`（测试时） | `b565f1442e1f6673f5566df369208e3f3d6c8270855beec806d3b67463571fe9` |

schema 5 契约第 8 节关于生命周期“待冻结”的句子在运行测试后作**单句文档修订**，其新 hash 与测试时 hash 不同；后者只表明参考输入字节，并非修订后的测试 PASS。其余三个提交文件为实施账本、路线图及本记录；提交总计限定 17 个路径，不把任何排除文件的变化并入本包。

## 已证行为与边界

- 仅内部 synthetic ACTIVE/PAUSED v5 时间权威：测试可信 owner 提供私有已关闭文件连接及独占目标，这是**测试假设**，不是生产路径所有权证明。独立原生 wall/monotonic 采样锚定，approval actor + nonce 绑定 history tip/head generation；anchor/head/floor 同事务原子。旧基线仅在已确认提交与清理后建立；已提交但不确定的 reanchor 不重建基线。
- 重放不恢复私有 session、不新增时钟采样或写入；preview/status 只读；全纳秒 delta、慢 COMMIT 从提交前 mono 原点计费。跨目标 guard 必须在 B 工作前拒绝。错误内部私有 code 与对外 fresh Error 隔离，未解决的清理不确定性优先报告 `MAINTENANCE_DURABILITY_UNCERTAIN`；构造清理错误经安全边界。回调后续抛出的 foreign public Error 走 `MAINTENANCE_APPROVAL_DENIED`，实际被捕获的重入走 `MAINTENANCE_INVALID`，不能概括为所有外来错误都 INVALID。
- 最新独立固定源码覆盖六种可变 Error、两种 rollback refused、两种 constructor 清理尾部、十种 cross-target 与 restart。清理未确认资源是**测试所有权下的清理**，不证明生产事务回滚；软件 fault 不证明物理断电或跨机器全局 fencing。

## 运行证据（计数重叠，不求和）

| 环境 / 范围 | 结果 |
| --- | --- |
| Windows Node 24.19 / SQLite 3.53.3，新候选仅 `npm ci` | 安装退出 0；专项 115 total / 3 pass / 112 skip / 0 fail；关联测试分别 133、33、25 pass；完整套件 2338 total / 1536 pass / 802 skip / 0 fail；五个显式插件测试 46 pass / 0 skip。 |
| 原生 Linux ext4 / euid 0，受测目录 0700 | 专项 115 total / 114 pass / 1 skip / 0 fail；关联范围分别 133、33、25 pass；原生套件及独立 WSL 外层退出 0。最终 umask 为 0022，**不是**旧 CR-03 中的 0077；复用匹配版本和依赖的 lock，**不是**全新 Linux 安装。 |

原生 1 skip 与 Windows 112 skip 都不算 PASS；并未执行完整 Linux 仓库测试，也不声称 Windows 严格文件保护支持。之前 `e5bea…` 的 PASS 未覆盖错误别名修复；CR-01 的 120 秒中断无最终 exit，CR-02 的 112 pass / 2 fail / 1 skip 为 RED（回调错误期待已裁决修正），CR-03 新尾部真实 PASS；不得把历史红/中断追认为最终版本证据。旧 clone checkout 只验证 normalized JSON/blob 等价，原始 lock CRLF 不同，**没有**执行 install/test；新测试使用调用局部 `git -c core.autocrlf=false`，不修改全局配置或重写源码。

未配置项目或已核父目录 `.sybermem`，未初始化、安装或生成记忆记录，不声称记忆索引通过；本仓库文档是版本绑定记录。B0.3 不接 server、MCP、CLI 或 recovery；转换候选不是合法时间目标，未交付生产 maintenance executor、schema 5 production owner、实际删除或 v5 backup/恢复兼容。默认 enabled/expiry/purge/backup cleanup 均 OFF，backup TTL 未确认。下一门禁按 [实施账本](im-v2-implementation-plan.md)：v5 runtime/clock → manifest 3 → registry 4/source evidence 2 → 新 recovery family → 仍 paused 往返；B1 writer、P6 fault、P7、H1–H3 分别待办。
