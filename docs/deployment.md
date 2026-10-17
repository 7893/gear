# 自动发布流程

最小 TypeScript 页面的网络连接已通过开发机真实浏览器验证；随后按用户明确授权配置服务器访问、AWS 临时身份和 GitHub 发布环境，启用 `CD_ENABLED`。首次完整 GitHub 自动运行已通过 CI、网关版本发布、网站上传、CDN 刷新和真实浏览器验证，部署版本核对成功。Cloudflare 依照用户决定复用本地开发令牌，凭据保存在项目私有配置及 GitHub Secrets。业务实现暂停，本轮只完善交付流程。

## 目标流程

提交到主分支后，先完成仓库、网关、静态页和隔离数据库四项 CI 检查，再发布既有网关版本、上传网站文件、刷新 CloudFront 入口缓存，最后使用真实 Chromium 检查页面和跨域后端连接。数据库检查只创建临时本地集群，不执行云端迁移。任一环节失败，工作流标红并停止后续步骤。

工作流只允许 `main` 的推送或手动运行进入发布任务，且要求仓库变量 `CD_ENABLED=true`。PR 只检查，不能发布或获取部署 Secrets。主分支运行不自动取消正在执行的发布，避免新提交打断文件上传；发布目标与 CI 使用同一提交。

[发布脚本](../scripts/deploy.py)重新构建该提交的生产产物，构建进程只接收必要配置，不继承部署密钥。网站运行配置由私有环境注入，包含 API origin、Supabase publishable key 和发布提交标识。浏览器验证除现有连接检查外，还核对该提交标识，避免把旧页面的成功当作本次发布成功。

## 已配置的发布权限

以下配置均已获得明确授权并完成，未修改其他业务站点：

| 位置 | 已完成配置 | 权限边界 |
| --- | --- | --- |
| 部署主机 | 专用无 sudo 账号与独立 SSH 密钥；现有项目目录交给该账号写入 | 公钥强制执行 `rrsync -wo -no-del`，限定项目目录、禁止删除，不允许交互命令和转发；不修改其他站点 |
| AWS | GitHub OIDC 身份提供方与专用角色 | 信任精确的仓库身份及 `production` 环境；仅允许目标 CloudFront 分发的 `CreateInvalidation`、`GetInvalidation`，不配置长期 AWS 密钥 |
| GitHub | `production` 环境限主分支、专用 Secrets、启用变量 | 主分支四个检查任务通过后才发布，部署凭据只进入发布步骤 |

受限上传已通过成功传输预检、普通身份查询命令拒绝和删除选项拒绝检查；Nginx 配置摘要保持不变。AWS 权限策略通过官方校验，生产环境分支限制与精确 OIDC 信任条件已核对。精确策略与凭据清单保存在项目已忽略的私有目录，原始操作记录保存在仓库外；公开文档不记录真实账号、域名、地址或资源编号。

Cloudflare 按用户决定复用现有本地开发令牌，不创建新令牌，不修改原令牌权限。其副本保存在项目已忽略的 `.private/credentials/`，由 `.env` 的 `CLOUDFLARE_API_TOKEN_FILE` 引用；仓库使用同名 `CLOUDFLARE_API_TOKEN` Secret。现有令牌权限范围继承原配置，不能把本项目脚本只更新一个网关等同于令牌本身只拥有该网关权限。

GitHub 的 OIDC subject 格式须从仓库接口核对；当前仓库启用不可变身份，不能直接套用只有仓库名称的旧示例。环境分支规则与 AWS 精确 subject 一起限制发布来源。[GitHub 官方说明](https://docs.github.com/en/actions/how-tos/secure-your-work/security-harden-deployments/oidc-in-aws)。

Cloudflare 支持只授予指定既有 Worker 的 Editor 权限，可在以后需要收紧凭据时另行配置；当前依照用户决定使用开发令牌。本方案仍使用 `cf workers versions create` 和 `cf workers deployments create` 发布版本，保留已经配置好的域名连接，不调用触发器部署。[权限说明](https://developers.cloudflare.com/workers/authorization/workers/)、[版本发布说明](https://developers.cloudflare.com/cf/projects/#upload-a-version)。

## 配置与故障处理

所需 Secret 名称见[工作流](../.github/workflows/verify.yml)的发布步骤；本地文件引用名称见[环境模板](../.env.example)。SSH 私钥和主机公钥校验记录只保存在私有文件与 GitHub Secrets，不复用日常开发机的 SSH 私钥。主机公钥通过已有可信 SSH 连接核对，CI 开启严格校验，不能在运行时盲目信任 `ssh-keyscan` 的结果。

项目级凭据目录权限为 `700`，令牌、专用 SSH 私钥、主机公钥记录及私有清单文件权限为 `600`，全部由 `.private/` 忽略规则覆盖。`.env` 保持 `600` 并记录凭据文件路径；私有清单记录来源、用途、GitHub Secret 名称及是否已启用，不把尚未安装的 SSH 公钥写成已授权。部署所需凭据同步至仓库 Secrets，现有云管理员凭据及邮件授权文件继续通过私有路径引用，不混入部署工作流。

发布前检查 AWS 临时身份和受限上传通道。网站先上传静态资源及运行配置，最后替换首页，保留旧哈希资源和 `robots.txt`；不全量删除网站目录，不重载 Nginx。网关上传的新版本按提交说明匹配后，才切换到该版本。CDN 只刷新 `/`、`/index.html`、`/runtime-config.json`，等待完成后再运行浏览器验证。公开日志只显示步骤结果，不打印实际地址、资源标识、工具原始响应或凭据。

前后端发布不是跨平台事务：部分发布成功后后续步骤仍可能失败，标红不会自动撤销已经完成的更新。当前回退方式为签名还原对应提交后重新发布。首次真实自动运行已完成，公开日志只显示各阶段成功状态，详细运行记录及发布标识私密保存。

本流程不授予 Supabase 管理权限，不创建业务 schema、桶或函数，不修改共享 Auth 设置，不执行数据库迁移。后续业务后端发布和迁移需按共享项目隔离要求另行接入，不能把当前网络测试视为其验收。Browser Integrity Check 兼容规则继续保持未授权、未实施；真实浏览器连接不受当前脚本客户端的拦截问题影响。
