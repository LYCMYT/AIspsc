# 14｜B2.1A 本地 HTTP 演示平台

## 范围与定位

B2.1A 是“多模型 AI 营销视频生产平台”的本地 HTTP 合同实现：它把现有 B1 的产品请求、Batch/Item、额度、审核和显式入库流程放到一个受控的回环 HTTP 服务中，并用独立定时器驱动确定性的 Fake Worker。它面向电商投流视频素材生产的交互和工程验证，仍是本地演示重建。

默认开发环境、公开 Pages 和所有生产构建继续使用 B1 `MockPlatform`。只有本地启动器以 Vite `serve`、`local-http` 模式运行时，前端才选择 `HttpPlatform`。本阶段没有真实 Provider 接入、生产数据库、分布式队列、真实账单、登录/Workspace 隔离或云端部署，也不调用 Agnes 或其他付费接口。Agnes 的 `runtimeEligible=false` 与 `smoke_tested` 含义保持不变。

服务端返回的生成结果均来自仓库内固定演示夹具；结果、审核和资产记录带有 `isDemo=true` 或相应来源信息。它们不能被解释为真实客户任务、模型质量、投流效果或运营指标。

## 启动、停止与重启

环境固定为 Node.js `24.19.x`、pnpm `12.3.4`。本机全局 pnpm 可能是旧版本，使用仓库约定的固定包装命令：

```sh
npm exec --cache .cache/npm --yes --package pnpm@12.3.4 -- pnpm install --frozen-lockfile
npm exec --cache .cache/npm --yes --package pnpm@12.3.4 -- pnpm http:dev
```

启动器默认监听：

| 服务 | 默认地址 | 作用 |
|---|---|---|
| 前端 Vite | `http://127.0.0.1:5173` | `local-http` 开发页面与同源 `/api` 代理 |
| Node HTTP API | `http://127.0.0.1:8788` | 受鉴权的 `/v1` API；启动器也支持临时端口 |
| 数据目录 | `artifacts/local-generation` | 被 Git 忽略的本地状态目录 |

也可以直接调用启动器。CLI 只接受一个可选的前端端口参数：

```sh
node packages/generation-api/scripts/start.ts
node packages/generation-api/scripts/start.ts --port 4174
```

`--port` 必须是 1–65535 的十进制整数；不能添加其他 CLI 参数。以下是服务端进程使用的可选环境变量：

| 变量 | 语义 |
|---|---|
| `GENERATION_API_PORT` | API 端口；可设为 `0` 让操作系统分配临时端口 |
| `GENERATION_DATA_DIR` | 工作区内的自定义状态目录；默认 `artifacts/local-generation` |
| `GENERATION_API_TOKEN` | 可选的本机合成令牌；不设置时每次启动随机生成 |

这些变量只被 Node 启动器读取。它们不是 `VITE_*` 变量，不进入浏览器代码、构建产物、浏览器存储或 API 响应。启动器只打印前端/API 地址和“仅使用演示夹具”的边界，不打印令牌。

在运行命令的终端按 `Ctrl+C`，或向启动器发送 `SIGTERM`，触发正常关闭。启动器会优雅停止自己持有的前端/API/Worker/SSR loader 与状态 Store，并释放本进程持有的 `.lock`。正常关闭后可以使用相同目录重新启动；持久化的 pending 工作会由新的 Worker 继续处理，既有任务不会因为页面关闭而丢失。

如果启动失败并提示端口、工作区数据或操作锁问题，先确认旧的启动器进程已经退出，并确认没有另一个操作人正在使用该目录。不要为了绕过错误删除正在使用的 `.lock`。只有在确认旧 owner 已经停止、保留好状态目录备份并确认该锁确实是遗留锁之后，才可由操作人处理该目录下的遗留锁再重启。损坏的 `state.json` 会拒绝启动，不会静默清空或覆盖历史。

数据目录不在仓库工作区内时，在创建 Store 前返回 `LOCAL_DATA_MUST_BE_IN_WORKSPACE`；即使在工作区内，若目录是 `apps/web/public` 或其子目录，也会返回 `LOCAL_DATA_MUST_BE_PRIVATE`。普通工作区内的自定义目录可用，但应放在被忽略的本地目录中。不要通过公网监听、反向代理或隧道公开该服务。

## 模式选择与前端代理

组合根在 `apps/web/src/services/platform.ts` 使用以下三项编译时/运行时条件：

```text
import.meta.env.DEV && import.meta.env.MODE === 'local-http' && import.meta.env.LOCAL_HTTP_SERVE === true
  → HttpPlatform('/api')
其他所有情况
  → MockPlatform
```

因此：

- `pnpm dev` 的普通开发页面仍为 B1 `MockPlatform`，请求和状态留在浏览器 IndexedDB；
- `pnpm http:dev` 通过同源 `/api/v1/...` 访问本地 API，浏览器不持有操作令牌；
- `vite build --mode local-http` 仍选择 `MockPlatform`，因为构建命令不是 Vite serve；
- 即使 production 构建继承 `NODE_ENV=development`，serve-only 门禁也仍使其使用 `MockPlatform`；
- 公开 Pages 只有 B1 Mock 行为，不是本地 HTTP 服务的公网部署。

浏览器看到的路径以 `/api/v1` 开头。Vite 服务器只代理 `^/api/v1(?:/|$)`，去掉 `/api` 后转发到 API 的 `/v1`，并在代理进程内写入令牌。浏览器代码不会直接拼接 API 端口，也不会发送 `Authorization`。API 的直接地址仅供受控本机 CLI/测试使用，仍必须发送 `Authorization: Bearer <token>`；API 不接受把令牌放在 URL、请求体或前端变量中。

代理和 API 各自执行边界检查：

- 前端只绑定 `127.0.0.1`，请求 `Host` 必须精确匹配前端端口；有 `Origin` 时必须精确等于该前端 origin，缺省 Origin 才可继续；`Sec-Fetch-Site: cross-site` 直接拒绝；
- API 只绑定 `127.0.0.1`，`Host` 必须精确匹配实际 API authority；有 `Origin` 时必须属于配置的本机允许 origin，缺省 Origin 仍需要正确令牌；
- 代理在这些检查通过后才覆盖任何来访的 `Authorization`，因此调用方不能选择操作身份；
- API 不配置开放 CORS，错误响应使用固定消息，不回显路径、请求内容、令牌或异常文本。

Vite 保留默认的敏感文件拒绝规则，并额外拒绝 `artifacts/**`、`.ai/**` 和启动器配置的状态目录。自定义状态目录的 `/@fs` 路径（包括 URL 编码和 Windows 形式）在 SPA fallback 前返回拒绝；公开 `apps/web/public/demo` 夹具仍可读取。这样既保护 `state.json`、`.lock`、临时快照和证据，也不把普通源码或演示媒体误封为私有状态。

## HTTP 路由与输入合同

除二进制媒体响应外，成功响应均为 `{ "ok": true, "value": ... }`，错误响应均为 `{ "ok": false, "error": { "code": ..., "message": ... } }`。写请求必须使用 `Content-Type: application/json`、有效 UTF-8 和 `Idempotency-Key`；幂等键是 1–100 个 `[A-Za-z0-9_-]` 字符。JSON 请求体上限为 64 KiB。服务端错误消息是固定的中文演示提示，不把不可信输入或本地路径写入响应。

以下是 API 监听器上的路径；浏览器通过同源代理时把每个路径前面加 `/api`。

| 方法与路径 | 请求输入 | 成功结果 |
|---|---|---|
| `GET /v1/snapshot` | 无请求体 | `DemoSnapshot` 公共投影 |
| `GET /v1/generation-batches` | 无请求体 | `GenerationBatchSnapshot[]` |
| `GET /v1/generation-batches/:id` | 无请求体 | 单个批次快照 |
| `GET /v1/generation-items/:id` | 无请求体 | 单个子任务 |
| `POST /v1/generation-batches` | `CreateGenerationRequest` + 幂等键 | 批次快照，HTTP `202` |
| `POST /v1/generation-items/:id/cancel` | `{expectedVersion}` + 幂等键 | 更新后的子任务 |
| `POST /v1/generation-items/:id/retry` | `{expectedVersion}` + 幂等键 | 新批次快照，HTTP `202` |
| `POST /v1/generation-items/:id/reconcile` | `{expectedVersion,outcome}` + 幂等键 | 对账后的子任务 |
| `POST /v1/generation-items/:id/retry-download` | `{expectedVersion}` + 幂等键 | 更新后的子任务，HTTP `202` |
| `POST /v1/generation-items/:id/reviews` | `{expectedVersion,form,reason}` + 幂等键 | `Evaluation` |
| `POST /v1/generation-items/:id/assets` | `{expectedVersion,evaluationId}` + 幂等键 | `Asset` |
| `GET /v1/assets` | 无请求体 | `Asset[]`，保留失效历史 |
| `GET /v1/media/:id` | 无请求体 | 已校验的 `MediaFile` 元数据 |
| `GET /v1/media/:id/file` | 无请求体 | 真实夹具字节，`Content-Type` 为媒体 MIME；不是 JSON envelope |
| `GET /v1/quota` | 无请求体 | `CreditSnapshot` |
| `POST /v1/fixtures` | `{key}` + 幂等键 | `source=fixture` 的 `Asset` |
| `POST /v1/scenario` | `{name}` + 幂等键 | JSON `null`；`HttpPlatform` 转成 `void` |

生成请求严格按模态区分：

- 所有请求都需要 `prompt`、`references` 和 `count`。Prompt 先 `trim`，trim 后必须非空，长度上限 5000；`count` 为 1–4 的整数；
- `video` 需要整数时长 5–15 秒、比例 `9:16`/`16:9`/`1:1`、分辨率 `720p`/`1080p` 和布尔 `audio`；
- `image` 需要上述比例和非空分辨率字符串；
- `copy` 只能使用 `zh-CN`，`maxCharacters` 为 1–5000 的整数，并且不接受引用素材；
- 引用最多 4 个，角色为 `product`、`person`、`background` 或 `reference_video`；资产必须存在、可用、属于本地演示 workspace，角色与媒体类型必须匹配，同一角色不能重复；
- 请求对象和模态对象拒绝未知字段。`modelId`、`referenceStrength` 等底层选择字段不能被忽略后继续提交；
- 领域能力与仓库夹具不支持的完整参数组合返回 `NO_COMPATIBLE_MODEL`（HTTP `422`），不静默更改模态、时长、音频、比例、分辨率、引用或额度。

主要错误映射如下：非法 JSON、字段、版本或请求体为 `400 INVALID_PARAMETERS`；错误令牌为 `401 FORBIDDEN`；Host/Origin/跨站请求或资产权限问题为 `403`；找不到任务/媒体为 `404`；版本、幂等和状态竞争为 `409`；不兼容能力为 `422 NO_COMPATIBLE_MODEL`；超大 JSON 为 `413`；存储故障为 `503 STORAGE_UNAVAILABLE`。领域错误码和 HTTP 状态必须同时符合合同，客户端遇到无法验证的响应按 `NETWORK_ERROR` 处理。

## 持久化、幂等与 Worker

服务端状态是本地单进程文件快照：`state.json` 保存公共聚合以及服务端私有的 `pending`、幂等 memo、审核表单和序列；媒体字节仍来自只读夹具文件。Store 使用独占 `.lock`、串行事务、临时文件 fsync 和原子替换；事务失败时不发布部分状态或额度。公共快照不会暴露调度、审核表单原文或幂等 memo。

Fake Worker 是独立模块，由服务器定时器自动推进，不依赖页面、`pump()` 或 GET 请求。每个 item 的 pending 记录保存 `dueAt`、捕获的 scenario、`submit`/`accept`/`complete`/`download` 阶段和下载重试标志。它保存稳定的 `fake-...` 幂等键和 `fake-job-...` 标识；重启会继续原 item，不能创建第二个生成 attempt。

可通过受控 `POST /v1/scenario` 为未来任务选择确定性场景：`seed`、`empty`、`processing`、`success`、`failure`、`partial_success`、`unknown`、`download_failure`、`cancel_race`、`quota_insufficient`、`request_failure`、`storage_failure`。场景只影响之后创建的任务，不重写历史、不重置历史，也不模拟真实 Provider 对账；`missing_file` 在 HTTP 输入合同中明确不支持。

`processing` 是延迟后成功的可复验场景；`partial_success` 按固定 item 索引产生部分失败；`failure`、`request_failure`、额度不足、取消竞争、未知结果和下载/存储失败分别走明确状态与恢复路径。`needs_reconciliation` 不等于失败；只有显式合成对账才收敛。下载失败只允许重试下载/持久化，不重新创建生成任务。

HTTP 命令按操作范围和幂等键 memo。相同范围、相同 key 和相同 canonical JSON 会重放原先已接受的结果；同一 key 搭配不同 body 返回 `IDEMPOTENCY_CONFLICT`；失败命令不记为成功 memo。对象键排序、数组顺序、trim 后 Prompt 和 JSON 合法性共同参与规范化哈希。每个 item 命令都带 `expectedVersion`：独立新 key 的过期版本返回 `VERSION_CONFLICT`，成功的新命令只递增一次 item 版本。重试会递增原 item 版本、创建带 `retryOfItemId` 的新单 item 批次；调用方提供的幂等键保持有效。

## 结果来源、媒体校验与审核

视频和图片结果只从 `apps/web/public/demo/MEDIA_MANIFEST.json` 列出的 fixture key 读取。服务端打开夹具时检查路径包含关系、当前文件字节 SHA-256 和文件签名；PNG 还检查文件头尺寸。视频的尺寸、时长和音轨字段来自受信 `MEDIA_MANIFEST.json`，并在读取结果时与记录的 metadata 比对；这一步不声称每次读取都执行 ffprobe 或全片解码。适配器再次核对元数据、Blob 大小、MIME 和 SHA-256。历史媒体响应带 `isDemo=true`、`fixtureKey` 和生成记录，浏览器实际加载的是 MP4 字节，可以用原生 `<video>` 播放。文案结果以文本保存并保留其摘要。固定夹具的 provenance 与生成结果的 `originItemId` 分开记录；加载夹具是 `source=fixture`，生成结果是 `source=generated`。HTTP facade 没有任意上传入口，因此上传文件不会被伪装为 AI 已分析或已生成结果。

生成成功只进入历史。每个成功 item 单独进行人工审核：视频使用 `rubric-v2-rebuild` 的 11 个维度、适用性、问题标签、硬失败、技术错误和 1–10 综合分；图片和文案使用 `basic-media-review-v1` 的可读取与任务遵循检查。审核保存只创建 `Evaluation`，第一次通过不会自动创建 Asset。

用户必须再点击“入库”执行 `POST .../assets`。服务端要求最新的 approved evaluation、匹配当前结果摘要和正确版本；不通过、未审核、未成功或审核版本失效的结果不能入库。再次审核创建不可变 revision；从第二次开始需要非空改判原因。任何新审核都会使旧生成资产在需要时标记 `review_invalidated` 并恢复 `not_saved`，即使新 revision 再次 approved，也要再次执行明确的手动入库。重复入库在相同有效审核下保持同一个资产，不把审核通过与资产保存混成一个动作。

## 明确不支持的外围操作

本地 HTTP facade 为了保持与 B1 的统一界面，只实现生成、历史、服务端状态、确定性场景、夹具加载、额度、媒体读取、未知结果合成对账、下载恢复、人工审核和显式入库。以下操作会返回明确的 `FORBIDDEN` 或不提供对应路由，不会静默回退到 Mock：

- 任意文件上传、恢复本地 Blob、媒体写入/删除；
- 资产标题/标签修改、资产删除；
- 视频拆解、真实 FFmpeg 切片、切片入库；
- 独立 reset 场景接口；`setScenario` 只设置未来 Fake Worker 场景，不清空数据；
- Provider Create/Query/Cancel、真实模型路由、付费调用、真实费用或退款；
- 登录、RBAC、Workspace 隔离、生产对象存储、PostgreSQL、分布式队列、公共下载授权、投放平台连接；
- 自动长视频拼接、动态智能择优、广告转化或营销质量承诺。

前台仍不显示模型选择或参考强度。路由快照只在开发诊断/任务只读明细中保留，当前 binding 是 `mock` 演示能力。

## 后续架构边界

B2.1A 的 API、文件 Store 和同进程定时器用于验证合同，不是生产拓扑。后续经过单独授权后，计划演进为 NestJS 模块化单体、PostgreSQL 权威状态、对象存储媒体、Outbox/队列和独立部署的 Worker，再以受控 Provider Adapter 接入真实模型。真实 Provider 仍需能力证据、费用授权、幂等对账、输出参数验收和真实业务评测后才能进入路由。

当前阶段不会自动进入下一阶段，不会发布公网，也不会读取或写入共享生产数据库。B1 的视频拆解仍只在普通上传没有真实切片时展示区间计划；B2.1A HTTP facade 不提供任意上传处理或真实 FFmpeg。独立 Delivery 验收台仍按 [13_CONTROLLED_MEDIA_DELIVERY](13_CONTROLLED_MEDIA_DELIVERY.md) 使用真实 FFmpeg；账号与计费均保持未完成。

## 验证与证据

本地命令必须在隔离工作区按顺序执行，使用固定 pnpm 包装器：

```sh
npm exec --cache .cache/npm --yes --package pnpm@12.3.4 -- pnpm verify
npm exec --cache .cache/npm --yes --package pnpm@12.3.4 -- pnpm test:e2e
npm exec --cache .cache/npm --yes --package pnpm@12.3.4 -- pnpm test:http:e2e
npm exec --cache .cache/npm --yes --package pnpm@12.3.4 -- pnpm test:delivery
PLAYWRIGHT_BROWSERS_PATH=.cache/ms-playwright npm exec --cache .cache/npm --yes --package pnpm@12.3.4 -- pnpm test:delivery:ui
```

Windows PowerShell 设置浏览器路径时可使用：

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = (Resolve-Path .cache/ms-playwright).Path
npm exec --cache .cache/npm --yes --package pnpm@12.3.4 -- pnpm test:delivery:ui
```

五条最终命令的提交号、开始/结束时间、退出码、真实测试数量、失败/跳过数量、原始日志和截图统一记录在 `.ai/evidence/B21A-acceptance.md` 与 `.superpowers/sdd/2026-09-12-b21a-implementation/task-4b-report.md`。忽略目录中的日志/截图是本机证据，不是 GitHub Actions 结果；CI 是否通过仍以对应 Actions 日志为准。

`test:delivery` 在 Windows 账号上可能因文件符号链接权限产生 `EPERM`，即使其他用例通过也必须记录为退出码 1 的真实环境限制，不得跳过、删除或改成假绿。历史 B1 的 `ERR_NO_BUFFER_SPACE` 失败和聚焦重跑也保留在基线证据中；不能把历史数量冒充当前分支的最终结果。`runtimeEligible=false` 与 `smoke_tested` 继续表示模型证据分层，不表示生产路由已启用。
