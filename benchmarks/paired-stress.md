# 名义策略配对压力检查：固定 60% 对照

负数为完整模拟账单更低；没有模型实测或质量证明。

| 冻结价格 | 计费假设 | 旧 vs 60% | 配对 vs 60% | 胜/负 | 最差变化 | 配对 vs 旧 | 旧/配对经济压缩 | 旧/配对最长等待 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| deepseek-flash-peak | summary-uncached | 0.48% | 0.51% | 2/2 | 1.57% | 0.04% | 5/11 | 26/25 |
| deepseek-flash-peak | hypothetical-summary-shared-80 | 0.52% | 0.52% | 1/3 | 1.29% | 0.00% | 5/5 | 26/26 |
| deepseek-flash-peak | hypothetical-shared-80-prewarm-1 | 0.66% | 0.66% | 1/3 | 1.28% | 0.00% | 4/4 | 26/26 |
| deepseek-flash-offpeak | summary-uncached | 0.48% | 0.51% | 2/2 | 1.57% | 0.04% | 5/11 | 26/25 |
| deepseek-flash-offpeak | hypothetical-summary-shared-80 | 0.52% | 0.52% | 1/3 | 1.29% | 0.00% | 5/5 | 26/26 |
| deepseek-flash-offpeak | hypothetical-shared-80-prewarm-1 | 0.66% | 0.66% | 1/3 | 1.28% | 0.00% | 4/4 | 26/26 |
| deepseek-v4-pro-peak | summary-uncached | 0.60% | -0.97% | 2/2 | 1.19% | -1.54% | 23/25 | 27/26 |
| deepseek-v4-pro-peak | hypothetical-summary-shared-80 | -0.13% | -2.38% | 2/2 | 2.44% | -2.32% | 10/23 | 27/16 |
| deepseek-v4-pro-peak | hypothetical-shared-80-prewarm-1 | 0.03% | -2.80% | 2/2 | 1.49% | -2.90% | 8/22 | 27/14 |
| claude-sonnet-5.5-5m-price | summary-uncached | -6.78% | -12.63% | 4/0 | -1.16% | -6.10% | 46/63 | 21/14 |
| claude-sonnet-5.5-5m-price | hypothetical-summary-shared-80 | -17.84% | -20.43% | 4/0 | -9.56% | -2.89% | 70/83 | 9/7 |
| claude-sonnet-5.5-5m-price | hypothetical-shared-80-prewarm-1 | -15.97% | -19.70% | 4/0 | -8.49% | -3.97% | 65/79 | 11/8 |
| claude-sonnet-5.5-1h-price | summary-uncached | 1.60% | -7.05% | 3/1 | 3.07% | -8.44% | 4/47 | 26/15 |
| claude-sonnet-5.5-1h-price | hypothetical-summary-shared-80 | -11.36% | -17.34% | 4/0 | -4.59% | -5.94% | 48/71 | 13/8 |
| claude-sonnet-5.5-1h-price | hypothetical-shared-80-prewarm-1 | -9.67% | -16.88% | 4/0 | -3.68% | -7.08% | 42/76 | 13/9 |
| claude-opus-5.5-5m-price | summary-uncached | 1.59% | 1.29% | 0/4 | 1.77% | -0.29% | 2/4 | 26/26 |
| claude-opus-5.5-5m-price | hypothetical-summary-shared-80 | -4.68% | -7.24% | 3/1 | 1.87% | -2.55% | 26/44 | 16/13 |
| claude-opus-5.5-5m-price | hypothetical-shared-80-prewarm-1 | -7.65% | -8.36% | 3/1 | 2.15% | -0.73% | 54/57 | 15/11 |
| gemini-2.5-flash-text | summary-uncached | -5.71% | -12.44% | 4/0 | -1.53% | -7.03% | 52/64 | 23/14 |
| gemini-2.5-flash-text | hypothetical-summary-shared-80 | -16.59% | -20.17% | 4/0 | -10.05% | -3.95% | 68/82 | 10/7 |
| gemini-2.5-flash-text | hypothetical-shared-80-prewarm-1 | -15.75% | -20.10% | 4/0 | -9.38% | -4.47% | 69/86 | 13/7 |
| gemini-2.5-flash-lite-text | summary-uncached | -11.32% | -14.65% | 4/0 | -0.15% | -3.36% | 80/86 | 21/14 |
| gemini-2.5-flash-lite-text | hypothetical-summary-shared-80 | -21.73% | -22.65% | 4/0 | -11.00% | -1.00% | 87/92 | 8/7 |
| gemini-2.5-flash-lite-text | hypothetical-shared-80-prewarm-1 | -20.01% | -21.87% | 4/0 | -10.75% | -2.18% | 79/86 | 13/7 |

## 短任务损失面

| 计费假设 | 样本数 | 配对比旧更贵的次数 | 配对 vs 旧最差变化 | 配对 vs 60%最差变化 |
| --- | --- | --- | --- | --- |
| summary-uncached | 21 | 0 | 0.00% | 13.15% |
| hypothetical-summary-shared-80 | 21 | 0 | 0.00% | 13.15% |
| hypothetical-shared-80-prewarm-1 | 21 | 0 | 0.00% | 14.15% |

## 限制

- 只修改 WAIT 压力对照的选择语义：与 NOW 一样，先按名义预测选策略，再压力测试同一个策略。继续概率、压力幅度、收益余量、安全与执行门均未放宽。
- 旧方式是在压力情景里独立取最便宜 WAIT，是额外保守的包络比较；它不是少收费的账本错误。新方式不是对所有 WAIT 策略的最坏情形保证。
- 未来重复压缩仍未完整复用当前的收益/压力门，本轮没有修复完整递归预测一致性；不能称为该问题已全部解决。
- 96 组长任务沿用上一轮完整控制，固定 60% 费用、增长指纹和历史费用逐项匹配；组合已看过，不是盲测。缓存共享仍为假设，任务质量未验证，默认核心/Pi 未切换。
- 63 组短任务从 500k 上下文开始，首个普通请求建立缓存，包含一轮结束及 4/12 轮结束；用于检查损失面，不是新暖缓存长任务收益样本。
