# 多次摘要的信息保留小测

目的不是证明小窗口省钱，而是先发现反复摘要有没有丢任务状态。工具调用本地 Pi 的
`generateSummaryWithUsage`：第一次使用原生初始摘要提示，之后使用原生更新摘要提示。
不修改 Pi。摘要策略不由 FoldPoint 接管。

## 固定协议

60 段公开合成任务日志包含分支约束、部署窗口更正、构建更换、测试结果、审批状态、
尚未完成的备份验证和回滚要求。第 20/40/60 段用同一问题检查 8 个字段。
问题声明格式和所有可能状态，不给正确答案。答案只由离线评分器持有。
检查问答不写回任务日志，避免它替后续摘要重复强化答案。

三组是完整历史参考、fixed60 摘要链和实验策略摘要链。后两组的摘要步骤预先从同一个
1M 仿真案例固定，分别摘要 3/7 次，不依据评分改动步骤。共 10 次摘要、9 次检查，
计划 19 次模型调用。这里是摘要暴露对照，不是在小输入上实时执行两套触发算法。

当前 v2 协议统一使用 Pi 已有对照的 16,384 reserve / 13,107 summary maxTokens。
检查输出上限 512。所有组同模型、同输入日志、同问题。完整压缩的 cut point、recent tail、
文件操作后处理、agent 任务执行没有被测试；它只是信息保留筛查。

## 运行

建议用直接 node 命令，避免部分 Windows/npm 环境吃掉选项。未知参数会在联网前拒绝。

```powershell
cd D:\project\FoldPoint
# 零付费；不读取 API key，网络被禁止，假的输出不评分
node node_modules/tsx/dist/cli.mjs tools/pi-summary-quality.mjs --pi D:/pi

# 已有环境变量 DEEPSEEK_API_KEY 时才运行；输出目录必须不存在
node node_modules/tsx/dist/cli.mjs tools/pi-summary-quality.mjs --live --pi D:/pi --out traces/summary-quality-native-03
```

可用 `--arms fixed60` 单独诊断，不能把单组结果当作完整三组对照。每轮 HTTP 最多 24 次，
逻辑请求和 HTTP 请求体各累计最多 500,000 UTF-8 字节预算（按字节作为保守输入 token
代理，非 tokenizer/账单保证）；每个逻辑调用 120 秒超时。HTTP 重试仍计请求次数与字节。
预算不足会停止，不能调大预算后覆盖原报告。

预算估算来自本地 Pi 价格表，不是实时服务商报价。当前 v2 按每个允许请求都用满摘要
输出预算做保守估算约 USD 0.68，实际检查输出更小；真实费用仍以服务商账单为准。
脚本记录 provider token usage 和 Pi catalog cost，后者也不是独立账单验证。

## 失败也要计费

流的 `result()` 返回时先登记 usage，再让 Pi 判断摘要是否完整。因此输出达上限而被 Pi
拒绝的摘要也进入 `usageLedger`，不会因为调用失败而被算作零费用。无法取得用量的 HTTP
尝试单列 `unaccountedHttpAttempts`。错误响应的空/零用量也视为未知，不伪装成已核算的
零费用。报告不会写原始异常、摘要、回答正文或 API key。
请求体/任务日志是本工具自己的公开合成内容；默认 Pi 插件的隐私范围没有改变。

`completedPlannedRun` 标识是否完成当前选择的组；`comparableThreeArmRun` 要求 live、
三组齐全、全程完成且完整历史参考能正确回答。它仍不代表任务质量非劣或多数真实任务有效。

## 已完成的 2048-token 先导及撤回边界

初始 v1 错误地给小测设置了 2048 摘要输出上限，低于此前 Pi 对照中的 13,107。保留产物：

- `traces/summary-quality-01/report.json`：8 次 HTTP；完整历史三个检查各 8/8，fixed60
  前两个检查各 8/8，第 8 个请求失败，实验组未开始。旧工具遗漏了失败请求的具体原因及
  usage，明确留有 1 次未核算尝试，不能当完整质量结果。
- `traces/summary-quality-fixed-diagnostic-02/report.json`：另 5 次 HTTP，固定链前两次
  检查各 8/8；第三次摘要 stopReason=length、output-token-cap，失败 usage 已计入。

两轮共 13 次 HTTP。已知用量分别 66,217 / 32,226 tokens；第一轮仍有一个失败请求的用量
未知，不给虚假的完整总额。按各报告已知用量的本地 catalog cost 合计约 USD 0.02517，
不是最终账单。停止付费后才将协议更正为 v2；本轮没有进行 v2 付费测试。

不能将这个人为过小上限造成的失败归因于 FoldPoint、Pi 原生压缩或信息遗忘；也不能因
前两个检查通过就宣称连续 7 次摘要安全。不同输出预算的结果不混合评分。不删失败案例，
不缩减日志、不追加保存答案的特化摘要指令、不修改触发算法以提高通过率。
