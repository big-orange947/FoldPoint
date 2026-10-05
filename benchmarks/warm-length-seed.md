# 暖缓存长任务：冻结参数的长度与种子扩展

负数为相对固定 60% 更便宜；全部合成费用，非真实模型质量成绩。

## 主表

| 冻结价格 | 计费假设 | 调用长度 | 候选 | 数量 | 胜/负/平 | 平均变化 | 总账变化 | 最差变化 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| deepseek-flash-peak | summary-uncached | all | paired | 36 | 17/19/0 | 0.69% | 0.21% | 8.61% |
| deepseek-flash-peak | summary-uncached | all | common | 36 | 17/19/0 | 0.66% | 0.18% | 8.61% |
| deepseek-v4-pro-peak | summary-uncached | all | paired | 36 | 19/17/0 | -0.11% | -0.56% | 7.86% |
| deepseek-v4-pro-peak | summary-uncached | all | common | 36 | 19/17/0 | -0.11% | -0.56% | 7.86% |
| claude-sonnet-5.5-5m-price | summary-uncached | all | paired | 36 | 33/3/0 | -11.86% | -11.85% | 0.73% |
| claude-sonnet-5.5-5m-price | summary-uncached | all | common | 36 | 33/3/0 | -11.86% | -11.85% | 0.73% |
| claude-sonnet-5.5-1h-price | summary-uncached | all | paired | 36 | 29/7/0 | -6.84% | -6.62% | 2.02% |
| claude-sonnet-5.5-1h-price | summary-uncached | all | common | 36 | 27/9/0 | -6.58% | -6.30% | 3.97% |
| claude-opus-5.5-5m-price | summary-uncached | all | paired | 36 | 6/30/0 | 2.72% | 2.18% | 8.65% |
| claude-opus-5.5-5m-price | summary-uncached | all | common | 36 | 6/30/0 | 2.74% | 2.16% | 8.65% |
| gemini-2.5-flash-text | summary-uncached | all | paired | 36 | 35/1/0 | -11.52% | -11.61% | 1.77% |
| gemini-2.5-flash-text | summary-uncached | all | common | 36 | 35/1/0 | -11.47% | -11.58% | 1.77% |
| gemini-2.5-flash-lite-text | summary-uncached | all | paired | 36 | 36/0/0 | -14.50% | -14.60% | -2.48% |
| gemini-2.5-flash-lite-text | summary-uncached | all | common | 36 | 36/0/0 | -14.36% | -14.41% | -2.79% |

## 按长度

| 冻结价格 | 计费假设 | 调用长度 | 候选 | 数量 | 胜/负/平 | 平均变化 | 总账变化 | 最差变化 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| deepseek-flash-peak | summary-uncached | 120 | paired | 12 | 7/5/0 | 1.18% | 0.26% | 8.61% |
| deepseek-flash-peak | summary-uncached | 120 | common | 12 | 7/5/0 | 1.18% | 0.26% | 8.61% |
| deepseek-flash-peak | summary-uncached | 240 | paired | 12 | 4/8/0 | 0.69% | 0.28% | 3.73% |
| deepseek-flash-peak | summary-uncached | 240 | common | 12 | 4/8/0 | 0.69% | 0.28% | 3.73% |
| deepseek-flash-peak | summary-uncached | 360 | paired | 12 | 6/6/0 | 0.21% | 0.15% | 2.04% |
| deepseek-flash-peak | summary-uncached | 360 | common | 12 | 6/6/0 | 0.10% | 0.08% | 2.04% |
| deepseek-v4-pro-peak | summary-uncached | 120 | paired | 12 | 9/3/0 | -0.01% | -0.95% | 7.86% |
| deepseek-v4-pro-peak | summary-uncached | 120 | common | 12 | 9/3/0 | -0.01% | -0.95% | 7.86% |
| deepseek-v4-pro-peak | summary-uncached | 240 | paired | 12 | 6/6/0 | -0.18% | -0.60% | 3.54% |
| deepseek-v4-pro-peak | summary-uncached | 240 | common | 12 | 6/6/0 | -0.18% | -0.60% | 3.54% |
| deepseek-v4-pro-peak | summary-uncached | 360 | paired | 12 | 4/8/0 | -0.14% | -0.42% | 2.55% |
| deepseek-v4-pro-peak | summary-uncached | 360 | common | 12 | 4/8/0 | -0.14% | -0.42% | 2.55% |
| claude-sonnet-5.5-5m-price | summary-uncached | 120 | paired | 12 | 9/3/0 | -9.99% | -9.37% | 0.73% |
| claude-sonnet-5.5-5m-price | summary-uncached | 120 | common | 12 | 9/3/0 | -9.99% | -9.37% | 0.73% |
| claude-sonnet-5.5-5m-price | summary-uncached | 240 | paired | 12 | 12/0/0 | -12.41% | -11.88% | -0.69% |
| claude-sonnet-5.5-5m-price | summary-uncached | 240 | common | 12 | 12/0/0 | -12.41% | -11.88% | -0.69% |
| claude-sonnet-5.5-5m-price | summary-uncached | 360 | paired | 12 | 12/0/0 | -13.19% | -12.63% | -0.18% |
| claude-sonnet-5.5-5m-price | summary-uncached | 360 | common | 12 | 12/0/0 | -13.19% | -12.63% | -0.18% |
| claude-sonnet-5.5-1h-price | summary-uncached | 120 | paired | 12 | 9/3/0 | -5.68% | -5.09% | 1.94% |
| claude-sonnet-5.5-1h-price | summary-uncached | 120 | common | 12 | 9/3/0 | -5.47% | -4.83% | 3.97% |
| claude-sonnet-5.5-1h-price | summary-uncached | 240 | paired | 12 | 10/2/0 | -6.67% | -6.08% | 0.83% |
| claude-sonnet-5.5-1h-price | summary-uncached | 240 | common | 12 | 9/3/0 | -6.30% | -5.64% | 2.01% |
| claude-sonnet-5.5-1h-price | summary-uncached | 360 | paired | 12 | 10/2/0 | -8.17% | -7.46% | 2.02% |
| claude-sonnet-5.5-1h-price | summary-uncached | 360 | common | 12 | 9/3/0 | -7.96% | -7.21% | 1.92% |
| claude-opus-5.5-5m-price | summary-uncached | 120 | paired | 12 | 4/8/0 | 3.74% | 2.70% | 8.65% |
| claude-opus-5.5-5m-price | summary-uncached | 120 | common | 12 | 4/8/0 | 3.86% | 2.78% | 8.65% |
| claude-opus-5.5-5m-price | summary-uncached | 240 | paired | 12 | 2/10/0 | 2.44% | 2.26% | 4.69% |
| claude-opus-5.5-5m-price | summary-uncached | 240 | common | 12 | 2/10/0 | 2.53% | 2.33% | 4.69% |
| claude-opus-5.5-5m-price | summary-uncached | 360 | paired | 12 | 0/12/0 | 1.98% | 1.96% | 4.17% |
| claude-opus-5.5-5m-price | summary-uncached | 360 | common | 12 | 0/12/0 | 1.84% | 1.86% | 2.57% |
| gemini-2.5-flash-text | summary-uncached | 120 | paired | 12 | 11/1/0 | -9.56% | -8.94% | 1.77% |
| gemini-2.5-flash-text | summary-uncached | 120 | common | 12 | 11/1/0 | -9.49% | -8.88% | 1.77% |
| gemini-2.5-flash-text | summary-uncached | 240 | paired | 12 | 12/0/0 | -11.92% | -11.49% | -1.33% |
| gemini-2.5-flash-text | summary-uncached | 240 | common | 12 | 12/0/0 | -11.84% | -11.43% | -1.33% |
| gemini-2.5-flash-text | summary-uncached | 360 | paired | 12 | 12/0/0 | -13.07% | -12.54% | -1.89% |
| gemini-2.5-flash-text | summary-uncached | 360 | common | 12 | 12/0/0 | -13.08% | -12.55% | -1.89% |
| gemini-2.5-flash-lite-text | summary-uncached | 120 | paired | 12 | 12/0/0 | -12.94% | -12.63% | -2.87% |
| gemini-2.5-flash-lite-text | summary-uncached | 120 | common | 12 | 12/0/0 | -12.94% | -12.64% | -2.87% |
| gemini-2.5-flash-lite-text | summary-uncached | 240 | paired | 12 | 12/0/0 | -14.71% | -14.31% | -2.48% |
| gemini-2.5-flash-lite-text | summary-uncached | 240 | common | 12 | 12/0/0 | -14.54% | -14.19% | -2.79% |
| gemini-2.5-flash-lite-text | summary-uncached | 360 | paired | 12 | 12/0/0 | -15.86% | -15.41% | -3.26% |
| gemini-2.5-flash-lite-text | summary-uncached | 360 | common | 12 | 12/0/0 | -15.61% | -15.13% | -2.80% |

## 360 次调用的平均费用差拆分

每列为候选减固定 60% 的模拟 USD/任务；普通请求含压缩后重建，摘要与独立预热另列。不是实际账单。

| 冻结价格 | 候选 | 普通请求（含重建） | 摘要 | 独立预热 | 总差额 |
| --- | --- | --- | --- | --- | --- |
| deepseek-flash-peak | paired | 0.0189 | -0.0065 | 0.0000 | 0.0124 |
| deepseek-flash-peak | common | 0.0204 | -0.0142 | 0.0000 | 0.0062 |
| deepseek-v4-pro-peak | paired | -0.2595 | 0.1050 | 0.0000 | -0.1545 |
| deepseek-v4-pro-peak | common | -0.2595 | 0.1050 | 0.0000 | -0.1545 |
| claude-sonnet-5.5-5m-price | paired | -9.8220 | 0.8436 | 0.0000 | -8.9784 |
| claude-sonnet-5.5-5m-price | common | -9.8220 | 0.8436 | 0.0000 | -8.9784 |
| claude-sonnet-5.5-1h-price | paired | -5.7373 | 0.2913 | 0.0000 | -5.4460 |
| claude-sonnet-5.5-1h-price | common | -5.5686 | 0.3068 | 0.0000 | -5.2618 |
| claude-opus-5.5-5m-price | paired | 2.5011 | -0.1184 | 0.0000 | 2.3827 |
| claude-opus-5.5-5m-price | common | 2.5239 | -0.2672 | 0.0000 | 2.2567 |
| gemini-2.5-flash-text | paired | -1.5037 | 0.1602 | 0.0000 | -1.3434 |
| gemini-2.5-flash-text | common | -1.4980 | 0.1538 | 0.0000 | -1.3442 |
| gemini-2.5-flash-lite-text | paired | -0.5840 | 0.0434 | 0.0000 | -0.5406 |
| gemini-2.5-flash-lite-text | common | -0.5750 | 0.0444 | 0.0000 | -0.5306 |

## 同一增长流换结束位置的稳定性

每个流固定种子/增长/底座，只改变 120/240/360 的结束位置。符号翻转只证明结束位置敏感，不自动归因为最后一个周期。

| 冻结价格 | 候选 | 流数 | 三个长度都胜 | 三个长度都负 | 胜负翻转 |
| --- | --- | --- | --- | --- | --- |
| deepseek-flash-peak | paired | 12 | 2 | 1 | 9 |
| deepseek-flash-peak | common | 12 | 2 | 1 | 9 |
| deepseek-v4-pro-peak | paired | 12 | 4 | 3 | 5 |
| deepseek-v4-pro-peak | common | 12 | 4 | 3 | 5 |
| claude-sonnet-5.5-5m-price | paired | 12 | 9 | 0 | 3 |
| claude-sonnet-5.5-5m-price | common | 12 | 9 | 0 | 3 |
| claude-sonnet-5.5-1h-price | paired | 12 | 9 | 1 | 2 |
| claude-sonnet-5.5-1h-price | common | 12 | 9 | 3 | 0 |
| claude-opus-5.5-5m-price | paired | 12 | 0 | 8 | 4 |
| claude-opus-5.5-5m-price | common | 12 | 0 | 8 | 4 |
| gemini-2.5-flash-text | paired | 12 | 11 | 0 | 1 |
| gemini-2.5-flash-text | common | 12 | 11 | 0 | 1 |
| gemini-2.5-flash-lite-text | paired | 12 | 12 | 0 | 0 |
| gemini-2.5-flash-lite-text | common | 12 | 12 | 0 | 0 |

## 有限计费敏感性

| 冻结价格 | 计费假设 | 调用长度 | 候选 | 数量 | 胜/负/平 | 平均变化 | 总账变化 | 最差变化 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| deepseek-flash-peak | hypothetical-summary-shared-80 | all | paired | 3 | 0/3/0 | 1.86% | 1.46% | 2.77% |
| deepseek-flash-peak | hypothetical-summary-shared-80 | all | common | 3 | 0/3/0 | 1.86% | 1.46% | 2.77% |
| deepseek-flash-peak | hypothetical-shared-80-prewarm-1 | all | paired | 3 | 0/3/0 | 1.77% | 1.35% | 3.47% |
| deepseek-flash-peak | hypothetical-shared-80-prewarm-1 | all | common | 3 | 0/3/0 | 1.77% | 1.35% | 3.47% |
| deepseek-v4-pro-peak | hypothetical-summary-shared-80 | all | paired | 3 | 3/0/0 | -14.43% | -14.86% | -13.15% |
| deepseek-v4-pro-peak | hypothetical-summary-shared-80 | all | common | 3 | 3/0/0 | -14.43% | -14.86% | -13.15% |
| deepseek-v4-pro-peak | hypothetical-shared-80-prewarm-1 | all | paired | 3 | 3/0/0 | -14.39% | -14.83% | -13.10% |
| deepseek-v4-pro-peak | hypothetical-shared-80-prewarm-1 | all | common | 3 | 3/0/0 | -14.39% | -14.83% | -13.10% |
| claude-sonnet-5.5-5m-price | hypothetical-summary-shared-80 | all | paired | 3 | 3/0/0 | -32.03% | -32.49% | -30.65% |
| claude-sonnet-5.5-5m-price | hypothetical-summary-shared-80 | all | common | 3 | 3/0/0 | -32.03% | -32.49% | -30.65% |
| claude-sonnet-5.5-5m-price | hypothetical-shared-80-prewarm-1 | all | paired | 3 | 3/0/0 | -31.61% | -32.08% | -30.14% |
| claude-sonnet-5.5-5m-price | hypothetical-shared-80-prewarm-1 | all | common | 3 | 3/0/0 | -31.61% | -32.08% | -30.14% |
| claude-sonnet-5.5-1h-price | hypothetical-summary-shared-80 | all | paired | 3 | 3/0/0 | -32.08% | -32.40% | -31.03% |
| claude-sonnet-5.5-1h-price | hypothetical-summary-shared-80 | all | common | 3 | 3/0/0 | -32.08% | -32.40% | -31.03% |
| claude-sonnet-5.5-1h-price | hypothetical-shared-80-prewarm-1 | all | paired | 3 | 3/0/0 | -31.87% | -32.25% | -30.77% |
| claude-sonnet-5.5-1h-price | hypothetical-shared-80-prewarm-1 | all | common | 3 | 3/0/0 | -31.87% | -32.25% | -30.77% |
| claude-opus-5.5-5m-price | hypothetical-summary-shared-80 | all | paired | 3 | 3/0/0 | -19.35% | -19.88% | -17.64% |
| claude-opus-5.5-5m-price | hypothetical-summary-shared-80 | all | common | 3 | 3/0/0 | -19.35% | -19.88% | -17.64% |
| claude-opus-5.5-5m-price | hypothetical-shared-80-prewarm-1 | all | paired | 3 | 3/0/0 | -19.20% | -19.79% | -17.38% |
| claude-opus-5.5-5m-price | hypothetical-shared-80-prewarm-1 | all | common | 3 | 3/0/0 | -19.20% | -19.79% | -17.38% |
| gemini-2.5-flash-text | hypothetical-summary-shared-80 | all | paired | 3 | 3/0/0 | -32.64% | -32.91% | -31.80% |
| gemini-2.5-flash-text | hypothetical-summary-shared-80 | all | common | 3 | 3/0/0 | -32.64% | -32.91% | -31.80% |
| gemini-2.5-flash-text | hypothetical-shared-80-prewarm-1 | all | paired | 3 | 3/0/0 | -32.37% | -32.74% | -31.11% |
| gemini-2.5-flash-text | hypothetical-shared-80-prewarm-1 | all | common | 3 | 3/0/0 | -32.37% | -32.74% | -31.11% |
| gemini-2.5-flash-lite-text | hypothetical-summary-shared-80 | all | paired | 3 | 3/0/0 | -33.23% | -33.79% | -31.39% |
| gemini-2.5-flash-lite-text | hypothetical-summary-shared-80 | all | common | 3 | 3/0/0 | -33.23% | -33.79% | -31.39% |
| gemini-2.5-flash-lite-text | hypothetical-shared-80-prewarm-1 | all | paired | 3 | 3/0/0 | -32.91% | -33.38% | -31.61% |
| gemini-2.5-flash-lite-text | hypothetical-shared-80-prewarm-1 | all | common | 3 | 3/0/0 | -32.91% | -33.38% | -31.61% |

## 前缀一致性

588 条区间/策略检查通过：相同增长前缀、完整压缩记录和公共决策点。区间账单见 JSON，不反馈给算法。

## 限制

- 算法与参数冻结在 69d2752；新 seeds/长度首次扩展验证，读完结果后即为已见合成数据，不再称盲测。
- 252 组主表为完整价格×底座×增长×种子×长度组合；42 组计费敏感性只覆盖 22k 增长/20k 底座/seed151，不外推到全部组合。
- 主对照固定 60%；配对压力候选与共同后续候选都保留，未选择表现最好的版本替换负结果。offpeak 标量对照不重复计作独立价格比例。
- 除首请求建立缓存外，TTL 内持续暖缓存；所有压缩成功、恒定增长分布、兼容历史为合成前提，不代表真实任务质量或 provider 缓存行为。
- 摘要/重建/独立预热与普通输出全部计费，历史采集成本单列。费用平均变化与总账比例是不同统计口径，无人口分布或置信区间保证。
- 共同增长前缀、实际压缩与公共决策点相同后，区间账单才用长减短。结束位置敏感性是诊断，不证明全部差异来自最后周期；尚未分解预测误差原因。
- 不读 API key、不调用模型，不改默认核心/Pi 策略，不把真实未来长度喂给决策。
