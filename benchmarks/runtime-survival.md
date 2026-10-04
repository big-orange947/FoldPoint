# Runtime 继续概率：零付费实验

实验策略未接管 Pi，也未替换核心默认策略。参数预先列举作敏感性检查，不选择获胜参数作默认。

平均成本变化是逐场景相对差值的算术平均；不是实际用户流量加权结果。无压缩场景不计为胜利。

| 场景组 | 参数 | 基线 | 比较数 | 胜/负 | 平均变化 | 最坏变化 | 经济压缩 | 未回本/判定 | 溢出 | 首压<20%的场景 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| matrix | q80-loss1 | current | 324 | 296/28 | -57.81% | 86.64% | 7001 | 1806/7001 | 0 | 324 |
| matrix | q80-loss1 | fixed60 | 324 | 289/35 | -56.34% | 86.64% | 7001 | 1806/7001 | 0 | 324 |
| matrix | q95-loss1 | current | 324 | 296/28 | -57.83% | 86.64% | 7003 | 1808/7003 | 0 | 324 |
| matrix | q95-loss1 | fixed60 | 324 | 289/35 | -56.37% | 86.64% | 7003 | 1808/7003 | 0 | 324 |
| matrix | q99-loss1 | current | 324 | 0/0 | 0.00% | 0.00% | 0 | 0/0 | 0 | 0 |
| matrix | q99-loss1 | fixed60 | 324 | 16/200 | 6.23% | 20.32% | 0 | 0/0 | 0 | 0 |
| matrix | q95-loss3 | current | 324 | 298/26 | -58.85% | 86.64% | 7668 | 2484/7668 | 0 | 324 |
| matrix | q95-loss3 | fixed60 | 324 | 295/29 | -57.45% | 86.64% | 7668 | 2484/7668 | 0 | 324 |
| near-end | q80-loss1 | current | 24 | 19/5 | -6.17% | 105.54% | 30 | 9/30 | 0 | 0 |
| near-end | q80-loss1 | fixed60 | 24 | 21/3 | -17.98% | 105.54% | 30 | 9/30 | 0 | 0 |
| near-end | q95-loss1 | current | 24 | 19/5 | -6.17% | 105.54% | 30 | 9/30 | 0 | 0 |
| near-end | q95-loss1 | fixed60 | 24 | 21/3 | -17.98% | 105.54% | 30 | 9/30 | 0 | 0 |
| near-end | q99-loss1 | current | 24 | 0/0 | 0.00% | 0.00% | 0 | 0/0 | 0 | 0 |
| near-end | q99-loss1 | fixed60 | 24 | 7/2 | -8.73% | 2.45% | 0 | 0/0 | 0 | 0 |
| near-end | q95-loss3 | current | 24 | 19/5 | -6.17% | 105.54% | 30 | 9/30 | 0 | 0 |
| near-end | q95-loss3 | fixed60 | 24 | 21/3 | -17.98% | 105.54% | 30 | 9/30 | 0 | 0 |

## 限制

- Explicit uncalibrated priors, not estimated task progress or future user commands.
- No held-out endpoint, true retention or future cache condition is supplied to the policy.
- All original 1M simulation limitations apply; summary success and unchanged task output are assumed.
- Geometric survival, constant observed growth and future cache reuse can be wrong.
- WAIT delays economic compaction until safety; it is not an optimal policy that replans an earlier compaction next call.
- Look-ahead truncated at 64 calls; q=0.99 leaves 52.6% survival probability beyond it.
- Policy refuses economic triggers if unmodeled tail probability exceeds 5%; q99 therefore falls back to safety.
- Immediate-loss budget is conditional on estimated costs, not an actual spending cap.
- Unneeded uses the existing bounded shadow interval, not a global optimum.
- Sensitivity cases do not establish real task-quality or majority-traffic savings.
