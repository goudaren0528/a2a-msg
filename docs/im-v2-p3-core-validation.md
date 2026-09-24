# IM v2 P3 A/B 核心本地验证记录（NONRELEASE）

**版本与范围。**基于 `55652a4416f0367b3b379d54cdbff0579cdfc493` 加 15 份源码、测试、fixture 与两份冻结契约/实施计划文档 overlay 验证；此处记录的是该基线与 overlay 的证据，**不是**后来干净提交的重新执行结果。执行 manifest SHA-256 `2B04B5817700A954FB3061E8055DF7F6EBD698BF0B2FA634BB6833F01556A16E`；独立复核的 13 份代码/测试/fixture 清单 SHA-256 `FEC9D57FD3F60939FB7BF0050E775CE99D12FFFEA493F25DC5A6A1509445CFDE`。参见[路线图](roadmap.md)、[冻结契约](im-recovery-retention-v2-design.md)、[实施计划](im-v2-implementation-plan.md)与[P2 验证](im-v2-p2-validation.md)。四项独立来源/安全/契约及最终 QA（gen35）结论均为限定范围 PASS；不是完整 P3 或生产验收。

**A：消息核心。**九个消息 API 覆盖消息、附件 reservation、operation mapping、content、delivery 与 audit 的原子事实写入和发送幂等；同 epoch 重放与冲突、旧 origin 查询/未知结果、旧 origin POST 拒绝及真正到期后的 key 不复用分别处理。授权与有效期检查不将未知旧结果误认成可安全重发。内部共享 projector 只投影 metadata；仍须 auth scope 与 ACL，绝非公开授权捷径。

**B：有界投递。**六个 delivery API 处理 lease/fence、同步、真实 ACK 与到期 receipt 的分离：receipt 不冒充 `acked_at`/`read_at`；单批不超过 100，单次最多推进 1000 个不同 seq 前缀，并最多留下两个 pending probe。真实的 1002 条已发出、乱序 pending、文件关闭与新 guard 续接路径已覆盖；过期但先前已 handled 的事实只按证据推进。v4 运行时持久 ACK cursor 可以落后于最大真实连续 ACK 前缀（每次推进有界），但不能超出真实 ACK 证明和持久 handled；v3 导入仍要求最大连续真实 ACK 前缀，不改 DDL/checksum。trusted `finalCheck` 位于最后 auth 刷新和 lease 核验之后，使用最终观察时刻，hook 后不再取样；不允许借旧快照恢复或复制 live DB 绕开门禁。

**限定测试证据。**Windows Node 24.19：隔离 fresh `npm ci` 安装 95 packages、退出码 0；九份目标测试 457 pass、0 skip、21.73s；完整测试 848 total / 791 pass / 57 skip / 0 fail、54.35s。实际 OpenCode 插件五份指定文件分别 1/4/30/5/6 pass，合计 46 pass、0 skip。Linux 原生 ext4、Node 24.19：九份目标 457 pass、0 skip、约 30s，复用经匹配核对的 95 个已安装依赖，**不是** Linux fresh install。不同批次测试有重叠，不可相加为互异覆盖，也不能把平台 skip 说成已执行。最终 QA 核对 205 份非 overlay 跟踪文件在 Windows CRLF 归一化后未改；外来源码未进入本验证 overlay。

**未完成及授权边界。**P3-C HTTP/server、P4 journal/client、P5 备份恢复/激活、P6 留存维护/物理 purge、P7 外部真实网络与跨平台交付仍待执行。默认 disabled/paused；active fixture **仅用于 TEST**，不构成启写批准。旧 LAN、生产数据库、历史 v1–v3 schema/DDL/checksum/golden 均不在本轮变更或操作范围内。备份 30 天 TTL 仍未确认；人工 H1 源隔离/凭据/恢复证据、H2 实际启用/清理/备份 TTL、H3 公网 TLS/DNS/资源费用均须另行批准。未启动生产服务、迁移、物理删除或推送；没有 SyberMem 绑定或写入记录。
