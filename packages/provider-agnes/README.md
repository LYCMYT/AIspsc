# Agnes Video Provider Adapter

这是 AIspsc 的独立服务端 Provider 接入模块，不被在线 B1 浏览器页面调用。

## 已实测状态

文生视频和单图片生视频均完成真实创建/查询/下载/哈希校验/全片解码。`smoke_tested` 仅指技术验证，**产品真实路由仍禁用**。

两条结果均为 1280×704、约 5.04 秒、含 AAC 音轨；请求为 1280×720 / 16:9 / audio=false。请求参数被接受不代表输出满足产品要求。详见 `docs/12_AGNES_SMOKE_RECOVERY.md`。

## 安全运行

`AGNES_API_KEY` 只通过运行进程环境或 GitHub Secret 提供，不放入浏览器、VITE 变量、源码或命令示例的真实值。

默认是恢复模式，**不会在缺少参数时偷偷创建任务**：

```sh
AGNES_SMOKE_MODE=recover AGNES_EXISTING_VIDEO_ID='<saved-video-id>' pnpm smoke:agnes
```

已明确确认价格和额度后，单条新测试需要显式授权：

```sh
AGNES_SMOKE_MODE=text AGNES_ALLOW_CREATE=1 pnpm smoke:agnes
AGNES_SMOKE_MODE=image AGNES_ALLOW_CREATE=1 pnpm smoke:agnes
```

上述命令均要求已安全注入 `AGNES_API_KEY`。图片模式只使用固定哈希的自有测试图，不接受任意客户输入。

GitHub 的 `agnes-smoke` workflow 同样默认 recover，选择 text/image 时必须勾选新建授权。普通 push/PR 不执行真实生成。不要重跑失败的创建任务；从 smoke.json 取原 ID 执行恢复。

证据目录 `artifacts/agnes-smoke/` 被 Git 忽略。结果地址与原始错误不写入报告；实际成本未返回时记录 null，不猜测账单。
