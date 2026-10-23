import { expect, it } from "vitest";
import {
  executeRetentionReplay,
  type ReplayWorld,
  replayGrowth,
  runRetentionReplay,
} from "../tools/retained-floor-replay";

const base: ReplayWorld = {
  steps: 80,
  growth: 15000,
  readRatio: 0.1,
  summaryShared: false,
  actualRetention: "overlap",
};

it("keeps the whole execution deterministic and bills the same offered workload per arm", () => {
  const a = runRetentionReplay();
  expect(a).toEqual(runRetentionReplay());
  expect(a.cells).toHaveLength(144);
  for (const c of a.cells) {
    const offered = replayGrowth(c.world).reduce((n, v) => n + v, 0);
    for (const arm of c.arms) {
      expect(arm.offeredGrowth).toBe(offered);
      expect(arm.ordinaryCalls).toBe(c.world.steps);
      expect(arm.total).toBeCloseTo(arm.ordinaryCost + arm.summaryCost, 10);
      expect(arm.maxPrompt).toBeLessThan(700000);
      expect(arm.compactions).toBe(arm.actions.length);
    }
  }
});

it("has exactly matching costs before any compaction, not imaginary early savings", () => {
  const world = { ...base, steps: 5 };
  const results = (["legacy-affine", "total-floor-v2", "fixed60"] as const).map((policy) =>
    executeRetentionReplay(world, policy),
  );
  expect(new Set(results.map((r) => r.total)).size).toBe(1);
  expect(results.every((r) => r.compactions === 0 && r.summaryCost === 0)).toBe(true);
  const first = executeRetentionReplay({ ...world, steps: 1 }, "fixed60");
  expect(first.total).toBeCloseTo(100000 * 0.03e-6 + 300 * 1.2e-6, 12);
});

it("does not change earlier actions using a later task endpoint", () => {
  for (const policy of ["legacy-affine", "total-floor-v2", "fixed60"] as const) {
    const short = executeRetentionReplay({ ...base, steps: 80 }, policy);
    const long = executeRetentionReplay({ ...base, steps: 800 }, policy);
    expect(long.actions.filter((a) => a.step < 80)).toEqual(short.actions);
  }
});

it("reconciles an independent warm read/write and summary ledger from actual executed actions", () => {
  for (const summaryShared of [false, true])
    for (const actualRetention of ["overlap", "additive"] as const) {
      const world = { ...base, summaryShared, actualRetention };
      for (const policy of ["legacy-affine", "total-floor-v2", "fixed60"] as const) {
        const run = executeRetentionReplay(world, policy);
        let context = 100000,
          prefix = 100000,
          ordinary = 0,
          summary = 0;
        const growth = replayGrowth(world);
        for (let step = 0; step < world.steps; step++) {
          const action = run.actions.find((a) => a.step === step);
          if (action) {
            expect(action.before).toBe(context);
            const read = summaryShared ? Math.min(prefix, context) : 0;
            summary +=
              read * 0.03e-6 +
              (context - read) * 0.3e-6 +
              Math.ceil(context * 0.002 + 100) * 1.2e-6;
            context = action.after;
            prefix = 0;
          }
          ordinary +=
            Math.min(prefix, context) * 0.03e-6 +
            (context - Math.min(prefix, context)) * 0.3e-6 +
            300 * 1.2e-6;
          prefix = context;
          context += growth[step] ?? 0;
        }
        expect(run.ordinaryCost).toBeCloseTo(ordinary, 10);
        expect(run.summaryCost).toBeCloseTo(summary, 10);
        expect(run.compactions).toBeGreaterThan(0);
      }
    }
});

it("retains losses and ties instead of hiding them in an aggregate savings percentage", () => {
  const report = runRetentionReplay();
  expect(report.summary.allVsFixed60).toMatchObject({ cells: 144, wins: 99, ties: 36, losses: 9 });
  expect(report.summary.longVsLegacy).toMatchObject({ cells: 72, wins: 15, ties: 42, losses: 15 });
  expect(report.summary.longVsFixed60).toMatchObject({ cells: 72, wins: 67, ties: 0, losses: 5 });
  expect(report).toMatchObject({ paidCalls: 0, realTask: false, policyChanged: false });
});

it("rejects malformed synthetic worlds", () => {
  for (const patch of [{ steps: 0 }, { growth: NaN }, { growth: 200000 }, { readRatio: 0 }])
    expect(() => executeRetentionReplay({ ...base, ...patch }, "fixed60")).toThrow();
});
