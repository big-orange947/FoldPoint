import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  type ApproximateFeedback,
  ApproximateRetentionTracker,
} from "../tools/approximate-feedback";
import {
  renderApproximateFeedback,
  runApproximateFeedbackProbe,
} from "../tools/approximate-feedback-probe";

const observation = (overrides: Partial<ApproximateFeedback> = {}): ApproximateFeedback => ({
  basisKey: "host/model/compactor/estimator-v1",
  sequence: 1,
  success: true,
  source: "host-immediate",
  beforeTokens: 100_000,
  afterTokens: 25_000,
  beforeErrorTokens: 0,
  afterErrorTokens: 0,
  ...overrides,
});
const tracker = () => new ApproximateRetentionTracker(observation().basisKey);

it("learns approximate observations without converting them into exact samples or policy authority", () => {
  const t = tracker();
  expect(t.predict(100_000)).toBeNull();
  expect(t.observe(observation())).toBe("accepted-approximate");
  expect(t.snapshot()).toMatchObject({
    acceptedApproximate: 1,
    exactSamples: 0,
    canDrivePolicy: false,
    sources: { hostImmediate: 1, hostDelayed: 0 },
  });
  expect(t.predict(100_000)).toMatchObject({
    pointTokens: 25_000,
    lowerTokens: 25_000,
    upperTokens: 25_000,
    calibratedConfidenceInterval: false,
    canDrivePolicy: false,
    extrapolated: false,
  });
  expect(t.predict(200_000)?.extrapolated).toBe(true);
});

it("keeps nominal estimates stable when error assumptions widen and gives uncertain updates less influence", () => {
  const a = tracker();
  const b = tracker();
  a.observe(observation({ afterTokens: 10_000 }));
  b.observe(observation({ afterTokens: 10_000 }));
  a.observe(observation({ sequence: 2, afterTokens: 40_000 }));
  b.observe(
    observation({
      sequence: 2,
      afterTokens: 40_000,
      beforeErrorTokens: 20_000,
      afterErrorTokens: 8_000,
    }),
  );
  expect(b.predict(100_000)?.pointTokens).toBeLessThan(a.predict(100_000)?.pointTokens ?? 0);
  const alone = tracker();
  alone.observe(
    observation({ afterTokens: 40_000, beforeErrorTokens: 20_000, afterErrorTokens: 8_000 }),
  );
  expect(alone.predict(100_000)?.pointTokens).toBe(40_000);
  expect(alone.predict(100_000)?.lowerTokens).toBeLessThan(40_000);
  expect(alone.predict(100_000)?.upperTokens).toBeGreaterThan(40_000);
});

it("requires a growth budget for delayed sizes and subtracts its range in the correct direction", () => {
  const t = tracker();
  expect(t.observe(observation({ source: "host-delayed" }))).toBe("unknown-growth");
  expect(t.snapshot().acceptedApproximate).toBe(0);
  expect(
    t.observe(
      observation({
        sequence: 2,
        source: "host-delayed",
        afterTokens: 40_000,
        growth: { lowerTokens: 10_000, upperTokens: 20_000 },
      }),
    ),
  ).toBe("accepted-approximate");
  expect(t.predict(100_000)).toMatchObject({
    lowerTokens: 20_000,
    pointTokens: 25_000,
    upperTokens: 30_000,
  });
  expect(
    t.observe(
      observation({
        sequence: 3,
        source: "host-delayed",
        growth: { lowerTokens: 50_000, upperTokens: 60_000 },
      }),
    ),
  ).toBe("inconsistent-growth");
  expect(t.snapshot().acceptedApproximate).toBe(1);
  expect(t.snapshot().sources).toEqual({ hostImmediate: 0, hostDelayed: 1 });
});

it("does not learn failed, duplicate, out-of-order or incompatible-basis observations", () => {
  const t = tracker();
  expect(t.observe(observation({ basisKey: "different-estimator", sequence: 99 }))).toBe(
    "incompatible-basis",
  );
  expect(t.snapshot().lastSequence).toBe(0);
  expect(t.observe(observation({ success: false }))).toBe("failed");
  expect(t.observe(observation({ sequence: 2 }))).toBe("accepted-approximate");
  expect(t.observe(observation({ sequence: 2 }))).toBe("duplicate-or-out-of-order");
  expect(t.observe(observation())).toBe("duplicate-or-out-of-order");
  expect(t.snapshot().acceptedApproximate).toBe(1);
});

it("keeps bounded recent envelopes, including drift and non-shrinking outcomes without clipping", () => {
  const t = tracker();
  for (let i = 1; i <= 100; i++)
    t.observe(observation({ sequence: i, afterTokens: i % 2 === 0 ? 10_000 : 40_000 }));
  expect(t.snapshot()).toMatchObject({
    acceptedApproximate: 100,
    retainedSamples: 32,
    exactSamples: 0,
  });
  expect(t.predict(100_000)).toMatchObject({ lowerTokens: 10_000, upperTokens: 40_000 });
  t.observe(observation({ sequence: 101, afterTokens: 120_000 }));
  expect(t.predict(100_000)?.upperTokens).toBe(120_000);
  const s = t.snapshot();
  if (s.estimate) s.estimate.ratio = 999;
  expect(t.snapshot().estimate?.ratio).not.toBe(999);
});

it("does not average away a systematic assumed error by repeating the same estimate", () => {
  const t = tracker();
  t.observe(observation({ beforeErrorTokens: 10_000, afterErrorTokens: 2_500 }));
  const first = t.predict(100_000);
  for (let i = 2; i <= 50; i++)
    t.observe(observation({ sequence: i, beforeErrorTokens: 10_000, afterErrorTokens: 2_500 }));
  expect(t.predict(100_000)).toEqual(first);
  expect(t.snapshot().exactSamples).toBe(0);
});

it.each([
  { beforeTokens: 0 },
  { beforeTokens: Number.NaN },
  { beforeErrorTokens: 100_000 },
  { afterTokens: -1 },
  { afterErrorTokens: 0.5 },
  { sequence: 0 },
  { afterTokens: Number.MAX_SAFE_INTEGER, afterErrorTokens: 1 },
  { growth: { lowerTokens: 20, upperTokens: 10 } },
])("rejects malformed metadata before mutating state: %j", (change) => {
  const t = tracker();
  expect(() => t.observe(observation(change))).toThrow(RangeError);
  expect(t.snapshot().lastSequence).toBe(0);
  expect(t.snapshot().acceptedApproximate).toBe(0);
});

it("reports an explicitly assumed error envelope rather than deriving precision from one live sample", () => {
  const r = runApproximateFeedbackProbe();
  expect(r.passed).toBe(true);
  expect(r.paidCalls).toBe(0);
  expect(Object.values(r.checks)).toEqual(Array(8).fill(true));
  expect(r.sensitivity.map((s) => s.sameSizePrediction?.pointTokens)).toEqual([1474, 1474, 1474]);
  expect(r.sensitivity.every((s) => s.state.exactSamples === 0)).toBe(true);
  expect(renderApproximateFeedback(r)).toBe(
    readFileSync("benchmarks/approximate-feedback.md", "utf8"),
  );
});
