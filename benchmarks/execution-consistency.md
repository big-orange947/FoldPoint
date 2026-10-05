# 执行一致性与预测误差（固定 60% 对照）

负数为省钱，所有案例为已见回归场景。

| 价格 | 分组 | 策略 | 胜/负/平 | 平均变化 | 最差变化 | 压缩次数 |
| --- | --- | --- | --- | --- | --- | --- |
| deepseek-flash-peak | seen-floor | previous | 3/5/0 | -0.15% | 2.71% | 94 |
| deepseek-flash-peak | seen-floor | feasible | 3/5/0 | -0.15% | 2.71% | 94 |
| deepseek-flash-peak | seen-proportional | previous | 7/1/0 | -7.07% | 1.21% | 278 |
| deepseek-flash-peak | seen-proportional | feasible | 7/1/0 | -7.07% | 1.21% | 278 |
| deepseek-flash-peak | seen-model | previous | 5/3/0 | -1.04% | 2.76% | 118 |
| deepseek-flash-peak | seen-model | feasible | 5/3/0 | -1.04% | 2.76% | 118 |
| deepseek-flash-offpeak | seen-floor | previous | 3/5/0 | -0.15% | 2.71% | 94 |
| deepseek-flash-offpeak | seen-floor | feasible | 3/5/0 | -0.15% | 2.71% | 94 |
| deepseek-flash-offpeak | seen-proportional | previous | 7/1/0 | -7.07% | 1.21% | 278 |
| deepseek-flash-offpeak | seen-proportional | feasible | 7/1/0 | -7.07% | 1.21% | 278 |
| deepseek-flash-offpeak | seen-model | previous | 5/3/0 | -1.04% | 2.76% | 118 |
| deepseek-flash-offpeak | seen-model | feasible | 5/3/0 | -1.04% | 2.76% | 118 |
| deepseek-v4-pro-peak | seen-floor | previous | 1/7/0 | 1.87% | 3.50% | 97 |
| deepseek-v4-pro-peak | seen-floor | feasible | 1/7/0 | 1.87% | 3.50% | 97 |
| deepseek-v4-pro-peak | seen-proportional | previous | 7/1/0 | -8.69% | 5.03% | 293 |
| deepseek-v4-pro-peak | seen-proportional | feasible | 7/1/0 | -8.69% | 5.03% | 293 |
| deepseek-v4-pro-peak | seen-model | previous | 4/4/0 | 1.24% | 7.81% | 80 |
| deepseek-v4-pro-peak | seen-model | feasible | 4/4/0 | 1.24% | 7.81% | 80 |
| claude-sonnet-5.5-5m-price | seen-floor | previous | 4/4/0 | -3.60% | 4.66% | 151 |
| claude-sonnet-5.5-5m-price | seen-floor | feasible | 4/4/0 | -3.54% | 4.66% | 152 |
| claude-sonnet-5.5-5m-price | seen-proportional | previous | 8/0/0 | -29.27% | -17.88% | 412 |
| claude-sonnet-5.5-5m-price | seen-proportional | feasible | 8/0/0 | -29.27% | -17.88% | 412 |
| claude-sonnet-5.5-5m-price | seen-model | previous | 4/4/0 | -8.15% | 2.48% | 171 |
| claude-sonnet-5.5-5m-price | seen-model | feasible | 4/4/0 | -8.42% | 2.28% | 170 |
| claude-sonnet-5.5-1h-price | seen-floor | previous | 2/6/0 | 2.34% | 6.20% | 101 |
| claude-sonnet-5.5-1h-price | seen-floor | feasible | 2/6/0 | 2.34% | 6.20% | 101 |
| claude-sonnet-5.5-1h-price | seen-proportional | previous | 8/0/0 | -27.64% | -15.99% | 410 |
| claude-sonnet-5.5-1h-price | seen-proportional | feasible | 8/0/0 | -27.54% | -14.92% | 409 |
| claude-sonnet-5.5-1h-price | seen-model | previous | 3/5/0 | -1.77% | 5.80% | 116 |
| claude-sonnet-5.5-1h-price | seen-model | feasible | 3/5/0 | -2.51% | 2.53% | 119 |
| claude-opus-5.5-5m-price | seen-floor | previous | 1/7/0 | 2.10% | 3.41% | 98 |
| claude-opus-5.5-5m-price | seen-floor | feasible | 1/7/0 | 2.10% | 3.41% | 98 |
| claude-opus-5.5-5m-price | seen-proportional | previous | 8/0/0 | -17.01% | -10.06% | 387 |
| claude-opus-5.5-5m-price | seen-proportional | feasible | 8/0/0 | -17.01% | -10.06% | 387 |
| claude-opus-5.5-5m-price | seen-model | previous | 2/6/0 | 0.75% | 7.24% | 81 |
| claude-opus-5.5-5m-price | seen-model | feasible | 2/6/0 | 0.75% | 7.24% | 81 |
| gemini-2.5-flash-text | seen-floor | previous | 4/4/0 | -2.34% | 4.61% | 144 |
| gemini-2.5-flash-text | seen-floor | feasible | 4/4/0 | -2.47% | 4.61% | 144 |
| gemini-2.5-flash-text | seen-proportional | previous | 8/0/0 | -29.45% | -19.50% | 414 |
| gemini-2.5-flash-text | seen-proportional | feasible | 8/0/0 | -29.45% | -19.50% | 414 |
| gemini-2.5-flash-text | seen-model | previous | 4/4/0 | -6.33% | 2.57% | 146 |
| gemini-2.5-flash-text | seen-model | feasible | 4/4/0 | -6.39% | 2.57% | 146 |
| gemini-2.5-flash-lite-text | seen-floor | previous | 5/3/0 | -9.41% | 3.36% | 197 |
| gemini-2.5-flash-lite-text | seen-floor | feasible | 5/3/0 | -8.53% | 3.36% | 191 |
| gemini-2.5-flash-lite-text | seen-proportional | previous | 8/0/0 | -30.12% | -19.95% | 414 |
| gemini-2.5-flash-lite-text | seen-proportional | feasible | 8/0/0 | -30.12% | -19.95% | 414 |
| gemini-2.5-flash-lite-text | seen-model | previous | 4/4/0 | -10.18% | 10.04% | 213 |
| gemini-2.5-flash-lite-text | seen-model | feasible | 4/4/0 | -11.10% | 2.24% | 212 |

## 成功压缩的预测误差

有符号正数为高估；绝对误差不是任务质量指标。

| 策略 | 阶段 | 样本 | 长度有符号 | 长度绝对 | 费用有符号 | 费用绝对 |
| --- | --- | --- | --- | --- | --- | --- |
| previous | cold-start | 576 | 6.42% | 60.23% | -3.80% | 7.68% |
| previous | low-span | 1102 | -0.31% | 0.31% | -0.01% | 0.01% |
| previous | interpolation | 2882 | 1.10% | 1.56% | 0.00% | 0.00% |
| previous | extrapolation | 345 | -2.05% | 2.20% | -0.00% | 0.00% |
| feasible | cold-start | 576 | 6.42% | 60.23% | -3.82% | 7.66% |
| feasible | low-span | 1102 | -0.31% | 0.31% | -0.01% | 0.01% |
| feasible | interpolation | 2877 | 1.03% | 1.49% | 0.00% | 0.00% |
| feasible | extrapolation | 345 | -1.99% | 2.20% | -0.00% | 0.00% |

## 限制

- 全部 24 个组合已经看过，只作执行一致性归因回归，不称盲测；价格、先验、拟合与余量均未重调。
- 未来经济压缩现在应用宿主冷却、最小回收量/比例与 soft-window；安全 FORCE 不受这些经济门阻拦。
- 预测中的最小回收使用预测压缩结果；真实分支仍依赖核心已学习比例的门，因此不是完整递归执行策略。
- 成功压缩才有保留长度误差；误差表受策略选择影响，不能证明所有 KEEP 点的压缩结果准确。
- 误差按实际压缩后的反馈结算，不提前反馈诊断结果；费用相对误差与长度相对误差逐样本平均。
- 预测阻拦数是各次 eligible 决策选中 NOW 路径里的假设事件，重复预测会重复计数，不是实际否决次数。
- 八组冻结价格含一组等比例缩放控制；合成任务和误差不能证明真实 Pi 的任务质量或供应商缓存语义。
- 不读取 key、不进行付费调用、不切换核心或 Pi 默认策略，保留所有旧结果。
