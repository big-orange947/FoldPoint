import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const r = JSON.parse(readFileSync("benchmarks/reports/pi-steady-ledger-20261020.json", "utf8"));
it("reconciles the published real-run bills and token-based decomposition without claiming superiority", () => {
  for (const arm of [r.baseline, r.candidate])
    expect(arm.totalCostUsd).toBeCloseTo(arm.ordinaryCostUsd + arm.summaryCostUsd, 12);
  const d = r.billDecompositionUsd;
  expect(d.netSaving).toBeCloseTo(d.cachedReadSaving - d.extraUncachedInput - d.extraOutput, 12);
  expect(d.netSaving).toBeCloseTo(r.baseline.totalCostUsd - r.candidate.totalCostUsd, 12);
  expect(r.candidate.vetoes + r.candidate.economicAllowed + r.candidate.safetyAllowed).toBe(
    r.candidate.candidateApplied,
  );
  expect(r.superiorityProven).toBe(false);
  expect(r.publicationReady).toBe(false);
  expect(r.candidate.unknownAfterSizes).toBe(r.candidate.successfulCompactions);
});
it("labels repricing as conditional path accounting and recomputes it from observed usage", () => {
  const s = r.priceSensitivity;
  const bill = (a: typeof r.baseline) =>
    ((a.allPromptTokens - a.allCachedReadTokens) * s.inputPerMillion +
      a.allCachedReadTokens * s.inputPerMillion * s.cacheReadInputRatio +
      a.allOutputTokens * s.outputPerMillion) /
    1e6;
  expect(s.baselineCostUsd).toBeCloseTo(bill(r.baseline), 12);
  expect(s.candidateCostUsd).toBeCloseTo(bill(r.candidate), 12);
  expect(s.basis).toContain("No policy rerun");
});
