# IM v2 P6-B0.2b 候选 schema 5 转换引擎验证（NONRELEASE）

**资格边界：**这是基于 `d9d090701af3c85813a0092388332f134ea8aaba` + 19 份已测 overlay 的本地候选证据，不是新提交后的 clean commit 重跑，也不是生产迁移/恢复许可。最终 gen145 QA 对 B0.2b 基线及 19 overlay 和两份分别审查的契约给出 PASS；[恢复转换契约](im-v2-recovery-conversion-contract.md)及[维护 schema 5 契约](im-v2-maintenance-schema-v5-contract.md)是设计参照，不是执行的 overlay 输入。19 份内容见逻辑运行标识 `b02b-a7-followup-20260928T031607Z-05d56c` 的 manifest（SHA-256 `c787d78c4729bf14a5680f68c34b8d4c5bfb7bc9a9f4a7c906348d5d3191631e`）；其导入闭包及 hash 已核对。两个契约分别审查的 SHA-256 为 `277010c7436291628da20f8c9f626814b09dfd467ec7e49ad221b2b1362f0e08` 和 `bf46e994af8342f5748a689d2d3448a4b5603bb2a9e2b144a0bd855d5844d0b8`。

## 已实现的有界行为

- 私有真实 ownership bridge 仅由 converter factory 使用。预览具备写能力以认领转换目标，随后暂停候选并绑定不可变计划；固定 schema 4→5 转换必须有独立审批者身份，执行时重新核对当前审批与时间，并沿用已认证的父预算、原始 deadline 及文件系统限制，不能重开预算。
- 在实际归属事务中启用 FK、执行冻结 DDL、类型化转换状态流转及完整 v5 校验；继承的时钟/epoch、策略、身份和业务行保持不变。候选专用暂停是明确的例外，不能说所有行均不变。未向旧恢复 facade 的转换归属运行开放入口。
- COMMIT 响应不确定时以实际 schema 4/5 及持久证据调和，不隐式重做 DDL 或制造新 ID。已确定 native close 成功但返回异常的路径仅在完整证明与耐久性条件成立时可完成；真正未决的 open 则保守拒绝。
- 完成记录缺失时，只在干净命名空间做精确修复。缺少持久 ownership 证明的未知 pending 保留为 `INDETERMINATE`，不得接管或删除；完成后的 post-hash 冲突直接拒绝。每次精确完成重试均重同步候选及 completion 文件和目录；准确已完成重试不产生新时钟、审批、审计或时间。有效 locator 但 owner 不符的 status 保守给出 indeterminate，不伪装为正常成功。

## 本地证据与限制

| 范围 | 结果与限定 |
| --- | --- |
| 新 Windows 候选 | Node 24.19.0、Python 3.12.10；仅候选 fresh `npm ci`，95 packages。未插桩 A7 单测 7 pass / 0 skip；全套 2223 total、1533 pass、690 skip、0 fail；明确的五插件集 46 pass / 0 skip，退出码均为 0。Windows skip 不能证明 POSIX。新全套 stdout SHA-256 `814009cdd3fb1719f373e6644ee870ab35aaa94ea2593397f64c027fb5bce425`；Windows completion SHA-256 `3e87b62dd76b0d7da3d4cdcad6a7c7051b6ec0832df9f176afaafb5f435cc0cd`。 |
| 原生 Unix 复用 | `b02b-final-compat-gl43_m9a`：先前 18 overlay 的八个目标共 378 pass / 4 skip / 0 fail；独立 WSL outer 为 0。核对相同范围的 after-hash 和 import closure 后复用，**不是**新 19 overlay Linux 运行，也不是完整 Linux 仓库测试；原生依赖复用、不是 fresh install。结果 SHA-256 `b6ebc9280281870f73251539f0ef45695b164129048609c53226376118ebf186`，复用记录 SHA-256 `aa5c1235d81cd1f996be38f0fe8028738f086d8abb4673d05693d4910978c5aa`。 |
| A7 修订 | 一行 `localhost`→`127.0.0.1` 使客户端 URL 与监听地址及证书 SAN 一致；继续验证 CA，未放宽 timeout 或默认并发。原始 Windows 运行 1526 pass / 7 fail / 690 skip、退出码 1（六个子失败及父失败），不能改写为绿；虽观察到 IPv6 拒连脆弱性，原超时的确切原因仍未知。 |

以上运行有覆盖重叠，**计数不可相加**。此前 `207/3` 裁决的 converter 测试 RED、gen144 null outer 的历史缺失继续如实保留；新的前瞻性证明不能重建旧记录。故障覆盖是软件故障测试，不证明硬件掉电或旧写入方全局 fencing。

## 继续关闭的门禁

没有运营 server/MCP/CLI wiring，也没有 B0.3 时间权威或维护写执行器。runtime 5 → backup manifest 3 → registry 4 → 新恢复家族 → facade 的兼容及 v5 roundtrip 尚须分别验证；P6 物理清理、P7 实网、H1–H3 人工许可、备份 TTL 确认与原 WP0–WP4 发布门槛均未因本切片改变。默认关闭/暂停和旧 LAN 行为不变。本记录不授权生产迁移、真实恢复、启用、删除、监听或发布。
