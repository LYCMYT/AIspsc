# 03｜领域数据与状态合同

类型是 B1 模拟服务与 B2 API 的共享逻辑合同，UI 不能再自定义第二套字段。
时间均为 ISO UTC；视频区间采用整数毫秒、半开区间 [startMs,endMs)；额度用非负整数，不用浮点货币。

## 最小实体

| 实体 | 关键字段与约束 |
|---|---|
| Workspace/User/Membership | B2 需要；workspaceId 来自已认证上下文，不能信任前端自行提交的租户身份 |
| MediaFile | id, workspaceId, mediaType, mime, byteSize, width?, height?, durationMs?, objectKey/blobKey, sha256, availability |
| Asset | id, mediaFileId/text, source(upload/generated/fixture), originItemId?, reviewId?, title, tags, archivedAt? |
| GenerationBatch | id, requestSnapshot, requestedCount, idempotencyKey, requestHash, createdAt |
| GenerationItem | id, batchId, index, status, resultMediaId/text?, errorCode?, retryOfItemId?, routingSnapshot, pricingSnapshot |
| ProviderAttempt | itemId, attemptNo, providerBindingId, externalJobId?, externalIdempotencyKey, submissionState, timestamps |
| Evaluation | id, itemId, rubricVersion, score, applicability, issueTags, hardFailures, decision, reviewerId, createdAt |
| SplitJob/Clip | sourceMediaId, mode, sourceDurationMs, ruleVersion, intervals; clip 含 startMs/endMs/actualDurationMs/mediaFileId? |
| CreditReservation/Ledger | itemId, reservedUnits, finalState；流水 GRANT/RESERVE/COMMIT/RELEASE，referenceId 唯一约束 |
| OutboxEvent/AuditEvent | B2 中同事务出站事件；操作人、实体、请求 ID、事件时间；日志不能泄露密钥 |

## 生成请求逻辑结构

```ts
interface CreateGenerationRequest {
  mode: 'video' | 'image' | 'copy';
  prompt: string;
  references: { assetId: string; role: 'product'|'person'|'background'|'reference_video' }[];
  count: number; // 1..4，本次重建政策
  video?: { durationSeconds: number; ratio: '9:16'|'16:9'|'1:1'; resolution: '720p'|'1080p'; audio: boolean };
  image?: { ratio: '9:16'|'16:9'|'1:1'; resolution: string };
  copy?: { language: 'zh-CN'; maxCharacters: number };
}
```
请求中没有 modelId 和 referenceStrength；收到这两个字段应按严格 Schema 拒绝，不忽略后继续提交。
引用必须存在、可用、属于当前 workspace、媒体类型与角色一致。参数对象严格随 mode 区分，不用 Record<string,any> 吞掉非法字段。

## 子任务状态

`queued → running → finalizing → succeeded`

允许分支：queued→cancelled；running→failed；running/finalizing→needs_reconciliation；running→cancel_requested→cancelled 或继续收敛到已有成功结果。

- succeeded/failed/cancelled 是确定终态；同一终态重复事件无副作用。
- needs_reconciliation 表示外部是否受理/完成未知，不等于失败，不自动再次创建付费任务。
- 用户主动重生成创建新 item，保留 retryOfItemId；技术重试不伪造用户新的意图。
- finalizing 表示外部已产出但本地文件持久化/校验未完成；此时不能审核入库。
- B1 通过持久化 dueAt/outcome/scenario 恢复模拟任务；组件卸载不得丢失任务推进。

批次状态由子项计算：全部成功=succeeded；仍有活动项=running；所有终态且成功数介于 0 与 N=partial_succeeded；零成功则按失败/取消组合展示。

## 两个独立状态轴

审核：pending → approved/rejected；已保存审核保留版本，不能通过重新打开表单默默覆盖。
资产：not_saved → saved；仅 approved 的成功子项可转 saved，唯一约束 originItemId。

## 持久化

B1：IndexedDB 保存 Blob 和版本化业务快照；localStorage 只存轻量 UI 偏好。不把 blob: URL 当耐久数据。
恢复页面后从 Blob 重新 createObjectURL，组件释放时 revoke；文件缺失进入明确恢复态。
重置 Demo 只清本应用命名空间，经确认执行；不调用 localStorage.clear() 清空其他应用数据。

B2：PostgreSQL 保存权威状态，对象存储保存媒体，前端只保存短期缓存。真实配额与审批必须由服务端强制。

## 统一端口与函数名称（T01 建立 TypeScript 定义，后续不得各写一套）

| 导出 | 输入 | 输出 / 语义 |
|---|---|---|
| validateGenerationRequest | unknown + 当前工作区可用素材索引 | 合法 CreateGenerationRequest 或带 field/code 的验证错误；先结构后素材权限 |
| classifyTask | 已验证请求 | 六类 TaskType 之一；严格按 04 文档优先级 |
| selectBinding | 已验证请求、TaskType、注册表、mock/real 环境 | RoutingDecision 或 NO_COMPATIBLE_MODEL；不修改请求 |
| planSequentialSplit / planAverageSplit | 正整数 durationMs | `{startMs:number,endMs:number}[]`；下限及舍入按 05 |
| planSceneSplit | durationMs + 排好序的 sceneCutMs 数组 | 原始 sceneRanges 与去重后参考 intervals，含扩展说明 |
| validateManualIntervals | durationMs + interval 数组 | 合法区间或 INVALID_INTERVAL；不静默修正 |
| decideReview | 成功子项、视频评审或图片/文案基础评审 | approved/rejected 与原因；仅作判定、不创建资产 |
| deriveBatchStatus | 非空子任务数组 | queued/running/needs_reconciliation/succeeded/partial_succeeded/failed/cancelled |
| GenerationService.create/get/cancel/retry | 严格请求或任务ID；create 含幂等 key | 批次/子项快照；无直接 Provider key |
| ReviewService.save | itemId、rubricVersion、审核表单 | 不可变 Evaluation；不隐式入库 |
| AssetService.saveApprovedOutput | itemId、evaluationId | 幂等 Asset；检查最新有效审核 |
| MediaStore.put/get/remove | Blob + 元数据或 mediaId | 可持久化媒体记录；get 返回 Blob，不保存短命 URL |

T01 在共享包导出精确 TS 类型及 Result 判别联合；UI 引入而非复制。验证错误统一使用 `{code,message,field?}`。
原始请求必须先按 JSON Schema 校验，随后检查同一素材角色最多一个、assetId 存在、媒体类别匹配和所属工作区；后四者属于语义验证，不冒充纯 Schema 已验证。

## 状态补充与竞态约束

- queued 可因调度前校验/不可恢复错误转 failed；finalizing 可在已确认不可恢复且已对账后转 failed。
- needs_reconciliation 是可恢复非终态，对账后可转 running/finalizing/succeeded/failed/cancelled；没有外部证据不任意改判。
- cancel_requested 可收到既有结果，走 finalizing→succeeded，或收到确认取消→cancelled；先到的终态不被旧事件覆盖。
- 批次：全 queued 为 queued；仍有 running/finalizing/cancel_requested/queued 为 running（全 queued 情况除外）；无这类活动项但仍有未知项为 needs_reconciliation；全成功为 succeeded；均确定终态且有成功也有非成功为 partial_succeeded；零成功且任意 failed 为 failed；全 cancelled 为 cancelled。
- 每次迁移原子比较 version/当前状态。取消/成功竞争、重复终态必须先通过同一事务或浏览器事务门禁。
- 已入库结果被新审核改判 rejected：保留旧审核与资产记录，资产标记 review_invalidated，禁用新的复用并提示；不继续把旧 approved 当作永久通行证。
