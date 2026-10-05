# 压缩固定项预测实验（主对照 60%）

负数为省钱，所有摘要与缓存重建费用均计入。

| 价格 | 分组 | 策略 | 胜/负/平 | 平均变化 | 最差变化 | 压缩次数 |
| --- | --- | --- | --- | --- | --- | --- |
| deepseek-flash-peak | seen-floor | ratio | 6/2/0 | -0.91% | 7.24% | 230 |
| deepseek-flash-peak | seen-floor | learned | 3/5/0 | -0.15% | 2.71% | 94 |
| deepseek-flash-peak | seen-proportional | ratio | 7/1/0 | -7.07% | 1.21% | 278 |
| deepseek-flash-peak | seen-proportional | learned | 7/1/0 | -7.07% | 1.21% | 278 |
| deepseek-flash-peak | fresh-fixed-term | ratio | 4/4/0 | -1.13% | 6.06% | 179 |
| deepseek-flash-peak | fresh-fixed-term | learned | 5/3/0 | -1.04% | 2.76% | 118 |
| deepseek-flash-offpeak | seen-floor | ratio | 6/2/0 | -0.91% | 7.24% | 230 |
| deepseek-flash-offpeak | seen-floor | learned | 3/5/0 | -0.15% | 2.71% | 94 |
| deepseek-flash-offpeak | seen-proportional | ratio | 7/1/0 | -7.07% | 1.21% | 278 |
| deepseek-flash-offpeak | seen-proportional | learned | 7/1/0 | -7.07% | 1.21% | 278 |
| deepseek-flash-offpeak | fresh-fixed-term | ratio | 4/4/0 | -1.13% | 6.06% | 179 |
| deepseek-flash-offpeak | fresh-fixed-term | learned | 5/3/0 | -1.04% | 2.76% | 118 |
| deepseek-v4-pro-peak | seen-floor | ratio | 4/4/0 | -1.64% | 9.98% | 420 |
| deepseek-v4-pro-peak | seen-floor | learned | 1/7/0 | 1.87% | 3.50% | 97 |
| deepseek-v4-pro-peak | seen-proportional | ratio | 7/1/0 | -9.77% | 0.36% | 313 |
| deepseek-v4-pro-peak | seen-proportional | learned | 7/1/0 | -8.69% | 5.03% | 293 |
| deepseek-v4-pro-peak | fresh-fixed-term | ratio | 4/4/0 | -2.75% | 6.80% | 283 |
| deepseek-v4-pro-peak | fresh-fixed-term | learned | 4/4/0 | 1.24% | 7.81% | 80 |
| claude-sonnet-5.5-5m-price | seen-floor | ratio | 6/2/0 | -10.57% | 3.82% | 544 |
| claude-sonnet-5.5-5m-price | seen-floor | learned | 4/4/0 | -3.60% | 4.66% | 151 |
| claude-sonnet-5.5-5m-price | seen-proportional | ratio | 8/0/0 | -29.82% | -21.49% | 417 |
| claude-sonnet-5.5-5m-price | seen-proportional | learned | 8/0/0 | -29.27% | -17.88% | 412 |
| claude-sonnet-5.5-5m-price | fresh-fixed-term | ratio | 4/4/0 | -5.33% | 18.39% | 413 |
| claude-sonnet-5.5-5m-price | fresh-fixed-term | learned | 4/4/0 | -8.15% | 2.48% | 171 |
| claude-sonnet-5.5-1h-price | seen-floor | ratio | 4/4/0 | -4.09% | 16.20% | 532 |
| claude-sonnet-5.5-1h-price | seen-floor | learned | 2/6/0 | 2.34% | 6.20% | 101 |
| claude-sonnet-5.5-1h-price | seen-proportional | ratio | 8/0/0 | -28.27% | -19.71% | 416 |
| claude-sonnet-5.5-1h-price | seen-proportional | learned | 8/0/0 | -27.64% | -15.99% | 410 |
| claude-sonnet-5.5-1h-price | fresh-fixed-term | ratio | 4/4/0 | 0.33% | 29.15% | 407 |
| claude-sonnet-5.5-1h-price | fresh-fixed-term | learned | 3/5/0 | -1.77% | 5.80% | 116 |
| claude-opus-5.5-5m-price | seen-floor | ratio | 4/4/0 | -1.69% | 9.60% | 440 |
| claude-opus-5.5-5m-price | seen-floor | learned | 1/7/0 | 2.10% | 3.41% | 98 |
| claude-opus-5.5-5m-price | seen-proportional | ratio | 8/0/0 | -16.90% | -9.44% | 387 |
| claude-opus-5.5-5m-price | seen-proportional | learned | 8/0/0 | -17.01% | -10.06% | 387 |
| claude-opus-5.5-5m-price | fresh-fixed-term | ratio | 4/4/0 | -0.06% | 17.03% | 336 |
| claude-opus-5.5-5m-price | fresh-fixed-term | learned | 2/6/0 | 0.75% | 7.24% | 81 |
| gemini-2.5-flash-text | seen-floor | ratio | 6/2/0 | -10.74% | 1.97% | 544 |
| gemini-2.5-flash-text | seen-floor | learned | 4/4/0 | -2.34% | 4.61% | 144 |
| gemini-2.5-flash-text | seen-proportional | ratio | 8/0/0 | -29.77% | -21.77% | 417 |
| gemini-2.5-flash-text | seen-proportional | learned | 8/0/0 | -29.45% | -19.50% | 414 |
| gemini-2.5-flash-text | fresh-fixed-term | ratio | 4/4/0 | -4.27% | 17.40% | 413 |
| gemini-2.5-flash-text | fresh-fixed-term | learned | 4/4/0 | -6.33% | 2.57% | 146 |
| gemini-2.5-flash-lite-text | seen-floor | ratio | 8/0/0 | -13.41% | -1.21% | 546 |
| gemini-2.5-flash-lite-text | seen-floor | learned | 5/3/0 | -9.41% | 3.36% | 197 |
| gemini-2.5-flash-lite-text | seen-proportional | ratio | 8/0/0 | -30.44% | -22.24% | 417 |
| gemini-2.5-flash-lite-text | seen-proportional | learned | 8/0/0 | -30.12% | -19.95% | 414 |
| gemini-2.5-flash-lite-text | fresh-fixed-term | ratio | 4/4/0 | -8.99% | 12.94% | 419 |
| gemini-2.5-flash-lite-text | fresh-fixed-term | learned | 4/4/0 | -10.18% | 10.04% | 213 |

## 限制

- 只学习当前会话已经成功压缩的元数据，不输入真实 floor、未来结果或任务终点；不修改核心/Pi 默认策略。
- 主对照固定 60%，不在不同阈值中挑最有利对照；旧报告保持原样。
- 非负仿射只是近似，不能证明固定底座存在；不同输入跨度不足时回退比例估计，窗口最多 32 条。
- 残差压力不是置信区间；区间外外推、输出成本与缓存制度变化可能失准。
- 样本全部来自合成轨迹，没有证明真实 Pi 任务质量，价格只替换冻结报价比例。
- fresh-fixed-term 是本轮首次运行的新组合，查看后即为已见数据，不再称盲测。
