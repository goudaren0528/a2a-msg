# IM 本机隔离演示

前提：Node.js 24、Python 3.8+（命令 `python` 或 `python3`）、项目现有 Node 依赖已安装。新检出的项目可按项目依赖说明自行运行 `npm ci`；演示命令自身不安装任何依赖。

在仓库根目录运行：

```sh
node examples/im-local-demo.mjs
```

预期输出三个阶段，最后 `PASS: 2 accepted, 2 delivered/ACKed`。第一行给出随机私有临时目录；运行结束**保留**该目录，包括 `summary.json`、隔离 center SQLite、接收端 SQLite journal 和附件文件。输出摘要没有凭据；请仍将整个目录视为敏感数据，不公开分享。每次运行创建新目录。可指定 `--root` 加**绝对且尚不存在**的路径；已有路径即使为空也拒绝，缺少 Python 会非零退出并保留已建立目录。`--help` 查看参数。

演示在全新 schema 3 数据库中注册两个身份、凭据与双向联系人，并仅对该数据库开启写入。父进程开启 `127.0.0.1` 随机端口 HTTPS center；Python 标准库进程通过现有 `examples/python/client.py` 在接收方离线时发送文本与二进制附件，随后用同一 clientMessageId/相同内容重发，验证只存一条消息、一条发送键。另一个独立 Node 进程通过现有 MCP adapter/SDK 与 SQLite FULL 同步 journal 获取消息、持久化附件及 receipt 并 ACK；关闭后离线发送第二条消息，再启动新接收进程，沿用同一 journal，验证游标续接、不重复第一条、空同步与中心 ACK 计数。`accepted` 是中心收下消息，`delivered/ACKed` 是接收进程持久化并回执，不代表执行收到的文本。

TLS 使用仓库中**公开的测试专用证书和私钥**，只绑定 loopback；两种客户端均使用指定 CA 验证证书链/主机名，绝不能将该密钥用于生产。命令会关闭自己启动的两个客户端进程及 HTTPS listener，不启动常驻服务。不访问现有中心数据库或真实服务。Unix 尽力对新目录/文件设置 0700/0600；Windows 的这些 mode 位**不是原生 ACL 权限保证**，输出目录的访问控制取决于主机 ACL。Python 发送方不是崩溃恢复 journal；JS 接收方使用持久 journal。本例不是跨机器 LAN、公网 TLS、干净克隆全框架验证或生产授权/发布验收，也不是旧 LAN 消息通道。
