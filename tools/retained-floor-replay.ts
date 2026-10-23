/** Paired synthetic execution, NOT the frozen controller or a provider/quality experiment. */
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { CompactorTokenModel } from "../src/experimental-compactor";
import { stableCycleCandidates, summaryUsageBill } from "../src/experimental-cycle";
import { costOfCall, resolveUnitPrices, type UnitPrices } from "../src/pricing";
import { predictRetainedFloor, retainedFloorCycles } from "./retained-floor";

export interface ReplayWorld {
  steps: number;
  growth: number;
  readRatio: number;
  summaryShared: boolean;
  actualRetention: "overlap" | "additive";
}
export type ReplayPolicy = "legacy-affine" | "total-floor-v2" | "fixed60";
const retention = { totalRatio: 0.1, recentBudgetTokens: 20000 };

/** Exogenous additions include all message/output growth; policy never sees the future array. */
export function replayGrowth(world: ReplayWorld) {
  return Array.from({ length: world.steps }, (_, i) =>
    Math.round(world.growth * ([0.8, 1, 1.2, 0.9, 1.1][i % 5] ?? 1)),
  );
}

function boundary(policy: ReplayPolicy, prices: UnitPrices, growth: number, shared: boolean) {
  if (policy === "fixed60") return 600000;
  const model: CompactorTokenModel = {
    after: { slope: 0.1, intercept: 20000, residual: 0 },
    output: { slope: 0.002, intercept: 100, residual: 0 },
    samples: 0,
    minBefore: 0,
    maxBefore: 700000,
    summaryInputCostPerToken: prices.inputPerToken,
  };
  const billing = shared ? { summarySharedPrefixRatio: 1 } : {};
  const rows =
    policy === "legacy-affine"
      ? stableCycleCandidates(prices, model, growth, 700000, billing)
      : retainedFloorCycles(prices, model, retention, growth, 700000, billing);
  return (
    rows
      .filter((r) => r.before >= 500000)
      .reduce<(typeof rows)[number] | null>(
        (best, row) => (!best || row.costPerOrdinaryCall < best.costPerOrdinaryCall ? row : best),
        null,
      )?.before ?? 700000
  );
}

export function executeRetentionReplay(world: ReplayWorld, policy: ReplayPolicy) {
  if (
    !Number.isSafeInteger(world.steps) ||
    world.steps < 1 ||
    world.steps > 10000 ||
    !Number.isFinite(world.growth) ||
    world.growth <= 0 ||
    world.growth > 100000 ||
    !Number.isFinite(world.readRatio) ||
    world.readRatio <= 0 ||
    world.readRatio > 1 ||
    !["overlap", "additive"].includes(world.actualRetention)
  )
    throw new RangeError("invalid replay world");
  const prices = resolveUnitPrices({
    inputPerMillion: 0.3,
    outputPerMillion: 1.2,
    cacheReadPerMillion: 0.3 * world.readRatio,
    cacheWritePerMillion: 0.3,
  });
  const growthSequence = replayGrowth(world);
  let context = 100000,
    prefix = 100000,
    observedGrowth: number | undefined;
  let ordinaryCost = 0,
    summaryCost = 0,
    compactions = 0,
    forced = 0,
    maxPrompt = 0;
  const actions: Array<{ step: number; before: number; after: number; forced: boolean }> = [];
  for (let i = 0; i < world.steps; i++) {
    // No task length, future growth, actual-retention law or future success is passed to selector.
    const target =
      observedGrowth === undefined
        ? 700000
        : boundary(policy, prices, observedGrowth, world.summaryShared);
    const safety = context >= 700000;
    if (safety || context >= target) {
      const before = context;
      summaryCost += summaryUsageBill(
        prices,
        before,
        Math.ceil(before * 0.002 + 100),
        prefix,
        1,
        world.summaryShared ? { summarySharedPrefixRatio: 1 } : {},
      );
      context = Math.ceil(
        world.actualRetention === "overlap"
          ? predictRetainedFloor(retention, before)
          : Math.min(before, before * 0.1 + 20000),
      );
      prefix = 0; // Summary invalidates ordinary prefix; next request rebuild is billed.
      compactions++;
      if (safety) forced++;
      actions.push({ step: i, before, after: context, forced: safety });
    }
    maxPrompt = Math.max(maxPrompt, context);
    ordinaryCost += costOfCall(
      prices,
      context,
      {
        prefixTokens: prefix,
        aliveProbability: 1,
        cachingInPlay: prices.hasCacheDiscount,
      },
      300,
    );
    prefix = context;
    // After this successful call, the following growth becomes observable. Identical for all policies.
    const added = growthSequence[i];
    if (added === undefined) throw new Error("missing growth");
    context += added;
    observedGrowth = observedGrowth === undefined ? added : 0.8 * observedGrowth + 0.2 * added;
  }
  return {
    policy,
    ordinaryCalls: world.steps,
    compactions,
    forced,
    ordinaryCost,
    summaryCost,
    total: ordinaryCost + summaryCost,
    maxPrompt,
    actions,
    offeredGrowth: growthSequence.reduce((n, v) => n + v, 0),
  };
}

export function runRetentionReplay() {
  const cells: Array<{
    world: ReplayWorld;
    arms: ReturnType<typeof executeRetentionReplay>[];
  }> = [];
  for (const steps of [24, 80, 240, 800])
    for (const growth of [5000, 15000, 50000])
      for (const readRatio of [0.01, 0.1, 0.5])
        for (const summaryShared of [false, true])
          for (const actualRetention of ["overlap", "additive"] as const) {
            const world = { steps, growth, readRatio, summaryShared, actualRetention };
            cells.push({
              world,
              arms: ["legacy-affine", "total-floor-v2", "fixed60"].map((policy) =>
                executeRetentionReplay(world, policy as ReplayPolicy),
              ),
            });
          }
  const summarize = (subset: typeof cells, reference: ReplayPolicy) => {
    let wins = 0,
      ties = 0,
      losses = 0,
      candidateCost = 0,
      referenceCost = 0;
    for (const c of subset) {
      const candidate = c.arms.find((a) => a.policy === "total-floor-v2");
      const other = c.arms.find((a) => a.policy === reference);
      if (!candidate || !other) throw new Error("missing arm");
      const difference = candidate.total - other.total;
      if (Math.abs(difference) < 1e-10) ties++;
      else if (difference < 0) wins++;
      else losses++;
      candidateCost += candidate.total;
      referenceCost += other.total;
    }
    return {
      cells: subset.length,
      wins,
      ties,
      losses,
      candidateCost,
      referenceCost,
      relativeDifference: candidateCost / referenceCost - 1,
    };
  };
  return {
    runner: "foldpoint.retained-floor-replay.v1",
    paidCalls: 0,
    realTask: false,
    policyChanged: false,
    summary: {
      allVsLegacy: summarize(cells, "legacy-affine"),
      allVsFixed60: summarize(cells, "fixed60"),
      longVsLegacy: summarize(
        cells.filter((c) => c.world.steps >= 240),
        "legacy-affine",
      ),
      longVsFixed60: summarize(
        cells.filter((c) => c.world.steps >= 240),
        "fixed60",
      ),
    },
    cells,
    limitations: [
      "Synthetic execution of isolated timing selectors, not the frozen Pi risk-gated controller.",
      "Warm append-only cache; successful deterministic summaries only; no TTL, failure or quality model.",
      "Same exogenous growth and actual compactor law per paired world, not real agent task equivalence.",
      "Fixed 50-70% eligibility, 256-call forecast cap; no horizon or dataset label enters selector.",
      "Aggregate relative difference is a cost-weighted synthetic sum, not a production savings estimate.",
    ],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--out" || !args[1] || args[1].startsWith("--"))
    throw new Error("usage: --out <fresh JSON path>");
  if (existsSync(args[1])) throw new Error("Refusing to overwrite replay");
  const report = runRetentionReplay();
  writeFileSync(args[1], `${JSON.stringify(report, null, 2)}\n`, { flag: "wx" });
  process.stdout.write(`${JSON.stringify(report.summary, null, 2)}\n`);
}
