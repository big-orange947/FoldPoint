import { expect, it } from "vitest";
import type { TraceEvent } from "../src/index";
import { joinSettledActivities } from "../tools/settled-runtime-join";

const d = (seq: number, sessionId: string, callId: string, runtimeId: string) => ({
  type: "decision",
  seq,
  sessionId,
  callId,
  input: { runtimeId, runtimeStatus: "active" },
});
const q = (seq: number, sessionId: string, callId: string, runtimeId?: string, outcome = "ok") => ({
  type: "request",
  seq,
  sessionId,
  callId,
  runtimeId,
  outcome,
});
const end = (seq: number, sessionId: string, runtimeId: string) => ({
  type: "runtime_end",
  seq,
  sessionId,
  runtimeId,
});
const trace = (a: unknown[]) => a as TraceEvent[];
const activity = (sessionId: string, runtimeIds: string[]) => ({
  sessionId,
  runtimeIds,
  reportedOutcome: "completed" as const,
  settled: true as const,
});

it("joins explicit attempts and counts tagged requests without inventing a decision", () => {
  const r = joinSettledActivities(
    trace([
      d(1, "s", "c1", "r1"),
      q(2, "s", "c1"),
      end(3, "s", "r1"),
      q(4, "s", "c2", "r2"),
      end(5, "s", "r2"),
    ]),
    [activity("s", ["r1", "r2"])],
  );
  expect(r).toMatchObject({
    valid: 1,
    observedCompleted: 1,
    ordinaryCalls: 2,
    usableForCalibration: false,
    unassignedRequests: 0,
  });
  expect(JSON.stringify(r)).not.toContain('"r1"');
});
it("refuses missing ends, duplicate claims, cross-session matches, failed calls and unidentified requests", () => {
  const r = joinSettledActivities(
    trace([
      d(1, "s", "c", "r"),
      q(2, "s", "c", undefined, "error"),
      end(3, "s", "r"),
      q(4, "s", "unassigned"),
      end(5, "s2", "other"),
    ]),
    [
      activity("s", ["r"]),
      activity("s", ["r"]),
      activity("s", ["other"]),
      activity("s2", ["other"]),
    ],
  );
  expect(r).toMatchObject({
    valid: 1,
    incomplete: 1,
    conflicts: 2,
    unassignedRequests: 1,
    usableForCalibration: false,
  });
});

it("marks every participant ambiguous when the same call or runtime is claimed twice", () => {
  const dupCalls = joinSettledActivities(
    trace([
      d(1, "s", "c", "r1"),
      d(2, "s", "c", "r2"),
      q(3, "s", "c"),
      end(4, "s", "r1"),
      end(5, "s", "r2"),
    ]),
    [activity("s", ["r1"]), activity("s", ["r2"])],
  );
  expect(dupCalls).toMatchObject({ valid: 0, incomplete: 2 });
  const dupClaim = joinSettledActivities(trace([q(1, "s", "c", "r"), end(2, "s", "r")]), [
    activity("s", ["r"]),
    activity("s", ["r"]),
  ]);
  expect(dupClaim).toMatchObject({ valid: 0, conflicts: 2 });
});
it("does not convert interrupted or absent end records into completed activities", () => {
  const r = joinSettledActivities(
    trace([q(1, "s", "c", "r"), end(2, "s", "r"), q(3, "s", "d", "unfinished")]),
    [{ ...activity("s", ["r"]), reportedOutcome: "aborted" }, activity("s", ["unfinished"])],
  );
  expect(r).toMatchObject({ valid: 1, incomplete: 1, observedCompleted: 0, observedOther: 1 });
});
