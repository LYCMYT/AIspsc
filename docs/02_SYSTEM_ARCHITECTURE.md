# 02｜系统架构与演进边界

## 1. 当前 B1 架构

B1 的目标是验证产品行为与领域合同，而不是伪装成生产后端。

```text
┌──────────────────────────────────────────────┐
│                 Vue 3 Web                    │
│                                              │
│ Create / History / Assets / Split / Recognize│
└──────────────────────┬───────────────────────┘
                       │ ServiceFacade
                       ↓
┌──────────────────────────────────────────────┐
│                MockPlatform                  │
│                                              │
│ Generation / Review / Asset / Split / Quota │
└─────────────┬───────────────────┬─────────────┘
              │                   │
              ↓                   ↓
┌─────────────────────┐   ┌────────────────────┐
│ packages/domain     │   │ packages/media-store│
│                     │   │                    │
│ validation          │   │ IndexedDB Blob     │
│ routing             │   │ metadata restore   │
│ split               │   └────────────────────┘
│ review              │
│ quota               │
│ state               │
└─────────┬───────────┘
          │
          ↓
┌──────────────────────────────────────────────┐
│ Contracts / Fixtures / Deterministic Media   │
│ JSON Schema / OpenAPI / test vectors         │
└──────────────────────────────────────────────┘
```

## 2. 各层职责

### `apps/web`

负责用户交互和状态展示，不定义第二套业务规则。

主要入口：

- `CreatePage.vue`：任务意图、参考素材与生成参数；
- `HistoryPage.vue`：异步状态、重试/取消/对账、审核与手动入库；
- `AssetsPage.vue`：素材与生成资产管理；
- `DecomposePage.vue`：拆解规划与真实浏览器媒体预览；
- `RecognizePage.vue`：固定样例与人工标签，不伪造 AI 识别。

### `packages/contracts`

定义 Web、Mock 和未来真实 API 共同使用的类型合同，包括：

- `CreateGenerationRequest`；
- Batch / Item 状态；
- RoutingDecision；
- Evaluation；
- Credit / Ledger；
- ServiceFacade。

### `packages/domain`

负责纯业务规则：

```text
unknown input
   ↓
validation
   ↓
classification
   ↓
routing
   ↓
state / review / quota / split rules
```

它不应该知道 Vue、数据库、S3、Seedance 或 Kling 等基础设施细节。

### `packages/mock-service`

B1 的浏览器内确定性执行环境。它实现 `ServiceFacade`，用于：

- 演示批量生成和异步状态；
- 故障与竞态场景；
- 额度生命周期；
- 审核与入库；
- 固定 fixture 拆解。

它不是生产后端。

### `packages/media-store`

用 IndexedDB 持久化本地 Blob 与媒体元数据。B1 不把 `blob:` URL 当长期数据，而是在读取 Blob 后重新创建临时 URL。

## 3. 当前最重要的架构缝隙：Platform Adapter

当前组合根：

```ts
export const platform: DemoPlatform = new MockPlatform();
```

B2 不需要重写 Vue 页面，而是新增真实 HTTP 实现：

```text
                   ┌─ MockPlatform  ← B1 / Demo
UI → ServiceFacade ┤
                   └─ HttpPlatform  ← B2+
                           │
                           ↓
                         API
```

这样可以同时保留：

1. 免费、确定性、离线可复验的作品集 Demo；
2. 真实后端的生产化演进路径；
3. 同一套请求、状态、审核和可靠性语义。

## 4. B2 目标架构

```text
┌──────────────────────┐
│      Vue Web         │
└──────────┬───────────┘
           │ HttpPlatform
           ↓
┌──────────────────────┐
│       API App        │
│ Auth / Workspace     │
│ Validation           │
│ Query / Commands     │
└──────┬────────┬──────┘
       │        │
       │        └───────────────┐
       ↓                        ↓
┌───────────────┐       ┌────────────────┐
│ PostgreSQL    │       │ Object Storage │
│ authoritative│       │ media files    │
│ state/ledger │       └────────────────┘
└──────┬────────┘
       │ Outbox
       ↓
┌──────────────────────┐
│       Worker         │
│ provider execution   │
│ polling/callback     │
│ FFmpeg               │
│ result persistence   │
└──────────────────────┘
```

### B2 必须迁移到服务端的权威能力

- Workspace / Membership 权限；
- 批次与子任务状态；
- 幂等键与版本竞争；
- 额度预占/结算/释放；
- ProviderAttempt；
- Evaluation / Asset；
- 媒体访问授权；
- Outbox / AuditEvent。

浏览器不再承担真实财务账本或生产授权判断。

## 5. B2 第一优先级：真实媒体处理

在接入付费模型之前，优先把视频拆解从“区间计划”升级成真实媒体能力：

```text
Upload
  ↓
Object Storage
  ↓
ffprobe
  ↓
metadata
  ↓
existing split planner
  ↓
FFmpeg render
  ↓
clip validation
  ↓
Object Storage
  ↓
preview / download / reuse
```

原因：

- 不依赖付费 Provider；
- 现有数学拆解规则已经稳定；
- 可以直接验证关键帧、VFR、旋转元数据、无音轨等媒体边界；
- 能把一个明显的 B1 模拟能力升级为真实基础设施能力。

## 6. B3 Provider Adapter

真实模型接入不能写成散落在业务代码里的：

```text
if model == A ...
else if model == B ...
```

建议的 Provider 接口职责：

```text
ProviderAdapter
├─ create()
├─ get()
├─ cancel?()
├─ normalizeStatus()
├─ normalizeError()
├─ downloadResult()
└─ capability()
```

一个 Adapter 只负责翻译：

```text
Platform contract
      ↕
Provider-specific API
```

业务层继续只看统一的 `GenerationItemStatus`、`DomainErrorCode` 和 `RoutingDecision`。

## 7. 未来真实 Router

B1 Router 当前只证明 capability matching 语义。B3 真实 Router 可演进为两阶段：

### 阶段一：硬约束过滤

```text
TaskType
reference roles/count
duration
ratio
resolution
audio
provider availability
```

任何硬约束不满足就淘汰，不能通过偷偷修改请求来适配模型。

### 阶段二：软目标排序

在有真实证据以后再考虑：

```text
quality evidence
cost
latency
provider health
recent failure rate
```

B1.5 不提前实现没有数据支持的“智能评分 Router”。

## 8. 数据流：生成任务

```text
Web
 ↓
CreateGenerationRequest
 ↓
strict schema validation
 ↓
semantic asset/workspace validation
 ↓
classifyTask
 ↓
selectBinding
 ↓
reserve quota
 ↓
create batch/items
 ↓
worker/provider attempt
 ↓
finalize media
 ↓
succeeded / failed / reconciliation
 ↓
human review
 ↓
manual library save
```

## 9. 数据流：未知 Provider 结果

```text
submit paid request
       ↓
timeout / ambiguous response
       ↓
needs_reconciliation
       ↓
keep reservation
       ↓
query same external job / callback / manual evidence
       ↓
settle exactly one platform terminal outcome
```

不能做：

```text
timeout
  ↓
assume failed
  ↓
release quota
  ↓
automatically submit a second paid generation
```

## 10. 测试分层

```text
Domain unit tests
      ↓
Contract tests
      ↓
Mock integration tests
      ↓
Web E2E
      ↓
B2 real dependency integration tests
      ↓
B3 provider smoke/evaluation tests
```

B1.5 新增 GitHub Actions 只复验已有确定性命令，不引入任何需要真实密钥或付费调用的 CI。

## 11. 当前明确不做的架构升级

B1.5 不引入：

- Kubernetes；
- Kafka；
- 多微服务拆分；
- Redis 作为必要依赖；
- 多 Provider 自动故障切换；
- 复杂模型评分算法。

这些能力只有在真实规模、并发或数据证明需要时再加入。当前优先保证领域合同、证据链和演进边界清晰。
