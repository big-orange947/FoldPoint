/** Repo-local experimental bridge. Never returns an instruction to the Pi event runner. */
import {
  estimateRuntimeSurvival,
  type FoldPointDecision,
  type FoldPointInput,
  profileKey,
  type RuntimeSurvivalOptions,
} from "../../src/index";
import { chooseSteadyCycle } from "../../tools/steady-choice";

/** The host must supply compatible past observations, not fixture truth or a known endpoint. */
export interface PiSteadyMetadata {
  profileKey: string;
  compactorTokenModel: NonNullable<RuntimeSurvivalOptions["compactorTokenModel"]>;
  durationModel: NonNullable<RuntimeSurvivalOptions["durationModel"]>;
  executionConstraints: NonNullable<RuntimeSurvivalOptions["executionConstraints"]>;
  /** Explicit summary sharing / extra warm request contract. {} means neither is declared. */
  cycleBilling: NonNullable<RuntimeSurvivalOptions["cycleBilling"]>;
}

export interface PiSteadyShadowOptions {
  /** Separate JSONL file. Must not be the ordinary FoldPoint trace. */
  path: string;
  /** Omit/return undefined when compatible observations or billing semantics are unknown. */
  getMetadata?: (input: Readonly<FoldPointInput>) => PiSteadyMetadata | undefined;
}

export function evaluatePiSteadyShadow(
  input: FoldPointInput,
  baseline: FoldPointDecision,
  metadata: PiSteadyMetadata | undefined,
) {
  const common = {
    runner: "foldpoint.pi-steady-shadow.v1" as const,
    candidateCommit: "86bde86",
    applied: false as const,
    estimatedOnly: true as const,
    sessionId: input.sessionId,
    timestamp: input.timestamp,
    baselineAction: baseline.action,
  };
  // FORCE is never weakened, even when economic observations are unavailable.
  if (baseline.action === "FORCE")
    return { ...common, status: "safety" as const, action: "FORCE" as const };
  if (!metadata)
    return { ...common, status: "blocked" as const, reason: "missing-host-metadata" as const };
  if (metadata.profileKey !== profileKey(input.profile))
    return { ...common, status: "blocked" as const, reason: "incompatible-profile" as const };
  if (input.reusablePrefixTokens === undefined)
    return { ...common, status: "blocked" as const, reason: "unknown-prefix-continuity" as const };

  // Frozen risk settings; dynamic values come only from the host's compatible past metadata.
  // Do not import the simulator, its synthetic feedback, or its endpoint into this bridge.
  const options: RuntimeSurvivalOptions = {
    compactorTokenModel: {
      after: {
        slope: metadata.compactorTokenModel.after.slope,
        intercept: metadata.compactorTokenModel.after.intercept,
        residual: metadata.compactorTokenModel.after.residual,
      },
      output: {
        slope: metadata.compactorTokenModel.output.slope,
        intercept: metadata.compactorTokenModel.output.intercept,
        residual: metadata.compactorTokenModel.output.residual,
      },
      samples: metadata.compactorTokenModel.samples,
      minBefore: metadata.compactorTokenModel.minBefore,
      maxBefore: metadata.compactorTokenModel.maxBefore,
      summaryInputCostPerToken: metadata.compactorTokenModel.summaryInputCostPerToken,
    },
    durationModel: {
      completedCalls: metadata.durationModel.completedCalls,
      components: metadata.durationModel.components.map((c) => ({
        weight: c.weight,
        continuationProbability: c.continuationProbability,
      })),
    },
    executionConstraints: {
      hasAttempt: metadata.executionConstraints.hasAttempt,
      minCallsBetweenCompactions: metadata.executionConstraints.minCallsBetweenCompactions,
      minReclaimTokens: metadata.executionConstraints.minReclaimTokens,
      minReclaimRatio: metadata.executionConstraints.minReclaimRatio,
      softWindowTokens: metadata.executionConstraints.softWindowTokens,
    },
    cycleBilling: {
      ...(metadata.cycleBilling.summarySharedPrefixRatio === undefined
        ? {}
        : { summarySharedPrefixRatio: metadata.cycleBilling.summarySharedPrefixRatio }),
      ...(metadata.cycleBilling.prewarmOutputTokens === undefined
        ? {}
        : { prewarmOutputTokens: metadata.cycleBilling.prewarmOutputTokens }),
    },
    continuationProbability: 0.95,
    maxImmediateLossRatio: 1,
    maxCalls: 256,
    rolloutMode: "renewal",
    endingRiskMode: "survival-weighted",
    endingLossBudgetRatio: 1,
    savingMarginBasis: "timing",
    stressWaitSelection: "paired-policy",
    futureQualification: { maxChecksPerPath: 2 },
  };
  const snapshot = { input: structuredClone(input), baseline: structuredClone(baseline), options };
  const estimate = estimateRuntimeSurvival(snapshot.input, snapshot.baseline, options);
  const incumbent = {
    action: estimate.shouldCompact ? ("COMPACT" as const) : ("KEEP" as const),
    estimatedBreakEvenCalls: null,
  };
  const choice = chooseSteadyCycle(snapshot, estimate, incumbent);
  return {
    ...common,
    status: "evaluated" as const,
    action: choice.decision.action,
    reason: choice.reason,
    selected: choice.selected,
    candidates: choice.candidates,
    snapshot,
    estimate,
  };
}
