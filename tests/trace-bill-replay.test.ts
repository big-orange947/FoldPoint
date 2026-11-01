import { expect, it } from "vitest";
import type { TraceEvent } from "../src/index";
import { replayRecordedBill } from "../tools/trace-bill-replay";

it("replays each billable category and refuses missing, failed or duplicate usage", () => {
  const profile = {
    provider: "p",
    model: "m",
    contextWindowTokens: 1000,
    compactorId: "c",
    pricing: {
      currency: "USD",
      inputPerMillion: 2,
      outputPerMillion: 5,
      cacheReadPerMillion: 1,
      cacheWritePerMillion: 3,
    },
  };
  const usage = {
    promptTokens: 100,
    cachedInputTokens: 40,
    cacheWriteTokens: 10,
    outputTokens: 10,
  };
  const decision = { type: "decision", sessionId: "s", profile };
  const request = { type: "request", sessionId: "s", callId: "1", outcome: "ok", usage };
  const summary = { type: "compaction", sessionId: "s", success: true, usage };
  const warm = { type: "cache_warm", sessionId: "s", usage: { actualCost: 0.2 } };
  const end = { type: "session_end", sessionId: "s" };
  const toEvents = (rows: unknown[]) => rows as TraceEvent[];
  const result = replayRecordedBill(toEvents([decision, request, summary, warm, end]));
  expect(result).toMatchObject({
    ordinaryCalls: 1,
    summaries: 1,
    prewarms: 1,
    counterfactual: false,
  });
  expect(result.ordinaryCost).toBeCloseTo(0.00022);
  expect(result.summaryCost).toBeCloseTo(0.00022);
  expect(result.totalCost).toBeCloseTo(0.20044);
  expect(() => replayRecordedBill(toEvents([decision, request, request, end]))).toThrow();
  expect(() =>
    replayRecordedBill(
      toEvents([decision, { ...request, usage: { ...usage, cacheWriteTokens: undefined } }, end]),
    ),
  ).toThrow();
  expect(() =>
    replayRecordedBill(toEvents([decision, request, { ...summary, success: false }, end])),
  ).toThrow();
  expect(() => replayRecordedBill(toEvents([decision, request]))).toThrow();
});
