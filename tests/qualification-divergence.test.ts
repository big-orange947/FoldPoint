import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { estimateRuntimeSurvival } from "../src/index";
import { sourceHash } from "../tools/affine-holdout";
import {
  forkAccounting,
  recheckProjected,
  renderQualificationDivergence,
  type runQualificationDivergence,
} from "../tools/qualification-divergence";
import { estimateRuntimeSurvival as safetyEstimate } from "../tools/qualification-safety-runtime";

const read = (p: string) => readFileSync(p, "utf8").replace(/\r\n/g, "\n");
const report = () =>
  JSON.parse(read("benchmarks/reports/qualification-divergence.json")) as ReturnType<
    typeof runQualificationDivergence
  >;
const checkpoint = () => {
  const c = report().selected.checkpoint;
  if (!c) throw new Error("Missing first fork");
  return c;
};

it("keeps the declared failure and unchanged control without selecting on new results", () => {
  const r = report();
  expect(r.planCommit).toBe("11c6ebb");
  expect(r.planHash).toBe("ff56b3f4f5a31cfee13aea61a1a840c6deb975edc3cbd17f829a7a4ab256ba93");
  expect(r.planHash).toBe(sourceHash(read("benchmarks/qualification-divergence-plan.json")));
  expect(r.selected.incumbentBill.summaryCalls).toBe(37);
  expect(r.selected.candidateBill.summaryCalls).toBe(71);
  expect(r.selected.baselineMatches).toBe(true);
  expect(r.control.baselineMatches).toBe(true);
  expect(r.control.status).toBe("UNCHANGED");
  expect(r.control.checkpoint).toBe(null);
  expect(r.control.candidateBill).toEqual(r.control.incumbentBill);
  expect(r.frozenResultHash).toBe(
    sourceHash(read("benchmarks/reports/qualification-fallback.json")),
  );
});

it("recreates both decisions at the same frozen state and reconciles all predicted components", () => {
  const c = checkpoint(),
    s = c.snapshot;
  const old = estimateRuntimeSurvival(s.input, s.baseline, { ...s.options, explainBills: true });
  const next = safetyEstimate(s.input, s.baseline, { ...s.options, explainBills: true });
  expect(c.step).toBe(37);
  expect(c.snapshot.input.contextTokens).toBe(87464);
  expect(old.shouldCompact).toBe(false);
  expect(next.shouldCompact).toBe(true);
  expect(old.requiredSaving).toBe(next.requiredSaving);
  expect(forkAccounting(old, next)).toEqual(c.accounting);
  expect(c.accounting.now.summaryCost).toBeLessThan(0);
  expect(c.accounting.wait.ordinaryInputCost).toBeGreaterThan(c.accounting.now.ordinaryInputCost);
  expect(c.accounting.wait.total - c.accounting.now.total).toBeCloseTo(0.10274003266200626, 12);
});

it("uses hand-computed WAIT minus NOW deltas and rejects inconsistent bills", () => {
  const s = checkpoint().snapshot;
  const template = estimateRuntimeSurvival(s.input, s.baseline, {
    ...s.options,
    explainBills: true,
  });
  if (!template.forecastBills) throw new Error("Missing bills");
  const old = structuredClone(template),
    next = structuredClone(template);
  for (const [e, nInput, nSummary, wInput, wSummary] of [
    [old, 3, 2, 4, 2],
    [next, 5, 1, 8, 1],
  ] as const) {
    if (!e.forecastBills) throw new Error("Missing bill");
    Object.assign(e.forecastBills.now, {
      ordinaryInputCost: nInput,
      summaryCost: nSummary,
      prewarmCost: 0,
    });
    Object.assign(e.forecastBills.wait, {
      ordinaryInputCost: wInput,
      summaryCost: wSummary,
      prewarmCost: 0,
    });
    e.compactNowCost = nInput + nSummary;
    e.bestWaitCost = wInput + wSummary;
    e.expectedSaving = e.bestWaitCost - e.compactNowCost;
  }
  const d = forkAccounting(old, next);
  expect(d.now.total).toBe(1);
  expect(d.wait.total).toBe(3);
  expect(d.savingChange).toBe(2);
  next.compactNowCost++;
  expect(() => forkAccounting(old, next)).toThrow(/accounting/);
});

it("exposes a projected KEEP that the same frozen candidate would replace with COMPACT", () => {
  const c = checkpoint(),
    s = structuredClone(c.snapshot),
    before = JSON.stringify(s);
  const e = safetyEstimate(s.input, s.baseline, { ...s.options, explainBills: true });
  if (!e.forecastBills) throw new Error("Missing projection");
  const rows = recheckProjected(s, e.forecastBills.now);
  expect(rows).toEqual(c.projectedRechecks);
  expect(rows).toHaveLength(12);
  const third = rows.find((v) => v.call === 3);
  expect(third).toMatchObject({
    forecastCompact: false,
    innerAllowed: false,
    incumbentAllowed: false,
    candidateAllowed: true,
    candidateEligible: true,
  });
  expect(third?.completedCalls).toBe(40);
  expect(JSON.stringify(s)).toBe(before);
  expect(c.candidate.actualFirst12[3]).toMatchObject({ step: 40, action: "COMPACT" });
  // Projected context and actual context are not treated as the same observation.
  expect(third?.context).not.toBe(c.candidate.actualFirst12[3]?.context);
});

it("keeps real total fees separate from hypothetical forecasts with a shared comparison window", () => {
  const r = report(),
    c = checkpoint();
  const d = c.actualComponentChanges;
  expect(d.summary).toBeCloseTo(2.04, 10);
  expect(d.ordinary).toBeCloseTo(-1.2394032, 10);
  expect(d.ordinary + d.summary + d.prewarm).toBeCloseTo(c.actualTotalCostChange, 10);
  expect(c.actualTotalCostChange).toBeCloseTo(
    r.selected.candidateBill.cost - r.selected.incumbentBill.cost,
    10,
  );
  for (const arm of [c.incumbent, c.candidate]) {
    expect(arm.chosenComparison.matchedCalls).toBe(203);
    expect(arm.chosenComparison.ordinaryOutputExcluded).toBe(true);
    expect(arm.actualFirst12).toHaveLength(12);
  }
  expect(c.candidate.chosenComparison.rawForecast.summaryCalls).toBe(8);
  expect(c.candidate.chosenComparison.rawActual.summaryCalls).toBe(68);
});

it("reproduces documentation and source identity without claiming a causal total or new savings", () => {
  const r = report();
  expect(r.sourceHash).toBe(sourceHash(read("tools/qualification-divergence.ts")));
  expect(r.paidCalls).toBe(0);
  expect(renderQualificationDivergence(r)).toBe(read("benchmarks/qualification-divergence.md"));
  expect(renderQualificationDivergence(r)).toContain("不能证明后续71次摘要全部");
  expect(renderQualificationDivergence(r)).toContain("不是实际宿主轨迹");
});
