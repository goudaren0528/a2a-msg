# 本机 OpenCode 任务桥接演示

前提：Node.js 24、项目依赖已安装、本机已运行并登记的 OpenCode v2 服务（含有效 Basic auth）。演示不会启动或重启 OpenCode；服务不可用时非零退出。

在仓库根目录运行：

```sh
node examples/im-bridge-demo.mjs
```

可选 `--root ABSOLUTE_NONEXISTENT_PATH` 指定全新绝对目录。输出及脱敏的 `summary.json` 留在控制台显示的临时目录，不自动删除；失败时也保留证据。演示在隔离 IM 中心使用测试 CA 验证的本机 HTTPS、临时项目及真实 OpenCode：查询项目清单、派发只读任务、确认接单与真实结果、拒绝未知项目及任务去重。待批准不会自动批准；超时或未知结果不会冒充成功。

**不证明**跨机器互通、生产安全或部署可用性；TLS 证书仅用于测试，执行只涉及演示临时项目。上游宿主会话的自动唤醒也不在本演示范围内。
