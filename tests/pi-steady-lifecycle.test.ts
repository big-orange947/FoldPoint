import { describe, expect, it } from "vitest";
import { PiSteadyLifecycle } from "../adapters/pi/steady-lifecycle";
import { TraceRecorder } from "../src/index";

function setup() {
  const life = new PiSteadyLifecycle(),
    trace = new TraceRecorder({ now: () => 1000 });
  life.startSession("s");
  life.startRuntime("r1");
  return { life, trace };
}

const usage = {
  timestamp: 1000,
  promptTokens: 10000,
  cachedInputTokens: 8000,
  cacheWriteTokens: 0,
  outputTokens: 10,
};

describe("Pi steady lifecycle metadata", () => {
  it("advances ordinary age only for successful ordinary requests, not warms, summaries, failures or vetoes", () => {
    const { life, trace } = setup();
    life.observe(trace.request("s", "c1", usage, { outcome: "ok" }));
    const warm = trace.cacheWarm("s", 1000, { ...usage, actualCost: 0.012 });
    life.observe(warm);
    life.observe(warm);
    life.observe(
      trace.compaction(
        "s",
        { ...usage, beforeTokens: 10000, afterTokens: 1000, success: true },
        { action: "COMPACT", afterTokensSource: "host-estimate" },
      ),
    );
    life.observe(
      trace.compaction(
        "s",
        { timestamp: 1000, beforeTokens: 10000, afterTokens: 10000, success: false },
        { action: "COMPACT", errorCode: "failed" },
      ),
    );
    life.observe(
      trace.compaction(
        "s",
        { timestamp: 1000, beforeTokens: 10000, afterTokens: 10000, success: false },
        { action: "COMPACT", errorCode: "vetoed" },
      ),
    );
    life.observe(trace.request("s", "c2", usage, { outcome: "error" }));
    expect(life.snapshot()).toMatchObject({
      completedOrdinaryCalls: 1,
      ordinaryRequests: 2,
      failedOrdinaryRequests: 1,
      summaryAttempts: 2,
      successfulSummaries: 1,
      failedSummaries: 1,
      vetoes: 1,
      summariesWithoutUsage: 1,
      cacheWarmCalls: 1,
      reportedCacheWarmCost: 0.012,
      estimatedAfterSizes: 1,
      exactRetentionSamples: 0,
      canDrivePolicy: false,
    });
  });

  it("counts unpaired ordinary requests but preserves unknown outcomes and missing usage", () => {
    const { life, trace } = setup();
    life.observe(trace.request("s", "unpaired-1", usage, { outcome: "ok" }));
    life.observe(trace.request("s", "unknown", usage));
    life.unknownRequest();
    expect(life.snapshot()).toMatchObject({
      completedOrdinaryCalls: 1,
      ordinaryRequests: 3,
      unknownOutcomeRequests: 2,
      runtimeUnknownOutcomeRequests: 2,
    });
  });

  it("resets runtime age, preserves session accounting, and isolates new sessions", () => {
    const { life, trace } = setup();
    life.observe(trace.request("s", "a", usage, { outcome: "ok" }));
    life.observe(trace.runtimeEnd("s", "r1", 1100));
    expect(life.snapshot().runtimeActive).toBe(false);
    life.startRuntime("r2");
    expect(life.snapshot()).toMatchObject({
      completedOrdinaryCalls: 0,
      ordinaryRequests: 1,
      runtimeActive: true,
    });
    life.observe(trace.request("s", "b", usage, { outcome: "ok" }));
    life.observe(trace.runtimeEnd("s", "r1", 1200));
    expect(life.snapshot().runtimeActive).toBe(true);
    life.observe(trace.sessionEnd("s", { timestamp: 1300 }));
    expect(life.snapshot()).toMatchObject({
      completedOrdinaryCalls: 1,
      ordinaryRequests: 2,
      runtimeActive: false,
    });
    life.startSession("s2");
    life.observe(trace.request("s", "old", usage, { outcome: "ok" }));
    expect(life.snapshot()).toMatchObject({
      sessionId: "s2",
      ordinaryRequests: 0,
      completedOrdinaryCalls: 0,
    });
  });
});
