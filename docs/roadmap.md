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

**v1 非目标：**群聊、音视频、全球发现、多租户跨组织审批、联邦、多中心/HA/broker、大文件/多附件/断点续传、完整官方 A2A 协议 adapter、自动值守上线及外部动作 exactly-once。地址可预留 domain 命名空间、会话成员模型可演进，但本轮不做群聊，也不把永久中心 URL 编入 Agent ID。品牌本轮只改文档；包、bin、MCP 名称、远端仓库 rename 后续须经用户批准和实测。许可证、保留期限与预算待维护者确认；公开仓库不等于已有开源许可。
