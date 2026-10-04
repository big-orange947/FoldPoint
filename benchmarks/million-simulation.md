# 1M 零付费模拟：算法敏感性筛选

场景 324；每场景四个独立策略分支；付费调用 0。

价格全部为假设比例；未知剩余调用数，不提前告诉 FoldPoint 真实缓存命中。没有任务质量证明。

| 价格形状 | 对照 | 有压缩的场景 | 更便宜 / 相同 / 更贵 | 平均相对费用变化 |
| --- | --- | --- | --- | --- |
| cheapRead | nativeTiming | 72 | 68 / 0 / 4 | -22.01% |
| cheapRead | fixed60 | 72 | 12 / 0 / 60 | 8.03% |
| cheapRead | safety70 | 72 | 64 / 0 / 8 | -1.49% |
| writePremium | nativeTiming | 72 | 72 / 0 / 0 | -26.05% |
| writePremium | fixed60 | 72 | 4 / 0 / 68 | 9.41% |
| writePremium | safety70 | 72 | 64 / 0 / 8 | -2.01% |
| expensiveRead | nativeTiming | 72 | 72 / 0 / 0 | -29.63% |
| expensiveRead | fixed60 | 72 | 0 / 0 / 72 | 10.61% |
| expensiveRead | safety70 | 72 | 72 / 0 / 0 | -2.60% |

nativeTiming 只模拟原生阈值；fixed60 固定 60%；safety70 是无经济模型的 70% 防护基线，避免把安全阈值差异误当成动态算法优势。

cheapRead：经济触发 0 次，安全强制 246 次。
writePremium：经济触发 0 次，安全强制 246 次。
expensiveRead：经济触发 0 次，安全强制 246 次。

当前结果用于定位模型缺口，不用于宣传获胜。在这组未知 horizon、摘要按全输入冷计费的假设下，若经济触发为零，费用差主要来自安全边界和增长余量，而非价格驱动的主动选择。

历史数据核对（未用于调整参数）：已保留的 fixed60-full 与 dynamic70-20261003 轨迹共六次摘要，输入约为压缩前上下文的 97.28%–97.35%，摘要缓存命中均为 0，压后保留约 9.19%–9.53%。这支持全输入冷计费作为本任务的近似，但不是所有 Pi 任务的通用事实，也不能验证模拟中的固定增长、TTL 或质量假设。

## 假设与限制

- Hypothetical price ratios, not current provider quotes or bills.
- Independent state per strategy; fixed offered growth and output tokens. No task-quality measurement.
- All summaries succeed; summary truncation, content loss and provider rejection are not modeled.
- Summaries are billed as uncached full-input calls; no summary prompt-selection or cache-sharing model.
- Full-prefix cache with hard TTL. No cache warming or provider cache eviction model.
- nativeTiming reproduces only the threshold, not Pi's complete scheduler or summarizer.
- Scenario win counts are sensitivity cases, not real traffic prevalence. No parameter optimization.

每个分支拥有自己的上下文、缓存和学习状态。相同增长序列并不代表真实压缩后模型仍会走相同路径；费用结果不是旧轨迹的反事实重算。所有场景保留，不挑选获胜场景调参。
