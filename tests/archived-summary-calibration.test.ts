import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { resolveUnitPrices, type TraceEvent } from "../src/index";
import {
  type ArchiveEntry,
  calibrateArchive,
  renderArchiveCalibration,
} from "../tools/archived-summary-calibration";

const prices = resolveUnitPrices({
  inputPerMillion: 2,
  outputPerMillion: 5,
  cacheReadPerMillion: 0.2,
});
const usage = (input: number, output = 10, cacheRead = 0) => ({
  input,
  output,
  cacheRead,
  cacheWrite: 0,
});
const traceUsage = (input: number, output = 10, cacheRead = 0) => ({
  promptTokens: input + cacheRead,
  outputTokens: output,
  cachedInputTokens: cacheRead,
  cacheWriteTokens: 0,
});
const entries: ArchiveEntry[] = [
  {
    type: "message",
    id: "a",
    parentId: null,
    message: { role: "assistant", stopReason: "stop", usage: usage(900) },
  },
  { type: "compaction", id: "b", parentId: "a", tokensBefore: 1000, usage: usage(950, 20) },
  { type: "message", id: "c", parentId: "b", message: { role: "user" } },
  {
    type: "message",
    id: "d",
    parentId: "c",
    message: { role: "assistant", stopReason: "stop", usage: usage(150) },
  },
  { type: "message", id: "e", parentId: "d", message: { role: "user" } },
  {
    type: "message",
    id: "f",
    parentId: "e",
    message: { role: "assistant", stopReason: "stop", usage: usage(50, 10, 150) },
  },
];
const events = [
  { type: "request", sessionId: "s", callId: "1", seq: 1, outcome: "ok", usage: traceUsage(900) },
  { type: "request", sessionId: "s", callId: "2", seq: 2, outcome: "ok", usage: traceUsage(150) },
  {
    type: "compaction",
    sessionId: "s",
    seq: 3,
    success: true,
    beforeTokens: 1000,
    usage: traceUsage(950, 20),
  },
  {
    type: "request",
    sessionId: "s",
    callId: "3",
    seq: 4,
    outcome: "ok",
    usage: traceUsage(50, 10, 150),
  },
  { type: "session_end", sessionId: "s", seq: 5 },
] as TraceEvent[];
const prior = { inputRate: 2e-6, output: 20, offset: 50 };
const estimate = (i: number) => (i === 1 ? 100 : 200);

it("locates the first replay in archive order despite a delayed trace compaction", () => {
  const called: number[] = [];
  const [r] = calibrateArchive(
    events,
    entries,
    (i) => {
      called.push(i);
      return estimate(i);
    },
    prices,
    prior,
  );
  expect(called).toEqual([1, 2]);
  expect(r?.firstReplayUsage.promptTokens).toBe(150);
  expect(r?.firstReplayUsage.cachedInputTokens).toBe(0);
  expect(r?.replayRecordedBeforeDeferredCompaction).toBe(true);
  expect(r?.firstReplayInputCost).toBeCloseTo(0.0003, 12);
  expect(r?.actualSummaryCost).toBeCloseTo(0.002, 12);
  expect(r?.estimates[0]?.firstReplayInputCostRelativeError).toBeCloseTo(0, 12);
  expect(r?.estimates[0]?.retentionOnlyConditionedInputCostRelativeError).toBeCloseTo(0, 12);
});

it("rejects unmatched, reordered, branched, duplicate or unpriced evidence", () => {
  const run = (es = events, archive = entries) =>
    calibrateArchive(es, archive, estimate, prices, prior);
  expect(() => run([events[1], events[0], ...events.slice(2)] as TraceEvent[])).toThrow();
  expect(() => run(events.slice(0, -1))).toThrow();
  expect(() =>
    run(events, [
      ...entries.slice(0, 3),
      { ...entries[3], parentId: "a" } as ArchiveEntry,
      ...entries.slice(4),
    ]),
  ).toThrow();
  expect(() =>
    run(
      events,
      entries.map((e, i) => (i === 1 ? { ...e, tokensBefore: 999 } : e)),
    ),
  ).toThrow();
  expect(() =>
    run(
      events,
      entries.map((e, i) =>
        i === 3 ? { ...e, message: { ...e.message, role: "assistant", usage: undefined } } : e,
      ),
    ),
  ).toThrow();
  expect(() => calibrateArchive(events, entries, () => NaN, prices, prior)).toThrow();
});

it("binds numeric report to code and preserves the distinction between coordinate and retention errors", () => {
  const r = JSON.parse(
    readFileSync("benchmarks/reports/archived-summary-calibration.json", "utf8"),
  ) as {
    paidCalls: number;
    sources: { calibrationHelper: string };
    rows: ReturnType<typeof calibrateArchive>;
  };
  expect(r.paidCalls).toBe(0);
  expect(r.rows).toHaveLength(3);
  expect(r.sources.calibrationHelper).toBe(
    createHash("sha256")
      .update(readFileSync("tools/archived-summary-calibration.ts", "utf8").replace(/\r\n/g, "\n"))
      .digest("hex"),
  );
  expect(r.rows.every((x) => x.replayRecordedBeforeDeferredCompaction)).toBe(true);
  expect(
    r.rows.every((x) =>
      x.estimates.every(
        (e) =>
          e.firstReplayInputCostRelativeError !== e.retentionOnlyConditionedInputCostRelativeError,
      ),
    ),
  ).toBe(true);
  expect(
    readFileSync("benchmarks/archived-summary-calibration.md", "utf8").replace(/\r\n/g, "\n"),
  ).toBe(renderArchiveCalibration(r));
});
