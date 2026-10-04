# 暖缓存多周期成本比较（零付费）

负数为更省。严格门与结束概率加权门分开；所有价格用相同参数。固定对照只从开发集选择后冻结。

| 价格 | 分组 | 分支 | 对照 | 胜/负/平 | 平均变化 | 最差变化 |
| --- | --- | --- | --- | --- | --- | --- |
| deepseek-flash-peak | dev-warm-long | renewalWeighted | fixed60/fixed60 | 10/2/0 | -1.41% | 6.89% |
| deepseek-flash-peak | dev-warm-long | renewalWeighted | frozenFixed/fixed70 | 8/4/0 | 0.31% | 4.69% |
| deepseek-flash-peak | heldout-warm | renewalWeighted | fixed60/fixed60 | 5/7/0 | 0.11% | 8.36% |
| deepseek-flash-peak | heldout-warm | renewalWeighted | frozenFixed/fixed70 | 8/4/0 | -0.32% | 6.50% |
| deepseek-flash-peak | near-end | renewalWeighted | fixed60/fixed60 | 1/0/0 | -49.93% | -49.93% |
| deepseek-flash-peak | near-end | renewalWeighted | frozenFixed/fixed70 | 0/0/0 | — | — |
| deepseek-flash-peak | cold-regression | renewalWeighted | fixed60/fixed60 | 4/0/0 | -63.14% | -52.26% |
| deepseek-flash-peak | cold-regression | renewalWeighted | frozenFixed/fixed70 | 4/0/0 | -67.90% | -58.54% |
| deepseek-flash-offpeak | dev-warm-long | renewalWeighted | fixed60/fixed60 | 10/2/0 | -1.41% | 6.89% |
| deepseek-flash-offpeak | dev-warm-long | renewalWeighted | frozenFixed/fixed70 | 8/4/0 | 0.31% | 4.69% |
| deepseek-flash-offpeak | heldout-warm | renewalWeighted | fixed60/fixed60 | 5/7/0 | 0.11% | 8.36% |
| deepseek-flash-offpeak | heldout-warm | renewalWeighted | frozenFixed/fixed70 | 8/4/0 | -0.32% | 6.50% |
| deepseek-flash-offpeak | near-end | renewalWeighted | fixed60/fixed60 | 1/0/0 | -49.93% | -49.93% |
| deepseek-flash-offpeak | near-end | renewalWeighted | frozenFixed/fixed70 | 0/0/0 | — | — |
| deepseek-flash-offpeak | cold-regression | renewalWeighted | fixed60/fixed60 | 4/0/0 | -63.14% | -52.26% |
| deepseek-flash-offpeak | cold-regression | renewalWeighted | frozenFixed/fixed70 | 4/0/0 | -67.90% | -58.54% |
| deepseek-v4-pro-peak | dev-warm-long | renewalWeighted | fixed60/fixed60 | 7/5/0 | -0.40% | 7.14% |
| deepseek-v4-pro-peak | dev-warm-long | renewalWeighted | frozenFixed/fixed50 | 4/8/0 | 4.23% | 7.24% |
| deepseek-v4-pro-peak | heldout-warm | renewalWeighted | fixed60/fixed60 | 3/9/0 | 0.76% | 8.81% |
| deepseek-v4-pro-peak | heldout-warm | renewalWeighted | frozenFixed/fixed50 | 0/12/0 | 3.27% | 7.29% |
| deepseek-v4-pro-peak | near-end | renewalWeighted | fixed60/fixed60 | 1/0/0 | -48.75% | -48.75% |
| deepseek-v4-pro-peak | near-end | renewalWeighted | frozenFixed/fixed50 | 3/0/0 | -5.85% | -1.32% |
| deepseek-v4-pro-peak | cold-regression | renewalWeighted | fixed60/fixed60 | 4/0/0 | -75.75% | -62.26% |
| deepseek-v4-pro-peak | cold-regression | renewalWeighted | frozenFixed/fixed50 | 4/0/0 | -72.59% | -57.24% |
| claude-sonnet-5.5-5m-price | dev-warm-long | renewalWeighted | fixed60/fixed60 | 2/10/0 | 1.73% | 2.70% |
| claude-sonnet-5.5-5m-price | dev-warm-long | renewalWeighted | frozenFixed/fixed50 | 0/12/0 | 9.84% | 14.25% |
| claude-sonnet-5.5-5m-price | heldout-warm | renewalWeighted | fixed60/fixed60 | 3/9/0 | 2.45% | 10.42% |
| claude-sonnet-5.5-5m-price | heldout-warm | renewalWeighted | frozenFixed/fixed50 | 0/12/0 | 8.35% | 13.07% |
| claude-sonnet-5.5-5m-price | near-end | renewalWeighted | fixed60/fixed60 | 3/0/0 | -25.95% | -9.18% |
| claude-sonnet-5.5-5m-price | near-end | renewalWeighted | frozenFixed/fixed50 | 0/0/3 | 0.00% | 0.00% |
| claude-sonnet-5.5-5m-price | cold-regression | renewalWeighted | fixed60/fixed60 | 4/0/0 | -76.43% | -63.29% |
| claude-sonnet-5.5-5m-price | cold-regression | renewalWeighted | frozenFixed/fixed50 | 4/0/0 | -73.27% | -58.09% |
| claude-sonnet-5.5-1h-price | dev-warm-long | renewalWeighted | fixed60/fixed60 | 2/10/0 | 1.31% | 2.16% |
| claude-sonnet-5.5-1h-price | dev-warm-long | renewalWeighted | frozenFixed/fixed50 | 0/12/0 | 9.21% | 13.91% |
| claude-sonnet-5.5-1h-price | heldout-warm | renewalWeighted | fixed60/fixed60 | 4/8/0 | 2.10% | 10.39% |
| claude-sonnet-5.5-1h-price | heldout-warm | renewalWeighted | frozenFixed/fixed50 | 0/12/0 | 7.65% | 12.71% |
| claude-sonnet-5.5-1h-price | near-end | renewalWeighted | fixed60/fixed60 | 3/0/0 | -47.71% | -39.45% |
| claude-sonnet-5.5-1h-price | near-end | renewalWeighted | frozenFixed/fixed50 | 0/0/3 | 0.00% | 0.00% |
| claude-sonnet-5.5-1h-price | cold-regression | renewalWeighted | fixed60/fixed60 | 4/0/0 | -80.59% | -70.05% |
| claude-sonnet-5.5-1h-price | cold-regression | renewalWeighted | frozenFixed/fixed50 | 4/0/0 | -77.92% | -65.59% |
| claude-opus-5.5-5m-price | dev-warm-long | renewalWeighted | fixed60/fixed60 | 6/6/0 | -0.63% | 0.95% |
| claude-opus-5.5-5m-price | dev-warm-long | renewalWeighted | frozenFixed/fixed50 | 0/12/0 | 4.94% | 9.41% |
| claude-opus-5.5-5m-price | heldout-warm | renewalWeighted | fixed60/fixed60 | 4/8/0 | 0.88% | 9.50% |
| claude-opus-5.5-5m-price | heldout-warm | renewalWeighted | frozenFixed/fixed50 | 0/12/0 | 4.26% | 8.17% |
| claude-opus-5.5-5m-price | near-end | renewalWeighted | fixed60/fixed60 | 3/0/0 | -24.66% | -9.18% |
| claude-opus-5.5-5m-price | near-end | renewalWeighted | frozenFixed/fixed50 | 0/0/3 | 0.00% | 0.00% |
| claude-opus-5.5-5m-price | cold-regression | renewalWeighted | fixed60/fixed60 | 4/0/0 | -72.00% | -54.64% |
| claude-opus-5.5-5m-price | cold-regression | renewalWeighted | frozenFixed/fixed50 | 4/0/0 | -68.12% | -48.35% |
| gemini-2.5-flash-text | dev-warm-long | renewalWeighted | fixed60/fixed60 | 2/10/0 | 1.80% | 2.90% |
| gemini-2.5-flash-text | dev-warm-long | renewalWeighted | frozenFixed/fixed50 | 0/12/0 | 9.82% | 14.09% |
| gemini-2.5-flash-text | heldout-warm | renewalWeighted | fixed60/fixed60 | 3/9/0 | 2.53% | 10.31% |
| gemini-2.5-flash-text | heldout-warm | renewalWeighted | frozenFixed/fixed50 | 0/12/0 | 8.46% | 12.98% |
| gemini-2.5-flash-text | near-end | renewalWeighted | fixed60/fixed60 | 1/2/0 | -11.83% | 11.62% |
| gemini-2.5-flash-text | near-end | renewalWeighted | frozenFixed/fixed50 | 0/0/3 | 0.00% | 0.00% |
| gemini-2.5-flash-text | cold-regression | renewalWeighted | fixed60/fixed60 | 4/0/0 | -73.62% | -59.12% |
| gemini-2.5-flash-text | cold-regression | renewalWeighted | frozenFixed/fixed50 | 4/0/0 | -70.16% | -53.53% |
| gemini-2.5-flash-lite-text | dev-warm-long | renewalWeighted | fixed60/fixed60 | 2/10/0 | 1.89% | 2.99% |
| gemini-2.5-flash-lite-text | dev-warm-long | renewalWeighted | frozenFixed/fixed50 | 0/12/0 | 10.12% | 14.44% |
| gemini-2.5-flash-lite-text | heldout-warm | renewalWeighted | fixed60/fixed60 | 3/9/0 | 2.58% | 10.46% |
| gemini-2.5-flash-lite-text | heldout-warm | renewalWeighted | frozenFixed/fixed50 | 0/12/0 | 8.64% | 13.26% |
| gemini-2.5-flash-lite-text | near-end | renewalWeighted | fixed60/fixed60 | 1/2/0 | -12.47% | 10.78% |
| gemini-2.5-flash-lite-text | near-end | renewalWeighted | frozenFixed/fixed50 | 0/0/3 | 0.00% | 0.00% |
| gemini-2.5-flash-lite-text | cold-regression | renewalWeighted | fixed60/fixed60 | 4/0/0 | -74.04% | -59.55% |
| gemini-2.5-flash-lite-text | cold-regression | renewalWeighted | frozenFixed/fixed50 | 4/0/0 | -70.62% | -53.97% |

## 限制

- 实验 API 显式 opt-in，核心/Pi 默认未改；ending-risk 是预计的即时结束损失，不是最大损失承诺，也不评估所有结束时刻的累计后悔。
- NOW/WAIT 使用同一重复边界族；NOW 的压力评估保持其名义最优边界，不在压力模型下重新挑更有利策略。每轮仍重新优化，非完整自递归未来策略。
- 开发场景已用于设计。heldout 仅是首次运行的新 seed/长度/增长/保留率组合，不是独立真实任务；禁止依据留出成绩反复调参后继续称其盲测。
- 冷缓存仅小型回归；预测使用共同比例缓存模型，不是真实供应商完整计费，无真实模型/压缩质量验证。
- 未来经济触发预测采用风险门，但未模拟全部宿主冷却和资格门；q 和缓存存活预测仍可能错误。
- 没有 endpoint、真实保留率或测试策略编号输入算法；无压缩双方排除胜负但保留。旧报告不改。
