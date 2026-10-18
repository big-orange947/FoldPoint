/** Metadata-only warm-cycle objective, research only. No future endpoint or grid reference. */
import type { StrategyDecision } from "../benchmarks/fixed-threshold";
import { stableCycleCandidates } from "../src/experimental-cycle";
import { type RuntimeSurvivalEstimate, resolveUnitPrices } from "../src/index";
import type { CommitmentSnapshot } from "./renewal-commitment";

export function chooseSteadyCycle(
  s: CommitmentSnapshot,
  e: RuntimeSurvivalEstimate,
  incumbent: StrategyDecision,
) {
  const keep = { action: "KEEP" as const, estimatedBreakEvenCalls: null };
  if (s.baseline.action === "FORCE")
    return {
      decision: { ...incumbent, action: "FORCE" as const },
      reason: "safety",
      selected: null,
      candidates: 0,
    };
  const prices = resolveUnitPrices(s.input.profile.pricing),
    m = s.baseline.metrics;
  if (!prices.hasCacheDiscount || m.estimatedCacheLaterAliveProbability !== 1)
    return {
      decision: incumbent,
      reason: "warm-unsupported-fallback",
      selected: null,
      candidates: 0,
    };
  const model = s.options.compactorTokenModel,
    c = s.options.executionConstraints;
  const growth = m.estimatedGrowthTokensPerCall;
  if (
    !model ||
    !c ||
    !s.options.cycleBilling ||
    !Number.isFinite(growth) ||
    growth <= 0 ||
    model.after.slope >= 1
  )
    return { decision: keep, reason: "cycle-unsupported", selected: null, candidates: 0 };
  const rows = stableCycleCandidates(
    prices,
    model,
    growth,
    m.guardedForceBoundaryTokens,
    s.options.cycleBilling,
    Math.max(1, c.minCallsBetweenCompactions + 1),
  ).filter(
    (row) =>
      row.before >= c.softWindowTokens &&
      row.before - row.after >= c.minReclaimTokens &&
      (row.before - row.after) / row.before >= c.minReclaimRatio,
  );
  const selected = rows.reduce<(typeof rows)[number] | null>(
    (best, row) => (!best || row.costPerOrdinaryCall < best.costPerOrdinaryCall ? row : best),
    null,
  );
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
      reasons: reached ? ["ECONOMIC_TRIGGER" as const] : [],
      estimatedBreakEvenCalls: null,
    },
    reason: reached ? "cycle-boundary" : "below-cycle",
    selected,
    candidates: rows.length,
  };
}
