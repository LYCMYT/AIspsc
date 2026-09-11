# 10｜真实模型小样本评测计划

## 1. 目标

B1.5 的真实模型评测不是为了制造“模型排行榜”，而是回答两个产品问题：

1. **当前候选模型是否真的满足平台定义的任务能力边界？**
2. **第一版真实 Router 应如何做硬能力过滤与候选优先级建议？**

首轮采用严格受控的小样本：

```text
4 个业务 Case × 2 个候选视频模型 = 8 个真实输出
```

候选模型：

- Seedance 2.0
- Kling 3.0

两者在进入真实实验前都必须至少达到 `documented`，并完成 exact API contract 核验；真正发起付费调用前还需要用户明确授权预算。

> 8 条样本只用于探索性产品判断，不用于宣称统计显著的胜率、行业领先、平均提升比例或广告转化效果。

---

## 2. 实验前阻塞门槛

任何真实调用开始前，两个候选都必须分别完成以下核验：

### 2.1 API 身份

必须记录：

- Provider；
- exact API model ID；
- endpoint；
- 官方文档链接；
- 文档检查日期；
- 版本/下线策略（如官方有说明）。

### 2.2 请求能力

必须根据当前平台 `RoutingCapabilitySnapshot` 逐项确认：

- 支持的 TaskType；
- 参考素材数量上限；
- 支持的参考角色；
- duration；
- ratio；
- resolution；
- audio；
- 组合限制。

如果某个 Case 在官方 API 层不支持，则该 Case 对该模型记为 `NOT_SUPPORTED`，**不为了凑满 8 条而偷偷改变任务定义**。

### 2.3 异步语义

必须确认：

- create 请求返回什么；
- 是否返回 externalJobId；
- 如何 query/poll；
- 是否有 callback；
- 是否支持 cancel；
- timeout 后如何判断是否已经受理；
- Provider 是否提供幂等能力。

### 2.4 价格与预算

必须记录官方价格证据或调用前可确定的费用规则。

真实调用执行前，用户需要明确确认一个**总预算上限**。未获得预算授权时，本计划只允许准备输入、Schema 和文档，不允许发起付费 Provider 调用。

### 2.5 数据与隐私

首轮使用公开可展示或自有测试素材，不使用：

- 客户未授权素材；
- 原商业项目机密；
- 未授权真人肖像；
- API Key、签名 URL 或 Provider 内部信息。

---

## 3. 控制变量原则

同一个 Case 的两个模型必须尽量共享相同业务意图：

- 同一 Prompt 语义；
- 同一参考素材；
- 同一目标比例；
- 同一目标时长；
- 同一音频要求；
- 同一审核量表。

如果两个 Provider 的 API 参数无法完全对应：

1. 记录差异；
2. 不伪造“完全同条件”；
3. 只比较真正共同支持的约束；
4. 将 Provider-specific 参数保存到 request evidence 中。

---

## 4. 四个业务 Case

## EV001｜商品图 → 营销视频

### 业务意图

从单张商品图生成一条短营销素材，核心要求是商品主体可见、关键结构稳定，并完成明确的镜头/动作指令。

### 输入角色

```text
product: required
person: none
background: optional
reference_video: none
```

### 建议目标参数

```text
ratio: 9:16
duration: 5s
resolution: 720p
audio: false
```

选择 5 秒 / 720p 是为了控制第一轮实验成本，同时保留商品一致性、动作自然度和时序稳定性判断空间；如果某 Provider 的真实 API 不支持这一组合，则按实际 capability 记录为不可比或调整整个 Case 的共同参数，而不是只改单一模型。

### 核心审核维度

- Q01 商品存在性
- Q02 商品一致性
- Q04 人体/结构完整性（商品结构同样适用）
- Q06 时序稳定性
- Q09 指令遵循度
- Q10 参考素材遵循度
- Q11 投流素材可用性

---

## EV002｜人物 + 商品 → 营销视频

### 业务意图

人物持有、展示或自然使用商品，测试人物、商品及交互结构的跨帧稳定性。

### 输入角色

```text
person: required
product: required
background: optional
reference_video: none
```

### 建议目标参数

```text
ratio: 9:16
duration: 5s
resolution: 720p
audio: false
```

### 核心审核维度

- Q02 商品一致性
- Q03 人物一致性
- Q04 人体/结构完整性
- Q05 动作自然度
- Q06 时序稳定性
- Q09 指令遵循度
- Q10 参考素材遵循度
- Q11 投流素材可用性

### 重点 Bad Case

- 手指/手臂结构错误；
- 手与商品穿插；
- 商品比例漂移；
- 人物身份跨帧变化；
- 商品关键图案/包装变化。

---

## EV003｜参考视频 → 视频

### 业务意图

给定一段合法 5–15 秒参考视频，要求新结果遵循指定动作、构图或运镜关系，而不是复制无关细节。

### 输入角色

```text
reference_video: required
product/person/background: none unless the API contract and Case are explicitly upgraded together
```

### 建议目标参数

```text
ratio: 与参考源兼容的共同目标比例
duration: 5s
resolution: 720p
audio: false
```

### 核心审核维度

- Q05 动作自然度
- Q06 时序稳定性
- Q08 场景正确性
- Q09 指令遵循度
- Q10 参考素材遵循度
- Q11 投流素材可用性

### 评测边界

Q10 只判断 Prompt 明确要求保留的参考关系，不因为没有复制参考视频全部细节而自动扣分。

---

## EV004｜多参考复杂任务

### 业务意图

测试多参考输入是否真正具备业务价值，以及 Router 是否应该把该模型列入 `MULTI_REFERENCE_VIDEO` 候选。

### 首选输入角色

```text
reference_video: required
product: required
person: required
background: optional
```

### 阻塞规则

此 Case **必须先由双方官方 API capability 核验共同交集**。

如果其中一个模型无法通过 API 接受该组合：

- 该模型记录 `NOT_SUPPORTED`；
- 不减少参考素材来制造“同 Case”假象；
- Router 结论直接记录“硬能力不兼容”；
- 剩余预算不自动转成额外随机样本。

### 核心审核维度

- Q01 商品存在性
- Q02 商品一致性
- Q03 人物一致性
- Q04 人体/结构完整性
- Q05 动作自然度
- Q06 时序稳定性
- Q09 指令遵循度
- Q10 参考素材遵循度
- Q11 投流素材可用性

---

## 5. 每一次真实调用必须保存的证据

每个输出对应一个独立 Evaluation Record，至少包含：

```text
experimentId
caseId
candidateModel
provider
apiModelId
providerDocsCheckedAt
startedAt
completedAt

prompt
references[]
normalizedRequest
providerRequestSummary

externalJobId
providerStatusTimeline
platformOutcome

resultMedia
resultSha256
actualDurationMs
width / height / hasAudio

latencyMs
estimatedCost
actualCost
currency
pricingEvidence

review
badCases[]
notes
```

敏感字段禁止进入记录：

- API Key；
- Authorization Header；
- 可复用签名 URL；
- Provider Secret；
- 客户隐私数据。

结构合同见 `contracts/real-evaluation-record.schema.json`。

---

## 6. 审核方法

### 6.1 使用已有 `rubric-v2-rebuild`

不为真实评测重新创造一套指标，继续使用：

- Q01–Q11；
- applicability；
- Hard Failure H01–H03；
- Technical Error；
- 1–10 人工综合分。

### 6.2 审核顺序

```text
检查文件可用性
  ↓
确认任务要求与适用维度
  ↓
检查 Hard Failure / Technical Error
  ↓
标问题标签
  ↓
给 1–10 综合分
  ↓
写原因与 Bad Case
```

### 6.3 不盲审模型名称

首轮目标是产品探索而非发表学术 benchmark，因此可以保留模型身份，方便直接结合 API 能力、成本和时延做 Router 判断。

如果未来要做更公平的视觉偏好比较，再单独设计匿名化双盲版本，不能把本次小样本包装成盲测。

---

## 7. 技术预检

每个真实结果先检查：

- 文件可下载并可解码；
- 实际 duration；
- width / height；
- 音轨是否符合要求；
- SHA-256；
- 本地/对象存储持久化是否成功。

技术预检失败不能通过高人工分掩盖。

---

## 8. 成本控制与停止条件

### 必须停止并检查的情况

任一出现即暂停该模型后续调用：

1. exact API 价格无法确认；
2. 单次预计成本超出已授权预算；
3. Provider 连续出现无法解释的付费失败；
4. 提交状态未知且没有可靠 external job 查询路径；
5. 结果无法安全下载/持久化；
6. 输入素材可能违反授权或隐私边界；
7. API contract 与此前文档理解发生重大变化。

### 不允许的“补样本”行为

- 为了让某模型分数更好而额外生成；
- 因结果不好就无限重试直到得到好结果；
- 隐藏失败调用；
- 把不同 Prompt 的最好结果拿来假装同条件比较。

如发生技术性重试，必须保留 retry 原因和所有付费 Attempt 证据。

---

## 9. 首轮输出不是排行榜，而是 Routing Decision Table

最终报告按任务类型输出：

| Task / Case | Seedance 2.0 | Kling 3.0 | Routing 结论 |
|---|---|---|---|
| Product Image → Video | 实测后填写 | 实测后填写 | 基于 capability + quality + cost + latency |
| Person + Product → Video | 实测后填写 | 实测后填写 | 同上 |
| Reference Video → Video | 实测后填写 | 实测后填写 | 同上 |
| Multi Reference | 实测后填写或 NOT_SUPPORTED | 实测后填写或 NOT_SUPPORTED | 硬能力先过滤 |

表格中的“实测后填写”是实验计划中的未执行状态，不代表任何预设优胜者。

---

## 10. 可以得出的结论

8 条探索性样本完成后，可以讨论：

- 哪些 Case 的 API capability 已验证兼容；
- 哪些 Case 存在明确硬能力缺失；
- 每个模型暴露了哪些典型 Bad Case；
- 哪些输入角色更容易导致一致性问题；
- 当前调用成本与端到端时延；
- 第一版 Router 的硬过滤规则；
- 下一轮最值得增加的样本类型。

## 11. 不能得出的结论

不能声称：

- “模型 A 胜率 X%”；
- “模型 A 比模型 B 提升 X%”；
- “平台审核通过率达到 X%”代表客户真实运营水平；
- “投流素材可用”代表真实广告转化提升；
- 8 条样本可以代表所有商品、人物、场景和 Prompt。

---

## 12. Bad Case 复盘格式

至少保留 1–2 个有代表性的失败案例，而不是只展示最好结果。

每个 Bad Case 记录：

```text
现象
↓
对应 Q 标签 / Hard Failure
↓
业务影响
↓
证据截图/视频时间点
↓
可能原因（区分事实与假设）
↓
下一步动作
  - Prompt 调整？
  - Reference 调整？
  - Provider capability 边界？
  - Router 调整？
  - 需要更多样本验证？
```

不能把“可能原因”写成已证明的模型内部机制。

---

## 13. 执行顺序

```text
官方 API Contract 核验
        ↓
预算授权
        ↓
准备可公开测试素材
        ↓
Provider Smoke Test
        ↓
确认结果持久化与成本记录
        ↓
EV001–EV004
        ↓
逐条 rubric-v2-rebuild 审核
        ↓
Bad Case 复盘
        ↓
Routing Decision Table
        ↓
更新 provider evidence 状态
```

本文件完成只代表“实验合同已定义”。只有真实调用、结果文件、审核与成本证据全部存在时，模型状态才能从 `documented` 向后推进。
