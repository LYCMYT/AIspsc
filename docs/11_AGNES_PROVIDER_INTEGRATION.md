# 11｜Agnes Provider 接入说明

## 1. 目标

Agnes AI 是本仓库第一个用于验证 **真实 Provider Adapter 架构** 的外部视频服务。

本阶段目标不是把 Agnes 直接放进前台模型选择器，也不是把它宣布为正式 Router 候选，而是先验证：

1. 服务端密钥边界；
2. 创建异步视频任务；
3. 使用 `video_id` 查询任务；
4. Provider 状态归一化；
5. 最终视频下载与 SHA-256 证据；
6. 不自动重试可能产生费用/配额消耗的 create 请求。

## 2. 官方合同（2026-09-11 核验）

官方文档：

- Overview: `https://www.agnes-ai.com/zh-Hans/docs/overview`
- Video V2.0: `https://agnes-ai.com/doc/agnes-video-v20`

已核验：

```text
Provider: Agnes AI
Model: agnes-video-v2.0
Create: POST https://apihub.agnes-ai.com/v1/videos
Query:  GET  https://apihub.agnes-ai.com/agnesapi?video_id=<VIDEO_ID>
Auth:   Authorization: Bearer <API_KEY>
```

官方推荐新集成使用 `video_id` 查询，不使用 legacy `task_id` 作为首选轮询标识。

Provider 状态：

```text
queued      → queued
in_progress → running
completed   → succeeded
failed      → failed
unknown     → needs_reconciliation
```

## 3. 当前公开的能力子集

为了避免在真实验证前过度声明，Adapter 只开放当前有明确文档证据、且与本项目请求合同能安全映射的子集。

### TaskType

```text
TEXT_TO_VIDEO
IMAGE_GUIDED_VIDEO
```

当前不声明支持：

```text
REFERENCE_VIDEO_GEN
MULTI_REFERENCE_VIDEO
```

### 图片参考

Agnes V2.0 的 `image` 参数接受一个公开可访问图片 URL。

因此当前候选 Binding：

- 最多 1 个图片参考；
- 可用于单一 product / person / background 图片角色；
- 不把 keyframe 数组冒充本平台的“商品 + 人物 + 背景”多参考语义；
- 不支持 `reference_video`。

### Duration

Provider 使用：

```text
seconds = num_frames / frame_rate
```

并要求 `num_frames <= 441` 且符合 `8n + 1`。

当前 Adapter 只使用官方明确列出的两个常用预设：

```text
5s  → num_frames=121, frame_rate=24
10s → num_frames=241, frame_rate=24
```

注意这里是“约 5 秒 / 约 10 秒”。真实结果必须以 Provider 返回的 `seconds` 为准。尚未实测前，不把 Agnes 声明为支持本平台完整 5–15 秒整数集合。

### Ratio / Resolution

官方文档说明当前模型支持：

- resolution tier：480p / 720p / 1080p；
- ratio：16:9 / 9:16 / 1:1 / 4:3 / 3:4。

本平台候选子集保留：

```text
ratio: 9:16 / 16:9 / 1:1
resolution: 720p / 1080p
```

Adapter 将目标 ratio/resolution 转成请求 width/height，但 Agnes 可能做参数归一化。最终必须使用响应中的：

```text
seconds
size
metadata.size_mapping
```

作为实际输出事实。

### Audio

模型专用视频请求文档没有提供音频生成参数，因此当前 Adapter 对：

```text
audio=true
```

明确拒绝，不静默忽略。

## 4. 密钥安全

API Key 只允许来自：

```text
AGNES_API_KEY
```

禁止进入：

- Vue 前端；
- `VITE_*` 环境变量；
- Git commit；
- README 示例真实值；
- JSON evidence；
- GitHub Actions 日志；
- Screenshot / Demo 视频。

用户曾在聊天中直接提供过一枚 Key。由于该 Key 已进入对话历史，建议在完成 Secret 配置后重新生成/轮换，并只把新 Key 写入 GitHub Repository Secret。

## 5. GitHub Secret 配置

仓库中已经提供手动 Workflow：

```text
.github/workflows/agnes-smoke.yml
```

它只通过：

```yaml
${{ secrets.AGNES_API_KEY }}
```

读取密钥。

需要在 GitHub 中设置：

```text
Repository
→ Settings
→ Secrets and variables
→ Actions
→ New repository secret
→ Name: AGNES_API_KEY
→ Value: <new key>
```

不要把 Key 写到 Variable；必须使用 Secret。

## 6. Smoke Test

Smoke workflow 是 `workflow_dispatch`，不会在 push / PR 时自动产生真实 Provider 请求。

执行流程：

```text
checkout
↓
pnpm install --frozen-lockfile
↓
pnpm verify
↓
检查 AGNES_API_KEY Secret
↓
创建 1 条固定 5s 文生视频任务
↓
使用 video_id 轮询
↓
completed
↓
下载结果
↓
SHA-256
↓
上传 sanitized artifact
```

固定 Smoke Prompt 使用简单几何物体，避免人物肖像、客户素材和版权素材。

输出 Artifact：

```text
agnes-smoke-evidence/
├── smoke.json
└── result.mp4        # 成功时
```

`smoke.json` 不保存 API Key，也不保存最终视频 URL。

## 7. 不自动重试 Create

创建视频属于可能消耗配额/费用的非幂等外部操作。

如果：

```text
POST /v1/videos
```

发生超时或 5xx，Adapter 不自动再次提交。

原因：无法仅凭 HTTP 客户端错误证明 Provider 没有受理原请求。盲目 retry 可能产生重复任务。

未来 B3 Worker 必须继续沿用 `needs_reconciliation` 思路，而不是给 create 加普通指数重试。

## 8. 当前状态门槛

在真实 Smoke Test 之前：

```text
Adapter code: implemented locally
Provider evidence: documented
Runtime binding: disabled
Routing eligibility: false
```

只有 Smoke Test 成功并保留证据后，才能把 Agnes 的证据级别提升到：

```text
smoke_tested
```

这仍然不等于 `integrated`。

若要进入真实 Router，还需要：

1. 真实输出 duration/size 校准；
2. IMAGE_GUIDED_VIDEO 实测；
3. 错误路径验证；
4. 真实成本/配额证据；
5. 评测记录；
6. 服务端持久化；
7. B2/B3 鉴权与 Workspace 边界。

## 9. 与原 4×2 评测计划的关系

Agnes 当前用于**验证 Provider Adapter 基础设施**，不自动替换 `docs/10_REAL_EVALUATION_PLAN.md` 中的 Seedance 2.0 / Kling 3.0 两个候选。

原因：目前 Agnes 官方合同不支持我们原 EV003 `reference_video`，也没有证据支持 EV004 的产品/人物/参考视频多参考组合。

如果后续需要将 Agnes 纳入正式横向比较，应建立新的共同能力 Case，而不是为了凑模型数量修改原 Case。
