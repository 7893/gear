# 技术选型与部署记录

状态：已配置前后端网络入口与证书，已有接入网关、静态联通测试页和维护工具，真实浏览器接入测试通过；设备管理应用尚未编写或部署，完整验收未执行。记录日期：2026-10-17。基础设施与业务应用分别记录；本文只保存脱敏信息。

## 1. 项目规模与选型原则

- 名称为设备簿 / gear，管理几十件、预计不到一百件设备，约十名系统用户；定位为带流转记录和签字单据的轻量设备簿。
- 当前以尽量零新增费用为目标，优先免费产品、复用资源和减少维护；不为未来可能出现的规模提前增加服务。
- Supabase 仅使用免费版，前端优先复用现有主机与 CloudFront Free 套餐。Google 邮箱沿用已完成验证的 Gmail API 通道。
- 用户已确认共用现有亚太 Supabase 项目，不因设备簿新建项目。确认共用不等于授权创建对象或修改项目级配置；以下隔离方案仍待实施。
- 前端境外托管，使用自有域名；大陆完整使用流程必须实测。免费额度和自有域名不构成网络可用性保证。
- 不再制作样稿，先补齐设计和实施边界；云端、服务器与凭据配置修改继续按用户逐项授权执行。

## 2. 已确定的平台分工

| 部分 | 产品或环境 | 职责与边界 |
| --- | --- | --- |
| 开发 | 开发机 | 文档、代码、调试和构建；主机别名及地址只在私有配置中记录 |
| 前端部署 | 现有美国主机上的 Nginx | 独立目录与 HTTPS 回源站点已建立，最小 TypeScript 测试页已部署；现有其他站点配置未改 |
| 前端分发 | AWS CloudFront Free | 已复用原停用分发，绑定目标域名、Google 证书与独立 HTTPS 源站 |
| 前端客户端 HTTPS 证书 | Google Trust Services / Google Public CA，导入 AWS ACM | Google 签发，ACM 托管并供 CloudFront 使用；已接入专用续期任务 |
| 前端 DNS | Google Cloud DNS | 已添加网站 CNAME 指向 CloudFront，独立回源域名配置 A 与 AAAA |
| 后台入口 | Cloudflare DNS、自动证书与专用 Worker | 自定义域名与 TypeScript 网关已部署，转发至既有 Supabase；不缓存接口响应 |
| 账号 | Supabase Auth | 邮箱密码、验证、会话和找回密码；管理员审核与业务角色由应用实现 |
| 数据库 | Supabase PostgreSQL | 设备、人员、团队、流转、单据和操作历史 |
| 业务计算 | Supabase Edge Functions | 业务校验、受保护管理操作、邮件及识别集成 |
| 附件 | Supabase Storage 私有桶 | 签字件、图片与 PDF，按账号审核状态和业务角色授权 |
| 定时任务 | Supabase Cron | 调用 Edge Functions，处理到期提醒和待发通知 |
| 邮件 | 自有域名 Google 邮箱及 Gmail API | 已完成独立发信验证；应用接入尚未完成 |

### 开发语言与前端方案

已确认使用 TypeScript 编写浏览器前端及所需的 Supabase Edge Functions。数据库结构、约束、权限策略和保证业务一致性的事务函数继续使用 SQL；TypeScript 不改变已有平台分工。

| 部分 | 决定或当前建议 | 状态 |
| --- | --- | --- |
| 应用开发语言 | TypeScript，服务于前端与自定义 Edge Functions | 已确认，尚无应用代码 |
| 前端框架与构建 | Vue 3 + Vite，普通单页应用 | 当前推荐，取代此前优先讨论的 React 候选；具体组合待初始化前定案 |
| 页面组件与路由 | Element Plus + Vue Router | 当前建议，用于表格、表单、上传及页面切换 |
| 数据与事务 | PostgreSQL + SQL | 沿用已确定的 Supabase 数据库分工 |

- 系统以电脑端台账、查询、交接表单、单据和附件为主，页面数量及交互复杂度有限；当前方案优先直接使用成熟组件，控制依赖与维护量。
- TypeScript 在开发阶段提供类型检查，前端最终构建为浏览器执行的 JavaScript 和静态资源，交由现有 Nginx 与 CloudFront 分发。Vite 构建与类型检查需分别配置，构建成功本身不代表类型检查通过。
- Supabase 承担已有后端职责，自定义函数复用 TypeScript；当前方案无需增加独立的 PHP、Java 或 Go 应用服务。涉及单据、状态和历史的一致性操作仍由数据库事务完成。
- 类型检查不能替代运行时输入校验、RLS 或角色授权。服务端密钥、邮件令牌及回源校验值只在服务端私密配置中使用，不能放入前端构建。
- 开发机已有的运行环境、检查工具和下载缓存按需复用；项目独立声明并锁定依赖版本，保持本地与 CI 的检查命令一致。其他项目已经安装工具不代表设备簿已经完成接入，详见[开发验证约定](verification.md)。

设备管理应用的框架尚未初始化；当前最小网络测试页仅使用 TypeScript 与 Vite，已锁定独立依赖并接入 CI，不作为业务界面的框架定案。二维码库、OCR 服务与认证细节仍待实现或验证。

## 3. 网络链路与区域

- 前端文件：浏览器访问自有域名，经 CloudFront 边缘节点获取缓存；未命中时回到美国源站。节点按网络条件选择，不保证固定在亚太。
- 业务接口：当前业务后端保留亚太 Supabase；美国主机只提供静态前端时，没有必要为配合主机而新建美国区域项目。
- 数据库与频繁访问数据库的函数应结合实际往返延迟选择执行位置；函数区域可单独验证，不把边缘接入等同于数据库跨区迁移。
- 后台已采用独立 Cloudflare Worker 网关，认证接口、限定业务 schema 的 Data API、专属函数前缀及附件桶路径按白名单转发；当前无 Realtime 或断点续传代理。Supabase 业务对象及共享 Auth 回调仍待实施。
- Supabase 免费版没有官方自定义域名能力。代理涉及回调、CORS、令牌和附件授权处理，不能作为零维护的透明替代。
- CloudFront 托管前端不会自动加速浏览器直连 Supabase 的请求。大陆验收必须覆盖页面、注册登录、审核、查询、流转、文件及邮件回调。
- 网站脚本、字体、图标和样式尽量随构建提供，减少浏览器外部依赖。Google 邮件与 OCR 调用放在服务端。

参考：[CloudFront 内容分发](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/HowCloudFrontWorks.html)、[Supabase 区域](https://supabase.com/docs/guides/platform/regions)、[函数区域](https://supabase.com/docs/guides/functions/regional-invocation)、[自定义域名](https://supabase.com/docs/guides/platform/custom-domains)。

### 客户端 HTTPS 证书与续期

已确认浏览器访问前端网站时使用 Google Trust Services 签发的服务器证书，已通过 Google Public CA 的 ACME 流程申请并导入 AWS ACM、绑定 CloudFront。后端域名经用户确认使用 Cloudflare 自动管理的证书，当前签发方为 Let's Encrypt，不固定其后续签发方。

| 环节 | 方案与边界 |
| --- | --- |
| 签发 | Google Public CA，官方说明证书申请免费；使用支持外部账号绑定 EAB 的 ACME 客户端 |
| 域名验证 | 已使用 Google Cloud DNS 与 ACME DNS-01；临时验证 TXT 在签发后清理，网站 CNAME 独立保留 |
| CDN 托管 | 已将叶证书、匹配私钥和中间证书链导入 AWS ACM 的 `us-east-1` 区域，绑定目标 CloudFront 分发 |
| 续期 | 已设置独立任务，ACME 续签后重新导入本应用专用的同一 ACM 资源；ACM 不负责导入证书的托管续期 |
| 源站 HTTPS | 已为独立回源域名单独申请 Google 证书并安装到专属 Nginx 站点 |

- 首次接入已创建设备簿专用的 ACM 证书资源，既有其他业务证书未覆盖。私有配置分别保存既有检查对象与本应用当前证书标识，续期只更新后者。
- 证书须覆盖目标网站域名，并在 CloudFront 中正确绑定该域名。仅域名解析指向 CloudFront 不代表证书或 HTTPS 已生效。
- 已在开发机设置专用用户级续期定时器，每日 UTC 03:20 起随机延迟不超过 15 分钟运行；用户服务管理器已启用退出登录后继续运行。复用现有 ACME 客户端与有效 Google ACME 账号，使用独立配置和证书目录，未修改其他应用的证书任务。
- [续期工具](../infrastructure/certificates/renew.py)检查证书链、域名、密钥匹配和至少十四天的剩余有效期；签发成功但部署失败时，后续运行继续重试未部署的新证书。前端更新专用 ACM 资源，源站只更新自身证书并在 `nginx -t` 成功后重载。证书更新后仍需复核 CloudFront 生效和实际客户端证书。
- 已通过本地证书检查及定时服务首次运行，当前新证书未到续期时间，未强制重复签发；真实到期续签与边缘证书替换仍需后续观察。失败通过服务状态和私有日志记录，主动邮件告警尚未接入。
- 后续 API、凭据、DNS、证书、分发及定时任务的配置更改继续按用户授权执行，当前仓库 CI 只验证工具，不执行续期或云端部署。
- 证书私钥、ACME 账号密钥、EAB 秘密及 DNS 写入凭据保存在仓库外的受限私有环境；真实域名、证书 ARN、验证记录值及必要文件路径仅记录在本地私有配置中。公开模板、文档、源码和日志不包含这些真实值，不把私钥复制进前端或常规构建产物。

参考：[Google Public CA 与 ACME](https://cloud.google.com/certificate-manager/docs/public-ca-tutorial)、[CloudFront 证书要求](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/cnames-and-https-requirements.html)、[ACM 导入与续期](https://docs.aws.amazon.com/acm/latest/userguide/import-certificate.html)。

## 4. 资源检查与接入进展

以下首次检查保留历史背景，当前实施结果见本节后半部分。

- 美国主机的 SSH IPv4 与出口地址已核对一致；检测到一个稳定公网 IPv6，IPv6 出口地址也一致。Nginx 正在运行，已有静态目录、HTTPS 与 IPv6 监听；尚无设备簿独立站点。
- 经单独授权已建立 `/var/www/gear`，与现有 Nginx 站点根目录和 alias 不重叠。目录为空，由部署用户持有，权限 `755`；路径记录在私有 `.env` 的 `DEPLOY_WEB_ROOT`。此次创建前后检查了现有 Nginx 配置摘要，内容未变，服务仍在运行，未执行重载。
- AWS 本地凭据可读取当前账号的两个 CloudFront 分发：一个停用，一个启用。停用分发的源站已指向该美国主机，使用 HTTPS 回源和一个自定义回源请求头。
- 停用分发关联有效 FREE 套餐，启用 IPv6；分发无地域限制，检查到的 WAF 地域规则未涉及中国。现有 CloudFront 证书不覆盖目标网站域名。
- 现有源站证书也不覆盖目标网站域名；回源证书是否调整取决于最终回源域名。不能把现有其他站点的 HTTPS 视为设备簿证书已配置。
- Google Cloud DNS 的公共区域与权威名称服务器已核对；目标网站的 A、AAAA 记录仅完成私密变更计划，尚未写入。后续 CloudFront 网站入口应使用 CNAME；若需要源站 A、AAAA，应使用另外确定的源站名称。
- 本轮只读复核：目标网站在 Cloud DNS 中没有 A、AAAA 或 CNAME，公共 DNS 查询也没有对应答案；候选 CloudFront 分发仍停用且未绑定目标域名。已附证书有效但不覆盖目标域名，在 ACM 的 `us-east-1` 区域未找到匹配目标域名的证书；Nginx 未引用设备簿域名或部署目录，目录仍为空。上述复核未修改云端或服务器配置。
- 已通过只读接口核对现有 Supabase 项目处于亚太地区且健康运行，包含其他业务结构和已部署函数。检查了系统目录、策略、桶、Auth 与函数元数据，未读取业务记录、执行已有业务函数或修改设置。用户随后确认共用；隔离规则及设备簿接入尚未实施。
- 基础设施检查后仅按单独授权建立上述独立目录，没有新增 Nginx 站点、重载服务、启用分发、申请证书或修改 DNS。真实地址、资源标识及检查详情仅在私有环境保存。

### 本轮已实施

- Google Cloud DNS 已新增网站 CNAME 及独立源站 A、AAAA；本机、Google 与 Cloudflare 公共解析器均返回预期网站 CNAME，原有其他业务记录未作为变更目标。
- 原停用 CloudFront 分发已更新并启用，绑定网站域名、专用 Google 证书和独立 HTTPS 源站。源站需要专用回源校验头，直接访问无校验头返回 403，有校验头返回 200。
- CloudFront Free 套餐使用不转发访客 Host 的托管 CachingOptimized 策略，保留独立回源主机名；缓存键不包含用户 Cookie 或查询参数。该策略最低 TTL 为一秒，首页即使声明 `no-cache` 也可能在边缘保留一秒；未来带内容哈希的静态资源长期缓存，后端业务接口始终不缓存。缺失静态资源返回 404，站点提供禁止搜索抓取的 robots 文件，这不代替身份授权。
- Nginx 已新增隔离站点和独立证书目录；配置检查通过后重载，变更前后比对确认原有 Nginx 配置文件未变。随后按授权将自身占位首页替换为最小 TypeScript 测试页，保留旧首页副本及部署摘要，不提供设备管理功能。
- Cloudflare 已部署专用 TypeScript 网关及自定义域名，后端证书和续期由 Cloudflare 管理。网关配置值以专用绑定注入，未上传 Supabase 管理密钥、邮件令牌或云管理凭据。
- 已通过前端 HTTPS、Google 签发方核对、后端健康检查、带前端 Origin 的 Auth 设置查询及 CORS、其他 schema 和附件桶拒绝访问检查；接口响应为 `no-store`，未读取业务数据或执行业务写入。
- 测试页已通过默认 Chromium 真实浏览器验证：页面经 CloudFront 返回 200，后端健康检查和 Supabase Auth 设置查询均返回 200，重新检测成功且无脚本异常。实际 API 地址与 publishable key 仅写入被忽略的部署产物，未向浏览器发布服务端密钥；未修改浏览器完整性检查或 TLS 验证。
- 原生脚本 User-Agent 被现有 Browser Integrity Check 拦截为 403 / 1010，浏览器 User-Agent 正常。仅针对新 API 域名跳过该项检查的规则已生成私有预览，尚待单独授权；未修改全域浏览器检查、WAF 或其他站点规则。
- 网关已接入独立类型检查、静态检查、格式检查、六项行为测试与构建；静态测试页也已接入独立类型检查、静态检查、格式检查与构建，均加入仓库 CI。生产浏览器验证已在开发机手动执行；随后准备了自动发布与浏览器验收任务，当前保持关闭，专用凭据与权限待单独授权，详见[自动发布方案](deployment.md)。共享 Supabase 的业务结构、授权策略及 Auth 回调和邮件设置没有更改，大陆真实网络和完整业务验收未执行。

## 5. 免费额度与规模边界

- Supabase 免费版当前提供 500 MB 数据库、1 GB 文件存储、每月 50 万次 Edge Functions 调用；普通出口流量和缓存出口流量分别计量，各有 5 GB 免费额度。附件数量及扫描大小比设备数量更直接影响存储用量。
- Storage 使用私有桶和 RLS；文件本体不写入业务表。接近免费容量时再评估优化或迁移，不能默认升级 Supabase 付费版。R2 不作为当前日常附件必需产品。
- CloudFront Free 套餐当前包含每月 100 GB 流量、100 万次请求，与按量计费模式的免费额度不同。实施时核对所选套餐的功能限制、既有主机流量和其他关联服务。
- 原有域名保留 Google DNS 不妨碍接入 CloudFront，不需要新增 Route 53 托管区域；证书接入按 AWS 要求处理。

参考：[Supabase 定价](https://supabase.com/pricing)、[Storage 访问控制](https://supabase.com/docs/guides/storage/security/access-control)、[CloudFront 套餐](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html)。

## 6. 权限、事务与通知

- 邮箱验证和管理员审核分开；待审核、拒绝或停用账号不能读取业务数据或私有附件。每次授权检查当前状态和角色，不能只依赖旧令牌。
- 普通查询采用用户身份与 RLS；交接确认使用受保护的 PostgreSQL 事务函数，一次更新状态、单据、历史和待通知记录。前端或 Edge Functions 的多次独立请求不能充当同一事务。
- 管理密钥和源站回源校验值仅在服务端使用，不进入前端。文件上传与数据库关联分别处理失败和重试，上传完成不等于归档完成。
- 实时查询先采用操作后刷新、重新聚焦刷新及适度轮询，当前不强制引入 Realtime 或 WebSocket。
- Supabase Auth 的认证邮件候选方案为 Send Email Hook 调用 Edge Functions，再使用 Gmail API。该 Hook 替换整个项目的认证发信过程；共用后必须先核对其他应用的邮件需求与回调，再单独授权配置，不能视作仅影响设备簿。
- 日常通知采用数据库待发记录配合 Cron；恢复后不自动重发历史邮件。具体流程见[邮件设计](email-design.md)。

### 共用项目的隔离方案（实施提案）

| 对象 | 建议命名或配置 | 隔离要求 |
| --- | --- | --- |
| 数据库 | 独立 `gear` schema，记录在 `GEAR_DB_SCHEMA` | 新表、索引、序列、SQL 函数和迁移限定到业务 schema，保留现有对象 |
| 附件 | 独立私有桶，候选名 `gear-attachments`，记录在 `GEAR_STORAGE_BUCKET` | 新增 Storage 策略限定该桶及设备簿成员权限，不扩大其他桶访问 |
| Edge Functions | 候选前缀 `gear-`，记录在 `GEAR_FUNCTION_PREFIX` | 新函数独立命名，不覆盖已有函数，相关凭据同样区分用途 |
| 业务成员 | 独立审核状态与三种角色，关联共享 Auth 身份 | 现有 Auth 用户不自动成为设备簿成员或管理员；已有账号验证身份后另行申请访问 |
| 接口授权 | RLS、事务函数及 Edge Functions 检查当前成员状态 | 同项目有效 JWT 或 `authenticated` 角色本身不代表可访问设备簿 |

- schema 是业务组织边界，仍需 RLS、最小授权和后端检查；项目管理密钥不向浏览器或普通用户分发。
- 设备簿停用、拒绝和降级只修改自身权限，不全局封禁或删除共享 Auth 用户，也不全局撤销其他应用会话。退出只处理本应用当前会话；共享密码修改和找回具有账号级影响，需在流程中说明。
- 通过 Data API 使用业务 schema 时，单独审核追加 exposed schema 的变更，保留现有暴露项；仅授权需要的表操作与事务函数执行权限。
- 保留现有 Site URL、回调、邮件设置和 Hook。追加回调、启用邮件 Hook、安装 Cron 扩展或新增共享表策略时，分别列出差异和影响后获得写操作授权。
- 角色不能来自用户可修改的元数据；首次管理员只写设备簿成员权限，不提升云项目角色或覆盖已有账号密码。
- 计算、存储、流量、函数调用额度与 Auth 均共享；业务命名空间不提供独立资源配额。

参考：[自定义 schema](https://supabase.com/docs/guides/api/using-custom-schemas)、[认证发信 Hook](https://supabase.com/docs/guides/auth/auth-hooks/send-email-hook)。上述资源尚未创建，名称目前只作设计约定。

## 7. 打印、识别与导出

- 使用统一 A4 网页打印规则，支持浏览器打印与另存 PDF；正式单据编号和快照固定，重复打印保持一致。
- 签字件优先识别二维码，文字识别仅辅助匹配单号，人工核对归档并保留原件。OCR 服务待脱敏样本验证，当前未启用。
- 备份按最新决定简化：短期允许暂不启用，后续按需手动整体导出。早期每日自动备份、30 天恢复点和一天数据损失窗口不再作为当前要求。
- 手动导出应覆盖网站源码快照或构建产物、部署说明、数据库结构与数据、附件本体及关联清单。账号和权限恢复范围单独验证；数据库导出不包含 Storage 文件本体。
- 导出可在开发机运行，先保存本地；如后续需要云端归档，再考虑私有 R2。不为此新增 Cloud Run Jobs、Scheduler、独立备份服务器或复杂备份服务。
- 凭据另行私密保管，公开仓库保留配置变量名与恢复说明；清理导出包不删除业务历史或签字原件。手动导出与恢复工具尚未实现。

## 8. 本地环境与仓库机密

- 项目目录已改名为 `gear`，Git 历史与已忽略的 `.env` 保留。`.env` 权限为 `600`，只用于记录当前已知配置，不代表配置已经部署或有应用读取。
- [.env.example](../.env.example) 只列变量名和空值。主机地址、前端域名、CDN 分配地址、云项目与资源标识、Supabase 参数均只进入本地私有 `.env`；未知值留空。
- 已确认复用现有 Supabase 项目；`.env` 同时记录待创建的 schema、附件桶和函数命名前缀。隔离实现和云端写入尚未授权执行，不自动建立表、策略或业务数据。管理令牌和云账号凭据不复制为应用运行密钥。
- 邮件 OAuth 客户端文件与令牌文件继续保存在仓库外，`.env` 仅记录文件位置。SSH 密钥和云 CLI 凭据继续使用现有私有凭据存储。
- 证书私钥、ACME 账号及 EAB 秘密保存在仓库外，不写入 `.env.example` 或常规 CI；目标证书已申请，专用证书标识与既有证书标识分别私密记录。
- `SUPABASE_SECRET_KEY` 和回源校验值只能在服务端使用；前端运行时所需的公开地址和 publishable key 可被浏览器查看，公开可见不等于可获得业务权限。
- 已建立公开 GitHub 仓库并关联 `origin`，仓库标识只记录在私有 `.env` 的 `GITHUB_REPOSITORY`。已使用 Actions Secrets 保存 SSH 部署参数、源站 IPv4/IPv6、前端/CDN 地址与分发标识、DNS 项目标识及 Supabase 地址、项目标识和 publishable key，并核对机密名称清单。
- 日常 SSH 私钥、邮件令牌、Supabase 管理密钥及云管理凭据继续保存在原有私有环境。三个 Actions 检查任务不读取部署 Secrets；另已准备默认关闭的发布任务，拟使用专用受限上传密钥、AWS OIDC 与指定 Worker 的 Editor token，待单独授权后配置并启用，不直接导入整份本地 `.env`。
- 提交前同时检查忽略规则、暂存内容和私密值泄漏。`.gitignore` 不清除已跟踪内容或历史提交中的信息。

## 9. 尚未完成

前端框架与组件组合定案、共用 Supabase 的隔离实现及应用接入、共享 Auth 邮件和密码流程的影响确认、API 浏览器检查豁免授权、自动部署专用权限配置与真实运行验收、设备管理应用、手动导出工具及大陆全流程验收均待完成。前后端域名接入、独立 Nginx 回源站点、CloudFront 启用、Google 证书接入与定时续期配置已完成，最小静态页与真实浏览器链路测试通过；自动发布代码已准备但保持关闭，证书真实续期及分发替换继续观察。参数和业务待办见[待确认事项](open-questions.md)。

历史说明：早期 Cloudflare 托管前端、R2 保存日常附件和自动备份的推荐已由本次选择替代；此前比较保留在 Git 历史与[最初提案](technical-proposal-v1.md)中，不作为当前实施要求。
