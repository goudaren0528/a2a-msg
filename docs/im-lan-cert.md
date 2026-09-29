# 局域网 IM 中心测试证书

在运行 IM 中心的机器上用 Node 24 生成证书（输出目录必须为绝对路径，且不存在或为空）：

```sh
node scripts/im-lan-cert.mjs --out /absolute/private/im-certs --host 192.168.11.40 --host localhost --days 90
```

Windows 示例：将 `--out` 换成 `D:\private\im-certs` 等绝对路径。生成前确认目录的访问权限；Windows 的文件 mode 位**不是** ACL，需要自行配置 Windows ACL 限制私钥读取。

脚本会先验证证书并实际完成一次本机 TLS 握手，全部通过后才写入文件。实际使用中曾两次遇到罕见的 ASN.1 编码错误，根因仍未知；因此失败时最多重新生成两次（共三次尝试），重试情况会提示在标准错误输出。

- **只复制 `ca-cert.pem` 到另一台机器**。在运行 bridge / OpenCode 的机器上设 `NODE_EXTRA_CA_CERTS` 为该文件的绝对路径，再启动客户端。例如 PowerShell：`$env:NODE_EXTRA_CA_CERTS='C:\private\ca-cert.pem'`；POSIX shell：`export NODE_EXTRA_CA_CERTS=/absolute/path/ca-cert.pem`。
- IM 中心 TLS 服务端使用 `server-key.pem`（私钥）和 `server-cert.pem`（证书）。客户端访问地址必须与 `--host` 中的 IP 或域名一致。
- **`ca-key.pem` 是 CA 私钥，绝不能离开发证机器，也不能复制到客户端。**服务端私钥同样必须保密。

这是仅供局域网测试使用的自签名测试 CA，**不是公网或生产证书**。
