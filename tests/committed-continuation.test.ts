import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { affineCostCases } from "../tools/affine-cost";
import { sourceHash } from "../tools/affine-holdout";
import {
  captureCommittedBranch,
  renderCommittedContinuation,
  type runCommittedContinuation,
} from "../tools/committed-continuation";
import type { runBudgetFallback } from "../tools/qualification-fallback";
import { RenewalCommitment } from "../tools/renewal-commitment";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const report = () =>
  JSON.parse(read("benchmarks/reports/committed-continuation.json")) as ReturnType<
    typeof runCommittedContinuation
  >;

it("reproduces frozen incumbent and fixed60 full ledgers in every declared cell", () => {
  const r = report(),
    old = JSON.parse(read("benchmarks/reports/qualification-fallback.json")) as ReturnType<
      typeof runBudgetFallback
    >;
  expect(r.rows).toHaveLength(24);
  for (const v of r.rows) {
    const control = old.rows.find(
      (x) =>
        x.profile === v.profile &&
        x.fixture === v.fixture &&
        x.steps === v.steps &&
        x.suite === v.suite,
    );
    expect(v.baselineMatches).toBe(true);
    expect(v.arms.incumbent).toEqual(control?.arms.incumbent);
    expect(v.arms.fixed60).toEqual(control?.arms.fixed60);
    expect(new Set(Object.values(v.arms).map((x) => x.fingerprint)).size).toBe(1);
    for (const bill of Object.values(v.arms)) {
      expect(bill.cost).toBeCloseTo(bill.ordinary + bill.summary + bill.prewarm, 10);
      expect(bill.overflow).toBe(0);
      expect(bill.inputWithinWindow).toBe(true);
    }
  }
});

it("can replay actual commitment decisions and failures without supplying a future task endpoint", () => {
  const c = affineCostCases().find(
    (c) => c.profile === "claude-sonnet-5.5-5m-price" && c.suite === "main",
  );
  if (!c) throw new Error("Missing existing case");
  const b = captureCommittedBranch({ ...c.scenario, steps: 60 }, true);
  const commitment = new RenewalCommitment();
  const events = new Map(b.bill.compactions.map((x) => [x.step, x]));
  for (let i = 0; i < b.actions.length; i++) {
    const s = b.snapshots[i],
      e = b.estimates[i];
    if (!s || !e) throw new Error("Missing capture");
    expect(s.options.futureQualification).toBeUndefined();
    expect(s.options.renewalComparison).toBe("shared-wait-continuation");
    expect(s.options.durationModel?.completedCalls).toBe(i);
    const replanned = {
      action:
        s.baseline.action === "FORCE"
          ? ("FORCE" as const)
          : e.shouldCompact
            ? ("COMPACT" as const)
            : ("KEEP" as const),
    };
    expect(commitment.decide(s, replanned, e).action).toBe(b.actions[i]);
    const event = events.get(i);
    if (event) commitment.observe(event.success);
  }
  expect(commitment.snapshot()).toEqual(b.commitment);
  expect(b.commitment.stats.started).toBeGreaterThan(0);
  expect(b.commitment.stats.overrides).toBeGreaterThan(0);
});

it("preserves the unchanged short paths and retains negative per-profile outcomes", () => {
  const r = report();
  for (const v of r.rows.filter((x) => x.suite === "short")) {
    expect(v.arms.sharedCommit).toEqual(v.arms.sharedReplan);
    expect(v.commitment.stats.overrides).toBe(0);
  }
  for (const g of r.groups) {
    const cells = r.rows.filter((x) => `${x.profile}/${x.suite}` === g.key);
    expect(g.cases).toBe(cells.length);
    expect(g.meanVsSharedReplan).toBeCloseTo(
      cells.reduce((s, x) => s + x.arms.sharedCommit.cost / x.arms.sharedReplan.cost - 1, 0) /
        cells.length,
      12,
    );
  }
  const sonnet = r.groups.find((x) => x.key === "claude-sonnet-5.5-5m-price/main");
  expect(sonnet?.meanVsSharedReplan).toBeLessThan(0);
  expect(sonnet?.meanVsIncumbent).toBeGreaterThan(0);
  expect(
    r.groups.find((x) => x.key === "deepseek-flash-peak/main")?.meanVsSharedReplan,
  ).toBeGreaterThan(0);
});

it("pins the frozen plan, producer and Chinese report without claiming full recursive consistency", () => {
  const r = report();
  expect(r.paidCalls).toBe(0);
  expect(r.planCommit).toBe("b15dec4");
  expect(r.planHash).toBe("213d6ba4cda3dc487a24ae59d3cf9190c980aeed866d1c6f5d1f3adcd343fb82");
  expect(r.planHash).toBe(sourceHash(read("benchmarks/committed-continuation-plan.json")));
  for (const [p, h] of Object.entries(r.sourceHashes)) expect(sourceHash(read(p))).toBe(h);
  expect(renderCommittedContinuation(r)).toBe(read("benchmarks/committed-continuation.md"));
  expect(renderCommittedContinuation(r)).toContain("不保证整个未来256步");
});
