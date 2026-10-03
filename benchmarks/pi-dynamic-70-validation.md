# 新动态策略的 1M 验证

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
