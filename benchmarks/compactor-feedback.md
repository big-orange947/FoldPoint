# 受控压缩反馈闭环：离线验证

状态：通过；17/17 项检查；付费调用 0。

默认 EMA：100k 上下文冷启动预测 10000；收到实际 24000 的一次反馈后预测 13500。它向观测移动，并非一次学成真实函数。
默认摘要费用预测 0.480000 → 0.392250，实际 0.129000；压缩后的增长观测为 5000，不把压缩下降当作负增长。

实验模型训练只使用先前 100k/200k/300k 的观测。250k 留出输入先预测、后揭示结果：
压缩后上下文 30000 / 实际 30000；摘要输出 2750 / 实际 2750。
摘要预测费用 0.288750 / 实际 0.288750（假设美元价格）。

独立手算账单：4 次成功摘要 + 1 次失败尝试合计 1.248750；一次预热 0.112515；一次含 5k 新增长的普通请求 0.034500；总计 1.395765。失败不训练成功模型，费用仍计入。

一致低跨度反馈：retained；观测漂移：unavailable/feedback-drift；足够新反馈后：fitted。

## 检查

- coldModelUnavailable: PASS
- noTrainingLookahead: PASS
- coreFeedbackMovesTowardObservation: PASS
- coreCostMovesTowardObservation: PASS
- heldoutContextCorrect: PASS
- heldoutOutputCorrect: PASS
- heldoutSummaryCostCorrect: PASS
- rejectedFeedbackDoesNotTrain: PASS
- failedCoreRetentionUnchanged: PASS
- completeBill: PASS
- summaryBill: PASS
- prewarmBill: PASS
- ordinaryBill: PASS
- growthDoesNotIncludeCompactionDrop: PASS
- lowSpanRetains: PASS
- driftInvalidates: PASS
- freshFeedbackRecovers: PASS

## 限制

- 公开确定性仿真，只验证接线、学习响应和账单，不证明真实任务质量或省钱。
- 尺寸留出仍来自同一个已知 affine fixture，不是独立真实数据集或模型泛化证据。
- host-measured 由受控宿主保证同口径且无中途增长；仅有标签不能证明真实宿主满足条件。
- 默认 EMA 与实验 affine 学习器分别验证；未把实验模型接管默认核心或 Pi。
- 低跨度/漂移阶段是独立反馈压力测试，不计入前面的五次摘要账单。
- 价格为假设计费 fixture，不是任何供应商当前报价；未读取 API key 或请求正文。
