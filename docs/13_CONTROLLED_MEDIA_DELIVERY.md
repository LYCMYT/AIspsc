# 13｜真实视频后处理与本地交付验收台

## 本阶段交付

新增 `packages/media-processing` 和 `packages/delivery-workbench`，不替换在线 B1 `MockPlatform`。

真实 Agnes 原文件已用于离线验证，零新增模型请求。两个原文件都是1280×704、121帧、约5.041667秒、含AAC音轨；经过规则`delivery-v1`后，分别得到1280×720、120帧、精确5秒、无音轨的独立衍生文件。原文件SHA-256保持不变。

这证明平台后处理可以完成本次文件规格验收，**不证明Agnes原生参数完全遵循、不证明营销质量评测通过，也不把Provider升级为integrated**。

## 媒体策略和证据

等比例适配并居中补黑边，不裁切商品，不强行拉伸；本次两条1280×704视频上下各补8像素。去掉音轨，统一24fps，仅裁掉100ms以内编码尾差。本次裁掉最后1帧。短于目标的素材不补帧凑时长，明显超长素材不自动截断，应走剪辑流程。

输出时长支持5–15秒整数，比例16:9/9:16/1:1，规格720p/1080p；此阶段只接受audio=false。其他组合明确拒绝。升采样或补边不叫画质提升，重新编码也不保证文件更小。

每次处理在一个新目录中生成：

```text
new-derivative/
  result.mp4
  delivery.json
```

`delivery.json`包含源/衍生文件哈希、实际媒体信息、目标规格、执行步骤、规则版本、编码器版本、时间和`businessReview=pending`。没有绝对路径、凭据或Provider结果地址。

FFmpeg以参数数组执行，无shell，输入强制MP4 demuxer、禁用网络协议、限定文件大小和执行时长。输入完整解码；输出再次探测和全片解码，验证帧数、时长、尺寸、像素比例和无音轨后才写成已完成结果。失败清理本次独占目录，不覆盖旧目录。

## 启动方法（本机）

沿用仓库 Node24.19.x + pnpm12.3.4；还需在PATH中安装FFmpeg和ffprobe。

```sh
pnpm install --frozen-lockfile
pnpm delivery:serve
```

打开终端输出的本机网址，默认`http://127.0.0.1:8787`，把终端显示的**本地操作令牌**填入验收台。这是随机生成的本机访问令牌，**不是Agnes密钥**。浏览器只在内存保存，不写localStorage、sessionStorage、Cookie或URL。

操作顺序：填写原任务提示词→导入已有MP4→历史→显式后处理→观看并填写11维人工审核→审核通过→再手动保存到资产库。

本地UI默认5秒/16:9/720p静音；其他已支持目标可通过API或CLI指定。浏览器导入来源标记为`operator_import`，不会凭上传文件就声称是本系统实时生成。原始文件只读保存。真实模型测试的来源通过原文件哈希与12号报告核对。

独立处理命令：

```sh
pnpm delivery:process "source.mp4" "new-output-directory" 5 16:9 720p
```

可选环境变量：`AISPSC_PORT`、`AISPSC_DATA_DIR`、`AISPSC_OPERATOR_TOKEN`。不设置token则启动时生成；设置时需32–512个可打印ASCII字符。**不需要、不读取AGNES_API_KEY**。默认数据目录`artifacts/local-delivery`已被Git忽略，勿改到公开目录。

## API合同

除健康检查和静态页面外，所有接口要求`Authorization: Bearer <本地令牌>`，所有写接口要求`Idempotency-Key`（1–100位字母数字、下划线或短横线）。不接受URL令牌、跨源Origin、错误Host；不配置开放CORS。

| 方法与路径 | 语义 |
|---|---|
| GET /health | 本地模式及Provider调用关闭状态，不返回数据或凭据 |
| POST /v1/tasks/import | `Content-Type: video/mp4`原始文件体，`X-Task-Prompt`为encodeURIComponent后的提示词；不接受文件路径或远程URL |
| GET /v1/tasks | 历史和当前交付状态 |
| GET /v1/tasks/{id} | 当前任务版本、原始哈希、衍生证据和审核历史 |
| POST /v1/tasks/{id}/postprocess | `{expectedVersion,target:{durationSeconds,ratio,resolution,audio:false}}`；202受理，后台单并发本地FFmpeg处理 |
| POST /v1/tasks/{id}/reviews | `{expectedVersion,form,reason}`，form复用rubric-v2-rebuild；第二次起必须有改判原因 |
| POST /v1/tasks/{id}/assets | `{expectedVersion}`；审核通过后显式入库 |
| GET /v1/tasks/{id}/result | 已完成衍生结果，供人工审阅；不等于已批准资产 |
| GET /v1/assets | 包括审核失效状态的资产历史 |
| GET /v1/assets/{id}/file | 必须仍绑定有效审核和当前结果哈希，否则409 |
| GET /v1/audit | 本地操作审计 |

新生成接口不提供，`/v1/generate`返回404。版本冲突409，缺少授权401，非法输入400，超限413，不兼容时长422。相同幂等键重放相同请求不会重新转码/重复入库；同键不同请求409。

## 审核不是另造一套简化规则

调用既有`packages/domain/src/review.ts`的`decideReview`。完整11维适用性、N/A原因、问题标签、H01/H02/H03和技术错误均保留。7分阈值仍仅是既有公开重建规则，不宣称有真实大样本校准。

审核绑定当前衍生文件SHA-256；技术结果合格也必须人工评分。高分不能覆盖适用硬失败。修改审核立即使已入库资产失效；再次批准也不会自动恢复旧资产，必须再次手动保存。

新后处理版本会使原审核/资产失效。处理中、失败或中断时不会把旧衍生结果冒充新结果下载。源文件和已有衍生目录保留，不通过覆盖修改历史。

## 持久化与安全边界

本机、单操作人、单进程写入；数据写操作串行，JSON临时文件fsync后原子替换，独占`.lock`防止两个进程写同一目录。正常关闭先收尾处理。重启时将遗留processing标记interrupted，不自动再次处理，更不调用模型。

异常退出可能留下`.lock`：**确认原进程已退出后**才能删除该目录下的`.lock`再启动；不要同时运行两份服务。损坏的state.json拒绝启动，不静默清空数据。建议停机后备份整个数据目录，不只备份JSON。

这是开发/验收工具，不是云生产后端。它不提供多租户隔离、登录会话体系、权限分级、PostgreSQL事务、队列集群或对象存储；不保证断电后的分布式恢复，不承诺防御有本机文件写权限的攻击者。不要通过反向代理或公网隧道开放本服务。每任务最多100次审核、最多200个导入任务，超过容量应归档或开始新的验收目录。

## 自动验证

```sh
pnpm verify
pnpm test:delivery
pnpm test:delivery:ui
pnpm test:e2e
```

`test:delivery`运行真实FFmpeg和本机HTTP集成；`test:delivery:ui`运行真实Chromium浏览器闭环；这些测试使用自生成几何夹具，测试中的人工分数是合成断言，不是对真实商业素材打分。专用delivery workflow安装FFmpeg和Chromium，不读取Provider Secret。

本次实测输出哈希（FFmpeg7.1.5；不同编码器版本不保证字节相同）：

| 文件 | SHA-256 |
|---|---|
| T2V原始 | 9f4507fdc3c313621c0a2e7b238cd4d80d3e9656094ce8640dbded3bafa680f9 |
| T2V交付 | 9a5fc7ac9c1a745669464b9b8af97e64de98fb2dbdaf4d4f31c4f72795de7151 |
| I2V原始 | fba567db1a978c5e32611b3a2d585daf7b25507547cbd92c2cea7890cb874653 |
| I2V交付 | 70944c9f0be15cf14e6d6a6773944438394f7d062c90cbb228bd9d696044e540 |

## 下一道门槛

公开站仍是B1模拟；本机验收台不是公开站已接真实Provider。进入联网的正式真实任务服务前，还需受控账号/Workspace、持久化任务队列、对象存储、Provider费用和幂等对账，以及真实业务样本评测。
