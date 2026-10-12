# DSH Clash fake-IP 扩展

为 DeepSeek Harness 的 `web_fetch` 增加 Clash TUN/fake-IP DNS 兼容。安装一次后由 profile 自动加载，不需要修改 Harness 源码、重建 Harness 或每次添加 `--patch`。

包名：`dsh-clash-fake-ip`。当前版本：`0.1.0`。兼容并验证的 Harness 版本：`0.2.0-rc.2`；Node 要求与该版本 Harness 一致：`^22.19.0 || >=24.0.0`。

## 安装

使用已安装的 DSH CLI：

```sh
dsh plugin --profile web add https://github.com/Ling-yunchi/dsh-clash-fake-ip-patch/releases/download/v0.1.0/dsh-clash-fake-ip-0.1.0.tgz
```

也可以直接从 GitHub 的固定版本安装：

```sh
dsh plugin --profile web add github:Ling-yunchi/dsh-clash-fake-ip-patch#v0.1.0
```

如果从 Harness 源码仓库启动，把命令开头的 `dsh` 替换为 `pnpm dsh`。包内已包含可执行 ESM JavaScript，没有 `prepare`、`postinstall` 或其他安装脚本。

安装会把 bundle 持久加入该 profile。停止现有 Web 进程后正常启动：

```sh
dsh --profile web
```

Web 插件管理器也可以安装上面的发布包 URL。其他基于 `dsh-base` 的 profile 可把 `web` 换成相应名称。自定义 profile 需要已加载 `web` 服务和 ID 为 `web-fetch-http` 的原后端行。

## 检查和卸载

```sh
dsh --profile web --dump-config
```

输出应包含原 `web-fetch-http` 行的 `disabled: true`，以及新增的 `web-fetch-http-clash` 行。随后让 Agent 用 `web_fetch` 请求网页。

卸载命令使用包名：

```sh
dsh plugin --profile web remove dsh-clash-fake-ip
```

移除 bundle 后原内置后端会恢复；重启进程后使用恢复后的组合。如果 profile 或 home 的手动 patch 覆盖了这些行，该手动配置拥有更高优先级，需要检查对应设置。

## 配置

安装 bundle 即表示启用 fake-IP 兼容。插件继承原版抓取后端的 timeout、重定向、响应大小和 User-Agent schema。需要调整时，在 profile 的 `cordis.patch.yml` 中配置新行：

```yaml
- id: web-fetch-http-clash
  config:
    timeoutMs: 30000
    maxResponseBytes: 5000000
    maxBodyChars: 100000
    maxRedirects: 5
```

原 `web-fetch-http` 行上的自定义限制不会自动复制到新行；请按需迁移。profile patch 替换整行 `config`，同一行已有的其他配置应一并保留。

如果之前使用本仓库的源码补丁方案，安装扩展后不需要 `allowClashFakeIp` 配置或额外 `--patch` 参数。可删除旧的启用配置；此前修改过的 Harness 源码不会被扩展安装或卸载操作自动还原。

## 地址策略和限制

- 仅把主机名 DNS 答案中的 IPv4 `198.18.0.0/15` 加入允许集合。
- URL 中直接写出的非公网 IP 字面量仍拒绝，包括 `http://198.18.0.5/`。
- 普通私网、回环、链路本地、CGNAT、文档网段和组播仍拒绝；混合 DNS 答案中任一违规地址会拒绝整组。
- 保留上游 DNS64/NAT64 检查，拒绝转换到私网或 fake-IP 的 IPv4 目的地址。
- 复用上游 `HttpFetchProvider` 的公开 resolver 接口；HTTP Host、TLS SNI、连接固定、显式代理、同源重定向和响应上限由原版后端负责。
- 仅用于可信的 Clash 映射。fake-IP 无法证明映射后的最终目的地址是公网；DSH 把这一步交给本地 Clash。
- 当前固定支持 `198.18.0.0/15`，不支持自定义网段或 IPv6 fake-IP。只声明已验证版本的 peer 兼容性。

## 实现

[`cordis.patch.yml`](cordis.patch.yml) 声明安装时应用的 bundle：禁用原后端行，插入 [`src/index.js`](src/index.js) 提供的替代后端。替代后端仍注册 provider ID `http`，原来的 `web_fetch` 工具和 `ctx.web` 选择配置保持兼容。DNS 校验实现位于 [`src/resolver.js`](src/resolver.js)。

本扩展不包含完整 Harness 源码与历史、本地配置或凭据。DNS 校验部分根据上游 MIT 许可实现改编，版权声明保留在 [LICENSE](LICENSE)。此前的源码差异文件仍留在仓库中供旧部署使用，不进入安装包。

## 验证

独立开发环境：

```sh
npm ci --ignore-scripts
npm test
npm run typecheck
```

需要真实 Clash fake-IP DNS 的网络测试：

```sh
npm run test:live
```

真实安装/卸载测试还需要设置 `DSH_TEST_CLI` 为已构建的 DSH CLI 入口绝对路径，再执行 `npm run test:install`；该测试创建隔离的 `DSH_HOME`，不会改动正在使用的 profile。可选 `DSH_TEST_SPEC` 指定待测 tarball，默认安装本地扩展目录。

本次验证使用 npm 发布的未修补 `@deepseek-ai/dsh-web-fetch-http@0.2.0-rc.2`，并检查它不含 `allowClashFakeIp`。真实网络下，原版后端拒绝 fake-IP；扩展成功读取 GitHub、GitHub API 和 example.com，均返回 HTTP 200。真实 CLI 安装后成功抓取，卸载后恢复原版拒绝行为。CLI 来自当前 Harness 构建；抓取对比使用独立安装的原版 npm 后端。本机 Node `22.18.0` 低于声明范围，测试出现 engines 警告，部署应使用受支持版本。

## 许可证

MIT，见 [LICENSE](LICENSE)。
