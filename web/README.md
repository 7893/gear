# 设备簿前端

Vue 3、Vite、Vue Router 与 TypeScript，使用官方 Supabase JavaScript SDK 接入账号。页面采用简单表单和本地样式，不加载第三方字体或组件 CDN。

```sh
pnpm -C web install --frozen-lockfile
pnpm -C web run check
pnpm -C web run dev
```

`check` 包含 ESLint、Prettier、Vue/TypeScript 检查、Playwright 浏览器测试及正式构建。浏览器测试使用本地服务器和虚构 Auth/RPC 响应，不连接共享项目；首次运行需安装相应 Chromium。数据库事务另在隔离 PostgreSQL 中验证，这两类测试不代表真实发信和完整 Supabase Auth 集成已经通过。

## 配置与路由

构建产物不包含部署地址。运行时从 `/runtime-config.json` 读取 `apiUrl`、`publishableKey`、`release`、`accountsEnabled`；实际文件由已获授权的发布流程注入并忽略。只有公开 publishable key 可进入浏览器，管理密钥和发件令牌不进入本目录。

`accountsEnabled` 只有明确的 `true` 才开启账号服务。共享认证配置已获准接入，账号发布开关已开启；关闭时不创建 Auth 客户端，不发送登录、注册或会话刷新请求。GitHub 发布步骤通过仓库变量 `GEAR_ACCOUNTS_ENABLED` 控制此项：共享配置获准并检查通过后，开放入口供指定管理员本人注册、验证，再由部署者初始化权限并完成真实流程验收；不能以切换此变量替代共享配置审批或验收。

| 路由 | 内容 |
| --- | --- |
| `/#/` | 账号状态、验证后提交使用申请 |
| `/#/login` | 邮箱密码登录 |
| `/#/register` | 注册；已有共享身份应直接登录 |
| `/#/verify` | 注册邮箱验证码及重发 |
| `/#/recover` | 找回密码，独立发布开关缺省关闭 |
| `/#/members` | 管理员审核、角色和停用处理 |
| `/#/diagnostics` | 保留的页面、网关和 Auth 只读连接检测 |

采用 hash 路由复用现有 Nginx 和 CloudFront，无需更改源站路由规则。设备簿注册使用六位纯数字验证码；注册后进入验证页并保留邮箱，邮箱不进入 URL，不需要跨浏览器的 PKCE 校验值。旧版 PKCE 回调的清理和交换仅保留兼容处理，不接收 URL fragment 中的隐式登录令牌。六位长度配置已获授权应用，页面按既有 CI/CD 发布；实际验收状态见[实施记录](../docs/account-implementation.md#六位验证码调整)。

## 权限边界

会话使用应用专属存储键，退出使用 `scope: local`。服务端按当前成员及邮箱验证状态授权；浏览器不能通过修改 metadata、表单角色或页面状态取得权限。刷新权限时先清除旧成员资料，失败或降级不继续显示旧管理列表；提交审核仍由数据库再次检查权限、版本和请求幂等键。

注册页面建议至少 12 字符；共享 Auth 当前服务端最短长度仍是原有 6 字符，尚未更改全项目密码策略。页面参数不能替代服务端限制。找回密码已加入独立开关，本次经授权开启并发布；普通已登录改密仍留待后续接入。

## 密码找回

密码找回的运行配置 `recoveryEnabled` 由仓库变量 `GEAR_RECOVERY_ENABLED` 控制，缺省关闭。本次已先完成迁移、私有配置及邮件函数检查，再经授权开启该变量并通过既有 CI/CD 发布。页面包含请求、六位验证、设置密码及重新登录，恢复会话只保存在独立内存客户端。服务端资格、额外私有配置和实际验收见[接入记录](../docs/recovery-implementation.md)。
