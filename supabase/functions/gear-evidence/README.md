# 签字原件服务

状态：本地代码和模拟网络检查已完成，尚未部署。浏览器上传及下载都须有有效用户 JWT；`supabase/config.toml` 为本函数保留平台 JWT 校验，函数还向 Auth 验证用户并以用户 JWT 调用设备簿授权接口。

```sh
pnpm -C supabase/functions/gear-evidence install --frozen-lockfile
pnpm -C supabase/functions/gear-evidence run check
```

`POST` 接收 multipart：`file`、`document_id`、`expected_version`、`request_id`，可选 `recognition`、`source_kind`、`external_reference`、`correction_reason`。读取原件使用 `GET` 与 `attachment_id`，传同一用户的授权头；不接受桶名或对象路径参数。响应错误只有固定代码，不输出内部诊断、原件内容或凭据。

运行环境需要统一的 `GEAR_DB_SCHEMA`、`GEAR_STORAGE_BUCKET`、`GEAR_EVIDENCE_APP_URL` 及字面 `true` 的 `GEAR_EVIDENCE_ENABLED`；项目内置 `SUPABASE_URL`、`SUPABASE_ANON_KEY` 和 `SUPABASE_SERVICE_ROLE_KEY` 留在函数运行环境，不复制到浏览器或公开仓库。新增项目级设置及创建私有桶、安装隔离策略均须另行授权。

PDF 用固定版本 pdf-lib 解析页数并拒绝加密或损坏文件；图片检查签名、容器及尺寸，不宣称完整图片解码或病毒扫描。实际大小和 SHA-256 由服务端计算。文件对象只新增、不覆盖或删除；成功入库需要仅服务端可执行的 `gear_2026.commit_attachment`。该接口在当前调用者仍是本应用有效经办人或管理员时生效，不给服务角色扩展表权限。

下载取得原件后再次核对业务权限，校验大小及哈希；响应 `no-store`、`nosniff`，不提供可转交的下载签名 URL。浏览器只把成功下载的 Blob 用于本地预览或下载。

测试覆盖实际虚构 PDF、内容指纹、上传重复确认、已有对象验证、匿名和权限拒绝、私有下载、文件类型、加密/损坏 PDF、页数、请求大小及图片容器边界。测试不调用真实 Auth、Storage 或云端数据库；仍需上线后验证真实 Edge Runtime。识别线索是客户端提示，人工核对才决定归档。完整状态、数据库接口及上线范围见[实施记录](../../../docs/evidence-implementation.md)。
