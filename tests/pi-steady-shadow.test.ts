import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PiSteadyLifecycle } from "../adapters/pi/steady-lifecycle";
import { evaluatePiSteadyShadow, type PiSteadyMetadata } from "../adapters/pi/steady-shadow";
import { estimateRuntimeSurvival, FoldPoint, type FoldPointInput, profileKey } from "../src/index";
import { chooseSteadyCycle } from "../tools/steady-choice";

function fixture() {
  const input: FoldPointInput = {
    sessionId: "pi-test",
    timestamp: 1000,
    runtimeStatus: "active",
    contextTokens: 200_000,
    reusablePrefixTokens: 180_000,
    safeBoundary: true,
    compactionAllowed: true,
    idleMs: 1000,
    profile: {
      model: "arbitrary-model",
      contextWindowTokens: 1_000_000,
      compactorId: "pi-compaction",
      pricing: { inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3 },
      cachePolicy: { ttlMs: 300_000 },
    },
  };
  const engine = new FoldPoint({ defaults: { compactOutputRatio: 0.002 } });
  engine.observeRequest(input.sessionId, input.profile, {
    timestamp: 0,
    promptTokens: 180_000,
    cachedInputTokens: 160_000,
    outputTokens: 100,
  });
  engine.observeRequest(input.sessionId, input.profile, {
    timestamp: 500,
    promptTokens: 200_000,
    cachedInputTokens: 180_000,
    outputTokens: 100,
  });
  const metadata: PiSteadyMetadata = {
    profileKey: profileKey(input.profile),
    compactorTokenModel: {
      after: { slope: 0.1, intercept: 10000, residual: 0 },
      output: { slope: 0.002, intercept: 1000, residual: 0 },
      samples: 3,
      minBefore: 100000,
      maxBefore: 400000,
      summaryInputCostPerToken: 3e-6,
    },
    durationModel: {
      completedCalls: 12,
      components: [
        { weight: 0.8, continuationProbability: 0.8 },
        { weight: 0.2, continuationProbability: 0.98 },
      ],
    },
    executionConstraints: {
      hasAttempt: false,
      minCallsBetweenCompactions: 3,
      minReclaimTokens: 4096,
      minReclaimRatio: 0.2,
      softWindowTokens: 0,
    },
    cycleBilling: {},
  };
  return { input, baseline: engine.decide(input), metadata };
}

describe("Pi steady shadow bridge", () => {
  it("uses the opt-in floor cycle with an explicitly labeled conservative affine risk envelope", () => {
    const f = fixture();
    const result = evaluatePiSteadyShadow(f.input, f.baseline, {
      ...f.metadata,
      cycleRetention: { totalRatio: 0.1, recentBudgetTokens: 20000 },
    });
    expect(result).toMatchObject({
      candidateCommit: null,
      variant: "total-floor-v2-affine-risk",
      status: "evaluated",
    });
    if (result.status !== "evaluated" || !result.selected) throw new Error("missing v2 cycle");
    expect(result.selected.after).toBeCloseTo(Math.max(result.selected.before * 0.1, 20000), 7);
    expect(result.snapshot.options.compactorTokenModel?.after).toEqual({
      slope: 0.1,
      intercept: 20000,
      residual: 0,
    });
    expect(result.riskModel).toBe("legacy-affine-upper-envelope");
    expect(() =>
      evaluatePiSteadyShadow(f.input, f.baseline, {
        ...f.metadata,
        cycleRetention: { totalRatio: 1, recentBudgetTokens: 20000 },
      }),
    ).toThrow();
  });
  it("rejects stale runtime ages and unknown runtime outcomes instead of trusting host estimates", () => {
    const f = fixture(),
      life = new PiSteadyLifecycle();
    life.startSession(f.input.sessionId);
    life.startRuntime("r1");
    expect(evaluatePiSteadyShadow(f.input, f.baseline, f.metadata, life.snapshot())).toMatchObject({
      status: "blocked",
      reason: "runtime-lifecycle-mismatch",
    });
    f.metadata.durationModel.completedCalls = 0;
    expect(evaluatePiSteadyShadow(f.input, f.baseline, f.metadata, life.snapshot()).status).toBe(
      "evaluated",
    );
    life.unknownRequest();
    expect(evaluatePiSteadyShadow(f.input, f.baseline, f.metadata, life.snapshot())).toMatchObject({
      status: "blocked",
      reason: "runtime-lifecycle-mismatch",
    });
  });
  it("reuses the frozen selector and risk calculation without changing caller state", () => {
    const f = fixture(),
      before = structuredClone(f);
    const result = evaluatePiSteadyShadow(f.input, f.baseline, f.metadata);
    expect(result.status).toBe("evaluated");
    if (result.status !== "evaluated") throw new Error("Missing shadow prediction");
    const estimate = estimateRuntimeSurvival(f.input, f.baseline, result.snapshot.options);
    const frozen = chooseSteadyCycle(result.snapshot, estimate, {
      action: estimate.shouldCompact ? "COMPACT" : "KEEP",
      estimatedBreakEvenCalls: null,
    });
    expect(result.action).toBe(frozen.decision.action);
    expect(result.selected).toEqual(frozen.selected);
    expect(result.reason).toBe(frozen.reason);
    expect(result.applied).toBe(false);
    expect(result.estimatedOnly).toBe(true);
    expect(f).toEqual(before);
  });

  it("blocks unknown metadata, changed profile and unproven request continuity", () => {
    const f = fixture();
    expect(evaluatePiSteadyShadow(f.input, f.baseline, undefined)).toMatchObject({
      status: "blocked",
      reason: "missing-host-metadata",
    });
    expect(
      evaluatePiSteadyShadow(f.input, f.baseline, { ...f.metadata, profileKey: "other" }),
    ).toMatchObject({ status: "blocked", reason: "incompatible-profile" });
    delete f.input.reusablePrefixTokens;
    expect(evaluatePiSteadyShadow(f.input, f.baseline, f.metadata)).toMatchObject({
      status: "blocked",
      reason: "unknown-prefix-continuity",
    });
  });

  it("preserves safety FORCE even without any economic metadata", () => {
    const f = fixture();
    expect(
      evaluatePiSteadyShadow(f.input, { ...f.baseline, action: "FORCE" }, undefined),
    ).toMatchObject({ status: "safety", action: "FORCE", applied: false });
  });

  it("keeps explicit summary sharing and paid prewarm separate, whitelisting metadata", () => {
    const f = fixture();
    Object.assign(f.metadata, { prompt: "private-text-must-not-leak" });
    Object.assign(f.metadata.compactorTokenModel.after, { secret: "private-text-must-not-leak" });
    f.metadata.cycleBilling = { summarySharedPrefixRatio: 0.8, prewarmOutputTokens: 1 };
    const result = evaluatePiSteadyShadow(f.input, f.baseline, f.metadata);
    expect(result.status).toBe("evaluated");
    if (result.status !== "evaluated") throw new Error("Missing prediction");
    expect(result.snapshot.options.cycleBilling).toEqual(f.metadata.cycleBilling);
    expect(result.snapshot.options.durationModel?.completedCalls).toBe(12);
    expect(JSON.stringify(result)).not.toContain("private-text-must-not-leak");
  });

  it("has no simulator, synthetic feedback, report reading or network dependency at runtime", () => {
    const code = readFileSync("adapters/pi/steady-shadow.ts", "utf8");
    expect(code).not.toMatch(/from ["'].*benchmarks\//);
    expect(code).not.toContain("hostFeedback");
    expect(code).not.toContain("readFileSync");
    expect(code).not.toContain("fetch(");
  });
});
