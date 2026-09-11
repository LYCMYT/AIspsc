# 多模型 AI 营销视频生产平台

> **Public reconstruction / B1 local interactive simulation**  
> 面向电商投流素材生产，把多模型生成从“单次调用工具”重构成可校验、可路由、可恢复、可审核、可入库的 AI 内容生产工作流。

本仓库基于真实商业项目中已确认的核心产品逻辑进行公开重构。它**不是原生产源码**，当前也**不会调用外部付费模型**。B1 的目标是把关键产品规则变成可以真实操作、自动测试和公开复验的证据。

## 这个项目解决什么问题

AI 营销素材生产的难点不只是“能否生成一条视频”，而是如何管理整个生产过程：

```text
参考素材 / Prompt
        ↓
严格请求校验
        ↓
任务分类与能力路由
        ↓
异步 Batch / Item
        ↓
成功 / 部分成功 / 失败 / 取消 / 结果未知
        ↓
逐条人工审核
        ↓
显式手动入库
        ↓
资产复用
```

平台把几个高风险环节做成显式产品合同：

- 用户表达任务意图，而不是自己研究底层模型；
- Prompt trim 后必须非空，参考素材不能绕过；
- 不兼容参数明确失败，不静默降级；
- 批量任务按子结果独立管理状态、审核和额度；
- Provider 结果未知不自动当失败，也不盲目重复付费生成；
- 生成成功、人工审核、资产入库三步分离；
- 上传 / 生成 / fixture 保留不同 provenance；
- 没有执行 AI 识别就明确显示“未执行”，不伪造标签或语义结果。

## 当前 B1 可以真实操作什么

### 1. 创作

- 视频 / 图片 / 文案三种模态；
- Prompt；
- 参考视频 / 人物 / 商品 / 背景四类参考角色；
- 视频时长 5–15 秒整数；
- 9:16 / 16:9 / 1:1；
- 720p / 1080p；
- 数量 1–4；
- 音频开关；
- 严格 Schema + 语义校验；
- 确定性 Mock 路由与结果。

### 2. 历史与异步可靠性

支持：

- `queued → running → finalizing → succeeded`；
- `partial_succeeded`；
- failed / retry；
- cancel / cancel race；
- `needs_reconciliation`；
- 下载失败恢复；
- 刷新/重开后的确定性恢复；
- 路由、价格、ProviderAttempt、额度流水只读诊断。

### 3. Human-in-the-loop 审核

视频使用 `rubric-v2-rebuild`：

- 11 类质量维度；
- applicable / N/A；
- 1–10 人工综合分；
- Hard Failure；
- Technical Error；
- 审核 revision；
- 改判原因；
- 审核通过后仍需手动入库。

这套量表是公开重建的审核合同，**不是历史客户评测数据的逐字复原，也不宣称阈值已经过真实样本统计验证**。

### 4. 视频拆解

提供：

- 顺序拆解；
- 平均拆解；
- 固定测试源的场景边界；
- 手动区间；
- 实际源 Blob 的浏览器播放与帧预览。

普通上传视频在 B1 只规划合法区间；没有真实切片文件时不会伪造下载或复用入口。

### 5. 素材与资产

- IndexedDB 持久化真实本地 Blob；
- 上传源与生成资产来源分离；
- 已审核结果显式入库；
- 审核改判后原资产进入 `review_invalidated`；
- 固定识别样例明确标注“预设标签，非 AI 分析”；
- 普通未知上传显示“内容识别未执行”。

## 为什么前台没有模型选择器

这是产品决策，不是漏做功能。

```text
用户意图
  ↓
Task Classification
  ↓
Capability Filter
  ↓
Provider Binding
```

用户不应该为了完成“生成营销视频”而自己维护各厂商模型的版本、参数兼容和价格知识。B1 用 Mock Binding 验证路由语义；B3 才会在真实 Provider 证据、Smoke Test 和评测完成后启用真实 Binding。

详细决策见 [`docs/01_PRODUCT_DECISIONS.md`](docs/01_PRODUCT_DECISIONS.md)。

## 架构

```text
Vue Web
   ↓ ServiceFacade
MockPlatform (B1)
   ↓
contracts + domain + IndexedDB media store
```

已经预留真实后端演进缝隙：B2 新增 `HttpPlatform`，而不是重写 Vue 页面。

```text
                   ┌─ MockPlatform  ← B1 Demo
UI → ServiceFacade ┤
                   └─ HttpPlatform  ← B2+
                           ↓
                         API
```

完整架构与 B2/B3 边界见 [`docs/02_SYSTEM_ARCHITECTURE.md`](docs/02_SYSTEM_ARCHITECTURE.md)。

## 模型证据不是“有名称就算已接入”

`contracts/model-registry.json` 中的真实模型绑定继续保持 disabled / unverified。

B1.5 新增独立的 [`contracts/provider-capability-evidence.json`](contracts/provider-capability-evidence.json)，使用五级证据状态：

```text
unverified
→ documented
→ smoke_tested
→ evaluated
→ integrated
```

只有 `integrated` 才能进入未来真实 Router。当前 Seedance 2.0 与 Kling 3.0 仅记录官方文档证据，不代表本仓库已验证 API Binding。

详见 [`docs/09_MODEL_CAPABILITY_MATRIX.md`](docs/09_MODEL_CAPABILITY_MATRIX.md)。

## 工程证据

B1 基线提交 `626fcb3ade8a850b9a852f8d083c916a0d5c1d08` 的 `IMPLEMENTATION_REPORT.md` 记录：

| Check | B1 baseline result |
|---|---:|
| Lint | PASS |
| TypeScript | PASS |
| Unit tests | 116 PASS |
| Contract tests | 25 PASS |
| Production build | PASS |
| End-to-end tests | 74 PASS |
| Capture checks | 6 PASS |

这些是**已记录的 B1 基线结果**，不是对任意后续提交的自动保证。B1.5 开始通过 GitHub Actions 在 push / PR 上重新执行：

```sh
pnpm verify
pnpm test:e2e
```

## 路线图

### B1｜Local Interactive Simulation ✅

产品流程、状态合同、Mock Router、审核、资产、额度、拆解和浏览器持久化。

### B1.5｜Portfolio Evidence Release ← 当前阶段

- 产品背景与决策；
- 架构与边界；
- 模型能力证据矩阵；
- CI 独立复验；
- 小样本真实视频模型评测；
- Bad Case 复盘；
- 可公开展示的证据链。

### B2｜Real Platform Foundation

计划：HTTP API、Auth/Workspace、PostgreSQL、对象存储、真实 FFmpeg、服务端账本、Outbox/Worker。

### B3｜Real AI Provider

计划：ProviderAdapter、真实异步调用、成本/时延证据、真实 Capability Routing。

### B4｜Production-like Acceptance

计划：安全、可观测性、限流、Provider 健康度/故障切换和客户级验收。

## 当前明确不声称完成

- 生产 HTTP 服务；
- 登录、权限与 Workspace 隔离；
- 外部 AI Provider 实际执行；
- 真实模型计费；
- 支付充值；
- 广告平台连接；
- 任意上传视频的服务端 FFmpeg 切片；
- 客户生产验收；
- 广告转化率或真实运营指标。

## 文档导航

- [`00_PROJECT_OVERVIEW.md`](docs/00_PROJECT_OVERVIEW.md)：项目背景、范围与版本路线。
- [`01_PRODUCT_DECISIONS.md`](docs/01_PRODUCT_DECISIONS.md)：关键 AI 产品决策与取舍。
- [`02_SYSTEM_ARCHITECTURE.md`](docs/02_SYSTEM_ARCHITECTURE.md)：B1 架构与 B2/B3 演进边界。
- [`03_DOMAIN_CONTRACT.md`](docs/03_DOMAIN_CONTRACT.md)：领域数据、状态与统一接口。
- [`04_ROUTING_CONTRACT.md`](docs/04_ROUTING_CONTRACT.md)：任务分类与能力路由。
- [`05_VIDEO_SPLIT_CONTRACT.md`](docs/05_VIDEO_SPLIT_CONTRACT.md)：拆解规则、数学边界和真实 FFmpeg 验收。
- [`06_EVALUATION_CONTRACT.md`](docs/06_EVALUATION_CONTRACT.md)：11 类人工质量审核。
- [`07_QUOTA_AND_RELIABILITY.md`](docs/07_QUOTA_AND_RELIABILITY.md)：额度、幂等、取消与未知结果。
- [`08_ACCEPTANCE.md`](docs/08_ACCEPTANCE.md)：阻塞验收与证据格式。
- [`09_MODEL_CAPABILITY_MATRIX.md`](docs/09_MODEL_CAPABILITY_MATRIX.md)：模型证据成熟度与真实接入门槛。

## 环境

- Node.js 24.19.x
- pnpm 12.3.4
- Chromium（Playwright E2E）
- FFmpeg / ffprobe（只在重新生成或完整校验演示媒体时需要）

## 本地安装与运行

```sh
npm exec --yes --package pnpm@12.3.4 -- pnpm install --frozen-lockfile
npm exec --yes --package pnpm@12.3.4 -- pnpm dev
```

开发服务默认监听 `http://127.0.0.1:5173`。可编辑设计预览位于 `/design-panel.html`。

## 验证

```sh
npm exec --yes --package pnpm@12.3.4 -- pnpm verify
```

首次运行浏览器测试：

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = (Join-Path (Get-Location) '.cache/ms-playwright')
npm exec --yes --package pnpm@12.3.4 -- pnpm exec playwright install chromium
npm exec --yes --package pnpm@12.3.4 -- pnpm test:e2e
```

```sh
PLAYWRIGHT_BROWSERS_PATH="$PWD/.cache/ms-playwright" npm exec --yes --package pnpm@12.3.4 -- pnpm exec playwright install chromium
npm exec --yes --package pnpm@12.3.4 -- pnpm test:e2e
```

演示媒体可另行校验：

```sh
node apps/web/scripts/verify-demo-media.mjs
```

## 目录

- `apps/web`：Vue 应用、设计预览、E2E 和自生成演示媒体。
- `packages/contracts`：共享 TypeScript 合同。
- `packages/domain`：验证、路由、拆解、审核、额度与状态规则。
- `packages/media-store`：IndexedDB 媒体持久化。
- `packages/mock-service`：B1 浏览器内模拟执行环境。
- `contracts`：JSON Schema、OpenAPI、逻辑模型与 Provider evidence。
- `fixtures`：确定性合同测试向量。
- `docs`：产品、领域、评测、可靠性和验收文档。

演示媒体由仓库脚本自行生成，逐文件 SHA-256、尺寸、时长、音轨和 Clip 来源记录在 `apps/web/public/demo/MEDIA_MANIFEST.json`。
