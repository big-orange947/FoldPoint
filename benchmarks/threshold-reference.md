# 固定阈值网格：费用机会参考

计划929b413先冻结。24格既有场景，每格实际执行5%到70%、间隔5个百分点的14个raw策略；外部及付费调用0。

| 价格/分组 | 可选格 | 原算法高于网格最低 | 固定60高于网格最低 | 网格最低相对固定60省 | 边缘最优格 |
| --- | ---: | ---: | ---: | ---: | ---: |
| deepseek-flash-peak/main | 4/4 | 3.84% | 3.01% | 2.82% | 0 |
| deepseek-flash-peak/short | 2/2 | 0.00% | 0.00% | 0.00% | 0 |
| deepseek-flash-peak/prewarm | 1/1 | 3.04% | 11.20% | 10.07% | 0 |
| deepseek-flash-peak/failure | 1/1 | 17.73% | 8.30% | 7.66% | 0 |
| claude-sonnet-5.5-5m-price/main | 4/4 | 5.53% | 22.32% | 17.18% | 0 |
| claude-sonnet-5.5-5m-price/short | 2/2 | 24.97% | 0.00% | 0.00% | 0 |
| claude-sonnet-5.5-5m-price/prewarm | 1/1 | 9.75% | 51.78% | 34.12% | 0 |
| claude-sonnet-5.5-5m-price/failure | 1/1 | 6.72% | 35.59% | 26.25% | 0 |
| claude-opus-5.5-5m-price/main | 4/4 | 6.34% | 9.78% | 8.52% | 0 |
| claude-opus-5.5-5m-price/short | 2/2 | 26.71% | 0.00% | 0.00% | 0 |
| claude-opus-5.5-5m-price/prewarm | 1/1 | 4.80% | 26.45% | 20.92% | 0 |
| claude-opus-5.5-5m-price/failure | 1/1 | 5.02% | 18.74% | 15.78% | 0 |

每格先计算比例，再组内等权平均。不同分母不能互换：高于最低费用比例不等于相对原账单的可节省比例。

| 价格/分组/fixture | 长度 | 固定60费用 | 原算法费用 | 网格最低费用 | 事后阈值 | 边缘 | 另一长度所选阈值在本格费用 |
| --- | ---: | ---: | ---: | ---: | ---: | --- | ---: |
| deepseek-flash-peak/main/heldout-floor-180-22000-20000 | 120 | 1.850387 | 1.813250 | 1.818357 | 25% | false | 1.822381 |
| deepseek-flash-peak/main/heldout-floor-180-22000-20000 | 240 | 3.883234 | 4.000946 | 3.570148 | 20% | false | 3.629871 |
| deepseek-flash-peak/short/heldout-floor-180-22000-20000 | 4 | 0.029054 | 0.029054 | 0.029054 | 10% | false | — |
| deepseek-flash-peak/prewarm/heldout-floor-180-22000-20000 | 240 | 2.639044 | 2.445449 | 2.373271 | 20% | false | — |
| deepseek-flash-peak/failure/heldout-floor-180-22000-20000 | 240 | 4.085523 | 4.441561 | 3.772572 | 20% | false | — |
| deepseek-flash-peak/main/heldout-floor-180-41000-50000 | 120 | 3.278180 | 3.332225 | 3.266331 | 45% | false | 3.266331 |
| deepseek-flash-peak/main/heldout-floor-180-41000-50000 | 240 | 6.736232 | 6.764459 | 6.659519 | 45% | false | 6.659519 |
| deepseek-flash-peak/short/heldout-floor-180-41000-50000 | 4 | 0.052538 | 0.052538 | 0.052538 | 20% | false | — |
| claude-sonnet-5.5-5m-price/main/heldout-floor-180-22000-20000 | 120 | 18.117500 | 15.009622 | 13.541337 | 15% | false | 13.541337 |
| claude-sonnet-5.5-5m-price/main/heldout-floor-180-22000-20000 | 240 | 37.617956 | 28.891400 | 27.179520 | 15% | false | 27.179520 |
| claude-sonnet-5.5-5m-price/short/heldout-floor-180-22000-20000 | 4 | 0.228861 | 0.286461 | 0.228861 | 10% | false | — |
| claude-sonnet-5.5-5m-price/prewarm/heldout-floor-180-22000-20000 | 240 | 30.090451 | 21.756986 | 19.824401 | 15% | false | — |
| claude-sonnet-5.5-5m-price/failure/heldout-floor-180-22000-20000 | 240 | 39.034993 | 30.723525 | 28.788660 | 10% | false | — |
| claude-sonnet-5.5-5m-price/main/heldout-floor-180-41000-50000 | 120 | 27.426191 | 26.184962 | 25.442684 | 35% | false | 25.918200 |
| claude-sonnet-5.5-5m-price/main/heldout-floor-180-41000-50000 | 240 | 56.109311 | 52.416569 | 51.349365 | 30% | false | 52.039631 |
| claude-sonnet-5.5-5m-price/short/heldout-floor-180-41000-50000 | 4 | 0.413161 | 0.515525 | 0.413161 | 20% | false | — |
| claude-opus-5.5-5m-price/main/heldout-floor-180-22000-20000 | 120 | 29.285226 | 27.590094 | 25.763840 | 15% | false | 26.059152 |
| claude-opus-5.5-5m-price/main/heldout-floor-180-22000-20000 | 240 | 61.156998 | 54.568970 | 51.099833 | 20% | false | 51.640067 |
| claude-opus-5.5-5m-price/short/heldout-floor-180-22000-20000 | 4 | 0.430626 | 0.547135 | 0.430626 | 10% | false | — |
| claude-opus-5.5-5m-price/prewarm/heldout-floor-180-22000-20000 | 240 | 45.143141 | 37.413975 | 35.700141 | 20% | false | — |
| claude-opus-5.5-5m-price/failure/heldout-floor-180-22000-20000 | 240 | 63.912195 | 56.527406 | 53.823979 | 20% | false | — |
| claude-opus-5.5-5m-price/main/heldout-floor-180-41000-50000 | 120 | 48.352452 | 49.192125 | 47.161917 | 45% | false | 47.161917 |
| claude-opus-5.5-5m-price/main/heldout-floor-180-41000-50000 | 240 | 99.164284 | 102.910536 | 96.030200 | 45% | false | 96.030200 |
| claude-opus-5.5-5m-price/short/heldout-floor-180-41000-50000 | 4 | 0.776426 | 0.981154 | 0.776426 | 20% | false | — |

## 解释边界

- 最低费用只是这14个已执行策略中的事后最小值，不是全局最优、最优费用下界或在线可获得的收益保证；边缘最优说明网格截断可能重要，但本轮不追着结果扩大网格。
- 阈值策略运行中只看当前利用率。评测器在全部执行结束后才选择最佳值，选择结果不进入原算法，也不以模型名/fixture特判部署。
- raw策略与原固定60控制一致，没有冷却、最小回收或安全余量规则。窗口内只代表输入没越界，不代表任务质量、输出余量或完整宿主安全条件合格；不能直接推广最便宜阈值。
- 普通请求输入输出、成功/失败摘要、缓存重建及显式预热都计费；JSON保留每个阈值的费用分解、计数和压缩序列指纹，不仅存胜出者。无效运行保留原因且不得胜出。
- 旧算法和固定60完整账单重新执行并逐项复现；压缩序列只为节省报告体积转成哈希，序列本身仍可由相同命令重建。
- 跨长度诊断用同价格/fixture另一长度选出的阈值，读取本格对应已执行账单；两长度同seed且共享前缀，不是独立留出，更不是新泛化成绩。
- 只覆盖已见暖缓存合成流，价格是冻结仿真参数，不是当前供应商报价；不证明真实模型质量，没有默认/SDK/Pi改动，也不启动付费试验。
