import { expect, it } from "vitest";
import type { TraceEvent } from "../src/index";
import { summarizeRuntimeEvidence } from "../tools/runtime-evidence";

const decision = (seq: number, sessionId: string, callId: string, runtimeId: string) => ({
  type: "decision",
  seq,
  sessionId,
  callId,
  input: { runtimeId, runtimeStatus: "active" },
});
const request = (seq: number, sessionId: string, callId: string, outcome = "ok") => ({
  type: "request",
  seq,
  sessionId,
  callId,
  outcome,
});
const end = (seq: number, sessionId: string, runtimeId: string) => ({
  type: "runtime_end",
  seq,
  sessionId,
  runtimeId,
});
const events = (a: unknown[]) => a as TraceEvent[];

it("separates runtime endings, right censoring and unrelated summary/prewarm events", () => {
  const r = summarizeRuntimeEvidence(
    events([
      decision(1, "s", "a", "r1"),
      request(2, "s", "a"),
      { type: "cache_warm", seq: 3, sessionId: "s" },
      { type: "compaction", seq: 4, sessionId: "s" },
      decision(5, "s", "b", "r1"),
      request(6, "s", "b"),
      end(7, "s", "r1"),
      decision(8, "s", "c", "r2"),
      request(9, "s", "c"),
    ]),
  );
  expect(r).toMatchObject({
    eligibleObservedEnd: 1,
    eligibleCensored: 1,
    usableForCalibration: false,
  });
  expect(r.observations[0]).toMatchObject({
    calls: 1,
    continuing: 1,
    observedEnd: 0,
    censored: 1,
    observedContinuationFraction: 1,
  });
  expect(r.observations[1]).toMatchObject({ calls: 2, continuing: 0, observedEnd: 1, censored: 0 });
});
it("excludes failed, unmatched and out-of-order events instead of treating missing evidence as an ending", () => {
  const r = summarizeRuntimeEvidence(
    events([
      decision(1, "s", "a", "r1"),
      request(2, "s", "a", "error"),
      end(3, "s", "r1"),
      decision(4, "s", "b", "r2"),
      end(5, "s", "r2"),
      request(6, "s", "b"),
      decision(7, "s", "c", "r3"),
      request(8, "s", "unpaired"),
    ]),
  );
  expect(r).toMatchObject({
    eligibleObservedEnd: 0,
    eligibleCensored: 0,
    ambiguousRuntimes: 3,
    pendingDecisions: 1,
    unpairedRequests: 1,
    ambiguousRequests: 2,
  });
  expect(r.calibrationBlockers).toContain("ordinary requests without a paired runtime decision");
});
it("does not merge equal runtime or call labels belonging to different sessions", () => {
  const r = summarizeRuntimeEvidence(
    events([
      decision(1, "s1", "a", "r"),
      request(2, "s1", "a"),
      end(3, "s1", "r"),
      decision(1, "s2", "a", "r"),
      request(2, "s2", "a"),
      end(3, "s2", "r"),
    ]),
  );
  expect(r).toMatchObject({
    totalRuntimesWithDecisionOrEnd: 2,
    eligibleObservedEnd: 2,
    unpairedRequests: 0,
  });
  expect(JSON.stringify(r)).not.toContain('"s1"');
});

it("attributes an ordinary request without a decision only when its runtime identity is explicit", () => {
  const r = summarizeRuntimeEvidence(
    events([
      { ...request(1, "s", "unpaired"), runtimeId: "r" },
      end(2, "s", "r"),
      request(3, "s", "unknown"),
    ]),
  );
  expect(r).toMatchObject({
    eligibleObservedEnd: 1,
    unpairedRequests: 2,
    assignedWithoutDecision: 1,
    unassignedRequests: 1,
  });
  expect(r.observations[0]).toMatchObject({ calls: 1, observedEnd: 1 });
  expect(r.usableForCalibration).toBe(false); // runtime_end has no success/interruption status
});
it("rejects contradictory runtime identities and repeated orphan requests", () => {
  const r = summarizeRuntimeEvidence(
    events([
      decision(1, "s", "a", "r1"),
      { ...request(2, "s", "a"), runtimeId: "r2" },
      { ...request(3, "s", "b"), runtimeId: "r2" },
      { ...request(4, "s", "b"), runtimeId: "r2" },
    ]),
  );
  expect(r).toMatchObject({
    ambiguousRuntimes: 2,
    ambiguousRequests: 2,
    eligibleObservedEnd: 0,
    eligibleCensored: 0,
  });
});
