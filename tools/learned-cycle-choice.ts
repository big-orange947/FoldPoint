/** Research-only selector. No cold prior or extrapolation is allowed into cycle billing. */
import type { CompactorTokenModel } from "../src/experimental-compactor";
import { stableCycleCandidates } from "../src/experimental-cycle";
import type { UnitPrices } from "../src/pricing";
import type { PiImmediateRetentionLearner } from "./pi-retention-learner";

export interface LearnedCycleInput {
  contextTokens: number;
  growthTokens: number | undefined;
  prices: UnitPrices;
  billingModel: CompactorTokenModel;
  retention: ReturnType<PiImmediateRetentionLearner["snapshot"]>;
  expectedBasis: string;
  softBoundary: number;
  fallbackBoundary: number;
  forceBoundary: number;
}

export function chooseSupportedCycle(input: LearnedCycleInput) {
  const { contextTokens, softBoundary, fallbackBoundary, forceBoundary, retention } = input;
  if (
    ![contextTokens, softBoundary, fallbackBoundary, forceBoundary].every(
      (n) => Number.isFinite(n) && n >= 0,
    ) ||
    softBoundary > fallbackBoundary ||
    fallbackBoundary >= forceBoundary ||
    forceBoundary <= 0
  )
    throw new RangeError("invalid learned cycle boundaries");
  const fallback = (reason: string) => ({
    action: contextTokens >= fallbackBoundary ? ("COMPACT" as const) : ("KEEP" as const),
    boundary: fallbackBoundary,
    reason,
    usedLearnedModel: false,
    candidates: 0,
  });
  if (contextTokens >= forceBoundary)
    return {
      action: "FORCE" as const,
      boundary: forceBoundary,
      reason: "safety",
      usedLearnedModel: false,
      candidates: 0,
    };
  if (retention.basis !== input.expectedBasis) return fallback("incompatible-model");
  if (!retention.identifiable || !retention.model) return fallback("unidentified-retention");
  const model = retention.model;
  if (
    ![model.slope, model.floor, model.envelope].every((v) => Number.isFinite(v) && v >= 0) ||
    model.slope >= 1
  )
    return fallback("invalid-or-nonshrinking-model");
  const lower = retention.minBefore,
    upper = retention.maxBefore;
  if (lower === null || upper === null || fallbackBoundary < lower || fallbackBoundary > upper)
    return fallback("unsupported-fallback-comparator");
  if (contextTokens > upper) return fallback("current-size-outside-range");
  const growth = input.growthTokens;
  if (growth === undefined || !Number.isFinite(growth) || growth <= 0)
    return fallback("unknown-growth");
  const rows = stableCycleCandidates(
    input.prices,
    {
      ...input.billingModel,
      // NEVER use billingModel.after, which may still contain a cold 10% prior.
      after: { slope: model.slope, intercept: model.floor, residual: model.envelope },
    },
    growth,
    Math.min(forceBoundary, upper),
    {},
    4,
  ).filter((r) => r.before >= Math.max(softBoundary, lower) && r.after + model.envelope < r.before);
  const selected = rows.reduce<(typeof rows)[number] | null>(
    (a, b) => (!a || b.costPerOrdinaryCall < a.costPerOrdinaryCall ? b : a),
    null,
  );
  if (!selected) return fallback("no-supported-cycle");
  return {
    action: contextTokens >= selected.before ? ("COMPACT" as const) : ("KEEP" as const),
    boundary: selected.before,
    reason: "supported-cycle",
    usedLearnedModel: true,
    candidates: rows.length,
  };
}
