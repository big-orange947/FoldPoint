# 1M 窗口下的多轮、多次压缩试验

## 新一轮：真实声明 1M 窗口的受控项目状态任务

旧长源码定位语料在 Pi 原生摘要处触发输出上限，不应用加长等待或提高预算继续硬跑，也不能把 800k 声明窗口说成实际跑满 1M。新语料由 `tools/pi-million-ledger-corpus.ts` 冻结生成：140 轮，每轮约 90k 字符；四个项目的负责人和截止日期不断更新，模型每轮须从整个历史回答六个状态字段。大量明确标作背景的例行记录用于填充上下文。这是**合成受控压力任务**，不是日常工作流的代表性样本；答对状态也不等于摘要质量在其他任务上可靠。

新执行器显式接受 `--run-window-tokens 1000000`，在报告中写入 `declaredRunWindowTokens`；旧结果仍默认 800000，不能与新结果混写。固定 60% 臂在 1M 下的 reserve 为 400000，默认和动态臂保留 Pi 的 16384。三臂共用 13107 的摘要输出上限，沿用相同的缓存隔离与计费口径，不修改 FoldPoint 核心。1M 默认臂靠近 DeepSeek 请求上限，有输入溢出风险；若发生，则记录为该配置失败，不调高 provider 上限、不删失败记录，也不把剩余两臂的局部结果称为三臂比较。

原先计划先跑默认臂 70 轮、至少一次成功压缩，再跑 140 轮三臂；实际预检证明默认臂无法完成，完整三臂不能成立。以下为已用过的历史命令，**不要原样重跑**：

```powershell
npx tsx tools/pi-million-ledger-corpus.ts --out traces/pi-ledger-1m-v2
npx tsx tools/pi-million-rpc.ts --manifest traces/pi-ledger-1m-v2/manifest.json --agent-base traces/pi-million-base --out traces/pi-ledger-1m-paid-preflight-02 --run-window-tokens 1000000 --arm default --max-stages 70 --min-compactions 1 --max-cost-usd 3 --max-prompt-tokens 50000000
npx tsx tools/pi-million-rpc.ts --manifest traces/pi-ledger-1m-v2/manifest.json --agent-base traces/pi-million-base --out traces/pi-ledger-1m-paid-full-01 --run-window-tokens 1000000 --min-compactions 2 --max-cost-usd 12 --max-prompt-tokens 100000000
```

每次必须使用新 `--out`，工具拒绝覆盖；原始付费轨迹在 gitignore 中。新执行器还接受 `--cache-run-id <新标识>`，让不同轮试验的缓存命名空间独立。预算线在每轮之后检查，单轮可能超出。预检不能证明三臂节省。

首轮真实 1M 声明窗口预检（`pi-ledger-1m-paid-preflight-01`）在第 29 轮因 DeepSeek HTTP 402 `insufficient-balance` 停止。前 28 轮任务答案全部通过，累计约 6,691,451 个输入 token、模型价格快照估算 $0.177797；尚无成功压缩，因此 **预检未通过，正式三臂不可启动**。第 28 轮 Pi 估计上下文约 467,645 tokens、provider prompt 约 461,467 tokens；在这份语料上目前没有重现旧源码语料的估算偏低，但仅凭半程不能推断临近 1M 上限安全。充值后必须换新的 `--out` 重新运行预检，旧失败记录不可覆盖；不要因为前 28 轮正确就宣称 1M 测试成功。

余额恢复后的 1M 预检给出一个更明确的负结果。默认 Pi 组 `pi-ledger-1m-paid-preflight-02` 在第 60 轮材料请求约 988,846 provider prompt tokens、60 轮答案正确后，三次摘要调用均触及输出上限；第 61 轮停止，成功压缩 0。未加额外安全约束的 FoldPoint 动态组 `pi-ledger-1m-paid-dynamic-preflight-01` 在约 906,504 Pi 上下文 token 首次主动尝试，之后同样因摘要输出上限停止，成功压缩 0。**旧问题没有被默认策略或当前动态策略解决。**

固定 60% 组 `pi-ledger-1m-paid-fixed-preflight-01` 在约 609,856 token 压缩成功，70/70 轮答题通过；说明更早压缩在本任务可行，但并不能推出精确的通用安全阈值。为表达“模型窗口 ≠ 压缩器可处理上限”，核心新增可选 `FoldPointProfile.compactorSafeInputTokens`；宿主声明后会以 `COMPACTOR_INPUT_LIMIT` 强制触发，未声明则保持旧行为。Pi 适配器通过 `FOLDPOINT_COMPACTOR_SAFE_INPUT_TOKENS` 接收这一值。诊断组 `pi-ledger-1m-paid-safe-dynamic-preflight-01` 使用保守的 580,000 上限，首次约 576,892 token 成功压缩，70/70 轮答题通过。但该上限是**看过本语料失败与固定组成功之后**选的，不能用这份语料上的费用差宣传算法优于固定 60%。

另外，旧试验每组使用固定 `user_id`，同一组重跑可能命中自己上一次的 KV 缓存；安全约束预检的首次压缩确实几乎全命中旧动态组的缓存。它的 $0.652056 与固定组 $0.656244 **不可作费用对照**。新的 `--cache-run-id` 同时改变 `user_id` 和系统提示标记，在一次正式试验的三组内保持各自稳定、跨试验不复用。后续完整长跑使用新的 run id；其成本仍只描述这份合成任务，不恢复已失败的三臂比较。

独立缓存命名空间下的 140 轮长跑（`cacheRunId=ledger-full-01`）已完成两个可运行组，精确摘要见 [`reports/pi-million-ledger-v2-diagnostic.json`](reports/pi-million-ledger-v2-diagnostic.json)。固定 60%：140/140 正确、3 次成功压缩、0 失败、全部计价，总成本 $1.500053。设置宿主安全上限 580,000 的 FoldPoint：140/140 正确、4 次成功压缩、0 失败、全部计价，总成本 $1.634650，**比固定组贵 $0.134597（约 8.97%）**。后者普通调用节约约 $0.005，却多支付约 $0.140 压缩成本。这个上限已用本数据校准，不能从该结果推断泛化性能，更不能把默认 Pi 的失败臂按低成本纳入比较。下一步是冻结一个不同任务形态的留出集，检验安全上限是否保持可行、是否有质量退化；在这之前不发布“多数情况下更省钱”。

**75% 最迟线的补充试验**（[`reports/pi-million-ledger-v2-75-diagnostic.json`](reports/pi-million-ledger-v2-75-diagnostic.json)）：这里的 75% 是*最晚必须压缩*，不是*最早允许压缩*。直接把触发值设为 750,000，会因一轮增长在约 758,184 token（75.8%）才开始摘要，且碰到输出上限；这不是严格执行 75% 的结果。为本冻结语料预留约一轮增长，把触发值设为 730,000 后，首次在约 725,224 token 压缩成功。换全新的缓存命名空间跑完整 140 轮：140/140 正确、3 次压缩全部成功，三次压缩前均约 72.5 万 token，估算 $1.644607。先前固定 60% 组也是 3 次成功压缩、估算 $1.500053；这次较晚压缩仍**贵 $0.144553（约 9.64%）**，其中普通调用多约 $0.039900、压缩调用多约 $0.104653。固定组未按用户要求重跑，因此它是不同批次、各自冷启动的参考值，不是同期配对；730,000 也根据本语料已观察到的结果选择，不能称为通用最佳边界。

**决策诊断，不是调参依据**：该动态组每次经济判断都只预计未来 3 次请求。前两轮长周期在约 665,000 token 时，模型估算回本需约 65/51 次请求、选择 KEEP；事后轨迹分别还有 98/56 次请求。第三轮同位置事后仅余 14 次，不能据此认为提前压缩一定正确。首次强制压缩前，预计摘要调用 $0.3247、压后仍有约 292,538 token；实际摘要调用约 $0.2132、压后约 56,112 token。冷启动先验明显高估了压缩成本与保留率，且当前“现在压缩 vs 在视野内始终不压缩”比较没有计入稍后必需的强制压缩。这是规划视野和模型先验的缺口，不是费用公式已被证明算错；只凭这一条合成轨迹把视野改成 100 次或把保留率改成 8%，会构成对测试集调参。下一步应先用独立任务验证上述误差，再设计轻量的在线视野估计和有限前瞻，随后在冻结留出集上对比。

状态：三臂执行器、缓存隔离、费用门禁和零付费环回已实现，但当前 128 阶段源码定位语料
在真实 Pi 摘要器上**不能跑通**；四份付费记录都不可用于三臂策略比较。以下长篇记录包含
DeepSeek 开发期间的历史假设，**以紧接着的 2026-09-28 复核结论为准**。
不要拿旧的 `pi-paired-run.ts --print` 命令冒充本试验。

## 2026-09-28 复核：压缩失败的直接证据与停跑决定

从 `pilot-02`、`pilot-03` 的 Pi session 中提取失败前的真实 `prepareCompaction` 输入，
调用同一版本 Pi 的 `generateSummaryWithUsage`、同一 DeepSeek 模型与同一输出预算重放：

| 原会话 | Pi 估计的压缩前上下文 | 摘要上限 | 实际结果 |
| --- | ---: | ---: | --- |
| `pilot-02` | 846,898 | 4,096 | 25 秒后 `generation hit the token cap and the summary is incomplete` |
| `pilot-03` | 795,212 | 13,107 | 45 秒后同一输出上限错误 |
| `pilot-03` 的相同输入 | 795,212 | 32,768 | 94 秒后仍是同一输出上限错误 |

另外，两次合成重复文本探针分别给 DeepSeek 738,687 和 804,077 个真实输入 token，
都只用约 300–400 个输出 token 正常结束。这证明**输入长度相近不代表摘要难度相近**：
合成文本可概括，随机源码定位材料要求保留大量精确函数—路径映射，Pi 的普通摘要提示
会持续列举细节直至触顶。早先“13,107 已修复摘要”“第 3 次只是 30 秒超时”“合成探针
证明输出预算足够”三个结论均已撤回。30 秒超时确实会过早中断，但并非唯一根因。

**停跑决定**：不再付费重试相同的 128 阶段源码语料，也不把单纯提高输出上限当作
FoldPoint 的修复；这项试验首先测到了宿主摘要器与语料的不匹配，而不是压缩时机优劣。
后续须更换为可被 Pi 摘要器保留任务关键状态的长任务，或把窗口/任务规模降到已验证
的范围，并在首次压缩处做真实摘要预检，再运行完整三臂。

## 三组固定策略

**如实称这份试验为"1M 模型、800k 运行预算"**：模型是 1M 上下文的
`deepseek-flash`，但 Pi 的声明窗口设为 800,000，为 DeepSeek 真实的
**1,048,576 token 请求上限**留出余量（上一次真实尝试就是被这个上限以 HTTP 400
拒绝的）。不得宣传为"跑满 1M"。**为什么从 860,000 再降到 800,000**：两次付费先导
没有死在 1M 上限上，而是死在**溢出恢复的那次摘要调用**上（见"失败证据"），说明上下文
长期贴着声明窗口运行，而摘要请求是整场会话里最大的单次请求——它带上整段对话再加摘要
指令，是唯一没有余量的那一次调用。800k 把最坏峰值压到约 0.83M，比上限低约 21%。

| 组 | Pi 阈值（声明窗口 800,000） | FoldPoint | 相同的压缩方式 |
| --- | ---: | --- | --- |
| `default` | 783,616 | 仅观察；不主动压缩、不否决 | Pi 原生 |
| `fixed60` | 480,000（= 运行预算的 60%） | 仅观察；不主动压缩、不否决 | Pi 原生 |
| `dynamic` | 783,616，作为安全兜底 | `act` 否决 + `auto` 空闲时主动触发 | Pi 原生 |

`tools/pi-million-config.ts` 为每组创建独立的 Pi agent 目录。三组共用同一个
模型、`maxTokens=13107`、`keepRecentTokens=20000`、`cacheWarming=off`、
`temperature: 0`、`thinking: off`、**完全相同的材料和问题**。固定 60% 的
`reserveTokens` 由窗口算出（800,000 × 0.4 = 320,000，阈值 480,000），不硬编码；Pi 也用该
数值计算摘要输出预算（`min(floor(0.8 × reserveTokens), model.maxTokens)`），所以三组必须
统一把模型输出封顶，否则固定组会单独拿到 0.8 × 320,000 = 256,000 的摘要预算（等于换了一个
更宽裕的摘要器）。封顶值取 **13,107 = floor(0.8 × 16,384)**：这是**唯一**能让三组摘要预算
既相等、又尽量够用的取值，理由见下文"根因闭合"。不得使用假设价格覆盖：三组都用 DeepSeek
原生价格。

**跨组缓存隔离**：三组各带一个不同的 DeepSeek `user_id`
（`foldpoint-1m-default` / `-fixed60` / `-dynamic`），组内保持一致。官方
[Rate Limit 页](https://api-docs.deepseek.com/quick_start/rate_limit) 明文写
`user_id` 用于 KVCache 隔离，但**未定义隔离键的构成**，且
[Context Caching 指南](https://api-docs.deepseek.com/guides/kv_cache/) 说明命中
需完整匹配已落盘的 cache prefix unit、必须是 best-effort。因此 `user_id`
**不是唯一防线**，还要让三组请求的**前缀本身从最开头就分叉**（双保险）。

**第二道防线（按臂注入系统提示前缀）**：Pi 把系统提示按有序 section 拼装，`preamble`
永远是第一个（`packages/coding-agent/src/core/system-prompt.ts:121-179`），而只有"自定义
系统提示"才会替换它（`system-prompt.ts:143-144`）。干净的按臂注入点就是 **agent 目录下的
`SYSTEM.md`**：Pi 从 `PI_CODING_AGENT_DIR` 发现它且**不需要项目信任**
（`core/resource-loader.ts:1027-1039`），本试验本来就为每组建了独立 agent 目录，所以不必
改 Pi 一行。三组注入结构相同、仅臂标识不同的两行文本，模板为：

```
<arm> / foldpoint-1m cache namespace.
Answer only from the material in this conversation: no tools, no file reads, no commands.
```

即首行是 `<arm> / foldpoint-1m cache namespace.`（`tools/pi-million-config.ts` 的
`millionSystemPromptMarker`），第二行三组逐字节相同。臂标识写在**最开头**，所以三组请求
从最开头就分叉：任何两组的共同前缀 ≤ 2 字符（`default` 与 `dynamic` 共享首字母 `d`），
而不是在会话深处——会话深处的差异对前缀缓存没有意义。

**代价（本机环回实测）**：注入后系统消息 226 字符；不注入（Pi 原生 preamble + 生成的
tools/rules/docs section）是 1,614 字符。也就是说这条防线**不是**单纯加长前缀，而是用一段
自己写的系统提示**替换**了 Pi 的原生 preamble，并顺带省掉了 Pi 自动生成的 tools/rules/docs
三节，固定前缀净减约 1,388 字符（≈347 token，按环回的字符/4 口径）。三组替换方式完全相同，
材料与问题一字未改，因此可比性不受影响，但**这一变化必须如实写进任何付费结果**：
付费先导跑的**不是** Pi 的原生系统提示。注入文本本身的成本是 2 行 129 字符 ≈ 33 token/请求。

假 HTTP 服务会**逐请求**从请求体里解析第一条消息（系统消息）的开头，断言：三组各自的首行
等于本组的 `millionSystemPromptMarker`、组内逐请求保持一致、三组互不相同。只检查
配置文件不算验证，必须证明差异真的到达请求体。

**阶段大小是安全阀**：Pi 只在每次助手回复后检查阈值，一个过大的阶段会在两次
检查之间把请求推过 1,048,576（估算还普遍偏低约 13%）。因此材料必须拆成小步，
单阶段控制在约 10 万字符量级，并让本地假服务拒绝任何超限请求来兜底。修行方式
见下文"为什么必须这么小"。

模型版本、Pi commit、语料哈希、每组实际配置、最大请求 token 都应入报告。

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

1. 零付费环回 provider：验证三组有效模型与阈值、同一摘要输出上限（现为 13,107，见
   "根因闭合"）；验证
   `fixed60` 在 60% 阈值（480,000）附近压缩且能再次压缩；验证 `dynamic` 只在空闲
   边界触发，下一轮不会在压缩期间被拒；验证关会话前最后一次成功压缩已计费。
   **2026-09-27 已按小语料通过**（三组各 3/6/21 次成功压缩、0 次撞上限、未计价压缩
   0），见文末"零付费环回门禁"小节。
2. 一组三臂 DeepSeek 先导：冻结任务、材料、提问、`temperature`、价格与
   预算。只要任一臂未到预定上下文区间、轨迹不完整、失败压缩费用未知或质量
   不合格，就报告该事实，不计算费用胜率。任一臂若停下来，报告还必须给出失败调用的
   `call`/`status`/`category`/`compactionReason`（见"失败证据"），否则"为什么停"
   仍然无法复核。
3. 确认先导成立后再扩大到不同任务和重复数；运行顺序轮换。质量以外部
   oracle 为准，总费用计普通请求 + 成功/失败压缩 + 缓存预热/恢复。另报时延、
   请求数、实际峰值上下文、每次压缩前后尺寸和各成本分量。

**停止条件**：运行前设付费调用、累计 prompt token、累计费用、总时长上限。达到任一
上限即停止并把会话标为**预算截断**（`reason: "budget-truncated"`，并在
`budgetStop` 里记下是哪条线、限额、触发时观测值）；不能把截断会话的低成本当作
胜利——截断的一组 `completed=false`，因此 `comparable` 与
`pilotCostAndQualitySignal` 都为 `false`。

## 发布判据

先导结果只有满足以下全部条件才允许进入发布文案：

1. **三组都完整跑完**，每组**至少两次成功压缩**，且**没有漏计费用**（未知
   用量的压缩必须显式计为未定价），否则不计算任何成本差；
2. 三组的价格快照相同、材料与问题完全相同、缓存命名空间互不相同（`user_id` 与
   系统提示前缀**两条**都互不相同，且都由假服务逐请求验证）；

满足后：

- 若 `dynamic` 的**质量不低于 `default`** 且**成本更低**，README 只能写
  **"这一份冻结任务上的先导结果"**，并同时列出材料、任务、阈值与预算；
- 若没有赢，**如实发布负结果**，写明适用边界（哪种窗口、哪种价格结构、
  哪种任务形态下没有优势），不得省略；
- **一份任务不能证明"大部分情况下更省钱"**。发布标签先用 `preview`/`beta`，
  **不写普遍性的省钱百分比**。

旧的失败报告 `traces/pi-million-paid-full-01-report.json`（`comparable=false`，
只启动了默认组，`3/13` 由执行器缺陷产生）**保留为失败记录，不覆盖、不纳入
任何策略比较**，也不得作为基线。导语中引用它时只能作为"为什么阶段必须变小"
的证据。

## 当前执行器与已验证范围

`tools/pi-million-rpc.ts` 读取 `{ "id": "...", "stages": [{ "file": "stage1.txt", "expectedContains": "..." }] }`
形式的 manifest（至少两阶段）。每阶段文本文件相对 manifest 所在目录，内容直接
作为 Pi 的下一条用户消息；`expectedContains` 是最小的输出断言，正式质量评测还要
外部 oracle。三组各使用一条独立但持续的 Pi RPC 会话，不在每一阶段重建会话。
它等 `agent_settled` 和空闲压缩完成，记录普通调用、压缩、预热的分项成本，
以及压缩前后大小。报告只含 manifest/内容哈希、数字和文件路径，不含提示词：
三组的系统提示前缀只以哈希与 token 数出现，注入文本本身写在
`tools/pi-million-config.ts` 与本节里，不写进结果文件。

**失败证据（2026-09-28 新增，取代"失败没有理由"的状态）**。付费先导
`traces/pi-million-paid-pilot-01-report.json` 在第 68 阶段停止（`reason:
stage-68-no-successful-response`、`qualityFailed: 5`、`unpricedCompactions: 1`、$0.95），
轨迹最后一条是溢出恢复时**失败的那次压缩**（`reason: "overflow"`、`errorCode: "failed"`）——
而报告与轨迹都没说为什么：只留下一个笼统的 `errorCode: "failed"`，错误内容从来不记。
第二次付费先导 `traces/pi-million-paid-pilot-02-report.json` 更远（第 102 阶段、$1.13），
但**死在同一处**：三条失败全记在摘要调用上（`call: "summary"`），
`assistantStopReasons: {stop: 101, length: 2}`，而 `lastFailure` 仍然是
`summary / error-without-status / no-status @ overflow`——同样说不出原因。余额已被确认
充足，402 基本可排除，剩下的候选（撞 token 上限的 400、429 限流、瞬时 5xx）**无法区分**。
现在 `tools/pi-million-rpc.ts` 把**失败的那次模型调用**记进报告，仍然只记可机器读的
枚举与数字：

- 每个臂新增 `failures`（最多 32 条，`failuresTruncated` 说明是否截断）、
  `lastFailure`、`failuresByCall`、`assistantStopReasons`、`hostRetryAttempts`；报告顶层新增
  `failedArms` 与 `failureEvidenceBasis`（口径写在报告里，不靠读代码）。
- 单条记录形如 `{stage, call, status, category, compactionReason}`：`call` 只有
  `"material"`（阶段材料调用）与 `"summary"`（宿主自己的摘要调用）两种——**这一条本身就
  足以区分大部分候选**；`status` 只存数字 HTTP 状态码；`category` 是**固定枚举**
  `rate-limit` / `insufficient-balance` / `context-length` / `invalid-request` /
  `server-error` / `http-other` / `rpc-lost` / `unknown-no-status`；`compactionReason`
  是宿主的 `threshold`/`manual`/`overflow`。
  `hostRetryAttempts` 是 Pi 自己的重试次数，只是记录，不改变"停下来报告"的协议。
- **证据来自 Pi 的 RPC 会话事件，不来自内容**：助手消息 `message_end` 的
  `stopReason: "error"`，以及**宿主真的开始过**（有配对 `compaction_start`）却没有结果的
  `compaction_end`。被否决/中止的压缩不算失败；没有配对 `compaction_start` 的
  `compaction_end` 是宿主失败后拒绝再次压缩，不重复计数。
- **分类按结构化程度取，不从正文里猜**（2026-09-28 第二次先导之后改写）。信息来源按优先级：
  1. **结构化状态码**：`message_end` 上助手消息的 `diagnostics[].error.code`（Pi 的类型是
     `string | number`，见 `pi-ai/dist/utils/diagnostics.d.ts`）优先，取不到才退回显示文本
     开头的三位数字（`"429: …"`、`"500 Rate limit exceeded"`、宿主自己的
     `"… failed: 500: …"` 前缀）。**Pi 的 RPC 协议不转发 HTTP 响应头，也没有数字
     `error.status` 字段**，所以这是线上唯一的"结构化状态码"。
  2. **provider 响应体自己的 `error.type` / `error.code`**：Pi 不把响应体当字段给出来，
     `formatProviderError` 是把它 `JSON.stringify` **塞进显示文本**
     （`pi-ai/dist/utils/error-body.js`），所以只能把那段文本**当 JSON 解析回来**
     （OpenRouter 式响应会在正文后追加一行 metadata，解析失败就逐个回退 `}`）。
  3. **固定词表**：`rate limit` / `insufficient balance` / `context length` / `token cap` /
     `invalid_request` / `server error` 等固定短语，匹配正文与结构化字段。
  **词表按"最具体优先"排序，这不是细节**：OpenAI 形状的 API 给大量 4xx 打上通用的
  `invalid_request_error`，DeepSeek 自己的 402 正文（`"Insufficient Balance"` +
  `code: "invalid_request_error"`）就是这样——先匹配通用词就会把余额不足记成"请求格式错"。
  有名字的原因优先于状态类别：400 带 `context_length_exceeded` 是上下文过长，不是请求写错。
- **错误正文一律不入库、不入日志**：正文只在分类函数内部被解析与匹配，函数返回的只有
  `{status, category}`；正文既不保存也不转发。拿不到状态、又没有固定词命中时，`category`
  只能是 `unknown-no-status`——这是这套证据的真实边界：**那种情况下报告依然分不清几种
  候选**。它也不比 provider 报的东西更权威：状态码仍是 Pi 的 provider 层从 SDK 错误对象
  里合成出来的，不是我们直接读到的响应头。
- **这条改写直接针对两次付费失败的形状**：摘要调用根本不走 `message_end`，宿主只留下一句
  自己拼的标签；当摘要**撞到自己的输出上限**时（当时 `maxTokens=4096`，2026-09-28 已改为
  13,107，见"根因闭合"），那句话里一个数字都没有
  （`generation hit the token cap and the summary is incomplete`，
  `core/compaction/compaction.ts:612`），旧口径只能记 `error-without-status`，新口径记
  `context-length`。付费先导 02 的两条材料回复正是 `length` 停止，同一个方向。
- 顺带修掉一处会白等 5 分钟的漏洞：`settleTurn` 原来要求 `compaction_start` 与
  `compaction_end` **数量相等**，而宿主在溢出压缩失败后**再次**溢出时只发
  `compaction_end`（不发 start），旧条件会一直等到超时并误报
  "Pi compaction did not settle"；改为 `ends >= starts`（仍在 `isCompacting`/`isStreaming`
  之外，所以真正未结束的压缩照旧要等）。该等待的上限 2026-09-28 已从 300 秒放宽到 **900 秒**，
  并会在超时时改说"子进程还活着"，见下文"第三次付费先导"一节。

### 历史推断（已撤回）：把 4,096 → 13,107 当作修复

> 本节保留原推理链供审计，**不是当前结论，也不能照着执行下一轮付费试验**。
> 上方的真实失败输入重放已经证明 13,107 乃至 32,768 同样触顶。

前两次付费先导的死因已经闭合，不再只是"若干候选之一"：

1. Pi 计算摘要输出预算是 `min(floor(0.8 × reserveTokens), model.maxTokens)`
   （`D:\pi/packages/coding-agent/src/core/compaction/compaction.ts:734-737`）。
2. `reserveTokens` 按臂不同（`default`/`dynamic` 16,384，`fixed60` 320,000），所以本试验用
   **三组共用的 `model.maxTokens`** 把摘要预算压成同一个数——否则固定 60% 臂会单独拿到
   0.8 × 320,000 = 256,000 的输出预算（Pi 内置 `deepseek-flash` 的 `maxTokens` 是 384,000，
   不会替我们挡住），等于换了一个更宽裕的摘要器，三臂不可比。
3. 当时的取值是 **4,096**：它确实做到了"三组相等"，但它**只为相等而选**，没有对照摘要要做的
   工作量。摘要请求带上整段对话再加摘要指令，要在约 80 万 token 的上下文上产出一份摘要，
   4,096 个输出 token 撑不住；生成撞上上限 → `stopReason: "length"` → Pi 判定摘要不完整、
   拒绝把部分摘要写成检查点（`getSummarizationFailure`，`compaction.ts:607-615`）→ 压缩失败
   → 溢出恢复以 `no successful response` 收场。
4. 证据，以及一处必须说准的地方：`traces/pi-million-paid-pilot-02-report.json` 的
   `assistantStopReasons` 是 `{stop: 101, length: 2}`，三条 `failures` 全在 `call: "summary"` 且
   `compactionReason: "overflow"`。**这两组记录不是同一批调用**——摘要调用根本不走
   `message_end`（见上文"证据来自 Pi 的 RPC 会话事件"），所以 `length: 2` 只可能是**助手回复**
   撞上同一个 `maxTokens` 上限被截断：那次付费运行里，4,096 这个封顶同时截断了回复和摘要。摘要
   三次失败的标签里一个数字都没有，而零付费注入一条裸的 `finish_reason: "length"`（见上文
   "失败注入（摘要 `length` 停止）"）能精确复现那个 `error-without-status` 形状。在候选成因里，
   "摘要撞上自己的输出上限"是唯一能同时解释"摘要路径失败"和"标签里没有状态码"的一条。严格说
   这是**高度一致**的推断，不是付费记录的直接证明——理由见本节末尾的不确定项。

**修法**：`MILLION_SUMMARY_MAX_TOKENS` 从 4,096 改为 **13,107 = floor(0.8 × 16,384)**，即默认臂
在 `reserveTokens=16,384` 下自己允许的上限。这是**唯一**能同时满足"三组摘要预算相等"和"尽量
够用"的取值：默认臂的预算是 `min(0.8 × 16,384, model.maxTokens)`，把 `model.maxTokens` 提到
13,107 正好让它顶到自己 reserve 允许的天花板，另两臂被同一个 `model.maxTokens` 压到同一数值
（`fixed60`：`min(256,000, 13,107) = 13,107`）；再大一点，默认臂自己的 reserve 先成为约束，
固定 60% 臂又会爬回去，三组就不再相等了。"再调大一点更保险"在这里**不是一个选项**。

**这条修复环回门禁验证不了，只有真实付费跑才能验证**：假 provider 的摘要是固定的一小段文本
（见下面那段 `## Goal …`），永远撞不到任何输出上限，也就永远不会 `length` 截断。零付费门禁
能证明的只是**没有连带破坏**——三组仍各 ≥2 次压缩、0 次超限、前缀仍互不相同，外加新增的
"三组的摘要请求在**请求体里**都要的是同一个 `max_tokens`、且等于 13,107"（`max_tokens` 取自
假服务逐请求解析出的字节，不是配置文件）：它证明这个上限确实到达 provider，**不能**证明
摘要不再被截断。要证明后者，必须在真实 DeepSeek 上重跑，并检查报告里
`assistantStopReasons` 是否还出现 `length`、`failures` 是否仍落在 `call: "summary"` 上。

**这次修复仍然不确定的地方**（必须写进任何付费结果）：

- 上面第 4 点的对应关系是**推断**：付费记录本身不足以在"摘要撞输出上限"与"网络层中断"之间
  区分（两者都会留下无状态码的标签）。判别只能靠下一次付费跑——新分类会给出
  `context-length`（撞上限）或 `unknown-no-status`（其它），两者指向完全不同的下一步。
- 13,107 是"默认臂 reserve 允许的上限"，**不是按摘要实际需要多少输出 token 算出来的**：没有
  实测过一份约 80 万 token 上下文的摘要到底要用多少 token。若它仍然不够，会以完全相同的方式
  失败，只是那时 `context-length` 会明确指出是撞上限。
- `model.maxTokens` 同时是**普通回复**的输出上限，所以三臂的正常回复也从 4,096 抬到 13,107。
  这对"回复被截断"是改善（付费先导 02 的两次 `length` 正是回复被截断），代价是单次回复的
  最坏输出费用按上限算变大（13,107 × $1.2/M ≈ $0.016/次），停机线的口径与检查时机都没变。

### 历史推断（已撤回）：第 3 次只因等不到返回

> 旧执行器的 30 秒等待确实过短，但真实会话重放在 45 秒后又证实摘要
> 触及 13,107 输出上限；延长等待**不能**让该摘要成功。

第三次真实付费先导 `traces/pi-million-paid-pilot-03-report.json`（只跑到默认臂、第 63/64 阶段、
估算 $0.646、`comparable=false`）证明 4,096 → 13,107 这个改动**改掉了失败形状，但没跑通**：

- 报告里两条失败都在摘要调用上（`call: "summary"`、`compactionReason: "threshold"`）：
  第 63 阶段一条 `context-length`（那次摘要被自己的输出上限截断，就是 4,096 时代的老病），
  第 64 阶段一条 `rpc-lost`，`reason: "Pi RPC event timeout or exit (exit=running)"`。
- 轨迹时间线：阶段请求本身每次 3–5 秒正常；一条压缩失败；**44 秒之后**另一条压缩被判中断。
  执行器自己的等待上限正好是 30 秒。
- 推断（证据一致，但**没有直接证明**）：13,107 的摘要在 30 秒内写不完。异常处理把"截断"
  换成了"等不到返回"，因为那句 `exit=running` 说明**子进程一直活着**，只是执行器不再等了。

机制在 Pi 源码里对齐（只读）：RPC 的 `prompt` 响应只在**预检成功后**发出
（`coding-agent/src/modes/rpc/rpc-mode.ts:394-414`），而预检自己会跑一次阈值压缩
（`core/agent-session.ts:1697` 在 `:1759` 之前）。所以"等下一次 prompt 的响应"这件事本身可以
整个包在一次摘要调用外面，而不是像原来假设的那样只包住一次快速的控制往返。

**本地改动（`tools/pi-million-rpc.ts`，只改执行器，不碰 Pi、不碰 `src/`、不碰任何付费记录）**：

1. **等待放宽到 900 秒（15 分钟）**，但只放宽"可能包住摘要调用"的三处：`prompt` 命令的响应、
   `agent_settled`、`settleTurn`。取值依据：这次付费运行自己的节奏（短回复连预填充 3–5 秒）
   把生成速度定在约 20–30 token/s，13,107 token 的摘要要 7–11 分钟，15 分钟留出余量；事件先到
   就先返回，所以这个数字只在真挂起时才付出时间代价。**没有**无差别放大短等待：`get_state` 的
   默认 30 秒保留（Pi 的命令循环在压缩期间照样立刻回答）、settle 轮询间隔 250 ms、预等待宽限
   600 ms、关会话宽限 10 s 全部原样。
2. **"等超时"与"真退出"分开记账**。旧的 `Pi RPC event timeout or exit (exit=running)` 把两种
   相反状态塞进一句话——`exit=running` 就是被混淆的证据。现在等待失败抛 `PiRpcLossError`，
   带一个固定枚举 `rpcLoss`：`event-timeout`（我们的截止时刻到了，子进程还活着）、
   `settle-timeout`（子进程还在压缩/流式输出）、`process-exit`（子进程真的结束，消息里带退出码）、
   `spawn-error`（没起来）、`runner-error`（其它）。每条 `rpc-lost` 失败记录都带这个字段，
   报告顶层的 `failureEvidenceBasis` 也写明了；两个正例的 `reason` 文字本身也不再混用。
3. 零付费覆盖（同一测试文件，新增 7 条）：用本地 stub 子进程分别构造"我们的截止时刻到了"
   （`event-timeout`，并断言 `exitCode` 仍为 `null`）、"子进程真的退出"（`process-exit` 且带退出码）、
   "从没起来"（`spawn-error`）、"压缩到点还没结束"（`settle-timeout`，子进程仍活着），以及
   空闲时立即收敛；再用字面事件直接断言 `scanFailures` 把同一条轨迹分别记成 `settle-timeout`
   与 `process-exit`，并断言真实 provider 失败（HTTP 500 注入）的 `rpcLoss` 仍为 `null`。
   全部只起本地进程，不访问任何外部服务。

**仍然不确定的地方**（写进任何付费结果）：上面这条因果是**推断**——"30 秒不够"没有直接证据，
只有"失败形状 + 时间线 + 代码路径"三件事一致。所以另配一个定向探针，见下节。

### 定向探针：13,107 的摘要到底要多久（`tools/pi-million-summary-probe.ts`，默认不发起调用）

直接回答"根因闭合"里明说没有实测过的那件事：**给定约 70 万 token 的上下文，DeepSeek 能不能在
13,107 的输出预算内产出一份完整摘要、要多久。**

- 上下文是**确定性合成**的（约 70 万 token 的 `[User]: …` / `[Assistant]: …` 回合，逐字节可复现；
  不读私有数据，不写任何文件）。
- 请求形状照抄 Pi 的摘要调用（**只读** Pi 源码，不改、不引）：`compaction.ts:704-775` 的
  `SUMMARIZATION_SYSTEM_PROMPT` + `<conversation>` 包裹的用户提示、`compaction.ts:734-737` 的
  `min(floor(0.8 × reserveTokens), model.maxTokens)`、`utils.ts:156-158` 的系统提示、
  `pi-ai/.../openai-completions.ts` 的请求体（`stream_options.include_usage`、
  `thinking: {type:"disabled"}`、按臂的 `user_id`），因此 `max_tokens` 正好是 **13,107**。
- 打印的字段只有数字与枚举：HTTP 状态、`finish_reason`（`stop`/`length`）、输出 token 数、
  `promptTokens`（DeepSeek 自己数的上下文大小，可与 chars/4 估算对照——"真实比估算高约 13%"
  那条偏差就是靠它对上）、耗时秒数、是否撞到上限（`hitOutputCap`）、判定 `verdict`
  （`budget-sufficient` / `budget-too-small` / `timed-out` / `http-error` / `transport-error` /
  `provider-error` / `stream-incomplete`）、以及预估花费。**提示词与响应正文一律不打印**：
  正文在流式解析里只被计数、立即丢弃，扫描结果里没有任何能装文本的字段（零付费测试直接断言）。
- **默认不发起调用**：不带 `--confirm-paid-call` 时只打印它将要做什么（端点、模型、`max_tokens`、
  合成上下文大小、自有超时、最坏情况花费）并退出 0。密钥只从 `DEEPSEEK_API_KEY` 读，只进
  `authorization` 头；脚本不写任何文件或日志。
- **预估花费**：700k 输入 token + 13,107 输出，按 Pi 的 `deepseek-flash` 快照
  （$0.3/M 输入、$1.2/M 输出）算最坏情况 **≈ $0.23**（未命中缓存；命中缓存的输入价是
  $0.006/M）。比一次付费先导便宜两个数量级，而且默认用自己的
  `foldpoint-1m-summary-probe` 缓存命名空间，不动三臂的 `user_id`。
- 解析与判定是纯函数，零付费测试覆盖：`length` → "预算不够"、`stop` → "够用"、
  自己的超时 → `timed-out`、402 → `http-error`、无状态的传输失败 → `transport-error`、
  流里的 provider 错误 → `provider-error`、什么都没有 → `stream-incomplete`；另有跨 chunk 拆行的
  SSE 解析、超长行丢弃、以及"只计数不留下"（响应里埋一个 canary 字符串，断言它不出现在结果里）。
  测试完全不访问任何真实 API。

运行方式（**只有这一步会花钱，由人自己确认后再跑**；密钥只在当前终端的环境变量里）：

```powershell
# 只打印计划与预估花费，不发起调用
npx tsx tools/pi-million-summary-probe.ts
# 真正发起一次
$env:DEEPSEEK_API_KEY='在自己的终端输入，不要写入文件或聊天'
npx tsx tools/pi-million-summary-probe.ts --confirm-paid-call
Remove-Item Env:DEEPSEEK_API_KEY
```

读结果时要回答的问题很具体：`finishReason` 是 `stop`（13,107 够用，pilot-03 的问题在等待上限上）
还是 `length`（输出预算仍然不够，得另找修法）；`elapsedSeconds` 是否真的超过 30 秒
（若是，pilot-03 那条推断闭合）；`promptTokens` 与 `approxInputTokens` 差多少
（真实 tokenizer 相对 chars/4 的偏差，直接关系到 800k 声明窗口还剩多少余量）。

示例命令（在 FoldPoint 仓库中，用自己的独立实验配置与语料路径）：

```powershell
$env:PI_CLI = 'D:\pi\packages\coding-agent\dist\bundle\cli.js'
$env:PI_NODE = 'C:\path\to\Node-22.19-or-newer\node.exe'
# 真实调用时在当前终端另行设置 DEEPSEEK_API_KEY；不要写入 models.json 或报告。
npx tsx tools/pi-million-rpc.ts --manifest D:\trial\manifest.json --agent-base D:\trial\pi-base --out D:\trial\run-01 --max-prompt-tokens 40000000 --max-cost-usd 20 --min-compactions 2
```

`pi-base/models.json` 要包含 `deepseek` 的 `deepseek-flash` modelOverride，且不覆盖
`cost`。执行器在临时 agent 目录统一设置 1M 窗口与 13,107 输出封顶，并写入该组的
`SYSTEM.md`（系统提示前缀，见上文"第二道防线"）；原始 base 不改。
已有结果路径绝不覆盖。`comparable=true` 只在三组全程完成、价格快照相同、三组系统提示
前缀互不相同且**每组至少两次成功压缩**时出现；轨迹缺失、未知缓存用量或压缩费用缺失
均不视为完成。阶段答错会计入 `qualityFailed`，但仍完成后续冻结任务；否则答错的一组
因少调用而显得更便宜。`pilotCostAndQualitySignal` 还要求动态组没有逐题质量倒退、且成本
低于两条基线。这只是单次先导信号，不是统计结论。命令在不能比较时非零退出。
`totalCost` 是 Pi 的价格快照
乘 provider 用量得到的**估算**，不是 DeepSeek 最终账单；峰谷时段等以账单为准。

**两条停机线**（`--max-prompt-tokens`、`--max-cost-usd`）都在**每个阶段完成后**检查，
**不是** provider 请求前的硬额度锁：Pi 只在助手回复后检查阈值，一个过大的阶段可以在
下一次检查之前就冲过任何一条线，`cost` 也不含摘要请求的部分输出费用，所以它们只能
限损、不能保证不超支。`--max-cost-usd` 用 Pi 的价格快照乘 provider 用量（与
`totalCost` 同一个口径、同一个 `sessionCosts[0]`），每阶段后重算一次；`--max-cost-usd`
未给出时不启用费用线（`maxCostUsd=null`）。任一触发即：该组停止、`reason` 记为
`budget-truncated`、`budgetStop` 记下 `{kind, limit, observed}`、后续两组不再启动。
报告对每组同时给出 `reason`、`budgetStop`、`stagesCompleted`、`promptTokensTotal`、
`totalCost`，以及逐阶段 `costUsdSoFar`（给出费用线时才有值，其余为 `null`），
因此"截断会话便宜"无法冒充胜利。若某阶段
费用算不出（轨迹未计价），费用线**不会**触发，该组最终会以
`incomplete-or-unpriced-trace` 收尾，仍然不可比。

小语料门禁（`PI_MILLION_SOURCE_MANIFEST`）由测试脚本断言：三组全部 128/128 完成、
每组成功压缩 ≥2、**没有任何请求被 1,048,576 拒绝**、全环回最大请求不超过上限、
**三组请求的系统提示前缀从最开头就互不相同且各自组内一致**，并把 manifest 路径与
SHA-256、每臂压缩次数/发起方/原因、每臂最大请求、累计 prompt token、费用与系统提示
前缀打到标准输出；测试还在 `--min-compactions 2` 下要求 `comparable=true`，不为跑通
而放宽。同一个测试文件里另有两段短跑，用极小额度分别触发费用线与 token 线，断言
`reason=budget-truncated`、只跑了 1 个阶段、`comparable=false`、且该组不会被当成赢家。
**2026-09-28 起还断言两件事**：(1) 三组跑完后 `failures` 必须为空、`assistantStopReasons`
只能出现 `stop`（健康的门禁不该留下任何失败证据）；(2) 两段**零付费失败注入**短跑——
假服务对某一类调用返回真实 HTTP 状态码（错误正文里**故意不写这个数字**，所以只有真的从
provider 层错误文本里读出来才算数），断言报告里出现对应状态码与"失败发生在哪类调用上"。

已用真实 Pi 进程 + 本地 HTTP 假 provider 验证三组三次独立会话、每会话四个连续
回合、请求/决策配对和完整计费轨迹（零外部请求）。仅假报 65 万 `prompt_tokens`
不会触发 Pi 压缩；必须有足量资料实际进入会话，才能检验切点与摘要流程。

随后用约 4 MB/阶段、八阶段的**合成重复资料**运行可选大型环回测试：三组均完整
结束，原生 3 次、固定 60% 7 次、动态 3 次成功压缩，未计价压缩为 0。它发现并
推动修复了两个事件竞态：下一次压缩覆盖前一次已付费但后置长度未知的记录；
Pi 原生压缩完成后，排队中的 FoldPoint 主动请求再次压缩，产生 `Already compacted`
失败。**该夹具的 4 MB/阶段现在会（正确地）撞 1,048,576 上限**，因此它不再是
可用的门禁，只作为"阶段过大必须被拒绝"的回归证据；实际门禁是下面小语料的那条。
普通小环回和大型环回均在 `tests/pi-million-rpc.test.ts`；大型测试需同时设置
`PI_CLI`、`PI_NODE`、`PI_MILLION_LARGE_LOOPBACK=1`，只访问本机假服务。

**这些合成资料没有任务质量标准答案**，假 provider 固定回复，报告中的美元值只
验证计费管线，不能宣称任何策略更省钱、更准确，亦不能取代真实 DeepSeek 先导。
源码任务、隐藏答案和首次 token 上限已冻结；下一步是严格窗口/预算预检，再进行
真实模型的一组三臂先导，到那一步才需要 API key。

## 已冻结的首批源码任务

生成器：`tools/pi-million-source-corpus.ts`。它拒绝 `packages/` 有未提交改动的
源仓库，只读 Git 已跟踪 `.ts` 文件并记录 commit、内容 SHA-256、各阶段长度与哈希；
不覆盖已有目录。**阶段默认 10 万字符**（`SAFE_STAGE_CHARS`），`--stage-chars` 超过
20 万直接报错：旧默认 100 万会造出能把请求推过 1,048,576 的阶段，已废弃。
**大于 10 万字符的单个文件整份跳过**（不裁剪正文），否则它会独占一个阶段，而一个
过大的阶段能在 Pi 两次阈值检查之间把请求推过上限；跳过它不影响任务自洽，因为
oracle 的答案只在留下的文件里取。`manifest.json` 每阶段带 `chars` 与 `sha256`（阶段
正文的哈希），`source-lock.json` 记整体 `sourceHash`。

当前语料基于本机 Pi commit
`d201760ffee16564aa8d9a759e0c85b70db33674`，位置
`traces/pi-source-d201760ff-small-v2`（忽略提交，可按下式复现）：

```powershell
npx tsx tools/pi-million-source-corpus.ts --source D:\pi --out D:\project\FoldPoint\traces\pi-source-d201760ff-small-v2
```

128 阶段、共 11,556,228 字符，平均 90,283、最小 32,421、**最大 106,166**。
`manifest.json` 的 SHA-256 为
`30af2cefb985df9648d607fe903edd48056499d901da07769a3c714423bc831b`，
`source-lock.json` 的 `sourceHash` 为
`0159e72ecd195b2ed491b7a48da953430dcabac9a311c83af662a4ca8988b1ac`。

上一版冻结 `traces/pi-source-d201760ff-small-v1`（135 阶段、12,323,677 字符、
最大阶段 238,958，manifest SHA-256
`60255b6043e18447cb732896e6f8878fb932fe063e3b1ca3bf206fd486beb6a2`）保留作历史：
它的最大阶段来自单个 238,599 字符的
`packages/coding-agent/src/modes/interactive-mode.ts`，该文件在 v2 里被整份跳过，
所以 v2 的每阶段上限才降到 10 万字符量级。v1 的环回实测数字见下表下方注释。

**为什么必须这么小**：每条阶段是**独立的一次 agent run**，而 Pi 的
`prepareNextTurn` 预检只在同一次 run 的第二轮及以后出现，所以新阶段文本从不参与
预检。于是峰值请求 = 上一次回复后的上报用量（≤ 声明窗口）+ 一个完整阶段。旧的
95 万字符阶段因此产生 883,616 + 约 27.8 万 ≈ 1.11M 的请求，即被 HTTP 400 拒绝的
1,114,489。10 万字符阶段把峰值压到约 0.83M token：最坏情况是
声明窗口 800,000 + 最大阶段（106k 字符 ≈ 2.7 万 token）≈ 0.83M，比上限低约 21%。

### 零付费环回门禁（小语料）

```powershell
$env:PI_CLI = 'D:\pi\packages\coding-agent\dist\bundle\cli.js'
$env:PI_MILLION_SOURCE_MANIFEST = 'D:\project\FoldPoint\traces\pi-source-d201760ff-small-v2\manifest.json'
npx vitest run tests/pi-million-rpc.test.ts
```

2026-09-27 实测（**当时的声明窗口是 900,000**；本机，292 s，`-small-v2` 语料，本节的数字
全部来自这一次运行；同一天另外两次同样的运行只在累计 prompt token 上差 1–2 个 token——
差异来自摘要文本长度——压缩次数、最大请求与三组前缀逐位一致。原始输出存临时目录
`C:\Users\freeze\AppData\Local\Temp\fp-probe\gate-06.log`，不入库）：

| 组 | 完成 | 成功压缩 | 发起方 / 原因 | 本组最大请求 | 累计 prompt token | 费用（估算） | 系统提示前缀 |
| --- | --- | ---: | --- | ---: | ---: | ---: | --- |
| `default` | 128/128 | 3 | host 3：threshold 1 + 窗口溢出 2 | 909,583 | 57,127,508 | $17.92 | `d18eca018927bfda` |
| `fixed60` | 128/128 | 6 | host 6：threshold 6 | 558,727 | 37,576,834 | $12.23 | `2e535ff5f2e4f1f6` |
| `dynamic` | 128/128 | 20 | policy 20：manual 20 | 813,027 | 23,893,153 | $11.88 | `4aa27d25a96475cf` |

全环回 413 次请求（每臂 128 次材料 + 29 次摘要请求），**0 次被 1,048,576 拒绝**，
未计价压缩 0，`qualityFailed` 0，`comparable=true`。同一进程里另有两次短跑，用极小额度
分别触发费用线与 token 线：两次都在**完成 1 个阶段后**停止，`reason=budget-truncated`、
`budgetStop={kind:"cost-usd"/"prompt-tokens", limit, observed}`、只跑了 `default` 一组、
`comparable=false`、`pilotCostAndQualitySignal=false`（费用线那次观测到
$0.0080193，正是该组 1 个阶段后的累计费用）。假服务逐请求解析出的三组首行
分别是 `default / foldpoint-1m cache namespace.`、`fixed60 / …`、`dynamic / …`，
组内逐请求一致、三组两两不同（最长共同前缀 ≤ 2 字符），说明前缀差异确实到达了请求体，
不是只写在配置里。每组最大请求都低于声明窗口 + 一个阶段，符合上面的机制；`default`
的两条按 `overflow` 记，是因为回复用量越过了**当时的声明窗口** 900,000（不是阈值
883,616），这正是声明窗口作为安全缓冲在起作用。

（上一版 `-small-v1` 语料的同一条门禁：135/135 完成、435 次请求、3/6/21 次压缩、
最大请求 900,803/560,247/819,052、累计 prompt token 62,792,122/39,737,554/25,665,950；
原始输出曾存 `traces/pi-source-d201760ff-small-v1/gate-loopback-01.log`。该语料已不是
当前冻结版本。）

**2026-09-28 复测**（**当时的声明窗口是 860,000**；同一条命令，加入失败证据断言后；
本机 334 s，原始输出 `C:\Users\freeze\AppData\Local\Temp\fp-diag-probe\gate-diag-03.log`，
不入库。收尾时又跑一次同样的命令（331 s，日志 `gate-final.log`），只有 `default` 最大请求
与 `dynamic` 累计 prompt token 各差 1、压缩次数与三组前缀逐位相同——差异来自摘要文本长度，
与 09-27 的复现情况一致）：

| 组 | 完成 | 成功压缩 | 发起方 / 原因 | 本组最大请求 | 累计 prompt token | 费用（估算） | 系统提示前缀 |
| --- | --- | ---: | --- | ---: | ---: | ---: | --- |
| `default` | 128/128 | 3 | host 3：threshold 2 + 窗口溢出 1 | 866,921 | 56,424,965 | $17.69 | `f4e56db3453a41b1` |
| `fixed60` | 128/128 | 6 | host 6：threshold 6 | 537,231 | 35,700,204 | $11.62 | `041ee98ebbe9542a` |
| `dynamic` | 128/128 | 20 | policy 20：manual 20 | 785,878 | 23,432,109 | $11.59 | `fe1adebba0d53c02` |

413 次请求（384 材料 + 29 摘要）、**0 次被 1,048,576 拒绝**、未计价压缩 0、
`qualityFailed` 0、`comparable=true`、三组 `failures` 全空、`assistantStopReasons` 只有
`stop`、`hostRetryAttempts` 0。与前一天的运行相比，压缩次数、每臂最大请求的量级和三组
前缀互不相同都一致，具体数字有小幅差异（摘要文本长度与切点位置）。**前缀哈希与 09-27
那张表不同、却与同仓库付费先导 `pi-million-paid-pilot-01-report.json` 的
`f4e56db3453a41b1` 相同**：那张表测的是 `MARKER_INITIAL`（A/B/C 首字母）之前的旧前缀
文本，今天的门禁与付费先导用的是同一份前缀。

**2026-09-28 第三次门禁（声明窗口 800k，结构化错误枚举 + 四条失败注入）**。同一条命令，
本机 365.6 s，原始输出 `C:\Users\freeze\AppData\Local\Temp\fp-gate-800k-3.log`，不入库
（收尾时用同一份代码再跑一次：361.4 s，日志 `fp-gate-800k-final.log`，只有三组累计
prompt token 各差 1–3 个 token、fixed60 峰值上下文差 1，压缩次数、最大请求、四条注入
结论与全部前缀逐位相同）：

| 组 | 完成 | 成功压缩 | 发起方 / 原因 | 本组最大请求 | 峰值上下文 | 累计 prompt token | 费用（估算） | 系统提示前缀 |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | --- |
| `default` | 128/128 | 4 | host 4：threshold 2 + 窗口溢出 2 | 806,276 | 804,088 | 52,881,953 | $16.78 | `f4e56db3453a41b1` |
| `fixed60` | 128/128 | 6 | host 6：threshold 6 | 503,109 | 501,084 | 33,730,890 | $10.98 | `041ee98ebbe9542a` |
| `dynamic` | 128/128 | 17 | policy 17：manual 17 | 733,404 | 732,013 | 25,271,601 | $11.17 | `fe1adebba0d53c02` |

411 次请求（384 材料 + 27 摘要）、**0 次被 1,048,576 拒绝**、未计价压缩 0、
`qualityFailed` 0、`comparable=true`、三组 `failures` 全空、`assistantStopReasons` 只有
`stop`、`hostRetryAttempts` 0。降窗口的直接效果：`default` 的溢出压缩从 1 次增到 2 次、
`dynamic` 的主动压缩从 20 次降到 17 次，压缩总数更多但仍远在"每臂 ≥2"之上；三种前缀哈希
与 860k 那次逐位相同（前缀是臂标识，与窗口无关）。峰值请求 806,276，比 1,048,576 低约
23%——比 860k 那次的 866,921 多留出约 6 万 token 的余量，正是给"真实 provider 比 Pi 估算
高约 13%"那条偏差用的。

**2026-09-28 第四次门禁（摘要把 4096 改成 13107 之后）**。同一条命令、同一份 800k 配置，
本机 358.0 s，原始输出 `C:\Users\freeze\AppData\Local\Temp\foldpoint-gate-13107b.log`，不入库，
与上一节的差异只有摘要输出封顶这一项：

| 组 | 完成 | 成功压缩 | 发起方 / 原因 | 本组最大请求 | 峰值上下文 | 累计 prompt token | 费用（估算） | 系统提示前缀 | 摘要请求体 `max_tokens` |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | --- | ---: |
| `default` | 128/128 | 4 | host 4：threshold 2 + 窗口溢出 2 | 806,276 | 804,088 | 52,881,982 | $16.78 | `f4e56db3453a41b1` | 13,107 |
| `fixed60` | 128/128 | 6 | host 6：threshold 6 | 503,109 | 501,083 | 33,730,920 | $10.98 | `041ee98ebbe9542a` | 13,107 |
| `dynamic` | 128/128 | 17 | policy 17：manual 17 | 733,404 | 732,013 | 25,271,628 | $11.17 | `fe1adebba0d53c02` | 13,107 |

411 次请求（384 材料 + 27 摘要）、**0 次被 1,048,576 拒绝**、未计价压缩 0、`qualityFailed` 0、
`comparable=true`、三组 `failures` 全空、`assistantStopReasons` 只有 `stop`、
`hostRetryAttempts` 0，四条失败注入与两条停机线短跑的结论与上一节逐条相同。新增断言
**逐请求**检查三组摘要请求在请求体里要的 `max_tokens`：三组都只有一个值、都等于 13,107
（上一节那张表的运行还没有这条断言）。压缩次数、峰值上下文与三组前缀哈希与上一节逐位相同；
累计 prompt token 每臂高 27～30 个 token，因为请求体里的 `max_tokens` 从 4 位数字变成 5 位
数字（每个请求多 4 字节），假 provider 按 `ceil(请求字节数/4)` 计量必然看到这点差值。**这张表
仍然只说"没改坏别的"**：摘要能不能不再被截断，只有真实付费跑能证明（见"根因闭合"）。

收尾时用同一份代码再跑一次（357.8 s，日志 `foldpoint-gate-13107-final.log`）：27 次摘要请求、
三组请求体 `max_tokens` 全为 13,107、0 次被 1,048,576 拒绝、`comparable=true`、四条注入结论
逐条相同；只有 `default` 峰值上下文 +1、三组累计 prompt token 各差 ≤5 个 token，压缩次数与
三组前缀逐位相同——与前面几次复现的差异量级一致（都来自摘要文本长度）。

**2026-09-28 第五次门禁（等待上限 30 秒 → 900 秒 + `rpcLoss`）**。同一条命令、同一份 800k 配置与
13,107 摘要封顶，本机 `npx vitest run`（全量）中的 `tests/pi-million-rpc.test.ts` 用了 357.8 s
（全量 16 个测试文件 269 条断言全绿，358.6 s）。原始输出
`C:\Users\freeze\AppData\Local\Temp\foldpoint-fullsuite-01.log`，不入库：

| 组 | 完成 | 成功压缩 | 发起方 / 原因 | 本组最大请求 | 峰值上下文 | 累计 prompt token | 费用（估算） | 系统提示前缀 |
| --- | --- | ---: | --- | ---: | ---: | ---: | ---: | --- |
| `default` | 128/128 | 4 | host 4：threshold 2 + 窗口溢出 2 | 806,276 | 804,088 | 52,881,985 | $16.78 | `f4e56db3453a41b1` |
| `fixed60` | 128/128 | 6 | host 6：threshold 6 | 503,109 | 501,083 | 33,730,922 | $10.98 | `041ee98ebbe9542a` |
| `dynamic` | 128/128 | 17 | policy 17：manual 17 | 733,404 | 732,013 | 25,271,627 | $11.17 | `fe1adebba0d53c02` |

411 次请求（384 材料 + 27 摘要）、**0 次被 1,048,576 拒绝**、未计价压缩 0、`qualityFailed` 0、
`comparable=true`、三组 `failures` 全空、`assistantStopReasons` 只有 `stop`、`hostRetryAttempts` 0、
三组摘要请求体 `max_tokens` 仍只有一个值 13,107，两条停机线短跑与四条失败注入短跑的结论逐条
与上一节相同（新增一处断言：四条注入的 `lastFailure.rpcLoss` 都必须为 `null`，否则"传输丢失"
这个字段就不再只表示传输丢失）。压缩次数、峰值上下文、最大请求与三组前缀哈希与上一节逐位相同
——**这张表仍然只说"没改坏别的"**：等待上限放宽只让"等超时"更晚发生，摘要能不能不再被截断
仍然只有真实付费跑能证明。

**新增的零付费断言**（同一文件）：7 条针对"等超时 vs 真退出"的断言，全部只起本地 stub 子进程。
`event-timeout` 那条同时断言 `child.exitCode === null`（子进程确实还活着），`process-exit` 那条
断言退出码出现在 `reason` 里，`settle-timeout` 那条用一个只会回答 `get_state` 且一直报
`isCompacting: true` 的 stub 进程顶到截止时刻；另有 2 条纯函数断言把同一条事件轨迹分别记成
`settle-timeout` 与 `process-exit`，并断言非传输失败的 `rpcLoss` 为 `null`。

两条停机线短跑与**四条**失败注入短跑在同一进程内通过，报告分别给出：

- 费用线：`budgetStop={kind:"cost-usd", limit:0.000001, observed:0.0080196}`、1 个阶段、
  `comparable=false`；token 线：`{kind:"prompt-tokens", limit:1, observed:26684}`。
- **失败注入（摘要 500）**：假服务对摘要调用返回 **HTTP 500**（响应体里既不写 `500`、
  也不写任何已知成因的词；同时把前两次材料调用的上报用量抬到 90 万 token，让 Pi 在没有
  真实长上下文时也会请求摘要），实测
  `lastFailure={stage:2, call:"summary", status:500, category:"server-error",
  compactionReason:"overflow"}`、`failuresByCall={material:0, summary:1}`、
  `hostRetryAttempts:3`、`reason=incomplete-or-unpriced-trace`、退出码 1——
  这正是付费先导第 68 阶段缺失的那句话：**失败的是一次摘要调用，发生在溢出恢复里**。
- **失败注入（摘要 400 + 结构化 `error.code`）**：返回 **HTTP 400**，正文
  `{"error":{"message":"This model's maximum context length is …","type":"invalid_request_error",
  "code":"context_length_exceeded"}}`，实测
  `lastFailure={stage:2, call:"summary", status:400, category:"context-length",
  compactionReason:"overflow"}`、`hostRetryAttempts:0`、退出码 1。这一条同时证明两件事：
  **响应体里的 `error.type`/`error.code` 确实被取到了**，而且那个通用的
  `invalid_request_error` **没有**把成因盖成 `invalid-request`。
- **失败注入（摘要 `length` 停止，完全没有状态码）**：HTTP 200、流里只有
  `finish_reason: "length"`，也就是**两次付费失败最可能的形状**——摘要撞上自己的输出上限。
  实测 `lastFailure={stage:2, call:"summary", status:null, category:"context-length",
  compactionReason:"overflow"}`、`hostRetryAttempts:0`、退出码 1。旧口径在这里只能给出
  `error-without-status`；新口径说得出"摘要被自己的输出上限截断"。
- **失败注入（材料 429）**：假服务对第一次材料调用返回 **HTTP 429**，实测
  `lastFailure={stage:1, call:"material", status:429, category:"rate-limit",
  compactionReason:null}`、`failuresByCall={material:4}`（Pi 自己重试了 3 次）、
  `reason=stage-1-no-successful-response`、退出码 1。
- 状态码确实来自提取而非正文：注入的响应体里没有那个数字。分类规则本身另有
  零依赖单元断言（同一测试文件里的 `Pi failure classification`），覆盖 DeepSeek 402
  正文里那个通用 `invalid_request_error` 不能被当成成因、结构化诊断码优先于显示文本、
  以及"什么都没命中"时必须落到 `unknown-no-status`。

四段注入短跑用的是**独立的 2 阶段、约 11 万字符/阶段（≈2.8 万 token）**的合成语料
（测试自己写的 `diag-manifest.json`），所以它们和 `PI_MILLION_SOURCE_MANIFEST` 无关、
在任何模式下都跑；只访问本机假服务，不涉及任何真实 API 调用。

费用列是假 provider 按 `ceil(请求字节数/4)` 上报用量、乘 Pi 的 DeepSeek 价格快照算出的
**估算**：它只验证计费与停机线管线，不是 DeepSeek 账单，也不能说任何一组"更省"。

4 MB/阶段的大型环回夹具现在（正确地）撞 400：小语料已取代它，它只保留为"阶段过大
必须被拒绝"的回归证据。

**这段环回不能替代真实校验**：(1) token 计量是 `ceil(请求字节数/4)`，与 Pi 自身的
估算同源，**复现不了真实 provider 比 Pi 估算高约 13% 的偏差**；按 800k 声明窗口，真实峰值
应估为"声明窗口 + 一个真实阶段" ≈ 0.83–0.85M，仍比上限低约 19–21%，但这份余量是留给
偏差的，不能用来把阶段放大。(2) 假 provider 固定回答，所以 `qualityFailed` 恒为 0，
**质量结论只能来自真实模型**。(3) 这个长度会把 `default` 的累计 prompt token 推到
5,288 万（fixed60 3,373 万、dynamic 2,527 万），执行器默认的 4,000 万 token 停机线
会在 `default` 中途触发，门禁显式传 4 亿；按这张表的费用量级，真实先导的
`--max-cost-usd` 应设在两位数美元以内、并在余额耗尽前留出余量。
(4) `dynamic` 的 17 次压缩全部由 FoldPoint 在空闲边界发起，远多于两条基线——它说明
语料长度已足以让策略反复触发，不构成任何成本优势结论。

生成物在 `traces/`（忽略提交）。旧的 13 阶段约 1230 万字符的
`traces/pi-source-d201760ff-pilot`、`-pilot-v2` 保留作历史，**不得再用作先导语料**：
它们的阶段会撞上限。已用这些**真实源码材料**及本地假服务跑完旧 13 阶段（原生
3 次、固定 60% 6 次、动态 3 次压缩）——那仍是旧语料的记录，阶段大小已按上表修正。

2026-09-27 的首次真实全量尝试**未构成三臂比较**：只有 Pi 默认组启动。第 4 阶段
请求 1,114,489 token，被 DeepSeek 的 1,048,576-token 窗口以 HTTP 400 拒绝；
后续出现 HTTP 402 `Insufficient Balance`。报告保留在忽略提交的
`traces/pi-million-paid-full-01-report.json`，`comparable=false`，其默认组估算
成本约 $1.17，但失败压缩没有完整 usage，不能当最终账单。原执行器把溢出恢复后的
回复按第一条 `agent_settled` 截取，错记阶段质量；已改为等待恢复后的 Pi idle 与
最后回复，并用本地 HTTP 400 / 402 回归测试锁定。旧报告的 `3/13` 不作为质量
结论。下一次正式比较必须先缩小阶段负载、重新冻结语料并获得足够余额；**不得**
直接重跑旧的 13 阶段全量命令。

2026-09-27 晚的**第二次真实先导**（`-small-v2` 语料、默认组）同样未被诊断为可比较：
`traces/pi-million-paid-pilot-01-report.json` 在第 68 阶段停止
（`reason: stage-68-no-successful-response`、`qualityFailed: 5`、
`unpricedCompactions: 1`、$0.95），轨迹
`traces/pi-million-paid-pilot-01-default.jsonl` 最后一条是溢出恢复时**失败的那次压缩**
（`reason: "overflow"`、`errorCode: "failed"`）。两个文件都已授权保留，**不覆盖、不删除、
不改动**，也不得当作任何策略比较的基线。它暴露的问题正是本节开头"失败证据"要解决的：
报告和轨迹都只说"压缩失败了"，**说不出是 429、瞬时 5xx 还是摘要被拒**，余额又已确认充足，
因此下一次付费运行前必须先补上这条证据链（现已在假服务上零付费验证）。

2026-09-27 深夜的**第三次真实先导**（同日、更远的第二次付费运行）走到第 102 阶段、$1.13，
**死在同一处**：`traces/pi-million-paid-pilot-02-report.json` 的三条 `failures` 全是
`call: "summary"`，`lastFailure = summary / error-without-status / no-status @ overflow`，
`assistantStopReasons: {stop: 101, length: 2}`，`hostRetryAttempts: 0`。三臂都没跑完
（只有默认组），`comparable=false`。两个文件同样**保留原样**。它把问题钉得更死：
失败不在材料调用上、不在 1M 上限上，而在**溢出恢复的摘要调用**上；而当时的口径
（只从显示文本里刮状态码）在那句话里找不到任何数字，所以三条记录**全都说不出原因**。
第三次先导之前先做两件事，两件都不花钱：把分类换成"结构化优先 + 固定枚举"，并把声明窗口
从 860k 降到 **800k**，给那次最大的单次请求留下余量。

三组固定使用 DeepSeek `deepseek-flash`、`--thinking off`、`temperature: 0`；
本地 Pi HTTP 回环测试已逐请求验证后两个参数实际发出，并逐请求验证三组的系统提示前缀
从最开头就不同。`--max-prompt-tokens` 与 `--max-cost-usd` 都是**每组每阶段完成后**
检查的停机线（累计输入 token / 已发生估算费用），**不是** provider 请求前的硬额度锁，
费用口径也不含摘要请求的部分输出费用。因此正式运行前仍应检查账户余额和模型价格；
输出的 `totalCost` 只是按 Pi 价格快照估计的已发生费用。触发任一条的组记为
`budget-truncated`（报告里同时有 `reason`/`budgetStop`/`stagesCompleted`/
`promptTokensTotal`/`totalCost`），该组不再是完整会话，`comparable=false`，
其低成本**不得**当作胜利。

先用真实模型只跑第 1 阶段、三组各一次；这一预检只验证模型能接入、返回格式和
三组隔离，`comparable` 必然为 `false`，不会被误当作 1M 成绩：

```powershell
$env:PI_CLI='D:\pi\packages\coding-agent\dist\bundle\cli.js'
$env:PI_NODE='C:\Users\freeze\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe'
$env:DEEPSEEK_API_KEY='在自己的终端输入，不要写入文件或聊天'
npx tsx tools/pi-million-rpc.ts --manifest traces\pi-source-d201760ff-small-v2\manifest.json --agent-base traces\pi-million-base --out traces\pi-million-paid-preflight-01 --max-stages 1 --min-compactions 0 --max-prompt-tokens 2000000 --max-cost-usd 1
```

预检若出现 `qualityFailed`、拒绝 1M 请求、未知缓存用量或未计价压缩，先查原因，
不要直接跑全量。每次 `--out` 都要用新名字，执行器拒绝覆盖旧轨迹。密钥只通过
当前 PowerShell 的环境变量传递；结束后可执行 `Remove-Item Env:DEEPSEEK_API_KEY`。
