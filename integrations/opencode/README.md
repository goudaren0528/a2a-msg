# OpenCode 未读侧栏与消息阅读

## SSE 更新（替代下文旧版轮询说明）

运行时不再定时请求 unread-summary。插件 setup 创建唯一 `GET /api/unread-events` 流，侧栏隐藏时仍接收事件、更新数量并用原生 toast 提示。多个 View 不重复连接；退出插件 abort 连接并清理重连、watchdog、toast 合并定时器。`pollMs` 旧配置兼容保留但忽略，不控制轮询；旧纯 core 轮询导出仅保留回归兼容。

目录安装现在为 **六个运行文件**：`tui.tsx`、`team-mailbox-unread.tsx`、`sidebar-setup.mjs`、`unread-core.mjs`、`unread-detail.mjs`、新增 **`unread-events.mjs`**。先部署支持 SSE 的中心，再由安装负责人同步这六个文件；本次源码实现不代表已安装。缺少端点时明确显示 404 升级提示，不回退轮询。

协议：无 query，source 身份；event 为 unread，id 与 data.cursor 完全一致，cursor 为 UUID epoch 加安全整数 seq。summary 仍只含 counts。客户端内存保存成功处理的游标，以 Last-Event-ID 重连，同 epoch 去重/拒倒序、允许 seq 跳号；epoch 改变需 reset。首次 snapshot、read、reset 不 toast；message 每帧计 1 条，500ms 合并显示「收到 N 条新消息」，不含发送人/标题/正文，不触发 prompt/focus/dialog。reset 清除待合并提示。服务器没有持久 replay，重连只收到 snapshot/reset 时不能承诺补齐断线期间通知。

连接建立超时 10s，空闲 watchdog 65s（高于服务端 20s comment 心跳），重连指数退避带 jitter、最高 30s；帧累计上限 64KiB，UTF-8/CRLF/跨 chunk/多行 data 均解析。元数据仍只在用户展开/刷新或已展开列表被新事件失效时按需请求，事件合并刷新不恢复周期查询。nullable title 修复保留。

验证：`node --test integrations/opencode/*.test.mjs`。流解析/重连/toast 单测不证明真实 TUI toast 已出现；中心与插件安装后，须实际验收隐藏侧栏收消息提示、重连以及展开列表刷新。本 lane 未安装全局、未改配置、未重启。

### 展开失败修正：可空标题

实际中心可返回 `title: null`（无标题消息）。前端必须接受该值并显示「（无标题）」，不能因一条无标题记录拒绝整页。已用真实中心两组 HTTP 200 响应验证：4 条（其中 2 条 null 标题）和 1 条（null 标题）均可解析；验证不查询正文、不标读，也不输出真实标题。错误提示区分断线、超时、400 参数错误、404 需升级和响应格式不兼容。没有正文摘要接口回退。

## V2.0.15 本地加载修正（优先于下文旧版安装步骤）

**不能把 `cli.json` 的 package 指向单个 `.tsx` 文件。** 官方 v2.0.15 `packages/tui/src/plugin/context.tsx` 在 reconcile 中对 `stat(local).isFile()` 直接 `continue`，在 import/setup 之前跳过普通文件；`discovery.ts` 也只发现目录。该行为会导致没有 setup/slot 日志。已安装文件哈希一致不代表被加载。

正确安装形态是本地插件目录，共五个运行文件：

```text
~/.config/opencode/plugins/team-mailbox-unread/
  tui.tsx
  team-mailbox-unread.tsx
  sidebar-setup.mjs
  unread-core.mjs
  unread-detail.mjs
```

`tui.tsx` 为 V2 目录入口，转出原 `Plugin.define`。2.0.15 `@opencode/plugin/dist/host.js` 的 `Host.resolve` 对本地目录解析 `tui`，不以原任意文件名作为入口。

```json
{"plugins":[{"package":"./plugins/team-mailbox-unread","options":{"serverUrl":"http://<central-host>:8787","pollMs":30000}}]}
```

安装负责人应先备份现有全局项，将同一 mailbox 项的 package 改为目录路径，保留其他配置和 options；将以上五个文件复制到目录并核对哈希。旧平铺文件不要未经批准删除。不要仅再次覆盖旧四文件而保留 `.tsx` package 路径。此修正尚需目标 TUI 中的 `/plugins` 状态、setup/slot 挂载和实际显示验收；源码根因证据不等于修正后的真实 UI 已通过。

在 OpenCode V2 TUI 的右侧栏常驻显示 team-mailbox 的未读消息概况。**OpenCode 标准安装必须完成 MCP bridge、四个侧栏运行文件、显式 `cli.json` plugins 对象（`serverUrl`、`pollMs`）、阅读 Skill 和 command；初装与更新均不能跳过。** 其他客户端不安装这些 OpenCode 专属集成。

```
📬 未读消息 · 3
甲  1 条
乙  2 条 · 📎 1 附件
```

常驻摘要只显示发件人、条数、附件数，不读取标题或正文；点击发件人后才按需请求未读元数据并显示短标题。点击标题向当前会话提交明确数字 ID 的阅读请求，正文由阅读 Skill 处理。零未读时显示「暂无未读消息」。

## 文件

| 文件 | 作用 |
|---|---|
| `team-mailbox-unread.tsx` | V2 插件入口，注册 `sidebar.content` slot 并绑定 Solid 渲染 |
| `sidebar-setup.mjs` | V2 slot 注册、配置与注销生命周期适配 |
| `unread-core.mjs` | 纯逻辑：响应校验、格式化、行数截断、轮询间隔下限 |
| `unread-detail.mjs` | 按需获取未读元数据、清洗标题、明确 ID 阅读与防重复提交 |
| `unread-core.test.mjs`、`sidebar-setup.test.mjs`、`unread-detail.test.mjs` | Node 测试：核心轮询、V2 注册适配及元数据阅读逻辑 |

安装用的 `team-mailbox-unread.tsx`、`sidebar-setup.mjs`、`unread-core.mjs` 与 `unread-detail.mjs` 必须放在同一目录；不必安装测试文件。旧版副本缺少任一运行文件时插件不能加载。

## 安装

1. 把本目录的 `team-mailbox-unread.tsx`、`sidebar-setup.mjs`、`unread-core.mjs` 和 `unread-detail.mjs` 复制到 OpenCode 的插件目录：

   - 全局：`~/.config/opencode/plugins/`（Windows：`%USERPROFILE%\.config\opencode\plugins\`）
   - 或项目级：`<项目目录>/.opencode/plugins/`

2. 在全局配置根的 `cli.json` 的 `plugins` 数组中配置 CLI-only 插件对象（不要把此插件放入服务端 `opencode.json(c)` 的插件列表，也不使用旧 `tui.json`）：

    `~/.config/opencode/cli.json`

   ```json
   {
      "$schema": "https://opencode.ai/v2/cli.json",
      "plugins": [{"package": "./plugins/team-mailbox-unread.tsx", "options": {"serverUrl": "http://<central-host>:8787", "pollMs": 30000}}]
   }
   ```

    路径相对于该 `cli.json` 所在目录。先备份已有文件；已有 V2 team-mailbox 项原位更新，缺少才新增，保留其他插件和配置，不追加重复项。旧 `tui.json` 的 V1 tuple 不会加载此 V2 入口，迁移时应由安装负责人备份并移除旧项，避免误认生效。CLI-only 配置在远程服务连接时仍由本地 CLI 加载。

3. 将 `serverUrl` 替换为管理员提供的共享中心 HTTP(S) 地址，不是本机 localhost（除非自己就是中心），也不是 Node 或 bridge 路径。无需永久环境变量。完全退出并重启 OpenCode，进入会话并展开侧栏；挂载立即拉取，正常变化约 0–30 秒加网络耗时体现，非硬实时。成功返回 `total: 0` 时显示空态，连接异常显示提示。可用 `get_unread_summary` 核对条数，用同一中心地址运行 `npm run doctor` 检查连通性和身份。

MCP 可独立收发，插件失败不会丢消息；但缺装或加载失败须报告阻塞与排障步骤，不能仅凭 MCP 连通报告 OpenCode 标准安装完成。

## 安装/更新验收清单

1. 记录 checkout revision 与 OpenCode V2 版本；旧版 1.18.31 的显示记录不证明 V2 兼容。
2. 对四个侧栏文件各自记录源文件及安装副本 SHA-256 并比较（PowerShell 可用 `Get-FileHash -Algorithm SHA256 -LiteralPath '<文件路径>'`），确认安装副本同目录；Skill 和 command 在同作用域安装/更新。
3. 备份并核对全局 `cli.json` 的 `plugins` 恰有一个 team-mailbox `{package, options}` 对象，显式配置管理员中心 `serverUrl` 和 `pollMs: 30000`。不在 `tui.json` 配置本插件；保留其他插件/设置。无需永久环境变量或绝对下载目录配置。
4. 完全退出重启 OpenCode，确认十二个 MCP 工具（包括 `capabilities`）、doctor 身份正确，以及 `/team-mailbox-read` 可用，不打开真实消息。
5. 进入会话并展开侧栏；中心可达、`get_unread_summary` 返回 `total > 0` 时，等待本次拉取或下一轮更新后核对区块与条数（通常 0–30 秒加网络耗时，非硬实时）。零未读应显示空态；异常旧数据不能用于当前数量验收。点击发件人核对按需短标题及分页、失败提示，点击标题会发起真实阅读，不得为验收擅自打开消息。
6. 每项报告通过、阻塞或未验收及证据。无法观察 UI 时明确记录未验收、标准安装/更新未完成。不能自动发测试消息、读真实正文或标读来验证；缺装/加载失败必须排障，不能降为跳过项。

## 原生选择、默认收件与完整阅读

“查看消息”“读消息”“查看某人的消息”和阅读工单消息属于 read，不因 TEST 关键词转入 dispatch。多条浏览必须先原生 question，禁止 assistant 用 Markdown 候选列表或表格替代；不可用时先说明并征求替代，不静默降级。明确 ID 且明确直接阅读时免选，先用 getmsg 查附件元数据、先保存后读正文。Skill/command 与工具描述是 Agent 指引，不是 runtime 强制；不能保证宿主隐藏工具原始 JSON。

**单条未读免选择：** 仅当筛选范围内确实只有一条（`unread_only=true`、本轮第一页且未传 cursor 或 `cursor=0`、`messages.length=1`、`hasMore=false`）时，用户本次查看意图即授权直接先收附件（`receive_attachment` 仅传 `attachment_id`，保存校验成功后）再呈现完整正文，不反复确认。多条、全部模式、后续页、局部过滤或完整性不确定仍走原生 question；0 条不读取不下载；取消后重新请求需重新查询，不复用旧判断。附件失败仍须重试／明确跳过／取消，不静默继续读正文。

本版中心已读修复：非空正文 offset>=totalLength 仍返回 200 空 text，但不标读；空正文只有 offset=0 标读。正常有效末页仍标读，hasMore=false 本身不足以证明有效末页。中心须管理员另行更新服务并重启，无数据库迁移；业务 IP 配置与本版公开发布无关。

安装文件映射（全局配置根为 `~/.config/opencode/`，项目级为 `<项目目录>/.opencode/`）：

| 仓库内源文件 | 配置根内目标 |
| --- | --- |
| `skills/team-mailbox-read/` 整个文件夹 | `skills/team-mailbox-read/` |
| `commands/team-mailbox-read.md` | `command/team-mailbox-read.md`（单数 command） |

命令 `/team-mailbox-read` 按名称加载 Skill。由 Agent 调用原生 question，每页最多 10 条消息及导航/取消，保留真实 id，不用 Markdown 消息列表。默认未读、可切全部，尊重过滤；getmsg 按 id 升序，不是全局最新倒序。取消/翻页不读正文、不下载、不标读。未知自定义答案不猜 id。

**单条未读免选择：** 仅当筛选范围内确实只有一条（`unread_only=true`、本轮第一页且未传 cursor 或 `cursor=0`、`messages.length=1`、`hasMore=false`）时，用户本次查看意图即授权直接先收附件（`receive_attachment` 仅传 `attachment_id`，保存校验成功后）再呈现完整正文，不反复确认。多条、全部模式、后续页、局部过滤或完整性不确定仍走原生 question；0 条不读取不下载；取消后重新请求需重新查询。附件保存失败仍须重试／明确跳过／取消，不静默继续读正文。这是 Agent 指引，不是运行时强制。

无需询问收件目录或配置 MSG_DOWNLOAD_DIR：每个用户运行的 bridge 根据自身 import.meta.url 定位包根，在首次保存时创建独立 downloads/，不受 Agent cwd 影响。启动/列消息不创建；文件占位、symlink/junction 或无权限明确失败。不要复制中心 downloads/。MCP 环境仅需管理员提供的共享地址，示意如下：

```json
{"MSG_SERVER_URL":"http://<central-host>:<port>"}
```

中心地址及端口由管理员提供，不是自己的 localhost（除非本机就是中心）。自动收件首选 receive_attachment，仅传 attachment_id，强制自动命名、不覆盖；save_attachment 仅用于用户指定路径，旧语义保留。高级 MSG_DOWNLOAD_DIR 可覆盖到已有绝对目录，不支持相对值；恢复默认时获准后仅清除本 MCP entry 的旧项，保留其他配置与旧文件。详见[保存契约](../../docs/tools.md)。选中后先保存校验再读全文，失败用原生 question 重试/明确跳过/取消，正文重试不重复下载；成功附 cleanupWarning 时报告后继续，不再次下载。不自动打开或执行附件。

bridge 现在提供 12 个工具，新增的 `capabilities` 是不访问中心的本地只读能力概览。receive_attachment 只有一个必填 ID，即使宿主把 schema 的全部 properties 强制 required，也无需填写路径。缺少工具时提示更新客户端 bridge、重新连接并刷新工具列表，以及更新已安装 Skill，不能猜路径或手动 mkdir 绕过。已运行 bridge 不会因源码更新自动注册新工具；中心无需重启。本次仓库修改不会自动更新用户已安装 Skill 副本。

Skill 属于 Agent 编排指令，不是运行时强制 UI；question 不可用时应说明并确认降级，不静默改回 Markdown。安装后完全退出重启 OpenCode。此处只定义安装契约，不授权 Agent 自行选择目录或改配置。

## 已安装用户更新

先核对以上必装项；此前跳过的文件或 V2 `cli.json` 对象必须补齐，已有项原位更新不重复添加。完成后逐项报告验收清单，UI 未验收不得宣称完整更新成功。新增 `unread-detail.mjs` 为第四个必装文件。

在自己的仓库 git pull --ff-only，有冲突不强制覆盖；更新四个侧栏运行文件、Skill 与 command。V1 用户先备份旧 `tui.json` 并迁移其 team-mailbox tuple 到全局 `cli.json` 的 V2 对象；如存在旧 MSG_DOWNLOAD_DIR，展示移除该项的改动并获准，保留其他 env、插件项和旧下载文件，完全退出重启。单独 pull 不更新插件安装副本。MCP bridge 的 npm 依赖未变，已有用户不需 npm ci，初装仍需。见[主 README 提示词](../../README.zh-CN.md)（其中若仍提及 V1 tuple，以本页 V2 说明为准）。

## 开发测试与验收场景安装

完整复制 `skills/team-mailbox-dispatch/` 到同作用域配置根 `skills/`，包括 references/ 下五个 JSON 模板；将 `commands/team-mailbox-dispatch.md` 放到 `command/`。更新前检查并备份同名自定义内容，保留其他插件/Skill/command，核对所有安装文件 SHA-256，再完全退出重启 OpenCode；不需要重启中心。
`/team-mailbox-dispatch` 按名称加载该 Skill，缺失应停止；自然语言选 Skill 只是引导。只有明确开发测试派发/回报意图才套模板，普通聊天/文件/调查资料不变。先预览并取得明确发送授权，缺必需信息先问；不自动接单执行、不提供服务端校验或持久去重。见[场景与模板](../../docs/work-orders.md)。

## 配置优先级与环境变量回退

V2 `cli.json` 的 `plugins` 对象中 `options` 由 CLI 传入 `setup(context)` 的 `context.options`。`serverUrl`、`pollMs` 分别优先于对应环境变量；只有该键缺省时才回退。显式非法选项会停用本插件，不会回退到另一个中心。`serverUrl` 仅接受无凭据、无 query/hash 的 HTTP(S) URL，HTTP 重定向禁止跟随。`pollMs` 必须为有限正数，最低 10000 毫秒并向下取整；缺省且无环境配置时为 30000。

| 变量 | 必填 | 默认 | 说明 |
|---|---|---|---|
| `MSG_SERVER_URL` | 仅未提供 `serverUrl` 时需要 | 无 | 管理员提供的中心 HTTP(S) 地址；未配置或非法时不渲染。 |
| `MSG_UNREAD_POLL_MS` | 否 | `30000` | 轮询间隔（毫秒）。**最低 10000**，低于此值按 10000 处理；非法值回落到 30000。 |

变量必须对启动 OpenCode 的那个进程可见。`MCP.environment` 只传给 MCP 子进程，不会回传给 TUI；推荐直接使用上面的 V2 `cli.json` 插件对象配置。

## V2 官方接口与验证边界

按 [CLI 插件 API](https://opencode.ai/v2/docs/build/plugins/cli)、[V1 迁移说明](https://opencode.ai/v2/docs/build/plugins/migrate-v1)、[CLI-only 配置](https://opencode.ai/v2/docs/cli/plugins) 与 [V2 主题](https://opencode.ai/v2/docs/cli/theme)：入口默认导出 `Plugin.define({id, setup})`，`context.options` 接收配置，`context.ui.slot({append: "sidebar.content", render})` 返回注销函数，`setup` 返回清理函数。Solid 组件通过 `usePlugin()` 读取当前主题；V2 `@opencode/theme` 解析后的 `hue` 仅提供 `accent`、`interactive`、`neutral` 三个别名，因此错误与附件分别使用 `theme.text.feedback.error.base`、`theme.text.feedback.warning.base`。

验证边界：Node 测试执行真实 `sidebar-setup.mjs` 适配层及不变的 `unread-core.mjs`，检查 slot 注册/options/清理与轮询 abort；该适配测试模拟 V2 上下文，**不等同于实际 OpenCode 加载**，也不覆盖 TSX 运行时渲染。本轮未安装本地 V2 类型检查依赖；TSX 类型及 OpenTUI JSX、深浅主题、中文与窄栏视觉仍须在装有目标 V2 的本机验证。V1 1.18.31 的历史 UI 显示不证明 V2 显示。

## 行为说明

零未读显示「暂无未读消息」；按发件人展开通过 `GET /api/unread-metadata?from=&cursor=&limit=10` 获取标题（不取正文、不标读）。中心返回 404 时明确显示升级提示，绝不回退到含正文摘要的旧接口。刷新与分页仍只请求元数据。命令面板提供发件人展开和已加载标题的数字 ID 阅读入口；仅在当前侧栏挂载期间可用。折叠偏好使用 V2 `context.storage.store` 保存。

阅读调用真实 V2 `context.client.session.prompt({sessionID,text})`；文本精确为 `读取消息ID ${id}`（其中 id 为已校验的数字消息 ID）。V2.0.15 `context.data.session.status()` 返回字符串 `idle | running`，只有 `idle` 才发送。服务端状态与点击之间仍可能发生竞态；插件不打断会话、不自动重发。同一插件生命周期内同会话/同 ID 锁定（包括请求超时或错误的送达不明），卸载再挂载不解除；重启插件后需先检查会话再决定是否重读。附件失败允许 Skill 的失败选择，不属于重复消息选择。

诊断日志仅固定事件：setup、config disabled、slot registered、slot render、sidebar mounted/unmounted、poll succeeded/failed；不记录中心地址、成员名、标题、正文或原始异常。Solid ErrorBoundary 提供可见渲染错误。`plugin-meta load` 不能替代 slot/render 证据。官方 v2.0.15 `routes/session/sidebar.tsx` 在有效 session 的可见 Sidebar 内挂载 `sidebar.content`；内置 `feature-plugins/sidebar/mcp.tsx` 使用 box 的 onMouseDown 折叠与 onMouseUp 条目，本插件沿用此交互。

当前验收边界：Node 回归与 Bun TSX 语法构建通过不证明真实 TUI 可见。本轮没有重启宿主、安装依赖或修改全局安装；现有工具只控制浏览器，不控制当前终端窗口，真实挂载/点击及 busy 请求竞态仍待在目标宿主验收。不能声称已查明此前 total>0 时不显示的最终根因。

- 数据来源是中心服务的 `GET /api/unread-summary`，无参数，身份由来源 IP 判定。
- 标题为 `📬 未读消息 · total`；标题与条数使用 V2 主题 accent hue 加粗，发件人使用 `theme.text.base`，连接异常使用 error 反馈色，附件使用温暖的 warning 反馈色显示 `📎 N 附件`。保留文字 fallback，不只依赖 emoji/颜色。
- 无声音、toast 或自动收件；只有用户主动点击标题才向当前会话发送明确 ID 阅读指令。发送状态不明时禁止再次点击重试，先检查会话；忙碌会话不发送。
- 发件人顺序由服务端按最新未读时间倒序给出，插件原样渲染，不重新排序。
- 最多渲染 10 行发件人；超出部分直接不显示，**不显示「还有 N 个」之类的截断提示**。
- 首次挂载立即拉取，之后默认每 30 秒轮询；正常变化通常在 0–30 秒加网络耗时后体现，不是硬实时上限。
- 每次请求 5 秒超时。请求失败、超时、HTTP 非 2xx、JSON 解析失败或结构异常时保留上一次成功结果，标题区域显示 `[连接异常 · 旧数据]`；从未成功时显示 `[连接异常]`。恢复成功后去提示，正常零未读显示空态；旧数据为零而连接异常时仍显示提示。
- 最后一个侧栏视图卸载或插件销毁时停止轮询并 abort 在途请求，通过 generation 丢弃晚到结果；重新挂载立即拉取。

## 稳定性声明

V2 官方 CLI 插件文档列出 `sidebar.content` slot；升级仍可能改变实际渲染行为，需要对目标版本重新验收。

注册失败时的表现：**侧栏不显示未读区块**。slot 注册包在 try/catch 中，注册失败只打印一条日志，不影响 team-mailbox 的消息收发和 MCP 工具；注册后的 JSX 渲染失败无法由注册 try/catch 捕获，必须实际 UI 验证。

## 自测

```bash
node --test integrations/opencode/unread-core.test.mjs integrations/opencode/sidebar-setup.test.mjs integrations/opencode/unread-detail.test.mjs
```

覆盖：正常多发件人、无未读、超过 10 个发件人、附件为 0、字段缺失与类型错误、轮询间隔下限与回落、各类请求失败后的降级与保留旧值。

自测仅使用 Node 内建测试工具，不包含 TSX 语法检查或真实 V2 TUI 加载。**实际 slot 渲染需要在装有 OpenCode V2 TUI 的机器上人工验证。**
