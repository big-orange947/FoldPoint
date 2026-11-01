import { expect, it } from "vitest";
import type { TraceEvent } from "../src/index";
import { auditTraceWorkload } from "../tools/trace-workload-audit";

it("uses only matched within-session observations and resets across compaction and gaps", () => {
  const events = [
    { type: "decision", sessionId: "a", callId: "1", input: { contextTokens: 100 } },
    {
      type: "request",
      sessionId: "a",
      callId: "1",
      timestamp: 100,
      outcome: "ok",
      usage: { promptTokens: 80, cachedInputTokens: 40, cacheWriteTokens: 0 },
    },
    { type: "decision", sessionId: "a", callId: "2", input: { contextTokens: 130 } },
    {
      type: "request",
      sessionId: "a",
      callId: "2",
      timestamp: 200,
      outcome: "ok",
      usage: { promptTokens: 100, cachedInputTokens: 75, cacheWriteTokens: 0 },
    },
    { type: "compaction", sessionId: "a", success: true, beforeTokens: 130, afterTokens: null },
    { type: "decision", sessionId: "a", callId: "3", input: { contextTokens: 20 } },
    {
      type: "request",
      sessionId: "a",
      callId: "3",
      timestamp: 300,
      outcome: "ok",
      usage: { promptTokens: 20 },
    },
    {
      type: "request",
      sessionId: "a",
      callId: "missing",
      timestamp: 400,
      outcome: "ok",
      usage: { promptTokens: 30 },
    },
    { type: "decision", sessionId: "a", callId: "4", input: { contextTokens: 50 } },
    {
      type: "request",
      sessionId: "a",
      callId: "4",
      timestamp: 500,
      outcome: "ok",
      usage: { promptTokens: 50, cachedInputTokens: 0, cacheWriteTokens: 0 },
    },
  ] as unknown as TraceEvent[];
  expect(auditTraceWorkload(events)).toMatchObject({
    requests: 5,
    unpairedOrFailedRequests: 1,
    successfulSummaries: 1,
    missingAfter: 1,
    unpricedSummaries: 1,
    unknownCache: 2,
    contextGrowthPerObservedCall: { count: 1, median: 30 },
    callGapMs: { count: 1, median: 100 },
    cacheReadRatio: { count: 3, median: 0.5 },
    absoluteCacheRatioChange: { count: 1, median: 0.25 },
  });
});
