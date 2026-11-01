# Runtime 调用长度：数据质量检查

本轮没有付费调用。真实付费轨迹用于描述性核对，未用于训练或修改结束概率。

`runtime-evidence` 将同一session内的 `decision.callId` 与 `request.callId` 配对，
只按runtime聚合成功普通调用；摘要、预热不增加普通调用计数。
缺结束事件的运行标记右删失；失败、缺结果、未配对决策及冲突顺序标记不明确。
同名runtime/call在不同session不混用，输出只包含统计，不包含会话标识或消息。

旧付费动态轨迹的结果：140个出现过decision或runtime_end的运行；129个具有一条已配对成功
普通请求和结束事件，11个有结束事件但没有可配对的普通请求；另有11个无法归属的普通请求。
这11个请求分别出现在摘要后的下一阶段。适配器源码显示Pi在摘要后可能暂不提供上下文长度，
因此跳过该调用前的decision，仍记录后续用量。这是与位置一致的代码解释，旧轨迹本身无法补证每个请求归属。

另一个限制更重要：当前 `runtime_end` 只有结束事件，没有标明正常完成还是中止。
所以129不是129个已确认成功完成的任务，0次继续也不是可用于训练的“真实继续概率为零”。
报告强制 `usableForCalibration=false`，列出无结果结束事件及未配对请求；不能拿它去拟合0.98或混合先验。

## 针对未来数据的修订

Pi适配器在有活动runtime但上下文长度未知、无法产生decision的情况下，
会将当前runtimeId附在真实request元数据上。没有活动runtime时不附加；不发明决策，也不输出正文。
trace的 `request.runtimeId` 是可选增量字段；旧记录仍可解析，新记录可在无decision时归属运行。
分析器只在宿主明确提供该标识时统计孤立请求；冲突、重复、结束后事件或失败标记为不明确。

这不能修复旧文件，也不能解决runtime结束原因未知；因此本轮分析器依然禁止把输出作为校准数据。
本地真实Pi SDK加回环模拟服务的两次摘要测试中，6个runtime、6次普通请求全部归属：
其中2次没有decision但明确带runtimeId，未归属请求0。没有外部调用或真实任务质量测试。
这验证了本地SDK生命周期；完整独立RPC进程重启和远端provider场景尚未验证。
仍需确定如何可靠表达正常结束、中止和错误。
不得仅凭会话结束、超时或普通请求成功假设任务自然完成。

本地Pi SDK回环进一步观察到6次 `agent_before_settle(outcome=completed)`，各自后面都有
`agent_settled`；Pi源码说明最终settled发生在自动重试和排队续行结束后。
这些是成功路径的本地探针，不验证错误、取消、重试或旧版Pi；
观察工具只记录固定枚举，不记录事件中的消息正文。目前仍未写入生产trace或解除校准阻断。

本地SDK回环又覆盖了成功、HTTP错误、一次503后重试成功和主动中止四种情况：
成功与普通错误均为 `agent_end → agent_before_settle(outcome) → agent_settled`；
重试场景则有两次 `agent_start/agent_end`，中间有重试事件，最终才结算。
主动中止为 `agent_end → agent_settled`，没有 `agent_before_settle`。
因此缺少结算前状态不能按completed填充；尝试级 `agent_end` 也不能等同用户任务最终结束。
这只是本地Pi SDK和模拟网络，不代表所有Pi版本或所有失败方式；尚未修改生产trace。

新增独立研究观察器，以最终settled为活动边界，计数其中的agent尝试和assistant消息，
输出Pi报告的状态或unknown。回环中，重试成功被记录成2次尝试、最终completed；
主动中止因没有before-settle状态而记录unknown。completed只表示Pi活动状态，不代表任务正确。
assistant消息计数未证明能排除所有摘要或预热，因此不称为校准用普通调用数。
该观察器不写生产trace、不驱动策略，未解决多进程持久化和配置绑定，也不能用于训练概率。
现提供显式 `attachPiSettlementObserver` 供宿主注册，默认Pi适配器不会自动启用；
测试通过真实Pi SDK的注册路径。记录不含sessionId、runtimeId或模型标识，宿主若持久化
必须另行提供安全的兼容性绑定，不能跨模型或会话随意合并；回调只支持同步写入。

复跑须使用新目录：

```powershell
node --import tsx tools/pi-settlement-probe.mjs --pi D:/pi --out traces/pi-settlement-fresh
```

复跑旧数据（输出需为新路径）：

```powershell
node --import tsx tools/runtime-evidence.ts --trace traces/pi-ledger-floor-v2-20261023-full-01-dynamic.jsonl --out traces/runtime-evidence-fresh.json
```

测试覆盖删失、失败、未知归属、跨session同名、重复与矛盾标识；输出为描述性统计，不是预测准确率。
