import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  assertFeedbackSource,
  FEEDBACK_SCENARIOS,
  renderFeedbackPrequential,
  runFeedbackPrequential,
  runFeedbackScenario,
} from "../tools/feedback-prequential";

const scenario = (id: string) => {
  const s = FEEDBACK_SCENARIOS.find((item) => item.id === id);
  if (!s) throw new Error("missing fixture");
  return s;
};

it("records predictions before the current target or future endpoint is revealed", () => {
  const s = scenario("stable-high");
  const a = runFeedbackScenario(s, 151, 40);
  expect(runFeedbackScenario(s, 151, 12).rows).toEqual(a.rows.slice(0, 12));
  const changed = runFeedbackScenario({ ...s, change: { at: 5, ratio: 0.4 } }, 151, 40);
  expect(changed.rows.slice(0, 5)).toEqual(a.rows.slice(0, 5));
  expect(changed.rows[5]?.predictions).toEqual(a.rows[5]?.predictions);
  expect(changed.rows[5]?.truth).not.toBe(a.rows[5]?.truth);
  expect(changed.rows[6]?.predictions.approximate).not.toBe(a.rows[6]?.predictions.approximate);
});

it("scores the same successful attempts for every arm, including cold fallback and unknown-growth refusals", () => {
  const first = runFeedbackScenario(scenario("stable-high"), 151, 1);
  for (const m of Object.values(first.metrics))
    expect(m).toMatchObject({ samples: 1, mae: 15_000, warmMae: null });
  const r = runFeedbackScenario(scenario("delayed-unknown-growth"), 151);
  expect(r.accepted).toBe(0);
  expect(r.fallbackScored).toBe(40);
  expect(r.rejectedGrowth).toBe(40);
  expect(r.envelope).toMatchObject({ samples: 0, coverage: null, meanRelativeWidth: null });
  expect(r.metrics.fixed10).toEqual(r.metrics.approximate);
  expect(r.metrics.fixed10).toEqual(r.metrics.pointEma);
});

it("separates failed attempts and keeps noise streams aligned without training on failure", () => {
  const failed = runFeedbackScenario(scenario("failed-attempts"), 151);
  const clean = runFeedbackScenario({ ...scenario("failed-attempts"), failEvery: undefined }, 151);
  expect(failed.failed).toBe(5);
  expect(failed.accepted).toBe(35);
  for (const row of failed.rows) {
    if (row.success) expect(row.observedAfter).toBe(clean.rows[row.step]?.observedAfter);
    else {
      expect(row.truth).toBeNull();
      expect(row.admission).toBe("failed");
    }
  }
  for (const m of Object.values(failed.metrics)) expect(m.samples).toBe(35);
});

it("recomputes point errors, interval coverage and widths rather than rewarding abstention or broad intervals", () => {
  const r = runFeedbackScenario(scenario("fixed-floor"), 919);
  const scored = r.rows.filter((row) => row.truth !== null);
  const mae =
    scored.reduce((sum, row) => sum + Math.abs(row.predictions.approximate - (row.truth ?? 0)), 0) /
    scored.length;
  expect(r.metrics.approximate.mae).toBe(mae);
  const eligible = scored.filter((row) => row.prediction !== null);
  expect(r.envelope.samples).toBe(39);
  expect(r.envelope.covered).toBe(
    eligible.filter(
      (row) =>
        row.prediction &&
        (row.truth ?? 0) >= row.prediction.lowerTokens &&
        (row.truth ?? 0) <= row.prediction.upperTokens,
    ).length,
  );
  expect(r.envelope.meanRelativeWidth).toBeGreaterThan(1);
});

it("keeps honest negative cases and deterministic artifacts without tuning the learner", () => {
  const r = runFeedbackPrequential();
  expect(r.summary).toMatchObject({
    streams: 27,
    attempts: 1080,
    scoredSuccesses: 1065,
    failedAttempts: 15,
    winsVsFixed: 15,
    lossesVsFixed: 9,
    winsVsPointEma: 12,
    lossesVsPointEma: 9,
  });
  for (const id of ["fixed-floor", "near-prior", "underdeclared-bias"]) {
    const g = r.groups.find((group) => group.id === id);
    expect(g?.mae.approximate).toBeGreaterThan(g?.mae.fixed10 ?? Infinity);
  }
  expect(r.groups.find((g) => g.id === "phase-change")?.mae.approximate).toBeGreaterThan(
    r.groups.find((g) => g.id === "phase-change")?.mae.pointEma ?? Infinity,
  );
  expect(r.groups.find((g) => g.id === "underdeclared-bias")?.assumptionViolations).toBe(120);
  expect(r.paidCalls).toBe(0);
  expect(r.summary.macroMae.approximate).toBeGreaterThan(r.summary.macroMae.pointEma);
  expect(r.summary.macroMae.approximate).toBeGreaterThan(r.summary.macroMae.lastObserved);
  expect(runFeedbackPrequential()).toEqual(r);
  expect(renderFeedbackPrequential(r)).toBe(
    readFileSync("benchmarks/feedback-prequential.md", "utf8"),
  );
});

it("refuses invalid screening inputs and changed source instead of silently rewriting old evidence", () => {
  const s = scenario("stable-high");
  expect(() => runFeedbackScenario(s, 151, 0)).toThrow(RangeError);
  expect(() => runFeedbackScenario(s, Number.NaN)).toThrow(RangeError);
  expect(() => runFeedbackScenario({ ...s, failEvery: 1 }, 151)).toThrow(RangeError);
  const source = readFileSync("tools/approximate-feedback.ts", "utf8");
  expect(() => assertFeedbackSource(source.replace(/\r?\n/g, "\r\n"))).not.toThrow();
  expect(() => assertFeedbackSource(`${source}\n// changed`)).toThrow(/Frozen learner/);
});
