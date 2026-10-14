# 修复候选冻结全矩阵：费用与压缩频率

冻结 8c054cc，不调参数。252 主组合 + 63 短任务，候选与 fixed60 全部执行，无旧结果拼接；缓存仅用于相同版本中断续跑。

| 冻结价格 | 胜/负 vs60 | 平均费用变化 | 最坏变化 | 摘要次数 候选/60 | 中位压缩间隔 候选/60 | 中位压缩利用率 候选/60 |
| --- | --- | --- | --- | --- | --- | --- |
| deepseek-flash-peak | 14/22 | 1.47% | 9.34% | 487/466 | 15/14 | 67.75%/61.86% |
| deepseek-v4-pro-peak | 16/20 | 0.11% | 8.73% | 672/466 | 7/14 | 65.66%/61.86% |
| claude-sonnet-5.5-5m-price | 36/0 | -16.40% | -5.14% | 1248/466 | 7/14 | 18.76%/61.86% |
| claude-sonnet-5.5-1h-price | 36/0 | -13.81% | -2.03% | 1023/466 | 8/14 | 22.75%/61.86% |
| claude-opus-5.5-5m-price | 21/15 | -0.24% | 8.41% | 522/466 | 15/14 | 62.24%/61.86% |
| gemini-2.5-flash-text | 36/0 | -16.35% | -5.45% | 1254/466 | 7/14 | 18.99%/61.86% |
| gemini-2.5-flash-lite-text | 36/0 | -17.85% | -6.55% | 1386/466 | 6/14 | 17.84%/61.86% |

主矩阵完成 252/252，短任务 63/63，硬失败 0。原成功主组合 250 组账单不变，原中断 2 组修复。
前缀审计 168/168；短任务 63/63 费用与旧候选相同，vs60 最坏增支 13.15%。

压缩频率是风险信号，不是任务质量分数；成本降低不等于已证明频繁压缩不会丢失任务信息。未加入按价格或场景的特殊分支，未因频率高而在本轮另调冷却或阈值。

## 限制

- Every candidate and fixed60 arm executed in this run (versioned execution checkpoints may resume identical runs); old bills used only as regression references, never as new simulation output.
- 252 main endpoints are correlated synthetic warm success paths, not independent real tasks. Same previously seen seeds, no heldout or task-quality claim.
- Prices are frozen ratios, not current provider quotes or actual cross-model tests. Summary does not share cache; no TTL, failure, or prewarm regime claim.
- Ordinary outputs, summary calls and rebuilds are charged; prior history collection bills are separate. Low synthetic cost with frequent summaries does not prove information retention.
- Core defaults and Pi timing are unchanged; no prior, drift tolerance, price, margin or threshold tuning in this replication.
