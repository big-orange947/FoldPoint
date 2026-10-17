import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { createRawFixedThresholdStrategy } from "../benchmarks/fixed-threshold";
import {
  affineCostCases,
  assertAffineCostSources,
  buildAffineCostReport,
  costLedger,
  createApproximateCostStrategy,
  executeAffineCost,
  hostFeedback,
  renderAffineCost,
} from "../tools/affine-cost";
import { sourceHash } from "../tools/affine-holdout";

it("enumerates the frozen main, short and sensitivity cells without a horizon oracle", () => {
  const cases = affineCostCases();
  expect(cases).toHaveLength(24);
  expect(() => assertAffineCostSources()).not.toThrow();
  expect(sourceHash(readFileSync("benchmarks/affine-cost-plan.json", "utf8"))).toBe(
    "3d88e95d91ebc25ca71b740d265a2941f8d15fdda0621e06537fa46743bc75cd",
  );
  expect(cases.filter((c) => c.suite === "main")).toHaveLength(12);
  expect(cases.filter((c) => c.suite === "short")).toHaveLength(6);
  expect(cases.filter((c) => c.suite === "failure")).toHaveLength(3);
  expect(cases.filter((c) => c.suite === "prewarm")).toHaveLength(3);
  expect(cases.every((c) => c.scenario.hostHorizon === undefined && c.scenario.steps > 0)).toBe(
    true,
  );
});

it("produces the same approximate host measurement rule in both independent branches", () => {
  const e = {
    step: 0,
    timestamp: 1,
    beforeTokens: 600000,
    afterTokens: 65000,
    outputTokens: 2000,
    action: "FORCE" as const,
    cost: 0.2,
    breakEvenCalls: null,
    success: true,
  };
  const feedback = hostFeedback(e, 1);
  expect(feedback).toEqual(hostFeedback(e, 1));
  expect(feedback.afterTokens).not.toBe(e.afterTokens);
  expect(feedback.beforeErrorTokens).toBe(72000);
  const c = affineCostCases()[0];
  if (!c) throw new Error("missing case");
  const a = createApproximateCostStrategy(c.scenario, "approximateEma");
  const b = createApproximateCostStrategy(c.scenario, "uncertainAffine");
  a.strategy.onCompaction?.(e);
  b.strategy.onCompaction?.(e);
  expect(a.diagnostic().observations).toEqual(b.diagnostic().observations);
  expect(a.diagnostic().exactSamples).toBe(0);
  expect(b.diagnostic().exactSamples).toBe(0);
  a.strategy.onCompaction?.({ ...e, success: false });
  expect(b.diagnostic().observations).toHaveLength(1);
  expect(a.diagnostic().observations.at(-1)?.success).toBe(false);
});

it("keeps the first DeepSeek zero-compaction short negative control identical across all four arms", () => {
  const c = affineCostCases().find((c) => c.suite === "short");
  if (!c) throw new Error("missing short");
  const r = executeAffineCost(c);
  for (const arm of Object.values(r.arms)) {
    expect(arm.summaryCalls).toBe(0);
    expect(arm.totalCalls).toBe(4);
    expect(arm.cost).toBe(r.arms.fixed60.cost);
    expect(arm.fingerprint).toBe(r.arms.fixed60.fingerprint);
    expect(arm.ordinary + arm.summary + arm.prewarm).toBeCloseTo(arm.cost, 12);
  }
});

it("flags oversized summary inputs even when the simulator overflow metric stays zero", () => {
  const c = affineCostCases()[0];
  if (!c) throw new Error("missing case");
  const s = { ...c.scenario, steps: 1, startTokens: c.scenario.contextWindowTokens + 1 };
  const ledger = costLedger(s, createRawFixedThresholdStrategy(0.6));
  expect(ledger.overWindowSummaryCalls).toBe(1);
  expect(ledger.inputWithinWindow).toBe(false);
  expect(ledger.overflow).toBe(0);
});

it("matches a hand bill for summary output, prefix rebuild and a separate one-token prewarm", () => {
  const c = affineCostCases()[0];
  if (!c) throw new Error("missing case");
  const s = {
    ...c.scenario,
    steps: 1,
    startTokens: 100000,
    growthPerStep: 0,
    growthJitter: 0,
    outputTokens: 100,
    pricing: {
      currency: "USD",
      inputPerMillion: 2,
      outputPerMillion: 10,
      cacheReadPerMillion: 0.2,
      cacheWritePerMillion: 2.5,
    },
    cycleBilling: {},
    compactor: {
      retentionRatio: 0.1,
      retainedFloorTokens: 20000,
      outputRatio: 0.002,
      outputFloorTokens: 2000,
      successRate: 1,
    },
  };
  const plain = costLedger(s, createRawFixedThresholdStrategy(0.05));
  expect(plain.summary).toBeCloseTo(100000 * 2e-6 + 2000 * 10e-6, 12);
  expect(plain.ordinary).toBeCloseTo(20000 * 2.5e-6 + 100 * 10e-6, 12);
  expect(plain.cost).toBeCloseTo(0.271, 12);
  const warm = costLedger(
    { ...s, cycleBilling: { prewarmOutputTokens: 1 } },
    createRawFixedThresholdStrategy(0.05),
  );
  expect(warm.prewarm).toBeCloseTo(20000 * 2.5e-6 + 1 * 10e-6, 12);
  expect(warm.ordinary).toBeCloseTo(20000 * 0.2e-6 + 100 * 10e-6, 12);
  expect(warm.cost).toBeCloseTo(0.27501, 12);
  expect(warm.totalCalls).toBe(3);
});

it("counts failed attempts and independent prewarm calls rather than treating them as free", () => {
  const c = affineCostCases().find((c) => c.suite === "prewarm");
  if (!c) throw new Error("missing sensitivity");
  const s = {
    ...c.scenario,
    steps: 4,
    startTokens: 610000,
    compactor: { ...c.scenario.compactor, successRate: 1 },
  };
  const success = costLedger(s, createRawFixedThresholdStrategy(0.6));
  expect(success.summaryCalls).toBeGreaterThan(0);
  expect(success.prewarmCalls).toBe(success.summaryCalls);
  expect(success.prewarm).toBeGreaterThan(0);
  expect(success.totalCalls).toBe(
    success.ordinaryCalls + success.summaryCalls + success.prewarmCalls,
  );
  const failed = costLedger(
    { ...s, compactor: { ...s.compactor, successRate: 0 } },
    createRawFixedThresholdStrategy(0.6),
  );
  expect(failed.failed).toBe(4);
  expect(failed.summary).toBeGreaterThan(0);
  expect(failed.prewarmCalls).toBe(0);
  expect(failed.cost).toBeCloseTo(failed.ordinary + failed.summary, 12);
});

it("reconciles every saved branch and preserves complete case counts and report arithmetic", () => {
  const report = JSON.parse(
    readFileSync("benchmarks/reports/affine-cost.json", "utf8"),
  ) as ReturnType<typeof buildAffineCostReport>;
  expect(report.rows).toHaveLength(24);
  for (const short of report.rows.filter((r) => r.suite === "main" && r.steps === 120)) {
    const longer = report.rows.find(
      (r) =>
        r.suite === "main" &&
        r.steps === 240 &&
        r.profile === short.profile &&
        r.fixture === short.fixture,
    );
    if (!longer) throw new Error("missing common-prefix control");
    for (const arm of [
      "fixed60",
      "nativeThresholdProxy",
      "approximateEma",
      "uncertainAffine",
    ] as const)
      expect(longer.arms[arm].compactions.filter((c) => c.step < 120)).toEqual(
        short.arms[arm].compactions,
      );
  }
  for (const row of report.rows) {
    for (const arm of Object.values(row.arms)) {
      expect(arm.cost).toBeCloseTo(arm.ordinary + arm.summary + arm.prewarm, 10);
      expect(arm.summaryCalls).toBe(arm.compactions.length);
      expect(arm.failed).toBe(arm.compactions.filter((c) => !c.success).length);
      expect(arm.totalCalls).toBe(arm.ordinaryCalls + arm.summaryCalls + arm.prewarmCalls);
      expect(arm.fingerprint).toBe(row.arms.fixed60.fingerprint);
      expect(arm.inputWithinWindow).toBe(
        arm.overWindowSummaryCalls + arm.overWindowOrdinaryCalls + arm.overWindowPrewarmCalls === 0,
      );
    }
    expect(row.diagnostics.uncertainAffine.exactSamples).toBe(0);
  }
  const rebuilt = buildAffineCostReport(report.rows);
  expect(rebuilt.sourceHashes).toEqual(report.sourceHashes);
  expect(rebuilt.groups).toEqual(report.groups);
  for (const g of rebuilt.groups) {
    const rows = report.rows.filter((r) => `${r.profile}/${r.suite}` === g.key);
    const eligible = rows.filter(
      (r) =>
        r.arms.nativeThresholdProxy.inputWithinWindow && r.arms.uncertainAffine.inputWithinWindow,
    );
    expect(g.nativeComparable).toBe(eligible.length);
    if (!eligible.length) expect(g.meanVsNativeProxy).toBeNull();
  }
  expect(
    report.rows
      .filter((r) => r.suite === "main")
      .every((r) => r.arms.uncertainAffine.cost < r.arms.approximateEma.cost),
  ).toBe(true);
  expect(
    report.groups.find((g) => g.key === "deepseek-flash-peak/main")?.meanVsFixed60,
  ).toBeGreaterThan(0);
  expect(
    report.groups.find((g) => g.key === "deepseek-flash-peak/failure")?.meanVsEma,
  ).toBeGreaterThan(0);
  expect(renderAffineCost(rebuilt)).toBe(readFileSync("benchmarks/affine-cost.md", "utf8"));
});
