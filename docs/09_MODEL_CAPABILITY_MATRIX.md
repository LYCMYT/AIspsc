# 09｜模型能力证据矩阵

## 原则

知道模型名称、阅读文档、完成一次技术调用、完成业务评测与正式接入产品是不同层次。`contracts/model-registry.json` 中真实绑定继续 disabled / unverified；研究证据不会直接开启真实 Router。

```text
unverified → documented → smoke_tested → evaluated → integrated
```

| 状态 | 含义 | 不能自动推出 |
|---|---|---|
| unverified | 只有逻辑候选，缺少充分来源 | 当前 API 可用 |
| documented | 有模型厂商/Provider 文档证据 | 本仓库已调用、已计费验证 |
| smoke_tested | 有真实请求、任务、输出或失败链路的技术记录 | 全参数保证、质量合格、生产接入 |
| evaluated | 有业务 Case、结果、审核、成本与归因证据 | 全场景生产稳定 |
| integrated | Adapter、平台状态、安全、持久化、额度与集成验收均满足 | 无需继续监测 |

证据有多个维度：`smoke_tested` 也可能暴露产品不符合项。实际费用未知须保留 null，不能靠当前网页标价补造账单；费用未核验继续阻塞 production-like routing。

## 当前状态

| 逻辑模型 | 证据状态 | 已有依据 / 仍待核验 |
|---|---|---|
| Seedance 2.0 | documented | BytePlus ModelArk 官方文档；本项目 exact binding、参数组合与真实调用待核验 |
| Seedance 2.0 Mini | unverified | 精确 Mini 产品/API 身份待核验 |
| Kling 3.0 | documented | 官方 VIDEO 3.0 产品指南；不等于 developer API binding 已验证 |
| Kling 2.0 | unverified | 当前接口合同待核验 |
| image2.0 | unverified | 历史逻辑名称保留，Provider 身份待确认 |
| Seedream 5.0 | unverified | 本阶段未详细验证图片 API 能力 |
| Qwen-Image 2.0 | unverified | 本阶段未详细验证图片 API 能力 |
| DeepSeek V4 | unverified | 当前模型与 Provider/API 身份待核验 |
| Agnes Video V2.0 | smoke_tested（技术） | 文生/单图生视频真实文件与恢复已验证；尺寸/比例/音轨不符合产品请求，真实路由禁用 |

此前各候选研究来源保留在 `contracts/provider-capability-evidence.json`；Agnes 的最新独立证据与允许范围保存在 `contracts/agnes-video-v20.binding-candidate.json`，完整实测见 `12_AGNES_SMOKE_RECOVERY.md`。

## Agnes：请求子集不是输出保证

已完成技术测试：TEXT_TO_VIDEO、单图片 IMAGE_GUIDED_VIDEO；目标5秒/横版/720p。

两个实际文件都为 **1280×704、约5.04秒、含AAC音轨**。不能声称它已经保证1280×720、精确16:9或无音频。10秒、竖版、方图、1080p尚未实测；参考视频、多参考和可控原生音频仍不声明。

`runtimeEligible=false`，也不改前台为模型选择器。技术成功与产品验收分开。

## 已记录的来源

- Seedance 2.0：
  - https://docs.byteplus.com/en/docs/ModelArk/Video_Generation_API
  - https://docs.byteplus.com/en/docs/ModelArk/2222480
  - https://docs.byteplus.com/en/docs/ModelArk/2291680
- Kling 3.0：
  - https://app.klingai.com/cn/quickstart/klingai-video-3-model-user-guide
- Agnes：
  - https://www.agnes-ai.com/zh-Hans/docs/overview
  - https://agnes-ai.com/doc/agnes-video-v20
  - 本仓库 Actions run 34620475819、34620909648、34622707888、34622911598、34623208051。

厂商产品指南仅支持对应指南里的主张，不代替精确 API 实测。文档和真实响应冲突时，保留差异并写回合同，而非隐藏。

## 进入真实 Router 的阻塞门槛

必须分别验证 Provider/exact model ID、请求 Schema、任务类型、参考角色/数量、时长/比例/分辨率/音频与组合限制、异步创建/查询/取消语义、错误归一化、输出持久化、实际费用、技术 smoke、业务评测、安全与授权。

输出流程应是：Provider 完成 → 下载 → 文件与参数校验 → 平台持久化 → succeeded。不能仅凭一个外部 URL 或 completed 字符串跳过 finalizing。

创建请求不确定时保留原任务并对账，不自动重复提交可能消耗费用的请求。未知取消能力不能伪造。

## 与原4×2评测的关系

`10_REAL_EVALUATION_PLAN.md` 仍规划4类业务任务×Seedance 2.0/Kling 3.0，费用与能力前置核验，不为凑8条私自改变任务。

Agnes 自有几何测试不是这一商业评测集。没有覆盖的能力记未测/不支持，不把两个技术样本写成质量排行榜或广告效果数据。

## 安全规则

不提交 Key、不在浏览器保存 Key、不使用 VITE 变量传 Provider Key、不把研究 evidence 文件直接变成执行路由、不把一次成功自动升级 integrated、不把网页零价格当成真实账单。
