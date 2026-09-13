# B2.1C｜一次授权 Agnes 真实链路设计

## 当前阶段

Phase A Preflight。授权状态 **NOT AUTHORIZED**；本次真实 Agnes Create 调用数 **0**。本文件是可审查设计，不是已实现或已执行真实模式的证明。Phase A 只完成代码/文档核对、模拟测试与 Spec/Plan；真实执行前必须落实并测试下述 One-Create Guard。

基线：`0d6d500a7a494082c6876bf9be1a081bc32c2a2a`，隔离分支 `codex/b21c-real-agnes-e2e`。Node `24.19.x`、pnpm `12.3.4`，不更换依赖。DOC01、deliverables、原目录文件与本地证据不进入本分支提交。

## 官方合同核对

`docsCheckedAt=2026-09-13T10:12:06Z`；`pricingCheckedAt=2026-09-13T10:12:06Z`（本轮公开文档访问开始时间）。模型 `agnes-video-v2.0`，Bearer 认证；Create 为 `POST https://apihub.agnes-ai.com/v1/videos`，推荐查询为同 host 的 `GET /agnesapi?video_id=<original-id>`，现有 Adapter 另传文档允许的 `model_name`。状态 queued / in_progress / completed / failed；结果在 `metadata.url`。保留历史实测顶层 url 兼容。帧数不超过 441 且为 8n+1，帧率 1–60；121/24 约为 5 秒。宽高可能归一化，reported 与实测分别记录。错误码 400/401/404/500/503；不因错误新增 Create。未发现模型、认证或端点重大不兼容。[官方接口文档](https://agnes-ai.com/en/docs/agnes-video-v20)。

公开当前价 $0/秒；标准价 $0.005/秒。按产品目标 5 秒计算，documented current estimate 为 $0，标准价格参考 $0.025；按 121/24 秒参考约 $0.025208。以上均不是实际账单；账户资格与促销可能影响实际费用。执行前再次核对，价格变化超出本次预期就停止。[官方价格](https://agnes-ai.com/en/docs/pricing)。

## 唯一请求

```json
{
  "mode": "video",
  "prompt": "A simple blue geometric cube on a clean light background, slow gentle camera push-in, minimal studio lighting, stable composition, no text, no people.",
  "count": 1,
  "references": [],
  "video": {
    "durationSeconds": 5,
    "ratio": "16:9",
    "resolution": "720p",
    "audio": false
  }
}
```

现有请求构造器正常映射为以下安全字段，不发送 image、mode、audio 或自造 Provider 参数：

```json
{
  "model": "agnes-video-v2.0",
  "prompt": "A simple blue geometric cube on a clean light background, slow gentle camera push-in, minimal studio lighting, stable composition, no text, no people.",
  "width": 1280,
  "height": 720,
  "num_frames": 121,
  "frame_rate": 24
}
```

五份分离记录：产品目标、Provider request、Provider reported、raw actual、delivery derivative。Provider 无原生 audio 开关的输出不能被称为原生静音支持。

## 已确认的实现缺口与执行前门槛

1. `provider/composition.ts` 与 `server.ts` 当前显式拒绝真实模式。保留普通入口的拒绝；新增本机受控入口，只有有效会话授权记录与一次性能力对象同时存在才可使用真实 Provider。不能把真实 fetch 注入模拟 Provider 冒充接入。
2. `AgnesProvider`、下载类型、RawProviderMedia、领域严格校验与 Store 仅允许模拟来源。新增明确的 `agnes-authorized-real` binding / `real_provider_output` provenance，与模拟分支分别校验。真实 derivative `isDemo=false`，无 synthetic fixtureKey；保持旧快照兼容，不放宽全部媒体校验。
3. Adapter 目前丢弃创建时的 id/task_id/created_at 及 size_mapping；增补固定白名单安全字段，禁止存 message、任意 metadata、原响应或 signed URL。
4. 本次固定请求通过原本的模拟路由/fixture 能力预检。受控入口应明确记录真实执行 binding，同时保留请求验证、Store、额度与业务状态；不能把真实任务的执行 binding 留为 mock，也不能整体启用 registry 的 runtimeEligible。
5. 增加持久化 One-Create Guard 与单 Item 限制，并证明并发、重启和失败均无法二次创建。未通过模拟回归与代码审查，不得到 REAL CREATE。

## One-Create Guard 可执行设计

固定实验 `B21C-2026-09-13`；`createBudget=1`，`maxRealGenerationItems=1`。只有受控入口持有真实 transport；普通入口与 CI 不导入或构造它。Provider 调用前原系统已经落盘 Batch、Item、Attempt、quota reservation、submission intent。

保护层分别承担两种限制：

- HTTP/Service 在 Store 事务内部限制整个实验只有一个 Item；相同幂等键可重放原批次，其他 Create 和 retry 创建新 Item 均拒绝。检查与写入必须同一个事务，不能用请求前数量检查应对并发。
- Provider create 的最外层验证固定请求与固定 Item/Attempt，再以独占 `open(..., 'wx')` 建立预算消费标记，写入并 fsync 后才进入一次真实 transport。已有标记（包括空、截断、损坏）一律拒绝；失败不删除，重启不重置。标记绑定实验、Item、Attempt、源代码 SHA 和授权记录。禁止换目录、新实验 ID 或新 Item 绕过。

一次性本机能力在进入 transport 的同步边界消耗；仅该次在受控子进程中临时允许 real Create，调用后立即关闭 Create gate（含异常路径）。GET/download 使用单独的只读恢复能力，不依赖再次打开 Create gate。

标记先落盘不等于 POST 已发送。分别记录 `createBudgetConsumed` 和 transport invocation；正常 dispatch 记录一次。崩溃落在落盘与 dispatch 之间时保留不确定事实，禁止凭标记伪造“已发送”，也禁止复用预算。即使零实际 POST，预算也不能自动退还。

无真实网络的回归必须验证：缺授权、CI、错误参数、第二个 Item、同进程并发、独立进程竞争、重启、截断标记、Create timeout/拒绝、poll/download/media 失败都不能产生第二次 POST。验证第二次调用只调用拒绝门禁，不能真发第二个请求作测试。

## 唯一数据流与资源上限

HTTP Generation API → Store → GenerationWorker → GenerationProvider → AgnesProvider → guarded real transport。禁止 smoke.ts 替代本链路。

受控运行用现有 `workerIntervalMs=5000`（默认 50ms 不变），再于 transport 强制相邻 GET 至少 5 秒；最大查询 120 次，最长 15 分钟。单次 API/下载 timeout 30 秒；媒体下载最多 2 次，第二次只能针对同一原 ID 的结果；最多总计 123 个外部请求（1 Create + 120 GET + 2 media GET），无其他外部请求。达到任一上限即暂停同一任务，停止此次自动执行。进程重启必须读取既有持久化计数与截止时间，不重获预算。

Create 响应丢失或无法确定结果：`needs_reconciliation`，保留 reservation，停止真实执行；无 ID 不猜 ID，不再次 Create。明确 Provider failed 按领域逻辑结算额度后停止。若有原始 video_id，只查询它，不用查询响应中的其他 ID 覆盖。

下载仅允许 HTTPS 与现有精确媒体 host，无跳转，不向媒体发送 Authorization；MIME、128 MiB、MP4 ftyp、哈希、ffprobe、完整解码全部通过。API transport 也拒绝重定向，避免 POST 重放或认证外泄。URL 只活在下载内存中，持久化只留 resultHost。

raw 原文件只读保留，记录 SHA-256、bytes、width、height、duration、fps、frames、audio、codec、fullDecode。codec 通过受限 ffprobe 白名单读取，禁止记录整个 probe 的自由文本标签。后处理用原 `delivery-v1`：等比适配补边、不裁商品、不拉伸，120 frames / 24fps / 5.000s / 1280×720 / 无音轨；不改变既有时长容差规则。

raw 不可修复或最终化失败：保留 raw/失败证据和原 Attempt，不重 Create。只有 raw、后处理、derivative 校验及持久化全部通过才 succeeded/额度 COMMIT。

## 授权、证据与结束

Phase A Secret 只报告 SET/NOT SET。本次仅配置 Agnes 用户环境变量；不配置火山，不把密钥写进仓库、浏览器或证据。普通测试子进程不继承真实密钥。SET 只证明已配置，不证明 Provider 认证或账户可用；本阶段未发送带凭据的认证探测。

Phase A 后 **STOP**；只有当前会话明确授权一次 Agnes V2.0 T2V、5秒、count1、失败不得再 Create，才能进入 Phase B。凭据配置、历史 smoke 与免费价格均不是授权。

ignored `.ai/evidence/B21C/` 保存 preflight.json、授权原文与时间、request-summary、原始安全 IDs、provider timeline、raw-media、delivery-media、security-audit、final-report。授权前不生成已授权记录。真实媒体和 state 不进 Git。报告字段白名单且不含密钥及其长度/摘要/首尾、Authorization、signed URL、任意 Provider 错误体。

终点固定 `review=pending` / `asset=not_saved`；不得自动评分、审核、入库或创建资产。不宣称质量通过。未获真实账单则后续实际费用字段为 null，与公开价格估算分开。保持 `smoke_tested` / `runtimeEligible=false`。

结束关闭 Create gate、停止受控进程、保留同一任务的安全恢复记录、扫描 secret/URL、运行六条普通门禁并记录对应最终 SHA 的真实结果。普通 CI 永远 0 real Provider calls。PR 将 deterministic code verification 与一次授权真实证据分开，禁止 push 触发真实任务。Windows symlink EPERM 如实记录，Linux 必须运行原测试，不能 skip/降断言。

不包含生产数据库、对象存储、分布式队列、Auth/Workspace、真实计费、公网部署、多模型生产路由或业务质量评测。
