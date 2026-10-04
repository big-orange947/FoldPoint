# 时机余量与费用归因：暖缓存实验

负数更省，余量比例固定为 10%，仅改余量尺度。

| 价格 | 分组 | 对照 | 胜/负/平 | 平均变化 | 最差变化 | 压缩次数 |
| --- | --- | --- | --- | --- | --- | --- |
| deepseek-flash-peak | dev-warm-long | fixed60/fixed60 | 10/2/0 | -7.70% | 4.19% | 247 |
| deepseek-flash-peak | dev-warm-long | frozenFixed/fixed70 | 10/2/0 | -6.11% | 1.16% | 247 |
| deepseek-flash-peak | dev-warm-long | durationMixture/durationMixture | 8/0/4 | -6.36% | 0.00% | 247 |
| deepseek-flash-peak | near-end | fixed60/fixed60 | 1/0/0 | -49.93% | -49.93% | 0 |
| deepseek-flash-peak | near-end | frozenFixed/fixed70 | 0/0/0 | — | — | 0 |
| deepseek-flash-peak | near-end | durationMixture/durationMixture | 0/0/0 | — | — | 0 |
| deepseek-flash-peak | validation-warm | fixed60/fixed60 | 7/1/0 | -7.07% | 1.21% | 278 |
| deepseek-flash-peak | validation-warm | frozenFixed/fixed70 | 7/1/0 | -7.68% | 1.75% | 278 |
| deepseek-flash-peak | validation-warm | durationMixture/durationMixture | 6/0/2 | -8.24% | 0.00% | 278 |
| deepseek-flash-peak | floor-stress | fixed60/fixed60 | 6/2/0 | -0.91% | 7.24% | 230 |
| deepseek-flash-peak | floor-stress | frozenFixed/fixed70 | 4/4/0 | -1.46% | 3.56% | 230 |
| deepseek-flash-peak | floor-stress | durationMixture/durationMixture | 6/2/0 | -2.26% | 6.39% | 230 |
| deepseek-flash-offpeak | dev-warm-long | fixed60/fixed60 | 10/2/0 | -7.70% | 4.19% | 247 |
| deepseek-flash-offpeak | dev-warm-long | frozenFixed/fixed70 | 10/2/0 | -6.11% | 1.16% | 247 |
| deepseek-flash-offpeak | dev-warm-long | durationMixture/durationMixture | 8/0/4 | -6.36% | 0.00% | 247 |
| deepseek-flash-offpeak | near-end | fixed60/fixed60 | 1/0/0 | -49.93% | -49.93% | 0 |
| deepseek-flash-offpeak | near-end | frozenFixed/fixed70 | 0/0/0 | — | — | 0 |
| deepseek-flash-offpeak | near-end | durationMixture/durationMixture | 0/0/0 | — | — | 0 |
| deepseek-flash-offpeak | validation-warm | fixed60/fixed60 | 7/1/0 | -7.07% | 1.21% | 278 |
| deepseek-flash-offpeak | validation-warm | frozenFixed/fixed70 | 7/1/0 | -7.68% | 1.75% | 278 |
| deepseek-flash-offpeak | validation-warm | durationMixture/durationMixture | 6/0/2 | -8.24% | 0.00% | 278 |
| deepseek-flash-offpeak | floor-stress | fixed60/fixed60 | 6/2/0 | -0.91% | 7.24% | 230 |
| deepseek-flash-offpeak | floor-stress | frozenFixed/fixed70 | 4/4/0 | -1.46% | 3.56% | 230 |
| deepseek-flash-offpeak | floor-stress | durationMixture/durationMixture | 6/2/0 | -2.26% | 6.39% | 230 |
| deepseek-v4-pro-peak | dev-warm-long | fixed60/fixed60 | 12/0/0 | -16.82% | -11.68% | 446 |
| deepseek-v4-pro-peak | dev-warm-long | frozenFixed/fixed50 | 12/0/0 | -12.98% | -10.38% | 446 |
| deepseek-v4-pro-peak | dev-warm-long | durationMixture/durationMixture | 12/0/0 | -15.53% | -11.66% | 446 |
| deepseek-v4-pro-peak | near-end | fixed60/fixed60 | 1/2/0 | -10.12% | 10.58% | 3 |
| deepseek-v4-pro-peak | near-end | frozenFixed/fixed50 | 0/0/3 | 0.00% | 0.00% | 3 |
| deepseek-v4-pro-peak | near-end | durationMixture/durationMixture | 0/0/3 | 0.00% | 0.00% | 3 |
| deepseek-v4-pro-peak | validation-warm | fixed60/fixed60 | 7/1/0 | -9.77% | 0.36% | 313 |
| deepseek-v4-pro-peak | validation-warm | frozenFixed/fixed50 | 8/0/0 | -8.46% | -0.97% | 313 |
| deepseek-v4-pro-peak | validation-warm | durationMixture/durationMixture | 7/0/1 | -11.28% | 0.00% | 313 |
| deepseek-v4-pro-peak | floor-stress | fixed60/fixed60 | 4/4/0 | -1.64% | 9.98% | 420 |
| deepseek-v4-pro-peak | floor-stress | frozenFixed/fixed50 | 4/4/0 | 0.72% | 10.57% | 420 |
| deepseek-v4-pro-peak | floor-stress | durationMixture/durationMixture | 6/2/0 | -3.65% | 8.61% | 420 |
| claude-sonnet-5.5-5m-price | dev-warm-long | fixed60/fixed60 | 12/0/0 | -38.76% | -26.65% | 534 |
| claude-sonnet-5.5-5m-price | dev-warm-long | frozenFixed/fixed50 | 12/0/0 | -34.15% | -24.23% | 534 |
| claude-sonnet-5.5-5m-price | dev-warm-long | durationMixture/durationMixture | 11/0/1 | -31.93% | 0.00% | 534 |
| claude-sonnet-5.5-5m-price | near-end | fixed60/fixed60 | 3/0/0 | -25.95% | -9.18% | 3 |
| claude-sonnet-5.5-5m-price | near-end | frozenFixed/fixed50 | 0/0/3 | 0.00% | 0.00% | 3 |
| claude-sonnet-5.5-5m-price | near-end | durationMixture/durationMixture | 0/0/3 | 0.00% | 0.00% | 3 |
| claude-sonnet-5.5-5m-price | validation-warm | fixed60/fixed60 | 8/0/0 | -29.82% | -21.49% | 417 |
| claude-sonnet-5.5-5m-price | validation-warm | frozenFixed/fixed50 | 8/0/0 | -26.55% | -20.10% | 417 |
| claude-sonnet-5.5-5m-price | validation-warm | durationMixture/durationMixture | 8/0/0 | -23.42% | -4.92% | 417 |
| claude-sonnet-5.5-5m-price | floor-stress | fixed60/fixed60 | 6/2/0 | -10.57% | 3.82% | 544 |
| claude-sonnet-5.5-5m-price | floor-stress | frozenFixed/fixed50 | 4/4/0 | -5.27% | 11.70% | 544 |
| claude-sonnet-5.5-5m-price | floor-stress | durationMixture/durationMixture | 8/0/0 | -3.99% | -1.03% | 544 |
| claude-sonnet-5.5-1h-price | dev-warm-long | fixed60/fixed60 | 12/0/0 | -37.45% | -24.45% | 530 |
| claude-sonnet-5.5-1h-price | dev-warm-long | frozenFixed/fixed50 | 12/0/0 | -32.85% | -22.31% | 530 |
| claude-sonnet-5.5-1h-price | dev-warm-long | durationMixture/durationMixture | 12/0/0 | -31.19% | -8.09% | 530 |
| claude-sonnet-5.5-1h-price | near-end | fixed60/fixed60 | 3/0/0 | -47.71% | -39.45% | 3 |
| claude-sonnet-5.5-1h-price | near-end | frozenFixed/fixed50 | 0/0/3 | 0.00% | 0.00% | 3 |
| claude-sonnet-5.5-1h-price | near-end | durationMixture/durationMixture | 0/0/3 | 0.00% | 0.00% | 3 |
| claude-sonnet-5.5-1h-price | validation-warm | fixed60/fixed60 | 8/0/0 | -28.27% | -19.71% | 416 |
| claude-sonnet-5.5-1h-price | validation-warm | frozenFixed/fixed50 | 8/0/0 | -25.15% | -18.76% | 416 |
| claude-sonnet-5.5-1h-price | validation-warm | durationMixture/durationMixture | 8/0/0 | -22.68% | -5.48% | 416 |
| claude-sonnet-5.5-1h-price | floor-stress | fixed60/fixed60 | 4/4/0 | -4.09% | 16.20% | 532 |
| claude-sonnet-5.5-1h-price | floor-stress | frozenFixed/fixed50 | 4/4/0 | 1.47% | 24.50% | 532 |
| claude-sonnet-5.5-1h-price | floor-stress | durationMixture/durationMixture | 4/4/0 | -0.62% | 2.49% | 532 |
| claude-opus-5.5-5m-price | dev-warm-long | fixed60/fixed60 | 12/0/0 | -23.90% | -14.67% | 486 |
| claude-opus-5.5-5m-price | dev-warm-long | frozenFixed/fixed50 | 12/0/0 | -19.86% | -14.17% | 486 |
| claude-opus-5.5-5m-price | dev-warm-long | durationMixture/durationMixture | 12/0/0 | -22.22% | -4.74% | 486 |
| claude-opus-5.5-5m-price | near-end | fixed60/fixed60 | 3/0/0 | -24.66% | -9.18% | 3 |
| claude-opus-5.5-5m-price | near-end | frozenFixed/fixed50 | 0/0/3 | 0.00% | 0.00% | 3 |
| claude-opus-5.5-5m-price | near-end | durationMixture/durationMixture | 0/0/3 | 0.00% | 0.00% | 3 |
| claude-opus-5.5-5m-price | validation-warm | fixed60/fixed60 | 8/0/0 | -16.90% | -9.44% | 387 |
| claude-opus-5.5-5m-price | validation-warm | frozenFixed/fixed50 | 8/0/0 | -15.00% | -9.87% | 387 |
| claude-opus-5.5-5m-price | validation-warm | durationMixture/durationMixture | 8/0/0 | -18.17% | -7.74% | 387 |
| claude-opus-5.5-5m-price | floor-stress | fixed60/fixed60 | 4/4/0 | -1.69% | 9.60% | 440 |
| claude-opus-5.5-5m-price | floor-stress | frozenFixed/fixed50 | 4/4/0 | 1.60% | 11.11% | 440 |
| claude-opus-5.5-5m-price | floor-stress | durationMixture/durationMixture | 4/4/0 | -4.00% | 7.81% | 440 |
| gemini-2.5-flash-text | dev-warm-long | fixed60/fixed60 | 12/0/0 | -38.47% | -26.58% | 534 |
| gemini-2.5-flash-text | dev-warm-long | frozenFixed/fixed50 | 12/0/0 | -33.87% | -24.14% | 534 |
| gemini-2.5-flash-text | dev-warm-long | durationMixture/durationMixture | 11/0/1 | -32.70% | 0.00% | 534 |
| gemini-2.5-flash-text | near-end | fixed60/fixed60 | 1/2/0 | -11.83% | 11.62% | 3 |
| gemini-2.5-flash-text | near-end | frozenFixed/fixed50 | 0/0/3 | 0.00% | 0.00% | 3 |
| gemini-2.5-flash-text | near-end | durationMixture/durationMixture | 0/0/3 | 0.00% | 0.00% | 3 |
| gemini-2.5-flash-text | validation-warm | fixed60/fixed60 | 8/0/0 | -29.77% | -21.77% | 417 |
| gemini-2.5-flash-text | validation-warm | frozenFixed/fixed50 | 8/0/0 | -26.49% | -20.28% | 417 |
| gemini-2.5-flash-text | validation-warm | durationMixture/durationMixture | 8/0/0 | -23.49% | -4.88% | 417 |
| gemini-2.5-flash-text | floor-stress | fixed60/fixed60 | 6/2/0 | -10.74% | 1.97% | 544 |
| gemini-2.5-flash-text | floor-stress | frozenFixed/fixed50 | 4/4/0 | -5.55% | 9.65% | 544 |
| gemini-2.5-flash-text | floor-stress | durationMixture/durationMixture | 8/0/0 | -4.40% | -1.10% | 544 |
| gemini-2.5-flash-lite-text | dev-warm-long | fixed60/fixed60 | 12/0/0 | -39.47% | -27.48% | 534 |
| gemini-2.5-flash-lite-text | dev-warm-long | frozenFixed/fixed50 | 12/0/0 | -34.84% | -24.94% | 534 |
| gemini-2.5-flash-lite-text | dev-warm-long | durationMixture/durationMixture | 10/0/2 | -31.95% | 0.00% | 534 |
| gemini-2.5-flash-lite-text | near-end | fixed60/fixed60 | 1/2/0 | -12.47% | 10.78% | 3 |
| gemini-2.5-flash-lite-text | near-end | frozenFixed/fixed50 | 0/0/3 | 0.00% | 0.00% | 3 |
| gemini-2.5-flash-lite-text | near-end | durationMixture/durationMixture | 0/0/3 | 0.00% | 0.00% | 3 |
| gemini-2.5-flash-lite-text | validation-warm | fixed60/fixed60 | 8/0/0 | -30.44% | -22.24% | 417 |
| gemini-2.5-flash-lite-text | validation-warm | frozenFixed/fixed50 | 8/0/0 | -27.11% | -20.69% | 417 |
| gemini-2.5-flash-lite-text | validation-warm | durationMixture/durationMixture | 8/0/0 | -24.05% | -5.01% | 417 |
| gemini-2.5-flash-lite-text | floor-stress | fixed60/fixed60 | 8/0/0 | -13.41% | -1.21% | 546 |
| gemini-2.5-flash-lite-text | floor-stress | frozenFixed/fixed50 | 4/4/0 | -8.19% | 6.50% | 546 |
| gemini-2.5-flash-lite-text | floor-stress | durationMixture/durationMixture | 8/0/0 | -4.19% | -1.46% | 546 |

## 限制

- 实验 API 显式 opt-in，核心/Pi 默认未改；ending-risk 是预计的即时结束损失，不是最大损失承诺，也不评估所有结束时刻的累计后悔。
- NOW/WAIT 使用同一重复边界族；NOW 的压力评估保持其名义最优边界，不在压力模型下重新挑更有利策略。每轮仍重新优化，非完整自递归未来策略。
- 开发场景已用于设计。heldout 仅是首次运行的新 seed/长度/增长/保留率组合，不是独立真实任务；禁止依据留出成绩反复调参后继续称其盲测。
- 冷缓存仅小型回归；预测使用共同比例缓存模型，不是真实供应商完整计费，无真实模型/压缩质量验证。
- 未来经济触发预测采用风险门，但未模拟全部宿主冷却和资格门；q 和缓存存活预测仍可能错误。
- 没有 endpoint、真实保留率或测试策略编号输入算法；无压缩双方排除胜负但保留。旧报告不改。
- 先验是显式未校准的研究假设，不是训练得到；混合模型并不证明已持续的任务一定更长，任务分布变化会失效。
- 对存活至某时点的任务做条件更新；摘要/预热和只读决策不增加年龄，不使用本轮真实总长度。
- 概率压力检查在混合模型中向最短成分移动 5% 后验质量；与旧版固定 q 减 0.05 不同，模型和压力契约的改动不能混为纯年龄收益。
- 三个新增对照均用 256 调用预测上限，保留原 64 调用对照；截断尾部超过 5% 仍拒绝经济触发。
- frozenDuration 采用同样的先验曲线和压力规则，但年龄永远固定为零，分离条件更新的贡献；它不代表推荐用法。
- Brier 是这些固定长度合成轨迹的逐调用分数，不是完整校准证明；长任务占更多调用，需同时检查临近结束。
- 完整 NOW/WAIT 路径仍逐次计入摘要和重建；仅修改等待一轮可行时的余量尺度，不删除共同费用，不把全部摘要当作免费。
- 模型、q、先验、压力和风险预算均未改；固定对照仍从原开发集选择后冻结，没有把固定百分比输入算法。
- 以前的 fresh-warm 现在标 seen-regression；八个新组合只用于首次验证，已看过后不能反复调参称盲测。
- 费用更低与摘要更多不代表任务质量不变；默认核心/Pi 未切换。成本拆分采用共同模拟计费，不是供应商真实账单。
- floor-stress 设置 20k/50k 保留底座与 2k 最低摘要输出，只通过实际压缩观测反馈，不提前把真实底座给策略；旧 fixture 默认底座为零。
