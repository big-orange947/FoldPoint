import { createHash } from "node:crypto";
import { expect, it } from "vitest";
import type { TraceEvent } from "../src/index";
import { matchSummaryFeedback } from "../tools/match-summary-feedback";
import { summaryHistoryBinding } from "../tools/pi-steady-history";

it("matches only complete, ordered, profile-bound and usage-identical immediate feedback", () => {
  const profile = { provider: "test", model: "m", contextWindowTokens: 100000, compactorId: "c" };
  const binding = createHash("sha256").update(summaryHistoryBinding(profile)).digest("hex");
  const usage = { promptTokens: 90, cachedInputTokens: 0, cacheWriteTokens: 0, outputTokens: 4 };
  const events = [
    { type: "decision", sessionId: "s", profile },
    {
      type: "compaction",
      sessionId: "s",
      success: true,
      beforeTokens: 100,
      afterTokens: null,
      usage,
    },
  ] as unknown as TraceEvent[];
  const sample = {
    v: 1,
    source: "pi-compaction-result-estimatedTokensAfter",
    sequence: 1,
    stage: 2,
    binding,
    compactorBinding: "b".repeat(64),
    beforeTokens: 100,
    afterTokens: 20,
    estimatedOnly: true,
    canDrivePolicy: false,
    usage,
  };
  expect(matchSummaryFeedback(events, [sample])).toEqual([
    { sequence: 1, stage: 2, beforeTokens: 100, immediateAfterHostEstimate: 20, usage },
  ]);
  expect(() => matchSummaryFeedback(events, [])).toThrow();
  expect(() => matchSummaryFeedback(events, [{ ...sample, binding: "a".repeat(64) }])).toThrow();
  expect(() =>
    matchSummaryFeedback(events, [{ ...sample, usage: { ...usage, outputTokens: 5 } }]),
  ).toThrow();
  expect(() =>
    matchSummaryFeedback(
      [...events, ...events.slice(1)],
      [sample, { ...sample, sequence: 2, stage: 3 }],
    ),
  ).toThrow();
});
