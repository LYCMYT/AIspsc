# 08｜验收与证据

不能只检查“页面上存在文字”；必须检查被用户确认的业务行为。
以下测试是本包规定的待实现验收，不是本次已运行结果。测试向量见 `fixtures/acceptance-cases.json`。

## B0

读齐事实/新设计/未确认项；生成 ADR、依赖锁定策略、五路由清单、共享 Schema；真实模型绑定全部 unverified/disabled。
当前准备包只能通过文件/引用/JSON 结构检查；没有应用代码就不能标记 app build/test=PASS。

## B1 阻塞验收

| ID | 必须证明的结果 |
|---|---|
| A01 | 空白 Prompt 即使有素材仍拒绝；不产生任务、不扣额度 |
| A02 | 五个入口为真实路由；无前台 model/reference strength 控件 |
| A03 | duration=4/16 拒绝，5/15 接受；严格模式参数互斥 |
| A04 | 按字段互斥地得到 6 类任务；无支持模型时拒绝，不默默降级 |
| A05 | count=3 产生 3 个子项，2 成 1 败显示部分成功，审核逐条进行 |
| A06 | 生成完成自动出现历史，资产不增加；approved 后仍不自动增加 |
| A07 | 点击入库创建 1 条资产；重复点击仍是 1 条；pending/rejected 均拒绝 |
| A08 | 7 分+硬失败仍拒绝；无人物=N/A；背景任务不因无商品硬失败 |
| A09 | 顺序/平均/手动区间通过 fixtures 边界；未渲染切片不出现假下载 |
| A10 | 场景 fixture 只能绑定其源视频；未知上传不展示伪造语义分析/标签 |
| A11 | Blob 刷新/重开后可恢复；被清除文件显示恢复提示，无假成功 |
| A12 | 生成中刷新后能恢复到确定结果；模拟任务不因组件卸载永久挂起 |
| A13 | 双击、网络重发、重复终态不会重复扣/退；不足额度时任务数不增加 |
| A14 | 未调用外部 Provider；模拟标识在结果、额度、分析样例中可见 |
| A15 | 真 DOM、真实媒体预览；结果文件类型正确，文案可复制，按钮不只弹无关 Toast |
| A16 | 1672/1440/1280 三档；表单、抽屉、非空列表、审核、异常态无裁切 |
| A17 | icon label、键盘焦点、Esc、弹层焦点返回；状态不只用颜色表达 |
| A18 | 重置前确认，仅清本应用命名空间；seed/empty/scenario 可确定复现 |
| A19 | 失效 assetId、缺文件、非法格式、存储不足均有错误码与恢复路径 |
| A20 | 请求/路由/结果/评审/额度快照关联可追踪；不把模拟统计当运营指标 |

## B2/B3 额外阻塞验收

- API 角色权限和跨工作区 IDOR 拒绝；文件写入/读取范围受控。
- 真实 FFmpeg 对任意合法视频产出可解码的区间文件；5/15 秒边界及无音频/旋转/变帧率样本通过。
- 数据库事务、幂等、账本恒等式、重复消息、存储失败重试及超时对账通过真实依赖集成测试。
- Provider capabilities/binding 有证据；真实 paid call 有用户预算授权、调用记录、结果与计费对账。
- 验收环境/数据与演示环境隔离；真实密钥不进入前端、日志、截图或仓库。

## 计划中的标准命令

项目脚手架完成后提供以下 pnpm workspace 脚本；脚本不得通过 echo/跳过测试冒充成功：

```sh
pnpm lint
pnpm typecheck
pnpm test:unit
pnpm test:contracts
pnpm build
pnpm test:e2e
pnpm capture
pnpm verify
```

verify 串联 lint/typecheck/unit/contracts/build；e2e/capture 在可用的浏览器环境中单独执行并存证。
设置 app webServer 生命周期，截图脚本不要依赖人工事先启动服务。安装完成提交 pnpm-lock.yaml，CI 使用 frozen-lockfile。
缺少依赖/网络/浏览器时状态为 BLOCKED/NOT_RUN，不可写 PASS。

## 证据格式

每个任务保存：taskId、specVersion、commit、命令、工作目录、时间、退出码、测试通过/失败/跳过数、日志路径、截图路径、遗留项。
UI 通过声明必须对应非空态及异常态截图；console error 和 page error 都要记录。
最终报告区分：已实现、已测试、仅设计、未开始。不能用 YAML completed=true 代替测试。
