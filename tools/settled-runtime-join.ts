/** Explicit identifier join for research. Missing or contradictory evidence never becomes a completion. */
import type { TraceEvent } from "../src/index";

export interface SettledActivity {
  sessionId: string;
  runtimeIds: readonly string[];
  reportedOutcome: "completed" | "aborted" | "error" | "unknown";
  settled: true;
}

export function joinSettledActivities(
  events: readonly TraceEvent[],
  activities: readonly SettledActivity[],
) {
  type Run = { count: number; ended: number; ambiguous: boolean };
  const runs = new Map<string, Run>(),
    decisions = new Map<string, string>(),
    consumed = new Map<string, string>();
  const id = (session: string, value: string) => JSON.stringify([session, value]);
  const ensure = (key: string) => {
    let run = runs.get(key);
    if (!run) {
      run = { count: 0, ended: 0, ambiguous: false };
      runs.set(key, run);
    }
    return run;
  };
  let unassignedRequests = 0;
  for (const e of events) {
    if (e.type === "decision" && e.input.runtimeId && e.input.runtimeStatus === "active") {
      const call = id(e.sessionId, e.callId),
        runtime = id(e.sessionId, e.input.runtimeId),
        run = ensure(runtime);
      if (decisions.has(call) || consumed.has(call) || run.ended) {
        run.ambiguous = true;
        const prior = decisions.get(call) ?? consumed.get(call);
        if (prior) ensure(prior).ambiguous = true;
      } else decisions.set(call, runtime);
    } else if (e.type === "request") {
      const call = id(e.sessionId, e.callId),
        paired = decisions.get(call);
      const explicit = e.runtimeId === undefined ? undefined : id(e.sessionId, e.runtimeId);
      const runtime = paired ?? explicit;
      if (!runtime) {
        unassignedRequests++;
        const prior = consumed.get(call);
        if (prior) ensure(prior).ambiguous = true;
        continue;
      }
      const run = ensure(runtime);
      if (
        consumed.has(call) ||
        run.ended ||
        (paired && explicit && paired !== explicit) ||
        e.outcome !== "ok"
      ) {
        run.ambiguous = true;
        const prior = consumed.get(call);
        if (prior) ensure(prior).ambiguous = true;
        if (paired && explicit && paired !== explicit) ensure(explicit).ambiguous = true;
      } else run.count++;
      decisions.delete(call);
      if (!consumed.has(call)) consumed.set(call, runtime);
    } else if (e.type === "runtime_end") {
      const run = ensure(id(e.sessionId, e.runtimeId));
      run.ended++;
      if (run.ended !== 1) run.ambiguous = true;
    }
  }
  for (const runtime of decisions.values()) ensure(runtime).ambiguous = true;
  const claimed = new Set<string>();
  let valid = 0,
    incomplete = 0,
    conflicts = 0,
    observedCompleted = 0,
    observedOther = 0,
    ordinaryCalls = 0;
  const keysFor = (activity: SettledActivity) => {
    if (
      activity?.settled !== true ||
      typeof activity.sessionId !== "string" ||
      !Array.isArray(activity.runtimeIds) ||
      !activity.runtimeIds.length ||
      !["completed", "aborted", "error", "unknown"].includes(activity.reportedOutcome) ||
      activity.runtimeIds.some((x) => typeof x !== "string" || !x)
    ) {
      return null;
    }
    return activity.runtimeIds.map((x) => id(activity.sessionId, x));
  };
  const counts = new Map<string, number>();
  const allKeys = activities.map(keysFor);
  for (const keys of allKeys)
    if (keys) for (const k of new Set(keys)) counts.set(k, (counts.get(k) ?? 0) + 1);
  for (let i = 0; i < activities.length; i++) {
    const activity = activities[i],
      keys = allKeys[i];
    if (!activity || !keys) {
      incomplete++;
      continue;
    }
    for (const k of keys) claimed.add(k);
    if (new Set(keys).size !== keys.length || keys.some((k) => (counts.get(k) ?? 0) > 1)) {
      conflicts++;
      continue;
    }
    const linked = keys.map((k) => runs.get(k));
    if (linked.some((r) => r?.ended !== 1 || r.ambiguous)) {
      incomplete++;
      continue;
    }
    valid++;
    ordinaryCalls += linked.reduce((sum, r) => sum + (r?.count ?? 0), 0);
    if (activity.reportedOutcome === "completed") observedCompleted++;
    else observedOther++;
  }
  return {
    runner: "foldpoint.settled-runtime-join.v1",
    activities: activities.length,
    valid,
    incomplete,
    conflicts,
    unassignedRequests,
    unclaimedRuntimes: [...runs.keys()].filter((k) => !claimed.has(k)).length,
    observedCompleted,
    observedOther,
    ordinaryCalls,
    usableForCalibration: false,
    limitations: [
      "Only explicit identifiers are joined; host identity/version compatibility and durable complete journals are not proven.",
      "Retries with failed requests are excluded as ambiguous; a Pi completed outcome is not a task-quality guarantee.",
      "Any unassigned request may belong to an otherwise valid activity. No continuation probability is fitted.",
    ],
  };
}
