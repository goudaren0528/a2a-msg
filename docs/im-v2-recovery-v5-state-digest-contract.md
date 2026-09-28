# C2 state-v1 逻辑摘要字节语法（NONRELEASE）

**概念语法已裁决；本文为独立联合审查通过的 DOCUMENT ARTIFACT（2026-09-28）。**这是 [C2-B2 中央 phase 协议](im-v2-recovery-v5-phase-contract.md) §5 的独立字节交接，不是新运行时实现、测试通过或 state-v1 runtime writer 授权。Whole C2 仍 IN_PROGRESS；S3/H4 NOT READY，Q5 blocked；按用户 2026-09-29 收尾要求暂停后续开发，不自动分配 admission codec，见 [PRD 收尾](im-v2-prd-closeout.md)。[literal schema/object/column manifest](im-v2-recovery-v5-state-manifest.md) 已单独接受为静态文档产物；两者均无 SQLite/product runtime 证据。前缀 35 字节、空表片段 262 字节仅经独立静态字节复算；[entry/plan](im-v2-recovery-v5-entry-plan-contract.md) 与 [terminal/API](im-v2-recovery-v5-terminal-api-contract.md) 已接受为文档产物而未实现。旧 3/4 digest、clock DDL/checksum 与通用 schema validator 均不变。

## 1. 完整帧与全流顺序

```text
P = UTF8('a2a-msg.im.v2/recovery-v5/state-v1\n')  // 恰好 35 bytes
F(tag, B) = ASCII(tag) || ':' || ASCII(canonicalUnsignedDecimal(byteLength(B))) || ':' || B
stateDigest = SHA256(P || StateStream)
```

`\n` 是前缀中**唯一**一个实际 LF 字节（`0a`），不是反斜杠和字母 `n`。标签 ASCII 原样、大小写固定；长度是 payload 的**字节数**，无前导零（零仅写 `0`）。流尾无分隔符、BOM 或附加换行。嵌套 payload 包含其内部**完整 typed frame**（含 tag、冒号和长度位）；先以 BigInt 检查全部长度、相加及预算，再在已验证可表示且有界时转为 Number 或分配。任何非规范数字、截断、额外字节、未知标签均拒绝。

唯一标签全集：

```text
schemaVersion schemaChecksum pragmaName pragmaValue
objectType objectName objectTable objectSql
table columnName columnType rowid null integer real text blob rowCount tableEnd
```

`StateStream` 恰为以下顺序的连续帧：

1. `F(schemaVersion, ASCII('5'))`；`F(schemaChecksum, ASCII('80eba5e6ce61261d31ec495216c3b6eb8c7a8f0c87edcbb1440372353f495435'))`。
2. 三对 `pragmaName`、`pragmaValue`，名称按 `user_version`、`application_id`、`encoding` 固定顺序。`pragmaValue` 的 payload **恰为一个完整 typed scalar frame**，没有尾随字节。前两项保留实际观测的 signed32 整数（`[-2147483648, 2147483647]`），不能强制为 0；用 BigInt 或经验证的 safe Number。`encoding` 的值恰为 `F(text, UTF8('UTF-8'))`；新 recovery admission 拒绝 UTF-16，不据此宣称 B2 原证据无效、修改通用校验或 baseline 规范化。candidate journal normalization 保留三个已编码 pragma 的观测值。
3. 恰好 **100 个** `ObjectRecord`，以 object name 的 ASCII 二进制序排列：`F(objectType, type)`、`F(objectName, name)`、`F(objectTable, literalManifestOwner)`、`F(objectSql, sqlFrame)`。`type` 只允许 `table` 或 `index`；`sqlFrame` 对自动索引恰为完整 `F(null, empty)`，对显式对象恰为完整 `F(text, rawStoredSqlBytes)`。允许清单为 32 表、26 显式索引、42 自动索引；不允许多余非 IM 对象、stats/sequence、视图/触发器、虚拟/影子、WITHOUT ROWID、temp 或意外 attached DB。catalog metadata 是对象元数据而非应用表数据；不编码物理 `rootpage`。
4. 恰好 **32 个** `TableRecord`，按表名二进制序：`F(table, ASCII(literalName))`；每个 manifest 列按 DDL 顺序依次 `F(columnName, literalName)`、`F(columnType, literalDeclaredType)`；接着严格按 **signed numeric rowid 递增**的实际行记录；最后 `F(rowCount, ASCII(canonicalUnsignedDecimal(actualCount)))`、`F(tableEnd, empty)`。每行是 `F(rowid, ASCII(canonicalSignedDecimal(actualRowid)))` 随后按列顺序恰好 N 个 typed cell frame。各表的 literal manifest 列数界定列/行边界，无额外 rowEnd/count 标签。INTEGER PRIMARY KEY alias 的列值仍在其列位置再编码一次且等于 rowid；复合 PK 的隐藏 rowid 也保留。重复 rowid、漏/多对象、列、行、错误顺序/数量、缺失/非空结束帧及 EOF 后尾随字节都拒绝。

## 2. 标量存储类与原始观察

| typed cell frame | payload 的唯一语法 |
| --- | --- |
| `null` | 空 payload；区别于空 `text` 和空 `blob`。 |
| `integer` | signed64 `[-2^63, 2^63-1]` BigInt 规范 ASCII 十进制：`0`、正数或 `-` 加正数；拒绝 `+`、`-0`、前导零、小数、指数及溢出。 |
| `real` | 实际 SQLite `typeof(...)='real'` 所观测 double 的 **8 字节 IEEE-754 big-endian**；保留可观测的 `+0`/`-0` 与正负 infinity。驱动若观测到 REAL NaN，拒绝，不发明规范 NaN；SQLite 在被观察前可能将 NaN 转为 NULL 或规范化符号，不承诺磁盘位型。 |
| `text` | 数据库 TEXT 的 `CAST(column AS BLOB)` 原字节（UTF-8 数据库），不经 JS string 往返；应用文本内 NUL/错误 UTF-8 仅在适用 schema/business validator 允许时保留，**不**由摘要编码认可其可准入。 |
| `blob` | 原始 BLOB 字节，允许空值；与 `null`、空 `text` 分别编码。 |

`rowid` 用同一 signed64 **payload** 语法但使用自身 `rowid` 标签，不是嵌套的 `integer` 帧；`rowCount` 是 unsigned decimal。列的声明类型只写 manifest literal，单元格只按**实际 SQLite 存储类**选择，不能以声明类型推断或转换其值。SQL 对象元数据先从 `CAST(sql AS BLOB)` 取得原字节，做 fatal UTF-8 验证并拒绝 NUL，再进入旧已审查的 manifest SQL normalization；不得剥掉原始 BOM 使之意外变为可接受 SQL（可用保留 BOM 的 fatal decode 并 literal 比较，或按相同准入语法直接拒绝 BOM），不得新增 case folding 或“规范 SQL 摘要”。一旦准入，`objectSql` **哈希原存储字节**：即使两个 DDL 经旧 normalizer 认为等价，原 SQL 空白不同仍可能得到不同 digest。

## 3. 流式提取与真实预算

仅在单个稳定 read transaction / protected snapshot 内抽取；期间无外来 callback、替换、突变或交错。先有界投影 object/row count 及每行 `typeof`、变长字节长度，再取实际可变字节；固定标量使用 `setReadBigInts(true)`。不得凭空假设 DatabaseSync 有 streaming blob handle，也不得用全库 `.all()`、oracle DB、保留行数组/BLOB。TEXT/BLOB 经 `substr(CAST(column AS BLOB), ?, ?)` 分块，SQLite offset 从 1 起，每块最多 65536 字节；按**精确 BigInt rowid**定位，复核类、返回长度及总字节数；行消失、NULL 或类变化拒绝。空值仍编码其帧头。对帧头只 hash 一次，其 payload 分块 hash、流中**不插入 chunk 边界**；同时至多保留一个变长 chunk。投影后的有界固定 metadata 整体 fetch 可以接受。

每个实际哈希字节均计入：前缀、标签、两个冒号、长度数字、schema/pragmas、对象、列、rowid、typed cells 以及结束帧。嵌套帧的字节**仅计一次**，但外层 payload 长度仍包含内部帧头。预检以 BigInt 加法确认上限。每条**完整流**不得超过原认证 budget 的 `limits.maxFileBytes`，实际文件大小、已验证内容、消息和维护记录上限另行保持；65536 的 record cap **不**施加于整条摘要流。每条流单独计数可复位，但不能构造新的认证 operation budget：原期限及 filesystem entry 累积跨 replay、baseline、actual 和各 pass 共享，native call 前后、每行及每块均 tick。原 10 秒或更低 deadline 保留，不增设 5 秒窗口。帧开销可能使物理文件符合上限的 DB 仍被拒绝，属于显式保守容量限制。

SQLite 内部 `CAST` / `substr` 可能物化数据；没有 hard native 内存/时间中断保证。文件、内容、metadata 限额及 soft deadline 仍适用。[旧 candidate 摘要实现](../src/im/v2/recovery-candidate.js) 约 119–122、143–152 行已有 `CAST`/`typeof`、`setReadBigInts` 和 BE 先例；[schema-v5 校验与预算](../src/im/v2/schema-v5-internal.js) 约 168–218 行提供范围和投影先例，不把旧 3/4 digest 改名或重算为 state-v1。

## 4. 精确帧片段（便于人工复算）

以下段落仅显示完整串接的**片段**，不是完整 schema stream，也不伪造 SHA。`+hex...` 代表拼接所列原始字节，**不是**字符串中的文字；排版换行不是输入字节。

```text
objectSql:7:null:0:                         (19 bytes; automatic index null SQL)
objectSql:7:text:0:                         (19 bytes; empty SQL invalid by manifest, framing differs)
pragmaName:8:encodingpragmaValue:12:text:5:UTF-8                         (48 bytes)
pragmaName:12:user_versionpragmaValue:12:integer:2:-1                   (53 bytes)
pragmaName:14:application_idpragmaValue:11:integer:1:0                  (54 bytes)
integer:19:9223372036854775807            (30 bytes)
integer:20:-9223372036854775808           (31 bytes)
rowid:20:-9223372036854775808             (29 bytes)
real:8:+hex8000000000000000              (15 bytes; negative zero; positive zero = hex0000000000000000)
real:8:+hex7ff0000000000000              (15 bytes; positive infinity)
text:3:+hex410042                       (10 bytes; A, NUL, B)
text:2:+hexc328                         (9 bytes; raw malformed application TEXT, not replacement efbfbd28)
rowid:1:7integer:1:7                     (20 bytes; INTEGER PRIMARY KEY alias repeated as column)
```

无行 `im_receiver_leases` 表的完整单表片段（262 bytes），每行仅为排版，实际顺序**无换行**：

```text
table:18:im_receiver_leases
columnName:8:agent_idcolumnType:4:TEXT
columnName:11:instance_idcolumnType:4:TEXT
columnName:10:generationcolumnType:7:INTEGER
columnName:10:expires_atcolumnType:7:INTEGER
columnName:13:credential_idcolumnType:4:TEXT
rowCount:1:0tableEnd:0:
```

同一 encoding、pragmas、存储 SQL、manifest 列类型、rowid、实际存储类和值产生同一串流，独立于 rootpage、page arrangement、freelist、rollback 物理重写和 journal mode（后者的保护另证）。虚拟预期状态须用**完全相同**的语法，不得用调用者遮罩字段代替；SQL 原字节变化则 digest 可以变化。

## 5. 后续证据与未决门禁

后续独立 literal vectors 须覆盖前缀、三 pragma 的整数边界与非零保留、nested NULL/空 SQL、signed64 两端、REAL ±0/±infinity/NaN 拒绝、NULL/畸形及空文本、空/多行、IPK 重复编码与复合 PK 隐藏 rowid、SQL 空白、完整 100 object/32 table、chunk size 不变性、UTF-16 准入拒绝、extra object、帧开销预算边界、baseline/virtual/actual 一致性。新的 runtime extractor/platform 行为 **UNTESTED**。`recovery-v5-state.js` 的模块分工和运行时立项需由 parent 单独授权；接受的 manifest、phase plans 和 binding bundles 文档不等于实现权限，独立 goldens 可与源码并行编写。

stage/normalization predecessor links、observation null/throw、phase plans 和 binding bundles 见已接受的 [entry/plan](im-v2-recovery-v5-entry-plan-contract.md)；八个 DTO、activation/release/status/terminal 和 physical inventory 见已接受的 [terminal/API](im-v2-recovery-v5-terminal-api-contract.md)。独立 goldens、native faults 与运行时证据仍待办；不据本文推出 target5 restore、运营隔离、写启用、清理或发布授权。
