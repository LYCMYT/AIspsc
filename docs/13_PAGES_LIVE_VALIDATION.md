# 13｜线上 Pages 媒体路径回归

## 真实发现

浏览器检查 run `34623278529` 打开 `https://lycmyt.github.io/AIspsc/`，HTTP 200 且应用标题正常，但页面出现“演示媒体清单不可用”，演示额度为 `—`。

Network 记录 `/demo/MEDIA_MANIFEST.json` 返回 404。问题不是 GitHub Pages 设置，而是 MockPlatform 把资源 URL 写成了站点根路径。Router/Vite base 正确不代表运行时 fetch 自动正确。

## 最小修复

- 保留 MockPlatform 核心生成、额度、审核与拆解逻辑。
- 新增 `createDemoFetcher(basePath)`，只重写 `/demo/` 前缀的 string 请求。
- 在 web composition root 注入 `import.meta.env.BASE_URL`。
- 本地 `/` 行为不变；Pages `/AIspsc/` 下请求变为 `/AIspsc/demo/...`。
- 不重写其他 API、外部 URL、Blob URL、已加前缀 URL 或 Request 对象；透传 signal/cache 等选项。
- 共享包不直接依赖 Vite 或浏览器 location。

## 验证

6 个新增回归测试覆盖媒体清单、视频/片段、本地根路径、不重复前缀、请求参数透传和 Request 对象。

测试先在未适配的实现上出现 3 项失败，适配后 6 项通过。最终还需完整 `pnpm verify`、E2E，以及部署后用全新浏览器再次确认媒体请求不再 404、演示额度和素材成功初始化。

先前 run 的成功只说明浏览器检查脚本执行成功，不说明产品健康；必须阅读报告内容，不能只看 Actions 绿色图标。
