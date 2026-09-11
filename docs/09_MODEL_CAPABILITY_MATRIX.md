# 09｜模型能力证据矩阵

## 目的

这份文档解决一个核心问题：

> “我们知道某个模型存在”与“这个模型已经可以被当前平台安全、可解释地路由”不是一回事。

B1 的 `contracts/model-registry.json` 只记录逻辑模型名称，真实绑定全部保持 `enabledForReal=false` / `unverified`。B1.5 新增 `contracts/provider-capability-evidence.json`，专门记录**外部证据成熟度**，不直接驱动运行时路由。

## 证据状态

```text
unverified
   ↓
documented
   ↓
smoke_tested
   ↓
evaluated
   ↓
integrated
```

### `unverified`

只有逻辑名称或历史业务口径，还没有足够的权威证据支撑当前项目需要的能力判断。

### `documented`

已经找到官方 Provider 文档支持部分能力声明，但尚未证明：

- 我们有可用 API 访问；
- 精确 `modelId` 已核对；
- 请求 Schema 与本项目合同兼容；
- 真实调用能成功；
- 价格已核对；
- 结果/错误/异步状态已完成归一化。

### `smoke_tested`

在明确预算授权下完成至少一次真实 API 调用，并保存：

- request；
- response / external job；
- 最终结果；
- latency；
- cost；
- 错误/状态映射；
- 输出持久化证据。

### `evaluated`

已经进入仓库定义的小样本真实评测，保留 Prompt、参考素材、参数、结果、人工审核、成本、时延和 Bad Case。

### `integrated`

Provider Adapter、密钥保护、真实状态机、对象存储、计费/额度和集成测试都已完成，且 capability limits 有证据。只有这个状态才允许进入真实 Router。

---

## 当前 B1.5 状态

| Logical model | Evidence status | 当前可以声称什么 | 当前不能声称什么 |
|---|---|---|---|
| Seedance 2.0 | `documented` | BytePlus ModelArk 官方存在 Seedance 2.0 系列视频生成服务与视频任务 API 文档 | 已核对本项目所需 exact model ID、所有参数组合、真实价格、真实绑定已可用 |
| Seedance 2.0 Mini | `unverified` | 逻辑候选名称仍保留 | Mini 的精确产品/API 身份已经确认 |
| Kling 3.0 | `documented` | 官方 VIDEO 3.0 指南描述 T2V/I2V、Native Audio、Element Reference、Multi-shot、最长 15s 等产品能力 | 本仓库已经获得并验证 developer API binding |
| Agnes Video V2.0 | `documented` | 已核对 `agnes-video-v2.0` 的 create/query/auth/status 基础 API 合同；服务端 Adapter、单测和手动 Smoke workflow 已准备 | 已完成真实 API Smoke、已进入真实 Router、支持 reference video / multi-reference / audio |
| Kling 2.0 | `unverified` | 逻辑候选名称仍保留 | 当前 API contract 已核验 |
| image2.0 | `unverified` | 历史逻辑名称保留 | Provider 身份已经确认 |
| Seedream 5.0 | `unverified` | 图片模型逻辑候选保留 | 当前阶段已经完成 API 能力核验 |
| Qwen-Image 2.0 | `unverified` | 图片模型逻辑候选保留 | 当前阶段已经完成 API 能力核验 |
| DeepSeek V4 | `unverified` | 文案模型逻辑候选保留 | 当前模型/Provider 身份及 API 已确认 |

> 注：本阶段优先验证视频模型，因为 AIspsc 的核心产品证据与下一轮评测聚焦 AI 营销视频生产。图片和文案 Provider 不因为“有名称”就自动升级证据状态。

---

## 已记录的官方证据

### Seedance 2.0

当前记录的 BytePlus 官方证据：

- `https://docs.byteplus.com/en/docs/ModelArk/Video_Generation_API`
  - 官方 Video generation API 公开了创建、查询、列表、取消/删除视频生成任务的接口入口。
- `https://docs.byteplus.com/en/docs/ModelArk/2222480`
  - Dreamina Seedance 2.0 series prompt guide。
- `https://docs.byteplus.com/en/docs/ModelArk/2291680`
  - Dreamina Seedance 2.0 series tutorial。

这些资料足以把逻辑候选从“名称未核验”升级到 **documented**，但不足以把本仓库 runtime binding 标记为 verified。

### Kling 3.0

当前记录的官方证据：

- `https://app.klingai.com/cn/quickstart/klingai-video-3-model-user-guide`
  - Kling VIDEO 3.0 官方产品指南描述：Text-to-Video、Image-to-Video、Start/End Frame、Native Audio、Multi-shot、Element Reference、多人物一致性、灵活时长与最长 15 秒等能力。

这说明 Kling 3.0 是值得进入 B1.5 实验候选池的真实产品能力，但**产品使用指南不等于本仓库所需的 developer API contract**。在找到并核对精确 API 请求/响应/任务状态/价格规则之前，仍不能启用真实 Binding。

### Agnes Video V2.0

当前记录的 Agnes 官方证据：

- `https://www.agnes-ai.com/zh-Hans/docs/overview`
  - 官方 API 总览给出 Bearer Token 鉴权和 API Hub 服务入口，并明确要求 API Key 不能暴露在前端或公共代码中。
- `https://agnes-ai.com/doc/agnes-video-v20`
  - 模型专页给出 exact model ID `agnes-video-v2.0`、`POST /v1/videos` 创建、按 `video_id` 查询、任务状态、视频结果 URL、分辨率/比例和帧数规则。

仓库新增：

- `contracts/agnes-video-v20.binding-candidate.json`：机器可读的候选能力边界，`runtimeEligible=false`；
- `packages/provider-agnes/src/index.ts`：服务端 Provider Adapter；
- `packages/provider-agnes/src/index.test.ts`：不访问外网的确定性单元测试；
- `.github/workflows/agnes-smoke.yml`：仅手动触发的真实 Smoke workflow；
- `docs/11_AGNES_PROVIDER_INTEGRATION.md`：完整接入边界。

当前仍维持 **documented**，原因是“Adapter 已实现”不等于“真实 API 已验证”。只有在 `AGNES_API_KEY` 通过 Secret 注入并完成真实 Smoke 后，才允许升级为 `smoke_tested`。

当前保守能力子集：

```text
TEXT_TO_VIDEO
IMAGE_GUIDED_VIDEO（单一公开图片 URL）
5s / 10s documented presets
9:16 / 16:9 / 1:1
720p / 1080p
no audio
```

当前不声明：

```text
REFERENCE_VIDEO_GEN
MULTI_REFERENCE_VIDEO
Native Audio
完整 5–15 秒整数时长集合
```

---

## Provider 进入真实 Router 的阻塞门槛

一个模型想从候选进入 B3 实际路由，至少必须完成以下检查：

### 1. 身份核验

- Provider；
- exact API model ID；
- model/version 生命周期；
- 官方文档链接与检查日期。

### 2. Capability 核验

根据本项目 `RoutingCapabilitySnapshot` 核对：

```text
taskTypes
maxReferences
reference roles/count
duration
ratio
resolution
audio
combination limits
```

不能仅根据营销页面推断 API 一定支持相同组合。

### 3. Async Contract 核验

至少明确：

```text
create
externalJobId
query/poll
callback (if any)
cancel (if any)
provider terminal states
timeout behavior
provider idempotency behavior
```

### 4. Error Mapping

把 Provider-specific error 映射到平台统一错误语义，例如：

```text
INVALID_PARAMETERS
NO_COMPATIBLE_MODEL
NETWORK_ERROR
PROVIDER_OUTCOME_UNKNOWN
CANCELLED
```

Adapter 不能伪造 Provider 不存在的查询或取消能力。

### 5. Result Persistence

模型结果不能只保留短期 Provider URL。需要：

```text
Provider result
   ↓
download
   ↓
validate
   ↓
object storage
   ↓
MediaFile
   ↓
finalizing → succeeded
```

### 6. Cost Evidence

保存：

- Provider 计费规则来源；
- 调用前预计成本；
- 实际调用成本；
- 计价版本；
- 对应 GenerationItem。

B1 的 1 演示额度不能被当作真实成本。

### 7. Smoke Test

至少覆盖：

- 一次成功；
- 一个非法参数；
- 一个可识别的失败/超时路径（若可安全复现）；
- 文件下载/持久化。

### 8. Evaluation

进入小样本真实评测，重点不是制造排行榜，而是回答：

> 哪一种任务类型更适合哪个已验证 Binding，以及 Router 第一版应如何做硬能力过滤。

---

## B1.5 第一轮真实评测方向

计划以两个视频候选作为第一轮对比对象：

```text
Seedance 2.0
vs
Kling 3.0
```

候选 Case：

1. Product Image → Video；
2. Person + Product → Video；
3. Reference Video → Video；
4. Multi Reference → Video。

目标规模：

```text
4 cases × 2 candidate models = 8 outputs
```

这是**探索性小样本**，不用于宣称统计显著的“胜率”。最终产出应是：

- capability compatibility；
- 具体输出证据；
- 11 类人工审核；
- cost / latency；
- Bad Case；
- 第一版 routing recommendation。

Agnes 当前用于验证第一条真实 Provider Adapter / Secret / 异步轮询 / 下载证据链。因为它当前核验的能力子集与上述 EV003/EV004 不同，所以不为了凑候选数量强行加入这组 4×2 横评。若未来将 Agnes 加入正式比较，会另建所有候选共同支持的 Case。

---

## 运行时安全规则

B1.5 期间：

- `contracts/model-registry.json` 的真实绑定保持 disabled；
- 不提交 API Key；
- 不在浏览器保存 Provider Key；
- 不把 `provider-capability-evidence.json` 当成可执行 routing registry；
- 不因为外部文档写“支持某能力”就跳过实际 Smoke Test；
- 不把一次成功调用直接升级为 `integrated`。
