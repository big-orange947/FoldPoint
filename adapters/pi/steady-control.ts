/** Explicit test-only threshold controller. No compaction calls or host mutation. */
import type { FoldPointDecision, FoldPointInput } from "../../src/index";
import type { PiSteadyLifecycleSnapshot } from "./steady-lifecycle";
import { evaluatePiSteadyShadow, type PiSteadyMetadata } from "./steady-shadow";

export function evaluatePiSteadyControl(
  input: FoldPointInput,
  baseline: FoldPointDecision,
  metadata: PiSteadyMetadata | undefined,
  lifecycle: PiSteadyLifecycleSnapshot,
) {
  // Pi also asks before agent_start. This is a NEW runtime, age zero, not the previous
  // runtime's final age. Never mutate the actual observer lifecycle or learn a fake call.
  const boundary = lifecycle.runtimeActive
    ? lifecycle
    : {
        ...lifecycle,
        runtimeActive: true,
        runtimeId: null,
        completedOrdinaryCalls: 0,
        runtimeUnknownOutcomeRequests: 0,
      };
  const prediction = evaluatePiSteadyShadow(input, baseline, metadata, boundary);
  const common = {
    runner: "foldpoint.pi-steady-control.v1" as const,
    candidateCommit: "86bde86",
    sessionId: input.sessionId,
    timestamp: input.timestamp,
    runtimeBoundary: lifecycle.runtimeActive ? "active" : "preflight",
    prediction,
  };
  if (prediction.status === "blocked")
    return {
      ...common,
      applied: false,
      resolution: "allow" as const,
      basis: "native-fallback" as const,
    };
  return {
    ...common,
    applied: true,
    resolution: prediction.action === "KEEP" ? ("veto" as const) : ("allow" as const),
    basis: prediction.status === "safety" ? ("safety" as const) : ("frozen-candidate" as const),
  };
}
