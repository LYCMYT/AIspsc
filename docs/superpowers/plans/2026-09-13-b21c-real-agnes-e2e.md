# B2.1C One Authorized Agnes E2E Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. The Phase A STOP overrides automatic execution handoff.

**Goal:** 完成可审查预检，并在用户另行授权后，经平台完整链路最多执行一次真实 Agnes T2V。

**Architecture:** 保留 HTTP → Store → Worker → ProviderPort → AgnesProvider。独立受控入口持有一次性能力与持久化预算，普通入口继续模拟；真实来源与模拟来源分开严格校验。

**Tech Stack:** Node 24.19.x、pnpm 12.3.4、现有 TypeScript/Vite/Vitest/Playwright、FFmpeg/ffprobe；不新增依赖。

**Spec:** `docs/superpowers/specs/2026-09-13-b21c-real-agnes-e2e-design.md`

## Global Constraints

- Phase A 授权状态 `NOT AUTHORIZED`，真实 Create 数 0。
- `createBudget=1`，`maxRealGenerationItems=1`；timeout/restart/poll/download/media 失败都不退还预算。
- 精确使用 Spec 固定 Prompt、video/count1/5s/16:9/720p/audiofalse/无引用。
- 默认 fake、真实 gate 关闭、普通 CI 零真实请求；不把启用值写进配置文件。
- 六条普通门禁不 skip、不删测试、不降断言、不忽略失败退出码；Windows EPERM 与 Linux 实测分开。
- 真实媒体/state/授权记录/本地 evidence 均 ignored；Git 只提交安全文档、必要实现及回归。
- 结束于 review pending / asset not_saved；不评分、不审核、不入库，不升级模型 evidence enum。

## 阶段边界

本计划在 Phase A 只执行任务 1，然后 STOP。任务 2–6 是授权后的实施计划，**尚未实现**；它们先使用模拟 transport 通过全部检查，再执行独立的 REAL CREATE 步骤。密钥配置不越过该 STOP。准备完成表示可以审阅授权范围，不表示已有真实模式可直接运行。

## Task 1: Phase A Preflight（当前可执行）

**Files:** 创建本 Spec/Plan；保存 ignored `.ai/evidence/B21C/preflight.json` 与 `preflight-report.md`、各门禁日志；不改产品代码。

**Interfaces:** 消费 README 权威链、docs09/11/12/13/14/15、provider/contracts/domain/generation/media 代码及当前 Actions；产出安全预检报告和本执行计划。

- [x] 在独立 worktree 更新 main，确认包含 `0d6d500a7a494082c6876bf9be1a081bc32c2a2a`，创建 `codex/b21c-real-agnes-e2e`。
- [x] 本轮重新读取 Agnes 官方接口和价格，记录时间与兼容性；只访问公开文档，不带凭据调用 API。
- [x] 检查 Secret 仅输出 SET。只配置 Agnes Windows 用户环境变量，未配置火山。
- [x] 对照真实任务需求列出源码缺口；将一次性保护、参数、请求上限、证据、恢复与停止条件写入 Spec。
- [x] 在无真实密钥的测试子进程运行以下四条命令，设置本地 Chromium 路径。最终 verify 492、B1 74、HTTP 11、Provider 20 全过，0 skipped。首次 Provider 16 passed/4 failed 已保留，设置浏览器路径后串行完整复跑通过；源码/断言/超时未改。后续串行运行涉及同一个 Vite 缓存的门禁。

```powershell
$env:AGNES_API_KEY = ''
$env:PROVIDER_MODE = 'fake'
$env:AGNES_REAL_CREATE_ENABLED = 'false'
$env:PLAYWRIGHT_BROWSERS_PATH = (Resolve-Path .cache/ms-playwright).Path
npm exec --cache .cache/npm --yes --package pnpm@12.3.4 -- pnpm verify
npm exec --cache .cache/npm --yes --package pnpm@12.3.4 -- pnpm test:e2e
npm exec --cache .cache/npm --yes --package pnpm@12.3.4 -- pnpm test:http:e2e
npm exec --cache .cache/npm --yes --package pnpm@12.3.4 -- pnpm test:provider:e2e
```

- [x] SELF_REVIEW Spec 对照、字段名、路径、默认门禁、secret/URL；安全扫描 PASS。实际查看 Provider 两张截图/三个报告和 HTTP 三张截图。保留失败与完整复跑结果，不把复跑成功改写成首次通过。
- [x] 保存预检报告，阶段状态 READY_FOR_B21C_AUTHORIZATION / REAL_AGNES_CREATE_CALLS_SO_FAR=0；STOP，不运行下文。

## USER AUTHORIZATION REQUIRED

用户必须在本会话单独授权：仅允许一次 Agnes Video V2.0 T2V Create，count1、5秒，任何失败不得再次 Create。之后才能实施任务 2–6；授权记录只保存原文、时间、实验 ID、请求及基线，不含密钥。

## Task 2: 实现并以模拟 transport 验证一次性能力

**Files:** 新建 `packages/generation-api/src/provider/one-create-guard.ts`、`one-create-guard.test.ts`；新建 `packages/generation-api/tests/one-create-process.provider.test.ts` 及 `tests/helpers/one-create-child.mjs`。测试可以使用固定模拟授权文本，不读取真实授权/凭据。

**Interfaces:** 导出 `consumeCreateBudget(markerPath: string, identity: { experimentId: string; itemId: string; attemptId: string; sourceSha: string; authorizedAt: string }): Promise<void>`。调用者先验证会话授权和固定请求；该函数只负责一次性预算，不调用网络、不接受密钥。后续受控 Provider 装饰器在其成功之后才调用 inner.create。

- [ ] 写失败测试，涵盖消费成功后进程重开仍拒绝、并发只有一个成功、空/损坏文件 fail closed。

```ts
const identity = {
  experimentId: 'B21C-2026-09-13', itemId: 'item-test', attemptId: 'attempt-test',
  sourceSha: '0'.repeat(40), authorizedAt: '2026-09-13T00:00:00Z',
};
const outcomes = await Promise.allSettled([
  consumeCreateBudget(markerPath, identity), consumeCreateBudget(markerPath, identity),
]);
expect(outcomes.filter(x => x.status === 'fulfilled')).toHaveLength(1);
await expect(consumeCreateBudget(markerPath, identity)).rejects.toThrow('CREATE_BUDGET_EXHAUSTED');
```

- [ ] 运行 `pnpm exec vitest run --project unit packages/generation-api/src/provider/one-create-guard.test.ts`，确认新测试因缺少实现失败。
- [ ] 最小实现使用 exclusive open，目录须为启动时校验的固定私有实验目录。核心落盘操作如下；已有任何标记直接拒绝，write/sync 失败保留标记且固定报错，不回显原异常。

```ts
const handle = await open(markerPath, 'wx', 0o600).catch(() => {
  throw Error('CREATE_BUDGET_EXHAUSTED');
});
try {
  await handle.writeFile(JSON.stringify({ version: 1, createBudgetConsumed: 1, ...identity }));
  await handle.sync();
} catch {
  throw Error('CREATE_BUDGET_PERSIST_FAILED');
} finally {
  await handle.close();
}
```

- [ ] Linux 同步父目录，Windows 明确记录目录 fsync 限制；缺标记但既有 state/dispatch 记录或陈旧锁时拒绝重新初始化。不要把删除文件、恢复旧备份或换实验目录当正常恢复。
- [ ] 扩展独立进程测试：两个子进程共享 marker，仅一个获得许可；成功后再开第三个进程仍拒绝。故障注入分别在预算写入前、写入后、dispatch 前、dispatch 后丢响应，保留 consumed 与 observed invocation 的区别。
- [ ] 模拟 create 计数器证明 throw/timeout 后调用仍为 1；GET/download 失败不调用消费函数第二次。运行相关 unit/provider 全组，审查 diff 后提交安全实现。

## Task 3: 真实来源、Provider 安全事实与单 Item 服务端限制

**Files:** 修改 `packages/contracts/src/provider-media.ts`、`generation.ts`，`packages/domain/src/provider-attempt.ts`、`provider-commands.ts`，`packages/provider-agnes/src/index.ts`，`packages/generation-api/src/provider/types.ts`、`agnes-provider.ts`、`worker.ts`、`media-repository.ts`、`store.ts`、`service.ts`。对应现有测试逐项扩展；不修改 delivery policy。

**Interfaces:** 在现有类型增加判别值 `real_provider_output` / `agnes-authorized-real`。模拟保持原值；`AgnesProviderOptions` 的执行 kind 只能由受控组合根传入真实值。ProviderCreateResult 和 ProviderPollResult 可带 `reported?: ProviderReportedFacts`，Attempt 保存同名白名单事实；transition/strict keys/public projection 一同更新。

```ts
interface ProviderReportedFacts {
  videoId?: string; taskId?: string; id?: string;
  status: 'queued' | 'in_progress' | 'completed' | 'failed' | 'unknown';
  createdAt?: number; seconds?: number; size?: string;
  sizeMapping?: {
    adjusted?: boolean; width?: number; height?: number;
    requestedWidth?: number; requestedHeight?: number;
    ratio?: '16:9' | '9:16' | '1:1' | '4:3' | '3:4';
    resolution?: '480p' | '720p' | '1080p';
  };
}
```

- [ ] 先写解析失败测试：合法 id/task_id/created_at/size_mapping 经创建、poll、Store reopen 保留；secret echo、任意 message、metadata.url 均不持久化。IDs 使用现有安全 opaque 校验，未知形状停止，不猜值。
- [ ] 写真实来源模拟回归：人为声明 real binding 并注入 FakeAgnesTransport，transport 请求计数属于模拟，绝不称为真实任务证据。期待 raw 为 real_provider_output、derivative 为 isDemo=false/无 synthetic fixtureKey；该测试只验证类型和链路分支。

```ts
expect(raw.provenance).toBe('real_provider_output');
expect(derivative.media.isDemo).toBe(false);
expect(derivative.media.fixtureKey).toBeUndefined();
expect(snapshot.items[0]?.reviewState).toBe('pending');
expect(snapshot.items[0]?.libraryState).toBe('not_saved');
expect(transport.realCalls).toBe(0);
```

- [ ] 严格媒体校验按判别值分支，真实分支要求受信 Attempt + raw/derivative hash 与报告绑定，不是允许所有媒体 isDemo=false。旧 schema2/fixture 必须原样通过；公共投影不泄漏私有事实。若需要改变 schemaVersion，提供旧版本读取迁移回归，不能重置 state。
- [ ] 受控模式的 Service 配置固定实验请求和幂等键。createBatch 的 Store 事务在创建前拒绝已有实验 Item；retry 在生成新 Item 前拒绝。普通 Service 的行为不变。并发两个不同幂等键只产生一个 Item；重放原 key 返回原批次。
- [ ] 记录实际 execution binding，不能用模拟路由记录表示真实执行。保留 validateGenerationRequest、额度、历史、审核分离，registry runtimeEligible=false 不变。
- [ ] 扩展 raw codec 的安全证据采集：现有 ffprobe 使用数组参数、无 shell、禁网络，只提取 codec_name，合法值限 `[a-zA-Z0-9_]{1,40}`，不保存任意 tags。可存私有 evidence，无需改变 delivery-v1 媒体规则。
- [ ] 跑 verify/provider/HTTP/Delivery 相关全组，审查真实/模拟来源严格分支与状态迁移后提交。任何失败保留原日志、先定位再修。

## Task 4: 受控入口与完整模拟演练

**Files:** 新建 `packages/generation-api/scripts/b21c-authorized.ts`、`packages/generation-api/src/provider/authorized-session.ts` 与单测；修改 `server.ts`、`provider/composition.ts` 接受仅服务端传入的能力对象。扩展 `tests/http-provider.provider.test.ts`，保留原 4 项。

**Interfaces:** `openAuthorizedSession({ directory, sourceSha, authorizationRecord, env, transport }): Promise<{ provider: GenerationProvider; close(): Promise<void> }>`；transport 必须显式注入，普通入口不传真实 fetch。`startGenerationApi` 增加可选 session 能力，CI 检查永远先于例外；Worker 保持同一个算法。

- [ ] 先写拒绝测试：只有 key、只有 mode、只有 flag、只有文本文件、缺请求绑定、SHA 不同、CI=true、目录可公开，全部拒绝且 mock fetch 为 0。无法通过 JSON 布尔字段伪造本机能力对象。
- [ ] session 固定实验目录并读取预算/原 ID/请求数量/截止时间；不接受 CLI 改实验 ID、count、prompt、目录以重置授权。恢复分支只能 GET 原 ID，不能调用创建入口。
- [ ] 启动 server 使用 `workerIntervalMs: 5000`，transport 再持久化限制最少 5秒 GET 间隔、最多120次 GET、2次媒体下载、15分钟总期限。临时过程变量只在该受控子进程设置，不能由共享环境默认启用。普通 `assertProviderStage` 和 scripts/provider-ci-guard 继续阻止普通 gate。
- [ ] 真实 transport 只允许固定 API host/path/method；设置 redirect:error，无自动 retry。一次性预算先写入，再调用 fetch；进入 Create 的同步边界消费内存 capability，并立即关闭后续 Create，finally 再确保关闭。媒体走现有 allowlist/无认证下载实现。
- [ ] 使用 FakeAgnesTransport 演练 HTTP → Store → Worker → AgnesProvider → raw → FFmpeg → review pending，断言 Create 前五种持久化记录齐全、第二个 Item/第二次 Create 被拒绝、成功后不产生 evaluation/asset。拒绝实验中 review/assets 写路由或不向自动化开放这些操作。
- [ ] 遍历 timeout、明确failed、未知状态、坏URL、坏MP4、后处理拒绝、恢复原ID等结果；全部 create<=1。人工 review 表单不填；检查浏览器 console/page errors 和 token/storage 边界。
- [ ] 跑完整六 gates，SELF_REVIEW 或获授权的独立审查；记录最终代码 SHA。Windows symlink 红项必须保留，并取得同 SHA 的 Linux 原测试通过证据才将它归因于 Windows 权限。任何未解决 Critical/P1/P2 或无法解释的回归均停止。

## Task 5: REAL CREATE（独立危险步骤，前四任务全部满足才执行）

**Files:** 只写 ignored `.ai/evidence/B21C/` 与本机私有任务目录；不改源码、不提交真实响应。

**Interfaces:** 调用任务4已模拟验收的本机入口；唯一请求从已验证的 HTTP Generation API 提交，不调用 smoke.ts，不直接调用 Provider SDK 替代业务入口。

- [ ] 再核对本会话授权原文、git status/HEAD、SET、官方价格/接口、createBudgetRemaining=1、零既有dispatch。读取安全环境只在受控进程内进行；不打印值或原文件路径。
- [ ] 使用固定 Idempotency-Key `b21c-2026-09-13-one`，向本机 `/v1/generation-batches` 提交 Spec 完整 JSON；等待持久化记录与一次 Create。若本机 HTTP 响应丢失，先只读查 state；不能盲目换 key 再提交。
- [ ] Create 一旦尝试即关闭 gate。取得原 ID 则保存安全事实并按上限 GET；结果不确定立刻 needs_reconciliation/STOP。明确 failed 正确释放额度后结束实验；不为获得视频重来。
- [ ] completed 后下载、保留 raw、ffprobe/hash/decode、delivery-v1、校验 derivative。每层事实分别记录；任何失败不重新生成。
- [ ] 成功仅到 pending/not_saved。实际观看视频验证可加载播放，不自动评价内容质量、评分或入库。

## Task 6: 审计、证据与交付

**Files:** ignored `provider-timeline.json`、`raw-media.json`、`delivery-media.json`、`security-audit.json`、`final-report.md`；安全结论可进入后续 docs/PR。不提交 MP4/state/secret/signed URL。

- [ ] 验证二次 Create 被本地拒绝且没有外部请求，保存 observed dispatch 与 budgetConsumed；遇到崩溃不确定窗口如实报告，不能猜 0/1。
- [ ] 汇总 Batch/Item/Attempt、原始安全 Provider IDs、timeline、请求/报告/实测/derivative、hash、真实账单缺失情况、pending/not_saved。
- [ ] 在内存中精确扫描 key 与签名 URL 是否进入 state、日志、evidence、截图相关报告、浏览器存储、Git diff，仅输出 PASS/FAIL，不输出匹配行、key hash 或路径中的 key。
- [ ] 关闭受控进程并核对默认 fake/关闭。普通六门禁始终不用真实 key；有源码修复则相关 full gates 针对最终 SHA 重跑。
- [ ] PR 区分普通代码门禁与一次用户授权真实证据，记录其各自 SHA；不得让普通 CI 重跑真实任务。先核对本次发布/合并授权及所有门禁，不套用 B2.1A 的阶段限定合并授权。
- [ ] 报告剩余单样本、业务质量未评、无生产 DB/对象存储/队列/Auth/Workspace/实际账单等限制，停止本任务。

## SELF_REVIEW 核对表

Phase A 仅文档/模拟测试；Task2预算、Task3来源/字段/单Item、Task4入口/CI/完整模拟、Task5唯一真实Create、Task6证据/关闭分别覆盖 Spec。所有后续函数均在各任务 Interfaces 定义，路径均为当前结构；未实现步骤保留未勾选。没有独立代理审查，本阶段审查标记 SELF_REVIEW。
