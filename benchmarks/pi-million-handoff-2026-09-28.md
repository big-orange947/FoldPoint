# 1M 三臂试验：交接说明（2026-09-28）

> **接手复核更正（同日）**：本文件下方“摘要输出预算不够已排除”“仍然未知”的判断
> 已被真实失败输入重放推翻。直接调用 Pi 的 `generateSummaryWithUsage` 重放 `pilot-02`
> 摘要，在 4,096 输出上限下 25 秒触顶；重放 `pilot-03` 在 13,107 下 45 秒触顶，
> 同一输入提高至 32,768 仍于 94 秒触顶。合成重复文本探针只说明那类文本容易摘要，
> 不能外推到本源码定位语料。当前结论与停跑决定见
> [pi-million-trial-plan.md](pi-million-trial-plan.md) 开头的“2026-09-28 复核”。
> 下文的“工作区状态”和“下一步”是 DeepSeek 交接当时的快照，不代表本次接手后的状态。

交接给下一位接手者。这份文档只讲**当前实际状态**、**已经用证据排除的东西**、**还没解决的问题**，
以及**不能碰的红线**。带数字的结论都能在 `traces/` 的产物里核对。

## 一句话现状

四份真实付费记录，**全部是失败记录**，按预登记判据**没有一份构成三臂比较**。
策略对比问题（动态时机 vs 固定 60% 阈值）在这四轮里**没有获得任何新证据**。
但工具链、诊断能力、以及几条关于真实 DeepSeek 行为的校准数据是真拿到了。

## 工作区状态（重要）

- HEAD = `58d4338`，与 `origin/main` 同步，**但工作区有 8 个文件未提交**：
  6 个修改（`benchmarks/pi-million-trial-plan.md`、`tests/pi-million-config.test.ts`、
  `tests/pi-million-rpc.test.ts`、`tools/pi-million-config.ts`、`tools/pi-million-rpc.ts`、
  `tools/pi-million-source-corpus.ts`）+ 2 个新增（`tools/pi-million-summary-probe.ts`、
  `tests/pi-million-summary-probe.test.ts`）。
- **这些改动是承重的**：窗口 800k、摘要上限 13107、等待上限 900s、失败分类、探针脚本、
  以及门禁里的新断言全在里面。接手第一件事应该是决定**提交它们**，否则下次付费跑无法
  从提交历史复现工具版本。
- 全量 `npx vitest run` 269 条通过 / 1 跳过（跳过的是需要 `PI_CLI` 的重集成测试）；
  `npx tsc --noEmit`、`npx biome check .` 干净。

## 四份失败记录（全部原样保留，不得覆盖、不得纳入比较）

| 记录 | 停止点 | 花费 | 关键证据 |
| --- | --- | ---: | --- |
| `traces/pi-million-paid-full-01-report.json` | 第 4 阶段 | ~$1.17 | 旧 13 阶段语料；单阶段过大，请求 1,114,489 token 被 HTTP 400 拒绝，随后 402 |
| `traces/pi-million-paid-pilot-01-report.json` | 阶段 68 | $0.95 | `stage-68-no-successful-response`；`qualityFailed: 5`；`unpricedCompactions: 1` |
| `traces/pi-million-paid-pilot-02-report.json` | 阶段 102 | $1.13 | `lastFailure = summary / error-without-status @ overflow`；`assistantStopReasons {stop:101, length:2}` |
| `traces/pi-million-paid-pilot-03-report.json` | 阶段 63 | $0.646 | `lastFailure = summary / rpc-lost @ threshold`；进程仍在运行 |

另有 `traces/pi-million-paid-preflight-01-*`（早期预检，同样不构成比较）。
累计花费约 **$2.96**（含今天的探针 $0.23）。

**共同点**：四次失败全部落在**压缩（compaction）路径**上，不同层：
单阶段过大撞上限 → 无状态码的压缩失败 → 等待超时。

## 已经用证据排除的候选死因

1. **余额不足**：用户确认余额充足（且 402 只在最早的 full-01 出现过）。
2. **撞 provider 的 token 上限**：从未出现过 400；且探针证明 `字节/4` 这个代理值
   **高估**约 19%（见下）。
3. **摘要输出预算不够**：探针实测一份 ~57 万 token 上下文的摘要**只用了 365 个输出 token**，
   `finish_reason: "stop"`，判定 `budget-sufficient`。上限 13107 远远够用——所以
   "4096 导致摘要截断"这个解释**同样站不住**（pilot-02 里那两条 `length` 是**助手回复**
   撞上限，不是摘要；摘要调用不走 `message_end`）。
4. **摘要耗时超过 runner 的 30 秒等待**：探针实测 **11.6 秒**。900 秒的等待上限在方向上
   无害，但前提是错的。

## 仍然未知（这是当前真正的阻塞点）

**压缩为什么失败。** 排除了上面四条之后，剩下更像 provider 侧偶发失败、流式/宿主侧中断，
但没有证据。第 3 次先导补上的 `event-timeout`（子进程还活着，我们等超时）与
`process-exit`（进程真的退出）区分**尚未在真实失败上验证过**——那是下次失败时最有价值的字段。

## 值得保留的实测数字（这几轮真正的产出）

- **缓存模型在真实规模上成立**：pilot-02 最后一次请求 867,166 prompt token 中
  841,600 命中缓存 = **97%**；46.2M token 花费 $1.13。此前只在 26K 规模校准过。
- **tokenizer 校准**：`字节/4` 估 709,266 → provider 实际 **574,692**，
  即该代理值**高估约 19%**（与我们此前假设的低估相反）。
- **压缩便宜且快**：57 万 token 上下文 → 摘要 **11.6 秒 / 365 输出 token**。
- **唯一一次真实质量信号**：pilot-01 在 68 个阶段里**答错 5 个**
  （环回里恒为 0，因为假 provider 永远答对）。

## 门禁与语料（现状，不要悄悄改）

- 冻结语料：`traces/pi-source-d201760ff-small-v2/manifest.json`，sha256
  `30af2cefb985df9648d607fe903edd48056499d901da07769a3c714423bc831b`，
  128 阶段、约 1156 万字符、最大阶段 106,166 字符，源为 Pi commit
  `d201760ffee16564aa8d9a759e0c85b70db33674`。
- 三臂：`default`（阈值 783,616）/ `fixed60`（480,000）/ `dynamic`（act + auto）。
  窗口 800,000（"1M 模型、800k 运行预算"，不得宣传为跑满 1M）。
- 零付费门禁 `tests/pi-million-rpc.test.ts` 要求：三臂各 **≥2 次压缩**、
  **0 次被 1,048,576 拒绝**、三臂 `user_id` 与系统提示前缀互不相同、
  摘要请求体 `max_tokens` 全为 13107。**这些断言不得为了通过而放宽。**
- **结构性局限**：假 provider 秒回、永远答对、摘要永不变长，因此
  **provider 侧的压缩失败、摘要截断、超时它都看不见**。四轮付费失败全部发生在它看不见的地方。

## 红线（不得违反）

1. 不得调整 FoldPoint 核心决策参数（`softWindowRatio`、`hardWindowRatio`、
   `minNetSaving`、`FOLDPOINT_MIN_COMPACT_TOKENS` 等）来迎合结果。
2. 不得覆盖、删除或修改 `traces/` 下任何已有产物，尤其四份失败记录。
3. 不得放宽门禁断言、不得放宽假服务的 1,048,576 拒绝。
4. 密钥只经进程环境变量传递，**不得写入任何文件、日志、报告或对话产物**；
   本次会话用过的 key 建议作废轮换。
5. 不得修改 `D:\pi`（只读）。不要用 PowerShell 的 `Set-Content` 改源文件
   （会写 BOM + CRLF，biome 会报错）。
6. 发布口径：单份冻结任务上的先导结果只能写成"这一份任务上的先导结果"，
   标签 `preview`/`beta`，不得写普遍性省钱百分比；没赢就如实发负结果与适用边界。

## 下一步的三个选项（按性价比）

1. **定向压缩探针**（约 $0.2–0.3）：把窗口调小、只跑很短一段，逼出一次真实阈值压缩，
   直接观察它在真实 API 上如何失败。比全量跑便宜一个数量级，且不依赖 128 阶段。
2. **退回能稳定跑完的规模**：26K 窗口的队列曾是跑通的（`benchmarks/pi-claude-like-*`），
   在那里做重复数是现实选择，代价是外部效度更低。
3. **停在这里**：把已有数据写成一份诚实的失败报告（工具链 + 校准数据 + 四份失败记录 +
   明确的未知），不宣称任何策略结论。

无论走哪条，**先提交工作区**，并回答一个问题：在能把"压缩为什么失败"解释清楚之前，
任何一次全量付费跑的失败期望值都太高。
