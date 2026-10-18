/** One-renewal execution commitment, research only; no text, I/O or provider access. */
import type { StrategyDecision } from "../benchmarks/fixed-threshold";
import type { createFoldPointStrategy } from "../benchmarks/simulator";
import { predictCompactorTokens, type RuntimeSurvivalEstimate } from "../src/index";

export type CommitmentSnapshot = Parameters<
  NonNullable<NonNullable<Parameters<typeof createFoldPointStrategy>[1]>["onSurvivalSnapshot"]>
>[0];

export class RenewalCommitment {
  private plan: {
    boundary: number;
    rootContext: number;
    phase: "pending-root" | "committed";
  } | null = null;
  private stats = {
    started: 0,
    released: 0,
    lockedRequests: 0,
    overrides: 0,
    gateBlocks: 0,
    failed: 0,
  };

  decide(
    s: CommitmentSnapshot,
    replanned: StrategyDecision,
    e: RuntimeSurvivalEstimate,
  ): StrategyDecision {
    if (!this.plan) {
      if (replanned.action === "COMPACT") {
        const boundary = e.commonContinuation?.repeatBoundaryTokens;
        if (
          !Number.isFinite(boundary) ||
          (boundary ?? 0) <= 0 ||
          (boundary ?? Infinity) > s.baseline.metrics.guardedForceBoundaryTokens
        )
          throw new Error("Missing executable common boundary");
        this.plan = {
          boundary: boundary as number,
          rootContext: s.input.contextTokens,
          phase: "pending-root",
        };
        this.stats.started++;
      }
      return replanned;
    }
    this.stats.lockedRequests++;
    let action: StrategyDecision["action"] = "KEEP";
    if (s.baseline.action === "FORCE") action = "FORCE";
    else {
      const { input, options, baseline } = s;
      const c = options.executionConstraints,
        model = options.compactorTokenModel;
      if (!c || !model) throw new Error("Missing execution constraints");
      const reclaim =
        input.contextTokens - predictCompactorTokens(model, input.contextTokens).afterTokens;
      const blocked =
        input.safeBoundary === false ||
        input.compactionAllowed === false ||
        input.runtimeStatus === "idle" ||
        (c.hasAttempt && baseline.metrics.callsSinceLastAttempt < c.minCallsBetweenCompactions) ||
        reclaim < c.minReclaimTokens ||
        reclaim / Math.max(input.contextTokens, 1) < c.minReclaimRatio ||
        input.contextTokens < c.softWindowTokens;
      if (blocked) this.stats.gateBlocks++;
      else if (
        input.contextTokens >=
        (this.plan.phase === "pending-root" ? this.plan.rootContext : this.plan.boundary)
      )
        action = "COMPACT";
    }
    if (action !== replanned.action) this.stats.overrides++;
    return {
      action,
      reasons:
        action === "FORCE" ? s.baseline.reasons : action === "COMPACT" ? ["ECONOMIC_TRIGGER"] : [],
      estimatedBreakEvenCalls: null,
    };
  }

  observe(success: boolean) {
    if (!this.plan) return;
    if (!success) {
      this.stats.failed++;
      return;
    }
    if (this.plan.phase === "pending-root") this.plan.phase = "committed";
    else {
      this.plan = null;
      this.stats.released++;
    }
  }

  snapshot() {
    return {
      plan: this.plan ? { ...this.plan } : null,
      stats: { ...this.stats },
      researchOnly: true as const,
    };
  }
}
