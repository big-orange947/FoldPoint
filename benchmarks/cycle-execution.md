# 暖缓存完整任务：逐轮执行与固定 60%

负数为实际完整模拟账单更低，包含普通输出、摘要及预热。不是供应商实测或任务质量证明。

| 冻结价格 | 计费假设 | 胜/负 | 平均变化 | 最差变化 | 经济/强制压缩 | 高于假想重复边界仍 KEEP | 最长连续次数 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| deepseek-flash-peak | summary-uncached | 2/2 | 0.48% | 1.34% | 5/33 | 289 | 26 |
| deepseek-flash-peak | hypothetical-summary-shared-80 | 1/3 | 0.52% | 1.29% | 5/29 | 387 | 26 |
| deepseek-flash-peak | hypothetical-shared-80-prewarm-1 | 1/3 | 0.66% | 1.28% | 4/30 | 385 | 26 |
| deepseek-flash-offpeak | summary-uncached | 2/2 | 0.48% | 1.34% | 5/33 | 289 | 26 |
| deepseek-flash-offpeak | hypothetical-summary-shared-80 | 1/3 | 0.52% | 1.29% | 5/29 | 387 | 26 |
| deepseek-flash-offpeak | hypothetical-shared-80-prewarm-1 | 1/3 | 0.66% | 1.28% | 4/30 | 385 | 26 |
| deepseek-v4-pro-peak | summary-uncached | 1/3 | 0.60% | 2.26% | 23/30 | 283 | 27 |
| deepseek-v4-pro-peak | hypothetical-summary-shared-80 | 2/2 | -0.13% | 1.50% | 10/28 | 451 | 27 |
| deepseek-v4-pro-peak | hypothetical-shared-80-prewarm-1 | 1/3 | 0.03% | 1.49% | 8/30 | 449 | 27 |
| claude-sonnet-5.5-5m-price | summary-uncached | 3/1 | -6.78% | 4.34% | 46/11 | 429 | 21 |
| claude-sonnet-5.5-5m-price | hypothetical-summary-shared-80 | 4/0 | -17.84% | -8.33% | 70/0 | 332 | 9 |
| claude-sonnet-5.5-5m-price | hypothetical-shared-80-prewarm-1 | 4/0 | -15.97% | -5.75% | 65/1 | 353 | 11 |
| claude-sonnet-5.5-1h-price | summary-uncached | 1/3 | 1.60% | 3.57% | 4/32 | 494 | 26 |
| claude-sonnet-5.5-1h-price | hypothetical-summary-shared-80 | 2/2 | -11.36% | 1.54% | 48/9 | 360 | 13 |
| claude-sonnet-5.5-1h-price | hypothetical-shared-80-prewarm-1 | 2/2 | -9.67% | 4.13% | 42/16 | 372 | 13 |
| claude-opus-5.5-5m-price | summary-uncached | 0/4 | 1.59% | 1.77% | 2/34 | 434 | 26 |
| claude-opus-5.5-5m-price | hypothetical-summary-shared-80 | 2/2 | -4.68% | 1.99% | 26/23 | 405 | 16 |
| claude-opus-5.5-5m-price | hypothetical-shared-80-prewarm-1 | 3/1 | -7.65% | 1.98% | 54/11 | 353 | 15 |
| gemini-2.5-flash-text | summary-uncached | 3/1 | -5.71% | 2.49% | 52/5 | 435 | 23 |
| gemini-2.5-flash-text | hypothetical-summary-shared-80 | 4/0 | -16.59% | -7.19% | 68/0 | 347 | 10 |
| gemini-2.5-flash-text | hypothetical-shared-80-prewarm-1 | 4/0 | -15.75% | -1.49% | 69/2 | 324 | 13 |
| gemini-2.5-flash-lite-text | summary-uncached | 3/1 | -11.32% | 0.41% | 80/5 | 348 | 21 |
| gemini-2.5-flash-lite-text | hypothetical-summary-shared-80 | 4/0 | -21.73% | -7.54% | 87/0 | 292 | 8 |
| gemini-2.5-flash-lite-text | hypothetical-shared-80-prewarm-1 | 4/0 | -20.01% | -9.71% | 79/0 | 330 | 13 |

## 限制

- 180 次普通工作调用、1M 窗口、暖缓存长任务的完整模拟；同价格/同增长流比较固定 60% 与实际逐轮重新决策，普通输出、摘要、预热均收费。
- 摘要共享 80% 与输出 1 token 的预热为显式合成假设，不是 Pi 的实测缓存。假设各前缀可共存、请求成功；没有改变真实 Pi 插件。
- 历史来自事先独立模拟会话，训练费用单列；没有读取当前任务未来终点，仍使用既有未校准的持续时间先验、压力与执行门。
- 高于预测中的重复边界但 KEEP 只是预测/行动不一致的诊断：边界属于假想 NOW 后的周期，不是当前状态的强制压缩承诺。连续等待不能单凭此计数认定为 bug。
- 全部组合已经看过，不是盲测；保留所有负结果，不按价格特判。失败/TTL 用单元回归覆盖，主表只代表持续暖缓存成功路径，尚未验证任务质量。
