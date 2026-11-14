# 模型列表与全局审核规则

## 使用已有模型账号

在「模型路由」编辑已有账号时，可以直接点击「获取模型列表」，不需要重新输入已保存的 API Key。浏览器只提交账号身份，服务端使用该账号已保存的地址和加密凭据请求供应商；原密钥不会回传到页面。仅在环境变量 `MODEL_PROVIDER_BASE_URLS` 中配置的旧地址也会正确回填。

如果修改了地址，需要先保存账号配置，或明确输入 API Key 验证新的地址。尚未保存的新地址不能直接使用旧密钥探测。模型列表请求有完整响应超时和大小限制，供应商错误不会把密钥回显到页面。

## 维护全局审核规则

「审核规则」页统一管理全局规则与各仓库规则。「分析设置」保留前往该页的入口，不再提供第二份全局规则表单。

全局规则支持三种输入方式：

- 直接编辑文本。
- 上传 UTF-8 编码的 `.md`、`.markdown` 或 `.txt` 文件。
- 从公开的 HTTP(S) 文本链接导入。

文件与链接都先显示预览。选择「追加」或「替换」后，内容才进入编辑区；点击「保存」后才对新的分析任务生效。URL 导入保存的是这次下载的文本快照，后续分析不自动重新下载该链接。导入失败、刷新失败或保存冲突不会丢弃未保存的草稿。

每份全局规则最多 16,000 字符。文件、下载内容和请求正文均有大小限制，超限会明确拒绝，不会悄悄截断后保存。URL 下载逐跳校验目标地址，不接受私网、回环、带账号密码的链接或二进制响应，并严格校验 UTF-8。

仅管理员可以读取全局规则；只读账号不能保存或导入。多人同时编辑时，保存请求携带已读取内容的指纹；旧版本提交会返回冲突，需先读取最新内容后再合并草稿。

已有规则沿用 `system_settings` 中的 `review_rules_global`，无需迁移或重填。全局规则继续用于 Issue 分析、普通 PR 审查和 PR 专家团队；关闭仓库目录规则不会停用全局规则。尚未配置 GitHub App 或没有已安装仓库时，也可以管理全局规则。

## 代码与接口

| 行为 | 位置 |
| --- | --- |
| 获取模型列表、读取已保存凭据 | `apps/api/src/commands/providers.ts` |
| 已有账号的模型编辑页面 | `apps/web/src/pages/ProviderPage.tsx` |
| 全局规则 HTTP 接口 | `apps/api/src/commands/global-rules.ts` |
| 全局规则的读取、指纹和并发保存 | `packages/database/src/global-review-rules.ts` |
| 规则 URL 下载与限制 | `packages/github-adapter/src/rule-source.ts` |
| 全局规则编辑及导入界面 | `apps/web/src/components/GlobalRulesEditor.tsx` |
| Issue/PR 规则注入 | `apps/analysis-worker/src/review-rules.ts` |

`POST /setup/models` 保留原有 `{baseUrl,apiKey}` 请求，并支持 `{baseUrl,provider,accountName}` 读取已保存账号。已有权限检查继续生效。

`GET /repo-rules/global` 返回内容、内容指纹与限制。`PUT /repo-rules/global` 接收 `{content,expectedContentHash}`；冲突返回 409。`POST /repo-rules/global/from-url` 接收 `{url}` 并返回下载预览，不直接修改规则。
