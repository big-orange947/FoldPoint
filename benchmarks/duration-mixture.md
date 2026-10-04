# 持续时间混合模型：零付费暖缓存实验

固定显式先验，不按供应商调参。负数更省。

| 价格 | 分组 | 分支 | 对照 | 胜/负/平 | 平均变化 | 最差变化 | Brier |
| --- | --- | --- | --- | --- | --- | --- | --- |
| deepseek-flash-peak | dev-warm-long | durationMixture | fixed60/fixed60 | 10/2/0 | -1.41% | 6.89% | 0.0087 |
| deepseek-flash-peak | dev-warm-long | durationMixture | frozenFixed/fixed70 | 8/4/0 | 0.31% | 4.69% | 0.0087 |
| deepseek-flash-peak | fresh-warm | durationMixture | fixed60/fixed60 | 4/4/0 | -0.47% | 6.95% | 0.0079 |
| deepseek-flash-peak | fresh-warm | durationMixture | frozenFixed/fixed70 | 6/2/0 | -0.42% | 5.38% | 0.0079 |
| deepseek-flash-peak | near-end | durationMixture | fixed60/fixed60 | 1/0/0 | -49.93% | -49.93% | 0.3205 |
| deepseek-flash-peak | near-end | durationMixture | frozenFixed/fixed70 | 0/0/0 | — | — | 0.3205 |
| deepseek-flash-offpeak | dev-warm-long | durationMixture | fixed60/fixed60 | 10/2/0 | -1.41% | 6.89% | 0.0087 |
| deepseek-flash-offpeak | dev-warm-long | durationMixture | frozenFixed/fixed70 | 8/4/0 | 0.31% | 4.69% | 0.0087 |
| deepseek-flash-offpeak | fresh-warm | durationMixture | fixed60/fixed60 | 4/4/0 | -0.47% | 6.95% | 0.0079 |
| deepseek-flash-offpeak | fresh-warm | durationMixture | frozenFixed/fixed70 | 6/2/0 | -0.42% | 5.38% | 0.0079 |
| deepseek-flash-offpeak | near-end | durationMixture | fixed60/fixed60 | 1/0/0 | -49.93% | -49.93% | 0.3205 |
| deepseek-flash-offpeak | near-end | durationMixture | frozenFixed/fixed70 | 0/0/0 | — | — | 0.3205 |
| deepseek-v4-pro-peak | dev-warm-long | durationMixture | fixed60/fixed60 | 8/4/0 | -1.54% | 0.42% | 0.0087 |
| deepseek-v4-pro-peak | dev-warm-long | durationMixture | frozenFixed/fixed50 | 4/8/0 | 3.10% | 7.43% | 0.0087 |
| deepseek-v4-pro-peak | fresh-warm | durationMixture | fixed60/fixed60 | 4/4/0 | 0.21% | 7.84% | 0.0079 |
| deepseek-v4-pro-peak | fresh-warm | durationMixture | frozenFixed/fixed50 | 0/8/0 | 3.80% | 8.46% | 0.0079 |
| deepseek-v4-pro-peak | near-end | durationMixture | fixed60/fixed60 | 1/2/0 | -10.12% | 10.58% | 0.3205 |
| deepseek-v4-pro-peak | near-end | durationMixture | frozenFixed/fixed50 | 0/0/3 | 0.00% | 0.00% | 0.3205 |
| claude-sonnet-5.5-5m-price | dev-warm-long | durationMixture | fixed60/fixed60 | 6/6/0 | -7.75% | 2.70% | 0.0087 |
| claude-sonnet-5.5-5m-price | dev-warm-long | durationMixture | frozenFixed/fixed50 | 5/7/0 | -0.24% | 14.13% | 0.0087 |
| claude-sonnet-5.5-5m-price | fresh-warm | durationMixture | fixed60/fixed60 | 5/3/0 | -7.71% | 7.25% | 0.0079 |
| claude-sonnet-5.5-5m-price | fresh-warm | durationMixture | frozenFixed/fixed50 | 3/5/0 | -1.02% | 14.62% | 0.0079 |
| claude-sonnet-5.5-5m-price | near-end | durationMixture | fixed60/fixed60 | 3/0/0 | -25.95% | -9.18% | 0.3205 |
| claude-sonnet-5.5-5m-price | near-end | durationMixture | frozenFixed/fixed50 | 0/0/3 | 0.00% | 0.00% | 0.3205 |
| claude-sonnet-5.5-1h-price | dev-warm-long | durationMixture | fixed60/fixed60 | 6/6/0 | -7.03% | 2.16% | 0.0087 |
| claude-sonnet-5.5-1h-price | dev-warm-long | durationMixture | frozenFixed/fixed50 | 4/8/0 | 0.45% | 13.91% | 0.0087 |
| claude-sonnet-5.5-1h-price | fresh-warm | durationMixture | fixed60/fixed60 | 5/3/0 | -7.77% | 7.21% | 0.0079 |
| claude-sonnet-5.5-1h-price | fresh-warm | durationMixture | frozenFixed/fixed50 | 3/5/0 | -1.32% | 14.05% | 0.0079 |
| claude-sonnet-5.5-1h-price | near-end | durationMixture | fixed60/fixed60 | 3/0/0 | -47.71% | -39.45% | 0.3205 |
| claude-sonnet-5.5-1h-price | near-end | durationMixture | frozenFixed/fixed50 | 0/0/3 | 0.00% | 0.00% | 0.3205 |
| claude-opus-5.5-5m-price | dev-warm-long | durationMixture | fixed60/fixed60 | 7/5/0 | -1.97% | 0.95% | 0.0087 |
| claude-opus-5.5-5m-price | dev-warm-long | durationMixture | frozenFixed/fixed50 | 1/11/0 | 3.60% | 9.41% | 0.0087 |
| claude-opus-5.5-5m-price | fresh-warm | durationMixture | fixed60/fixed60 | 4/4/0 | 0.94% | 8.19% | 0.0079 |
| claude-opus-5.5-5m-price | fresh-warm | durationMixture | frozenFixed/fixed50 | 0/8/0 | 5.56% | 10.19% | 0.0079 |
| claude-opus-5.5-5m-price | near-end | durationMixture | fixed60/fixed60 | 3/0/0 | -24.66% | -9.18% | 0.3205 |
| claude-opus-5.5-5m-price | near-end | durationMixture | frozenFixed/fixed50 | 0/0/3 | 0.00% | 0.00% | 0.3205 |
| gemini-2.5-flash-text | dev-warm-long | durationMixture | fixed60/fixed60 | 5/7/0 | -6.29% | 2.90% | 0.0087 |
| gemini-2.5-flash-text | dev-warm-long | durationMixture | frozenFixed/fixed50 | 4/8/0 | 1.26% | 13.91% | 0.0087 |
| gemini-2.5-flash-text | fresh-warm | durationMixture | fixed60/fixed60 | 5/3/0 | -7.53% | 7.18% | 0.0079 |
| gemini-2.5-flash-text | fresh-warm | durationMixture | frozenFixed/fixed50 | 3/5/0 | -0.86% | 14.59% | 0.0079 |
| gemini-2.5-flash-text | near-end | durationMixture | fixed60/fixed60 | 1/2/0 | -11.83% | 11.62% | 0.3205 |
| gemini-2.5-flash-text | near-end | durationMixture | frozenFixed/fixed50 | 0/0/3 | 0.00% | 0.00% | 0.3205 |
| gemini-2.5-flash-lite-text | dev-warm-long | durationMixture | fixed60/fixed60 | 6/6/0 | -8.21% | 2.99% | 0.0087 |
| gemini-2.5-flash-lite-text | dev-warm-long | durationMixture | frozenFixed/fixed50 | 5/7/0 | -0.61% | 14.35% | 0.0087 |
| gemini-2.5-flash-lite-text | fresh-warm | durationMixture | fixed60/fixed60 | 5/3/0 | -8.79% | 7.28% | 0.0079 |
| gemini-2.5-flash-lite-text | fresh-warm | durationMixture | frozenFixed/fixed50 | 3/5/0 | -2.07% | 14.89% | 0.0079 |
| gemini-2.5-flash-lite-text | near-end | durationMixture | fixed60/fixed60 | 1/2/0 | -12.47% | 10.78% | 0.3205 |
| gemini-2.5-flash-lite-text | near-end | durationMixture | frozenFixed/fixed50 | 0/0/3 | 0.00% | 0.00% | 0.3205 |

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
