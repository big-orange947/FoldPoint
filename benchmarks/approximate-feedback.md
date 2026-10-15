# 近似压缩反馈：来源与误差假设

离线检查：8/8 通过；新增付费调用 0。
已有真实 Pi 元数据仅作回放，每个误差假设分支都只接收同一份观测一次。精确样本仍为 0。

| before/after 误差假设 | 同尺寸回代点估计 | 假设下历史包络 |
| --- | ---: | ---: |
| 0% | 1474.0 | 1474.0–1474.0 |
| 10% | 1474.0 | 1205.4–1802.3 |
| 25% | 1474.0 | 883.9–2457.8 |

没有为了拟合而将 1474、1518 或 1532 当成相同含义的真值。误差假设不改变这份观测的名义点估计，只改变范围及后续学习影响；同尺寸回代不代表实测预测改进。

## 检查

- coldAbstains: PASS
- admitsApproximateWithoutUpgradingTruth: PASS
- zeroBudgetStillNotTruth: PASS
- errorAssumptionsDoNotShiftNominal: PASS
- largerAssumptionsWidenEnvelope: PASS
- knownSyntheticValueInsideEnvelope: PASS
- syntheticFeedbackImprovesOverColdPrior: PASS
- noPolicyAction: PASS

## 限制

- 0%/10%/25% 是误差假设敏感性，不是由这一次 Pi 实测估出来的误差率。
- Pi before 是利用上次 provider 用量校准的宿主上下文估计，after 是消息估计；误差预算必须覆盖估计方法差异，当前未校准。
- 只有一次真实压缩，不能证明下一次预测准确；同尺寸回代不是留出验证。
- 历史包络不是统计置信区间；未观测输入范围外的预测会标为 extrapolated。
- 这是比例 EMA，不是 affine 模型；固定保留底座、跨尺寸变化和任务阶段变化仍可能造成误差。
- 增长修正仅在同一宿主估计单位且由宿主提供范围时可用；provider 完整 prompt 不自动混进来。
- 近似模型独立于精确 affine 模型和精确校准；默认核心/Pi 策略、旧实测和费用均未更改。
