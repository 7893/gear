# 签字原件服务

状态：本地代码和模拟网络检查已完成；本轮经用户授权部署并开启后端。运行时配置、JWT 拒绝和私有桶技术连通检查通过，真实用户的签字原件上传与归档仍待验收。浏览器上传及下载都须有有效用户 JWT；`supabase/config.toml` 为本函数保留平台 JWT 校验，函数还向 Auth 验证用户并以用户 JWT 调用设备簿授权接口。

```sh
pnpm -C supabase/functions/gear-evidence install --frozen-lockfile
pnpm -C supabase/functions/gear-evidence run check
```

`POST` 接收 multipart：`file`、`document_id`（或 `event_id`）、`expected_version`、`request_id`，可选 `recognition`、`source_kind`、`external_reference`、`correction_reason`。读取原件使用 `GET` 与 `attachment_id`（或 `action=originals` 导出原件 ZIP），传同一用户的授权头；不接受桶名或对象路径参数。响应错误只有固定代码，不输出内部诊断、原件内容或凭据。

运行环境需要统一的 `GEAR_DB_SCHEMA`、`GEAR_STORAGE_BUCKET`、`GEAR_EVIDENCE_APP_URL` 及字面 `true` 的 `GEAR_EVIDENCE_ENABLED`；项目内置 `SUPABASE_URL`、`SUPABASE_PUBLISHABLE_KEYS` 和 `SUPABASE_SECRET_KEYS` 留在函数运行环境，不复制到浏览器或公开仓库。本轮新增项目级设置、创建私有桶及安装隔离策略已获授权；后续变更仍按其范围授权。

PDF 用固定版本 pdf-lib 解析页数并拒绝加密或损坏文件；图片检查签名、容器及尺寸，不宣称完整图片解码或病毒扫描。实际大小和 SHA-256 由服务端计算。文件对象只新增、不覆盖或删除；成功入库需要仅服务端可执行的 `gear_2026.commit_attachment`。该接口在当前调用者仍是本应用有效经办人或管理员时生效，不给服务角色扩展表权限。

下载取得原件后再次核对业务权限，校验大小及哈希；响应 `no-store`、`nosniff`，不提供可转交的下载签名 URL。浏览器只把成功下载的 Blob 用于本地预览或下载。

测试覆盖实际虚构 PDF、内容指纹、上传重复确认、已有对象验证、匿名和权限拒绝、私有下载、文件类型、加密/损坏 PDF、页数、请求大小及图片容器边界。测试不调用真实 Auth、Storage 或云端数据库；真实 Edge Runtime 的配置、身份拒绝、跨域及只读业务查询已通过；完整用户上传下载待本人验收。识别线索是客户端提示，人工核对才决定归档。完整状态、数据库接口及上线范围见[实施记录](../../../docs/evidence-implementation.md)。

平台内置密钥为按名称索引的 JSON 字典，选择 `default` 或唯一有效值，缺失及歧义时拒绝提供服务，不回退到已撤销的旧服务 JWT。用户 Bearer 保留用户身份；服务密钥只用于 `apikey`，服务请求显式使用空 Authorization 以适配本项目网关。不复制平台服务密钥到网站、公开文件或 CI。
