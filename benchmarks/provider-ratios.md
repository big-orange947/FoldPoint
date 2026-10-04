# 多供应商价格比例：零付费敏感性实验

固定同一批场景和参数，只替换公开价格。负数表示实验分支更便宜。

| 价格配置 | 缓存 | 对比 | 胜/负/平 | 平均费用变化 | 最差费用变化 |
| --- | --- | --- | --- | --- | --- |
| deepseek-flash-peak | all | 84 | 72/12/0 | -42.54% | 6.89% |
| deepseek-flash-peak | warm | 24 | 12/12/0 | 1.02% | 6.89% |
| deepseek-flash-peak | cold | 30 | 30/0/0 | -64.28% | -39.49% |
| deepseek-flash-peak | midpoint | 30 | 30/0/0 | -55.64% | -35.26% |
| deepseek-flash-offpeak | all | 84 | 72/12/0 | -42.54% | 6.89% |
| deepseek-flash-offpeak | warm | 24 | 12/12/0 | 1.02% | 6.89% |
| deepseek-flash-offpeak | cold | 30 | 30/0/0 | -64.28% | -39.49% |
| deepseek-flash-offpeak | midpoint | 30 | 30/0/0 | -55.64% | -35.26% |
| deepseek-v4-pro-peak | all | 96 | 81/15/0 | -49.60% | 7.14% |
| deepseek-v4-pro-peak | warm | 24 | 9/15/0 | 1.76% | 7.14% |
| deepseek-v4-pro-peak | cold | 36 | 36/0/0 | -71.47% | -48.99% |
| deepseek-v4-pro-peak | midpoint | 36 | 36/0/0 | -61.97% | -46.33% |
| claude-sonnet-5.5-5m-price | all | 108 | 88/20/0 | -48.21% | 8.95% |
| claude-sonnet-5.5-5m-price | warm | 36 | 16/20/0 | 0.13% | 8.95% |
| claude-sonnet-5.5-5m-price | cold | 36 | 36/0/0 | -77.84% | -63.47% |
| claude-sonnet-5.5-5m-price | midpoint | 36 | 36/0/0 | -66.90% | -57.45% |
| claude-sonnet-5.5-1h-price | all | 108 | 88/20/0 | -51.88% | 8.53% |
| claude-sonnet-5.5-1h-price | warm | 36 | 16/20/0 | -1.33% | 8.53% |
| claude-sonnet-5.5-1h-price | cold | 36 | 36/0/0 | -80.85% | -68.21% |
| claude-sonnet-5.5-1h-price | midpoint | 36 | 36/0/0 | -73.47% | -65.07% |
| claude-opus-5.5-5m-price | all | 108 | 92/16/0 | -48.78% | 7.62% |
| claude-opus-5.5-5m-price | warm | 36 | 20/16/0 | -0.20% | 7.62% |
| claude-opus-5.5-5m-price | cold | 36 | 36/0/0 | -77.84% | -63.47% |
| claude-opus-5.5-5m-price | midpoint | 36 | 36/0/0 | -68.30% | -57.74% |
| gemini-2.5-flash-text | all | 108 | 88/20/0 | -45.69% | 9.04% |
| gemini-2.5-flash-text | warm | 36 | 16/20/0 | 0.68% | 9.04% |
| gemini-2.5-flash-text | cold | 36 | 36/0/0 | -75.39% | -59.48% |
| gemini-2.5-flash-text | midpoint | 36 | 36/0/0 | -62.36% | -51.55% |
| gemini-2.5-flash-lite-text | all | 108 | 88/20/0 | -46.18% | 9.11% |
| gemini-2.5-flash-lite-text | warm | 36 | 16/20/0 | 0.63% | 9.11% |
| gemini-2.5-flash-lite-text | cold | 36 | 36/0/0 | -76.03% | -60.55% |
| gemini-2.5-flash-lite-text | midpoint | 36 | 36/0/0 | -63.13% | -52.91% |

## 价格来源（2026-10-04，USD/百万 token）

- [deepseek-flash-peak](https://api-docs.deepseek.com/quick_start/pricing/): input 0.3; output 1.2; read 0.006; write/mapping 0.3.
- [deepseek-flash-offpeak](https://api-docs.deepseek.com/quick_start/pricing/): input 0.15; output 0.6; read 0.003; write/mapping 0.15.
- [deepseek-v4-pro-peak](https://api-docs.deepseek.com/quick_start/pricing/): input 1.32; output 3.96; read 0.044; write/mapping 1.32.
- [claude-sonnet-5.5-5m-price](https://platform.claude.com/docs/en/about-claude/pricing): input 2; output 10; read 0.2; write/mapping 2.5.
- [claude-sonnet-5.5-1h-price](https://platform.claude.com/docs/en/about-claude/pricing): input 2; output 10; read 0.2; write/mapping 4.
- [claude-opus-5.5-5m-price](https://platform.claude.com/docs/en/about-claude/pricing): input 4; output 20; read 0.2; write/mapping 5.
- [gemini-2.5-flash-text](https://ai.google.dev/gemini-api/docs/pricing): input 0.3; output 2.5; read 0.03; write/mapping 0.3.
- [gemini-2.5-flash-lite-text](https://ai.google.dev/gemini-api/docs/pricing): input 0.1; output 0.4; read 0.01; write/mapping 0.1.

## 边界

- 只替换价格；所有模型保持相同 1M 窗口、token 数、缓存寿命、增长和压缩器质量，不证明真实模型支持该配置或任务质量。
- 实验分支固定 q=0.95/loss=1，不按供应商调参；不是默认算法，也不是已上线 Pi 策略。
- 价格名中的 5m/1h 只选择写价，缓存寿命仍是共同场景假设，不是对应服务商的完整制度模拟。
- 未列独立写价的服务商按 input 价映射 write；忽略显式缓存存储费、最低缓存门槛、长上下文阶梯、tokenizer 差异和额外思考 token。
- 共享模拟器把存活缓存的新增尾部按 input 计价；不模拟 Claude 新尾部 cache-write 的完整账单。
- Pi 原生是阈值代理，不是真实 Pi 执行；有权威 append-only 前缀的实验条件不保证真实宿主提供。
- 相对变化为逐场景算术平均，不是按真实流量加权；无压缩双方排除胜负但保留明细。
- DeepSeek peak/offpeak 是同一比例缩放控制，不算独立价格比例；所有旧报告保留。

完整 JSON 含近结束反例、原生阈值代理和核心默认分支对照、每条成本与压缩步骤。不得将结果当作多模型真实付费账单或质量结论。
