# Pi 仓库修复探针：缓存计费回归

日期：2026-09-25。此任务用于检查更接近项目开发的代码工作能否自然产生有意义的
压缩时机比较。它是**人工注入回归**，不是自然发生的生产缺陷；不因任务代码量较大
就预设会发生压缩。

每次运行从同一个 Git HEAD 读取 FoldPoint 的所有已跟踪文件，复制到全新目录，
并仅在 `src/pricing.ts` 注入两个错误：过期缓存按普通输入价而非写入价计费；
缓存存活时漏计输出 token。`node_modules` 从本地、lockfile 匹配的安装复制，
不是指向原仓库的链接，也不在每组之间共享可写目录。需要先在 FoldPoint 原仓库
执行 `npm ci`。任务不使用大型无关文本填充上下文。

Agent 被要求只修改 `src/pricing.ts`。结束后，运行器检查其他所有已跟踪文件的
SHA-256 没有变化，并在不继承 provider key 的子进程中执行 typecheck、全量测试、
build 和工作区外的 [独立 oracle](fixtures/pi-pricing/oracle.test.mjs)。oracle 覆盖
过期缓存、存活缓存和概率混合三种计费。离线自检确认：坏版本不通过；恢复原实现
则通过所有门；改测试文件会被拒绝。

复跑示例（需要已有的 Pi 实验配置和 provider 环境变量）：

```text
npx tsx tools/pi-paired-run.ts --tasks pricing-regression --reps 1 --cache-warming off --out <new-prefix>
```

实验结果待填。即便四组都通过质量门，若双方零压缩，费用差仍从策略比较中排除；
若发生压缩，至少还需多轮重复和调用路径检查，不能由一轮费用差宣称优势。
