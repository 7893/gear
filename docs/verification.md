# 开发验证约定

当前仓库包含设计文档和验证工具，尚无应用代码。CI 通过仅代表下列仓库检查通过，不代表业务验收、应用安全检查或部署完成。

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

## 应用代码阶段

框架确定后，将以下检查接到同一工作流，使用锁定依赖和虚构测试数据，验证失败时整次检查失败：

- 前端类型检查、静态检查及正式构建；构建产物检查不包含服务端密钥。
- 业务规则测试：设备状态流转、单号唯一、重复确认幂等、故障退回、临时分配到期，以及 UTC 与业务日期边界。
- 数据库和后端集成验证：待审核或停用账号无权读取，角色与附件授权正确，共享项目中其他应用身份不能越权，事务失败不产生半张单据。
- 最小端到端流程：申请、审核、领用、打印单据、上传签字件、归档及查询。打印效果、邮件送达与大陆网络访问还需实测。

数据库集成测试使用隔离环境，不连接现有共享业务数据库执行测试或迁移。当前尚未实施上述应用检查，[业务验收清单](acceptance.md)也仍待执行。

自动部署、分支保护和发布审批不属于当前验证工作流。部署工作流后续根据明确的目标和写操作授权单独配置；CI 通过不会触发服务器、DNS、CDN 或 Supabase 更改。
