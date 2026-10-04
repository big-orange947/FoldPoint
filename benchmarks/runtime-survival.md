# Runtime 继续概率：零付费实验

实验策略未接管 Pi，也未替换核心默认策略。参数预先列举作敏感性检查，不选择获胜参数作默认。

平均成本变化是逐场景相对差值的算术平均；不是实际用户流量加权结果。无压缩场景不计为胜利。

| 场景组 | 参数 | 基线 | 比较数 | 胜/负 | 平均变化 | 最坏变化 | 经济压缩 | 未回本/判定 | 溢出 | 首压<20%的场景 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| matrix | q80-loss1 | current | 288 | 215/1 | -33.03% | 0.00% | 2174 | 0/2174 | 0 | 216 |
| matrix | q80-loss1 | fixed60 | 288 | 183/105 | -28.40% | 20.31% | 2174 | 0/2174 | 0 | 216 |
| matrix | q80-loss1 | forceOnlyV1 | 324 | 28/235 | 140.52% | 804.41% | 2174 | 0/2174 | 0 | 216 |
| matrix | q80-loss1 | waitOneNoBudget | 324 | 150/134 | 15.92% | 146.97% | 2174 | 0/2174 | 0 | 216 |
| matrix | q80-loss1 | cacheAwareNoBudget | 300 | 41/134 | 61.61% | 602.44% | 2174 | 0/2174 | 0 | 216 |
| matrix | q95-loss1 | current | 300 | 247/1 | -34.13% | 0.00% | 2222 | 0/2222 | 0 | 234 |
| matrix | q95-loss1 | fixed60 | 300 | 199/101 | -29.78% | 15.57% | 2222 | 0/2222 | 0 | 234 |
| matrix | q95-loss1 | forceOnlyV1 | 324 | 28/235 | 133.61% | 804.41% | 2222 | 0/2222 | 0 | 234 |
| matrix | q95-loss1 | waitOneNoBudget | 324 | 156/128 | 11.84% | 146.97% | 2222 | 0/2222 | 0 | 234 |
| matrix | q95-loss1 | cacheAwareNoBudget | 300 | 41/134 | 54.66% | 602.44% | 2222 | 0/2222 | 0 | 234 |
| matrix | q99-loss1 | current | 216 | 0/0 | 0.00% | 0.00% | 0 | 0/0 | 0 | 0 |
| matrix | q99-loss1 | fixed60 | 216 | 16/200 | 9.35% | 20.32% | 0 | 0/0 | 0 | 0 |
| matrix | q99-loss1 | forceOnlyV1 | 324 | 28/296 | 291.72% | 892.03% | 0 | 0/0 | 0 | 0 |
| matrix | q99-loss1 | waitOneNoBudget | 324 | 33/291 | 77.05% | 180.80% | 0 | 0/0 | 0 | 0 |
| matrix | q99-loss1 | cacheAwareNoBudget | 300 | 1/275 | 186.45% | 892.03% | 0 | 0/0 | 0 | 0 |
| matrix | q95-loss3 | current | 300 | 271/1 | -36.82% | 0.00% | 2268 | 6/2268 | 0 | 234 |
| matrix | q95-loss3 | fixed60 | 300 | 221/79 | -32.79% | 15.57% | 2268 | 6/2268 | 0 | 234 |
| matrix | q95-loss3 | forceOnlyV1 | 324 | 28/264 | 122.50% | 789.85% | 2268 | 6/2268 | 0 | 234 |
| matrix | q95-loss3 | waitOneNoBudget | 324 | 178/110 | 6.45% | 141.80% | 2268 | 6/2268 | 0 | 234 |
| matrix | q95-loss3 | cacheAwareNoBudget | 300 | 17/109 | 43.29% | 462.43% | 2268 | 6/2268 | 0 | 234 |
| near-end | q80-loss1 | current | 20 | 18/2 | -31.36% | 3.68% | 25 | 3/25 | 0 | 0 |
| near-end | q80-loss1 | fixed60 | 21 | 19/0 | -34.22% | 0.00% | 25 | 3/25 | 0 | 0 |
| near-end | q80-loss1 | forceOnlyV1 | 24 | 5/2 | -0.44% | 76.12% | 25 | 3/25 | 0 | 0 |
| near-end | q80-loss1 | waitOneNoBudget | 24 | 6/3 | 0.19% | 76.12% | 25 | 3/25 | 0 | 0 |
| near-end | q80-loss1 | cacheAwareNoBudget | 20 | 0/3 | 3.76% | 40.57% | 25 | 3/25 | 0 | 0 |
| near-end | q95-loss1 | current | 20 | 20/0 | -34.13% | -9.18% | 24 | 0/24 | 0 | 0 |
| near-end | q95-loss1 | fixed60 | 21 | 21/0 | -36.76% | -9.18% | 24 | 0/24 | 0 | 0 |
| near-end | q95-loss1 | forceOnlyV1 | 24 | 7/1 | -3.94% | 36.98% | 24 | 0/24 | 0 | 0 |
| near-end | q95-loss1 | waitOneNoBudget | 24 | 7/1 | -3.32% | 36.98% | 24 | 0/24 | 0 | 0 |
| near-end | q95-loss1 | cacheAwareNoBudget | 20 | 0/0 | 0.00% | 0.00% | 24 | 0/24 | 0 | 0 |
| near-end | q99-loss1 | current | 0 | 0/0 | — | — | 0 | 0/0 | 0 | 0 |
| near-end | q99-loss1 | fixed60 | 9 | 5/4 | -11.25% | 3.17% | 0 | 0/0 | 0 | 0 |
| near-end | q99-loss1 | forceOnlyV1 | 24 | 4/20 | 56.95% | 204.46% | 0 | 0/0 | 0 | 0 |
| near-end | q99-loss1 | waitOneNoBudget | 24 | 4/20 | 57.79% | 200.69% | 0 | 0/0 | 0 | 0 |
| near-end | q99-loss1 | cacheAwareNoBudget | 20 | 0/20 | 73.19% | 204.46% | 0 | 0/0 | 0 | 0 |
| near-end | q95-loss3 | current | 20 | 20/0 | -34.13% | -9.18% | 24 | 0/24 | 0 | 0 |
| near-end | q95-loss3 | fixed60 | 21 | 21/0 | -36.76% | -9.18% | 24 | 0/24 | 0 | 0 |
| near-end | q95-loss3 | forceOnlyV1 | 24 | 7/1 | -3.94% | 36.98% | 24 | 0/24 | 0 | 0 |
| near-end | q95-loss3 | waitOneNoBudget | 24 | 7/1 | -3.32% | 36.98% | 24 | 0/24 | 0 | 0 |
| near-end | q95-loss3 | cacheAwareNoBudget | 20 | 0/0 | 0.00% | 0.00% | 24 | 0/24 | 0 | 0 |

## 缓存校准与剩余限制

缓存感知分支增加宿主连续前缀信息；以下是按相对成本选择的近结束审计示例，不是策略特判。即使校准通过，结束风险、未来缓存与质量仍不确定。
场景 near-end-cheapRead-warm-0.1-0.002-12-16500-1：最坏单次 KEEP 输入费用估计 0.566500，模拟真实缓存状态计价 0.566500，高估 1.00 倍。该诊断在策略之外计算，真实缓存用量没有反向传给策略。
缓存感知分支用宿主确认未变的已发送前缀估价；未声明该信息的旧候选仍保留作对照。这里的精确计价只验证模拟器的完整前缀/TTL 假设，真实 provider 驱逐、块对齐和缓存共享仍未被证明。风险账本不超预算不意味着真实任务质量得到保证。

## 按运行长度对比 fixed60

单次损失比例仍为 1；cacheAwareNoBudget 不加累计门，q95-loss1 加累计门。两者 q=0.95，没有选择获胜概率。12/60/140 是模拟调用数，不是真实任务难度，逐场景均值不代表真实流量。

| 调用数 | 候选 | 比较数 | 胜/负 | 平均费用变化 | 最坏变化 | 压缩次数 |
| --- | --- | --- | --- | --- | --- | --- |
| 12 | cacheAwareNoBudget | 84 | 84/0 | -46.23% | -4.85% | 214 |
| 12 | q95-loss1 | 84 | 84/0 | -48.41% | -4.85% | 218 |
| 60 | cacheAwareNoBudget | 108 | 88/20 | -47.47% | 8.95% | 1003 |
| 60 | q95-loss1 | 108 | 57/51 | -25.25% | 14.13% | 812 |
| 140 | cacheAwareNoBudget | 108 | 96/12 | -49.48% | 6.69% | 2387 |
| 140 | q95-loss1 | 108 | 58/50 | -19.82% | 15.57% | 1710 |

## 限制

- Explicit uncalibrated priors, not estimated task progress or future user commands.
- No held-out endpoint, true retention or future cache condition is supplied to the policy.
- Cache-aware arms declare the simulator's append-only prefix contract using their own previously sent prompt length, not future hit counts; real hosts must verify continuity.
- All original 1M simulation limitations apply; summary success and unchanged task output are assumed.
- Geometric survival, constant observed growth and future cache reuse can be wrong.
- WAIT compares safety-only waiting with compaction after one call; both are bounded forecast schedules, not full optimal control or a guarantee of information gain.
- Runtime risk budget is fixed from the first request estimated replay cost (ratios 1/3), charged conservatively without presumed payback refunds. Not a hard actual expense bound.
- Look-ahead truncated at 64 calls; q=0.99 leaves 52.6% survival probability beyond it.
- Policy refuses economic triggers if unmodeled tail probability exceeds 5%; q99 therefore falls back to safety.
- Immediate-loss budget is conditional on estimated costs, not an actual spending cap.
- Unneeded uses the existing bounded shadow interval, not a global optimum.
- Sensitivity cases do not establish real task-quality or majority-traffic savings.
