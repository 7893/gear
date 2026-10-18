# 认证邮件适配器

状态：本地代码及模拟提供方测试已完成，函数已部署，六项机密及共享 Hook 经授权配置。真实 Edge Runtime 已验证签名保护，Gmail OAuth 刷新成功；指定首个账号已完成真实注册收码和邮箱验证，真实密码找回已由本人确认成功。该函数用于 Supabase Send Email Hook，经已有 Gmail OAuth 发信，不接收普通浏览器发件请求。

## 验证与配置

```sh
pnpm -C supabase/functions/gear-auth-mail install --frozen-lockfile
pnpm -C supabase/functions/gear-auth-mail run check
```

测试采用虚构签名和模拟 OAuth/Gmail 响应；覆盖签名篡改、过期、大小限制、UTF-8 MIME、固定请求主机、邮箱更换时双验证码映射、认证类型与安全通知、发送结果不明时不在函数内重试。Node 检查不代替部署后的 Supabase Edge Runtime 验证。

需要六项私有运行配置：

- `GEAR_AUTH_WEBHOOK_SECRET`：Supabase Hook 的 Standard Webhooks 签名秘密。
- `GEAR_AUTH_PUBLIC_URL`：邮件链接使用的 HTTPS 认证 API origin。
- `GEAR_GMAIL_CLIENT_ID`、`GEAR_GMAIL_CLIENT_SECRET`、`GEAR_GMAIL_REFRESH_TOKEN`：既有 Gmail OAuth 授权。
- `GEAR_MAIL_FROM`：与已授权 Gmail 发件身份一致的邮箱。

这些值只能通过服务端机密注入。Supabase 的函数机密属于项目级，因此使用 `GEAR_` 前缀，并在写入前检查同名项，不能覆盖其他业务变量。公开模板只列空变量名，凭据来源继续由项目私有记录引用。

`supabase/config.toml` 为本函数关闭平台 JWT 校验，以接收 Auth 发出的签名 HTTP 请求；函数内部必须校验 Standard Webhooks 原始报文签名及时间戳。仅对该函数生效，不修改已有函数。无签名、篡改或过期请求在访问 Google 前拒绝。报文按实际字节限制，原始报文、验证码、链接、收件人和令牌均不写日志。

## 发送与共享影响

支持注册、邀请、登录链接、密码恢复、重新认证、邮箱变更和七类安全通知。验证码和验证链接只保存在受保护的 Auth 流程和邮件中，不写入普通业务待发表。设备簿注册通过已有 `gear_application_name` 标记选择专用模板，仅发送六位纯数字验证码，不包含验证链接或令牌哈希；代码长度不符时在访问 Google 前拒绝。其他应用的通用邮件继续保留认证链接及 Auth 指定的实际回调。六位长度配置与本函数更新已获授权并应用，指定首个账号的真实注册收信及验证已完成，见[实施记录](../../../docs/account-implementation.md#六位验证码调整)。

所有内容使用通用认证文字；一旦启用此 Hook，整个共享项目会改用所配置的 Gmail 身份和此处文字发送认证邮件，现有自定义模板不会由 Hook 自动继承。更换邮箱时按官方兼容字段映射分别发送到新旧邮箱，邮箱更改通知发送给原邮箱；部分发送成功而后续失败无法撤回。解除登录身份的通知受上游 Hook 报文限制：当前没有独立收件邮箱字段，只能发送给报文中的当前账号邮箱，不能保证与原 SMTP 的被解除身份邮箱一致。启用前须核对其他应用是否依赖此通知。

OAuth 与提交邮件共用 4.5 秒请求期限；实例内短暂缓存访问令牌，不持久化或输出。Google 接受提交才返回成功，这不证明已投递。超时返回受控失败且不在函数内再次发送；Supabase 或调用方的重试仍可能导致重复邮件，当前不承诺跨实例恰好一次投递，也不新增用于存储认证凭证的业务表。

本次启用已获单独授权；未来更改共享发信配置仍需相应授权。函数不随网站 CD 发布，现有 CI 不持有 Gmail 凭据。实施差异见[账号接入记录](../../../docs/account-implementation.md)。

参考：[Supabase Send Email Hook](https://supabase.com/docs/guides/auth/auth-hooks/send-email-hook)、[Gmail API messages.send](https://developers.google.com/workspace/gmail/api/reference/rest/v1/users.messages/send)。

## 统一模板

[templates.ts](templates.ts)集中提供设备簿六位验证码与业务通知内容，具体用途和上线边界见[邮件模板与操作规则](../../../docs/email-templates.md)。设备簿注册邮件已调用此模块并部署；找回已完成接入并经授权更新线上函数，审核通知消费及专用调度已获授权部署，实际任务收件待本人验收；到期通知仍待实现。其他应用继续使用原通用模板，不能仅根据共享用户曾申请设备簿就改写其在其他应用的找回邮件。

## 中文编码

设备簿模板固定标题和正文均为中文纯文本。发送层采用 UTF-8、RFC 2047 主题编码和 Base64 正文传输；本地已补齐长主题分段、正文 76 字符折行和 CRLF 规范化，并通过中文、生僻字及长文本编解码测试。此次编码加固已获授权更新线上函数；此前二十三封模板预览使用同样编码发送，用户已确认 Gmail 显示正常。详见[编码规则](../../../docs/email-templates.md#中文与字符编码)。

## 密码找回接入

已增加 `GEAR_AUTH_APP_URL` 精确识别设备簿找回入口、六位找回模板及仅服务端资格检查，并经授权完成迁移、配置及线上函数更新。真实 Edge Runtime 已用无资格虚构身份验证平台凭据和 RPC 连接，不触发 Gmail 发信；实际找回已由本人确认成功。只有该找回路径使用平台自带 `SUPABASE_URL`、`SUPABASE_SERVICE_ROLE_KEY`，先调用迁移 003 的只读 RPC，通过后才发送；其他应用的找回保持原行为。新增设置不加入注册邮件的必填检查，避免未开放找回时阻断既有注册。配置、权限与上线授权范围见[密码找回接入](../../../docs/recovery-implementation.md)。

## 独立的审核通知发送器

同一源码目录的 [notification-index.ts](notification-index.ts) 和 [notifications.ts](notifications.ts) 部署为新的 `gear-notification-mail`；入口文件与认证 Hook 不同。部署新函数时须明确选择该入口，不能覆盖现有认证函数。新函数关闭平台 JWT 校验后由专用后台令牌保护，普通浏览器不能触发发信。其测试纳入当前包的检查流程，复用中文模板与 MIME 编码，保持现有认证入口行为不变。

独立通知函数、迁移及专用调度已获授权部署，无令牌拒绝和合法令牌空闲返回均已通过真实环境检查；通知开关在页面发布验证后开启，实际任务收件待本人验收。数据库迁移、最小权限、Supabase Cron/Vault 配置、有限重试及授权范围见[审核通知接入](../../../docs/notification-implementation.md)。
