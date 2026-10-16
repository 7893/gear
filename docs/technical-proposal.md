# 技术选型提案

状态：待用户决定，未实施。查证日期：2026-10-16。

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
| 邮件 | Cloudflare Email Service，条件性推荐 | Auth 接 SMTP，业务通知调用发送 API；需验证 Beta 可用性及投递 |
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

## 两项待验证选择

邮件：Cloudflare Email Sending 当前标记 Beta，要求配置 Cloudflare DNS 域名。采用前核验账户可用性、Supabase SMTP 接入与实际投递。Supabase 默认邮件服务不作为正式发送通道。参考 [Cloudflare 发信](https://developers.cloudflare.com/email-service/get-started/send-emails/)、[Supabase SMTP](https://supabase.com/docs/guides/auth/auth-smtp)。若未通过验证，在允许的供应商中另评估邮件通道，不宣称链路已验证。

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

替代[最初提案](technical-proposal-v1.md)，保留历史。没有创建资源、部署服务、测试账号、发送邮件或运行应用测试。技术方向由用户决定；开源许可证尚未确定。
