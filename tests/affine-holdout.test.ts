import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  ARMS,
  assertHoldoutCandidate,
  HOLDOUT_PLAN,
  makeHoldoutFrames,
  renderAffineHoldout,
  replayHoldout,
  runAffineHoldout,
  sourceHash,
} from "../tools/affine-holdout";

it("freezes the prospective plan, candidate and new seeds without changing old fixtures", () => {
  expect(HOLDOUT_PLAN.candidateCommit).toBe("3fc64c4");
  expect(HOLDOUT_PLAN.cases).toHaveLength(12);
  expect(HOLDOUT_PLAN.seeds).toEqual([104729, 130363, 155921]);
  expect(sourceHash(readFileSync("benchmarks/affine-holdout-plan.json", "utf8"))).toBe(
    "02929b756a9b834a6d4f91c5b74da6439844064793ba7b77b89be5b2f5e69b37",
  );
  const source = readFileSync("tools/uncertain-affine-feedback.ts", "utf8");
  expect(() => assertHoldoutCandidate(source)).not.toThrow();
  expect(() => assertHoldoutCandidate(source.replace(/\r\n/g, "\n"))).not.toThrow();
  expect(() => assertHoldoutCandidate(`${source}\n// retuned`)).toThrow(/Frozen/);
});

it("generates prefix-stable streams and keeps later measurements aligned through failures", () => {
  const c = HOLDOUT_PLAN.cases[10];
  if (!c) throw new Error("missing case");
  const frames = makeHoldoutFrames(c, 104729);
  expect(makeHoldoutFrames(c, 104729, 12)).toEqual(frames.slice(0, 12));
  const successful = makeHoldoutFrames({ ...c, failEvery: undefined }, 104729);
  for (let i = 0; i < frames.length; i++) {
    const row = frames[i];
    if (!row) throw new Error("missing row");
    expect(row.feedback.beforeTokens).toBe(successful[i]?.feedback.beforeTokens);
    if (row.feedback.success) expect(row).toEqual(successful[i]);
  }
  expect(makeHoldoutFrames(c, 130363)).not.toEqual(frames);
  expect(() => makeHoldoutFrames(c, 1, 0)).toThrow(RangeError);
});

it("issues predictions before seeing the current outcome and never feeds evaluator truth", () => {
  const c = HOLDOUT_PLAN.cases[0];
  if (!c) throw new Error("missing case");
  const frames = makeHoldoutFrames(c, 104729);
  const base = replayHoldout(frames);
  expect(replayHoldout(frames.slice(0, 12)).rows).toEqual(base.rows.slice(0, 12));
  const altered = structuredClone(frames);
  const current = altered[8];
  if (!current) throw new Error("missing row");
  current.feedback.afterTokens *= 3;
  current.truth = 900_000;
  const changed = replayHoldout(altered);
  expect(changed.rows.slice(0, 8)).toEqual(base.rows.slice(0, 8));
  expect(changed.rows[8]?.predictions).toEqual(base.rows[8]?.predictions);
  const truthOnly = replayHoldout(
    frames.map((f) => ({ ...f, truth: f.truth === null ? null : 1 })),
  );
  expect(truthOnly.rows.map((r) => r.predictions)).toEqual(base.rows.map((r) => r.predictions));
  expect(changed.rows[9]?.predictions.affine).not.toBe(base.rows[9]?.predictions.affine);
});

it("scores common successes including cold fallbacks, and reconciles each error independently", () => {
  for (const c of HOLDOUT_PLAN.cases) {
    const r = replayHoldout(makeHoldoutFrames(c, 104729));
    const scored = r.rows.filter((row) => row.truth !== null);
    expect(r.fitted + r.fallback).toBe(scored.length);
    for (const arm of ARMS) {
      expect(r.metrics[arm]?.samples).toBe(scored.length);
      expect(r.metrics[arm]?.mae).toBe(
        scored.reduce((s, row) => s + Math.abs(row.predictions[arm] - (row.truth ?? 0)), 0) /
          scored.length,
      );
      const warm = scored.slice(3);
      expect(r.metrics[arm]?.warmMae).toBe(
        warm.reduce((s, row) => s + Math.abs(row.predictions[arm] - (row.truth ?? 0)), 0) /
          warm.length,
      );
    }
    expect(r.rows[0]?.predictions.affine).toBe(r.rows[0]?.predictions.fixed10);
    if (c.delayed === "unknown") {
      expect(r.rejected).toBe(64);
      expect(r.fallback).toBe(64);
      expect(r.intervalSamples).toBe(0);
      for (const arm of ARMS) expect(r.metrics[arm]).toEqual(r.metrics.fixed10);
    }
  }
});

it("retains narrow-range losses, understated-error failures and interval width alongside coverage", () => {
  const r = runAffineHoldout();
  expect(r.summary).toMatchObject({ streams: 36, attempts: 2304, samples: 2283 });
  const narrow = r.groups.find((g) => g.id === "narrow-floor");
  expect(narrow?.fitted).toBe(0);
  expect(narrow?.metrics.affine?.mae).toBeGreaterThan(narrow?.metrics.approximate?.mae ?? Infinity);
  const biased = r.groups.find((g) => g.id === "understated-error");
  expect(biased?.covered).toBeLessThan(biased?.intervals ?? 0);
  expect(biased?.metrics.affine?.mae).toBeGreaterThan(biased?.metrics.fixed10?.mae ?? Infinity);
  expect(r.summary.versus.approximate?.losses).toBe(14);
  expect(r.groups.find((g) => g.id === "irregular-floor")?.width).toBeGreaterThan(0.9);
  expect(r.paidCalls).toBe(0);
});

it("reproduces the checked-in report without rewriting historical reports", () => {
  const a = runAffineHoldout();
  expect(runAffineHoldout()).toEqual(a);
  expect(renderAffineHoldout(a)).toBe(readFileSync("benchmarks/affine-holdout.md", "utf8"));
  expect(a.runs.every((r) => r.rows.every((row) => !row.interval?.canDrivePolicy))).toBe(true);
});
