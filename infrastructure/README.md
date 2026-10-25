# 网络接入与证书工具

此目录包含基础设施工具；前端源码在独立的 `web` 目录，包含设备管理应用与保留在 `/#/diagnostics` 的联通检测页。真实域名、IP、账号、资源标识及凭据只在私有配置中保存，公开仓库不包含部署后的真实值。

## 静态联通测试页

[web](../web/README.md) 已采用 Vue 3 + Vite 实现设备管理页面与账号流程，原联通测试保留在 `/#/diagnostics`，仍包含页面脚本、后端健康检查、Supabase 连接和重新检测。Supabase 检查只读取 `/auth/v1/settings`，不注册账号、不查询设备或写入业务数据。

```sh
pnpm -C web install --frozen-lockfile
pnpm -C web run check
```

检查包括 ESLint、Prettier、独立 TypeScript 类型检查与构建；CI 执行同一命令。构建后，在已忽略的 `dist/runtime-config.json` 中通过私有部署环境注入 `apiUrl` 和 `publishableKey`，只接受 HTTPS API 地址与 `sb_publishable_` 公钥；不得放入服务端密钥。实际运行配置不提交，浏览器仍能查看运行时使用的公开地址和公钥。

发布时将 `dist/` 的内容放入独立网站目录，保留现有文件，先上传哈希资源与运行配置，最后替换首页，并刷新对应 CDN 入口缓存。当前已按此方式部署测试页，旧首页副本与部署摘要保存在仓库外；没有修改其他站点或共享数据库。

真实浏览器验证使用 Playwright 的 Chromium；安装对应浏览器后，从私有环境注入 `SMOKE_BASE_URL` 并运行 `pnpm -C web run test:live`。该命令检查实际 HTTPS 页面、CloudFront 响应、两项后端请求、重新检测与脚本异常，不模拟请求、不忽略证书错误。开发机及首次 GitHub 自动发布均已实测通过；设置 `SMOKE_EXPECTED_REVISION` 时还核对运行配置中的发布提交。五个 CI 检查任务不访问生产，只有获准的主分支发布任务执行线上验证；大陆访问及业务验收另行进行。

## 后端网关

[gateway](gateway/package.json) 使用 TypeScript 与 Cloudflare Worker，部署使用 `cf` CLI。真实 Worker 名称和域名由环境变量注入；未提供配置时构建使用示例名称且不绑定域名。构建成功不代表已部署。

```sh
pnpm -C infrastructure/gateway install --frozen-lockfile
pnpm -C infrastructure/gateway run check
```

检查包含 ESLint、Prettier、由 `cf workers types` 生成绑定类型后的 TypeScript 检查、八项行为测试及正式构建。依赖版本和允许执行的依赖构建脚本已固定，复用本地包缓存，不引用其他项目的安装目录。

运行时绑定包括 `SUPABASE_URL`、`FRONTEND_ORIGIN`、`GEAR_DB_SCHEMA`、`GEAR_STORAGE_BUCKET` 和 `GEAR_FUNCTION_PREFIX`，通过仓库外的专用文件交给 `cf deploy --secrets-file`。不向网关注入 Supabase 管理密钥，SDK 调用者仍提供自身 API key 和用户授权令牌；浏览器打开的一次性验证链接仅对 GET `/auth/v1/verify` 免 API key，验证交由 Auth 完成，链接中不放公钥。退出强制 `scope=local`，避免撤销其他应用会话。

- 数据库请求强制使用设备簿 schema，并拒绝指定其他 schema。
- 文件操作限定专属桶，函数调用限定命名前缀；认证只转发明确列出的用户接口，拒绝管理员接口。
- 跨域请求只允许配置的前端 Origin；该限制不能替代数据库 RLS 和用户身份授权。
- 请求和响应体流式转发，禁用接口缓存，不主动跟随上游重定向；未知路径默认拒绝。
- 当前不代理 Realtime、断点续传和跨桶复制操作。业务 schema、设备流转与台账 RPC、专属私有附件桶及独立函数均已接入，网关健康检查用于确认边缘转发与上游连通。
- 日志不记录授权头、请求体或上游地址，查询参数脱敏；运行日志与追踪启用但不持久化。

首次接入或更改域名连接前须设置 `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_GATEWAY_NAME` 和 `BACKEND_DNS_NAME`，生成包含实际域名的本地构建，先运行 `cf deploy --dry-run --prebuilt` 核对，再按授权发布。日常 GitHub 发布仅执行版本上传和流量切换，保留既有域名连接，具体步骤见[自动发布流程](../docs/deployment.md)。生成的 `.cloudflare/` 和本地 `.dev.vars` 已忽略，禁止提交；五个 CI 检查任务不持有部署凭据，独立的主分支发布任务按授权读取 Secrets。

## 独立源站

[Nginx 模板](origin/nginx.conf.template)只对设备簿的独立源站生效，实际域名、目录与回源校验值从私有环境注入；渲染时只替换模板中明确列出的部署变量，保留 Nginx 的 `$uri` 等运行时变量。修改后先执行配置检查，通过后再按授权重载。

首页声明重新验证，带内容哈希的静态资源允许长期缓存；当前 CloudFront Free 套餐使用托管 CachingOptimized 策略，最低 TTL 为一秒，首页在边缘最多可能额外保留一秒。后端接口单独转发且禁止缓存。回源时保留独立源站 Host，源站拒绝没有校验头的请求，证书文件保存在专用目录。当前网站已部署为设备管理应用，同时保留联通检测路由。

## Google 证书续期

[certificates/renew.py](certificates/renew.py)读取指定的私有 JSON 配置，调用已有 ACME 客户端，续签前端与独立源站证书。配置记录 ACME 路径、证书路径、域名、Google 项目、AWS profile、专用 ACM 证书标识、源站 SSH 别名和私有状态文件路径，权限须限制为当前用户读写。

只读检查使用 `python3 infrastructure/certificates/renew.py --config <私有配置文件> --check`；不带 `--check` 会执行续期、必要的证书导入及源站证书替换，须在授权范围内运行。

当前开发机的专用用户定时器每日检查，配置与原始日志在私有环境保存。新证书部署成功后才更新部署指纹；部署失败保留重试条件，源站配置验证失败恢复旧证书文件。前端续期保留专用 ACM 资源的 ARN 及 CloudFront 绑定；客户端证书的实际生效需另行核对。

更多接入状态、已知限制及授权边界见[技术记录](../docs/technical-proposal.md)。

## 搜索与 AI 爬虫

网站 robots 的唯一文件源位于 [web/public/robots.txt](../web/public/robots.txt)，随 Vite 构建提供，不另维护源站副本。后端网关提供同等禁抓取规则与禁止索引响应头。CloudFront 的 [viewer-request 函数](cloudfront/block-crawlers.js)在缓存之前拒绝已识别爬虫，单独测试和发布，不改变其他站点。完整部署边界见[抓取与索引规则](../docs/crawling-policy.md)。
