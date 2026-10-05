# 历史复用与首压阶段账单（固定 60%）

负数为省钱；早期/后期贡献以固定 60% 的完整任务费用为分母，二者相加为平均变化。

| 价格 | 分组 | 策略 | 胜/负/平 | 平均变化 | 最差变化 | 早期贡献 | 后期贡献 | 压缩次数 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| deepseek-flash-peak | seen-floor | cold | 3/5/0 | -0.15% | 2.71% | -4.43% | 4.28% | 94 |
| deepseek-flash-peak | seen-floor | warmTokens | 2/6/0 | 1.29% | 2.46% | -4.43% | 5.72% | 95 |
| deepseek-flash-peak | seen-floor | warmCore | 2/6/0 | 1.29% | 2.46% | -4.43% | 5.72% | 95 |
| deepseek-flash-peak | seen-proportional | cold | 7/1/0 | -7.07% | 1.21% | -6.97% | -0.10% | 278 |
| deepseek-flash-peak | seen-proportional | warmTokens | 8/0/0 | -7.43% | -0.10% | -6.97% | -0.46% | 284 |
| deepseek-flash-peak | seen-proportional | warmCore | 8/0/0 | -7.43% | -0.10% | -6.97% | -0.46% | 284 |
| deepseek-flash-peak | seen-model | cold | 5/3/0 | -1.04% | 2.76% | -6.52% | 5.47% | 118 |
| deepseek-flash-peak | seen-model | warmTokens | 5/3/0 | 0.80% | 6.67% | -6.52% | 7.32% | 112 |
| deepseek-flash-peak | seen-model | warmCore | 5/3/0 | 0.80% | 6.67% | -6.52% | 7.32% | 112 |
| deepseek-flash-offpeak | seen-floor | cold | 3/5/0 | -0.15% | 2.71% | -4.43% | 4.28% | 94 |
| deepseek-flash-offpeak | seen-floor | warmTokens | 2/6/0 | 1.29% | 2.46% | -4.43% | 5.72% | 95 |
| deepseek-flash-offpeak | seen-floor | warmCore | 2/6/0 | 1.29% | 2.46% | -4.43% | 5.72% | 95 |
| deepseek-flash-offpeak | seen-proportional | cold | 7/1/0 | -7.07% | 1.21% | -6.97% | -0.10% | 278 |
| deepseek-flash-offpeak | seen-proportional | warmTokens | 8/0/0 | -7.43% | -0.10% | -6.97% | -0.46% | 284 |
| deepseek-flash-offpeak | seen-proportional | warmCore | 8/0/0 | -7.43% | -0.10% | -6.97% | -0.46% | 284 |
| deepseek-flash-offpeak | seen-model | cold | 5/3/0 | -1.04% | 2.76% | -6.52% | 5.47% | 118 |
| deepseek-flash-offpeak | seen-model | warmTokens | 5/3/0 | 0.80% | 6.67% | -6.52% | 7.32% | 112 |
| deepseek-flash-offpeak | seen-model | warmCore | 5/3/0 | 0.80% | 6.67% | -6.52% | 7.32% | 112 |
| deepseek-v4-pro-peak | seen-floor | cold | 1/7/0 | 1.87% | 3.50% | -3.95% | 5.82% | 97 |
| deepseek-v4-pro-peak | seen-floor | warmTokens | 3/5/0 | 0.73% | 3.31% | -4.14% | 4.86% | 123 |
| deepseek-v4-pro-peak | seen-floor | warmCore | 3/5/0 | 0.73% | 3.31% | -4.14% | 4.86% | 123 |
| deepseek-v4-pro-peak | seen-proportional | cold | 7/1/0 | -8.69% | 5.03% | -6.67% | -2.02% | 293 |
| deepseek-v4-pro-peak | seen-proportional | warmTokens | 7/1/0 | -9.85% | 5.90% | -6.63% | -3.21% | 339 |
| deepseek-v4-pro-peak | seen-proportional | warmCore | 7/1/0 | -9.85% | 5.90% | -6.63% | -3.21% | 339 |
| deepseek-v4-pro-peak | seen-model | cold | 4/4/0 | 1.24% | 7.81% | -5.85% | 7.09% | 80 |
| deepseek-v4-pro-peak | seen-model | warmTokens | 6/2/0 | -2.68% | 7.22% | -6.12% | 3.45% | 179 |
| deepseek-v4-pro-peak | seen-model | warmCore | 6/2/0 | -2.68% | 7.22% | -6.12% | 3.45% | 179 |
| claude-sonnet-5.5-5m-price | seen-floor | cold | 4/4/0 | -3.54% | 4.66% | -1.94% | -1.60% | 152 |
| claude-sonnet-5.5-5m-price | seen-floor | warmTokens | 6/2/0 | -6.81% | 4.34% | -1.98% | -4.83% | 149 |
| claude-sonnet-5.5-5m-price | seen-floor | warmCore | 6/2/0 | -7.01% | 2.74% | -1.98% | -5.03% | 150 |
| claude-sonnet-5.5-5m-price | seen-proportional | cold | 8/0/0 | -29.27% | -17.88% | -4.44% | -24.83% | 412 |
| claude-sonnet-5.5-5m-price | seen-proportional | warmTokens | 8/0/0 | -28.57% | -16.08% | -4.42% | -24.15% | 406 |
| claude-sonnet-5.5-5m-price | seen-proportional | warmCore | 8/0/0 | -28.57% | -16.08% | -4.42% | -24.15% | 406 |
| claude-sonnet-5.5-5m-price | seen-model | cold | 4/4/0 | -8.42% | 2.28% | -2.79% | -5.63% | 170 |
| claude-sonnet-5.5-5m-price | seen-model | warmTokens | 4/4/0 | -6.46% | 8.76% | -3.71% | -2.74% | 157 |
| claude-sonnet-5.5-5m-price | seen-model | warmCore | 4/4/0 | -6.46% | 8.76% | -3.71% | -2.74% | 157 |
| claude-sonnet-5.5-1h-price | seen-floor | cold | 2/6/0 | 2.34% | 6.20% | -2.26% | 4.60% | 101 |
| claude-sonnet-5.5-1h-price | seen-floor | warmTokens | 1/7/0 | 2.72% | 6.18% | -2.36% | 5.08% | 90 |
| claude-sonnet-5.5-1h-price | seen-floor | warmCore | 1/7/0 | 2.72% | 6.18% | -2.36% | 5.08% | 90 |
| claude-sonnet-5.5-1h-price | seen-proportional | cold | 8/0/0 | -27.54% | -14.92% | -4.33% | -23.21% | 409 |
| claude-sonnet-5.5-1h-price | seen-proportional | warmTokens | 8/0/0 | -27.00% | -14.56% | -4.15% | -22.85% | 405 |
| claude-sonnet-5.5-1h-price | seen-proportional | warmCore | 8/0/0 | -27.00% | -14.56% | -4.15% | -22.85% | 405 |
| claude-sonnet-5.5-1h-price | seen-model | cold | 3/5/0 | -2.51% | 2.53% | -3.77% | 1.26% | 119 |
| claude-sonnet-5.5-1h-price | seen-model | warmTokens | 4/4/0 | -2.95% | 9.04% | -5.02% | 2.07% | 115 |
| claude-sonnet-5.5-1h-price | seen-model | warmCore | 4/4/0 | -2.95% | 9.04% | -5.02% | 2.07% | 115 |
| claude-opus-5.5-5m-price | seen-floor | cold | 1/7/0 | 2.10% | 3.41% | -3.66% | 5.76% | 98 |
| claude-opus-5.5-5m-price | seen-floor | warmTokens | 0/8/0 | 2.62% | 4.28% | -3.78% | 6.40% | 90 |
| claude-opus-5.5-5m-price | seen-floor | warmCore | 0/8/0 | 2.62% | 4.28% | -3.78% | 6.40% | 90 |
| claude-opus-5.5-5m-price | seen-proportional | cold | 8/0/0 | -17.01% | -10.06% | -4.00% | -13.01% | 387 |
| claude-opus-5.5-5m-price | seen-proportional | warmTokens | 8/0/0 | -15.19% | -2.98% | -4.00% | -11.19% | 369 |
| claude-opus-5.5-5m-price | seen-proportional | warmCore | 8/0/0 | -15.19% | -2.98% | -4.00% | -11.19% | 369 |
| claude-opus-5.5-5m-price | seen-model | cold | 2/6/0 | 0.75% | 7.24% | -5.50% | 6.24% | 81 |
| claude-opus-5.5-5m-price | seen-model | warmTokens | 6/2/0 | -2.82% | 7.71% | -5.77% | 2.95% | 167 |
| claude-opus-5.5-5m-price | seen-model | warmCore | 6/2/0 | -2.82% | 7.71% | -5.77% | 2.95% | 167 |
| gemini-2.5-flash-text | seen-floor | cold | 4/4/0 | -2.47% | 4.61% | -1.87% | -0.59% | 144 |
| gemini-2.5-flash-text | seen-floor | warmTokens | 6/2/0 | -6.66% | 1.17% | -1.77% | -4.89% | 144 |
| gemini-2.5-flash-text | seen-floor | warmCore | 6/2/0 | -6.66% | 1.17% | -1.77% | -4.89% | 144 |
| gemini-2.5-flash-text | seen-proportional | cold | 8/0/0 | -29.45% | -19.50% | -4.35% | -25.10% | 414 |
| gemini-2.5-flash-text | seen-proportional | warmTokens | 8/0/0 | -28.57% | -16.33% | -4.22% | -24.35% | 407 |
| gemini-2.5-flash-text | seen-proportional | warmCore | 8/0/0 | -28.57% | -16.33% | -4.22% | -24.35% | 407 |
| gemini-2.5-flash-text | seen-model | cold | 4/4/0 | -6.39% | 2.57% | -3.36% | -3.03% | 146 |
| gemini-2.5-flash-text | seen-model | warmTokens | 4/4/0 | -7.64% | 7.37% | -3.85% | -3.79% | 192 |
| gemini-2.5-flash-text | seen-model | warmCore | 4/4/0 | -7.64% | 7.37% | -3.85% | -3.79% | 192 |
| gemini-2.5-flash-lite-text | seen-floor | cold | 5/3/0 | -8.53% | 3.36% | -2.20% | -6.33% | 191 |
| gemini-2.5-flash-lite-text | seen-floor | warmTokens | 8/0/0 | -11.86% | -0.82% | -2.04% | -9.82% | 202 |
| gemini-2.5-flash-lite-text | seen-floor | warmCore | 8/0/0 | -11.86% | -0.82% | -2.04% | -9.82% | 202 |
| gemini-2.5-flash-lite-text | seen-proportional | cold | 8/0/0 | -30.12% | -19.95% | -4.44% | -25.68% | 414 |
| gemini-2.5-flash-lite-text | seen-proportional | warmTokens | 8/0/0 | -29.22% | -16.72% | -4.29% | -24.93% | 407 |
| gemini-2.5-flash-lite-text | seen-proportional | warmCore | 8/0/0 | -29.22% | -16.72% | -4.29% | -24.93% | 407 |
| gemini-2.5-flash-lite-text | seen-model | cold | 4/4/0 | -11.10% | 2.24% | -3.42% | -7.68% | 212 |
| gemini-2.5-flash-lite-text | seen-model | warmTokens | 4/4/0 | -10.00% | 4.53% | -2.86% | -7.14% | 196 |
| gemini-2.5-flash-lite-text | seen-model | warmCore | 4/4/0 | -10.00% | 4.53% | -2.86% | -7.14% | 196 |

## 限制

- 历史由两次独立的此前合成任务产生（85 步、seed 601、固定 25%/60% 采集），不来自待评测任务的未来压缩。
- 这是已知兼容的同一合成压缩器对照；fixture 分组只用于控制实验，不是生产自动识别压缩器/底座的算法。
- warmTokens 只复用 token/输入费用模型，warmCore 也复用保留率/输出统计；都不继承缓存、当前调用计数、任务终点或 horizon。
- 历史采集费用单独保留，评测费用假设已有这些历史；不是学习免费，也不建议额外付费强制压缩来制造训练数据。
- 阶段分界统一取固定 60% 首次成功压缩的那一轮；差额相加严格等于总差额，但不是首压造成损失的因果证明。
- 全部评测组合已经看过；固定采集配方没有按评测成绩调参，但不能称为新的盲测或真实任务质量验证。
- 不换核心/Pi 默认策略、不读 key、不调用付费 API；冻结价格只是报价比例模拟，包含等比例控制。
