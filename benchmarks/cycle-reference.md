# 暖缓存重复周期费用诊断

负数为比固定 60% 周期参考更便宜；不是有限任务的实际节费。边界列为 token 均值。

| 冻结价格配置 | 计费假设 | 选定周期 vs 60% | vs 稳定周期最低参考 | 选定边界 | 最低参考边界 | 当前建议压缩 |
| --- | --- | --- | --- | --- | --- | --- |
| deepseek-flash-peak | summary-uncached | -6.27% | 2.63% | 400138 | 292649 | 0/4 |
| deepseek-flash-peak | hypothetical-summary-shared-80 | -5.98% | 0.42% | 318128 | 281744 | 0/4 |
| deepseek-flash-peak | hypothetical-shared-80-prewarm-1 | -5.90% | 0.47% | 327443 | 287416 | 0/4 |
| deepseek-flash-offpeak | summary-uncached | -6.27% | 2.63% | 400138 | 292649 | 0/4 |
| deepseek-flash-offpeak | hypothetical-summary-shared-80 | -5.98% | 0.42% | 318128 | 281744 | 0/4 |
| deepseek-flash-offpeak | hypothetical-shared-80-prewarm-1 | -5.90% | 0.47% | 327443 | 287416 | 0/4 |
| deepseek-v4-pro-peak | summary-uncached | -8.84% | 3.81% | 363486 | 232577 | 0/4 |
| deepseek-v4-pro-peak | hypothetical-summary-shared-80 | -11.05% | 1.06% | 255357 | 226905 | 2/4 |
| deepseek-v4-pro-peak | hypothetical-shared-80-prewarm-1 | -10.91% | 1.10% | 264064 | 226905 | 2/4 |
| claude-sonnet-5.5-5m-price | summary-uncached | -21.72% | 3.49% | 201900 | 183076 | 3/4 |
| claude-sonnet-5.5-5m-price | hypothetical-summary-shared-80 | -26.22% | 2.44% | 192585 | 172506 | 4/4 |
| claude-sonnet-5.5-5m-price | hypothetical-shared-80-prewarm-1 | -25.86% | 2.38% | 192585 | 183076 | 4/4 |
| claude-sonnet-5.5-1h-price | summary-uncached | -19.77% | 3.50% | 228628 | 204991 | 2/4 |
| claude-sonnet-5.5-1h-price | hypothetical-summary-shared-80 | -23.64% | 2.22% | 210607 | 199319 | 3/4 |
| claude-sonnet-5.5-1h-price | hypothetical-shared-80-prewarm-1 | -23.36% | 2.18% | 210607 | 204991 | 3/4 |
| claude-opus-5.5-5m-price | summary-uncached | -12.00% | 3.03% | 291400 | 226905 | 2/4 |
| claude-opus-5.5-5m-price | hypothetical-summary-shared-80 | -14.59% | 0.90% | 228628 | 221233 | 2/4 |
| claude-opus-5.5-5m-price | hypothetical-shared-80-prewarm-1 | -14.40% | 0.95% | 246042 | 221233 | 2/4 |
| gemini-2.5-flash-text | summary-uncached | -21.39% | 2.84% | 201900 | 172506 | 3/4 |
| gemini-2.5-flash-text | hypothetical-summary-shared-80 | -25.96% | 1.45% | 183270 | 166834 | 4/4 |
| gemini-2.5-flash-text | hypothetical-shared-80-prewarm-1 | -25.47% | 1.50% | 192585 | 172506 | 4/4 |
| gemini-2.5-flash-lite-text | summary-uncached | -22.74% | 3.85% | 192585 | 172506 | 3/4 |
| gemini-2.5-flash-lite-text | hypothetical-summary-shared-80 | -27.88% | 2.67% | 174563 | 166834 | 4/4 |
| gemini-2.5-flash-lite-text | hypothetical-shared-80-prewarm-1 | -27.41% | 2.65% | 174563 | 166834 | 4/4 |

## 限制

- 稳态诊断，不是新的长任务实测胜率：无任务终点、无缓存过期、无失败、无重试、无质量评测。固定 60% 只是同假设下的周期参考费用。
- 摘要共享 80% 与额外输出 1 token 的预热是显式假设，不是 Pi 的实测缓存命中率；不同摘要提示词可能完全不共享缓存。
- 保留/输出模型只拟合先前独立模拟会话的成功反馈，不给策略真实底座；测试组合已经看过，不是新盲测。历史采集费用独立保留，不计为免费。
- 稳定 n 调用循环按仿射固定点求解；阈值循环可能长短交替，均要求至少 3 次普通调用，先丢弃 100 周期，再聚合 1000 周期总费用/普通工作调用数。阈值跨越有增长 overshoot，未模拟安全提前打断；它是参考族，不保证覆盖所有策略。
- 普通工作调用作分母；摘要与预热额外收费，不能靠增加请求数降低单位成本。默认核心、Pi、原完整任务 simulator 与旧报告均未切换。
- 普通输出设为 0，只比较输入/摘要/预热费用；摘要和预热输出均计费。加入相同普通输出会稀释相对百分比，但不改变周期排序。这里的百分比不是完整任务总账单节省。
- 有限 runtime 的选定边界与无限稳态的目标不同；差距只能定位待验证项，不能据此声称算法错误或真实节费。
- 周期参考假设普通请求可读取完整的上一轮前缀；有限预测仍采用学习到的覆盖率与压力预测。引用边界后的费用是独立理想化核对，不是有限预测费用的重放。
