# IM v2 C2-A 纯记录子范围验证（NONRELEASE）

**C2-A 限定范围已接受，本地提交收口；C2 整体仍 IN_PROGRESS。**执行输入是基线 `e161f37f8a690b9a54310393d04b5c923306fbc1` + 四份源码/测试 overlay，**不是**本次提交后的 clean commit 测试。详见 [C2-A 技术契约](im-v2-recovery-v5-intake-contract.md)与[当前 TODO](im-v2-implementation-plan.md)；技术契约只更新状态开头，其技术条款不随本次状态提交改动。

## 固定输入和纯范围

| 执行 overlay（仓库相对路径） | SHA-256 |
| --- | --- |
| `src/im/v2/recovery-v5-intake-records.js` | `57cd94ab1ce30836656fddbeac60c0966f983f7e5c3c4f79413b462787e30385` |
| `tests/im-v2-recovery-v5-intake-records.test.js` | `32fedd04ccba2c417ea82696715f0809511944da5f0fb1f204332296101843e0` |
| `tests/fixtures/im-v2-recovery-v5-intake-records/oracle.js` | `5e110d21bd9cc4f9eff9f01fa7621f3400c7342b8a29f590b318fe679b2f7ced` |
| `tests/fixtures/im-v2-recovery-v5-intake-records/vectors.json` | `5c9d06779d1008c799afe5aae1482c58dd5e4efd4173f22b0cbf9cb1d14a9fc4` |

接受范围是 `archiveIntent`、`conversionHandoff`、`nativeIntake`、`convertedIntake` 四类纯记录与五个精确导出；canonical 编码上限 65536 bytes、新 domain 与历史 raw/NUL/newline hash 分工保持。严格嵌套 ordinary 对象、输入字节、错误边界和独立 detached 输出；archive graph、native/converted actual DTO 的关系仅证明**纯一致性**，不构成来源认证、provenance、真实文件保护、archive 创建或 handoff。独立 51 份 literal vectors（13 新、38 历史）、五个 route graphs、原 72 个关系反例加三项隔离反例接受源码及独立测试设计 QA。初始测试设计遗漏的 plan input、changed hash 与 TTL 三个隔离负例已补齐；这是测试覆盖修订，**不是产品源码缺陷**，旧断言全部保留。

## 隔离执行与边界

| 证据标签 | 实际执行（重叠结果不相加） |
| --- | --- |
| 初始 `c2a-codec-44b3460d62de4c80ad5c4027ccda6b41`，evidence-index SHA-256 `a2751514c2338d80a776beab21ff906fb1c4357533e0b890737a34cf0bff8f4c` | 初版测试 SHA-256 `ef93675e22e5b1cceaea7811cab79ccea2e3db9fb439a7472624ea488bde34de`：目标 138 pass、历史纯 codec 133 pass、默认全套 2611 total / 1734 pass / 877 skip / 0 fail、五个 OpenCode 集成文件 46 pass；各进程 exit 0。Windows Node 24.19.0 / SQLite 3.53.3，独立候选 `npm ci` 安装 95 packages。 |
| 修订测试补充 `c2a-supplement-a7eaec38f917409786be63e4ca0309da`，evidence-index SHA-256 `54f35cc122deb4324525b05650636bbc295a2571bd8f6924f54c9b448c91c147` | 四 overlay 中仅测试改为上表 `32fedd04…`，新 suite **141 pass / 0 fail / 0 skip / 0 cancelled / 0 todo**，真实 exit 0、无 signal/error/timeout。原始 TAP SHA-256 `0f46fd3c22e2ee7f833c6e51d4306a0734e6cf81a0d45812510be708e6b9a317`，执行 supervisor SHA-256 `12dac570f26a279d13c8650e51a659b28e102c00254ef19293b9dc2bb16324fc`。本次**复用**已隔离且 lock/版本匹配依赖，非 fresh install；新测试哈希下未重跑全套/历史/插件。 |

补充的 raw TAP 中第 108/109/110 项分别为隔离 plan-to-paused coherent proof/completion、enabled changed-true equal-file-hash coherent inputs、plan-before-pause valid TTL/proof-window 反例；程序输出里便捷的 `matchingNewCaseLines` 搜索遗漏第 109 项，但 raw TAP 实际含此 PASS。补充运行前已保存环境及 417 份基线 tracked 文件 + 四份 overlay 的 source/candidate hash，实际等待进程结束后重新核对一致。首次补充 supervisor 的 Windows `fsync` EPERM 在**测试 spawn 前**停止并留存为 setup stop；改用证据 writer 的 `writeFileSync` flush，不改变产品安全守卫、不当作产品 RED 或已执行测试。此前离线 PowerShell `§` 语法检查失败也不属于集成测试 RED；不追认旧失败为通过。

Windows 877 个 skip 不是 Unix 原生保护通过。本子范围为可移植纯 codec，不要求也不声称新 Linux 执行；初版全套/历史/插件结果仅能用于未变化的产品源码/fixtures 与当时测试哈希，不是修订测试的重新执行。此前 B2 原生证据不冒充 C2-A 新执行。

## 下一门禁

**NEXT C2-B**：先冻结余下 request/stage/locator/source catalog、executor 与 conversion approval、source3/4/5 closure、copy/base/normalization、prepare intent/clock projection、seal/activation/release/status 的精确记录、八方法 DTO、各阶段 inventory 与 crash contracts，再审 S3/H4。C2-A 不表示 C2 整体冻结、runtime writer ready、target5 restore 或维护/运营时间授权；不授予启写、清理/删除、监听、H1–H3 人工许可或生产发布。本次无 C2-B 实现。
