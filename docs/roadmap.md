# 路线图：a2a-msg Agent IM v1

**状态（2026-09-24，本地迁移包基线 `f6e32d2`）：用户已在会话中批准按 PRD 推进实施；无批准排期或 GitHub milestone。已有本地实现与限定范围验证，尚未通过 v1 跨环境/发布验收。** PRD 文件头仍保留草案标记，不代表实施未获授权，也不代表上线或发布获批。完整需求、模块边界、公开治理与故障验收见 [Agent IM v1 PRD（v0.2）](prd/a2a-msg-agent-im-v1.md)。项目目标是让独立 Agent 作为联系人，在单一管理域内跨机器、网络、框架、进程和时间完成可恢复的私聊通信；不是 Agent/subagent 主从调度。调研→写作、数据分析→报告都是正常应用；研发测试工单只是可选场景。

| 顺序 | 工作包 | 本地进展与剩余门槛 |
| --- | --- | --- |
| WP0（并行治理） | 公开仓库、README 与兼容命名 | 治理文件已在本地建立，CI 定义不等于 GitHub CI 实际运行；`private: true`，无 LICENSE（用户明确暂缓选择），不能宣称开源授权。私密安全报告渠道、仓库/分支/rename、兼容与发布/回滚仍待维护者决定及实证；WP0 不阻碍内部 WP1–WP3 设计，正式开源发布必须完成治理验收。 |
| WP1 | 通信模型与版本兼容 | 版本化私聊会话、消息、附件、状态及 HTTP 契约/schema 已本地实现；旧 `team-mailbox` API / 包 / 命令兼容与旧历史不扩权、新会话双方可读仍须持续验证。 |
| WP2 | 独立身份、联系人与迁移 | 稳定 `agent_id`、凭据/撤销、联系人 allow-list 与同 IP 隔离已有本地实现；本地 A/B/C 迁移切片实现并经专项审查，采用实际 DB 身份及受保护的备份 registry 校验、管理员逐项绑定预览与独立审批。旧记录不追认强身份；新增隔离备份恢复候选及 TLS 续接的本地测试通过，但生产恢复演练、审批/来源证明集成仍未验收。详见[迁移验证](im-migration-validation.md)与[恢复/互通验证](im-local-recovery-interop-validation.md)。 |
| WP3 | 可靠私聊、附件与同步 | 发送/幂等、lease/fence、持久同步、ACK、通用 client/journal 与 SSE 提示已有本地实现；原路径 hash/registry 占位、generation 类型及新鲜时钟门槛已在本地 A/B/C 切片实现并通过限定范围最终 QA；Windows 严格 registry 不支持，外部审批撤销原子性未保证。物理清除目前有意只提供只读 planner，等待追加式 tombstone/content-expiry 设计获批，不能宣称已交付 purge。 |
| WP4 | 双网络模式与跨框架验收 | 本地无 OpenCode 的 Python 标准库 HTTP + 实际 SDK MCP stdio 独立进程，经 CA/主机名验证 TLS 完成文本/二进制、离线补收、journal-before-ACK、JS 顺序重启/游标去重、旧 fence 拒绝、关联回复及 Python ACK/read；但非 clean clone / `npm ci`，未认证真实第三方框架或 Python 崩溃 journal。真实双机 LAN、不同网络互联网 TLS（资源/凭据另获授权）、完整跨框架部署验收仍待完成。 |

客户端主动出站 HTTP/SSE，无须 P2P、NAT 穿透或跨中心联邦。core / 通用 client / MCP 适配与宿主 UI、coding 模板分离；OpenCode 提醒及原生 question 只是可选宿主体验，当前旧适配层安全交互规则不静默废除。当前 SQLite、10 MiB 单附件和校验可复用，但旧 IP→member LAN 入口**不等于 v1 验收通过**；README 的[当前能力与边界](../README.md#当前能力与边界)仍是实际可用说明。旧中心 `/api/unread-events` 的运行 SSE 已恢复为 200，但不是 IM A1/A2/A3 验收；内存事件环不作可靠同步源，源码或本地测试不代表用户已升级中心与插件。

**A1–A8 验收快照（仅本地证据，不替代 PRD 的外部验收）：** A1 同 IP/ACL 本地覆盖，真实双机 LAN 未过；A2 不同网络互联网 TLS 未测；A3 lease/同步/ACK/journal 及本地实际进程重启/崩溃路径已有证据，隔离恢复候选可写且经 TLS 续接，但尚非完整部署/掉电认证；A4 幂等、附件失败路径有本地测试，响应丢失与外部端到端证据未齐；A5 新旧权限与读取语义及本地迁移/恢复切片有验证，生产恢复演练/审批子系统未完成；A6 不可信内容/不执行有本地契约，不等于所有宿主获得安全认证；A7 本地无 OpenCode 的独立 Python HTTP + SDK MCP stdio 进程互通已通过，clean clone / `npm ci`、真实第三方框架与 Python 崩溃恢复未验收；A8 治理文件本地存在，许可暂缓、私密安全渠道和实际 GitHub CI/发布治理未验收。分批、版本绑定的验证计数与未覆盖项见[本地迁移验证与交接](im-migration-validation.md)及[恢复/互通验证](im-local-recovery-interop-validation.md)；不同批次计数不可累加为互异测试。旧 SSE 的 200 不计入 IM 验收。

**下一步（依赖顺序）：**本地 A/B/C 迁移包维持已验收的限定范围；新增隔离恢复及无宿主互通批次经代码 gen8、PRD exp5、性能/安全 ora3 和独立 QA gen9 审查 **PASS（仅限对应本地测试版本）**。仍须由维护者分别批准生产备份、显式 schema 升级、迁移与真实双模式验收；正式发布仍取决于 WP0–WP4 各门槛及资源/治理决定。物理 purge 等待设计批准；本次不据此启动新服务、变更远端或推送。

**IM v2 NONRELEASE P1 增量（2026-09-24，基于 `61052a3`）：**[冻结的恢复/留存契约](im-recovery-retention-v2-design.md)与[实施计划](im-v2-implementation-plan.md)保持独立；仅隔离 v4 schema、fresh 初始化与显式 v3→v4 导入候选的 P1 本地实现/审查通过。旧 v1–v3 schema 常量、旧 LAN 与现有 WP0–WP4 门槛不变；候选仍 prepared/paused，未实现 P2 wire、启写/激活或物理清除。版本绑定的测试、审查、限制与后续 P2–P7 门禁见 [P1 验证记录](im-v2-p1-validation.md)；这不是 WP0–WP4、整份 PRD 或生产发布验收。

**IM v2 NONRELEASE P2 增量（2026-09-24，基于 `8379179` 加八份 P2 源码/测试）：**独立 v2 contracts/config、clock、auth 与 ACL 边界经限定范围本地审查和验证通过；默认 disabled/paused，未开启新服务或写入。此处仅更新 P2 状态，不改变上方 WP0–WP4 的顺序、已存在门槛或旧 LAN/v1–v3 行为。P3 发送/delivery/HTTP、P4 journal、P5 备份恢复/激活、P6 留存维护/物理清理、P7 外部与跨平台验收仍未交付；人工 H1–H3 门禁仍独立待批。证据与局限见 [P2 验证记录](im-v2-p2-validation.md)。

**IM v2 NONRELEASE P3 A/B 核心增量（2026-09-24，基于 `55652a4` 加 15 份限定范围 overlay）：**消息与有界投递核心及内部只读投影已完成本地限定范围审查和验证；详情及证据边界见 [P3 核心验证记录](im-v2-p3-core-validation.md)。**P3-C HTTP 增量（2026-09-25，基于 `5cf5a13` 加四份源码/测试 overlay）：**独立 v2 HTTP handler 与中心组合 factory 已完成限定范围本地验证，见 [P3-C HTTP 验证记录](im-v2-p3-http-validation.md)。此处仅更新 P3-C 本地状态，不宣称完整 P3 外部交付或生产就绪。默认仍 disabled/paused；测试中的 active 候选只用于隔离 fixture，不是实际激活或监听。上方 WP0–WP4 原有顺序和未满足门槛保持不变；P4 journal、P5 备份恢复/激活、P6 留存维护/物理清理、P7 真实网络与外部跨平台验收仍待完成，人工 H1–H3 门禁不变。旧 LAN `18787` 入口未强制下线或更改。

**IM v2 NONRELEASE P4 存储切片（2026-09-25，基于 `01ca825` 加 11 份存储源码/测试/fixture）：**独立 journal v2 schema、journal 与严格本地附件文件存储的限定范围审查及分版本本地 QA 已通过，详见 [P4 存储验证记录](im-v2-p4-storage-validation.md)。这是 P4 的**存储切片**，不是完整 P4：journal 尚未由 consumer owner 持有或绑定；owner lock/client 尚未实现或验收。P5 激活/恢复、P6 物理清理、P7 真实网络及 H1–H3 人工门禁仍独立待完成。上方 WP0–WP4 顺序及旧 LAN 行为不变；无自动迁移、启用或删除。

**IM v2 NONRELEASE P4 owner 局部增量（2026-09-25，基于 `24b45e7` 加四份 owner 源码/测试/fixture overlay）：**可信离线打开、显式 journal 绑定及单消费者锁已通过限定范围审查和分平台本地验证，详见 [P4 owner 验证记录](im-v2-journal-owner-validation.md)。本增量不自动注册、不包含 consumer client；P4 仍未完成，P5–P7、H1–H3 与上方 WP0–WP4 门槛不变。仅新 v2 client 的严格 owner 限原生 Unix，Windows 拒绝；旧 LAN 不变，未激活、删除或发布。

**IM v2 NONRELEASE P4 client 局部增量（2026-09-25，基于 `7f0d0f6` 的独立 16 文件 overlay）：**通用客户端编排、journal change stamp、离线 owner 绑定、持久收发与有界对账完成限定范围本地验证；详见 [P4 client 验证记录](im-v2-p4-client-validation.md)。本地 P4 client 切片并非整份 PRD、部署或生产发布验收；严格新客户端仅支持原生 Unix，旧 Windows LAN 不变。P5 恢复控制、P6 清理、P7 真实双机 LAN/不同网络互联网与 H1–H3 仍待完成；30 天备份保留窗口未确认，未授权服务启动、迁移、恢复切换、物理删除或发布。

**IM v2 NONRELEASE P5-A 备份存储局部增量（2026-09-25，基于 `f3d1709` 加 23 份限定 overlay）：**独立 v4 原生备份、私有 record-v3 仓库、可信注册 v3 独立副本与持久 hold/prepare 绑定完成限定范围审查和隔离验证；详情及旧 WAL artifact-read 收紧见 [P5-A 备份验证记录](im-v2-p5-backup-validation.md)。这是 P5-A 存储切片，**不是**完整 P5 或生产恢复批准；清理始终禁用，未公开 release writer。P5-B stage/plan/prepare/status、P5-C verify/seal/activate/release、P5-D 崩溃矩阵，以及 P6/P7、H1–H3 和 30 天备份保留确认仍待完成。上方 WP0–WP4 顺序、旧 LAN `18787` 和原有门槛不变；未启用新监听、自动删除、恢复切换或发布。

**IM v2 NONRELEASE P5-B 恢复准备局部增量（2026-09-25，基于 `2085da6` 与 27 份限定 overlay）：**隔离恢复候选的 stage / preview / prepare / readonly status 已完成限定范围本地实现、审查与分平台验证；详见 [P5-B 恢复准备验证记录](im-v2-p5-prepare-validation.md)。这是 P5-B 本地切片，不代表 P5 全生命周期或生产恢复批准。候选保持 prepared/paused，不创建监听、不自动启用；P5-C seal/activation/release、P5-D 完整故障矩阵、P6 物理清理、P7 真实网络验收与 H1–H3 人工批准仍待完成。此增量不变更旧 LAN 或上方 WP0–WP4 门槛；前述 P5-A 段落记录其当时快照，勿将其“P5-B 待完成”误作当前状态。

**IM v2 NONRELEASE P5-C C0+C1 局部增量（2026-09-25，基于 `9e3bca5` 与 23 份限定 overlay）：**纯 seal / activation / completion / release-plan / status v2 编解码器、私有 hold 读取及 release capability（C0 fixture 验证，**并非**运行时 release），以及运行时 verify / activation preview / activate 已通过独立限定范围代码、安全、契约忠实度及 QA 门禁；见 [P5-C 激活验证记录](im-v2-p5-activation-validation.md)。运行时 facade 共七个方法，**尚无** releaseRecoveryHold 或 status v2；激活后仍 paused、不监听。P5-C C2 release/status v2、P5-D 完整故障矩阵、P6 purge、P7 实网与 H1–H3 实际运营确认仍待完成；没有授权真实恢复、来源隔离、激活、删除或发布。以上为本地候选证据而非提交后重跑；不改变原 WP0–WP4 顺序、既有门槛或旧 LAN。前述 P5-B 段落保留其当时快照。

**IM v2 NONRELEASE P5-C C2 局部增量（2026-09-25，基于 `02e6f2` 与 14 份限定 overlay）：**运行时增加 `releaseRecoveryHold` 与显式迁移后的 status v2，共八个同步恢复方法；旧纯 status 编解码器仍保留。仅 active 且实际 DB、受保护 completion 和真正 hold 匹配时才能导出 release plan 并取得独立审批；发布持久 marker **不删除** hold/备份、不开放 TTL 或清理，`cleanupAllowed` 始终为 false/HOLD。精确重试无逻辑 DB/时钟/epoch/审计变更，仍须执行六处同步；只读 status/B 读取不修复。限定范围的代码、安全、契约忠实度及独立 QA 均 PASS，见 [P5-C C2 release/status v2 验证记录](im-v2-p5-release-validation.md)。这是提交前本地候选证据，非提交后 clean commit 重跑；P5-D 完整故障矩阵、P6 留存清理、P7 真实网络、H1–H3 人工许可和 30 天备份窗口确认仍待完成。无真实用户操作获批，不变更 WP0–WP4 原有顺序、门槛或旧 LAN。前述 C0+C1 段落保留其当时快照。

**IM v2 NONRELEASE P5-D 进程恢复矩阵增量（2026-09-25，基于 `4884b65c` 加六份测试/fixture overlay）：**A6/B13/C10/D5/E3/F4/G2 共 43 个指定场景，39 个软件 SIGKILL 故障和四条独立进程正常退出链，限定范围 test-design 审查与最终 artifact QA 均 PASS；分版本兼容验证和证据保留局限见 [P5-D 进程恢复验证记录](im-v2-p5-process-validation.md)。恢复仅能遵守既定契约或保守拒绝，不保证任意故障恢复；原生证据不是硬件掉电、外部生产恢复或旧写入方全局 fencing 的证明。P5-A–D 本地切片有界验证不等于整项目发布/生产就绪；P6 留存 planner/purge 默认关闭与设计批准、P7 真正双机 LAN/跨网及 H1–H3 人工确认、30 天备份 TTL 确认仍未完成。此前各增量段落保留当时快照；原 WP0–WP4 顺序、门槛及旧 LAN 不变，不授权启用监听、自动接管、物理清理或发布。

**IM v2 NONRELEASE P6-A 只读预览增量（2026-09-26，基于 `609a97a` 加 15 份限定 overlay）：**五导出纯 plan/cursor 编解码、严格 schema4 离线借用连接的留存预览与仅配置诊断的备份预览完成限定范围本地 artifact QA；版本绑定计数、环境与限制见 [P6-A 预览验证记录](im-v2-p6-preview-validation.md)。所有 v4 计划均不可执行（`SCHEMA_UPGRADE_REQUIRED`）；过期与清除分批，备份不枚举、不授权 TTL 或删除。默认 expiry/purge/backup cleanup 继续关闭，未实现 apply/executor/status，v5 schema/时间锚/转换/运行时与备份恢复兼容仍为设计门槛。P6-B/C、P7、H1–H3 与备份 TTL 确认均待完成；不改变上方 WP0–WP4 顺序、旧 LAN 或运营门禁，不授权真实数据操作或发布。

**IM v2 NONRELEASE P6-B0.1 schema 5 存储校验增量（2026-09-26，基于 `65d0727` 加 14 份限定 overlay）：**精确 schema 5 DDL/manifest（58 个对象、checksum `80eba5e6ce61261d31ec495216c3b6eb8c7a8f0c87edcbb1440372353f495435`）、完整 4/5 校验分派、全局跨 epoch 连续时间锚历史与可选当前 tip/head、类型化转换历史和五种纯规范记录编解码完成本地限定范围 QA；详见 [B0.1 验证记录](im-v2-p6-schema-v5-validation.md)。继承校验器仅机械抽取，不放宽 v4 接受条件；冻结的 v4 checksum、公开导出、fresh4/import4 与历史 goldens 不变。此处是**提交前候选证据**，不宣称提交后 clean commit 重跑，也不将 B0.1 误写成整个 P6 完成：纯记录与一致性校验不构成授权或维护会话；尚无转换器、私有 ownership bridge、时间权威、写执行器或 v5 运行时备份恢复兼容。B0.2/B0.3、runtime→backup→registry→versioned recovery→facade 的兼容与 v5 roundtrip、实际启用/删除、P7 和 H1–H3 均待独立门禁；v4 预览仍不可执行，备份 TTL 未确认，备份预览仅配置诊断。原 WP0–WP4 顺序、旧 LAN、默认关闭策略及运营门槛不变。

**IM v2 NONRELEASE P6-B0.2a 转换所有权桥增量（2026-09-26，基于 `7c98249` 加限定源码/测试/契约 overlay）：**真实恢复 facade 内私有转换目标、规范 owner/intent/paused 证据、候选专用暂停和旧八方法的认领分支排除完成限定范围独立 QA；源码/测试与两份既有契约按冻结哈希验收，详见 [B0.2a 验证记录](im-v2-p6-conversion-bridge-validation.md)。这不是提交后 clean commit 重跑、schema 5 转换、时间权威或运行时启用。B0.2b 实际转换器、B0.3 时间权威、runtime→backup→registry→新版恢复家族→facade 兼容及 v5 往返、P6 写执行器、P7、H1–H3 与备份 TTL 确认仍待独立门禁；WP0–WP4 顺序、旧 LAN、默认关闭及运营批准不变，不授权真实恢复/删除/监听/发布。

**IM v2 NONRELEASE P6-B0.2b 转换引擎局部增量（2026-09-28，基于 `d9d0907` + 19 份限定 overlay）：**私有真实归属桥上的候选 schema 4→5 转换、独立审批与原预算/期限/文件系统约束、实际事务和完整 v5 校验、COMMIT 不确定性调和及精确完成重试已获 gen145 限定范围 QA PASS；两份设计契约另行审查，不作执行 overlay。见 [B0.2b 转换引擎验证记录](im-v2-p6-conversion-engine-validation.md)。这是提交前冻结候选的本地证据，**不是**新 clean commit 重跑、完整 P6 或运营授权；历史红测/缺失证据不能追认。B0.3 时间权威、runtime 5→backup manifest 3→registry 4→新恢复家族→facade 兼容及 v5 往返、维护写执行器、P7、H1–H3 和备份 TTL 确认仍待各自门禁。此前 B0.2a 段落保留当时快照；WP0–WP4 顺序、旧 LAN、默认关闭/暂停及生产批准不变，不授权迁移、真实恢复、启用、删除、监听或发布。

**v1 非目标：**群聊、音视频、全球发现、多租户跨组织审批、联邦、多中心/HA/broker、大文件/多附件/断点续传、完整官方 A2A 协议 adapter、自动值守上线及外部动作 exactly-once。地址可预留 domain 命名空间、会话成员模型可演进，但本轮不做群聊，也不把永久中心 URL 编入 Agent ID。品牌本轮只改文档；包、bin、MCP 名称、远端仓库 rename 后续须经用户批准和实测。许可证、保留期限与预算待维护者确认；公开仓库不等于已有开源许可。
