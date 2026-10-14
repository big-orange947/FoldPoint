# 重复摘要：小规模真实证据保留对照

Pi 配置模型：deepseek/deepseek-flash。Pi d201760ff；该 ID 是本地模型配置标识，不是独立核实的服务端版本号。
冻结矩阵只提供压缩曝光时间表，三个组均用同一个 DeepSeek 模型；不是 Claude 质量实测，也不是本轮运行动态时机算法。

| 组 | 真实摘要次数 | 检查点完全正确 | 字段正确 | 摘要调用输出首/末 tokens（provider用量） |
| --- | --- | --- | --- | --- |
| fullHistory | 0 | 3/3 | 36/36 | —/— |
| fixed60 | 3 | 3/3 | 36/36 | 628/973 |
| experimental | 11 | 3/3 | 36/36 | 427/5183 |

实际 HTTP 23 次，provider 报告 218155 tokens；未对账 HTTP 0。
目录价格折算约 US$0.087993，不是供应商账单，只覆盖摘要和探针调用；不能比较两种时机的完整 Agent 费用。
完整历史参考有效：true；候选相对 fixed60 的字段退化数：0。

通过这些检查只说明此公开日志上的关键事实/更正/前置条件被保留，不能证明普遍质量不降或真实任务完成率。输出 token 用量不等于压缩后上下文大小，本轮未独立测量摘要文本长度/保留率；摘要膨胀与后续复用成本仍需实测。未改动算法、默认核心或 Pi。

## 限制

- Frozen 90-step exposure prefix from a 120-call synthetic schedule, applied to a smaller public task log. NOT live adaptive timing, a new 1M trial or a provider-cost comparison.
- One predeclared source case, not the whole frequency matrix or a heldout quality dataset. No selection using retention scores.
- Only Pi initial/update summary prompts are exercised; normal agent reasoning/tool execution, native cut points and recent-tail preservation are not.
- Answer probes measure evidence retention and simple state prerequisites, not task completion. Dry-run fake responses are never scored as quality evidence.
