# 11｜Agnes Provider 接入说明

> 最新状态：文生视频与单图片生视频已完成真实技术验证；参数符合性仍阻塞，不能进入产品真实路由。实测文件、哈希、运行记录和故障恢复见 [12_AGNES_SMOKE_RECOVERY.md](12_AGNES_SMOKE_RECOVERY.md)。

## 目标与架构

保持 B1 浏览器 `MockPlatform`，用独立服务端模块验证 Provider 鉴权、异步创建/查询、结果持久化及错误处理。此模块不是已经部署的 HTTP 后端。

```text
手动/受控测试 → AgnesVideoClient → 异步视频任务
                               ↓
                         原 video_id 查询
                               ↓
                         下载并检查文件
                               ↓
                         脱敏技术证据
```

## 文档与接口

官方文档：
- https://www.agnes-ai.com/zh-Hans/docs/overview
- https://agnes-ai.com/doc/agnes-video-v20

模型为 `agnes-video-v2.0`；服务为 `https://apihub.agnes-ai.com`。
创建用 `POST /v1/videos`；推荐查询用 `GET /agnesapi?video_id=<VIDEO_ID>&model_name=agnes-video-v2.0`。
鉴权为 `Authorization: Bearer <API_KEY>`，只用于 API 网关，不用于下载媒体。

Provider 状态 queued / in_progress / completed / failed 分别映射排队、执行中、Provider 完成与失败；未知状态为 needs_reconciliation。Provider 完成后，文件下载与校验仍可能失败，不能直接视为产品已交付。

## 已验证的真实响应差异

文档示例结果地址在 `metadata.url`，实测推荐接口返回顶层 `url`。仅兼容这两个明确路径，不从任意嵌套对象中猜结果地址。

查询响应里的 id 与原始 opaque video_id 可能不同。原始查询 ID 不得被覆盖；已完成任务用原 ID 恢复，无需重新生成。

输出下载域名精确限制为文档中的 `platform-outputs.agnes-ai.space` 与实测确认的 `cos-platform-outputs.agnes-ai.cn`。保留 HTTPS、无凭据、禁止跳转、大小上限及媒体检查。

## 请求预设与输出保证必须分开

Adapter 接受文生视频或一个公开图片 URL；不声明参考视频和产品/人物/背景多参考组合。

请求预设为 5/10 秒，16:9/9:16/1:1，720p/1080p。5/10 秒分别映射121/241帧、24 fps；它们是约数，不代表精确整数时长。模型文档规定帧数不超过441且为8n+1。

**实际只验证了5秒、横版、720p请求。** 10秒、竖版、方图和1080p尚未实测。

两条技术样本都返回1280×704、121帧、24 fps，且存在AAC音轨。此前“没有音频请求参数，所以输出无音频”的解释需要纠正：没有可用控制项不等于输出无音轨。

`audio=true` 仍被当前 Adapter 拒绝，因为未实现可验证的音频控制；`audio=false` 也不能被当作 Provider 无音轨保证。进入真实产品前，需要显式去音轨/尺寸适配策略并复验，不应暗中拉伸、裁剪或丢弃原文件。

## 密钥与执行门槛

`AGNES_API_KEY` 由进程环境或 GitHub Repository Secret 注入。禁止进入 Vue、VITE 变量、Git、文档真实值、截图、日志和评测记录。

GitHub 配置位置：Settings → Secrets and variables → Actions。使用 Secret，不是普通 Variable。泄露过的密钥应轮换；不要通过聊天再次传递。

`agnes-smoke` 为手动 workflow；默认 recover，必须给出原任务 ID。新建 text/image 需要单独勾选授权，每次最多一个固定测试任务。恢复流程绝不 POST；创建超时/5xx 不自动重提。

## 可靠性与证据

- 创建前写入提交意图，获取 ID 后立即持久化。
- 查询、下载失败后保留原 ID 与阶段，方便恢复。
- Provider completed 但地址暂缺时，进行有界查询，不再次生成。
- 下载检查 MIME、128 MiB 上限、MP4 文件头、ffprobe 元数据、FFmpeg 全片解码和 SHA-256。
- 只保存安全错误码，不把可能带密钥/签名 URL 的原始异常挂到公开日志。
- smoke.json 记录实际文件尺寸/时长/音轨，不复写请求参数充当事实。
- recover 的 operationLatencyMs 只表示本次恢复耗时，不是原始生成耗时。
- API 未给账单时 actualCostUsd 保留 null；网站当前价格不等于已核实实际账单。

## 当前门槛

Agnes 为 `smoke_tested`（技术链路），不是 `evaluated` 或 `integrated`；候选 binding 的 `runtimeEligible=false`。

进入真实路由前还需要：输出参数规范化及验收、更多组合实测、实际成本证据、业务质量审核、服务端状态/文件持久化、访问控制和 Workspace 隔离。

Agnes 不替代原 Seedance 2.0 / Kling 3.0 的4×2评测。自有几何测试只验证技术链路，不能用于宣传原商业系统通过率、投流效果或模型质量领先。
