# FoldPoint

**在合适的时候压缩 Agent 上下文。**

FoldPoint 是一个轻量级、感知提示词缓存与调用价格的**压缩时机决策器**。它不生成摘要，不删改消息，也不接管 Agent 的上下文；它只根据 token 数、缓存状态、价格和历史压缩效果，回答当前该 `KEEP`、`COMPACT` 还是 `FORCE`。

> 项目仍处于早期验证阶段。合成 benchmark 展示了潜力；真实 Pi 配对实验也证明“避免过早压缩”可能省钱，但**尚未证明动态算法明显优于调得合适的固定晚阈值**。任务质量和跨模型收益仍需验证。

## 它解决什么问题

固定在窗口的 70% 或 80% 压缩，无法回答一个更关键的问题：**现在花钱压缩，能否在接下来几次调用里回本？**

同样是长上下文，成本可能完全不同：

- 前缀仍在缓存中、缓存读取很便宜时，继续使用长上下文可能比重新写入摘要更省。
- 缓存已经失效、每轮都要重放完整输入时，提前压缩可能更划算。
- 压缩器本身要调用模型；如果压不掉多少内容，或者任务快结束了，这笔费用可能收不回来。
- 无论经济计算怎样，接近窗口上限时都必须保留安全余量。

FoldPoint 用短期盈亏平衡估计和安全门限作判断。它只处理**何时压缩**；如何摘要、保留哪些事实、是否最终执行，始终由宿主 Agent 决定。

| 决策 | 含义 |
| --- | --- |
| `KEEP` | 现在保留上下文更合适。 |
| `COMPACT` | 预计后续调用能抵消压缩及缓存重建成本，建议压缩。 |
| `FORCE` | 已触及窗口安全边界，建议宿主尽快在安全时机压缩。 |

`FORCE` 也不是对宿主的强制命令。如果当前处于工具执行中等不安全边界，宿主仍需自行处理。每次决策都附带原因码、置信度和成本指标，便于审计。

## 当前能做什么

- **本地、常数时间决策**：核心零运行时依赖，不调用 LLM，不联网，不读取对话正文或工具输出。
- **按会话隔离、按配置学习**：每个会话有独立运行状态；同一模型、窗口和压缩器共享压缩保留率、缓存覆盖率等统计经验。
- **区分本次与未来调用**：本次缓存是否失效、写入要花多少钱，与未来调用可复用多少前缀分别估计；不会把一次缓存过期当成之后每次都必然过期。
- **接收真实反馈**：宿主在模型调用后上报 token 用量，在压缩后上报压缩前后长度与费用，FoldPoint 才能逐渐替换冷启动估计。
- **安全保护**：冷却期、最小回收量、置信度折扣、窗口预留和失败尝试处理，避免为了很小的预计收益反复压缩。
- **可观测轨迹**：`TraceRecorder` 将决策前估计与请求后的真实用量分开记录；离线分析可以检查预测误差和会话成本。

核心只接收数字和标识符，不包含正文。**轨迹仍可能暴露模型、时间和使用频率**，应按日志保护，不能视为完全匿名数据。

## 快速体验

目前建议从源码运行，不把“可运行示例”等同于已发布、开箱即用的宿主插件：

```bash
npm ci
npm run typecheck
npm test
npm run example:basic
```

完整的最小接入代码在 [`examples/basic.ts`](examples/basic.ts)。接入宿主需要四个时机：

1. **调用模型前**：传入当前上下文长度、缓存线索、窗口大小和价格，调用 `decide()`。
2. **模型返回后**：把实际 prompt、缓存读取、缓存写入和输出 token 通过 `observeRequest()` 反馈。
3. **压缩结束后**：由宿主执行压缩，再通过 `recordCompaction()` 上报成功、前后长度及用量；失败也应上报。
4. **会话结束时**：调用 `endSession()`，让学习器获得实际剩余调用数，并清理会话状态。

简化示意（`hostAgent` 由接入方实现）：

```ts
import { FoldPoint } from "foldpoint";

const foldPoint = new FoldPoint();
const sessionId = crypto.randomUUID();
const profile = {
  provider: "example",
  model: "example-model",
  contextWindowTokens: 200_000,
  compactorId: "native-summary-v1",
  pricing: {
    currency: "USD",
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
  },
  cachePolicy: { ttlMs: 300_000 },
};

const decision = foldPoint.decide({
  sessionId,
  profile,
  timestamp: Date.now(),
  contextTokens: estimatedNextPromptTokens,
  safeBoundary: true,
  compactionAllowed: true,
});

if (decision.action !== "KEEP") {
  const result = await hostAgent.compact();
  foldPoint.recordCompaction(sessionId, profile, {
    timestamp: Date.now(),
    beforeTokens: result.beforeTokens,
    afterTokens: result.afterTokens,
    promptTokens: result.usage.inputTokens,
    outputTokens: result.usage.outputTokens,
    success: true,
  });
}

// 每次普通模型调用结束后：
foldPoint.observeRequest(sessionId, profile, {
  timestamp: Date.now(),
  promptTokens: usage.promptTokens,
  cachedInputTokens: usage.cacheReadTokens,
  cacheWriteTokens: usage.cacheWriteTokens,
  outputTokens: usage.outputTokens,
});

foldPoint.endSession(sessionId, profile, { timestamp: Date.now() });
```

上面展示的是接线关系，不是可直接运行的完整程序。**调用前不能把尚未发生的缓存命中当作已知值**；`cachedTokens` 只有宿主确实拥有该线索时才传。缓存用量“未上报”也不等于“命中 0”。价格未知时可以使用 `tokenOnlyPricing()`，但此时得到的是归一化 token 成本，不能解读为美元。

详细契约见[接入说明](docs/integration.md)，算法及默认参数见[算法文档](docs/algorithm.md)。状态可用 `exportState()` / `importState()` 持久化，里面没有消息正文或密钥。

## Pi 适配器

仓库包含一个**实验性** [Pi 扩展](adapters/pi/foldpoint-observe.ts)。默认仅观察和记录；显式设置 `FOLDPOINT_MODE=act` 后，它可以否决 Pi 因阈值触发的压缩，但不会否决用户手动压缩或溢出恢复，也不会替换 Pi 的摘要器。它不是 npm 包内已打磨完成的 Pi 插件。

Pi 自身的缓存预热会发送额外的付费请求。适配器把成功预热单独记账，并避免把跨预热的两次请求当成自然缓存存活证据。比较压缩时机时，预热开关必须在各组保持一致；生产环境不因 FoldPoint 自动关闭 Pi 预热。[Pi 接入与实验手册](docs/pi-runbook.md)记录了运行方式、权限边界与限制。

## 已有评测，以及不能声称什么

### 合成 benchmark

`npm run benchmark` 运行 11 类可复现的合成场景，并与固定阈值等基线比较。它能验证计费公式、缓存分支、失败与窗口安全行为；不能证明真实 Agent 的任务质量。[方法与原始报告](benchmarks/README.md)包含场景、数字和反事实结算口径。

### 真实 Pi + DeepSeek 配对试验

最新一轮使用真实 DeepSeek 请求，四组策略、两种合成任务、每组两轮，**16/16 任务产物检查通过**。为了在短任务中触发压缩，实验把 Pi 报告给该模型的窗口从正常的 1M **人为限制为 26K**，并在四组都关闭缓存预热。因此下表只反映这一受控压力条件，费用由 provider 用量和 Pi 价格表估算，未经账单核对：

| 策略 | 4 次运行估算总费用 | 成功压缩 |
| --- | ---: | ---: |
| Pi 默认阈值 | $0.099563 | 21 |
| 仅提前阈值 | $0.113532 | 22 |
| 提前阈值 + FoldPoint | $0.055050 | 4 |
| **固定晚阈值** | **$0.057297** | **4** |

FoldPoint 相比固定晚阈值只低约 **3.9%**，调用路径也有波动；在这么小的样本中，**无法证明动态算法比简单晚压缩更强**。目前能稳妥说的是：这类条件下，避免过早压缩、减少缓存失效和压缩调用，有降低费用的潜力。不能把对 Pi 默认设置的优势宣称为对最佳固定策略的优势，更不能外推到默认 1M 窗口。

详见[固定晚阈值对照报告](benchmarks/pi-fixed-late-2026-09-24.md)和[此前三组试验](benchmarks/pi-real-paired-2026-09-24.md)。下一步需要更真实、异质的长任务、更多重复、工具行为与结果质量检查，以及在已验证缓存 TTL 的模型上分开测试预热开关。满足这些条件之前，不计划向 Pi 上游推销内置算法。

另有一项[真实代码修复探针](benchmarks/pi-ledger-probe-2026-09-25.md)：四组均通过独立的 5 项 oracle 测试，但全部 **0 次压缩**。这组费用差异不计为 FoldPoint 收益，作为短任务的负对照保留。

[完整仓库的注入回归探针](benchmarks/pi-pricing-probe-2026-09-25.md)四组也都通过质量门，FoldPoint 否决了 9 次过早压缩；但仅一轮、解题调用数差异大，而且两组失败压缩没有用量，不能据此宣称费用优势。对照报告现会排除未定价失败或双方零压缩的配对。

现在还加入了[不同价格比例的先导试验](benchmarks/pi-price-ratio-plan.md)：执行模型仍是 DeepSeek，假设价格会进入 FoldPoint 决策和同一份轨迹的费用计算。首轮“缓存读取较贵”情景没有显示动态策略优于固定晚阈值；这是需要继续检验的负面结果，不是 Claude 的实测结论。

## 边界与限制

- FoldPoint 不知道摘要是否遗漏重要信息，只能通过较少压缩、安全边界和宿主反馈降低风险，**省钱不等于任务质量更好**。
- 剩余调用数和后续缓存存活是预测；短期盈亏平衡不是全局最优控制器。
- 首次使用只能依赖冷启动先验。不同模型、价格制度、缓存策略或压缩器的经验不能混用。
- 没有缓存读取折扣或可靠用量时，成本估计会退化；缺失字段不应伪装成 0。
- Pi 扩展目前只能控制其阈值压缩是否放行，不能保证在任意调用边界主动压缩；其他宿主需自行接线。
- 轨迹只存元数据，但时间戳和模型使用模式仍具有隐私风险。

更多细节见[限制说明](docs/limitations.md)与[轨迹格式](docs/traces.md)。

## 开发与项目结构

`src/` 是独立决策核心；`adapters/pi/` 是实验性宿主适配；`benchmarks/` 保存合成与真实试验方法；`tools/` 提供轨迹分析和配对运行器；`docs/` 存放算法、接入及限制说明。

```bash
npm ci
npm run typecheck
npm run lint
npm test
npm run build
npm run benchmark
npm run trace:capture
npm run trace:analyze -- traces/example.jsonl
```

核心没有运行时依赖，不要求 Node 专属 API。许可证为 [MIT](LICENSE)。
