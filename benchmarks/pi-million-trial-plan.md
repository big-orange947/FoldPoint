# 1M 窗口下的多轮、多次压缩试验

状态：配置、末次压缩计费门禁、持续 RPC 三组执行器及零付费多次压缩门禁已实现；真实任务语料的质量评测和 DeepSeek 付费试验尚未完成。
不要拿旧的 `pi-paired-run.ts --print` 命令冒充本试验。

## 三组固定策略

| 组 | Pi 阈值 | FoldPoint | 相同的压缩方式 |
| --- | ---: | --- | --- |
| `default` | 983,616 / 1,000,000 | 仅观察；不主动压缩、不否决 | Pi 原生 |
| `fixed60` | 600,000 / 1,000,000 | 仅观察；不主动压缩、不否决 | Pi 原生 |
| `dynamic` | 983,616 / 1,000,000，作为安全兜底 | `act` 否决 + `auto` 空闲时主动触发 | Pi 原生 |

`tools/pi-million-config.ts` 为每组创建独立的 Pi agent 目录。三组共用 DeepSeek
`deepseek-flash` 的 1M 窗口、`maxTokens=4096`、`keepRecentTokens=20000`、
`cacheWarming=off`。固定 60% 用 `reserveTokens=400000` 实现；Pi 也使用该数值
计算摘要输出预算，因此三组统一把模型输出封顶 4096，避免固定组获得更大的摘要
上限。不得使用此前的假设价格覆盖。模型版本、Pi commit、语料哈希及每组实际
配置都应入报告。

## 数据与回合

使用同一份分阶段材料与预先冻结的提问顺序，持续发送到**同一个** Pi RPC 会话。
每轮等待 `agent_settled`；若压缩开始，等 `compaction_end` 后再发送下一轮。
Pi 在压缩期间拒绝新提示，不能只等待固定毫秒数。单次 `--print` 回合内的工具
调用不构成多个空闲边界，不适合测 `auto`。

首批语料取本地公开的 Pi 仓库已跟踪 TypeScript 源码，不改写源码正文，以文件为边界
分成阶段。每轮问两个真实导出函数分别定义在哪个仓库相对路径：一个取较早阶段，
一个取最近阶段；标准答案只保留在 manifest，不进入发给 agent 的消息。三组统一
禁用 Pi 文件/命令工具，只能从阶段资料回答。它是**真实源码上的分阶段定位任务**，
但阶段切分和提问由我们改造，不能称作现成基准的原始分数，也不足以代表所有日常
任务。后续还需不同任务类型。语料按实际 provider token 用量标定，不按字符数
预判阈值。

## 先后门禁

1. 零付费环回 provider：验证三组有效模型与阈值、同一摘要输出上限；验证
   `fixed60` 在 600K 左右压缩且能再次压缩；验证 `dynamic` 只在空闲边界触发，
   下一轮不会在压缩期间被拒；验证关会话前最后一次成功压缩已计费。
2. 一组三臂 DeepSeek 先导：冻结任务、材料、提问、`temperature`、价格与
   预算。只要任一臂未到预定上下文区间、轨迹不完整、失败压缩费用未知或质量
   不合格，就报告该事实，不计算费用胜率。
3. 确认先导成立后再扩大到不同任务和重复数；运行顺序轮换。质量以外部
   oracle 为准，总费用计普通请求 + 成功/失败压缩 + 缓存预热/恢复。另报时延、
   请求数、实际峰值上下文、每次压缩前后尺寸和各成本分量。

**停止条件**：运行前设付费调用、累计 prompt token、总时长上限。达到任一
上限即停止并把会话标为预算截断；不能把截断会话的低成本当作胜利。

## 当前执行器与已验证范围

`tools/pi-million-rpc.ts` 读取 `{ "id": "...", "stages": [{ "file": "stage1.txt", "expectedContains": "..." }] }`
形式的 manifest（至少两阶段）。每阶段文本文件相对 manifest 所在目录，内容直接
作为 Pi 的下一条用户消息；`expectedContains` 是最小的输出断言，正式质量评测还要
外部 oracle。三组各使用一条独立但持续的 Pi RPC 会话，不在每一阶段重建会话。
它等 `agent_settled` 和空闲压缩完成，记录普通调用、压缩、预热的分项成本，
以及压缩前后大小。报告只含 manifest/内容哈希、数字和文件路径，不含提示词。

示例命令（在 FoldPoint 仓库中，用自己的独立实验配置与语料路径）：

```powershell
$env:PI_CLI = 'D:\pi\packages\coding-agent\dist\bundle\cli.js'
$env:PI_NODE = 'C:\path\to\Node-22.19-or-newer\node.exe'
# 真实调用时在当前终端另行设置 DEEPSEEK_API_KEY；不要写入 models.json 或报告。
npx tsx tools/pi-million-rpc.ts --manifest D:\trial\manifest.json --agent-base D:\trial\pi-base --out D:\trial\run-01 --max-prompt-tokens 40000000 --min-compactions 2
```

`pi-base/models.json` 要包含 `deepseek` 的 `deepseek-flash` modelOverride，且不覆盖
`cost`。执行器在临时 agent 目录统一设置 1M 窗口与 4096 输出封顶；原始 base 不改。
已有结果路径绝不覆盖。`comparable=true` 只在三组全程完成、价格快照相同且**每组
至少两次成功压缩**时出现；轨迹缺失、未知缓存用量或压缩费用缺失均不视为完成。
阶段答错会计入 `qualityFailed`，但仍完成后续冻结任务；否则答错的一组因少调用
而显得更便宜。`pilotCostAndQualitySignal` 还要求动态组没有逐题质量倒退、且成本
低于两条基线。这只是单次先导信号，不是统计结论。命令在不能比较时非零退出。
`totalCost` 是 Pi 的价格快照
乘 provider 用量得到的**估算**，不是 DeepSeek 最终账单；峰谷时段等以账单为准。

已用真实 Pi 进程 + 本地 HTTP 假 provider 验证三组三次独立会话、每会话四个连续
回合、请求/决策配对和完整计费轨迹（零外部请求）。仅假报 65 万 `prompt_tokens`
不会触发 Pi 压缩；必须有足量资料实际进入会话，才能检验切点与摘要流程。

随后用约 4 MB/阶段、八阶段的**合成重复资料**运行可选大型环回测试：三组均完整
结束，原生 3 次、固定 60% 7 次、动态 3 次成功压缩，未计价压缩为 0。它发现并
推动修复了两个事件竞态：下一次压缩覆盖前一次已付费但后置长度未知的记录；
Pi 原生压缩完成后，排队中的 FoldPoint 主动请求再次压缩，产生 `Already compacted`
失败。普通小环回和大型环回均在 `tests/pi-million-rpc.test.ts`；大型测试需同时设置
`PI_CLI`、`PI_NODE`、`PI_MILLION_LARGE_LOOPBACK=1`，只访问本机假服务。

**这些合成资料没有任务质量标准答案**，假 provider 固定回复，报告中的美元值只
验证计费管线，不能宣称任何策略更省钱、更准确，亦不能取代真实 DeepSeek 先导。
源码任务、隐藏答案和首次 token 上限已冻结；下一步是严格窗口/预算预检，再进行
真实模型的一组三臂先导，到那一步才需要 API key。

## 已冻结的首批源码任务

生成器：`tools/pi-million-source-corpus.ts`。它拒绝 `packages/` 有未提交改动的
源仓库，只读 Git 已跟踪 `.ts` 文件并记录 commit、内容 SHA-256、各阶段长度；
不覆盖已有目录。当前候选基于本机 Pi commit
`d201760ffee16564aa8d9a759e0c85b70db33674`，13 阶段、约 1230 万字符。
生成物在 `traces/`（忽略提交），可按下式复现：

```powershell
npx tsx tools/pi-million-source-corpus.ts --source D:\pi --out D:\project\FoldPoint\traces\pi-source-pilot
New-Item -ItemType Directory D:\project\FoldPoint\traces\pi-million-base
Copy-Item benchmarks\pi-million-models.template.json D:\project\FoldPoint\traces\pi-million-base\models.json
```

已用这些**真实源码材料**及本地假服务跑完 13 阶段：原生 3 次、固定 60% 6 次、
动态 3 次压缩，三组无漏计价压缩。假服务固定回答，所以这个通过仅是链路和负载
验证，质量必须留给真实模型。假服务还接受了超过 1M 的请求；真实 API 可能拒绝并
走 Pi 的 overflow 恢复，因此先导必须把错误、重试与总费用单独报告，不能把此离线
结果当作真实 API 已完成验证。

2026-09-27 的首次真实全量尝试**未构成三臂比较**：只有 Pi 默认组启动。第 4 阶段
请求 1,114,489 token，被 DeepSeek 的 1,048,576-token 窗口以 HTTP 400 拒绝；
后续出现 HTTP 402 `Insufficient Balance`。报告保留在忽略提交的
`traces/pi-million-paid-full-01-report.json`，`comparable=false`，其默认组估算
成本约 $1.17，但失败压缩没有完整 usage，不能当最终账单。原执行器把溢出恢复后的
回复按第一条 `agent_settled` 截取，错记阶段质量；已改为等待恢复后的 Pi idle 与
最后回复，并用本地 HTTP 400 / 402 回归测试锁定。旧报告的 `3/13` 不作为质量
结论。下一次正式比较必须先缩小阶段负载、重新冻结语料并获得足够余额；**不得**
直接重跑旧的 13 阶段全量命令。

三组固定使用 DeepSeek `deepseek-flash`、`--thinking off`、`temperature: 0`；
本地 Pi HTTP 回环测试已逐请求验证后两个参数实际发出。`--max-prompt-tokens` 是
**每组每阶段完成后**检查的累计输入 token 停机线，不是 provider 请求前的硬额度锁，
也不包含摘要请求的全部费用。因此正式运行前仍应检查账户余额和模型价格；输出的
`totalCost` 只是按 Pi 价格快照估计的已发生费用。

先用真实模型只跑第 1 阶段、三组各一次；这一预检只验证模型能接入、返回格式和
三组隔离，`comparable` 必然为 `false`，不会被误当作 1M 成绩：

```powershell
$env:PI_CLI='D:\pi\packages\coding-agent\dist\bundle\cli.js'
$env:PI_NODE='C:\Users\freeze\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$env:DEEPSEEK_API_KEY='在自己的终端输入，不要写入文件或聊天'
npx tsx tools/pi-million-rpc.ts --manifest traces\pi-source-d201760ff-pilot-v2\manifest.json --agent-base traces\pi-million-base --out traces\pi-million-paid-preflight-01 --max-stages 1 --min-compactions 0 --max-prompt-tokens 2000000
```

预检若出现 `qualityFailed`、拒绝 1M 请求、未知缓存用量或未计价压缩，先查原因，
不要直接跑全量。每次 `--out` 都要用新名字，执行器拒绝覆盖旧轨迹。密钥只通过
当前 PowerShell 的环境变量传递；结束后可执行 `Remove-Item Env:DEEPSEEK_API_KEY`。
