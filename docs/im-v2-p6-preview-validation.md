# IM v2 P6-A 只读预览验证记录（NONRELEASE）

**范围与版本：**基线 `609a97acd1fc78e5393a2e52154be809353df9d6` 加 15 份已接受源码、测试、fixture 和三份既有契约 overlay；本记录与[路线图](roadmap.md)为另两份文档。15 文件清单及 SHA-256 绑定到 `p6a-final-f7c346f821/manifest.json`（清单 SHA-256 `c01d15b9f845b45271255fe6d9361d2690ace83134a71e453f9a54106d12e8fc`）；其 populated accepted map 仅用于文件清单与哈希，不作为测试执行前快照。独立执行 provenance 为 `p6a-provenance-20260926-9381/setup.json`（SHA-256 `ee535deecd1feef7bb66b8fe5b8283fbda3c9c655d2c6d3ad71612c703cd6584`），每个 run ID 有独立 before/after 捕获。以下是**基线加 overlay 的候选执行证据**，不是未来提交后 clean commit 的重跑或上线验收；P6-A 源码与最终 artifact QA 均 PASS。

## 本地切片与不可越过的边界

- `maintenance-plan.js` 的五个纯导出实现 canonical plan/cursor 编解码和域分离哈希；授权先于目标检查及结果披露。预览使用严格 schema4、原生 Unix、离线 quiescent DELETE 模式的借用连接：可信 owner 必须预先建立原始 DB/path 配对并维持替换排除，在释放所有权/关闭 DB 前使能力失效。它不证明任意已打开句柄的 inode，也不支持 live writer、任意 handle 或 Windows 保护绕过。
- 同一快照中验证完整原始事实指纹（包括历史 v1 epoch/发送事实）；逐组在读取重体或 BLOB **之前**投影并预留精确行、字节及 framing 预算。不可拆组或跳过超出剩余额度的组打包后续项；固定 cutoff/cursor，有限 monotonic elapsed 的软报告边界，并非正在运行的 SQLite 调用的硬中断。过期与 scrub 分开；所有成功 v4 计划 `executable:false`、`SCHEMA_UPGRADE_REQUIRED` 且 anchor/session 字段均为 null。
- 无逻辑 DB/clock/run 写入、文件内容/mtime 写入或副作用式预览；OS atime 不在承诺范围。配置专用备份预览不枚举 registry、备份或受保护引用；`protectedRefs:[]` 表示**未枚举**，不是没有受保护对象。它不确认 TTL、不授权备份删除。expiry/purge/backup cleanup 全部仍 OFF；无 apply、executor 或 status stub，更无真实生产操作。
- [维护契约](im-v2-maintenance-contract.md)、[计划契约](im-v2-maintenance-plan-contract.md)及 [v5 设计契约](im-v2-maintenance-schema-v5-contract.md)三份既有文本作为已接受 overlay 保持不变；其中旧的“未实现/文档专用”状态行是该阶段的设计快照，不是本次实现状态。v5 schema、独立时间锚、converter、runtime 和 backup/recovery 兼容门禁仍**仅设计、未实现**；P6-B/C 执行与故障验证、P7 外部验收、H1–H3 人工运营审批均待完成，备份 TTL 仍 null/未确认。

## 执行证据和局限

| 独立执行标签 | 范围与结果 |
| --- | --- |
| `windows-target-d2d040c63c6c` | 四项 P6-A target：370 total / 258 pass / 112 skip / 0 fail。 |
| `windows-full-0cebf00ed084` | 全套 Windows：1920 total / 1318 pass / 602 skip / 0 fail。 |
| `windows-plugins-058c1ec33742` | 显式插件检查：46 pass / 0 skip。 |
| `native-target-b8f4156f127d` | 原生 Unix 四项 target：370 total / 368 pass / 2 Windows skip / 0 fail。独立 WSL outer 退出码 0。 |

计数有交集，**不可求和为互异用例**；Windows 上跳过的原生保护断言不是通过，未运行完整 Linux 仓库测试，也未调用生成器或 fixture preflight。Windows 和原生依赖均重用先前隔离的 `npm ci` 产物，经相同 lock 和 95 个已安装包版本核对，**不是**本轮新鲜安装；更早的 Windows `npm ci` 只提供安装来源证据。执行 Node `v24.19.0`、Node SQLite `3.53.3`、原生扩展 4；原生 setup 元数据的 Python SQLite `3.45.1` **不是** Node 引擎版本。原生 euid 0、umask 0077、私有 TMP 0700 环境及路径元数据有执行前后捕获。首次新原生 clone 在测试启动前因 setup 权限失败；随后在私有 0700 环境重新建立的新 clone 才产生上述通过结果，未 chmod 既有共享根目录或放宽策略。

执行绑定具有 source15、candidate15 和 tracked240 的前后哈希图；原生 target before `66a7217d6ea40a0d54799d0c487677d76aca064b9522b140c8c10ba1b78ed5f9`、after `4a80c5f77414354c7fa909aa5c0547ab5f45c6769e02f6e57859acc9ab4e658d`，outer `5152421955231c4821935b7c36c743e3dff5796b974f65bc63943e85615745fa`。旧原生批次 273 pass / 95 fail / 2 skip、退出码 1，仍是历史**失败**，不以新执行改写；更早历史运行的环境和运行绑定哈希缺失，不倒填。没有硬件掉电、全局 fencing 或生产零写认证结论。工作区其他未提交文件、生成器、运行器及证据目录不在 15 文件接受清单内，亦不构成本次证据或发布授权。
