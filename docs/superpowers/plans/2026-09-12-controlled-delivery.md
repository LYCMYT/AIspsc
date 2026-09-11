# Controlled Media Delivery Implementation Plan

> **For agentic workers:** Use executing-plans; continue the already authorized next phase.

**Goal:** 将真实结果后处理为可验收文件，并提供本机受控交付 API。
**Architecture:** 独立 media-processing + delivery-workbench；复用既有人工审核函数，不改变 B1 MockPlatform。
**Tech Stack:** Node24、TypeScript、Vitest、FFmpeg/ffprobe，无新增npm依赖。
**Spec:** docs/superpowers/specs/2026-09-12-controlled-delivery.md

## Global Constraints

零新增Provider请求；原文件不可修改；人工审核和显式入库分离；本地模式不冒充生产系统；密钥不进入前端/文件/日志。

### Task 1: 可追踪媒体后处理
- [x] 在 packages/media-processing/src/policy.test.ts 写尺寸、尾差、静音、错误参数断言；delivery.integration.test.ts 写真实转码、源哈希、拒绝覆盖断言。
- [x] `node node_modules/vitest/vitest.mjs run` 确認 RED。
- [x] 新建 policy.ts 与 processor.ts，导出 validateTarget、planDelivery、probeVideo、processDelivery。返回 source/result/policy/transformations/report 哈希证据，不含绝对路径。
- [x] 重跑测试，GREEN；对已存在的两条 Agnes MP4 实测。

### Task 2: 本机受控历史和审核闭环
- [x] 在 packages/delivery-workbench/src/workbench.integration.test.ts 写导入→后处理→未审禁止保存→审核→手动保存→改判撤销和重启断言。
- [x] 新建 store.ts，序列化写入、独占锁、原子JSON、版本/幂等保护；复用 decideReview。
- [x] 新建 server.ts 与 CLI，认证、Host/Origin、请求大小、原始上传及认证下载；不提供Provider生成接口。
- [x] 重跑真实HTTP/FFmpeg集成用例，GREEN。

### Task 3: 发布验证和操作说明
- [x] package.json/vitest.config.ts 注册测试与本地启动命令；新增独立delivery CI。
- [x] 完成13号交付说明、API示例、单进程/重启限制与真实后处理报告。
- [x] 删除临时dev-snapshot-once workflow；审查diff与秘密扫描。
- [ ] lint、typecheck、148条旧unit+新unit、28条contracts、媒体/API集成、build、原74条E2E全部复验后才合并。
