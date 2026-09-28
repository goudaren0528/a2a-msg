# Agent IM v1：PRD 对照与阶段收尾

**日期：2026-09-29。结论：阶段成果可保存，但原 PRD 尚未完整验收；本轮停止扩展开发。**

基线 HEAD：`f51cce36afb833cf67775cd47183dd3ebc3341e8`。用户明确要求“收尾工作，不要再过度开发了，对照 PRD”。本文只对照[原 PRD](prd/a2a-msg-agent-im-v1.md)、[路线图](roadmap.md)、[当前账本](im-v2-implementation-plan.md)及既有证据；未运行新测试、服务或数据库操作。

PRD 文件仍保留 v0.2 草案状态，路线图记录了后续会话实施授权。两者均不等于生产启用、远端修改或发布许可。历史验证记录中的“下一包”是当时快照；本次明确暂停自动推进，不把未完成事项打勾，也不再派生开发任务。

## 1. 原 PRD 的交付目标与现有事实

状态按能力与证据边界划分，同一能力可以“已有本地实现”但“真实部署验收未覆盖”。不计算完成百分比。

| PRD 条款 | 状态 | 可保存的成果及边界 |
| --- | --- | --- |
| §2 G1、§3.1 R-ID/R-ACL、§3.2 R-MSG/R-STATE | **已实现并有证据（本地限定范围）** | `src/im/{admin,auth,acl,messages,delivery}.js` 已有稳定身份、独立凭据、联系人、双方新会话、单附件及显式 ACK/read；迁移与权限边界见[迁移验证](im-migration-validation.md)。v2 对应核心/HTTP 已有[P3 验证](im-v2-p3-http-validation.md)，不是旧 IP LAN 的改名。 |
| §2 G2、§3.3 R-SEND/R-LEASE/R-SYNC、A3/A4 | **已实现并有证据（本地限定范围）** | `src/im/{client,journal,delivery}.js` 与 v2 client/journal/delivery 有持久 key、lease/fence、分页同步、journal-before-ACK 和故障恢复路径；[P4 client 验证](im-v2-p4-client-validation.md)含原生进程故障补充。严格 v2 owner/client 限原生 Unix，不能把 Windows 跳过记为通过。 |
| §3.5 R-MOD、A6/A7 | **已有实现；完整验收未覆盖** | 通用 `src/im/client.js`、`src/im/mcp-adapter.js`、Python HTTP 示例与宿主适配分离；[本地无宿主互通](im-local-recovery-interop-validation.md)实际覆盖 Python HTTP + SDK MCP 独立进程、TLS、附件与补 ACK。core 不以 OpenCode/工单为必需条件；该记录不证明所有宿主安全、第三方框架或 Python 崩溃 journal。消息不授予执行权限。 |
| §3.1 R-NET、§2 G3、A1/A2 | **已实现但验收未覆盖** | HTTP/TLS 策略、CA/主机名检查和 loopback 测试存在；[P3 HTTP](im-v2-p3-http-validation.md)明确真实 socket 与模拟 transport 的区别。尚无已接受的真实双机 LAN、不同网络互联网 TLS 验收；本机 TLS 不能替代。 |
| §4 R-MIG、A5、§5 发布门槛中的备份/恢复 | **已实现并有证据；运营验收未覆盖** | `src/im/migration-runner.js` 支持管理员绑定/独立审批；旧消息权限不追认强身份。`src/im/v2/recovery.js:createImV2RecoveryServices` 已有 target4 八方法与 release/status；[P5-D](im-v2-p5-process-validation.md)有四来源链和软件故障证据。真实来源隔离、实际备份/恢复审批与部署演练仍须另行确认。 |
| §3.6 R-OSS、A8 | **部分文件已实现；发布验收未覆盖** | CONTRIBUTING、SECURITY、CHANGELOG、CI/模板文件已存在；`package.json` 仍 `team-mailbox`、`private:true`，本地未见 LICENSE。GitHub CI 实际运行、安全渠道可达性、历史秘密审计、clean clone quickstart、许可/分支/命名兼容决定未在本次验收。其他会话的 README 修改不纳入本次成果。 |
| §3.4 留存/存储满与同步缺口、§6.2 留存参数 | **策略/预览已有实现；维护 writer 未实现** | 后续设计采用 90 天内容/7 天安全重试/180 天普通审计、备份 TTL 未确认；P6-A 只有[只读预览](im-v2-p6-preview-validation.md)，`retention.js:createImV2MaintenancePreview` 的 v4 计划 `executable:false`。expiry/scrub/audit 执行器与自动备份清理未交付；关闭默认值不能冒充已完成留存运营。 |
| 后续 schema5 备份与纯 intake 子集 | **已实现并有证据，非 target5 恢复交付** | R1/C1/B2 与 `recovery-v5-intake-records.js` 已实现；[B2](im-v2-backup-v5-validation.md)证明备份发布/注册限定范围，[C2-A](im-v2-recovery-v5-intake-validation.md)只证明纯记录一致性。旧 target4 对 native5 admission/release 仍明确拒绝。 |
| C2-B admission/phase/state/entry/terminal 新恢复家族 | **仅设计文档；对应 runtime 未实现** | 七份契约已审查接受，原型字段/API/清单不是源码。未实现 `createImV5RecoveryServices`、新 admission codec、state-v1 extractor、target5 handoff/恢复执行；S3/H4/Q5 不可写成完成。 |

## 2. 不把实现路线扩大为 PRD 首版必需项

原 PRD 要求可靠通信、明确留存/备份恢复行为与恢复演练（§3.4、§4、§5、§6），**没有指定 schema 5、维护时间锚、转换归档、双 target4/5 恢复家族或 state-v1 字节流**。这些是后来恢复/留存设计选择及加固工作，不应因为已写出 C2 契约就自动变成新的首版产品需求。

- 已有 target4 恢复并非“还没做恢复”；保留 P5 本地证据与保守拒绝边界。
- P6 时间权威仅为[内部 synthetic ACTIVE/PAUSED 切片](im-v2-p6-time-validation.md)，不是维护执行器或生产时钟归属。
- 原 PRD 没有明确要求首版采用整套 P6 purge/维护算法；但留存参数、过期缺口、存储满行为与发布策略必须确认，不能因暂停高级实现而从验收中删除。
- 若未来产品明确选择 schema5 作为真实恢复目标，则其兼容/恢复缺口必须在那个范围内解决；本次不为“收尾”启动这条路线，也不允许将未完成的 target5 对外声称可用。
- 群聊、联邦、多中心/HA、完整官方 A2A、自动执行消息等仍是 PRD §2/路线图列明的非目标。

## 3. 最小剩余验收清单（仅记录，不自动执行）

后续由维护者决定是否、何时授权以下有限验收，不以先完成 C2/S3/H4 为统一前置：

- [ ] **A1/A2：**明确选用的已实现协议/版本，在真实双机 LAN 和不同网络 TLS 中心留下身份隔离、证书、凭据撤销及同步证据；资源/凭据需独立授权。
- [ ] **A3/A4/A5：**复用本地结果，只补选定交付版本尚缺的部署级离线重启、发送响应丢失、附件失败、迁移不扩权与受控恢复验收；确认源隔离/RPO与不覆盖新增 accepted 数据，不要求硬件掉电或全局 fencing 超额承诺。
- [ ] **A6/A7：**在全新环境、无 OpenCode 前提下验收通用 MCP/client + Python 的文本、附件、回复、ACK、重启补收与不执行恶意内容；旧适配层安全交互保留。现有本地独立进程证据不自动覆盖真实框架/机器。
- [ ] **R-SYNC/§6：**维护者确认留存、幂等窗口、过期缺口、存储满/退避和备份策略；明示当前未交付的物理清除，决定是否影响本次选定版本发布，不能承诺不存在的 writer。
- [ ] **A8/发布：**确认 LICENSE、安全报告渠道、实际 CI、clean clone 示例、升级/回滚和仓库命名/分支兼容；未齐前不宣称正式开源发布。

**当前交付口径：内部 NONRELEASE 阶段成果与已接受设计可以保存；整份 PRD、跨网络部署及正式发布尚未完整验收。**不把 A1–A8 未覆盖项改称通过，也不立即为这些清单启动新开发/测试。

## 4. 已有证据如何复用

- 本次只有文档核对，没有新的全套、目标、Linux 或 Windows 测试执行。
- C2-A 最终目标为 **141 pass / 0 fail / 0 skip**；此前全套 **1734 pass / 877 skip** 使用旧测试哈希，随后仅补三项断言的目标运行。不是新测试哈希下全套重跑，范围重叠不相加。
- B2 原生 **400 pass / 9 skip** 是其既有固定输入批次；既非本次新执行，也不证明 target5 restore。
- P5-D 43 个场景及保留运行/新运行审计局限按原验证记录保留；软件 SIGKILL 不等于掉电。原始红测、setup stop、缺失证据不删除、不追认。
- 最近从 `2b9334c` 到 `f51cce3` 的五次收口提交是 admission、phase、manifest/digest、entry、terminal **文档工作**；`cf7c90f` 才是已实现 C2-A codec 提交，`e161f37` 是 B2 集成。文档提交数不是功能完成度。

## 5. 本轮文档范围与停止点

保留此前九份自有契约/账本文档中正确的已接受状态、enum/inventory/API 交叉链接；只撤下立即分派 admission codec/fixtures 的下一步，改为按用户要求暂停。C2 保持 IN_PROGRESS，P6 writer、S3/H4/Q5 与高级恢复设计留作后续明确范围决定，不新增技术契约或实现。

PRD、roadmap、源码/测试/依赖、其他会话的 README/MCP/附件/read-flow 工作及生成证据均不属于本轮写集合。本文不是这些脏文件的 QA 或合并批准。保留旧 LAN 的证据是既有版本的兼容记录，不是本轮对整个脏工作树重新认证。

未解决事实：真实 A1/A2、clean 环境 A7/A8、生产审批/来源归属与 GitHub 服务端治理证据未在本轮取得；当前脏 README 等未审查。本次不访问运行数据库、真实服务或凭据来补结论。下一步仅由 parent 核对限定 diff，按已授权范围决定本地提交；不 stage/commit/push 于本 lane，不自动排队任何后续工作。
