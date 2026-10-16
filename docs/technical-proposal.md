# 技术选型提案

状态：待用户决定，未实施。查证日期：2026-10-16。

后续单项决策：整体技术栈继续暂缓，邮件通道已另行选定自有域名 Google 邮箱及 Gmail API，并完成独立发信验证。该部分以[邮件与通知设计](email-design.md)为准；其余推荐仍待决定。

## 最新约束：需重新验证下述推荐

用户已明确 Supabase 仅免费版、Oracle Cloud 仅永久免费资源，Google Cloud 和 Cloudflare 可少量付费。此约束取代下文早期“先不考虑费用”的比较前提；下述组合暂不定案。

另外要求中国大陆普通网络能正常访问，且已有自有域名。选型验收必须覆盖登录、审核、台账、上传、附件预览下载、验证码、邮箱验证与密码重置链接，不能只验证首页。

- 网站使用自有域名；脚本、字体、图标与样式尽量随站点构建发布，减少浏览器直接依赖外部 CDN。
- 如果 Supabase 保留为后台，评估同域应用接口承接认证和数据访问的必要性；这会改变当前推荐的浏览器直连路径，须计入开发复杂度，不能把增加网关视为没有代价。
- 同域 API 或自有域名都不能保证大陆网络稳定；发布前需在实际使用地区和网络测试，测试失败时重新选择入口和区域。
- 邮件验证和密码重置回调不能遗留必须直连第三方域名的关键步骤；如使用验证码，需验证其脚本和挑战链路，不得以关闭验证掩盖失败。
- 如引入 Google OCR，调用放在服务端，浏览器不直接依赖 Google 服务。
- 不依赖 Supabase 付费自定义域名功能：[官方说明](https://supabase.com/docs/guides/platform/custom-domains)。
- Cloudflare 常规服务不等于其中国大陆网络服务；China Network 是 Enterprise 的单独订阅，不纳入当前小额付费方案：[官方说明](https://developers.cloudflare.com/china-network/)。

尚未完成大陆测试网络与具体部署区域的连通性实测；真实域名和环境参数不写入公开文档，不承诺单凭域名配置即可达标。

## 决策依据

不考虑本地使用经验或现有资源优势。本轮先不考虑费用，以功能适配、维护工作量、数据一致性、开源交付和迁移难度为依据。有必要才分散，不强求一家，也不因某项资源免费就引入新平台。

## 推荐组合

推荐 Supabase 为业务核心，Cloudflare 承载网站及辅助服务。

| 部分 | 推荐 | 项目收益 |
| --- | --- | --- |
| 前端 | React + TypeScript + Vite | 支持交互表格、表单和打印，静态构建可迁移，无需 SSR |
| 网站 | Cloudflare Workers Static Assets | 发布前端，不再额外部署重复的业务后端 |
| 账号 | Supabase Auth | 密码认证、邮箱验证、会话和重置密码 |
| 主数据库 | Supabase PostgreSQL | 台账、审核、角色和单据集中；用事务保证交接一致性 |
| 签字件 | Supabase Storage 私有桶 | 与数据库共用 RLS 权限依据，减少跨云文件授权逻辑 |
| 服务端集成 | Supabase Edge Functions | 受保护的管理操作、发信与识别调用 |
| 提醒任务 | Supabase Cron | 定时扫描到期记录及处理待发通知 |
| 注册防滥用 | Cloudflare Turnstile | 配合限流，不替代角色和审核检查 |
| 邮件 | 自有域名 Google 邮箱 + Gmail API，已单独选定 | 独立授权、刷新及同域收件已验证；正式运行环境和认证邮件接入仍需验证 |
| 独立备份目标 | Cloudflare R2 私有桶 | 与主数据分平台，不再为备份单独引入 Oracle |
| 识别 | 二维码优先，云端文字识别补充 | 根据样本验证选择服务，不与业务流程绑定 |

Supabase 原生提供 [Edge Functions](https://supabase.com/docs/guides/functions)、[Cron](https://supabase.com/docs/guides/cron) 和基于 RLS 的[文件权限](https://supabase.com/docs/guides/storage/security/access-control)。将业务服务端放在这里的理由是减少账号、数据库、附件之间的接入工作，而非本地经验。

## 权限和数据边界

- 推荐邮箱加密码、姓名另设字段；独立用户名登录仍待用户明确。
- 邮箱验证与管理员审核分开。待审核账号即使已登录，也不能读业务数据或私有文件。
- 每次授权查询当前审核状态和角色，不能仅依赖尚未刷新的令牌。
- 普通查询使用用户身份及 RLS；交接确认通过受保护的数据库事务函数，一次完成状态更新、单据、历史和待通知记录。
- 前端不能直接分多次更新来模拟事务。管理员操作与 Edge Functions 同样要校验身份，管理密钥不能进入浏览器或作为所有请求的默认身份。
- 文件上传与数据库更新不是跨服务原子事务，使用待关联状态、重试和孤立文件清理机制；上传成功不等于归档成功。
- 当前状态先采用操作后刷新、页面重新聚焦刷新和适度轮询，不为十来个用户强加 Realtime 或 WebSocket。

参考：[密码认证](https://supabase.com/docs/guides/auth/passwords)、[RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)。审核和业务角色仍需实现，不能认为开通平台就自动完成。

## 备选取舍

| 方案 | 判断 |
| --- | --- |
| Cloudflare 全套 | 可行，但需另集成完整密码认证；D1、R2 和 Workers 并不自动提供账号与附件授权体系 |
| Oracle ADB + APEX | 适合表单台账，但交付方式和运行环境依赖 Oracle/APEX，当前没有必须使用其特性的需求 |
| Oracle MySQL + OCI 应用服务 | 数据库适合，但仍需组合认证、应用运行和文件授权；暂不考虑费用时，免费数据库不是充分理由 |
| Google Cloud 为业务核心 | 可行；本项目在 Supabase 中已有直接的关系数据、账号和附件组合，先不引入另一套主后端 |

这是工程取舍，不代表其他平台能力不足。Oracle 免费 MySQL 的私有子网、固定一天备份见[官方说明](https://docs.oracle.com/en-us/iaas/mysql-database/doc/creating-always-free-db-system.html)，ADB 闲置停止与回收见[官方说明](https://docs.oracle.com/en-us/iaas/autonomous-database-serverless/doc/autonomous-always-free.html)。

## 邮件与识别的后续验证

邮件：已选择 Gmail API，早期 Cloudflare 发信推荐不再作为当前方案。API 发信验证不等于托管认证服务的 SMTP 接入已打通；最终选择认证产品时，必须确认其自定义邮件发送方式能否调用该通道。外部投递、来信转发和正式服务端授权仍待验证，详见[邮件设计](email-design.md)。

识别：先解析自制单据二维码；失败后用文字识别匹配单号。使用实际脱敏样本比较 Workers AI 与 Google Cloud Vision，关注单号准确率、错误匹配、模糊拍照和 PDF 多页处理。Cloudflare 达标就保留两平台组合，不达标再将 Google 作为必要的第三方服务。暂未测试，不承诺准确率。参考 [Workers AI](https://developers.cloudflare.com/workers-ai/models/)、[Cloud Vision](https://cloud.google.com/vision/pricing)。识别失败仍允许人工关联。

## 备份与迁移

- 每日备份、30 天恢复点保持不变，目标为独立 R2 桶。
- 数据库导出包含角色、审核、单据、流转和附件关联；Auth 用户恢复另行验证，不能只导业务表。
- Supabase 数据库备份不含 Storage 实际文件，附件需单独增量复制并保存每日清单、校验值。见[备份说明](https://supabase.com/docs/guides/platform/backups)。
- 未变化文件不必每天复制，仍被恢复点引用的对象不可提前清理；核对数据库快照与附件清单的一致性。
- 数据库导出需要受控执行器，不能假设 Edge Functions 或 Workers 可运行 pg_dump。执行环境、运行限制和凭据保管在实施准备阶段验证，当前不声称备份链路已完成。
- 恢复演练检查设备、单据、附件、账号权限，并避免历史邮件重发。
- PostgreSQL 迁移脚本、授权策略及业务函数进入源码仓库。Auth 与 Storage 仍有平台耦合，不承诺零成本迁移。

## 当前状态

替代[最初提案](technical-proposal-v1.md)，保留历史。本提案初稿时尚未部署或发信；后续已经用户逐项授权完成 Gmail API 启用、独立邮箱授权及一封同域测试邮件，收件已确认。尚无应用代码、部署服务或应用测试，整体技术方向仍待决定；开源许可证尚未确定。真实环境信息与凭据不纳入本文。
