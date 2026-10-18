# 抓取与索引规则

设备簿部署站点禁止搜索引擎抓取和索引、AI 搜索检索及训练抓取。范围包含前端页面、公开静态资源和设备簿后端网关；公开源码仓库继续保持开源。

## 实施

- 网站 [robots.txt](../web/public/robots.txt)随构建和发布提供，`User-agent: *` 配合 `Disallow: /` 拒绝全部遵守协议的爬虫；另明确拒绝 Google-Extended 产品控制项。后端网关的 `/robots.txt` 对 GET、HEAD 提供相同规则，不要求登录或 API key，不连接上游。
- 首页设置全局 robots meta；独立源站的页面、静态资源和错误响应，以及后端网关的正常、拒绝、重定向和文件响应，都声明 `X-Robots-Tag: noindex, nofollow, noarchive, nosnippet, noimageindex`。Nginx 有自身 `add_header` 的 location 需重复声明，不能依赖父级继承。
- [CloudFront 请求函数](../infrastructure/cloudfront/block-crawlers.js)在查询缓存前拒绝可识别的爬虫，返回不缓存的 403；后端网关同样在访问上游前拒绝。覆盖常见搜索爬虫标识、OpenAI、Claude、Perplexity、Meta 等搜索、用户代取及训练代理；通用 bot/crawler/spider 标识同时被拒绝。`robots.txt` 保持可读，普通浏览器保持原有行为。
- 不添加 sitemap 或面向 AI 的内容发现清单。单据及原件仍须经过已验证、审核通过的账号及当前角色授权；禁止抓取标记不能替代访问控制。

## 部署与维护

页面、robots 文件及网关随既有主分支 CI/CD 发布；发布流程刷新首页、运行配置及 robots 文件，线上浏览器检查同时核对页面禁止索引标记和两端 robots 规则。

Nginx 配置和 CloudFront 请求函数是独立基础设施：先保存私有基线，测试后单独应用；不由网站发布脚本自动修改，也不扩展网站 CI 的云管理员权限。源站只修改设备簿站点的响应头，先验证再重载；首次补齐静态响应头后刷新本分发缓存。请求函数只关联本应用缓存行为，保留源站、缓存策略、证书及已有防护。以后修改请求函数源码，需重新测试并发布该函数，网站 CD 不自动更新它。

实际函数名称和 ARN 仅保存在私有 `.env`、凭据清单及仓库 Secrets，通过 `AWS_CLOUDFRONT_CRAWLER_FUNCTION_NAME`、`AWS_CLOUDFRONT_CRAWLER_FUNCTION_ARN` 引用。原始配置、测试结果和发布证据不进入公开仓库。

## 边界

robots 和 noindex 取决于对方遵守，User-Agent 可以伪装，不能承诺阻止所有自动访问或让既有收录立即消失。robots 禁止访问后，搜索引擎可能无法读取页面 noindex，仍可能保留从其他地方发现的 URL；业务内容必须持续依赖账号权限，而不能把搜索不可见当作保密措施。

参考：[Google noindex](https://developers.google.com/search/docs/crawling-indexing/block-indexing)、[Nginx 响应头继承](https://nginx.org/en/docs/http/ngx_http_headers_module.html)、[CloudFront Functions](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cloudfront-functions.html)、[OpenAI 爬虫说明](https://developers.openai.com/api/docs/bots)、[Anthropic 爬虫说明](https://support.anthropic.com/en/articles/8896518-does-anthropic-crawl-data-from-the-web-and-how-can-site-owners-block-the-crawler)。
