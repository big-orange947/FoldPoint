/**
 * Offline trace analysis: do FoldPoint's predictions match what really happened?
 *
 * ```bash
 * npm run trace:analyze -- traces/example.jsonl
 * npm run trace:analyze -- traces/example.jsonl --out traces/report
 * ```
 *
 * Reads a JSONL trace (see `src/trace.ts` and `docs/traces.md`), pairs each decision with the
 * request that followed it, and reports prediction error for:
 *
 * - the cost of the call the decision was about (prompt side; output tokens are excluded on
 *   both sides because the model does not predict them),
 * - cache aliveness for that call and for the next one in the session,
 * - the compaction retention ratio,
 * - the remaining-call horizon.
 *
 * Results are split into a development set and a holdout set by a documented, deterministic
 * rule, and broken down by scenario class (cold cache, one-off expiry, near end of session,
 * steady). Nothing here changes the model: this tool only measures.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import {
  costOfUsage,
  parseTraceJsonl,
  resolveUnitPrices,
  type TraceCompactionEvent,
  type TraceDecisionEvent,
  type TraceEvent,
  type TraceRequestEvent,
} from "../src/index";

/** Scenario classes a decision can belong to. A decision can be in more than one. */
export type TraceClass = "cold-cache" | "one-off-expiry" | "near-end" | "steady";

export const TRACE_CLASSES: readonly TraceClass[] = [
  "cold-cache",
  "one-off-expiry",
  "near-end",
  "steady",
];

export interface TraceAnalysisOptions {
  /** A decision is "near end" when it is within this many requests of the session's last. */
  nearEndCalls?: number;
  /** Sessions whose id hashes into this bucket form the holdout set. */
  holdoutModulo?: number;
  /** Include per-case details for the worst errors. */
  worstCases?: number;
}

export interface ErrorSummary {
  count: number;
  /** Mean of (actual - predicted) / |actual|, so a positive value means under-prediction. */
  meanSignedRelativeError: number | null;
  meanAbsoluteRelativeError: number | null;
  worst: Array<{ sessionId: string; callId: string; predicted: number; actual: number }>;
}

export interface CalibrationBucket {
  lowerBound: number;
  upperBound: number;
  count: number;
  meanPredicted: number | null;
  observedRate: number | null;
}

export interface ClassMetrics {
  decisions: number;
  pairedRequests: number;
  callCost: ErrorSummary;
  cacheAliveThisCall: CalibrationBucket[];
  cacheAliveNextCall: CalibrationBucket[];
  retention: ErrorSummary;
  horizon: ErrorSummary;
}

export interface TraceAnalysis {
  format: { version: number | null; libraryVersion: string | null; producer: string | null };
  files: string[];
  events: number;
  parseErrors: Array<{ file?: string; line: number; message: string }>;
  /** False when the input is incomplete: a trace with unreadable lines is not evidence. */
  usableForCalibration: boolean;
  calibrationBlockers: string[];
  sessions: number;
  completeSessions: number;
  /** Sessions without a `session_end` event: right-censored, excluded from horizon metrics. */
  censoredSessions: number;
  decisions: number;
  requests: number;
  compactions: number;
  unpriceable: number;
  unpairedDecisions: number;
  /** Requests whose cache read/write tokens the host did not report: unknown, not a miss. */
  unknownCacheUsage: number;
  skippedNextCall: { compaction: number; profileChange: number; unknownNextDecision: number };
  overall: ClassMetrics;
  byClass: Record<TraceClass, ClassMetrics>;
  split: { dev: ClassMetrics; holdout: ClassMetrics };
  notes: string[];
}

interface SessionIndex {
  sessionId: string;
  decisions: TraceDecisionEvent[];
  requests: TraceRequestEvent[];
  compactions: TraceCompactionEvent[];
  endedAt: number | null;
  /** Known cache-read state per request: `true` served, `false` not served, `undefined` unknown. */
  servedFromCache: Array<boolean | undefined>;
}

const CALIBRATION_BUCKETS: ReadonlyArray<{ lowerBound: number; upperBound: number }> = [
  { lowerBound: 0, upperBound: 0.25 },
  { lowerBound: 0.25, upperBound: 0.5 },
  { lowerBound: 0.5, upperBound: 0.75 },
  { lowerBound: 0.75, upperBound: 1 },
];

function emptySummary(): ErrorSummary {
  return { count: 0, meanSignedRelativeError: null, meanAbsoluteRelativeError: null, worst: [] };
}

/** FNV-1a, the same hash the benchmark uses for fingerprints. */
function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Deterministic dev/holdout split: by session id, so a session is never in both. */
export function isHoldoutSession(sessionId: string, holdoutModulo = 5): boolean {
  return holdoutModulo > 1 && hashString(sessionId) % holdoutModulo === 0;
}

class SummaryBuilder {
  readonly #errors: number[] = [];
  readonly #absolute: number[] = [];
  readonly #cases: Array<{ sessionId: string; callId: string; predicted: number; actual: number }> =
    [];
  readonly #worstCases: number;

  constructor(worstCases: number) {
    this.#worstCases = worstCases;
  }

  add(predicted: number, actual: number, sessionId: string, callId: string): void {
    const denominator = Math.abs(actual);
    if (denominator === 0) {
      return;
    }
    const relative = (actual - predicted) / denominator;
    this.#errors.push(relative);
    this.#absolute.push(Math.abs(relative));
    this.#cases.push({ sessionId, callId, predicted, actual });
  }

  build(): ErrorSummary {
    if (this.#errors.length === 0) {
      return emptySummary();
    }
    const sorted = [...this.#cases].sort(
      (left, right) =>
        Math.abs((right.actual - right.predicted) / Math.abs(right.actual)) -
        Math.abs((left.actual - left.predicted) / Math.abs(left.actual)),
    );
    return {
      count: this.#errors.length,
      meanSignedRelativeError: mean(this.#errors),
      meanAbsoluteRelativeError: mean(this.#absolute),
      worst: sorted.slice(0, this.#worstCases),
    };
  }
}

class CalibrationBuilder {
  readonly #buckets: Array<{ predicted: number[]; observed: number[] }>;

  constructor() {
    this.#buckets = CALIBRATION_BUCKETS.map(() => ({ predicted: [], observed: [] }));
  }

  add(predicted: number, observed: boolean): void {
    const clamped = Math.min(Math.max(predicted, 0), 1);
    let index = 0;
    for (let candidate = 0; candidate < CALIBRATION_BUCKETS.length; candidate += 1) {
      const bucket = CALIBRATION_BUCKETS[candidate];
      if (bucket !== undefined && clamped >= bucket.lowerBound) {
        index = candidate;
      }
    }
    const bucket = this.#buckets[index];
    if (bucket === undefined) {
      return;
    }
    bucket.predicted.push(clamped);
    bucket.observed.push(observed ? 1 : 0);
  }

  build(): CalibrationBucket[] {
    return this.#buckets.map((bucket, index) => {
      const bounds = CALIBRATION_BUCKETS[index] ?? { lowerBound: 0, upperBound: 1 };
      return {
        lowerBound: bounds.lowerBound,
        upperBound: bounds.upperBound,
        count: bucket.predicted.length,
        meanPredicted: bucket.predicted.length > 0 ? mean(bucket.predicted) : null,
        observedRate: bucket.observed.length > 0 ? mean(bucket.observed) : null,
      };
    });
  }
}

interface Collectors {
  decisions: number;
  pairedRequests: number;
  cost: SummaryBuilder;
  retention: SummaryBuilder;
  horizon: SummaryBuilder;
  thisCall: CalibrationBuilder;
  nextCall: CalibrationBuilder;
}

function newCollectors(worstCases: number): Collectors {
  return {
    decisions: 0,
    pairedRequests: 0,
    cost: new SummaryBuilder(worstCases),
    retention: new SummaryBuilder(worstCases),
    horizon: new SummaryBuilder(worstCases),
    thisCall: new CalibrationBuilder(),
    nextCall: new CalibrationBuilder(),
  };
}

function finishCollectors(collectors: Collectors): ClassMetrics {
  return {
    decisions: collectors.decisions,
    pairedRequests: collectors.pairedRequests,
    callCost: collectors.cost.build(),
    cacheAliveThisCall: collectors.thisCall.build(),
    cacheAliveNextCall: collectors.nextCall.build(),
    retention: collectors.retention.build(),
    horizon: collectors.horizon.build(),
  };
}

type ClassCollectors = Record<TraceClass, Collectors>;

function newClassCollectors(worstCases: number): ClassCollectors {
  return {
    "cold-cache": newCollectors(worstCases),
    "one-off-expiry": newCollectors(worstCases),
    "near-end": newCollectors(worstCases),
    steady: newCollectors(worstCases),
  };
}

/** Analyses parsed trace events. Pure: no I/O, no clock, no global state. */
export function analyzeTraceEvents(
  events: readonly TraceEvent[],
  options: TraceAnalysisOptions = {},
): TraceAnalysis {
  const nearEndCalls = options.nearEndCalls ?? 3;
  const holdoutModulo = options.holdoutModulo ?? 5;
  const worstCases = options.worstCases ?? 5;

  const header = events.find((event) => event.type === "header");
  const sessions = indexSessions(events);
  const classes = newClassCollectors(worstCases);
  const overall = newCollectors(worstCases);
  const dev = newCollectors(worstCases);
  const holdout = newCollectors(worstCases);

  const notes: string[] = [];
  const calibrationBlockers: string[] = [];
  let unpriceable = 0;
  let unpairedDecisions = 0;
  let unknownCacheUsage = 0;
  let unpairedCompactions = 0;
  const skippedNextCall = { compaction: 0, profileChange: 0, unknownNextDecision: 0 };

  for (const session of sessions.values()) {
    const sessionClasses = classifySession(session);
    const split = isHoldoutSession(session.sessionId, holdoutModulo) ? holdout : dev;
    // Two pairings come out of one pass over the compactions, and they are not the same pairing.
    //
    // Retention belongs to the decision in force *when* the compaction happened: that call's
    // context is the one that was shrunk, and that decision is the one that predicted what
    // would survive. Cost belongs to the *next* call, which is the first replay of the new
    // prefix and is priced differently.
    //
    // A host that acts on its own decisions attributes the compaction to the decision that
    // asked for it, and that decision is already the next call. A host that compacts by its own
    // policy (Pi) attributes nothing, and there the two have to be found by time.
    const retentionDecisionByCompaction = new Map<TraceCompactionEvent, TraceDecisionEvent>();
    const firstReplayAfterCompaction = new Set<string>();
    for (const compaction of session.compactions) {
      const decision =
        compaction.callId === undefined
          ? lastDecisionBefore(session, compaction.timestamp)
          : session.decisions.find((entry) => entry.callId === compaction.callId);
      if (compaction.success) {
        if (decision === undefined) {
          unpairedCompactions += 1;
        } else {
          retentionDecisionByCompaction.set(compaction, decision);
        }
      }
      // A failed compaction changed nothing, so the next call replays the old prefix.
      if (compaction.success) {
        const firstReplay =
          compaction.callId ??
          session.requests.find((request) => request.timestamp > compaction.timestamp)?.callId;
        if (firstReplay !== undefined) {
          firstReplayAfterCompaction.add(firstReplay);
        }
      }
    }

    for (const decision of session.decisions) {
      const requestIndex = session.requests.findIndex(
        (request) => request.callId === decision.callId,
      );
      const request = requestIndex >= 0 ? session.requests[requestIndex] : undefined;
      const decisionClasses = classesForDecision(
        sessionClasses,
        requestIndex,
        session,
        nearEndCalls,
      );

      overall.decisions += 1;
      split.decisions += 1;
      for (const traceClass of decisionClasses) {
        classes[traceClass].decisions += 1;
      }

      // --- horizon: how many calls really remained, counting the one being decided ---
      // `expectedFutureCalls` covers the current call plus the later ones, because that is
      // what `C_now + (N - 1) * C_later` assumes. Only a session that ended can answer it:
      // a trace exported mid-session is right-censored, and its last recorded call is not
      // the last call of the session.
      if (requestIndex >= 0 && session.endedAt !== null) {
        const actualRemaining = session.requests.length - requestIndex;
        const predicted = decision.prediction.expectedFutureCalls;
        overall.horizon.add(predicted, actualRemaining, session.sessionId, decision.callId);
        split.horizon.add(predicted, actualRemaining, session.sessionId, decision.callId);
        for (const traceClass of decisionClasses) {
          classes[traceClass].horizon.add(
            predicted,
            actualRemaining,
            session.sessionId,
            decision.callId,
          );
        }
      }

      // --- cache aliveness for this call, and for the next one ---
      if (request !== undefined) {
        const cacheStateKnown =
          !isFailedRequest(request) && request.usage.cachedInputTokens !== undefined;
        if (!cacheStateKnown) {
          unknownCacheUsage += 1;
        } else {
          const served =
            request.usage.cachedInputTokens !== undefined && request.usage.cachedInputTokens > 0;
          const thisCallProbability = decision.prediction.estimatedCacheAliveProbability;
          overall.thisCall.add(thisCallProbability, served);
          split.thisCall.add(thisCallProbability, served);
          for (const traceClass of decisionClasses) {
            classes[traceClass].thisCall.add(thisCallProbability, served);
          }
        }

        const next = session.requests[requestIndex + 1];
        if (
          next !== undefined &&
          cacheStateKnown &&
          !isFailedRequest(next) &&
          next.usage.cachedInputTokens !== undefined
        ) {
          const nextDecision = session.decisions.find((entry) => entry.callId === next.callId);
          const blocker = nextCallBlocker(session, request, next, decision, nextDecision);
          if (blocker === null) {
            const nextServed =
              next.usage.cachedInputTokens !== undefined && next.usage.cachedInputTokens > 0;
            const laterProbability = decision.prediction.estimatedCacheLaterAliveProbability;
            overall.nextCall.add(laterProbability, nextServed);
            split.nextCall.add(laterProbability, nextServed);
            for (const traceClass of decisionClasses) {
              classes[traceClass].nextCall.add(laterProbability, nextServed);
            }
          } else {
            skippedNextCall[blocker] += 1;
          }
        }
      }

      // --- call cost: what the model predicted against what the provider reported ---
      if (request === undefined) {
        unpairedDecisions += 1;
        continue;
      }
      overall.pairedRequests += 1;
      split.pairedRequests += 1;
      for (const traceClass of decisionClasses) {
        classes[traceClass].pairedRequests += 1;
      }

      const pricing = decision.profile.pricing;
      if (pricing === undefined) {
        unpriceable += 1;
        continue;
      }
      // A cost can only be priced when the host reported the whole prompt breakdown, and only
      // when the call actually ran: a failed call reports zeroed usage.
      if (
        isFailedRequest(request) ||
        request.usage.cachedInputTokens === undefined ||
        request.usage.cacheWriteTokens === undefined
      ) {
        continue;
      }
      const actualCost = costOfUsage(resolveUnitPrices(pricing), {
        promptTokens: request.usage.promptTokens,
        cachedInputTokens: request.usage.cachedInputTokens,
        cacheWriteTokens: request.usage.cacheWriteTokens,
        outputTokens: 0,
      });
      // A decision that compacted is followed by the *first post-compaction* replay, which
      // the model prices separately: the compacted context is written as a new prefix.
      const compacted = firstReplayAfterCompaction.has(decision.callId);
      const predictedCost = compacted
        ? decision.prediction.estimatedFirstPostCompactReplayCost
        : decision.prediction.estimatedCurrentCallReplayCost;
      overall.cost.add(predictedCost, actualCost, session.sessionId, decision.callId);
      split.cost.add(predictedCost, actualCost, session.sessionId, decision.callId);
      for (const traceClass of decisionClasses) {
        classes[traceClass].cost.add(predictedCost, actualCost, session.sessionId, decision.callId);
      }
    }

    // --- retention: the model's post-compaction estimate against the real one ---
    for (const compaction of session.compactions) {
      if (!compaction.success) {
        continue;
      }
      const decision = retentionDecisionByCompaction.get(compaction);
      if (decision === undefined) {
        continue;
      }
      const predicted = decision.prediction.estimatedPostCompactTokens;
      const actual = compaction.afterTokens;
      const retentionClasses = classesForDecision(
        sessionClasses,
        session.requests.findIndex((request) => request.callId === decision.callId),
        session,
        nearEndCalls,
      );
      overall.retention.add(predicted, actual, session.sessionId, decision.callId);
      split.retention.add(predicted, actual, session.sessionId, decision.callId);
      for (const traceClass of retentionClasses) {
        classes[traceClass].retention.add(predicted, actual, session.sessionId, decision.callId);
      }
    }
  }

  if (unpairedDecisions > 0) {
    notes.push(
      `${unpairedDecisions} decision(s) have no request event with the same callId; they are excluded from the cost, cache and horizon error.`,
    );
  }
  if (unpriceable > 0) {
    notes.push(
      `${unpriceable} decision(s) carry no pricing snapshot; their call cost cannot be priced from the trace.`,
    );
  }
  if (unknownCacheUsage > 0) {
    notes.push(
      `${unknownCacheUsage} request(s) report no usable cache state (not reported, or the call failed); unknown is not a miss, so they are excluded from the cache calibration and the cost error.`,
    );
  }
  const failedRequests = [...sessions.values()].reduce(
    (total, session) =>
      total + session.requests.filter((request) => isFailedRequest(request)).length,
    0,
  );
  if (failedRequests > 0) {
    notes.push(
      `${failedRequests} request(s) failed or were aborted; they are recorded in the trace but excluded from every prediction metric, because a call that never reached the cache proves nothing about it.`,
    );
  }
  if (unpairedCompactions > 0) {
    notes.push(
      `${unpairedCompactions} compaction(s) have no decision to compare against (a compaction before the first call, or one the host attached to a callId that has no decision); they are excluded from the retention error.`,
    );
  }
  const requestsWithoutDecision = [...sessions.values()].reduce(
    (total, session) =>
      total +
      session.requests.filter(
        (request) => !session.decisions.some((decision) => decision.callId === request.callId),
      ).length,
    0,
  );
  if (requestsWithoutDecision > 0) {
    notes.push(
      `${requestsWithoutDecision} request(s) have no decision: the host recorded the call but could not decide before it (a context size it did not know). Their usage is in the trace and in the next-call cache comparison, but they carry no prediction of their own.`,
    );
  }
  const skippedNextCallTotal =
    skippedNextCall.compaction +
    skippedNextCall.profileChange +
    skippedNextCall.unknownNextDecision;
  if (skippedNextCallTotal > 0) {
    notes.push(
      `${skippedNextCallTotal} next-call cache comparison(s) were skipped because the two calls are not the same path: ${skippedNextCall.compaction} after a compaction, ${skippedNextCall.profileChange} after a model or compactor change, ${skippedNextCall.unknownNextDecision} with no decision for the next call.`,
    );
  }
  if (sessions.size === 0) {
    notes.push("No sessions found: the trace has no decision events.");
  }
  const censoredSessions = [...sessions.values()].filter(
    (session) => session.endedAt === null,
  ).length;
  if (censoredSessions > 0) {
    notes.push(
      `${censoredSessions} session(s) have no session_end event and are treated as right-censored: they are excluded from the horizon error and from the near-end class, because their last recorded call is not known to be the last call.`,
    );
  }

  const byClass = {} as Record<TraceClass, ClassMetrics>;
  for (const traceClass of TRACE_CLASSES) {
    byClass[traceClass] = finishCollectors(classes[traceClass]);
  }

  return {
    format: {
      version: header?.v ?? null,
      libraryVersion: header?.library.version ?? null,
      producer: header?.producer ?? null,
    },
    files: [],
    events: events.length,
    parseErrors: [],
    usableForCalibration: calibrationBlockers.length === 0,
    calibrationBlockers,
    sessions: sessions.size,
    completeSessions: sessions.size - censoredSessions,
    censoredSessions,
    decisions: overall.decisions,
    requests: [...sessions.values()].reduce((total, session) => total + session.requests.length, 0),
    compactions: [...sessions.values()].reduce(
      (total, session) => total + session.compactions.length,
      0,
    ),
    unpriceable,
    unpairedDecisions,
    unknownCacheUsage,
    skippedNextCall,
    overall: finishCollectors(overall),
    byClass,
    split: { dev: finishCollectors(dev), holdout: finishCollectors(holdout) },
    notes,
  };
}

function classesForDecision(
  sessionClasses: readonly TraceClass[],
  requestIndex: number,
  session: SessionIndex,
  nearEndCalls: number,
): TraceClass[] {
  const result: TraceClass[] = sessionClasses.filter((traceClass) => traceClass !== "near-end");
  // "Near end" needs a real end: a session without a `session_end` event is right-censored,
  // so its last recorded call is not the last call of the session.
  if (
    session.endedAt !== null &&
    requestIndex >= 0 &&
    requestIndex >= session.requests.length - nearEndCalls
  ) {
    result.push("near-end");
  }
  return result;
}

/**
 * Classifies a session from what the trace actually shows:
 *
 * - `cold-cache`: the provider served almost nothing from cache;
 * - `one-off-expiry`: the cache lapsed at least once *after* the first call and recovered
 *   afterwards (the first call of a session has no prefix to reuse, so it is not a lapse);
 * - `steady`: cache reads throughout;
 * - `near-end` is added per decision, for the last few calls of a *complete* session.
 *
 * Requests whose cache usage the host did not report are unknown, not misses, and are left
 * out of the classification.
 */
function classifySession(session: SessionIndex): TraceClass[] {
  const served = session.servedFromCache;
  const known = served.filter((value) => value !== undefined);
  if (known.length === 0) {
    return [];
  }
  const rate = known.filter(Boolean).length / known.length;

  if (rate <= 0.1) {
    return ["cold-cache"];
  }

  let lapsedThenRecovered = false;
  for (let index = 1; index < served.length; index += 1) {
    if (served[index] === false && served.slice(index + 1).some((value) => value === true)) {
      lapsedThenRecovered = true;
      break;
    }
  }
  if (lapsedThenRecovered) {
    return ["one-off-expiry"];
  }

  return ["steady"];
}

function indexSessions(events: readonly TraceEvent[]): Map<string, SessionIndex> {
  const sessions = new Map<string, SessionIndex>();

  const ensure = (sessionId: string): SessionIndex => {
    const existing = sessions.get(sessionId);
    if (existing !== undefined) {
      return existing;
    }
    const created: SessionIndex = {
      sessionId,
      decisions: [],
      requests: [],
      compactions: [],
      endedAt: null,
      servedFromCache: [],
    };
    sessions.set(sessionId, created);
    return created;
  };

  for (const event of events) {
    switch (event.type) {
      case "header":
        break;
      case "decision":
        ensure(event.sessionId).decisions.push(event);
        break;
      case "request": {
        const session = ensure(event.sessionId);
        session.requests.push(event);
        // `undefined` means "no usable evidence": the host did not report the cache usage, or
        // the call itself failed and never reached the cache. Neither is a miss.
        session.servedFromCache.push(
          isFailedRequest(event) || event.usage.cachedInputTokens === undefined
            ? undefined
            : event.usage.cachedInputTokens > 0,
        );
        break;
      }
      case "compaction":
        ensure(event.sessionId).compactions.push(event);
        break;
      case "session_end":
        ensure(event.sessionId).endedAt = event.timestamp;
        break;
    }
  }

  return sessions;
}

/**
 * The decision in force when a compaction happened.
 *
 * Used when the host does not attach a `callId` to its compaction events, which is the case for
 * a host that compacts by its own policy. The call whose context the compaction shrank is the
 * one decided last before it, and that decision is the one that predicted the retention.
 *
 * The comparison uses the timestamp of the call itself, not of the decision: a call and the
 * compaction that follows it can land in the same millisecond, and then the decision timestamp
 * alone would also match the *next* decision.
 */
function lastDecisionBefore(
  session: SessionIndex,
  timestamp: number,
): TraceDecisionEvent | undefined {
  let found: TraceDecisionEvent | undefined;
  for (const decision of session.decisions) {
    const request = session.requests.find((entry) => entry.callId === decision.callId);
    const at = request?.timestamp ?? decision.timestamp;
    if (at <= timestamp) {
      found = decision;
    }
  }
  return found;
}

/**
 * True when the call itself failed, or when the reported usage cannot be a real call.
 *
 * A request with no prompt tokens and no output tokens did not happen: a model call always
 * reads a prompt. Older traces recorded such a call with `outcome: "ok"`, so the check is on the
 * numbers as well as on the outcome. Either way the call proves nothing about the cache, and
 * treating its zeroes as a miss would poison the calibration.
 */
function isFailedRequest(request: TraceRequestEvent): boolean {
  if (request.outcome !== undefined && request.outcome !== "ok") {
    return true;
  }
  return request.usage.promptTokens === 0 && (request.usage.outputTokens ?? 0) === 0;
}

/**
 * Why the next-call cache prediction cannot be compared with the next call, or `null` when it
 * can. A compaction or a model change between the two calls means they are not the same path.
 */
function nextCallBlocker(
  session: SessionIndex,
  request: TraceRequestEvent,
  next: TraceRequestEvent,
  decision: TraceDecisionEvent,
  nextDecision: TraceDecisionEvent | undefined,
): "compaction" | "profileChange" | "unknownNextDecision" | null {
  const compactedBetween = session.compactions.some(
    (compaction) =>
      compaction.callId === decision.callId ||
      (compaction.timestamp > request.timestamp && compaction.timestamp <= next.timestamp),
  );
  if (compactedBetween) {
    return "compaction";
  }
  if (nextDecision === undefined) {
    return "unknownNextDecision";
  }
  const before = decision.profile;
  const after = nextDecision.profile;
  if (before.model !== after.model || before.provider !== after.provider) {
    return "profileChange";
  }
  if (before.compactorId !== after.compactorId) {
    return "profileChange";
  }
  return null;
}

function mean(values: readonly number[]): number {
  return values.reduce((total, value) => total + value, 0) / values.length;
}

function formatPercent(value: number | null): string {
  if (value === null) {
    return "n/a";
  }
  const sign = value > 0 ? "+" : "";
  return `${sign}${(value * 100).toFixed(1)}%`;
}

function renderSummary(label: string, summary: ErrorSummary): string[] {
  const lines = [
    `| ${label} | ${summary.count} | ${formatPercent(summary.meanSignedRelativeError)} | ${formatPercent(summary.meanAbsoluteRelativeError)} |`,
  ];
  return lines;
}

function renderCalibration(label: string, buckets: readonly CalibrationBucket[]): string[] {
  const lines: string[] = [
    `**${label}**`,
    "",
    "| predicted range | n | mean predicted | observed |",
    "| --- | --- | --- | --- |",
  ];
  for (const bucket of buckets) {
    if (bucket.count === 0) {
      continue;
    }
    lines.push(
      `| ${bucket.lowerBound.toFixed(2)}–${bucket.upperBound.toFixed(2)} | ${bucket.count} | ${(bucket.meanPredicted ?? 0).toFixed(3)} | ${(bucket.observedRate ?? 0).toFixed(3)} |`,
    );
  }
  lines.push("");
  return lines;
}

function renderClass(label: string, metrics: ClassMetrics): string[] {
  const lines = [
    `### ${label}`,
    "",
    `decisions: ${metrics.decisions}, paired requests: ${metrics.pairedRequests}`,
    "",
    "| error | n | mean signed | mean absolute |",
    "| --- | --- | --- | --- |",
    ...renderSummary("call cost", metrics.callCost),
    ...renderSummary("retention", metrics.retention),
    ...renderSummary("horizon (calls remaining)", metrics.horizon),
    "",
    ...renderCalibration("cache alive for this call", metrics.cacheAliveThisCall),
    ...renderCalibration("cache alive for the next call", metrics.cacheAliveNextCall),
  ];
  return lines;
}

/** Renders the analysis as a markdown report. */
export function renderTraceReport(analysis: TraceAnalysis): string {
  const lines: string[] = [
    "# FoldPoint trace analysis",
    "",
    `- trace format: v${String(analysis.format.version ?? "?")}, produced by foldpoint ${analysis.format.libraryVersion ?? "?"}${analysis.format.producer ? ` (${analysis.format.producer})` : ""}`,
    `- files: ${analysis.files.length > 0 ? analysis.files.join(", ") : "n/a"}`,
    `- events: ${analysis.events} (${analysis.sessions} sessions: ${analysis.completeSessions} complete, ${analysis.censoredSessions} censored; ${analysis.decisions} decisions, ${analysis.requests} requests, ${analysis.compactions} compactions)`,
    `- usable for calibration: ${analysis.usableForCalibration ? "yes" : "**no**"}`,
    "",
    "A positive signed error means the model **under-predicted**; a negative one means it",
    "over-predicted. Call cost is prompt-side only: output tokens are excluded on both sides",
    "because the model does not predict them.",
    "",
  ];

  if (!analysis.usableForCalibration) {
    lines.push(
      "> **This report is not usable for calibration.**",
      "",
      ...analysis.calibrationBlockers.map((blocker) => `> - ${blocker}`),
      "",
    );
  }

  for (const note of analysis.notes) {
    lines.push(`> ${note}`, "");
  }

  if (analysis.parseErrors.length > 0) {
    lines.push("## Unreadable lines", "");
    for (const error of analysis.parseErrors.slice(0, 20)) {
      lines.push(
        `- ${error.file === undefined ? "" : `${error.file} `}line ${error.line}: ${error.message}`,
      );
    }
    lines.push("");
  }

  lines.push(...renderClass("All decisions", analysis.overall));
  lines.push("## By scenario class", "");
  for (const traceClass of TRACE_CLASSES) {
    lines.push(...renderClass(traceClass, analysis.byClass[traceClass]));
  }
  lines.push("## Development vs holdout", "");
  lines.push(...renderClass("development set", analysis.split.dev));
  lines.push(...renderClass("holdout set", analysis.split.holdout));

  lines.push(
    "## What this report cannot say",
    "",
    "- It does not prove savings. Replaying a trace with a different compaction time changes",
    "  the context *and* the cache after that point, so the counterfactual is not in the data.",
    "  Only a paired experiment on real tasks (same tasks, same model and compactor, FoldPoint",
    "  against a guarded fixed threshold) can compare total cost.",
    "- Task quality is not measured here. A cheaper session that dropped something important is",
    "  not a win.",
    "",
  );

  return lines.join("\n");
}

interface CliOptions {
  inputs: string[];
  out?: string;
  nearEndCalls: number;
  holdoutModulo: number;
  allowErrors: boolean;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    inputs: [],
    nearEndCalls: 3,
    holdoutModulo: 5,
    allowErrors: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--out") {
      options.out = argv[index + 1];
      index += 1;
      continue;
    }
    if (arg === "--near-end") {
      options.nearEndCalls = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--holdout-modulo") {
      options.holdoutModulo = Number(argv[index + 1]);
      index += 1;
      continue;
    }
    if (arg === "--allow-errors") {
      options.allowErrors = true;
      continue;
    }
    if (arg !== undefined && !arg.startsWith("--")) {
      options.inputs.push(arg);
    }
  }
  return options;
}

/** CLI entry point: read one or more JSONL traces, write `<out>.md` and `<out>.json`. */
export function main(argv: readonly string[] = process.argv.slice(2)): void {
  const options = parseArgs(argv);
  if (options.inputs.length === 0) {
    console.error(
      "usage: npm run trace:analyze -- <trace.jsonl> [<trace.jsonl> ...] [--out <prefix>] [--allow-errors]",
    );
    process.exitCode = 1;
    return;
  }

  const inputPaths = options.inputs.map((input) => resolve(input));
  const events: TraceEvent[] = [];
  const parseErrors: Array<{ file: string; line: number; message: string }> = [];
  for (const inputPath of inputPaths) {
    const parsed = parseTraceJsonl(readFileSync(inputPath, "utf8"));
    events.push(...parsed.events);
    for (const error of parsed.errors) {
      parseErrors.push({ file: basename(inputPath), ...error });
    }
  }

  // A trace with unreadable lines is not evidence. Refuse by default; --allow-errors writes a
  // report that says so instead of quietly averaging over whatever parsed.
  if (parseErrors.length > 0 && !options.allowErrors) {
    console.error(
      `${parseErrors.length} unreadable line(s) across ${inputPaths.length} file(s); refusing to report on incomplete input.`,
    );
    for (const error of parseErrors.slice(0, 10)) {
      console.error(`  ${error.file} line ${error.line}: ${error.message}`);
    }
    if (parseErrors.length > 10) {
      console.error(`  ... and ${parseErrors.length - 10} more`);
    }
    console.error("pass --allow-errors to get a report marked as not usable for calibration.");
    process.exitCode = 1;
    return;
  }

  const analysis = analyzeTraceEvents(events, {
    nearEndCalls: options.nearEndCalls,
    holdoutModulo: options.holdoutModulo,
  });
  analysis.files = inputPaths.map((inputPath) => basename(inputPath)).sort();
  analysis.parseErrors = parseErrors;
  if (parseErrors.length > 0) {
    analysis.usableForCalibration = false;
    analysis.calibrationBlockers.push(
      `${parseErrors.length} line(s) could not be parsed (${parseErrors[0]?.file ?? "?"} line ${parseErrors[0]?.line ?? "?"} first); the events that did parse are not a complete session record.`,
    );
  }

  const outPrefix =
    options.out !== undefined
      ? resolve(options.out)
      : join(
          dirname(inputPaths[0] ?? "."),
          `${basename(inputPaths[0] ?? "trace").replace(/\.jsonl$/i, "")}-report`,
        );

  writeFileSync(`${outPrefix}.json`, `${JSON.stringify(analysis, null, 2)}\n`, "utf8");
  writeFileSync(`${outPrefix}.md`, `${renderTraceReport(analysis)}\n`, "utf8");

  console.log(
    `events: ${analysis.events}  sessions: ${analysis.sessions} (${analysis.censoredSessions} censored)  decisions: ${analysis.decisions}`,
  );
  console.log(
    `unpaired decisions: ${analysis.unpairedDecisions}  unpriceable: ${analysis.unpriceable}  unknown cache usage: ${analysis.unknownCacheUsage}`,
  );
  console.log(`usable for calibration: ${analysis.usableForCalibration ? "yes" : "NO"}`);
  console.log(`report: ${outPrefix}.md`);
  console.log(`data:   ${outPrefix}.json`);
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("/trace-analyze.ts") === true;
if (invokedDirectly) {
  main();
}
