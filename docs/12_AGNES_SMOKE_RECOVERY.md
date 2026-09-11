# 12｜Agnes 实测故障与恢复

## 事实与根因

首次真实测试：Actions run `34620475819`，基线 `c130a35cc49214343f7685411c628d89356798e8`。
认证、创建和轮询已成功；Provider 返回 `completed`，但旧脚本未取得下载地址并退出。此时不能把“文件下载失败”说成“模型生成失败”，也不能重新 POST。

只读诊断：Actions run `34620909648`。仅查询已有任务，没有新生成。返回结构的脱敏检查确认：推荐 `/agnesapi` 接口的实际结果地址在顶层 `url`；模型文档示例使用 `metadata.url`。顶层 `id` 也不能当成原始 opaque `video_id` 随意替换。

官方文档：
- https://www.agnes-ai.com/zh-Hans/docs/overview
- https://agnes-ai.com/en/docs/agnes-video-v20

## 本轮执行范围

1. 兼容文档 envelope 与真实 flat response；仅从已确认的两个路径取结果，不递归搜任意 URL。
2. 始终保留创建/用户提供的原始查询 ID。
3. 将 smoke 拆成可测试的流程；`recover` 只能 GET，绝不重新生成。
4. 创建前保存提交意图，拿到 ID 后立即保存，轮询/下载失败仍保留恢复依据。
5. Provider `completed` 后无地址继续有界查询；视频完成与本地文件校验成功分开。
6. 下载仅允许文档中的 HTTPS 输出域名，无密钥/无跳转，128 MiB 上限；验证 MIME、MP4 容器、ffprobe 元数据与 FFmpeg 全片解码。
7. 默认手动流程为 recover；新建 text/image 必须显式勾选授权，单次至多一条。
8. image 模式只使用仓库自生成几何测试图：校验本地与固定提交公开 URL 的 SHA-256。不是客户素材，也不是商业评测样本。
9. 不修改 B1 浏览器 MockPlatform，不开放公网付费生成，不升级 runtime eligibility。

## 验证要求

- 回归测试：真实顶层 URL、文档 metadata URL、空值回退、原始 ID、错误脱敏。
- 流程测试：零 POST 恢复、未授权创建拦截、缺地址有界查询、下载失败保留 ID、未知提交不自动重试。
- 媒体验证：非可信 URL、伪装为 200 的 HTML、超大/空响应、无视频流、实际音轨与尺寸。
- 最终以当前提交的 GitHub Actions `pnpm verify` 和完整 E2E 为准。

## 证据口径

`artifacts/agnes-smoke/smoke.json` version 2 记录 operation、phase、outcome、newTaskSubmissions、externalVideoId、时间线、Provider 报告、实际文件信息。签名 URL、密钥和原始错误不写入证据。

`operationLatencyMs` 在 recover 中仅表示本次恢复耗时，绝不能冒充生成耗时。恢复记录不凭空补原请求；需与首次创建 run 的证据关联。

`actualCostUsd=null` 表示 API 未返回实际账单，不把网站展示的当前零价格伪装成已核对账单。

即使技术 smoke 成功，也不等于通过 11 维业务质量审核、不等于 Seedance/Kling 横评、不等于正式接入产品真实 Router。
