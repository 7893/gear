# 开发验证约定

当前仓库包含设计文档、接入网关、最小静态测试页和验证工具，设备管理应用尚未实现。CI 通过代表相应仓库、网关与静态页检查通过，业务验收与发布状态分别记录。

## 当前工作流

[Verify](../.github/workflows/verify.yml) 在推送 `main`、提交或更新 PR 时运行，也支持手动运行。同一分支的新运行取消旧运行，单次最长十分钟。

| 检查 | 当前范围 |
| --- | --- |
| 工作流语法 | actionlint 检查 Actions YAML、表达式及可用的 shell 静态检查 |
| 验证工具回归 | Python 标准库测试，覆盖私有路径、配置值、失效链接、中文锚点及提交范围 |
| 文档与公开配置 | 已跟踪常规文件、末尾换行、Markdown 行内本地链接与 ATX 标题锚点、配置模板空值及变量名唯一性 |
| 私有文件 | 拒绝跟踪 `.env`、私有记录目录、常见凭据文件与数据附件目录；不读取未跟踪文件 |
| 凭据扫描 | Gitleaks 默认规则扫描已获取的完整 Git 历史，输出脱敏，不上传扫描报告 |
| 提交规则 | 新增提交必须经 GitHub 验证签名；标题要求 ASCII、包含英文字母且不超过七个空格分隔单词，英文表达仍由人工审阅 |
| 后端接入网关 | 独立锁定依赖，执行 ESLint、Prettier、生成绑定类型后的 TypeScript 检查、六项行为测试与 Worker 构建；不连接共享数据库执行测试 |
| 静态联通测试页 | 独立锁定依赖，执行 ESLint、Prettier、TypeScript 类型检查与 Vite 构建；不向 CI 提供实际运行配置，不访问生产服务 |

PR 检查实际贡献提交，排除 GitHub 临时合并提交；普通推送检查本次新增提交，首次推送和手动运行检查全部可达提交。签名验证调用 GitHub API，接口或验证服务不可用时检查失败，不静默跳过。

文档检查不联网验证外链，当前解析范围是 Markdown 行内链接和 `#` 标题，不代替完整 Markdown 渲染器。凭据扫描不能识别所有真实邮箱、IP、域名和资源编号；提交前仍需人工检查暂存内容，并在本地对照私有配置检查真实值。不要为了云端扫描而向 PR 暴露真实配置或凭据。

工作流使用 GitHub 托管的临时 Ubuntu runner，只有仓库内容只读权限，不引用任何部署 Secrets。使用普通 `pull_request` 事件，第三方 Action 固定完整提交 SHA，下载的验证工具固定版本与 SHA-256。依赖升级时同时核对官方发行来源和校验值。

参考：[GitHub Actions 安全约定](https://docs.github.com/en/actions/reference/security/secure-use)、[提交签名验证字段](https://docs.github.com/en/rest/commits/commits#get-a-commit)、[Gitleaks](https://github.com/gitleaks/gitleaks)、[actionlint](https://github.com/rhysd/actionlint)。

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

## 应用代码阶段

应用语言已确认为 TypeScript，前端当前推荐 Vue 3 + Vite，具体组合见[技术记录](technical-proposal.md#开发语言与前端方案)。框架定案并初始化应用后，将以下检查接到同一工作流，使用锁定依赖和虚构测试数据，验证失败时整次检查失败：

- 独立执行类型检查、静态检查、格式检查及正式构建；Vue 方案使用 `vue-tsc` 检查组件模板与 TypeScript，Vite 构建不代替类型检查。自定义 Edge Functions 的类型与运行时检查另行接入；构建产物检查不包含服务端密钥。
- 业务规则测试：设备状态流转、单号唯一、重复确认幂等、故障退回、临时分配到期，以及 UTC 与业务日期边界。
- 数据库和后端集成验证：待审核或停用账号无权读取，角色与附件授权正确，共享项目中其他应用身份不能越权，事务失败不产生半张单据。
- 最小端到端流程：申请、审核、领用、打印单据、上传签字件、归档及查询。打印效果、邮件送达与大陆网络访问还需实测。

数据库集成测试使用隔离环境，不连接现有共享业务数据库执行测试或迁移。当前尚未实施上述应用检查，[业务验收清单](acceptance.md)也仍待执行。

本地复用已有 Node、pnpm、Python 等运行环境及包缓存；当前项目仍需独立配置和锁定开发依赖，不引用其他项目的安装目录。ESLint、Prettier、Vitest 与 Playwright 是当前建议工具，版本与命令在应用初始化时统一；已有其他项目的安装不能视为本项目已配置或测试通过。

自动部署、分支保护和发布审批不属于当前验证工作流。部署工作流后续根据明确的目标和写操作授权单独配置；CI 通过不会触发服务器、DNS、CDN 或 Supabase 更改。
