/** Aggregate ordinary-call counts from decision/request pairs; never infer a normal runtime outcome. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTraceJsonl, type TraceEvent } from "../src/index";

export function summarizeRuntimeEvidence(events: readonly TraceEvent[]) {
  type Runtime = { calls: number; ended: boolean; ambiguous: boolean; endSeq: number | null };
  const runtimes = new Map<string, Runtime>();
  const pending = new Map<string, { runtime: string; decisionSeq: number }>();
  const used = new Set<string>();
  let unpairedRequests = 0,
    assignedWithoutDecision = 0,
    unassignedRequests = 0,
    decisionsWithoutRuntime = 0,
    ambiguousRequests = 0;
  const key = (session: string, id: string) => JSON.stringify([session, id]);
  const ensure = (id: string) => {
    let r = runtimes.get(id);
    if (!r) {
      r = { calls: 0, ended: false, ambiguous: false, endSeq: null };
      runtimes.set(id, r);
    }
    return r;
  };
  for (const event of events) {
    if (event.type === "decision") {
      const call = key(event.sessionId, event.callId),
        id = event.input.runtimeId;
      if (!id || event.input.runtimeStatus !== "active") {
        decisionsWithoutRuntime++;
        continue;
      }
      const runtime = key(event.sessionId, id),
        r = ensure(runtime);
      if (pending.has(call) || used.has(call) || r.ended) {
        r.ambiguous = true;
        continue;
      }
      pending.set(call, { runtime, decisionSeq: event.seq });
    } else if (event.type === "request") {
      const call = key(event.sessionId, event.callId),
        paired = pending.get(call);
      if (!paired) {
        unpairedRequests++;
        if (event.runtimeId === undefined) {
          unassignedRequests++;
          continue;
        }
        const r = ensure(key(event.sessionId, event.runtimeId));
        if (r.ended || used.has(call) || event.outcome !== "ok") {
          r.ambiguous = true;
          ambiguousRequests++;
          continue;
        }
        used.add(call);
        assignedWithoutDecision++;
        r.calls++;
        continue;
      }
      pending.delete(call);
      used.add(call);
      const r = ensure(paired.runtime);
      if (
        event.seq <= paired.decisionSeq ||
        r.ended ||
        event.outcome !== "ok" ||
        (event.runtimeId !== undefined && key(event.sessionId, event.runtimeId) !== paired.runtime)
      ) {
        r.ambiguous = true;
        ambiguousRequests++;
        continue;
      }
      r.calls++;
    } else if (event.type === "runtime_end") {
      const r = ensure(key(event.sessionId, event.runtimeId));
      if (r.ended) r.ambiguous = true;
      r.ended = true;
      r.endSeq = event.seq;
    }
  }
  for (const pair of pending.values()) ensure(pair.runtime).ambiguous = true;
  const clean = [...runtimes.values()].filter((r) => !r.ambiguous && r.calls > 0);
  const observations = Array.from({ length: 20 }, (_, i) => {
    const calls = i + 1;
    const continuing = clean.filter((r) => r.calls > calls).length;
    const observedEnd = clean.filter((r) => r.ended && r.calls === calls).length;
    const censored = clean.filter((r) => !r.ended && r.calls === calls).length;
    return {
      calls,
      continuing,
      observedEnd,
      censored,
      observedContinuationFraction:
        continuing + observedEnd > 0 ? continuing / (continuing + observedEnd) : null,
    };
  });
  return {
    runner: "foldpoint.runtime-evidence.v1",
    paidCalls: 0,
    policyChanged: false,
    totalRuntimesWithDecisionOrEnd: runtimes.size,
    eligibleObservedEnd: clean.filter((r) => r.ended).length,
    eligibleCensored: clean.filter((r) => !r.ended).length,
    ambiguousRuntimes: [...runtimes.values()].filter((r) => r.ambiguous).length,
    emptyRuntimes: [...runtimes.values()].filter((r) => !r.ambiguous && r.calls === 0).length,
    unpairedRequests,
    assignedWithoutDecision,
    unassignedRequests,
    decisionsWithoutRuntime,
    pendingDecisions: pending.size,
    ambiguousRequests,
    usableForCalibration: false,
    calibrationBlockers: [
      "runtime_end does not distinguish completed from interrupted runtimes",
      ...(unassignedRequests ? ["ordinary requests without a paired runtime decision"] : []),
      ...(decisionsWithoutRuntime ? ["decisions without active runtime identity"] : []),
      ...(pending.size ? ["decisions without a paired request"] : []),
      ...(ambiguousRequests ? ["requests with missing or unsuccessful outcomes"] : []),
      ...([...runtimes.values()].some((r) => r.ambiguous)
        ? ["ambiguous runtime event sequence"]
        : []),
    ],
    observations,
    limitations: [
      "runtime_end has no outcome: observed endings can include interruption or failure and are not confirmed successful task completions.",
      "A missing runtime_end is right-censored; sessions with missing pairs/outcomes are excluded, not inferred.",
      "Ordinary requests without decisions are counted only when the host explicitly records runtimeId; others cannot be assigned and durations may be incomplete.",
      "Summary and prewarm events do not advance runtime age.",
      "This is descriptive evidence, not a calibrated continuation probability or a causal cost estimate.",
    ],
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const args = process.argv.slice(2);
    if (
      args.length !== 4 ||
      args[0] !== "--trace" ||
      !args[1] ||
      args[2] !== "--out" ||
      !args[3] ||
      existsSync(args[3])
    )
      throw new Error("invalid inputs");
    const parsed = parseTraceJsonl(readFileSync(args[1], "utf8"));
    if (parsed.errors.length) throw new Error("invalid trace");
    const result = summarizeRuntimeEvidence(parsed.events);
    writeFileSync(args[3], `${JSON.stringify(result, null, 2)}\n`, { flag: "wx" });
    process.stdout.write(
      `${JSON.stringify({ ...result, observations: result.observations.slice(0, 3) }, null, 2)}\n`,
    );
  } catch {
    process.stderr.write("Runtime evidence failed validation; source files unchanged\n");
    process.exitCode = 1;
  }
}
