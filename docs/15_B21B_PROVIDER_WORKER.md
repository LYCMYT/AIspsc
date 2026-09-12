# 15｜B2.1B Provider Worker 集成

## 范围与结论

B2.1B 在 B2.1A 的本地 HTTP、文件快照、Batch/Item、额度、审核和显式入库之上增加 Provider-neutral Worker 架构。Worker 只依赖 `GenerationProvider`，Provider 的创建、轮询和下载职责分开；确定性 Fake Provider 和注入式 Agnes 模拟实现同一端口。

本阶段的硬边界是：**Real Agnes Create calls = 0**。Agnes 仍为 `smoke_tested`（技术证据），`runtimeEligible=false`，没有进入业务路由。B2.1B 的 Agnes 结果来自 `FakeAgnesTransport` 和仓库生成的合成 MP4，不能称为真实 Agnes 结果、业务质量评测或生产接入。

这份文档描述当前实现的合同和证据边界。本地门禁结果列于下文；最终 PR HEAD 的 Linux Run ID、产物检查与合并后 main 结果记录在关联 PR 和最终验收报告中。

## 架构与组合根

```text
HTTP API / Service
        ↓
GenerationStore（单进程、原子 JSON 快照）
        ↓
GenerationWorker（一个编排算法，持久化 dueAt 驱动）
        ↓
GenerationProvider
   ┌────┴──────────────────────────┐
   │                               │
DeterministicFakeProvider   AgnesProvider
   │                               │
固定演示夹具                  FakeAgnesTransport
                                   │
                       create / get / download
        ↓
ProviderAttempt（私有生命周期）
        ↓
Provider raw MP4 → FFmpeg delivery-v1 derivative
        ↓
GenerationItem succeeded → 人工审核 → 显式入库
```

`GenerationWorker` 是 Fake 和 Agnes 模拟共同使用的单一编排实现，不存在一套“Fake Worker”和另一套“Agnes Worker”。Worker 不直接实例化 `AgnesVideoClient`，不决定审核、资产或额度政策；这些仍由领域命令和服务层负责。

普通 `pnpm dev`、生产构建、Pages 以及普通 `pnpm http:dev` 继续使用 `MockPlatform` 或 `fake-local`。`apps/web` 没有 Provider 模式选择器，浏览器也不读取 Provider 密钥。HTTP Provider E2E 通过服务端测试入口注入 Provider，用于验证真实 HTTP/Worker/FFmpeg/浏览器闭环；这不是面向操作人的 Agnes 启用方式。

## ProviderPort

Provider-neutral 接口位于 `packages/generation-api/src/provider/port.ts`：

```ts
interface GenerationProvider {
  readonly bindingId: string;
  create(request, context): Promise<ProviderCreateResult>;
  get(externalJobId, context): Promise<ProviderPollResult>;
  download(resultReference, context): Promise<ProviderDownloadedMedia>;
}
```

三个动作有意保持分离。Provider 不负责 quota、review、asset save、Batch 状态、业务 retry 或取消政策；它只把平台请求/上下文翻译成 Provider API，并把 Provider 状态、结果引用和固定错误分类交回 Worker。

`ProviderOperationError` 只允许固定 code、category 和 submission certainty 穿过适配器边界：

- code：`PROVIDER_INVALID_REQUEST`、`PROVIDER_UNAUTHORIZED`、`PROVIDER_NOT_FOUND`、`PROVIDER_RATE_LIMITED`、`PROVIDER_UNAVAILABLE`、`PROVIDER_OUTCOME_UNKNOWN`、`PROVIDER_DOWNLOAD_FAILED`、`PROVIDER_STORAGE_FAILED`、`REAL_PROVIDER_CREATE_DISABLED`；
- category：`invalid_request`、`unauthorized`、`not_found`、`rate_limited`、`transient`、`unknown`；
- certainty：`not_submitted`、`rejected`、`unknown`。

任意原始 transport error、Provider message、cause 和带密钥的 URL 都会被丢弃。错误解码使用跨 loader 可识别的固定 brand（`Symbol.for`），未知对象不会被当作可信诊断。

### DeterministicFakeProvider

`fake-local` 使用已有确定性场景和 `MEDIA_MANIFEST.json`，不使用随机数，不依赖页面、`pump()` 或 GET 请求。`success`、`partial_success`、`failure`、`unknown`、`download_failure`、`storage_failure` 和 `cancel_race` 保留 B2.1A 语义。合成结果标记为演示/合成 Provider 模拟，不能转写成真实运营指标。

### AgnesProvider 的模拟边界

`AgnesProvider` 位于 `packages/generation-api/src/provider/agnes-provider.ts`，复用 `packages/provider-agnes` 的请求构造、状态规范化、结果 URL 兼容、原始 opaque ID、域名校验、下载上限和错误脱敏。测试必须注入 `FakeAgnesTransport`；该 transport 只响应预声明的本地合成请求，未知 URL、未知方法、错误认证和未声明响应都会拒绝，`realCalls` 固定为 0。

当前适配器只允许以下请求子集，其他组合在发送前返回 `PROVIDER_INVALID_REQUEST` 且 `submissionCertainty=not_submitted`：

- `mode=video`；
- `references=[]`，不接受产品/人物/背景/参考视频引用；
- `audio=false`；
- `durationSeconds=5` 或 `10`；
- 比例为 `16:9`、`9:16` 或 `1:1`，分辨率为 `720p` 或 `1080p`，并使用严格 Prompt 合同。

因此图片、文案、多参考视频、任何引用素材、`audio=true`、7 秒等未被 Agnes 适配器验证的组合都会明确拒绝，不静默改时长、比例、分辨率、音频或引用。允许提交的参数仍不等于输出保证：真实 Smoke 已观察到 `1280×704`、约 `5.041667s`、含 AAC；B2.1B 只用同类合成输入演示后处理。

## ProviderAttempt 与私有 schema 2

公共 `GenerationItem.status` 不新增 Provider 中间态。Provider 的细粒度生命周期只存于服务端私有 `ProviderAttempt`：

```text
not_submitted
    ↓ claim（先持久化 submittedAt）
submitting
    ├─ 明确未发送/被拒绝 → failed
    ├─ 响应不确定         → needs_reconciliation
    └─ 接受               → submitted → polling
                                      ├─ unknown → needs_reconciliation
                                      ├─ failed/cancelled → failed
                                      └─ result_ready → downloading
```

Create 响应若已明确 failed/cancelled，保存原 external ID 并立即结算；unknown 则直接暂停对账，不额外轮询覆盖已知终态。成功下载后先保存 raw evidence，再执行最终化；只有 derivative 通过校验并保存，Attempt 才到 `settled`，Item 才到 `succeeded`。公共 Item 在 `result_ready/downloading` 阶段保持 `finalizing`，Batch 聚合仍遵循 B2.1A 的公共状态合同。

schema 2 的 Attempt 字段包括：

```text
lifecycleVersion
attemptId / itemId / attemptNo
providerBindingId
submissionState / providerStatus
externalJobId / externalIdempotencyKey
createdAt / updatedAt / submittedAt / lastPolledAt / nextPollAt
errorCategory
actualCost=null
rawMedia?
derivativeEvidence?
```

当前实现每个 Item 使用一个 `attemptNo=1`；用户重试创建新的 Generation Item、Batch 和 Attempt，并保留 `retryOfItemId`。这避免把失败 Attempt 原地重用成第二次付费 Create。

旧 B2.1A state 没有 `schemaVersion` 时，Store 在打开并通过旧结构校验后写入 `schemaVersion=2`；Worker 在真正执行前显式 adoption。旧的 `submitting`/`outcome_unknown` 会安全转入 `needs_reconciliation`，已有 external job 的旧下载阶段会继续查询原 ID。带有不支持 schema 版本或结构损坏的 state 会拒绝启动，不会清空历史。迁移不是重新创建任务。

公共 snapshot 只投影 legacy-safe Attempt 字段：不会包含 `rawMedia`、`derivativeEvidence`、Provider 原始状态时间、签名 URL、Authorization、原始错误体或密钥；内部 `polling/result_ready/downloading` 对公共投影保持兼容的 `submitted` 语义，未知保持 `outcome_unknown`。

## Create、Poll、Download 和恢复语义

### Create

Worker 在 Provider 调用前通过同一 Store 事务持久化 claim、`submitting` 和原始 `submittedAt`。因此：

- 明确 `not_submitted` 的拒绝（例如真实 Create 被阶段门禁拒绝）可以安全结算失败并释放额度；
- 已进入 `submitting` 后任何无法证明未发送的错误都进入 `needs_reconciliation`，保留 Attempt 和 reservation；
- 没有 `externalJobId` 也不能推导 Provider 没有受理；不会自动再次 POST；
- Provider 返回的 external ID 被限制为安全字符集和 200 字符上限，原 ID 保留，不使用查询响应中另一个 upstream ID 替代。

### Poll

`queued`/`in_progress` 映射为 `queued`/`running`，写入 `lastPolledAt` 和有界的 `nextPollAt`。未知 Provider status、poll timeout 和无可信错误 certainty 都不会直接变成失败：Attempt/Item 进入 `needs_reconciliation` 或保持可继续轮询的状态。已有 external ID 时恢复只调用原 ID 的 `get`。

### Download 与最终化

Provider completed 不等于平台 succeeded。Worker 需要：

1. 接收安全的结果引用；
2. 只允许受信 HTTPS 输出域名，禁止跳转和向媒体域发送 Authorization；
3. 下载后验证 MP4 文件头、128 MiB 上限、SHA-256、ffprobe 实际尺寸/时长/FPS/音轨和全片解码；
4. 将 raw 文件写入 Store 私有目录，并只持久化 host、时间、external ID、实际媒体事实和哈希；
5. 用现有 `packages/media-processing` 的 `delivery-v1` 执行真实 FFmpeg 后处理；
6. 再次验证 derivative，保存 `delivery.json` 和 derivative evidence；
7. 原子地发布媒体、Item succeeded 和 quota COMMIT。

下载失败、哈希失败、raw 文件损坏和后处理失败均保留原 Item/Attempt，不创建新的 Provider job。`retry-download` 会查询原 external ID 或复用已持久化且重新验证的 raw 文件。成功的 raw 可在进程重新打开后直接最终化，不需要重新 GET 或 Create；损坏 raw 则必须回到原 job 重新取得结果。

## Raw 与 derivative provenance

Provider raw 和平台 derivative 是两层事实：

```text
synthetic provider result
  → media/raw-<uuid>.mp4 + RawProviderMedia
  → FFmpeg delivery-v1
  → media/delivery-<uuid>/result.mp4 + delivery.json
```

`RawProviderMedia` 至少保存 provider binding、external job ID、Provider 报告的可选秒数/尺寸、实际 host、获取时间、实际尺寸/时长/FPS/帧数、是否含音轨、raw SHA-256、相对 object key、字节数、全片解码通过标志和 `provenance=synthetic_provider_simulation`。临时 signed URL 不写入 state、snapshot、报告或长期媒体 metadata。

`ProviderDerivativeEvidence` 保存 `delivery-v1`、source raw hash、报告 hash、derivative `MediaFile` 和完成时间。输出为新的文件和新的 hash，原 raw 只读保留。现有 `Asset.source` 仍只有 `upload/generated/fixture`；Provider 完成、技术合格和手动入库仍是三个独立状态。

### delivery-v1 的当前限制

目标为 5–15 秒整数、`16:9/9:16/1:1`、`720p/1080p`、`audio=false`。处理采用等比例缩放、居中补边、不裁切、不强行拉伸，去音轨、统一 24fps，并只裁掉允许范围内的编码尾差。输入过短、明显过长、旋转元数据、非 `1:1` SAR、坏容器和 `audio=true` 目标都明确拒绝。FFmpeg 通过参数数组调用，禁用 shell、网络协议和输入覆盖；输入/输出都会完整解码和复验。

## Quota、取消和对账

B2.1B 继续使用 B2.1A 的演示额度：请求和路由通过后按 Item 预占 1 个 `demo-credit`；明确 Provider failure、明确未提交取消和已确认取消只释放一次；最终 derivative 持久化后 COMMIT 一次。

- Ambiguous Create、未知 poll、缺结果 URL、下载失败、raw 校验失败和可恢复后处理失败保留 reservation；
- 人工审核拒绝不会退款；再次生成是新的 Batch/Item，使用新的 reservation；
- `queued` 在提交前可取消；已经 claim/submitted 的 Item 先进入 `cancel_requested`，没有已验证的 Agnes cancel API，不伪造 Provider Cancel；
- Provider 完成与取消竞争时，以先被同一事务确认的结果收敛；成功结果不会被旧取消事件覆盖；
- `/reconcile` 对 fake-local 保留 B2.1A 的合成 operator outcome；对 Agnes 模拟忽略请求中的建议 outcome，只安排 GET 原 external ID，由 Provider 结果决定收敛。没有 external ID 的 ambiguous Create 继续停留 `needs_reconciliation`，不能据此推断未受理或重新 Create。

## 安全门禁与密钥边界

当前组合策略是故意 fail-closed：

- 未设置 `PROVIDER_MODE` 时总是 `fake-local`，即使进程环境存在 `AGNES_API_KEY`；
- `PROVIDER_MODE=agnes` 得到 `agnes-disabled`，其 `create/get/download` 明确返回 `REAL_PROVIDER_CREATE_DISABLED`，不会 fallback 到 Fake；
- `AGNES_REAL_CREATE_ENABLED=true` 在 B2.1B 的 stage guard 中直接拒绝：CI 报 `REAL_PROVIDER_CALL_FORBIDDEN_IN_CI`，非 CI 报 `REAL_PROVIDER_CALL_OUTSIDE_STAGE`；
- 该阶段没有把 flag 设为 true 的启用步骤，也没有 CLI、Pages 或普通 HTTP 入口可以绕过门禁；
- `AGNES_API_KEY` 只允许在未来的 server-side Provider composition boundary 使用，不进入 Vue、`VITE_*`、HttpPlatform、API response、public snapshot、state.json、日志、截图、fixture 或 artifact；
- 新 Worker 的 Provider error 只保留固定 code/category，丢弃原始错误消息。已有 Agnes client 的独立脱敏回归保留 `[REDACTED]` 语义，两者不是同一种输出。

## 故障矩阵与现有回归覆盖

下表列出当前代码/测试中已经表达的行为。本地完整 Gate 已运行；表内名称是可检索的回归定位，不能替代最终 HEAD 的 Linux CI 结果。

| 故障/竞态 | 当前行为 | 主要测试定位 |
|---|---|---|
| Provider Create 明确未发送即拒绝 | Item `failed`，释放 reservation；用户 retry 创建新 lineage | `packages/generation-api/src/provider-worker.test.ts`：`known pre-send rejection releases and user retry creates new lineage`；`packages/generation-api/src/provider/agnes-provider.test.ts`：`rejects unsupported requests before transport` |
| Create timeout/响应丢失 | claim 已持久化；Item `needs_reconciliation`，Attempt 保留，reservation 保留，不再次 Create | `provider-worker.test.ts`：`durable ambiguous create never repeats across ticks or reopening and retains reserve without secret`、`persists original claim submittedAt before IO and preserves it after ambiguous response` |
| 两个 Worker/tick 同时 claim | Store/active-store gate 合并执行，Create 只发生一次；取消版本变化不会覆盖 accepted external ID | `provider-worker.test.ts`：`two workers coalesce a persisted claim and retain accepted id when cancel changes version` |
| restart 位于 submitting | 新 Worker 不 POST，转为需对账，保持 reservation | `provider-worker.test.ts`：`restart after claim pauses without POST and public attempts contain only legacy-safe fields`；`worker-process-restart.provider.test.ts`：`a separate Node process resumes durable submitting without another create` |
| poll timeout | 保持 running，记录 `lastPolledAt/nextPollAt`，不把 timeout 当失败 | `provider-worker.test.ts`：`poll timeout and restart resume GET only, unknown pauses, reconcile ignores synthetic failure` |
| Provider 未知状态 | `unknown → needs_reconciliation`，不伪造终态；有 external ID 时可继续原 job 对账 | `packages/generation-api/src/provider/agnes-provider.test.ts`：`normalizes unknown status without persisting it`；`provider-worker.test.ts` 同上 |
| Create 已确认 failed/cancelled/unknown | failed/cancelled 释放；unknown 进入 reconciliation；不额外 poll 已确认终态 | `provider-worker.test.ts`：`honors confirmed create status %s immediately without polling away evidence` |
| completed 但没有可用 URL | Item 保持 `finalizing`，reservation 保留；retry-download 查询同一 job | `provider-worker.test.ts`：`completed without a usable URL stays finalizing and retry-download queries original job` |
| 下载网络失败或首个 hash 错误 | 保持 finalizing，不产生 raw 成功证据；重试 download，external ID 和 Create 次数不变 | `worker-recovery.provider.test.ts`：`recovers %s failure using the original provider job` |
| 已持久化 raw 后 FFmpeg 最终化失败 | raw 保留、derivative 未发布；重新打开 Store/Worker 后可继续最终化，不 GET/Create | `worker-recovery.provider.test.ts`：`raw is durable before finalization failure and reopened worker finalizes without GET or create` |
| raw 文件被破坏 | raw evidence 保留；重新查询原 job；未知/对账后按原 job 的 result_ready 或 failed 收敛 | `worker-recovery.provider.test.ts`：`retains corrupt raw evidence through unknown/reconcile and recovers %s on the original job` |
| 伪造 fixture bytes | 即使 metadata 看似来自 manifest，也拒绝发布媒体和 succeeded | `provider-worker.test.ts`：`rejects forged fixture download bytes even with catalog-looking metadata` |
| MP4/尺寸/音轨/帧数不符合 | raw 记录实际事实；delivery-v1 只发布通过 FFmpeg 校验的 derivative | `media-repository.provider.test.ts`：`preserves actual raw facts before real delivery-v1 normalization`；`packages/media-processing/src/delivery.integration.test.ts`：`preserves original bytes and validates an exact silent 120-frame derivative` |
| Provider HTTP 400/401/429/503 | 映射固定 category；不保留原始响应，不自动重试 paid Create；不暴露 secret | `packages/generation-api/src/provider/agnes-provider.test.ts`：`maps HTTP %i without raw errors or retry`、`maps %s transport timeout safely without retry` |
| URL shape/opaque ID 差异 | 只接受 `metadata.url` 或顶层 `url`；查询继续使用原 opaque `video_id` | `packages/provider-agnes/src/result-recovery.test.ts`：`reads the top-level url...`、`preserves documented metadata.url...`、`uses the original opaque query ID...` |
| 不可信媒体 host/跳转/超大或 HTML | 拒绝 host、跳转、错误 MIME、空响应和超过上限的 body；下载请求不带 Provider Authorization | `packages/provider-agnes/src/download.test.ts` 全组；`packages/generation-api/src/provider/agnes-provider.test.ts`：`downloads bounded credential-free bytes with hash and redirects disabled` |
| Provider secret echo | 新 Worker 仅保留固定分类，原文不进入 Attempt、state、snapshot、捕获日志、浏览器请求或安全报告 | `packages/provider-agnes/src/index.test.ts`：`redacts the configured API key...`；`packages/generation-api/tests/http-provider.provider.test.ts`：模拟 HTTP/浏览器 secret absence 断言 |
| submitted/polling/downloading/settled 的受控进程 restart | 通过关闭 Store、释放锁、启动新的 Node Worker 验证原 Attempt/job 继续；不是 SIGKILL、断电、遗留锁或 OS 崩溃证明 | `packages/generation-api/tests/worker-process-restart.provider.test.ts`：`a separate Node process resumes durable %s without another create` |

## 真实 HTTP/浏览器模拟验收路径

`packages/generation-api/tests/http-provider.provider.test.ts` 覆盖一条测试专用链路：

```text
HTTP Create
 → GenerationStore
 → GenerationWorker
 → AgnesProvider
 → FakeAgnesTransport
 → original video_id polling
 → synthetic MP4 download
 → raw evidence / FFmpeg delivery-v1
 → playable history video
 → review pending/approved
 → explicit asset save
 → review revision invalidates old asset
```

测试使用合成的 `1280×704`、121 帧、带 AAC 的输入，最终 derivative 为 `1280×720`、120 帧、约 5 秒、无音轨。审核通过不会自动产生 Asset；点击入库才增加资产；改判会使既有资产 `review_invalidated`。测试还断言真实外部请求为 0、浏览器无 Provider Authorization、state/public snapshot 无 secret/signed URL/private raw evidence、视频可播放且无 page/console error。

## 本地门禁与远端验收要求

运行环境：Node.js `24.19.0`，pnpm `12.3.4`；测试需要 Chromium，媒体测试需要 FFmpeg/ffprobe。每条命令都应先由 Provider CI guard 检查，不能通过跳过或 `continue-on-error` 造绿。

本地代码验收对应源代码提交 `2995c8b53dcf55ef624e5f59ca0b95744e2743e7`（运行时为其待提交工作树），时间为 2026-09-13 Asia/Shanghai；不将本地结果称为最终 HEAD 的 Actions 结果。

| Gate | 命令 | Tests | Failed | Skipped | Exit |
|---|---|---:|---:|---:|---:|
| Verify | `pnpm verify` | 492 | 0 | 0 | 0 |
| B1 E2E | `pnpm test:e2e` | 74 | 0 | 0 | 0 |
| HTTP E2E | `pnpm test:http:e2e` | 11 | 0 | 0 | 0 |
| Delivery（Windows） | `pnpm test:delivery` | 10 | 1 | 0 | 1 |
| Delivery UI | `pnpm test:delivery:ui` | 1 场景 / 8 检查 | 0 | 0 | 0 |
| Provider simulation | `pnpm test:provider:e2e` | 20 | 0 | 0 | 0 |

Verify 包含 438 unit、42 contracts、12 HTTP。Provider 包含媒体 6、Worker 恢复 5、真实 HTTP/浏览器与密钥回显 4、独立进程恢复 5。Windows Delivery 是 9 passed / 1 failed，失败在 symlink 创建 EPERM；测试未修改、未跳过，最终 Linux 必须真实运行同一 10 项并全部通过。

远端 Linux Actions 结果必须按最终 HEAD 记录 Run ID；本地日志、截图和 ignored artifacts 不能冒充远端 CI。Windows 上 `GenerationMediaRepository` 跳过目录 fsync，因为 Node 当前不能安全打开 Windows 目录句柄；因此 restart 证据是受控 close/reopen/fresh Worker，不是断电后的目录持久化保证。

## 明确的非目标与当前缺口

本阶段不做真实 Agnes Create、真实 Provider 账单、PostgreSQL、对象存储、Redis、分布式队列、Auth/Workspace、多 Provider 自动切换、公共部署、任意上传视频的 Provider 生成、生产级断电恢复或自动质量择优。B2.1C 的“一次授权真实 Provider E2E”必须另获授权，并从 HTTP → Create → Poll → Download → raw evidence → delivery → Review Pending 重新建立证据链。

运行与证据限制：

- 六条本地 Gate 已执行；独立分项高风险审查已通过，最终整分支高审查、Linux CI 与 artifact 检查以关联 PR 的验收记录为准；
- `worker-process-restart.provider.test.ts` 的受控子进程覆盖不等于 SIGKILL、陈旧 lock、断电或多进程生产恢复；
- Windows 目录 fsync 被跳过，不能宣称和 Linux 一样的目录落盘语义；
- `captureRaw` 在写入后 ffprobe/解码失败时返回稳定错误，state 不会引用失败文件；当前没有自动回收这些私有孤儿文件的机制，不能把未引用文件当成成功 raw evidence 或公开结果；
- 当前 `PROVIDER_MODE=agnes` 仍是显式拒绝 Provider，只有测试注入才能跑 Agnes 模拟；不存在 B2.1B 的真实启用步骤。

因此本文只能把 B2.1B 描述为“Provider-neutral worker architecture and simulated Agnes integration”。只有最终 PR HEAD 全部门禁、实际产物检查和独立整分支审查通过后才能给出 Ready for B2.1C 的建议；这不是调用真实 Provider 的授权，也不会升级 Agnes 的 evidence level。
