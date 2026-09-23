import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  decideFoldPoint,
  FOLDPOINT_VERSION,
  type FoldPointProfile,
  parseTraceJsonl,
  TRACE_FORMAT_VERSION,
  type TraceEvent,
  TraceRecorder,
  validateTraceEvent,
} from "../src/index";
import {
  analyzeTraceEvents,
  isHoldoutSession,
  main,
  renderTraceReport,
} from "../tools/trace-analyze";
import {
  BASE_TIMESTAMP,
  HISTORY,
  makeInput,
  makeLearning,
  makeProfile,
  makeSession,
  profileWithCacheTtl,
  SESSION_HISTORY,
} from "./helpers";

const PACKAGE_JSON = JSON.parse(
  readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
) as { version: string };

function recorder(): TraceRecorder {
  return new TraceRecorder({ producer: "test-host", now: () => 0 });
}

describe("trace format", () => {
  it("is versioned, and the library version matches package.json", () => {
    expect(TRACE_FORMAT_VERSION).toBe(1);
    expect(FOLDPOINT_VERSION).toBe(PACKAGE_JSON.version);
  });

  it("records the resolved defaults in the header", () => {
    const header = recorder().header();

    expect(header.v).toBe(TRACE_FORMAT_VERSION);
    expect(header.type).toBe("header");
    expect(header.seq).toBe(0);
    expect(header.library).toEqual({ name: "foldpoint", version: FOLDPOINT_VERSION });
    expect(header.producer).toBe("test-host");
    expect(header.defaults.expectedFutureCalls).toBeGreaterThan(0);
    expect(header.defaults.softWindowBreakEvenCalls).toBeGreaterThan(0);
  });

  it("keeps the decision-time estimate apart from the post-request actual", () => {
    const trace = recorder();
    const profile = profileWithCacheTtl(60_000);
    const input = makeInput({ profile, contextTokens: 100_000, cachedTokens: 80_000, idleMs: 0 });
    const decision = decideFoldPoint(input, makeLearning(HISTORY), makeSession(SESSION_HISTORY));

    const decisionEvent = trace.decision(input, decision, { callId: "call-1" });
    expect(decisionEvent.type).toBe("decision");
    expect(decisionEvent.callId).toBe("call-1");
    expect(decisionEvent.prediction.estimatedCurrentCallReplayCost).toBeCloseTo(0.084, 12);
    expect(decisionEvent.prediction.estimatedCacheAliveProbability).toBe(1);
    // Nothing about the real usage can be known before the call returns.
    expect("usage" in decisionEvent).toBe(false);
    expect(decisionEvent.decision.action).toBe("KEEP");

    const requestEvent = trace.request("session-a", decisionEvent.callId, {
      timestamp: BASE_TIMESTAMP,
      promptTokens: 100_000,
      cachedInputTokens: 80_000,
      cacheWriteTokens: 0,
      outputTokens: 500,
    });
    expect(requestEvent.type).toBe("request");
    expect(requestEvent.callId).toBe("call-1");
    expect(requestEvent.usage.promptTokens).toBe(100_000);
    expect("prediction" in requestEvent).toBe(false);
  });

  it("generates a callId when the host does not supply one", () => {
    const trace = recorder();
    const input = makeInput({ contextTokens: 10_000 });
    const decision = decideFoldPoint(input, makeLearning(), makeSession());

    const first = trace.decision(input, decision);
    const second = trace.decision(input, decision);

    expect(first.callId).not.toBe(second.callId);
    expect(first.callId.startsWith("session-a#")).toBe(true);
  });

  it("records compactions and session ends", () => {
    const trace = recorder();
    const compaction = trace.compaction(
      "session-a",
      {
        timestamp: BASE_TIMESTAMP,
        beforeTokens: 100_000,
        afterTokens: 30_000,
        promptTokens: 100_000,
        outputTokens: 10_000,
        actualCost: 0.45,
        success: true,
      },
      { action: "COMPACT", callId: "call-1" },
    );

    expect(compaction.beforeTokens).toBe(100_000);
    expect(compaction.afterTokens).toBe(30_000);
    expect(compaction.usage?.actualCost).toBe(0.45);
    expect(compaction.callId).toBe("call-1");

    const end = trace.sessionEnd(
      "session-a",
      { timestamp: BASE_TIMESTAMP + 1_000 },
      {
        reason: "completed",
      },
    );
    expect(end.reason).toBe("completed");
  });

  it("round-trips through JSONL and reports unreadable lines", () => {
    const trace = recorder();
    const input = makeInput({ contextTokens: 10_000 });
    const decision = decideFoldPoint(input, makeLearning(), makeSession());
    const events: TraceEvent[] = [
      trace.header(),
      trace.decision(input, decision),
      trace.sessionEnd("session-a", { timestamp: BASE_TIMESTAMP }),
    ];

    const jsonl = `${events.map((event) => JSON.stringify(event)).join("\n")}\n\n{"type":"nope"}\n`;
    const parsed = parseTraceJsonl(jsonl);

    expect(parsed.events).toHaveLength(3);
    expect(parsed.events[0]?.type).toBe("header");
    expect(parsed.errors).toHaveLength(1);
    expect(parsed.errors[0]?.line).toBe(5);
    expect(parsed.errors[0]?.message).toContain("supported");
  });

  it("rejects a label that looks like content", () => {
    const trace = recorder();
    const input = makeInput({ contextTokens: 10_000 });
    const decision = decideFoldPoint(input, makeLearning(), makeSession());

    // A session id, a call id or a reason is an identifier, never a sentence.
    expect(() => new TraceRecorder({ producer: "my agent, please summarize the file" })).toThrow(
      RangeError,
    );
    expect(() =>
      trace.request("session with spaces", "call-1", {
        timestamp: BASE_TIMESTAMP,
        promptTokens: 1,
      }),
    ).toThrow(RangeError);
    expect(() =>
      trace.sessionEnd(
        "session-a",
        { timestamp: BASE_TIMESTAMP },
        {
          reason: "user asked: why is the build failing?",
        },
      ),
    ).toThrow(RangeError);
    expect(() =>
      validateTraceEvent({
        ...trace.decision(input, decision, { callId: "ok-1" }),
        sessionId: "line\nbreak",
      }),
    ).toThrow(RangeError);
    expect(() => new TraceRecorder({ producer: "x".repeat(200) })).toThrow(RangeError);
  });

  it("rejects malformed events instead of repairing them", () => {
    const trace = recorder();
    const input = makeInput({ contextTokens: 10_000 });
    const decision = decideFoldPoint(input, makeLearning(), makeSession());
    const event = trace.decision(input, decision);

    expect(() => validateTraceEvent({ ...event, v: 99 })).toThrow(RangeError);
    expect(() => validateTraceEvent({ ...event, type: "unknown" })).toThrow(RangeError);
    expect(() => validateTraceEvent({ ...event, callId: "" })).toThrow(RangeError);
    expect(() =>
      validateTraceEvent({
        ...trace.request("session-a", "call-1", { timestamp: BASE_TIMESTAMP, promptTokens: -1 }),
      }),
    ).toThrow(RangeError);
    expect(() =>
      validateTraceEvent({
        ...trace.compaction("session-a", {
          timestamp: BASE_TIMESTAMP,
          beforeTokens: 1,
          afterTokens: 1,
          success: true,
        }),
        success: "yes",
      }),
    ).toThrow(RangeError);
  });
});

describe("trace analysis", () => {
  /** Two sessions: one with a live cache, one where the cache never holds. */
  function buildTrace() {
    const trace = recorder();
    const events: TraceEvent[] = [trace.header()];

    // Warm session: the cache is alive and serves 80k of a 100k prompt on both calls.
    const warmProfile = profileWithCacheTtl(60_000);
    const warmInput = makeInput({
      sessionId: "warm",
      profile: warmProfile,
      contextTokens: 100_000,
      cachedTokens: 80_000,
      idleMs: 0,
      expectedFutureCalls: 2,
    });
    const warmDecision = decideFoldPoint(
      warmInput,
      makeLearning(HISTORY),
      makeSession(SESSION_HISTORY),
    );
    const warmEvent = trace.decision(warmInput, warmDecision, { callId: "warm-1" });
    events.push(warmEvent);
    events.push(
      trace.request("warm", "warm-1", {
        timestamp: BASE_TIMESTAMP,
        promptTokens: 100_000,
        cachedInputTokens: 80_000,
        cacheWriteTokens: 0,
        outputTokens: 500,
      }),
    );

    // Second warm call: the model predicts the same 0.084, but the provider served 60k
    // instead of 80k, so the actual cost is 0.018 + 0.12 = 0.138.
    const warmInput2 = makeInput({
      sessionId: "warm",
      profile: warmProfile,
      contextTokens: 100_000,
      cachedTokens: 80_000,
      idleMs: 0,
      expectedFutureCalls: 1,
    });
    const warmDecision2 = decideFoldPoint(
      warmInput2,
      makeLearning(HISTORY),
      makeSession(SESSION_HISTORY),
    );
    const warmEvent2 = trace.decision(warmInput2, warmDecision2, { callId: "warm-2" });
    events.push(warmEvent2);
    events.push(
      trace.request("warm", "warm-2", {
        timestamp: BASE_TIMESTAMP + 1_000,
        promptTokens: 100_000,
        cachedInputTokens: 60_000,
        cacheWriteTokens: 0,
        outputTokens: 500,
      }),
    );
    events.push(trace.sessionEnd("warm", { timestamp: BASE_TIMESTAMP + 2_000 }));

    // Cold session: the TTL has lapsed, so nothing is served and the model must say so.
    const coldProfile = profileWithCacheTtl(1_000);
    const coldInput = makeInput({
      sessionId: "cold",
      profile: coldProfile,
      contextTokens: 100_000,
      cachedTokens: 0,
      idleMs: 600_000,
      expectedFutureCalls: 1,
    });
    const coldDecision = decideFoldPoint(
      coldInput,
      makeLearning(HISTORY),
      makeSession(SESSION_HISTORY),
    );
    const coldEvent = trace.decision(coldInput, coldDecision, { callId: "cold-1" });
    events.push(coldEvent);
    events.push(
      trace.request("cold", "cold-1", {
        timestamp: BASE_TIMESTAMP + 600_000,
        promptTokens: 100_000,
        cachedInputTokens: 0,
        cacheWriteTokens: 100_000,
        outputTokens: 500,
      }),
    );
    events.push(
      trace.compaction(
        "cold",
        {
          timestamp: BASE_TIMESTAMP + 600_000,
          beforeTokens: 100_000,
          afterTokens: 30_000,
          success: true,
        },
        { callId: "cold-1" },
      ),
    );
    events.push(trace.sessionEnd("cold", { timestamp: BASE_TIMESTAMP + 601_000 }));

    return events;
  }

  it("pairs decisions with requests and measures the cost error exactly", () => {
    const analysis = analyzeTraceEvents(buildTrace());

    expect(analysis.sessions).toBe(2);
    expect(analysis.decisions).toBe(3);
    expect(analysis.requests).toBe(3);
    expect(analysis.unpairedDecisions).toBe(0);
    expect(analysis.unpriceable).toBe(0);

    // Warm call 1: predicted 0.084 (80k read + 20k input), actual the same.
    // Warm call 2: the provider served 60k, so the actual is 0.018 + 0.12 = 0.138.
    // Signed error for call 1 is 0 and for call 2 is (0.138 - 0.084) / 0.138 = +0.3913.
    const warm = analysis.byClass.steady;
    expect(warm.pairedRequests).toBe(2);
    expect(warm.callCost.count).toBe(2);
    expect(warm.callCost.meanSignedRelativeError).toBeCloseTo(0.391304347826087 / 2, 10);
  });

  it("counts the current call in the horizon and reports the error", () => {
    const analysis = analyzeTraceEvents(buildTrace());

    // The warm decisions predicted 2 and 1 remaining calls; the session really had exactly
    // that many requests from each point, counting the call being decided.
    expect(analysis.overall.horizon.count).toBe(3);
    expect(analysis.overall.horizon.meanSignedRelativeError).toBeCloseTo(0, 12);
    expect(analysis.overall.horizon.meanAbsoluteRelativeError).toBeCloseTo(0, 12);
  });

  it("calibrates cache aliveness for this call and for the next one", () => {
    const analysis = analyzeTraceEvents(buildTrace());

    const warmBuckets = analysis.byClass.steady.cacheAliveThisCall.filter(
      (bucket) => bucket.count > 0,
    );
    expect(warmBuckets).toHaveLength(1);
    expect(warmBuckets[0]?.meanPredicted).toBe(1);
    expect(warmBuckets[0]?.observedRate).toBe(1);

    // The cold session predicts "not alive" and is right about it.
    const coldBuckets = analysis.byClass["cold-cache"].cacheAliveThisCall.filter(
      (bucket) => bucket.count > 0,
    );
    expect(coldBuckets).toHaveLength(1);
    expect(coldBuckets[0]?.meanPredicted).toBe(0);
    expect(coldBuckets[0]?.observedRate).toBe(0);
  });

  it("measures the retention error against the real post-compaction size", () => {
    const analysis = analyzeTraceEvents(buildTrace());

    // The model predicted 100k * 0.25 = 25k; the compactor produced 30k.
    expect(analysis.overall.retention.count).toBe(1);
    expect(analysis.overall.retention.meanSignedRelativeError).toBeCloseTo(
      (30_000 - 25_000) / 30_000,
      12,
    );
  });

  it("splits sessions into development and holdout deterministically", () => {
    const analysis = analyzeTraceEvents(buildTrace());

    expect(analysis.split.dev.decisions + analysis.split.holdout.decisions).toBe(3);
    expect(isHoldoutSession("warm")).toBe(isHoldoutSession("warm"));
    expect(isHoldoutSession("warm", 1)).toBe(false);

    const again = analyzeTraceEvents(buildTrace());
    expect(again.split.holdout.decisions).toBe(analysis.split.holdout.decisions);
  });

  it("renders a report that states what the trace cannot prove", () => {
    const report = renderTraceReport(analyzeTraceEvents(buildTrace()));

    expect(report).toContain("# FoldPoint trace analysis");
    expect(report).toContain("call cost");
    expect(report).toContain("cold-cache");
    expect(report).toContain("It does not prove savings");
    expect(report).toContain("Task quality is not measured here");
  });

  it("notes unpaired decisions and missing pricing instead of guessing", () => {
    const trace = recorder();
    const input = makeInput({ contextTokens: 10_000, profile: makeInput().profile });
    const decision = decideFoldPoint(input, makeLearning(), makeSession());
    const events: TraceEvent[] = [trace.header(), trace.decision(input, decision)];

    const analysis = analyzeTraceEvents(events);
    expect(analysis.unpairedDecisions).toBe(1);
    expect(analysis.notes.join(" ")).toContain("no request event");
  });
});

describe("trace analysis: unknown cache usage", () => {
  function mixedTrace(): TraceEvent[] {
    const trace = recorder();
    const events: TraceEvent[] = [trace.header()];
    const profile = profileWithCacheTtl(60_000);

    const build = (callId: string, step: number, reportCache: boolean) => {
      const input = makeInput({
        sessionId: "mixed",
        profile,
        contextTokens: 100_000,
        cachedTokens: 80_000,
        idleMs: 0,
        expectedFutureCalls: 2 - step,
      });
      events.push(
        trace.decision(
          input,
          decideFoldPoint(input, makeLearning(HISTORY), makeSession(SESSION_HISTORY)),
          { callId },
        ),
      );
      const usage = reportCache
        ? {
            timestamp: BASE_TIMESTAMP + step * 1_000,
            promptTokens: 100_000,
            cachedInputTokens: 80_000,
            cacheWriteTokens: 0,
            outputTokens: 0,
          }
        : { timestamp: BASE_TIMESTAMP + step * 1_000, promptTokens: 100_000, outputTokens: 0 };
      events.push(trace.request("mixed", callId, usage));
    };

    build("mixed-1", 0, true);
    // The second call reports no cache breakdown at all: unknown, not a miss.
    build("mixed-2", 1, false);
    events.push(trace.sessionEnd("mixed", { timestamp: BASE_TIMESTAMP + 2_000 }));
    return events;
  }

  it("treats a missing cache report as unknown, not as a miss", () => {
    const analysis = analyzeTraceEvents(mixedTrace());

    expect(analysis.unknownCacheUsage).toBe(1);
    // Only the call with a known cache state is calibrated.
    expect(analysis.overall.cacheAliveThisCall.reduce((n, bucket) => n + bucket.count, 0)).toBe(1);
    // Only the call with a complete breakdown enters the cost error.
    expect(analysis.overall.callCost.count).toBe(1);
    // One unknown call does not turn a served session into a cold-cache session.
    expect(analysis.byClass["cold-cache"].decisions).toBe(0);
    expect(analysis.byClass.steady.decisions).toBe(2);
    expect(analysis.notes.join(" ")).toContain("unknown is not a miss");
  });
});

describe("trace analysis: path continuity", () => {
  function twoCallSession(
    sessionId: string,
    secondProfile: FoldPointProfile | undefined,
    compaction: boolean,
  ): TraceEvent[] {
    const trace = recorder();
    const events: TraceEvent[] = [trace.header()];
    const profile = profileWithCacheTtl(60_000);
    const first = makeInput({
      sessionId,
      profile,
      contextTokens: 100_000,
      cachedTokens: 80_000,
      idleMs: 0,
      expectedFutureCalls: 2,
    });
    events.push(
      trace.decision(
        first,
        decideFoldPoint(first, makeLearning(HISTORY), makeSession(SESSION_HISTORY)),
        { callId: "x-1" },
      ),
    );
    events.push(
      trace.request(sessionId, "x-1", {
        timestamp: BASE_TIMESTAMP,
        promptTokens: 100_000,
        cachedInputTokens: 80_000,
        cacheWriteTokens: 0,
        outputTokens: 0,
      }),
    );
    if (compaction) {
      events.push(
        trace.compaction(
          sessionId,
          {
            timestamp: BASE_TIMESTAMP + 500,
            beforeTokens: 100_000,
            afterTokens: 30_000,
            success: true,
          },
          { callId: "x-1" },
        ),
      );
    }
    const secondOverrides: Parameters<typeof makeInput>[0] = {
      sessionId,
      contextTokens: 100_000,
      cachedTokens: 80_000,
      idleMs: 0,
      expectedFutureCalls: 1,
    };
    if (secondProfile !== undefined) {
      secondOverrides.profile = secondProfile;
    }
    const second = makeInput(secondOverrides);
    events.push(
      trace.decision(
        second,
        decideFoldPoint(second, makeLearning(HISTORY), makeSession(SESSION_HISTORY)),
        { callId: "x-2" },
      ),
    );
    events.push(
      trace.request(sessionId, "x-2", {
        timestamp: BASE_TIMESTAMP + 1_000,
        promptTokens: 100_000,
        cachedInputTokens: 80_000,
        cacheWriteTokens: 0,
        outputTokens: 0,
      }),
    );
    events.push(trace.sessionEnd(sessionId, { timestamp: BASE_TIMESTAMP + 2_000 }));
    return events;
  }

  it("skips the next-call comparison after a compaction", () => {
    const analysis = analyzeTraceEvents(twoCallSession("compacted", undefined, true));

    expect(analysis.skippedNextCall.compaction).toBe(1);
    expect(analysis.overall.cacheAliveNextCall.reduce((n, bucket) => n + bucket.count, 0)).toBe(0);
    expect(analysis.notes.join(" ")).toContain("not the same path");
  });

  it("skips the next-call comparison after a model change", () => {
    const analysis = analyzeTraceEvents(
      twoCallSession("switched", makeProfile({ model: "other-model" }), false),
    );

    expect(analysis.skippedNextCall.profileChange).toBe(1);
    expect(analysis.overall.cacheAliveNextCall.reduce((n, bucket) => n + bucket.count, 0)).toBe(0);
  });

  it("compares the next call when the path is unchanged", () => {
    const analysis = analyzeTraceEvents(twoCallSession("intact", undefined, false));

    expect(analysis.skippedNextCall.compaction).toBe(0);
    expect(analysis.skippedNextCall.profileChange).toBe(0);
    expect(analysis.overall.cacheAliveNextCall.reduce((n, bucket) => n + bucket.count, 0)).toBe(1);
  });
});

describe("trace analysis CLI", () => {
  function writeTempTrace(name: string, lines: string[]): string {
    const path = join(tmpdir(), `foldpoint-trace-${name}-${process.pid}.jsonl`);
    writeFileSync(path, `${lines.join("\n")}\n`, "utf8");
    return path;
  }

  function brokenTraceLines(): string[] {
    const trace = recorder();
    const input = makeInput({ contextTokens: 10_000 });
    const decision = decideFoldPoint(input, makeLearning(), makeSession());
    return [
      JSON.stringify(trace.header()),
      "{not json",
      JSON.stringify(trace.decision(input, decision)),
    ];
  }

  it("refuses to report on a trace with unreadable lines", () => {
    const path = writeTempTrace("broken", brokenTraceLines());
    const outPrefix = path.replace(/\.jsonl$/, "-out");

    const previousExitCode = process.exitCode;
    process.exitCode = undefined;
    main([path, "--out", outPrefix]);
    const exitCode = process.exitCode;
    process.exitCode = previousExitCode;

    expect(exitCode).toBe(1);
    expect(existsSync(`${outPrefix}.md`)).toBe(false);
  });

  it("marks a report as not usable for calibration when errors are allowed", () => {
    const path = writeTempTrace("allowed", brokenTraceLines());
    const outPrefix = path.replace(/\.jsonl$/, "-out");

    main([path, "--out", outPrefix, "--allow-errors"]);

    const analysis = JSON.parse(readFileSync(`${outPrefix}.json`, "utf8")) as {
      usableForCalibration: boolean;
      calibrationBlockers: string[];
    };
    expect(analysis.usableForCalibration).toBe(false);
    expect(analysis.calibrationBlockers[0]).toContain("could not be parsed");
    expect(readFileSync(`${outPrefix}.md`, "utf8")).toContain("not usable for calibration");
  });
});

describe("trace analysis: right-censored sessions", () => {
  /** A session with no `session_end` event: the trace was exported mid-session. */
  function censoredTrace(): TraceEvent[] {
    const trace = recorder();
    const events: TraceEvent[] = [trace.header()];
    const profile = profileWithCacheTtl(60_000);
    for (let step = 0; step < 3; step += 1) {
      const input = makeInput({
        sessionId: "open",
        profile,
        contextTokens: 100_000,
        cachedTokens: 80_000,
        idleMs: 0,
        expectedFutureCalls: 8,
      });
      const decision = decideFoldPoint(input, makeLearning(HISTORY), makeSession(SESSION_HISTORY));
      events.push(trace.decision(input, decision, { callId: `open-${step}` }));
      events.push(
        trace.request("open", `open-${step}`, {
          timestamp: BASE_TIMESTAMP + step * 1_000,
          promptTokens: 100_000,
          cachedInputTokens: 80_000,
          cacheWriteTokens: 0,
          outputTokens: 0,
        }),
      );
    }
    return events;
  }

  it("excludes an unfinished session from the horizon error and the near-end class", () => {
    const analysis = analyzeTraceEvents(censoredTrace());

    expect(analysis.sessions).toBe(1);
    expect(analysis.censoredSessions).toBe(1);
    expect(analysis.completeSessions).toBe(0);
    // The last recorded call is not known to be the last call, so the horizon cannot be judged.
    expect(analysis.overall.horizon.count).toBe(0);
    expect(analysis.byClass["near-end"].decisions).toBe(0);
    // The other metrics still use the calls that were recorded.
    expect(analysis.overall.pairedRequests).toBe(3);
    expect(analysis.notes.join(" ")).toContain("right-censored");
  });

  it("measures the horizon again once the session has an end", () => {
    const events = censoredTrace();
    events.push(recorder().sessionEnd("open", { timestamp: BASE_TIMESTAMP + 5_000 }));
    const analysis = analyzeTraceEvents(events);

    expect(analysis.censoredSessions).toBe(0);
    expect(analysis.overall.horizon.count).toBe(3);
    expect(analysis.byClass["near-end"].decisions).toBe(3);
    // The host claimed 8 remaining calls where 3, 2 and 1 were real.
    expect(analysis.overall.horizon.meanSignedRelativeError).toBeLessThan(0);
  });
});
