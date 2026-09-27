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

首批语料采用可复现的长文任务生成器：每阶段有真实需要理解的资料、有限的
干扰项和独立保存的标准答案；在压缩前后都有跨阶段问题。禁止把标准答案文件
暴露给 agent，材料分批进入模型可见上下文，不能仅停留在工作区文件中。
后续可从公开长文语料选取材料，但改造后的分阶段分数不能称作原基准分数。
语料按实际 provider token 用量标定，不按字符数预判阈值。

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
至少两次成功压缩**时出现；任一组的阶段断言失败、轨迹缺失、未知缓存用量或压缩
费用缺失均不视为成功。命令在不能比较时非零退出。`totalCost` 是 Pi 的价格快照
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
下一步先冻结长文任务材料、答案与停机预算，然后才需要 API key。
