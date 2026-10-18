# 开发验证约定

当前仓库包含设计文档、接入网关、Vue 账号与设备页面、数据库迁移及认证邮件适配代码。CI 验证隔离场景，真实 Auth 发信和完整设备业务验收分别记录，不能互相替代。

## 当前工作流

[Verify](../.github/workflows/verify.yml) 在推送 `main`、提交或更新 PR 时运行，也支持手动运行。PR 的新运行取消旧运行，主分支不打断正在执行的运行；每个检查任务最长十分钟，已启用的发布任务最长二十分钟。

| 检查 | 当前范围 |
| --- | --- |
| 工作流语法 | actionlint 检查 Actions YAML、表达式及可用的 shell 静态检查 |
| 验证工具回归 | Python 标准库测试，覆盖私有路径、配置值、失效链接、中文锚点、提交范围、部署来源与参数边界、私密文件保护及网关版本选择 |
| 文档与公开配置 | 已跟踪常规文件、末尾换行、Markdown 行内本地链接与 ATX 标题锚点、配置模板空值及变量名唯一性 |
| 私有文件 | 拒绝跟踪 `.env`、私有记录目录、常见凭据文件与数据附件目录；不读取未跟踪文件 |
| 凭据扫描 | Gitleaks 默认规则扫描已获取的完整 Git 历史，输出脱敏，不上传扫描报告 |
| 提交规则 | 新增提交必须经 GitHub 验证签名；标题要求 ASCII、包含英文字母且不超过七个空格分隔单词，英文表达仍由人工审阅 |
| 后端接入网关 | 独立锁定依赖，执行 ESLint、Prettier、生成绑定类型后的 TypeScript 检查、八项行为测试与 Worker 构建；不连接共享数据库执行测试 |
| 前端账号与连接检测 | 独立锁定依赖，执行 ESLint、Prettier、Vue/TypeScript 类型检查、三十八项虚构 Auth/RPC 浏览器测试（账号、台账、流转与签字件）及 Vite 构建；不访问生产服务 |
| 认证邮件适配器 | 签名校验、MIME、收件人映射、固定提供方主机和失败处理；所有 Google 请求均为模拟，无真实发信凭据 |
| 签字原件服务 | 固定版本文件解析、实际大小/哈希、仅服务端完成接口、上传响应丢失及私有下载复核；所有云端请求均为模拟 |
| 数据库初始结构 | 以虚构 Auth 替身和业务数据运行临时 PostgreSQL 集群，验证迁移、RLS、并发唯一分配、快照与附件约束、跨日流水和回滚；不连接云端数据库 |

PR 检查实际贡献提交，排除 GitHub 临时合并提交；普通推送检查本次新增提交，首次推送和手动运行检查全部可达提交。签名验证调用 GitHub API，接口或验证服务不可用时检查失败，不静默跳过。

文档检查不联网验证外链，当前解析范围是 Markdown 行内链接和 `#` 标题，不代替完整 Markdown 渲染器。凭据扫描不能识别所有真实邮箱、IP、域名和资源编号；提交前仍需人工检查暂存内容，并在本地对照私有配置检查真实值。不要为了云端扫描而向 PR 暴露真实配置或凭据。

工作流使用 GitHub 托管的临时 Ubuntu runner，六个 CI 检查任务只有仓库内容只读权限，不引用部署 Secrets。数据库任务复用 runner 的 PostgreSQL 16，本地按目标环境验证 PostgreSQL 17；运行方法见[数据库迁移说明](../database/README.md)。使用普通 `pull_request` 事件，第三方 Action 固定完整提交 SHA，下载的验证工具固定版本与 SHA-256。已启用的发布任务单独使用 OIDC 与部署 Secrets，只允许可信主分支进入；配置及授权边界见[自动发布流程](deployment.md)。依赖升级时同时核对官方发行来源和校验值。

参考：[GitHub Actions 安全约定](https://docs.github.com/en/actions/reference/security/secure-use)、[提交签名验证字段](https://docs.github.com/en/rest/commits/commits#get-a-commit)、[Ubuntu runner 已安装软件](https://github.com/actions/runner-images/blob/main/images/ubuntu/Ubuntu2404-Readme.md)、[Gitleaks](https://github.com/gitleaks/gitleaks)、[actionlint](https://github.com/rhysd/actionlint)。

## 本地检查

在项目根目录执行，Python 3.10 或更新版本即可，无应用依赖安装。工具安装脚本支持 Linux x86_64 和 ARM64，将工具下载到临时目录；需要访问官方 GitHub 发行页面。

```sh
python3 -m unittest discover -s tests -v
python3 scripts/check_repository.py
bash scripts/install-ci-tools.sh /tmp/gear-ci-tools
/tmp/gear-ci-tools/actionlint
/tmp/gear-ci-tools/gitleaks git --redact --no-banner --log-opts="--all"
git diff --check
git diff --cached --check
```

公开文件检查以 Git 索引为文件清单，新文件加入暂存后才会检查；Gitleaks 的上述命令检查已提交历史，不包含未提交内容。新内容先审阅并暂存，再签名提交，在推送前重新扫描历史；不得把真实密钥加入提交来测试扫描器。不要打印真实 `.env` 或把它作为测试夹具。

本地提交使用已配置的 SSH 签名和 `git commit -S`，可用 `git verify-commit HEAD` 验证；不要把签名私钥或真实签名身份写入公开配置。云端签名检查依赖 Actions 事件上下文和临时只读令牌，无需为本地运行复制管理员令牌。

网关与静态页的本地检查命令见[基础设施工具](../infrastructure/README.md)。源码与配置均使用变量注入实际资源名称和地址，生成目录与 `.dev.vars` 已忽略；检查和构建不能作为部署、证书续期或完整业务可用性的证明。

静态测试页已在开发机用真实 Chromium 浏览器完成一次线上验证：HTTPS 页面经 CloudFront 返回 200，跨域后端健康检查及 Supabase Auth 设置只读查询均返回 200，重新检测成功且无页面脚本异常。测试使用默认浏览器行为，未修改 Browser Integrity Check、证书验证或共享业务数据；原始运行记录保存在仓库外。这覆盖网络接入与脚本运行，不覆盖登录、业务数据、附件、邮件或大陆网络。

随后已通过 GitHub 的首次完整自动发布：三个 CI 任务成功，发布任务完成 AWS OIDC 认证、受限 SSH 上传预检、网关版本发布、静态文件上传、CDN 刷新等待及 Chromium 实测。浏览器还核对运行配置中的提交标识与本次发布一致，避免把旧版本的成功当作本次发布成功。

## 应用代码阶段

应用语言已确认为 TypeScript，前端当前推荐 Vue 3 + Vite，具体组合见[技术记录](technical-proposal.md#开发语言与前端方案)。账号框架及当前检查已接入；后续设备应用实现时继续补齐以下检查，使用锁定依赖和虚构测试数据，验证失败时整次检查失败：

- 独立执行类型检查、静态检查、格式检查及正式构建；Vue 方案使用 `vue-tsc` 检查组件模板与 TypeScript，Vite 构建不代替类型检查。自定义 Edge Functions 的类型与运行时检查另行接入；构建产物检查不包含服务端密钥。
- 业务规则测试：设备状态流转、单号唯一、重复确认幂等、故障退回、临时分配到期，以及 UTC 与业务日期边界。
- 数据库和后端集成验证：待审核或停用账号无权读取，角色与附件授权正确，共享项目中其他应用身份不能越权，事务失败不产生半张单据。
- 最小端到端流程：申请、审核、领用、打印单据、上传签字件、归档及查询。打印效果、邮件送达与大陆网络访问还需实测。

数据库集成测试使用隔离环境，不连接现有共享业务数据库执行测试或迁移。账号、台账及领入、分发、退回的部分隔离检查已实施，多页 PDF 已在本地 Chromium 检查；完整上传归档、实际打印机及大陆网络验收仍待完成，[业务验收清单](acceptance.md)也仍待执行。

本地复用已有 Node、pnpm、Python 等运行环境及包缓存；当前项目仍需独立配置和锁定开发依赖，不引用其他项目的安装目录。当前前端已独立配置并锁定 ESLint、Prettier、Vue/TypeScript 与 Playwright，数据库采用隔离 PostgreSQL 检查；已有其他项目的安装不能视为本项目已配置或测试通过。

自动发布已按授权启用，只对主分支发布静态页与既有网关版本、刷新指定 CDN 缓存并验证，不执行数据库迁移或 DNS 更改；PR 仍只检查。GitHub 生产环境已限定 `main`，这不等于已经启用仓库主分支保护或人工发布审批。当前 CD 接入验收已通过，设备管理业务验收仍待实现后执行。
