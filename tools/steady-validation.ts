/** Prospective synthetic combinations; frozen policies, no live calls or hindsight choices. */
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRawFixedThresholdStrategy } from "../benchmarks/fixed-threshold";
import type { Scenario } from "../benchmarks/scenarios";
import { affineCostCases, assertAffineCostSources, costLedger } from "./affine-cost";
import { sourceHash } from "./affine-holdout";
import { captureBudgetBranch } from "./qualification-fallback";
import { captureSteadyBranch, type runSteadyPolicy } from "./steady-policy";
import { compactLedger } from "./threshold-reference";

const read = (p: string) => readFileSync(p, "utf8");
export const VALIDATION_PLAN = JSON.parse(read("benchmarks/steady-validation-plan.json")) as {
  seeds: number[];
  mainLengths: number[];
  shortLength: number;
  sensitivityLength: number;
  families: {
    id: string;
    growth: number;
    jitter: number;
    retention: number;
    afterFloor: number;
    outputRatio: number;
    outputFloor: number;
  }[];
  profiles: string[];
  failureSuccessRate: number;
  prewarm: { summarySharedPrefixRatio: number; prewarmOutputTokens: number };
};
export function validationCases() {
  const result: {
    profile: string;
    family: string;
    suite: string;
    seed: number;
    scenario: Scenario;
  }[] = [];
  for (const profile of VALIDATION_PLAN.profiles) {
    const original = affineCostCases().find((c) => c.profile === profile);
    if (!original) throw new Error("Frozen profile unavailable");
    for (const f of VALIDATION_PLAN.families) {
      const add = (suite: string, seed: number, steps: number) => {
        result.push({
          profile,
          family: f.id,
          suite,
          seed,
          scenario: {
            ...original.scenario,
            id: `steady-validation-${result.length}`,
            seed,
            steps,
            hostHorizon: undefined,
            growthPerStep: f.growth,
            growthJitter: f.jitter,
            cycleBilling: suite === "prewarm" ? { ...VALIDATION_PLAN.prewarm } : {},
            compactor: {
              retentionRatio: f.retention,
              retainedFloorTokens: f.afterFloor,
              outputRatio: f.outputRatio,
              outputFloorTokens: f.outputFloor,
              successRate: suite === "failure" ? VALIDATION_PLAN.failureSuccessRate : 1,
            },
          },
        });
      };
      for (const seed of VALIDATION_PLAN.seeds)
        for (const steps of VALIDATION_PLAN.mainLengths) add("main", seed, steps);
      const first = VALIDATION_PLAN.seeds[0];
      if (first === undefined) throw new Error("Missing seed");
      add("short", first, VALIDATION_PLAN.shortLength);
      add("failure", first, VALIDATION_PLAN.sensitivityLength);
      add("prewarm", first, VALIDATION_PLAN.sensitivityLength);
    }
  }
  return result;
}
type SafeRun = {
  status: "ok" | "invalid";
  errorCode: null | "UNACCOUNTED_BILL_OR_RECOVERY" | "INPUT_EXCEEDS_WINDOW" | "OVERFLOW";
  bill: ReturnType<typeof compactLedger> | null;
};
export function safeValidationRun(run: () => ReturnType<typeof costLedger>): SafeRun {
  try {
    const b = run(),
      errorCode = !b.inputWithinWindow ? "INPUT_EXCEEDS_WINDOW" : b.overflow ? "OVERFLOW" : null;
    return { status: errorCode ? "invalid" : "ok", errorCode, bill: compactLedger(b) };
  } catch (error) {
    if (
      !(error instanceof Error) ||
      error.message !== "Full bill does not reconcile or overflow recovery is unaccounted"
    )
      throw error;
    return { status: "invalid", errorCode: "UNACCOUNTED_BILL_OR_RECOVERY", bill: null };
  }
}
export function evaluateFreshSteady(c: ReturnType<typeof validationCases>[number]) {
  if (c.scenario.hostHorizon !== undefined) throw new Error("Endpoint not allowed");
  const arms = {
    fixed60: safeValidationRun(() => costLedger(c.scenario, createRawFixedThresholdStrategy(0.6))),
    incumbent: safeValidationRun(() => captureBudgetBranch(c.scenario, false).bill),
    steadyRatio: safeValidationRun(() => captureSteadyBranch(c.scenario, false).bill),
    steadyOutput: safeValidationRun(() => captureSteadyBranch(c.scenario, true).bill),
  };
  const fingerprints = Object.values(arms).flatMap((a) => (a.bill ? [a.bill.fingerprint] : []));
  if (new Set(fingerprints).size > 1) throw new Error("Growth mismatch across frozen arms");
  return {
    profile: c.profile,
    family: c.family,
    suite: c.suite,
    seed: c.seed,
    steps: c.scenario.steps,
    truth: {
      growth: c.scenario.growthPerStep,
      jitter: c.scenario.growthJitter,
      compactor: { ...c.scenario.compactor },
    },
    arms,
  };
}
type FreshRow = ReturnType<typeof evaluateFreshSteady>;
export function summarizeFreshSteady(rows: FreshRow[]) {
  return [...new Set(rows.map((r) => `${r.profile}/${r.suite}`))].map((key) => {
    const cells = rows.filter((r) => `${r.profile}/${r.suite}` === key);
    const comparison = (
      a: "steadyRatio" | "steadyOutput",
      b: "fixed60" | "incumbent" | "steadyRatio",
    ) => {
      const valid = cells.filter((r) => r.arms[a].status === "ok" && r.arms[b].status === "ok");
      const deltas = valid.map((r) => {
        const x = r.arms[a].bill,
          y = r.arms[b].bill;
        if (!x || !y || y.cost <= 0) throw new Error("Invalid denominator");
        return x.cost / y.cost - 1;
      });
      // Invalid cells remain in denominator accounting; no partial-group mean is advertised.
      return {
        comparable: valid.length,
        total: cells.length,
        mean:
          valid.length === cells.length ? deltas.reduce((s, n) => s + n, 0) / cells.length : null,
        wins: deltas.filter((n) => n < -1e-9).length,
        losses: deltas.filter((n) => n > 1e-9).length,
        ties: deltas.filter((n) => Math.abs(n) <= 1e-9).length,
        worst: deltas.length ? Math.max(...deltas) : null,
        best: deltas.length ? Math.min(...deltas) : null,
      };
    };
    return {
      key,
      cases: cells.length,
      ratioVsIncumbent: comparison("steadyRatio", "incumbent"),
      outputVsIncumbent: comparison("steadyOutput", "incumbent"),
      outputVsFixed60: comparison("steadyOutput", "fixed60"),
      outputVsRatio: comparison("steadyOutput", "steadyRatio"),
    };
  });
}
export function freshPilotGate(rows: FreshRow[], groups: ReturnType<typeof summarizeFreshSteady>) {
  const validBills = rows.every((r) => Object.values(r.arms).every((a) => a.status === "ok"));
  const perProfile = VALIDATION_PLAN.profiles.map((profile) => {
    const g = groups.find((g) => g.key === `${profile}/main`);
    const mainAvailable = !!g && g.cases === 8;
    const meanVsFixed60 =
      mainAvailable && g.outputVsFixed60.mean !== null && g.outputVsFixed60.mean < 0;
    const meanVsIncumbent =
      mainAvailable && g.outputVsIncumbent.mean !== null && g.outputVsIncumbent.mean < 0;
    const majorityVsFixed60 = mainAvailable && g.outputVsFixed60.wins > g.outputVsFixed60.losses;
    return {
      profile,
      mainAvailable,
      meanVsFixed60,
      meanVsIncumbent,
      majorityVsFixed60,
      passed: mainAvailable && meanVsFixed60 && meanVsIncumbent && majorityVsFixed60,
    };
  });
  return {
    validBills,
    perProfile,
    passed: validBills && perProfile.every((p) => p.passed),
    defaultPromotion: false,
  };
}

function assertFrozenCandidate() {
  assertAffineCostSources();
  const text = read("benchmarks/reports/steady-policy.json");
  if (sourceHash(text) !== "87b90c1d544459d7b85da5a7c14e8cc48ec56c0e8d15b39ddb03f1c2692f8abb")
    throw new Error("Frozen steady report changed");
  const hashes: Record<string, string> = {};
  for (const report of [
    "benchmarks/reports/steady-policy.json",
    "benchmarks/reports/summary-output-cost.json",
    "benchmarks/reports/qualification-fallback.json",
  ]) {
    const frozen = JSON.parse(read(report)) as { sourceHashes: Record<string, string> };
    for (const [p, h] of Object.entries(frozen.sourceHashes)) {
      if (sourceHash(read(p)) !== h || (hashes[p] !== undefined && hashes[p] !== h))
        throw new Error("Frozen candidate dependency changed");
      hashes[p] = h;
    }
  }
  return { frozen: JSON.parse(text) as ReturnType<typeof runSteadyPolicy>, hashes };
}
function replayCanary(frozen: ReturnType<typeof runSteadyPolicy>) {
  const c = affineCostCases().find(
    (c) => c.profile === "deepseek-flash-peak" && c.suite === "main" && c.scenario.steps === 240,
  );
  if (!c) throw new Error("Missing preregistered canary");
  const old = frozen.rows.find(
    (r) =>
      r.profile === c.profile && r.suite === c.suite && r.fixture === c.fixture && r.steps === 240,
  );
  if (!old) throw new Error("Missing canary bill");
  const arms = {
    fixed60: compactLedger(costLedger(c.scenario, createRawFixedThresholdStrategy(0.6))),
    incumbent: compactLedger(captureBudgetBranch(c.scenario, false).bill),
    steadyRatio: compactLedger(captureSteadyBranch(c.scenario, false).bill),
    steadyOutput: compactLedger(captureSteadyBranch(c.scenario, true).bill),
  };
  if (JSON.stringify(arms) !== JSON.stringify(old.arms)) throw new Error("Canary ledger changed");
  return { profile: c.profile, fixture: c.fixture, steps: 240, matched: true, arms };
}
export function runFreshSteadyValidation(onProgress?: (message: string) => void) {
  const plan = read("benchmarks/steady-validation-plan.json");
  if (sourceHash(plan) !== "ce3d4fea6354997e95164db4d73107a9e0b12dff7cc35cabead83eb1c40aacef")
    throw new Error("Frozen validation plan changed");
  const { frozen, hashes } = assertFrozenCandidate();
  const canary = replayCanary(frozen);
  onProgress?.("frozen canary matched");
  const rows = validationCases().map((c) => {
    const row = evaluateFreshSteady(c);
    onProgress?.(`${c.profile}/${c.family}/${c.suite}/${c.seed}/${c.scenario.steps} complete`);
    return row;
  });
  const groups = summarizeFreshSteady(rows);
  return {
    runner: "foldpoint.steady-validation.v1",
    planCommit: "f14e82d",
    candidateCommit: "86bde86",
    paidCalls: 0,
    planHash: sourceHash(plan),
    sourceHash: sourceHash(read("tools/steady-validation.ts")),
    candidateHashes: hashes,
    canary,
    rows,
    groups,
    gate: freshPilotGate(rows, groups),
  };
}
export function renderFreshSteadyValidation(r: ReturnType<typeof runFreshSteadyValidation>) {
  const pct = (n: number | null) => (n === null ? "不可比" : `${(n * 100).toFixed(2)}%`);
  return [
    "# 冻结稳定周期候选：新组合验证",
    "",
    "计划f14e82d先冻结，候选固定86bde86，未修改参数或按价格选算法。42格：24主测试、各6格短任务/失败/预热；付费调用0。",
    "",
    `旧240步Flash canary四臂完整账单及压缩序列指纹复现：${r.canary.matched}；付费试点前置门：${r.gate.passed}；默认推广：false。`,
    "",
    "| 价格/分组 | 格数 | 旧输出周期相对原算法 | 拟合输出周期相对原算法 | 拟合输出周期相对固定60 | 对60胜/负/平 | 对60最差 |",
    "| --- | ---: | ---: | ---: | ---: | --- | ---: |",
    ...r.groups.map(
      (g) =>
        `| ${g.key} | ${g.cases} | ${pct(g.ratioVsIncumbent.mean)} | ${pct(g.outputVsIncumbent.mean)} | ${pct(g.outputVsFixed60.mean)} | ${g.outputVsFixed60.wins}/${g.outputVsFixed60.losses}/${g.outputVsFixed60.ties} | ${pct(g.outputVsFixed60.worst)} |`,
    ),
    "",
    "| 价格/特性/分组 | seed / 步数 | 固定60 | 原算法 | 周期旧输出 | 周期拟合输出 | 拟合输出摘要/失败/预热 |",
    "| --- | --- | ---: | ---: | ---: | ---: | --- |",
    ...r.rows.map((v) => {
      const fee = (key: keyof typeof v.arms) => v.arms[key].bill?.cost.toFixed(6) ?? "无有效账单";
      const b = v.arms.steadyOutput.bill;
      return `| ${v.profile}/${v.family}/${v.suite} | ${v.seed} / ${v.steps} | ${fee("fixed60")} | ${fee("incumbent")} | ${fee("steadyRatio")} | ${fee("steadyOutput")} | ${b ? `${b.summaryCalls}/${b.failed}/${b.prewarmCalls}` : "—"} |`;
    }),
    "",
    "## 解释边界",
    "",
    "- 主候选预先固定为steadyOutput；steadyRatio只作分离输出模型影响的对照，不因某档价格成绩更好而切换算法。",
    "- 主测试每档价格8格。前置门要求所有账单有效且无越界/溢出，并逐档满足相对固定60和原算法均值都更低、对60胜多于负。短任务/失败/预热不混入主均值，最差格仍披露；通过也不代表可以默认推广或直接发布。",
    "- 有无效账单的组不公布删样本后的部分均值；报告保留错误原因和可比数，未预期程序错误仍抛出。",
    "- 新增长/保留量组合及增长、失败种子在执行前冻结；仍使用同一个模拟器、压缩器公式和既有104729测量误差配方，两种子不构成统计优势证明，也不是真实任务质量验证。",
    "- 各臂独立学习，仅通过原有请求/摘要观测读取信息，不提供剩余任务长度、真实保留率或事后最佳阈值。共享前缀不是独立样本；不把新组合宣传为独立真实世界测试。",
    "- 完整费用包括普通输出、失败摘要、重建和独立预热；压缩次数只是诊断，不代替费用目标。价格是冻结仿真参数，不是实时供应商报价。",
    "- 没有SDK/Pi默认变化、付费调用或额外冷缓存网格。默认命令只表示完成运行；--require-pilot-ready会在前置门未通过时exit 1，报告仍完整写出。",
    "",
  ].join("\n");
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length > 1 || (args.length === 1 && args[0] !== "--require-pilot-ready"))
    throw new Error("usage: tsx tools/steady-validation.ts [--require-pilot-ready]");
  const r = runFreshSteadyValidation(console.log);
  writeFileSync("benchmarks/reports/steady-validation.json", `${JSON.stringify(r, null, 2)}\n`);
  writeFileSync("benchmarks/steady-validation.md", renderFreshSteadyValidation(r));
  console.log(JSON.stringify({ groups: r.groups, gate: r.gate }, null, 2));
  if (args.length && !r.gate.passed) process.exitCode = 1;
}
