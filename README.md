# DSH Clash fake-IP 补丁

让 DeepSeek Harness 的 `web_fetch` 支持 Clash TUN 的 `198.18.0.0/15` fake-IP DNS 结果。

这个仓库只包含补丁文件和说明，不包含完整 Harness 源码或历史。补丁需要应用到 Harness 源码并重新构建；单独加载 YAML 不会为未修补版本增加配置项。

## 文件

- [`web-fetch-http-clash-fake-ip.patch`](web-fetch-http-clash-fake-ip.patch)：源码、回归测试、包文档和生成配置目录的 Git 差异。
- [`clash-fake-ip.patch.yml`](clash-fake-ip.patch.yml)：开启 `allowClashFakeIp` 的 profile overlay。
- [`LICENSE`](LICENSE)：上游 MIT 许可证。

## 应用补丁

补丁基于 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) 的提交 `639ed015397290b3745d163aafe02ffee4aa3f84`。其他版本请先执行 `git apply --check` 检查兼容性；若失败，需人工适配。

在 Harness 源码仓库根目录执行以下命令。将 `../dsh-clash-fake-ip-patch` 替换成这个补丁仓库的实际位置。

```sh
git apply --check ../dsh-clash-fake-ip-patch/web-fetch-http-clash-fake-ip.patch
git apply ../dsh-clash-fake-ip-patch/web-fetch-http-clash-fake-ip.patch
pnpm install
pnpm run build
pnpm dsh --profile web --patch ../dsh-clash-fake-ip-patch/clash-fake-ip.patch.yml
```

如果已有 Web 进程，请停止旧进程后使用上述命令重新启动。持久启用时，也可以将以下行合并到自己的 Web profile `cordis.patch.yml` 中；若已有 `web-fetch-http` 配置，请同时保留已有字段，因为 profile patch 会替换整行配置。

```yaml
- id: web-fetch-http
  config:
    allowClashFakeIp: true
```

## 行为与限制

- 新增插件配置 `allowClashFakeIp`，默认 `false`。
- 开启后，只额外允许主机名 DNS 答案中的 `198.18.0.0/15` IPv4 地址。
- 请求仍使用已验证的 DNS 地址集合固定连接，并保留原 URL 主机名用于 HTTP Host 和 TLS SNI。
- URL 中显式写出的非公网 IP 字面量继续拒绝；其他私网、回环、链路本地、CGNAT、文档地址和 NAT64 私网转换继续拒绝。
- 仅用于可信的 Clash TUN/fake-IP 映射。Clash 负责映射后的实际目的地址，DSH 无法仅凭 fake-IP 判断最终地址是否公网。
- 此补丁使用固定的 `198.18.0.0/15` 网段，不支持自定义 fake-IP 网段或 IPv6 fake-IP。
- 它扩展现有 `dsh-web-fetch-http` 插件的配置，不是独立安装的 npm 插件。

## 已执行验证

在 Windows 上对修补后的 Harness 执行：

```sh
pnpm exec vitest run packages/web/web-fetch-http/tests/fetch-http.spec.ts packages/web/web-fetch-http/tests/proxy.spec.ts
pnpm exec tsc -p packages/web/web-fetch-http/tsconfig.json --noEmit
pnpm run verify-config-catalog
pnpm run test:docs
pnpm run doc-sync
pnpm dsh --profile web --dump-config --patch ./clash-fake-ip.patch.yml
git diff --check
```

结果：81 个相关测试通过；包类型检查和配置目录检查通过；文档快速检查 21 项通过；`doc-sync` 43 项通过；overlay 可合并到 Web profile。测试机 Node 为 `22.18.0`，低于仓库声明的 `^22.19.0 || >=24.0.0`，执行时出现 engines 警告；部署请使用上游支持的版本。

真实网络测试中，`github.com`、`api.github.com` 和 `example.com` 均由系统 DNS 返回 `198.18.x.x`。直接调用已构建的抓取后端：关闭选项时均返回 `WEB_BLOCKED_URL`；开启选项后三个 HTTPS 请求均返回 HTTP 200。当前会话的 `web_fetch` 也成功读取了 GitHub API。

## 许可证

MIT。保留上游 DeepSeek 版权声明；见 [LICENSE](LICENSE)。
