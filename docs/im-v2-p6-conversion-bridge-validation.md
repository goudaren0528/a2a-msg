# IM v2 P6-B0.2a 转换所有权桥验证（NONRELEASE）

**范围与版本。** 本记录绑定提交前基线 `7c982499920354706ffa973aa74cfe478222c34a` 与经 SHA-256 核对的限定 overlay，不声称本地提交后在 clean commit 上重跑。输入清单：`b02a-independent-92d4ecc0aff04e72a4ee21574bd043df`、`b02a-independent-Q6A1gl`；原生批次冻结清单：`b02a-bridge-wple0kiy`。两个独立输入清单列出的源码/测试/fixture 字节一致；另核对[转换桥契约](im-v2-recovery-conversion-contract.md)和[schema 5 契约](im-v2-maintenance-schema-v5-contract.md)。清单还哈希了未纳入本次提交、未由纳入测试/fixture 静态或动态引用的 `check-observer.js`；它不是本次执行链或验收范围。本文的验证计数均为版本绑定的隔离运行，不是生产或发布验收。

## 已实现的边界

- 仅真实恢复 factory 创建的冻结 facade 可私有铸造转换目标；不是调用方路径、DB、SQL、记录或普通对象授予所有权。目标作用域同步、限时、可失效；会话仅提供 `inspectIntake`、`readConversionRecords`、`claimConversion`、`ensurePaused` 四个固定操作，返回值须为本作用域成功方法结果的**同一对象身份**。异步前缀、越权/过期调用、重入及被捕获故障不能借回调返回值取得成功；最终清理后仍检查 poison/失效。
- 共享下调预算贯穿来源→工作区→候选的控制跨度、元数据、发布与最终检查。持久 owner、pause intent、paused 证据分别固定且不可替换；意图先于候选写入。仅对候选 `im_settings.write_mode` 执行固定暂停；已暂停路径不做 UPDATE。旧八个恢复 facade 方法对已认领分支拒绝普通 v4 路径；所有者未知/损坏、别名或不安全残留保守拒绝，不当作未认领。历史 stage-only 与 locator-only 重试/修复路径也覆盖所有者门禁。未将不确定的 pause 归结为所有状态一律 `RECOVERY_CONVERSION_PENDING`：证据不充分时可转人工不确定处理。
- 跨新进程的精确重试需显式同步已存在记录及候选文件/目录；进程可见文件不等于持久性。意图后候选字节变化而缺少 paused 证明时人工拒绝，不从当前暂停模式推导成功；不清理未知文件、删除所有者或重写 intake。来源与原始备份业务事实不变，仅隔离 fixture 的候选发生目标暂停。闭源 v3 路径仍依赖其可信隔离回调，不宣称全局 fencing。
- 新纯 codec 只编码/解码/哈希规范 owner、pauseIntent、paused 记录；没有 I/O 或授权。B0.2a **未**执行 v5 DDL/转换、时间写入、转换 plan/completion，也未向运行时 facade 暴露转换器。

## 独立执行证据与局限

| 隔离批次 | 实际结果 |
| --- | --- |
| Windows 修正配置的全新隔离 `npm ci` | 95 packages，退出 0；独立 bridge 2 pass / 44 Unix skip，codec 21 pass；全量 1507 pass / 646 skip / 0 fail；显式绝对路径五组插件 46 pass / 0 skip。各次记录的进程退出均为 0。 |
| 原生 Unix 九组 | 合计 201 pass / 6 Windows skip / 0 fail，**每组**实际退出 0，独立 WSL 外层退出 0。Node 24.19、SQLite 3.53.3、ext4 私有 `0700` 临时目录、euid 0、umask `0077`；依赖复用匹配的隔离安装，**不是**原生全新安装。各组 Node argv 保留，完整 WSL launcher argv 未保留；结果计数经后处理仅规范化计数字段，其余字段与独立外层原始输出对应。未运行整份 Linux 仓库测试。 |

这些计数涉及重叠测试集，不可把 Windows bridge/全量、既有批次及原生九组相加当互异测试。固定功能时钟只在专用测试子进程、模块导入之前安装；其余回归使用独立自然时钟。自然时钟观测到成功路径；安全拒绝分支为源码审阅，**没有**声称在自然时钟运行中实际遇到。低于 floor 1 的拒绝与精确一次重试路径通过且未替换 owner。四个响应丢失探针是原生操作**已成功后注入抛错**，不是实际 fsync 失败、掉电或“关闭失败仍保持打开”的证明；进程故障矩阵同样不构成硬件掉电或全局 fencing 证明。

早期 RED 批次 `tvd6__2x` 保留原样：44 pass / 1 fail / 1 skip，报告 `TypeError`，未启动组未被补写为成功；最初未捕获的 `ensurePaused` 原因**未知**，不可事后归因为时钟。独立 Windows 初轮 00 的安装因重复 npm 配置退出 1，01 bridge 在加载模块时缺少 `zod`（0 pass / 1 fail），02 纯 codec 21 pass，03 全量在 npm 配置阶段即失败；错误插件路径没有执行测试。后续 10–14 使用独立外部空 user/global npm 配置及正确绝对插件路径成功，产品/测试字节未因此改变。Windows 外部 runner 后来被禁用，已完成调用没有历史 runner 脚本 hash；证据限于已保存 argv、字节映射、结果及 npm 自有日志，不以当前 runner 文本冒充当时脚本。没有抹除或倒填早期失败。

## 后续门禁

上述局部 QA 仅支持 B0.2a 所有权桥。B0.2b 实际候选转换器、B0.3 另有私有 owned-v5 目标与时间权威，以及 schema→runtime→backup→registry/source→新版恢复家族→facade 的兼容和 v5 backup/注册/恢复/激活往返仍待分别审查验证；P6 写执行器、P7 真实双机/跨网络、H1–H3 人工批准与备份保留期限确认均不由本记录替代。未执行实际迁移、运营启用、删除、监听或推送。旧 LAN/v1–v4 历史契约及原 WP0–WP4 门槛不因局部验证改变。
