# 多模型 AI 营销视频生产平台

> 基于真实商业项目核心产品逻辑公开重构的可复验 Demo。不是原生产源码，不把模拟能力包装成客户生产结果。

**在线 B1 Demo：** https://lycmyt.github.io/AIspsc/

## 本轮进展：B1.5 证据、B2.1A 本地 HTTP、B2.1B Provider Worker 与真实模型边界

Agnes Video V2.0 已完成文生视频和单图片生视频的真实技术测试，包括认证、创建、轮询、下载、SHA-256、实际文件元数据和全片解码。

**技术链路通过不等于产品验收通过。** 两条结果都为1280×704、约5.04秒并含AAC音轨，而目标请求为1280×720 / 16:9 / audio=false。真实路由仍禁用，在线页面仍为不消耗模型额度的 B1 Mock Demo。

首次测试还发现真实结果 URL 层级和输出域名与文档示例不同；修复后恢复了原视频，**没有重新生成原任务**。另新增1条固定自有图片测试，不使用客户素材。

- [真实测试、文件哈希与故障恢复](docs/12_AGNES_SMOKE_RECOVERY.md)
- [Agnes 接入边界与运行方式](docs/11_AGNES_PROVIDER_INTEGRATION.md)
- [候选能力与实际不符合项](contracts/agnes-video-v20.binding-candidate.json)
- [Pages 线上媒体路径回归](docs/13_PAGES_LIVE_VALIDATION.md)
- [B2.1A 本地 HTTP 演示平台](docs/14_B21A_HTTP_PLATFORM.md)
- [B2.1B Provider Worker 集成](docs/15_B21B_PROVIDER_WORKER.md)

B2.1B 已加入 Provider-neutral Worker、持久化 ProviderAttempt schema 2、Agnes 注入式模拟、raw/derivative 媒体证据和真实 FFmpeg 最终化。该阶段 **Real Agnes Create calls = 0**；Agnes 仍为 `smoke_tested` 且 `runtimeEligible=false`，普通开发、生产构建、Pages 和本地 HTTP 默认仍使用 Mock/Fake。本地门禁数量见 B2.1B 文档，最终 HEAD 的 Linux 与合并结果以关联 PR 验收记录为准。

## 解决的业务问题

难点不只是“能否生成一条视频”，而是把素材输入、模型能力、异步失败、人工审核、额度和资产复用组织成可追踪的生产流程。

```text
参考素材 / Prompt → 严格校验 → 任务分类与能力路由
                                  ↓
                         异步 Batch / Item
                                  ↓
                成功 / 部分成功 / 失败 / 取消 / 结果未知
                                  ↓
                         人工审核 → 显式入库 → 资产复用
```

用户表达任务意图，不在前台研究模型版本或选择底层模型。不兼容请求明确失败，不静默降级。生成成功、审核通过和手动入库是三个独立步骤。

## 当前 B1 可操作能力

| 入口 | 能力 | 真实边界 |
|---|---|---|
| 创作 | 视频/图片/文案，Prompt，参考视频/人物/商品/背景，参数与数量 | 确定性 Mock 生成，不调用付费模型 |
| 历史 | Batch/Item、部分成功、失败重试、取消竞态、未知状态对账、下载恢复 | 模拟 ProviderAttempt，不冒充真实运营数据 |
| 人工审核 | rubric-v2-rebuild，11维问题标签、适用性、硬失败、技术失败、综合分、改判版本 | 公开重建审核合同，不是原客户历史评测数据 |
| 资产库 | 上传/生成/fixture 来源区分，审核后显式入库，改判失效 | IndexedDB 保存真实浏览器 Blob |
| 视频拆解 | 顺序/平均/固定场景样例/手动区间，源视频与帧预览 | 普通上传只规划区间；无真实切片就不伪造下载 |
| 素材识别 | 固定样例标签与人工标签 | 未执行AI识别就明确显示“未执行” |

前台视频合同：5–15秒整数，9:16/16:9/1:1，720p/1080p，数量1–4，音频开关。**这些是 B1 产品请求合同，不表示每个真实 Provider 都已支持全部组合。**

可靠性覆盖 `queued → running → finalizing → succeeded`、partial_succeeded、cancel_requested、needs_reconciliation、刷新恢复、下载恢复、审核改判与额度预占/结算/释放。

## 关键产品决策

- 前台不暴露 `modelId` 或参考强度字段；系统根据意图与硬能力筛选候选。
- 批次按子结果维护状态、错误、审核与额度，部分失败不抹掉成功结果。
- 提交结果未知不等于未受理；保留原任务，不盲目重复生成。
- 技术生成成功不代表素材可用；通过人工审核后仍需确认入库。
- 保留来源与审核版本；已入库结果改判后标记失效。

完整取舍见 [产品决策](docs/01_PRODUCT_DECISIONS.md)。

## 架构与证据状态

```text
Vue UI → ServiceFacade → MockPlatform → contracts / domain / IndexedDB
                          （B1）

B2.1A 本地：ServiceFacade → HttpPlatform → 回环 API / 文件快照 / Fake Worker
                                                   ↓（固定演示夹具）
                                              生成历史 / 审核 / 手动入库

B2.1B 本地：Generation API → 单一 Worker → ProviderPort → Fake / 注入式 Agnes 模拟
                                                   ↓
                                      raw evidence → FFmpeg derivative → 历史

后续：ServiceFacade → 受控 API / PostgreSQL / 对象存储 / 独立 Worker
                                      ↓
                                  ProviderAdapter
```

Pages 子路径由 composition root 注入，不让领域包依赖 Vite。B2.1A 的本地启动器只在 `import.meta.env.DEV && import.meta.env.MODE === 'local-http' && import.meta.env.LOCAL_HTTP_SERVE === true` 下选择 `HttpPlatform`（`LOCAL_HTTP_SERVE` 由 Vite 配置的 serve-only `define` 注入）；默认开发、生产构建和在线 Pages 仍选择 `MockPlatform`。Agnes 服务端模块不被在线前端导入，不把密钥放到浏览器。

模型证据：`unverified → documented → smoke_tested → evaluated → integrated`。
Agnes 目前为 **smoke_tested（技术）**，未完成业务评测与产品参数验收。其他候选状态见 [能力证据矩阵](docs/09_MODEL_CAPABILITY_MATRIX.md)。研究证据文件不直接驱动真实路由。

## 版本路线

**B1：** 本地交互模拟，产品合同、状态、审核、资产、拆解、额度与浏览器持久化。

**B1.5（当前）：** 产品决策、架构、公开 Demo、CI、Provider 技术证据、真实小样本评测合同和故障复盘。

**B2.1A（本地受控增量）：** 回环 HTTP API、服务端文件快照、同进程确定性 Fake Worker，以及生成→历史→人工审核→显式入库的浏览器闭环。它不代表生产后端、真实 Provider、真实账单或云部署。

**B2.1B（本地 Provider Worker 增量）：** Provider-neutral Worker、持久化 Attempt、模拟 Agnes 的 Create/Poll/Download 分层、raw/derived 媒体校验和现有审核/入库闭环。没有真实 Agnes Create，不改变 `smoke_tested` / `runtimeEligible=false` 证据边界。

**B2 后续：** NestJS 模块化单体、Auth/Workspace、PostgreSQL、对象存储、真实 FFmpeg、服务端账本、Outbox 和独立 Worker。

**B3：** 受控 Provider 集成、输出参数符合性、实际费用、任务恢复与真实能力路由。

**B4：** 安全、可观测性、限流、故障切换与客户级验收。

下一步优先解决已实测发现的输出尺寸/音轨规范化，再推进最小受控服务端闭环；不继续随机生成昂贵样本。

## 安装与验证

环境：Node.js 24.19.x、pnpm 12.3.4；浏览器测试使用 Playwright Chromium。真实 Provider smoke 的文件校验还需要 FFmpeg/ffprobe。

```sh
npm exec --cache .cache/npm --yes --package pnpm@12.3.4 -- pnpm install --frozen-lockfile
npm exec --cache .cache/npm --yes --package pnpm@12.3.4 -- pnpm dev
```

本地默认地址 `http://127.0.0.1:5173`，设计预览 `/design-panel.html`。

```sh
npm exec --cache .cache/npm --yes --package pnpm@12.3.4 -- pnpm verify
npm exec --cache .cache/npm --yes --package pnpm@12.3.4 -- pnpm exec playwright install chromium
npm exec --cache .cache/npm --yes --package pnpm@12.3.4 -- pnpm test:e2e
```

`verify` 包含 lint、TypeScript、单元测试、合同测试、HTTP 集成测试和生产构建。最终以对应提交的 Actions 日志为准；旧 B1 基线的116/25/74等历史结果保留在 `IMPLEMENTATION_REPORT.md`，不能冒充后续提交的固定测试数。

真实 Agnes 测试只通过手动受控入口，默认恢复，不自动生成。密钥只在服务器进程环境/GitHub Secret 中，操作方式见 [Provider README](packages/provider-agnes/README.md)。

### B2.1A 本地 HTTP 演示

需要服务端持久化 Batch/Item、同进程确定性 Fake Worker 或真实 MP4 播放证据时，运行：

```sh
npm exec --cache .cache/npm --yes --package pnpm@12.3.4 -- pnpm http:dev
```

它提供 `http://127.0.0.1:5173`（不会自动打开浏览器），API 监听 `127.0.0.1:8788`，状态写入被忽略的 `artifacts/local-generation`。停止时按 `Ctrl+C` 让服务正常释放锁；重启会恢复未完成的确定性 Fake Worker 工作。自定义前端端口只能使用 `node packages/generation-api/scripts/start.ts --port 4174` 形式，API 端口和数据目录通过服务端进程变量 `GENERATION_API_PORT`、`GENERATION_DATA_DIR` 指定。不要把状态目录放在 `apps/web/public` 或公开目录。

默认开发、生产构建（包括 `--mode local-http`）和在线 Pages 仍为 B1 Mock；本地 HTTP 的路由、鉴权、锁恢复、媒体哈希和不支持操作见 [B2.1A 本地 HTTP 演示平台](docs/14_B21A_HTTP_PLATFORM.md)。本地 HTTP 只使用仓库演示夹具，不调用付费 Provider，不提供公网服务。

## 文档导航

| 文档 | 内容 |
|---|---|
| [00 项目概览](docs/00_PROJECT_OVERVIEW.md) | 业务背景、范围和版本路线 |
| [01 产品决策](docs/01_PRODUCT_DECISIONS.md) | 用户意图、路由、审核与取舍 |
| [02 系统架构](docs/02_SYSTEM_ARCHITECTURE.md) | B1结构与B2/B3边界 |
| [03 领域合同](docs/03_DOMAIN_CONTRACT.md) | 实体、状态和接口 |
| [04 路由合同](docs/04_ROUTING_CONTRACT.md) | 任务分类、能力筛选 |
| [05 拆解合同](docs/05_VIDEO_SPLIT_CONTRACT.md) | 区间规则与真实媒体验收 |
| [06 审核合同](docs/06_EVALUATION_CONTRACT.md) | 11类质量审核与入库规则 |
| [07 额度与可靠性](docs/07_QUOTA_AND_RELIABILITY.md) | 幂等、取消、未知结果 |
| [08 验收](docs/08_ACCEPTANCE.md) | 阻塞用例与证据格式 |
| [09 模型证据](docs/09_MODEL_CAPABILITY_MATRIX.md) | 文档、技术测试与正式接入分层 |
| [10 真实评测计划](docs/10_REAL_EVALUATION_PLAN.md) | 原4×2探索性业务实验与预算门槛 |
| [11 Agnes 接入](docs/11_AGNES_PROVIDER_INTEGRATION.md) | 安全运行与真实路由阻塞项 |
| [12 Agnes 实测复盘](docs/12_AGNES_SMOKE_RECOVERY.md) | 真实结果、哈希、时延与参数差异 |
| [13 Pages 线上回归](docs/13_PAGES_LIVE_VALIDATION.md) | 子路径媒体加载问题 |
| [14 B2.1A 本地 HTTP](docs/14_B21A_HTTP_PLATFORM.md) | 本地 API、Fake Worker、代理安全与边界 |
| [15 B2.1B Provider Worker](docs/15_B21B_PROVIDER_WORKER.md) | ProviderPort、Attempt、模拟 Agnes、raw/derivative 与安全门禁 |

## 目录与明确未完成项

`apps/web` 为前端与E2E；`packages/contracts` 为共享合同；`packages/domain` 为纯业务规则；`packages/media-store` 为浏览器持久化；`packages/mock-service` 为演示执行环境；`packages/provider-agnes` 为独立服务端测试接入；`contracts`、`fixtures`、`docs` 保存规格、确定性向量与证据说明。

演示媒体由仓库脚本生成，来源与逐文件SHA-256见 `apps/web/public/demo/MEDIA_MANIFEST.json`。

当前不声称完成：生产HTTP服务、登录与Workspace隔离、真实Router上线、统一实际计费、充值支付、广告平台连接、任意上传视频的服务端FFmpeg切片、客户生产验收或广告转化提升。B2.1A/B2.1B 的本地服务仅是受控演示增量，不能替代这些生产能力。

## 本机交付验收台（独立于公开 B1）

新增真实MP4后处理与本机受控历史→11维人工审核→显式入库闭环。原始结果只读保留；两条Agnes结果的衍生版本通过1280×720、120帧、5秒、无音轨验收，不代表营销质量通过。

运行 `pnpm delivery:serve` 启动本地验收台：不需要Agnes密钥、不调用模型、不切换在线B1。操作、API、文件哈希和边界见 [13_CONTROLLED_MEDIA_DELIVERY](docs/13_CONTROLLED_MEDIA_DELIVERY.md)。
