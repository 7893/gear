# 技术选型提案

状态：待用户决定，尚未采纳或实施。查证日期：2026-10-16。

## 选择原则

用户允许在 Cloudflare、Oracle Cloud、Google Cloud、Supabase 之间选择。本轮先按功能适配与维护难度推荐，不以免费额度作为首要筛选条件；此前免费优先的偏好作为后续费用评估背景，不代表现在购买服务或确定预算。

## 推荐组合

| 部分 | 推荐 | 原因 |
| --- | --- | --- |
| 前端 | React + TypeScript + Vite | 与本地 Lens 的已有经验一致，适合表格、表单、批量操作 |
| 网站与业务 API | Cloudflare Workers Static Assets + Hono | 前端与 API 同域，集中处理授权、上传、识别和通知 |
| 身份认证 | Supabase Auth | 使用现成的密码认证、邮箱验证和重置流程 |
| 唯一业务主库 | Supabase PostgreSQL | 设备、单据、角色、审核状态统一存储；交接确认可使用数据库事务 |
| 签字件 | Cloudflare R2 私有存储 | 保存原始图片和 PDF，授权由 Worker 校验 |
| 注册防滥用 | Cloudflare Turnstile | 配合注册和登录限流；不能替代权限检查 |
| 邮件 | Cloudflare Email Service | Auth 邮件接自定义 SMTP，业务邮件由 Worker 调用发送接口 |
| 识别 | 二维码匹配优先，Google Cloud Vision OCR 补充 | 对已知单号做文字识别，不需要大模型推理才能完成闭环 |
| 独立备份 | Oracle Object Storage | 保存每日数据库导出、附件清单及增量文件，保留 30 天恢复点 |

React + Vite 和 Hono 均有 Workers 官方/项目部署说明：[React + Vite](https://developers.cloudflare.com/workers/framework-guides/web-apps/react/)、[Hono](https://hono.dev/docs/getting-started/cloudflare-workers)。具体版本和 UI 组件库在实现准备时固定，不照搬其他项目的版本锁。

## 数据与账号边界

推荐将“账号密码”具体实现为邮箱加密码，姓名另设显示字段；这是提案，若用户要求独立用户名登录需调整。Supabase Auth 原生支持邮箱或手机号配合密码：[密码认证](https://supabase.com/docs/guides/auth/passwords)。

注册、邮箱验证与管理员审核是不同环节。注册后即使能取得登录会话，也只能访问待审核页面。业务主库维护审核状态和角色，每次业务请求检查当前状态，不能仅信任可能尚未刷新的令牌角色。

业务请求统一经 Worker，数据库同时启用 RLS。普通请求使用用户身份调用受限制的数据接口；交接确认封装为数据库事务操作，原子完成持有人更新、单据确认、历史记录和待通知任务。管理员操作也须核对管理员身份。服务密钥不得进入浏览器，不能把绕过 RLS 的管理密钥当作所有业务请求的默认通道。实现参考：[RLS](https://supabase.com/docs/guides/database/postgres/row-level-security)、[角色权限](https://supabase.com/docs/guides/api/custom-claims-and-role-based-access-control-rbac)。

R2 不开放公共桶。上传、预览和下载均验证账号启用状态及权限；对象上传成功不等于已归档，须完成文件校验、单据关联和人工核对。保存原件，预览文件可单独生成。

不同时建立 D1 和 PostgreSQL 两个业务主库，也不使用 Oracle 数据库保存第二份在线台账。实时查询先采用操作后刷新、页面重新聚焦刷新和适度轮询，无需第一版引入 Realtime 或 WebSocket。

## 邮件和识别的实施前核验

Supabase 默认发信服务不作为正式邮件通道，需配置自定义 SMTP：[SMTP 文档](https://supabase.com/docs/guides/auth/auth-smtp)。Cloudflare 提供 SMTP 和应用发信接口，但 Email Sending 当前文档标记 Beta，需要核验实际账号可用性、域名配置和投递表现。它要求 Cloudflare DNS，向任意收件人发送需要 Workers Paid：[接入说明](https://developers.cloudflare.com/email-service/get-started/send-emails/)、[发信条件](https://developers.cloudflare.com/email-service/platform/pricing/)。当前未配置域名、发信或账号。

如该发信通道未通过验证，再在用户允许的云厂商中单独评估替代通道，不默认宣称邮件链路已可用。

单据带内部编号和二维码。浏览器能解码时直接候选匹配；否则由后端调用 Vision 提取单号。PDF 的每页计独立识别单元；页面栅格化、大小限制和多页匹配需在实现前确定。识别失败仍可手动关联，不阻塞上传归档。文字识别产品与计量规则见 [Vision 文档](https://cloud.google.com/vision/pricing)。二维码解析和多页文件处理尚未做原型验证。

## 为什么这样选

| 备选 | 判断 |
| --- | --- |
| Cloudflare Workers + D1 | 是可行的精简平台方案，但需另选认证实现；加入 Supabase 后，认证与角色数据放同一 PostgreSQL 主库更直接 |
| Oracle Autonomous Database / MySQL HeatWave | 数据库能力足够；当前没有需要它们特性的业务，将主库跨平台连接会增加接入和维护事项 |
| Google Cloud Run + 数据库 | 可行，但本项目不需要独立容器服务；Google 先承担 OCR 即可 |
| Supabase Storage 替代 R2 | 同样可行，可减少文件授权与数据平台之间的接线；本提案偏向已有 Cloudflare 使用经验下的 R2，后续可切换文件存储实现 |

Oracle 官方列有 Autonomous Database、MySQL HeatWave 和对象存储的 Always Free 资源，但可用性和额度按账户及地域核验：[Oracle 资源说明](https://docs.oracle.com/en-us/iaas/Content/FreeTier/freetier_topic-Always_Free_Resources.htm)。Autonomous Always Free 存在闲置停止和回收规则，不能当作无人维护的永久在线主库：[闲置规则](https://docs.oracle.com/en-us/iaas/autonomous-database-serverless/doc/autonomous-always-free.html)。

以上为架构判断，不代表实际账号资源已检查或部署性能已验证。

## 备份与恢复设计方向

- 每日导出业务数据库，并明确包含角色、审核状态、流转历史和附件关联关系。
- Auth 用户身份及恢复方式单独验证；不能只导出业务表就宣称全部账号可恢复。会话不作为长期备份恢复目标，恢复后要求重新登录。
- 原始附件采用不可覆盖对象键，增量复制到独立存储；每日清单记录对象键和校验值。
- 保留 30 天恢复点，不每天重复复制整套未变化附件。任何仍被保留恢复点引用的文件不得被提前清理。
- 数据库备份与附件清单需要共同校验一致性。恢复演练须验证设备去向、单据、附件和账号权限。
- 执行数据库导出的任务需要受控运行环境，暂不假设 Worker 可运行 pg_dump；执行器和密钥保管在实现方案中明确。
- 恢复时暂停自动发信，核对任务状态，避免重发历史通知。

## 开发与发布

继续使用本地 harness、CodeGraph 和 Graphify 的既定工作方式；尚无图索引时不自动建索引。新 Cloudflare 项目使用 cf CLI，除非以后明确采用已有 Wrangler 配置。源码与配置模板公开，部署凭据、备份和真实业务数据不提交。

本提案等待用户决定。批准技术方向也不等于授权购买、部署、变更云资源或公开当前仓库。
