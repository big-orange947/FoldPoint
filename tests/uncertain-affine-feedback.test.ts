import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  assertAffineBaseline,
  renderAffineComparison,
  runAffineComparison,
  runAffineScenario,
} from "../tools/affine-feedback-comparison";
import type { ApproximateFeedback } from "../tools/approximate-feedback";
import { FEEDBACK_SCENARIOS, runFeedbackScenario } from "../tools/feedback-prequential";
import { UncertainAffineFeedback } from "../tools/uncertain-affine-feedback";

const basis = "compatible-host-estimator/v1";
const observation = (
  sequence: number,
  beforeTokens: number,
  afterTokens: number,
  overrides: Partial<ApproximateFeedback> = {},
): ApproximateFeedback => ({
  basisKey: basis,
  sequence,
  beforeTokens,
  afterTokens,
  beforeErrorTokens: 0,
  afterErrorTokens: 1000,
  success: true,
  source: "host-immediate",
  ...overrides,
});
const trained = () => {
  const m = new UncertainAffineFeedback(basis);
  for (const [i, x] of [100_000, 200_000, 300_000].entries())
    m.observe(observation(i + 1, x, 10_000 + 0.1 * x));
  return m;
};

it("learns a nonnegative floor and slope without receiving either coefficient as input", () => {
  const m = trained();
  const s = m.snapshot();
  expect(s.model?.floor).toBeCloseTo(10_000, 6);
  expect(s.model?.slope).toBeCloseTo(0.1, 9);
  expect(s).toMatchObject({
    acceptedApproximate: 3,
    exactSamples: 0,
    canDrivePolicy: false,
    calibratedErrorBudget: false,
  });
  expect(m.predict(250_000)?.pointTokens).toBeCloseTo(35_000, 6);
  expect(m.predict(250_000)?.lowerTokens).toBeLessThan(35_000);
  expect(m.predict(250_000)?.upperTokens).toBeGreaterThan(35_000);
  expect(m.predict(500_000)?.extrapolated).toBe(true);
});

it("keeps cold/low-span fallback explicit and never forces an unidentifiable affine fit", () => {
  const m = new UncertainAffineFeedback(basis);
  expect(m.predict(100_000)).toBeNull();
  for (const [i, x] of [100_000, 101_000, 102_000].entries())
    m.observe(observation(i + 1, x, 25_000));
  expect(m.snapshot().model).toBeNull();
  expect(m.predict(102_000)).toMatchObject({
    source: "last-observation-fallback",
    pointTokens: 25_000,
  });
  const instantaneous = new UncertainAffineFeedback(basis, 1);
  for (const [i, x] of [100_000, 200_000, 300_000].entries())
    instantaneous.observe(observation(i + 1, x, 25_000));
  expect(instantaneous.snapshot().model).toBeNull();
});

it("uses explicit uncertainty to reduce outlier influence, not to turn estimates into exact samples", () => {
  const narrow = trained();
  const wide = trained();
  narrow.observe(observation(4, 250_000, 60_000, { afterErrorTokens: 0 }));
  wide.observe(observation(4, 250_000, 60_000, { afterErrorTokens: 20_000 }));
  expect(Math.abs((wide.predict(250_000)?.pointTokens ?? 0) - 35_000)).toBeLessThan(
    Math.abs((narrow.predict(250_000)?.pointTokens ?? 0) - 35_000),
  );
  expect(wide.snapshot().exactSamples).toBe(0);
});

it("rejects unknown growth, failure, duplicates, incompatible metadata and invalid counts without training", () => {
  const m = new UncertainAffineFeedback(basis);
  expect(m.observe(observation(1, 100_000, 25_000, { source: "host-delayed" }))).toBe(
    "unknown-growth",
  );
  expect(m.observe(observation(2, 100_000, 25_000, { success: false }))).toBe("failed");
  expect(
    m.observe(
      observation(3, 100_000, 40_000, {
        source: "host-delayed",
        growth: { lowerTokens: 10_000, upperTokens: 20_000 },
      }),
    ),
  ).toBe("accepted-approximate");
  expect(m.predict(100_000)?.pointTokens).toBe(25_000);
  expect(m.observe(observation(3, 100_000, 25_000))).toBe("duplicate-or-out-of-order");
  expect(m.observe(observation(4, 100_000, 25_000, { basisKey: "different-estimator" }))).toBe(
    "incompatible-basis",
  );
  expect(() => m.observe(observation(4, 100_000, Number.NaN))).toThrow(RangeError);
  expect(m.snapshot().acceptedApproximate).toBe(1);
});

it("keeps memory bounded, drops unsupported identification and does not clip expansion into fake shrinkage", () => {
  const m = trained();
  for (let i = 4; i < 100; i++) m.observe(observation(i, 100_000, 120_000));
  expect(m.snapshot().retainedSamples).toBe(32);
  expect(m.snapshot().model).toBeNull();
  expect(m.predict(100_000)?.pointTokens).toBe(120_000);
  const fresh = trained();
  const copied = fresh.snapshot();
  if (copied.model) copied.model.floor = 999_999;
  expect(fresh.snapshot().model?.floor).toBeCloseTo(10_000);
});

it("uses a causal replay with unchanged endpoints and baselines", () => {
  const s = FEEDBACK_SCENARIOS[0];
  if (!s) throw new Error("missing scenario");
  const a = runAffineScenario(s, 151, 40);
  expect(runAffineScenario(s, 151, 12).rows).toEqual(a.rows.slice(0, 12));
  const changed = runAffineScenario({ ...s, change: { at: 5, ratio: 0.4 } }, 151);
  expect(changed.rows.slice(0, 5)).toEqual(a.rows.slice(0, 5));
  expect(changed.rows[5]?.issued).toBe(a.rows[5]?.issued);
  expect(changed.rows[5]?.truth).not.toBe(a.rows[5]?.truth);
  expect(a.baseline).toEqual(runFeedbackScenario(s, 151).metrics);
  expect(a.rows[0]?.issued).toBe(10_000);
});

it("reconciles scoring and refusals without hiding fallback attempts", () => {
  const unknown = FEEDBACK_SCENARIOS.find((s) => s.id === "delayed-unknown-growth");
  const failed = FEEDBACK_SCENARIOS.find((s) => s.id === "failed-attempts");
  if (!unknown || !failed) throw new Error("missing scenario");
  const r = runAffineScenario(unknown, 151);
  expect(r.coldFallbacks).toBe(40);
  expect(r.mae).toBe(r.baseline.fixed10.mae);
  const f = runAffineScenario(failed, 151);
  expect(f.samples).toBe(35);
  expect(f.fittedPredictions + f.lastFallbacks + f.coldFallbacks).toBe(35);
  const scored = f.rows.filter((row) => row.truth !== null);
  expect(f.mae).toBe(
    scored.reduce((sum, row) => sum + Math.abs(row.issued - (row.truth ?? 0)), 0) / scored.length,
  );
});

it("publishes deterministic positive and negative results and refuses changed baseline source", () => {
  const r = runAffineComparison();
  expect(r.paidCalls).toBe(0);
  expect(r.summary.samples).toBe(1065);
  const floor = r.groups.find((g) => g.id === "fixed-floor");
  expect(floor?.affineMae).toBeLessThan(floor?.mae.approximate ?? 0);
  const stable = r.groups.find((g) => g.id === "stable-high");
  expect(stable?.affineMae).toBeGreaterThan(stable?.mae.approximate ?? Infinity);
  expect(r.groups.find((g) => g.id === "underdeclared-bias")?.mae.fixed10).toBe(0);
  expect(r.summary.lossesVsFixed).toBe(6);
  expect(runAffineComparison()).toEqual(r);
  expect(renderAffineComparison(r)).toBe(
    readFileSync("benchmarks/affine-feedback-comparison.md", "utf8"),
  );
  const source = readFileSync("tools/feedback-prequential.ts", "utf8");
  expect(() => assertAffineBaseline(source)).not.toThrow();
  expect(() => assertAffineBaseline(`${source}\n// changed`)).toThrow(/baseline changed/);
});
