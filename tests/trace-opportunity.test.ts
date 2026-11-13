import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { costOfCall, resolveUnitPrices } from "../src/pricing";
import { type SimulationWorld, simulateTraceWorld } from "../tools/trace-driven-simulation";
import {
  diagnoseOpportunity,
  opportunityMarkdown,
  searchTimingReference,
  thresholds,
} from "../tools/trace-opportunity";

const world: SimulationWorld = {
  initialContext: 550000,
  initialPrompt: 540000,
  growth: [10000, 10000, 10000, 10000],
  prices: resolveUnitPrices({
    inputPerMillion: 0.3,
    outputPerMillion: 1.2,
    cacheReadPerMillion: 0.006,
  }),
  retentionRatio: 0.11,
  summaryInputRate: 0.0000003,
  summaryOutput: 1000,
  ordinaryOutput: 300,
};

// Independent exhaustive enumeration and pricing, not the shared transition under test.
function bruteForce(w: SimulationWorld) {
  let best = Infinity;
  for (let mask = 0; mask < 2 ** (w.growth.length + 1); mask++) {
    let context = w.initialContext,
      prefix = 0,
      cost = 0,
      valid = true;
    for (let step = 0; step <= w.growth.length; step++) {
      const compact = Boolean(mask & (1 << step));
      if (context > 700000 || (compact && context < 500000) || (!compact && context >= 700000)) {
        valid = false;
        break;
      }
      if (compact) {
        cost += context * w.summaryInputRate + w.summaryOutput * w.prices.outputPerToken;
        context = Math.round(context * w.retentionRatio);
        prefix = 0;
      }
      const prompt = Math.max(0, context - (w.initialContext - w.initialPrompt));
      cost += costOfCall(
        w.prices,
        prompt,
        {
          prefixTokens: prefix,
          aliveProbability: w.cacheAlive?.[step] === false ? 0 : 1,
          cachingInPlay: w.prices.hasCacheDiscount,
        },
        w.ordinaryOutput,
      );
      prefix = prompt;
      context += w.growth[step] ?? 0;
    }
    if (valid) best = Math.min(best, cost);
  }
  return best;
}

it("matches exhaustive paths on small warm and expired worlds with no beam pruning", () => {
  for (const w of [
    world,
    {
      ...world,
      growth: [100000, 100000, 100000, 100000, 100000],
      cacheAlive: [true, false, true, false, true, true],
    },
  ]) {
    const result = searchTimingReference(w);
    expect(result.discardedStates).toBe(0);
    expect(result.best?.totalCost).toBeCloseTo(bruteForce(w), 12);
  }
});

it("exposes pruning and keeps a feasible best-grid path even with beam width one", () => {
  const w = { ...world, growth: Array(80).fill(12000) };
  const r = diagnoseOpportunity(w, 1);
  expect(r.reference.discardedStates).toBeGreaterThan(0);
  expect(r.reference.globalOptimumProven).toBe(false);
  expect(r.reference.totalCost).toBeLessThanOrEqual(r.bestFixed.totalCost);
  expect(r.bestFixed.totalCost).toBeLessThanOrEqual(r.fixed60.totalCost);
});

it("keeps the 60% bill unchanged, rejects invalid thresholds and excludes overshoots", () => {
  const w = { ...world, growth: Array(70).fill(17000) };
  const r = diagnoseOpportunity(w);
  expect(thresholds).toHaveLength(21);
  expect(r.grid.find((x) => x.thresholdTokens === 600000)?.totalCost).toBe(
    simulateTraceWorld(w, "fixed60").totalCost,
  );
  expect(r.grid.some((x) => !x.eligible && x.overshoots > 0)).toBe(true);
  expect(r.bestFixed.eligible).toBe(true);
  expect(() => simulateTraceWorld(w, { thresholdTokens: 710000 })).toThrow();
  const short = simulateTraceWorld(
    { ...w, growth: w.growth.slice(0, 30) },
    { thresholdTokens: 650000 },
  );
  expect(
    simulateTraceWorld(w, { thresholdTokens: 650000 }).actions.filter((a) => a.step <= 30),
  ).toEqual(short.actions);
});

it("allows hindsight to skip a terminal summary, without presenting it as an online result", () => {
  const w = { ...world, initialContext: 600000, initialPrompt: 590000, growth: [1] };
  const r = diagnoseOpportunity(w);
  expect(r.fixed60.summaries).toBe(1);
  expect(r.reference.actions).toHaveLength(0);
  expect(r.reference.totalCost).toBeLessThan(r.fixed60.totalCost);
  expect(opportunityMarkdown({ rows: [] })).toContain("不能证明任务质量");
});

it("keeps the saved report bound to code and markdown and reconciles every bill", () => {
  const report = JSON.parse(readFileSync("benchmarks/reports/trace-opportunity.json", "utf8")) as {
    paidCalls: number;
    sources: Record<string, string>;
    rows: Array<
      ReturnType<typeof diagnoseOpportunity> & {
        workload: string;
        retentionRatio: number;
        endpointRole: string;
        provenance: string;
      }
    >;
  };
  expect(report.paidCalls).toBe(0);
  expect(report.rows).toHaveLength(54);
  for (const [key, path] of Object.entries({
    engine: "tools/trace-driven-simulation.ts",
    evaluator: "tools/trace-opportunity.ts",
    candidate: "tools/cold-start-candidate.ts",
    supported: "tools/learned-cycle-choice.ts",
  })) {
    expect(report.sources[key]).toBe(
      createHash("sha256").update(readFileSync(path, "utf8").replace(/\r\n/g, "\n")).digest("hex"),
    );
  }
  for (const row of report.rows) {
    expect(row.reference.totalCost).toBeCloseTo(
      row.reference.ordinaryCost + row.reference.summaryCost,
      12,
    );
    expect(row.reference.totalCost).toBeLessThanOrEqual(row.bestFixed.totalCost);
    expect(row.bestFixed.totalCost).toBe(
      Math.min(...row.grid.filter((r) => r.eligible).map((r) => r.totalCost)),
    );
    expect(row.grid.find((r) => r.thresholdTokens === 600000)?.totalCost).toBe(
      row.fixed60.totalCost,
    );
  }
  expect(readFileSync("benchmarks/trace-opportunity.md", "utf8").replace(/\r\n/g, "\n")).toBe(
    opportunityMarkdown(report),
  );
});
