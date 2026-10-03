# 新动态策略的 1M 验证

## 2026-10-03 实测结果

算法提交 `b86eea3`，真实 DeepSeek 完整执行：140/140 阶段正确，140 次普通调用，
3 次 policy 发起的经济压缩，0 次失败、0 次宿主重试，未触发预算停机。
最大决策上下文 616,457 token。没有配置任务专用 compactor 输入上限。

| 项目 | 数值 |
| --- | ---: |
| 普通调用估算费用 | $0.9642357 |
| 压缩调用估算费用 | $0.5327442 |
| 缓存预热费用 | $0 |
| 总估算费用 | $1.4969799 |
| 普通调用累计 prompt tokens | 43,432,199 |
| 无法计费的压缩 | 0 |

| 次数 | 决策时 context | Pi 压缩记录 before | 压后 after |
| --- | ---: | ---: | ---: |
| 1 | 615,983 | 609,865 | 56,117 |
| 2 | 616,457 | 610,339 | 56,653 |
| 3 | 600,512 | 594,391 | 56,659 |

三个决策都为 `COMPACT`，原因 `ECONOMIC_TRIGGER` 与
`DEFERRED_COMPACTION_COSTLIER`。第三个决策仍在 60% 以上；Pi 摘要准备过程中的
token 估计不同，所以压缩记录的 before 小于 600K。保留率约 9.2%–9.5%。

同一个 manifest SHA-256 为
`63c70f37fd5c35ebc096cc011d5f579e32b7bc054b432f7644854f983df24260`；
新旧完整运行的价格 fingerprint 相同。

| 不同批次参考 | 总估算费用 | 成功压缩 | 新动态组相对差异 |
| --- | ---: | ---: | ---: |
| 旧固定 60% | $1.500053412 | 3 | -0.20% |
| 旧动态 75% 诊断 | $1.64460684 | 3 | -8.98% |
| 新动态 60%–70% | $1.4969799 | 3 | — |

本轮证明这份 1M 长任务上主动经济压缩、10% 保留率先验和完整费用结算可以正常运行。
相对固定 60% 的差距只有约 $0.0031，单轮跨批次数据无法证明动态算法更优；
140 道结构化答案正确也不等于通用代码任务质量已验证。该任务已经参与开发校准，
应将下一份不同增长/缓存模式的任务作为留出验证，而不是继续调整本任务阈值。

本地原始产物在 `traces/pi-ledger-1m-dynamic70-20261003-01-report.json` 与
`traces/pi-ledger-1m-dynamic70-20261003-01-dynamic.jsonl`，按轨迹隐私策略不入 Git。

本轮使用冻结的 `controlled-project-ledger-1m-v2` 140 轮任务，模型声明窗口 1,000,000。
仅执行 dynamic，保留此前 default 与 fixed60 的付费报告作为不同批次参考。

代码默认：保留率 0.10、经济区间 60%–70%、单轮增长保护、NOW/DEFER 成本比较；
Pi 摘要输出先验 0.002。活动会话 horizon 使用可配置的次线性更新，系数是开发集
校准过的产品先验，尚未通过独立留出任务验证。

运行前清除旧试验的 `FOLDPOINT_DEFAULTS` 与 `FOLDPOINT_COMPACTOR_SAFE_INPUT_TOKENS`，
避免旧的 75% 或 730K 上限覆盖本轮默认。key 由当前进程环境提供。

```powershell
$env:PI_CLI = 'D:\pi\packages\coding-agent\dist\bundle\cli.js'
Remove-Item Env:FOLDPOINT_DEFAULTS -ErrorAction SilentlyContinue
Remove-Item Env:FOLDPOINT_COMPACTOR_SAFE_INPUT_TOKENS -ErrorAction SilentlyContinue
npx tsx tools/pi-million-rpc.ts --manifest traces/pi-ledger-1m-v2/manifest.json --agent-base traces/pi-million-base --out traces/pi-ledger-1m-dynamic70-20261003-01 --run-window-tokens 1000000 --arm dynamic --cache-run-id dynamic70-20261003-01 --min-compactions 2 --max-cost-usd 3 --max-prompt-tokens 120000000
```

验收读取全部阶段正确率、成功/失败压缩、摘要与普通调用费用、缓存命中及压缩位置。
预算检查发生在每个阶段完成后，因此单阶段可能超出停机线。费用由 provider 用量和
Pi 价格表计算，尚非账单核对值。单独 dynamic 运行不能通过三臂 superiority 门；
与旧 fixed60 的比较只能作为跨批次参考，不能声称严格配对胜出。

合成 benchmark 当前成本 182.13，低于共享 70% 安全线的固定策略 189.33，但高于
raw 50% 的 170.93；28 次可判定压缩有 11 次区间内未回本。此结果说明仍需检验
暖缓存、快速回涨和失败压缩情形，不能据此声称大部分真实任务都省钱。
