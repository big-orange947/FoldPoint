# 压缩频率与费用归因：零付费诊断

不改默认算法，不选择获胜参数。摘要、压缩后首次输入、其他普通输入、普通输出四项互不重复。压缩后首次输入并不等于额外损失；应与未压缩的输入费用对照。

| 调用数 | 缓存 | 分支 | 比较数 | 胜/负 | 平均费用变化 | 压缩尝试 | 最短压缩间隔/调用 | 摘要占总费用 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 12 | warm | fixed60 | 0 | 0/0 | — | 0 | — | 0.00% |
| 12 | warm | cacheAwareNoBudget | 24 | 24/0 | -10.43% | 28 | 9 | 8.69% |
| 12 | warm | cumulativeRisk1 | 24 | 24/0 | -14.70% | 29 | 3 | 4.76% |
| 12 | cold | fixed60 | 0 | 0/0 | — | 0 | — | 0.00% |
| 12 | cold | cacheAwareNoBudget | 30 | 30/0 | -62.70% | 106 | 3 | 25.22% |
| 12 | cold | cumulativeRisk1 | 30 | 30/0 | -63.85% | 106 | 3 | 21.85% |
| 12 | coldAfterMidpoint | fixed60 | 0 | 0/0 | — | 0 | — | 0.00% |
| 12 | coldAfterMidpoint | cacheAwareNoBudget | 30 | 30/0 | -58.41% | 80 | 3 | 27.12% |
| 12 | coldAfterMidpoint | cumulativeRisk1 | 30 | 30/0 | -59.94% | 83 | 3 | 25.43% |
| 60 | warm | fixed60 | 36 | 0/0 | 0.00% | 72 | 15 | 18.53% |
| 60 | warm | cacheAwareNoBudget | 36 | 16/20 | -11.27% | 140 | 3 | 27.16% |
| 60 | warm | cumulativeRisk1 | 36 | 5/31 | 4.46% | 95 | 3 | 18.55% |
| 60 | cold | fixed60 | 36 | 0/0 | 0.00% | 72 | 15 | 5.67% |
| 60 | cold | cacheAwareNoBudget | 36 | 36/0 | -70.41% | 530 | 3 | 26.20% |
| 60 | cold | cumulativeRisk1 | 36 | 26/10 | -42.60% | 430 | 3 | 11.57% |
| 60 | coldAfterMidpoint | fixed60 | 36 | 0/0 | 0.00% | 72 | 15 | 8.32% |
| 60 | coldAfterMidpoint | cacheAwareNoBudget | 36 | 36/0 | -60.72% | 333 | 3 | 27.90% |
| 60 | coldAfterMidpoint | cumulativeRisk1 | 36 | 26/10 | -37.60% | 287 | 3 | 16.52% |
| 140 | warm | fixed60 | 36 | 0/0 | 0.00% | 210 | 15 | 21.20% |
| 140 | warm | cacheAwareNoBudget | 36 | 24/12 | -14.91% | 346 | 3 | 28.72% |
| 140 | warm | cumulativeRisk1 | 36 | 12/24 | 2.27% | 205 | 3 | 19.13% |
| 140 | cold | fixed60 | 36 | 0/0 | 0.00% | 210 | 15 | 6.57% |
| 140 | cold | cacheAwareNoBudget | 36 | 36/0 | -72.34% | 1241 | 3 | 26.31% |
| 140 | cold | cumulativeRisk1 | 36 | 24/12 | -36.00% | 928 | 3 | 10.56% |
| 140 | coldAfterMidpoint | fixed60 | 36 | 0/0 | 0.00% | 210 | 15 | 9.93% |
| 140 | coldAfterMidpoint | cacheAwareNoBudget | 36 | 36/0 | -61.17% | 800 | 3 | 28.22% |
| 140 | coldAfterMidpoint | cumulativeRisk1 | 36 | 22/14 | -25.74% | 577 | 3 | 14.15% |

近结束的 27 个案例仍全部保留在 JSON 明细中，不因结果好坏移除。无压缩双方不计入胜负。步骤号、最后一次压缩之后的调用数只用于事后审计，不用于触发决策。
callsAfterFinalCompaction 包含紧接最后一次摘要的普通调用；最短/中位间隔来自成功压缩步骤差，不把会话结尾的短区间当作压缩间隔。

## 限制

- Synthetic 1M matrix with identical offered growth; no real task quality or provider cache evidence.
- q=0.95 is an uncalibrated diagnostic prior, not a selected production default.
- All summary attempts are billed; first post-compaction input is part of ordinary input, not added again.
- First post-compaction input is a full bill, not an incremental cache rebuilding penalty or avoidable overhead.
- Calls/compaction and adjacent pairs describe frequency, not a validated quality limit.
- Costs use hypothetical prices; group means are unweighted sensitivity summaries, not real traffic savings.
- Cold-cache future reuse prediction can be optimistic; this audit does not change that model.
- Endpoint and true retention are used only for evaluation, never supplied to policy decisions.
