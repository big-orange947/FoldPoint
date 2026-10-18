import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { estimateRuntimeSurvival } from "../src/index";
import { affineCostCases, costLedger } from "../tools/affine-cost";
import { sourceHash } from "../tools/affine-holdout";
import type { runForecastAudit } from "../tools/forecast-execution-audit";
import {
  captureBudgetBranch,
  renderBudgetFallback,
  type runBudgetFallback,
} from "../tools/qualification-fallback";
import { estimateRuntimeSurvival as safetyEstimate } from "../tools/qualification-safety-runtime";
import { createOutputCostStrategy } from "../tools/summary-output-cost";

const text = (path: string) => readFileSync(path, "utf8").replace(/\r\n/g, "\n");
const audit = JSON.parse(text("benchmarks/reports/forecast-execution-audit.json")) as ReturnType<
  typeof runForecastAudit
>;
const report = () =>
  JSON.parse(text("benchmarks/reports/qualification-fallback.json")) as ReturnType<
    typeof runBudgetFallback
  >;

it("derives the research runtime with only imports, annotation and the exhaustion boolean changed", () => {
  const original = text("src/experimental-runtime.ts").trimEnd();
  const needle = "decisions.set(state.call, true);\n          return true;";
  expect(original.split(needle)).toHaveLength(2);
  const derived =
    "/** Research-only frozen derivative. See qualification-fallback-plan.json. Not exported by SDK. */\n" +
    original
      .replaceAll('from "./', 'from "../src/')
      .replace(needle, "decisions.set(state.call, false);\n          return false;");
  expect(text("tools/qualification-safety-runtime.ts").trimEnd()).toBe(derived);
});

it("reproduces the incumbent exactly when qualification is disabled and never mutates snapshots", () => {
  for (const row of audit.rows) {
    if (!row.checkpoint) continue;
    for (const arm of [row.checkpoint.legacy, row.checkpoint.candidate]) {
      const s = structuredClone(arm.snapshot),
        before = JSON.stringify(s);
      const opts = { ...s.options, futureQualification: undefined, explainBills: true };
      expect(safetyEstimate(s.input, s.baseline, opts)).toEqual(
        estimateRuntimeSurvival(s.input, s.baseline, opts),
      );
      safetyEstimate(s.input, s.baseline, { ...s.options, explainBills: true });
      expect(JSON.stringify(s)).toBe(before);
    }
  }
});

it("allows only screened approvals or safety compactions on both explained paths", () => {
  let approvals = 0,
    exhausted = 0,
    forces = 0;
  for (const row of audit.rows) {
    if (!row.checkpoint) continue;
    // Also test a cheap-summary contract: approvals must not disappear merely because
    // exhausted later attempts are rejected. This is a unit fixture, not a matrix cell.
    const arms = [row.checkpoint.legacy, row.checkpoint.candidate];
    const cheap = structuredClone(arms);
    for (const arm of cheap) {
      if (!arm.snapshot.options.compactorTokenModel) throw new Error("Missing model");
      arm.snapshot.options.compactorTokenModel.summaryInputCostPerToken = 3e-8;
    }
    for (const arm of [...arms, ...cheap]) {
      const s = arm.snapshot;
      const r = safetyEstimate(s.input, s.baseline, { ...s.options, explainBills: true });
      if (!r.futureQualification || !r.forecastBills) throw new Error("Missing bounded forecast");
      for (const name of ["now", "wait"] as const) {
        const q = r.futureQualification[name];
        expect(q.checks.length).toBeLessThanOrEqual(2);
        exhausted += q.unassessedAttempts;
        const fallback =
          name === "now"
            ? r.futureQualification.nowSafetyFallback
            : r.futureQualification.waitSafetyFallback;
        for (const step of r.forecastBills[name].steps) {
          if (!step.compact || step.call === 0) continue;
          if (step.beforeTokens >= s.baseline.metrics.guardedForceBoundaryTokens) {
            forces++;
            continue;
          }
          expect(fallback).toBe(false);
          const approved = q.checks.find((c) => c.call === step.call);
          expect(approved?.allowed).toBe(true);
          approvals++;
        }
        for (const check of q.checks) {
          const step = r.forecastBills[name].steps[check.call];
          if (!fallback && check.allowed) expect(step?.compact).toBe(true);
        }
      }
    }
  }
  expect(exhausted).toBeGreaterThan(0);
  expect(forces).toBeGreaterThan(0);
  expect(approvals).toBeGreaterThan(0);
});

it("keeps present safety and unsafe-boundary execution gates", () => {
  const s = audit.rows.find((r) => r.role === "worst")?.checkpoint?.candidate.snapshot;
  if (!s) throw new Error("Missing snapshot");
  const force = { ...s.baseline, action: "FORCE" as const };
  expect(safetyEstimate(s.input, force, s.options).shouldCompact).toBe(false);
  for (const input of [
    { ...s.input, safeBoundary: false },
    { ...s.input, compactionAllowed: false },
    { ...s.input, runtimeStatus: "idle" as const },
  ])
    expect(safetyEstimate(input, s.baseline, s.options).shouldCompact).toBe(false);
});

it("reproduces the wrapper baseline and cold-start decisions without hidden future task length", () => {
  const c = affineCostCases().find((c) => c.suite === "short");
  if (!c) throw new Error("Missing short case");
  const captured = captureBudgetBranch(c.scenario, false);
  expect(captured.bill).toEqual(
    costLedger(c.scenario, createOutputCostStrategy(c.scenario, false).strategy),
  );
  expect(captured.snapshots[0]?.options.durationModel?.completedCalls).toBe(0);
});

it("preserves all control bills, full fees and negative results in the checked-in report", () => {
  const r = report();
  expect(r.rows).toHaveLength(24);
  expect(r.paidCalls).toBe(0);
  expect(r.rows.every((v) => v.baselineMatches)).toBe(true);
  const frozen = JSON.parse(text("benchmarks/reports/affine-cost.json"));
  for (const row of r.rows) {
    const old = frozen.rows.find(
      (v: { profile: string; fixture: string; suite: string; steps: number }) =>
        v.profile === row.profile &&
        v.fixture === row.fixture &&
        v.suite === row.suite &&
        v.steps === row.steps,
    );
    expect(row.arms.incumbent).toEqual(old?.arms.uncertainAffine);
    expect(row.arms.fixed60).toEqual(old?.arms.fixed60);
    expect(new Set(Object.values(row.arms).map((a) => a.fingerprint)).size).toBe(1);
    for (const arm of Object.values(row.arms)) {
      expect(arm.cost).toBeCloseTo(arm.ordinary + arm.summary + arm.prewarm, 9);
      expect(arm.overflow).toBe(0);
      expect(arm.inputWithinWindow).toBe(true);
    }
  }
  for (const group of r.groups) {
    const cells = r.rows.filter((v) => `${v.profile}/${v.suite}` === group.key);
    expect(group.cases).toBe(cells.length);
    expect(group.meanVsIncumbent).toBeCloseTo(
      cells.reduce((sum, v) => sum + v.arms.budgetSafety.cost / v.arms.incumbent.cost - 1, 0) /
        cells.length,
      12,
    );
  }
  expect(renderBudgetFallback(r)).toBe(text("benchmarks/qualification-fallback.md"));
  expect(r.planHash).toBe(sourceHash(text("benchmarks/qualification-fallback-plan.json")));
  for (const [p, h] of Object.entries(r.sourceHashes)) expect(sourceHash(text(p))).toBe(h);
});
