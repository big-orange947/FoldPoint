import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { postCompactBill, summaryUsageBill } from "../src/experimental-cycle";
import { resolveUnitPrices } from "../src/index";
import type { buildAffineCostReport } from "../tools/affine-cost";
import { sourceHash } from "../tools/affine-holdout";
import { SummaryOutputLearner } from "../tools/summary-output";
import { buildOutputCostReport, renderOutputCostReport } from "../tools/summary-output-cost";

const observation = (sequence: number, beforeTokens: number, outputTokens: number) => ({
  sequence,
  beforeTokens,
  beforeErrorTokens: Math.ceil(beforeTokens * 0.12),
  outputTokens,
  success: true,
});

it("preserves the legacy ratio prior/EMA fallback until the fixed-plus-proportional fit is identifiable", () => {
  const m = new SummaryOutputLearner("test-output/v1");
  expect(m.predict(100000)).toMatchObject({ outputTokens: 200, source: "ratio-prior", samples: 0 });
  m.observe(observation(1, 100000, 2000));
  expect(m.predict(100000).outputTokens).toBeCloseTo((0.002 + 0.25 * (0.02 - 0.002)) * 100000, 10);
  m.observe(observation(2, 110000, 2000));
  expect(m.snapshot().source).toBe("ratio-ema");
  m.observe(observation(3, 300000, 2000));
  expect(m.snapshot().source).toBe("affine");
  expect(m.predict(500000).outputTokens).toBeCloseTo(2000, 8);
  expect(m.snapshot().canDrivePolicy).toBe(false);
});

it("fits pure proportional and mixed output streams without baking in a 2000-token minimum", () => {
  const proportional = new SummaryOutputLearner("proportional/v1");
  const mixed = new SummaryOutputLearner("mixed/v1");
  [100000, 200000, 400000].forEach((before, i) => {
    proportional.observe(observation(i + 1, before, 0.005 * before));
    mixed.observe(observation(i + 1, before, 500 + 0.004 * before));
  });
  expect(proportional.predict(300000).outputTokens).toBeCloseTo(1500, 8);
  expect(proportional.snapshot().intercept).toBeCloseTo(0, 8);
  expect(mixed.predict(300000).outputTokens).toBeCloseTo(1700, 8);
  expect(mixed.snapshot().intercept).toBeCloseTo(500, 8);
});

it("accepts zero output and output larger than host input without clipping it as retention", () => {
  const zero = new SummaryOutputLearner("zero/v1");
  const expansion = new SummaryOutputLearner("expansion/v1");
  [500, 1000, 2000].forEach((before, i) => {
    zero.observe(observation(i + 1, before, 0));
    expansion.observe(observation(i + 1, before, 3000));
  });
  expect(zero.predict(3000).outputTokens).toBe(0);
  expect(expansion.predict(500).outputTokens).toBeCloseTo(3000, 8);
});

it("rejects invalid/duplicate feedback and excludes failed attempts from successful output learning", () => {
  const m = new SummaryOutputLearner("guard/v1");
  expect(m.observe({ ...observation(1, 100000, 5000), success: false })).toBe("failed");
  expect(m.snapshot().samples).toBe(0);
  expect(m.snapshot().legacyRatio).toBe(0.002);
  expect(m.observe(observation(1, 100000, 5000))).toBe("duplicate-or-out-of-order");
  expect(() => m.observe(observation(2, 100000, Number.NaN))).toThrow(RangeError);
  expect(m.observe(observation(2, 100000, 5000))).toBe("accepted-approximate");
  expect(m.snapshot().samples).toBe(1);
  expect(() => m.predict(0)).toThrow(RangeError);
});

it("bounds history, adapts after a change and drops an unsupported narrow-span fit", () => {
  const m = new SummaryOutputLearner("drift/v1");
  [100000, 200000, 400000].forEach((before, i) => {
    m.observe(observation(i + 1, before, 1800));
  });
  const prior = m.predict(600000).outputTokens;
  for (let i = 4; i <= 80; i++) m.observe(observation(i, 600000, 3500));
  expect(m.snapshot().retainedSamples).toBe(32);
  expect(m.snapshot().source).toBe("ratio-ema");
  expect(m.predict(600000).outputTokens).toBeGreaterThan(prior);
  expect(m.predict(600000).outputTokens).toBeCloseTo(3500, 4);
});

it("issues an output prediction before the current usage and learns only after receiving it", () => {
  const a = new SummaryOutputLearner("causal/v1");
  const b = new SummaryOutputLearner("causal/v1");
  [100000, 300000, 600000].forEach((before, i) => {
    a.observe(observation(i + 1, before, 1800));
    b.observe(observation(i + 1, before, 1800));
  });
  expect(a.predict(400000)).toEqual(b.predict(400000));
  a.observe(observation(4, 400000, 1000));
  b.observe(observation(4, 400000, 6000));
  expect(a.predict(500000).outputTokens).not.toBe(b.predict(500000).outputTokens);
});

it("does not double-charge a rebuilt prefix after an explicit prewarm request", () => {
  const prices = resolveUnitPrices({
    currency: "USD",
    inputPerMillion: 2,
    outputPerMillion: 10,
    cacheReadPerMillion: 0.2,
    cacheWritePerMillion: 2.5,
  });
  const direct = postCompactBill(prices, 20000, true, {});
  const warm = postCompactBill(prices, 20000, true, { prewarmOutputTokens: 1 });
  expect(direct).toEqual({ prewarm: 0, ordinary: 0.05 });
  expect(warm.prewarm).toBeCloseTo(0.05001, 12);
  expect(warm.ordinary).toBeCloseTo(0.004, 12);
  expect(warm.prewarm + warm.ordinary).toBeCloseTo(0.05401, 12);
  expect(warm.prewarm + warm.ordinary).toBeLessThan(2 * 0.05);
});

it("keeps old-summary cache sharing separate from establishment of the new summarized prompt", () => {
  const prices = resolveUnitPrices({
    currency: "USD",
    inputPerMillion: 2,
    outputPerMillion: 10,
    cacheReadPerMillion: 0.2,
    cacheWritePerMillion: 2.5,
  });
  const summary = summaryUsageBill(prices, 100000, 2000, 100000, 1, {
    summarySharedPrefixRatio: 0.8,
  });
  expect(summary).toBeCloseTo(80000 * 0.2e-6 + 20000 * 2e-6 + 2000 * 10e-6, 12);
  const post = postCompactBill(prices, 20000, true, { summarySharedPrefixRatio: 0.8 });
  expect(post.ordinary).toBeCloseTo(0.05, 12);
});

it("reconciles all saved output-only branches and refuses to hide negative or neutral cells", () => {
  const r = JSON.parse(
    readFileSync("benchmarks/reports/summary-output-cost.json", "utf8"),
  ) as ReturnType<typeof buildOutputCostReport>;
  expect(r.rows).toHaveLength(24);
  expect(sourceHash(readFileSync("benchmarks/summary-output-plan.json", "utf8"))).toBe(
    "b7c831e575bfe250f8dc1d59c90d1ab63ff9ad6eef5f9e3a5407fe1a26bb8eda",
  );
  const frozen = JSON.parse(
    readFileSync("benchmarks/reports/affine-cost.json", "utf8"),
  ) as ReturnType<typeof buildAffineCostReport>;
  for (const row of r.rows) {
    const old = frozen.rows.find(
      (v) =>
        v.profile === row.profile &&
        v.fixture === row.fixture &&
        v.suite === row.suite &&
        v.steps === row.steps,
    );
    if (!old) throw new Error("missing frozen cell");
    expect(row.arms.fixed60).toEqual(old.arms.fixed60);
    expect(row.arms.legacyOutputRatio).toEqual(old.arms.uncertainAffine);
    expect(row.baselineMatches).toBe(true);
    for (const arm of Object.values(row.arms)) {
      expect(arm.cost).toBeCloseTo(arm.ordinary + arm.summary + arm.prewarm, 10);
      expect(arm.fingerprint).toBe(row.arms.fixed60.fingerprint);
    }
    expect(row.diagnostics.candidate.outputModel.canDrivePolicy).toBe(false);
    expect(row.commonAttemptPrediction.samples).toBe(
      row.diagnostics.legacy.usage.filter((e) => e.success).length,
    );
    expect(row.diagnostics.candidate.usage.slice(0, 3)).toEqual(
      row.diagnostics.legacy.usage.slice(0, 3),
    );
  }
  for (const short of r.rows.filter((v) => v.suite === "main" && v.steps === 120)) {
    const long = r.rows.find(
      (v) =>
        v.suite === "main" &&
        v.steps === 240 &&
        v.profile === short.profile &&
        v.fixture === short.fixture,
    );
    expect(long?.arms.affineOutput.compactions.filter((v) => v.step < 120)).toEqual(
      short.arms.affineOutput.compactions,
    );
  }
  const rebuilt = buildOutputCostReport(r.rows);
  expect(rebuilt).toEqual(r);
  expect(renderOutputCostReport(r)).toBe(readFileSync("benchmarks/summary-output-cost.md", "utf8"));
  for (const [path, hash] of Object.entries(r.sourceHashes))
    expect(sourceHash(readFileSync(path, "utf8"))).toBe(hash);
  expect(r.paidCalls).toBe(0);
  expect(r.groups.find((g) => g.key === "deepseek-flash-peak/main")?.meanVsLegacy).toBe(0);
  expect(
    r.groups.find((g) => g.key === "claude-sonnet-5.5-5m-price/main")?.meanVsLegacy,
  ).toBeGreaterThan(0);
  expect(
    r.groups.find((g) => g.key === "claude-opus-5.5-5m-price/main")?.meanVsLegacy,
  ).toBeGreaterThan(0);
});
