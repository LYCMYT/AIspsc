# 多模型 AI营销视频生产平台

这是电商投流视频素材生产平台的 **B1 本地交互式模拟版本**。它包含 Vue 3 前端、浏览器内模拟服务、可持久化本地媒体、固定几何演示素材、业务合同测试和端到端测试。

当前版本不会调用外部模型或付费 Provider，也不包含生产后端、账号鉴权、支付充值、投放平台连接或自动长视频拼接。生成、识别与固定样例场景拆解均带有演示或未执行标识。

## 环境

- Node.js 24.19.x
- pnpm 12.3.4
- Chromium（运行 Playwright 端到端测试时安装）
- FFmpeg / ffprobe（仅重新生成或完整校验演示媒体时需要）

## 安装与运行

```sh
npm exec --yes --package pnpm@12.3.4 -- pnpm install --frozen-lockfile
npm exec --yes --package pnpm@12.3.4 -- pnpm dev
```

开发服务默认监听 `http://127.0.0.1:5173`。可编辑设计预览位于 `/design-panel.html`。

## 验证

```sh
npm exec --yes --package pnpm@12.3.4 -- pnpm verify
```

Playwright 配置固定使用仓库内的 `.cache/ms-playwright`。首次运行浏览器测试前，请将安装目录指向该位置：

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = (Join-Path (Get-Location) '.cache/ms-playwright')
npm exec --yes --package pnpm@12.3.4 -- pnpm exec playwright install chromium
npm exec --yes --package pnpm@12.3.4 -- pnpm test:e2e
npm exec --yes --package pnpm@12.3.4 -- pnpm capture
```

```sh
PLAYWRIGHT_BROWSERS_PATH="$PWD/.cache/ms-playwright" npm exec --yes --package pnpm@12.3.4 -- pnpm exec playwright install chromium
npm exec --yes --package pnpm@12.3.4 -- pnpm test:e2e
npm exec --yes --package pnpm@12.3.4 -- pnpm capture
```

`pnpm verify` 依次执行 lint、TypeScript、单元测试、合同测试与生产构建。演示媒体可另行校验：

```sh
node apps/web/scripts/verify-demo-media.mjs
```

本次源代码及独立快照的实际验证结果见 `IMPLEMENTATION_REPORT.md`；新环境可按上述命令复验。

## 关键业务边界

- Prompt trim 后必须非空，参考素材不能绕过。
- 视频时长只接受 5–15 秒整数；不支持的参数组合会明确拒绝。
- 生成成功先进入历史，逐条人工审核通过后仍需手动入库。
- 上传源素材与生成结果分别记录来源；未知上传不会冒充 AI 已分析。
- 视频拆解仅提供顺序、平均、固定样例场景和手动区间，不生成虚构语义。
- 浏览器前端不保存 Provider 密钥。

## 目录

- `apps/web`：Vue 应用、设计预览、端到端测试和自生成演示媒体。
- `packages/contracts`：共享类型和合同测试。
- `packages/domain`：校验、路由、拆解、审核、额度与状态规则。
- `packages/media-store`：IndexedDB 媒体持久化。
- `packages/mock-service`：B1 浏览器内模拟服务。
- `contracts`：JSON Schema 与 OpenAPI 设计稿。
- `fixtures`：确定性合同测试向量。
- `docs`：可公开的领域、拆解、审核、可靠性和验收合同。

演示媒体由本仓库脚本生成，来源与逐文件 SHA-256 记录在 `apps/web/public/demo/MEDIA_MANIFEST.json`。
