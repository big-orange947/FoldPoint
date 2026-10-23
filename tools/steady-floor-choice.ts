/** Opt-in v2 cycle objective; the caller retains the legacy affine risk envelope. */
import type { StrategyDecision } from "../benchmarks/fixed-threshold";
import { type RuntimeSurvivalEstimate, resolveUnitPrices } from "../src/index";
import type { CommitmentSnapshot } from "./renewal-commitment";
import { type RetainedFloor, retainedFloorCycles } from "./retained-floor";
import { chooseSteadyCycle } from "./steady-choice";

export function chooseSteadyFloorCycle(
  s: CommitmentSnapshot,
  e: RuntimeSurvivalEstimate,
  incumbent: StrategyDecision,
  retention: RetainedFloor,
) {
  const legacy = chooseSteadyCycle(s, e, incumbent);
  if (["safety", "warm-unsupported-fallback", "cycle-unsupported"].includes(legacy.reason))
    return legacy;
  const model = s.options.compactorTokenModel;
  const constraints = s.options.executionConstraints;
  if (!model || !constraints || !s.options.cycleBilling) return legacy;
  const rows = retainedFloorCycles(
    resolveUnitPrices(s.input.profile.pricing),
    model,
    retention,
    s.baseline.metrics.estimatedGrowthTokensPerCall,
    s.baseline.metrics.guardedForceBoundaryTokens,
    s.options.cycleBilling,
    Math.max(1, constraints.minCallsBetweenCompactions + 1),
  ).filter(
    (r) =>
      r.before >= constraints.softWindowTokens &&
      r.before - r.after >= constraints.minReclaimTokens &&
      (r.before - r.after) / r.before >= constraints.minReclaimRatio,
  );
  const selected = rows.reduce<(typeof rows)[number] | null>(
    (a, b) => (!a || b.costPerOrdinaryCall < a.costPerOrdinaryCall ? b : a),
    null,
  );
  const keep = { action: "KEEP" as const, estimatedBreakEvenCalls: null };
  if (!selected) return { decision: keep, reason: "no-cycle", selected, candidates: rows.length };
  if (
    !e.eligible ||
    !e.runtimeRiskAllowed ||
    e.assessedEndingLoss > e.immediateLossBudget ||
    e.probabilityOfUnmodeledTail > 0.05
  )
    return { decision: keep, reason: "execution-or-risk-gate", selected, candidates: rows.length };
  const reached = s.input.contextTokens >= selected.before;
  return {
    decision: {
      action: reached ? ("COMPACT" as const) : ("KEEP" as const),
      estimatedBreakEvenCalls: null,
    },
    reason: reached ? "cycle-boundary" : "below-cycle",
    selected,
    candidates: rows.length,
  };
}
