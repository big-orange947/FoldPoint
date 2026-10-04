# Runtime 继续概率：零付费实验

实验策略未接管 Pi，也未替换核心默认策略。参数预先列举作敏感性检查，不选择获胜参数作默认。

平均成本变化是逐场景相对差值的算术平均；不是实际用户流量加权结果。无压缩场景不计为胜利。

| 场景组 | 参数 | 基线 | 比较数 | 胜/负 | 平均变化 | 最坏变化 | 经济压缩 | 未回本/判定 | 溢出 | 首压<20%的场景 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| matrix | q80-loss1 | current | 324 | 273/51 | -32.16% | 12.10% | 2149 | 80/2149 | 0 | 324 |
| matrix | q80-loss1 | fixed60 | 324 | 216/108 | -27.97% | 19.67% | 2149 | 80/2149 | 0 | 324 |
| matrix | q80-loss1 | forceOnlyV1 | 324 | 33/248 | 133.76% | 769.50% | 2149 | 80/2149 | 0 | 324 |
| matrix | q80-loss1 | waitOneNoBudget | 324 | 160/124 | 12.86% | 170.87% | 2149 | 80/2149 | 0 | 324 |
| matrix | q95-loss1 | current | 324 | 281/43 | -24.99% | 12.10% | 1153 | 60/1153 | 0 | 324 |
| matrix | q95-loss1 | fixed60 | 324 | 219/105 | -20.54% | 19.67% | 1153 | 60/1153 | 0 | 324 |
| matrix | q95-loss1 | forceOnlyV1 | 324 | 32/292 | 166.99% | 766.79% | 1153 | 60/1153 | 0 | 324 |
| matrix | q95-loss1 | waitOneNoBudget | 324 | 61/120 | 24.62% | 148.67% | 1153 | 60/1153 | 0 | 324 |
| matrix | q99-loss1 | current | 216 | 0/0 | 0.00% | 0.00% | 0 | 0/0 | 0 | 0 |
| matrix | q99-loss1 | fixed60 | 216 | 16/200 | 9.35% | 20.32% | 0 | 0/0 | 0 | 0 |
| matrix | q99-loss1 | forceOnlyV1 | 324 | 28/296 | 291.72% | 892.03% | 0 | 0/0 | 0 | 0 |
| matrix | q99-loss1 | waitOneNoBudget | 324 | 33/291 | 77.05% | 180.80% | 0 | 0/0 | 0 | 0 |
| matrix | q95-loss3 | current | 324 | 290/34 | -25.73% | 52.28% | 1356 | 87/1356 | 0 | 324 |
| matrix | q95-loss3 | fixed60 | 324 | 243/81 | -21.59% | 52.28% | 1356 | 87/1356 | 0 | 324 |
| matrix | q95-loss3 | forceOnlyV1 | 324 | 31/293 | 159.41% | 717.82% | 1356 | 87/1356 | 0 | 324 |
| matrix | q95-loss3 | waitOneNoBudget | 324 | 23/109 | 21.50% | 137.96% | 1356 | 87/1356 | 0 | 324 |
| near-end | q80-loss1 | current | 24 | 20/4 | -19.84% | 105.54% | 30 | 6/30 | 0 | 0 |
| near-end | q80-loss1 | fixed60 | 24 | 21/3 | -25.76% | 105.54% | 30 | 6/30 | 0 | 0 |
| near-end | q80-loss1 | forceOnlyV1 | 24 | 0/0 | 0.00% | 0.00% | 30 | 6/30 | 0 | 0 |
| near-end | q80-loss1 | waitOneNoBudget | 24 | 2/2 | 0.70% | 13.19% | 30 | 6/30 | 0 | 0 |
| near-end | q95-loss1 | current | 24 | 20/4 | -20.34% | 105.54% | 26 | 4/26 | 0 | 0 |
| near-end | q95-loss1 | fixed60 | 24 | 21/3 | -26.08% | 105.54% | 26 | 4/26 | 0 | 0 |
| near-end | q95-loss1 | forceOnlyV1 | 24 | 2/2 | -0.62% | 1.25% | 26 | 4/26 | 0 | 0 |
| near-end | q95-loss1 | waitOneNoBudget | 24 | 0/0 | 0.00% | 0.00% | 26 | 4/26 | 0 | 0 |
| near-end | q99-loss1 | current | 0 | 0/0 | — | — | 0 | 0/0 | 0 | 0 |
| near-end | q99-loss1 | fixed60 | 9 | 5/4 | -11.25% | 3.17% | 0 | 0/0 | 0 | 0 |
| near-end | q99-loss1 | forceOnlyV1 | 24 | 4/20 | 56.95% | 204.46% | 0 | 0/0 | 0 | 0 |
| near-end | q99-loss1 | waitOneNoBudget | 24 | 4/20 | 57.79% | 200.69% | 0 | 0/0 | 0 | 0 |
| near-end | q95-loss3 | current | 24 | 20/4 | -20.34% | 105.54% | 26 | 4/26 | 0 | 0 |
| near-end | q95-loss3 | fixed60 | 24 | 21/3 | -26.08% | 105.54% | 26 | 4/26 | 0 | 0 |
| near-end | q95-loss3 | forceOnlyV1 | 24 | 2/2 | -0.62% | 1.25% | 26 | 4/26 | 0 | 0 |
| near-end | q95-loss3 | waitOneNoBudget | 24 | 0/0 | 0.00% | 0.00% | 26 | 4/26 | 0 | 0 |

## 仍未解决的成本估计偏差

增加等待一轮和累计风险预算只修比较路径与风险累积，不能保证基础成本估计准确。以下是按相对损失选择的最坏近结束场景，作为审计示例，不是策略特判。
场景 near-end-cheapRead-warm-0.1-0.002-12-16500-2：最坏单次 KEEP 输入费用估计 0.583000，模拟真实缓存状态计价 0.022165，高估 26.30 倍。该诊断在策略之外计算，真实缓存用量没有反向传给策略。
初次请求缓存命中为零，不等于它写回的前缀在下一次请求仍不可用。当前按历史命中覆盖度预测本次缓存的路径可能混淆这两者，因此立即结束损失估计也可能过低；风险账本不超预算不意味着真实损失被限制。应先验证缓存重建后的费用校准，再做付费收益测试。

## 限制

- Explicit uncalibrated priors, not estimated task progress or future user commands.
- No held-out endpoint, true retention or future cache condition is supplied to the policy.
- All original 1M simulation limitations apply; summary success and unchanged task output are assumed.
- Geometric survival, constant observed growth and future cache reuse can be wrong.
- WAIT compares safety-only waiting with compaction after one call; both are bounded forecast schedules, not full optimal control or a guarantee of information gain.
- Runtime risk budget is fixed from the first request estimated replay cost (ratios 1/3), charged conservatively without presumed payback refunds. Not a hard actual expense bound.
- Look-ahead truncated at 64 calls; q=0.99 leaves 52.6% survival probability beyond it.
- Policy refuses economic triggers if unmodeled tail probability exceeds 5%; q99 therefore falls back to safety.
- Immediate-loss budget is conditional on estimated costs, not an actual spending cap.
- Unneeded uses the existing bounded shadow interval, not a global optimum.
- Sensitivity cases do not establish real task-quality or majority-traffic savings.
