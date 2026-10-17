# 网络接入与证书工具

此目录包含基础设施工具，设备管理应用尚未实现。真实域名、IP、账号、资源标识及凭据只在私有配置中保存，公开仓库不包含部署后的真实值。

## 后端网关

[gateway](gateway/package.json) 使用 TypeScript 与 Cloudflare Worker，部署使用 `cf` CLI。真实 Worker 名称和域名由环境变量注入；未提供配置时构建使用示例名称且不绑定域名。构建成功不代表已部署。

```sh
pnpm -C infrastructure/gateway install --frozen-lockfile
pnpm -C infrastructure/gateway run check
```

检查包含 ESLint、Prettier、由 `cf workers types` 生成绑定类型后的 TypeScript 检查、六项行为测试及正式构建。依赖版本和允许执行的依赖构建脚本已固定，复用本地包缓存，不引用其他项目的安装目录。

运行时绑定包括 `SUPABASE_URL`、`FRONTEND_ORIGIN`、`GEAR_DB_SCHEMA`、`GEAR_STORAGE_BUCKET` 和 `GEAR_FUNCTION_PREFIX`，通过仓库外的专用文件交给 `cf deploy --secrets-file`。不向网关注入 Supabase 管理密钥，调用者仍提供自身 API key 和用户授权令牌。

- 数据库请求强制使用设备簿 schema，并拒绝指定其他 schema。
- 文件操作限定专属桶，函数调用限定命名前缀；认证只转发明确列出的用户接口，拒绝管理员接口。
- 跨域请求只允许配置的前端 Origin；该限制不能替代数据库 RLS 和用户身份授权。
- 请求和响应体流式转发，禁用接口缓存，不主动跟随上游重定向；未知路径默认拒绝。
- 当前不代理 Realtime、断点续传和跨桶复制操作。业务 schema、桶、函数及共享 Auth 的回调尚未实施，网关健康并不代表完整业务可用。
- 日志不记录授权头、请求体或上游地址，查询参数脱敏；运行日志与追踪启用但不持久化。

生产部署前须设置 `CLOUDFLARE_ACCOUNT_ID`、`CLOUDFLARE_GATEWAY_NAME` 和 `BACKEND_DNS_NAME`，生成包含实际域名的本地构建，先运行 `cf deploy --dry-run --prebuilt` 核对，再按授权发布。生成的 `.cloudflare/` 和本地 `.dev.vars` 已忽略，禁止提交；仓库 CI 不持有部署凭据，也不自动发布。

## 独立源站

[Nginx 模板](origin/nginx.conf.template)只对设备簿的独立源站生效，实际域名、目录与回源校验值从私有环境注入；渲染时只替换模板中明确列出的部署变量，保留 Nginx 的 `$uri` 等运行时变量。修改后先执行配置检查，通过后再按授权重载。

首页声明重新验证，未来构建出的带内容哈希静态资源允许长期缓存；当前 CloudFront Free 套餐使用托管 CachingOptimized 策略，最低 TTL 为一秒，首页在边缘最多可能额外保留一秒。后端接口单独转发且禁止缓存。回源时保留独立源站 Host，源站拒绝没有校验头的请求，证书文件保存在专用目录。当前网站仅为部署占位内容，后续发布才替换成应用构建产物。

## Google 证书续期

[certificates/renew.py](certificates/renew.py)读取指定的私有 JSON 配置，调用已有 ACME 客户端，续签前端与独立源站证书。配置记录 ACME 路径、证书路径、域名、Google 项目、AWS profile、专用 ACM 证书标识、源站 SSH 别名和私有状态文件路径，权限须限制为当前用户读写。

只读检查使用 `python3 infrastructure/certificates/renew.py --config <私有配置文件> --check`；不带 `--check` 会执行续期、必要的证书导入及源站证书替换，须在授权范围内运行。

当前开发机的专用用户定时器每日检查，配置与原始日志在私有环境保存。新证书部署成功后才更新部署指纹；部署失败保留重试条件，源站配置验证失败恢复旧证书文件。前端续期保留专用 ACM 资源的 ARN 及 CloudFront 绑定；客户端证书的实际生效需另行核对。

更多接入状态、已知限制及授权边界见[技术记录](../docs/technical-proposal.md)。
