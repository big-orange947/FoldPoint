import { describe, expect, it } from "vitest";
import { FoldPoint, type FoldPointInput, TraceRecorder, validateTraceEvent } from "../src/index";

const input: FoldPointInput = {
  sessionId: "prefix-test",
  timestamp: 1001,
  contextTokens: 583_000,
  reusablePrefixTokens: 566_500,
  profile: {
    model: "test",
    compactorId: "test",
    contextWindowTokens: 1_000_000,
    pricing: { inputPerMillion: 1, outputPerMillion: 4, cacheReadPerMillion: 0.01 },
    cachePolicy: { ttlMs: 60_000 },
  },
};
function warmed() {
  const engine = new FoldPoint();
  engine.observeRequest(input.sessionId, input.profile, {
    timestamp: 1,
    promptTokens: 566_500,
    cachedInputTokens: 0,
    outputTokens: 300,
  });
  return engine;
}

describe("host-verified reusable prefix is not a provider cache hit", () => {
  it("prices a cold-start follow-up from the prefix just sent, not its old hit fraction", () => {
    const decision = warmed().decide(input);
    expect(decision.metrics.estimatedCurrentCallReplayCost).toBeCloseTo(0.022165, 12);
    expect(decision.metrics.estimatedCacheLaterCandidateTokens).toBe(583_000);
    const legacy = warmed().decide({ ...input, reusablePrefixTokens: undefined });
    expect(legacy.metrics.estimatedCurrentCallReplayCost).toBeCloseTo(0.583, 12);
  });
  it("does not bypass expiry, disabled caching or explicit provider feedback", () => {
    const expired = warmed().decide({ ...input, timestamp: 60_002 });
    expect(expired.metrics.estimatedCurrentCallReplayCost).toBeCloseTo(0.583, 12);
    expect(expired.metrics.estimatedCacheLaterCandidateTokens).toBe(583_000);
    const disabled = warmed().decide({
      ...input,
      profile: { ...input.profile, cachePolicy: { disabled: true } },
    });
    expect(disabled.metrics.estimatedCurrentCallReplayCost).toBeCloseTo(0.583, 12);
    expect(disabled.metrics.estimatedCacheLaterCandidateTokens).toBe(0);
    const actualMiss = warmed().decide({ ...input, cachedTokens: 0 });
    expect(actualMiss.metrics.estimatedCurrentCallReplayCost).toBeCloseTo(0.583, 12);
  });
  it("lets the host invalidate a rewritten prefix and keeps the estimate read-only", () => {
    const engine = warmed();
    const state = engine.exportState();
    const changed = engine.decide({ ...input, reusablePrefixTokens: 0 });
    expect(changed.metrics.estimatedCurrentCallReplayCost).toBeCloseTo(0.583, 12);
    expect(engine.exportState()).toEqual(state);
    for (const count of [-1, NaN, Infinity, 600_000])
      expect(() => engine.decide({ ...input, reusablePrefixTokens: count })).toThrow(RangeError);
  });
  it("round-trips the continuity hint separately from actual cached tokens", () => {
    const recorder = new TraceRecorder({ producer: "test" });
    const event = recorder.decision(input, warmed().decide(input));
    expect(event.input.reusablePrefixTokens).toBe(566_500);
    expect(event.input.cachedTokens).toBeUndefined();
    expect(validateTraceEvent(JSON.parse(JSON.stringify(event)))).toEqual(event);
    expect(() =>
      validateTraceEvent({ ...event, input: { ...event.input, reusablePrefixTokens: 600_000 } }),
    ).toThrow(RangeError);
  });
});
