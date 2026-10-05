# 单周期资格假设：完整任务消融

负数为完整模拟费用更低，不是完整递归一致性证明。

| 冻结价格 | 计费假设 | 配对 vs 60% | 单周期 vs 60% | 胜/负 | 最差变化 | 单周期 vs 配对 | 配对/单周期经济压缩 | 单周期强制压缩 | 拒绝次数 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| deepseek-flash-peak | summary-uncached | 0.51% | 0.34% | 2/2 | 0.80% | -0.16% | 11/0 | 34 | 618 |
| deepseek-flash-peak | hypothetical-summary-shared-80 | 0.52% | 1.11% | 0/4 | 1.29% | 0.60% | 5/0 | 34 | 618 |
| deepseek-flash-peak | hypothetical-shared-80-prewarm-1 | 0.66% | 1.11% | 0/4 | 1.28% | 0.45% | 4/0 | 34 | 618 |
| deepseek-flash-offpeak | summary-uncached | 0.51% | 0.34% | 2/2 | 0.80% | -0.16% | 11/0 | 34 | 618 |
| deepseek-flash-offpeak | hypothetical-summary-shared-80 | 0.52% | 1.11% | 0/4 | 1.29% | 0.60% | 5/0 | 34 | 618 |
| deepseek-flash-offpeak | hypothetical-shared-80-prewarm-1 | 0.66% | 1.11% | 0/4 | 1.28% | 0.45% | 4/0 | 34 | 618 |
| deepseek-v4-pro-peak | summary-uncached | -0.97% | 0.98% | 0/4 | 1.19% | 2.01% | 25/0 | 34 | 618 |
| deepseek-v4-pro-peak | hypothetical-summary-shared-80 | -2.38% | -1.87% | 1/3 | 2.40% | 0.50% | 23/16 | 29 | 484 |
| deepseek-v4-pro-peak | hypothetical-shared-80-prewarm-1 | -2.80% | -1.86% | 1/3 | 2.39% | 0.94% | 22/16 | 29 | 484 |
| claude-sonnet-5.5-5m-price | summary-uncached | -12.63% | -3.11% | 1/3 | 3.62% | 10.90% | 63/16 | 29 | 485 |
| claude-sonnet-5.5-5m-price | hypothetical-summary-shared-80 | -20.43% | -19.80% | 4/0 | -5.98% | 0.66% | 83/79 | 4 | 46 |
| claude-sonnet-5.5-5m-price | hypothetical-shared-80-prewarm-1 | -19.70% | -18.81% | 4/0 | -6.20% | 1.02% | 79/74 | 5 | 59 |
| claude-sonnet-5.5-1h-price | summary-uncached | -7.05% | 0.45% | 1/3 | 3.47% | 8.51% | 47/9 | 32 | 574 |
| claude-sonnet-5.5-1h-price | hypothetical-summary-shared-80 | -17.34% | -14.53% | 3/1 | 3.16% | 3.08% | 71/53 | 13 | 187 |
| claude-sonnet-5.5-1h-price | hypothetical-shared-80-prewarm-1 | -16.88% | -14.27% | 3/1 | 3.15% | 2.85% | 76/56 | 14 | 206 |
| claude-opus-5.5-5m-price | summary-uncached | 1.29% | 1.59% | 0/4 | 1.77% | 0.29% | 4/2 | 34 | 612 |
| claude-opus-5.5-5m-price | hypothetical-summary-shared-80 | -7.24% | -4.73% | 2/2 | 1.99% | 2.63% | 44/23 | 26 | 425 |
| claude-opus-5.5-5m-price | hypothetical-shared-80-prewarm-1 | -8.36% | -3.61% | 1/3 | 1.98% | 5.24% | 57/21 | 27 | 434 |
| gemini-2.5-flash-text | summary-uncached | -12.44% | -3.51% | 2/2 | 2.57% | 10.26% | 64/17 | 28 | 477 |
| gemini-2.5-flash-text | hypothetical-summary-shared-80 | -20.17% | -19.47% | 4/0 | -7.20% | 0.78% | 82/79 | 3 | 36 |
| gemini-2.5-flash-text | hypothetical-shared-80-prewarm-1 | -20.10% | -19.51% | 4/0 | -6.97% | 0.66% | 86/84 | 3 | 38 |
| gemini-2.5-flash-lite-text | summary-uncached | -14.65% | -4.77% | 2/2 | 2.66% | 12.03% | 86/23 | 27 | 442 |
| gemini-2.5-flash-lite-text | hypothetical-summary-shared-80 | -22.65% | -22.49% | 4/0 | -10.36% | 0.18% | 92/90 | 1 | 22 |
| gemini-2.5-flash-lite-text | hypothetical-shared-80-prewarm-1 | -21.87% | -21.28% | 4/0 | -8.41% | 0.65% | 86/83 | 2 | 28 |

## 短任务

| 计费假设 | 数量 | 比配对更贵 | 比配对最差变化 | 比 60%最差变化 |
| --- | --- | --- | --- | --- |
| summary-uncached | 21 | 0 | 0.00% | 13.15% |
| hypothetical-summary-shared-80 | 21 | 1 | 6.29% | 13.15% |
| hypothetical-shared-80-prewarm-1 | 21 | 1 | 3.11% | 14.15% |

## 限制

- 只增加 single-cycle 资格假设：当前与预测中的经济候选都要在 KEEP 下一次安全压缩前，按相同存活先验和压力预测覆盖摘要/重建/预热费用及收益余量；安全 FORCE 不受影响。它不是全任务省钱的数学必要条件。
- 闭式折现未来缓存节省，不递归求解。当前仍需通过原 NOW/WAIT 整体收益门，未来没有完全复用那项门。因此这不是完整策略一致性修复。
- 截断周期是额外保守假设，可能排除跨安全压缩后才能兑现的长期收益。拒绝更多压缩不代表性能改善，必须保留所有负结果。
- 96 组已见暖缓存长任务，旧/配对/固定 60% 控制原样保留。63 组短任务首请求建缓存；缓存共享是假设、质量未验证，默认核心/Pi 未切换。
