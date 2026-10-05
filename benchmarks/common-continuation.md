# 共同 WAIT 后续策略：完整任务消融

负数表示完整模拟账单更低。不是全局最优或真实任务质量证明。

| 冻结价格 | 计费假设 | 配对 vs 60% | 共同后续 vs 60% | 共同 vs 配对 | 胜/负 | 最差变化 | 配对/共同经济压缩 | 共同强制压缩 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| deepseek-flash-peak | summary-uncached | 0.51% | 0.51% | 0.00% | 2/2 | 1.57% | 11/11 | 32 |
| deepseek-flash-peak | hypothetical-summary-shared-80 | 0.52% | 0.52% | 0.00% | 1/3 | 1.29% | 5/5 | 29 |
| deepseek-flash-peak | hypothetical-shared-80-prewarm-1 | 0.66% | 0.66% | 0.00% | 1/3 | 1.28% | 4/4 | 30 |
| deepseek-flash-offpeak | summary-uncached | 0.51% | 0.51% | 0.00% | 2/2 | 1.57% | 11/11 | 32 |
| deepseek-flash-offpeak | hypothetical-summary-shared-80 | 0.52% | 0.52% | 0.00% | 1/3 | 1.29% | 5/5 | 29 |
| deepseek-flash-offpeak | hypothetical-shared-80-prewarm-1 | 0.66% | 0.66% | 0.00% | 1/3 | 1.28% | 4/4 | 30 |
| deepseek-v4-pro-peak | summary-uncached | -0.97% | -0.97% | 0.00% | 2/2 | 1.19% | 25/25 | 29 |
| deepseek-v4-pro-peak | hypothetical-summary-shared-80 | -2.38% | -2.38% | 0.00% | 2/2 | 2.44% | 23/23 | 19 |
| deepseek-v4-pro-peak | hypothetical-shared-80-prewarm-1 | -2.80% | -2.79% | 0.01% | 2/2 | 1.49% | 22/22 | 20 |
| claude-sonnet-5.5-5m-price | summary-uncached | -12.63% | -12.63% | 0.00% | 4/0 | -1.16% | 63/63 | 4 |
| claude-sonnet-5.5-5m-price | hypothetical-summary-shared-80 | -20.43% | -20.40% | 0.04% | 4/0 | -9.56% | 83/83 | 0 |
| claude-sonnet-5.5-5m-price | hypothetical-shared-80-prewarm-1 | -19.70% | -19.70% | 0.00% | 4/0 | -8.49% | 79/79 | 0 |
| claude-sonnet-5.5-1h-price | summary-uncached | -7.05% | -7.00% | 0.04% | 3/1 | 3.25% | 47/43 | 8 |
| claude-sonnet-5.5-1h-price | hypothetical-summary-shared-80 | -17.34% | -17.34% | 0.00% | 4/0 | -4.59% | 71/71 | 0 |
| claude-sonnet-5.5-1h-price | hypothetical-shared-80-prewarm-1 | -16.88% | -16.97% | -0.10% | 4/0 | -4.05% | 76/76 | 0 |
| claude-opus-5.5-5m-price | summary-uncached | 1.29% | 1.59% | 0.29% | 0/4 | 1.77% | 4/2 | 34 |
| claude-opus-5.5-5m-price | hypothetical-summary-shared-80 | -7.24% | -7.24% | 0.00% | 3/1 | 1.87% | 44/44 | 10 |
| claude-opus-5.5-5m-price | hypothetical-shared-80-prewarm-1 | -8.36% | -8.04% | 0.32% | 3/1 | 3.44% | 57/57 | 10 |
| gemini-2.5-flash-text | summary-uncached | -12.44% | -12.44% | 0.00% | 4/0 | -1.53% | 64/64 | 2 |
| gemini-2.5-flash-text | hypothetical-summary-shared-80 | -20.17% | -20.17% | 0.00% | 4/0 | -10.05% | 82/82 | 0 |
| gemini-2.5-flash-text | hypothetical-shared-80-prewarm-1 | -20.10% | -20.10% | 0.00% | 4/0 | -9.38% | 86/86 | 0 |
| gemini-2.5-flash-lite-text | summary-uncached | -14.65% | -14.65% | 0.00% | 4/0 | -0.15% | 86/86 | 2 |
| gemini-2.5-flash-lite-text | hypothetical-summary-shared-80 | -22.65% | -22.72% | -0.08% | 4/0 | -11.28% | 92/91 | 0 |
| gemini-2.5-flash-lite-text | hypothetical-shared-80-prewarm-1 | -21.87% | -21.83% | 0.05% | 4/0 | -10.58% | 86/87 | 0 |

## 短任务

| 计费假设 | 数量 | 比配对更贵 | 比配对更便宜 | 比 60% 最差变化 |
| --- | --- | --- | --- | --- |
| summary-uncached | 21 | 0 | 0 | 13.15% |
| hypothetical-summary-shared-80 | 21 | 0 | 0 | 13.15% |
| hypothetical-shared-80-prewarm-1 | 21 | 0 | 0 | 14.15% |

## 限制

- WAIT 按名义费用选择首压类型与重复边界，NOW 复用同一重复边界；压力分支也保持这一策略。每条路径独立计费、保留各自缓存/冷却/保留量。
- 这是相对一个共同 WAIT 基线策略的单步改进评估，不是全局最优控制或完整递归一致性修复；下一次真实决策仍会重新选策略，未来未复用完整当前收益门。
- 不增加单周期回本限制；继续先验、压力幅度、余量、风险和原候选范围不变。不因特定模型或任务调整参数。
- 96 组已见长任务与 63 组短任务，保留旧/配对/固定 60% 控制；完整费用包含普通输出、摘要与预热。历史采集成本单列，不冒充当前费用。
- 冻结价格比例、假设摘要共享缓存及预热为合成条件，不是真实模型实测。默认核心/Pi 未改，无质量结论。
