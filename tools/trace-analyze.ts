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
  parseErrors: Array<{ line: number; message: string }>;
  sessions: number;
  decisions: number;
  requests: number;
  compactions: number;
  unpriceable: number;
  unpairedDecisions: number;
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
  /** Request callIds that were served from cache, in order. */
  servedFromCache: boolean[];
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
  let unpriceable = 0;
  let unpairedDecisions = 0;

  for (const session of sessions.values()) {
    const sessionClasses = classifySession(session);
    const split = isHoldoutSession(session.sessionId, holdoutModulo) ? holdout : dev;

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
      // what `C_now + (N - 1) * C_later` assumes.
      if (requestIndex >= 0) {
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
        const served = (request.usage.cachedInputTokens ?? 0) > 0;
        const thisCallProbability = decision.prediction.estimatedCacheAliveProbability;
        overall.thisCall.add(thisCallProbability, served);
        split.thisCall.add(thisCallProbability, served);
        for (const traceClass of decisionClasses) {
          classes[traceClass].thisCall.add(thisCallProbability, served);
        }

        const next = session.requests[requestIndex + 1];
        if (next !== undefined) {
          const nextServed = (next.usage.cachedInputTokens ?? 0) > 0;
          const laterProbability = decision.prediction.estimatedCacheLaterAliveProbability;
          overall.nextCall.add(laterProbability, nextServed);
          split.nextCall.add(laterProbability, nextServed);
          for (const traceClass of decisionClasses) {
            classes[traceClass].nextCall.add(laterProbability, nextServed);
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
      const actualCost = costOfUsage(resolveUnitPrices(pricing), {
        promptTokens: request.usage.promptTokens,
        cachedInputTokens: request.usage.cachedInputTokens ?? 0,
        cacheWriteTokens: request.usage.cacheWriteTokens ?? 0,
        outputTokens: 0,
      });
      // A decision that compacted is followed by the *first post-compaction* replay, which
      // the model prices separately: the compacted context is written as a new prefix.
      const compacted = session.compactions.some(
        (compaction) => compaction.callId === decision.callId && compaction.success,
      );
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
      const decision = session.decisions.find((entry) => entry.callId === compaction.callId);
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
  if (sessions.size === 0) {
    notes.push("No sessions found: the trace has no decision events.");
  }
  const withoutEnd = [...sessions.values()].filter((session) => session.endedAt === null).length;
  if (withoutEnd > 0) {
    notes.push(
      `${withoutEnd} session(s) have no session_end event; their horizon is still measured from the requests that follow each decision.`,
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
    sessions: sessions.size,
    decisions: overall.decisions,
    requests: [...sessions.values()].reduce((total, session) => total + session.requests.length, 0),
    compactions: [...sessions.values()].reduce(
      (total, session) => total + session.compactions.length,
      0,
    ),
    unpriceable,
    unpairedDecisions,
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
  if (requestIndex >= 0 && requestIndex >= session.requests.length - nearEndCalls) {
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
 * - `near-end` is added per decision, for the last few calls of a session.
 */
function classifySession(session: SessionIndex): TraceClass[] {
  const served = session.servedFromCache;
  if (served.length === 0) {
    return [];
  }
  const servedCount = served.filter(Boolean).length;
  const rate = servedCount / served.length;

  if (rate <= 0.1) {
    return ["cold-cache"];
  }

  let lapsedThenRecovered = false;
  for (let index = 1; index < served.length; index += 1) {
    if (!served[index] && served.slice(index + 1).some(Boolean)) {
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
        session.servedFromCache.push((event.usage.cachedInputTokens ?? 0) > 0);
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
    `- events: ${analysis.events} (${analysis.sessions} sessions, ${analysis.decisions} decisions, ${analysis.requests} requests, ${analysis.compactions} compactions)`,
    "",
    "A positive signed error means the model **under-predicted**; a negative one means it",
    "over-predicted. Call cost is prompt-side only: output tokens are excluded on both sides",
    "because the model does not predict them.",
    "",
  ];

  for (const note of analysis.notes) {
    lines.push(`> ${note}`, "");
  }

  if (analysis.parseErrors.length > 0) {
    lines.push("## Unreadable lines", "");
    for (const error of analysis.parseErrors.slice(0, 20)) {
      lines.push(`- line ${error.line}: ${error.message}`);
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
  input?: string;
  out?: string;
  nearEndCalls: number;
  holdoutModulo: number;
}

function parseArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = { nearEndCalls: 3, holdoutModulo: 5 };
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
    if (arg !== undefined && !arg.startsWith("--")) {
      options.input = arg;
    }
  }
  return options;
}

/** CLI entry point: read a JSONL trace, write `<out>.md` and `<out>.json`. */
export function main(argv: readonly string[] = process.argv.slice(2)): void {
  const options = parseArgs(argv);
  if (options.input === undefined) {
    console.error("usage: npm run trace:analyze -- <trace.jsonl> [--out <prefix>]");
    process.exitCode = 1;
    return;
  }

  const inputPath = resolve(options.input);
  const parsed = parseTraceJsonl(readFileSync(inputPath, "utf8"));
  const analysis = analyzeTraceEvents(parsed.events, {
    nearEndCalls: options.nearEndCalls,
    holdoutModulo: options.holdoutModulo,
  });
  analysis.files = [basename(inputPath)];
  analysis.parseErrors = parsed.errors;

  const outPrefix =
    options.out !== undefined
      ? resolve(options.out)
      : join(dirname(inputPath), `${basename(inputPath).replace(/\.jsonl$/i, "")}-report`);

  writeFileSync(`${outPrefix}.json`, `${JSON.stringify(analysis, null, 2)}\n`, "utf8");
  writeFileSync(`${outPrefix}.md`, `${renderTraceReport(analysis)}\n`, "utf8");

  console.log(
    `events: ${analysis.events}  sessions: ${analysis.sessions}  decisions: ${analysis.decisions}`,
  );
  console.log(
    `unpaired decisions: ${analysis.unpairedDecisions}  unpriceable: ${analysis.unpriceable}`,
  );
  if (parsed.errors.length > 0) {
    console.log(`unreadable lines: ${parsed.errors.length}`);
  }
  console.log(`report: ${outPrefix}.md`);
  console.log(`data:   ${outPrefix}.json`);
}

const invokedDirectly = process.argv[1]?.replace(/\\/g, "/").endsWith("/trace-analyze.ts") === true;
if (invokedDirectly) {
  main();
}
