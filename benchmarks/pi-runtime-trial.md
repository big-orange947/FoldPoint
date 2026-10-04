# Pi 短、中任务对照：低成本诊断

这一轮先验证真实调用链和成本口径，再判断是否值得扩大付费样本。它不是 1M
测试的替代品，也不预设 FoldPoint 应该获胜。核心算法不为这些任务增加特判。

## 三组设置

显式使用 `--runtime-window 64000`。这是缩小后的**声明窗口**，不是服务商真实窗口。

| 组 | Pi reserve | 检查/压缩位置 | FoldPoint 行为 |
| --- | --- | --- | --- |
| default | 16384 | Pi 原生时机，约 74.4% | observe，主动压缩关闭 |
| fixed60 | 25600 | 固定 60% | observe，主动压缩关闭 |
| dynamic | 48000 | 25% 起由 Pi 频繁询问 | act 放行/否决；auto 在新 runtime 启动前重新评估 |

dynamic 的 25% 是**原生检查的起点**，不是 FoldPoint 的经济压缩下限。算法仍可 KEEP；
70% 安全边界和增长余量保持默认。不注入任务还剩几次调用的 oracle，也不预测用户还会发几轮消息。

三组使用同一模型、temperature=0、keepRecentTokens=4000、model.maxTokens=8192。
Pi 的摘要预算是 `min(floor(0.8 × reserve), model.maxTokens)`，所以三组均为 8192。
普通回答也受该输出上限约束。这是公平的受控实验，不是完全未修改配置的 stock Pi 对照。
缓存预热首先统一关闭；需要测试时再将三组统一切到同一种模式。

每次运行创建新的配置、任务目录和 prefix store，不改变用户原配置；但这**不能保证**
服务端缓存绝不跨组共享。报告必须保留实际缓存读写用量，不能称为严格独立冷缓存实验。

## 分阶段执行

1. `--plan-only`：不启动 Pi、不读取凭证、不请求 provider。核对组数和参数。
2. 三组各跑一次 `sum`：只检查接线、计费和完成情况。若没有压缩，不能据此宣称省钱。
3. 接线成功后跑 `ledger` 和 `steps`：修复小模块与分步文件读取，各有程序可检查的结果。
   先各一次；只有报告完整且确实出现压缩，再补到每组三次。
4. 先报告每组成功率、所有运行的费用和缺失费用，再报告双方均成功、完整计费且有压缩的配对差值。
   不得把失败、摘要用量缺失或两边都没压缩的运行算成策略获胜。
5. 64K 结果有清晰信号之后，再考虑完整 1M 重测。既有 1M 历史结果保留，不与新算法直接混算。

`sum` / `ledger` / `steps` 是任务类型，不保证具体模型执行时分别落在多少次调用。
以实际调用数记录长度，不能为凑出“中任务”而要求模型额外循环。

## 命令

```powershell
# 零付费计划；PowerShell 中逗号分隔的参数要加引号。
npx tsx tools/pi-paired-run.ts --runtime-window 64000 --tasks 'sum,ledger,steps' --reps 1 --plan-only

# 当前源码的真实 Pi 事件循环 + 内存替身模型，网络被阻断。
npx tsx tools/pi-runtime-smoke.mjs D:/pi default
npx tsx tools/pi-runtime-smoke.mjs D:/pi fixed60
npx tsx tools/pi-runtime-smoke.mjs D:/pi dynamic

# 真实 provider：key 仅通过终端环境变量传入，不写到命令或文件中。
$env:PI_CLI = 'D:/pi/packages/coding-agent/dist/bundle/cli.js'
$env:PI_CODING_AGENT_DIR = 'D:/project/FoldPoint/traces/pi-million-base'
$env:PI_SCRATCH = 'D:/project/FoldPoint/traces'
npx tsx tools/pi-paired-run.ts --runtime-window 64000 --tasks sum --reps 1 --cache-warming off --price-scenario native --out traces/runtime-sum-NEW-ID
```

实验 base 必须已存在，并包含 `deepseek/deepseek-flash` 的 models.json；真实授权用环境变量。
输出前缀不可重复，命令拒绝覆盖已有结果。中任务把 tasks 改为 `'ledger,steps'`，换新输出前缀。

目前 runner 的 300 秒单任务超时**不是** API 金额或 token 硬限额。先跑单任务、单次重复，
检查实际消耗后再扩展；不要将默认的全任务多重复命令当作预算受控命令。

## 成本与质量边界

费用包括普通模型调用的输入/输出/缓存、所有有 usage 的摘要尝试、缓存预热。
摘要失败而没有 usage 时，费用只是下界，不进入省钱配对。费用依据 Pi 模型价格元数据估算，
不是服务商账单审计。

`--price-scenario` 的假设价格需要重新执行对应策略实验：不能把一次 DeepSeek 轨迹重新定价后，
就称为 Claude 上的真实策略效果。不同 provider 的缓存行为也不是改价格能模拟的。

程序 oracle 只能验证这些任务的输出，不代表通用任务质量不下降。首次一遍结果只能决定
是否扩大样本，不足以支持“大部分情况下更省钱”的发布声明。
