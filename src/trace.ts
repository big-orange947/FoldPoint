/**
 * Trace events for real-trajectory validation.
 *
 * A trace is a JSONL file: one event per line, in the order the host observed them. It exists
 * to answer one question — do FoldPoint's predictions match what a real agent session actually
 * did? — so it records **metadata only**: timestamps, token counts, prices, cache usage, the
 * decision and the model's own estimates. Prompts, tool output, chat content and credentials
 * have no field here and must never be added to one.
 *
 * The distinction that matters most:
 *
 * - a {@link TraceDecisionEvent} carries the **estimate** the model made *before* the call,
 *   when the provider's cache usage is not yet known;
 * - a {@link TraceRequestEvent} carries the **actual usage** the provider reported *after*
 *   the call returned.
 *
 * They are separate events on purpose. A host cannot know the actual cache read/write tokens
 * at decision time, and a trace that pretends otherwise cannot calibrate the model.
 *
 * This module is pure: it builds and validates plain objects. It performs no I/O, opens no
 * network connection and holds no state beyond a line counter. Writing the JSONL file is the
 * host's job — see `examples/trace-capture.ts` for the three-line writer and
 * `docs/traces.md` for the wiring contract.
 */

import { resolveDefaults } from "./defaults";
import type {
  CachePolicy,
  CompactionObservation,
  FoldPointAction,
  FoldPointDecision,
  FoldPointDefaults,
  FoldPointInput,
  FoldPointProfile,
  FoldPointReason,
  PricingSnapshot,
  RequestObservation,
  SessionEndObservation,
} from "./types";
import { FOLDPOINT_VERSION } from "./version";

/** Bumped whenever the event shape changes in a way a reader has to know about. */
export const TRACE_FORMAT_VERSION = 2;

/** What happened to the call a decision was about. */
export type TraceOutcome = "ok" | "error" | "overflow" | "aborted";

/** The estimates the model produced *before* the call, recorded for later comparison. */
export interface TracePrediction {
  utilization: number;
  remainingTokens: number;
  /** Cost of the call this decision is about, including any prefix it must write. */
  estimatedCurrentCallReplayCost: number;
  /** Expected cost of a later call on the kept context. */
  estimatedLaterCallReplayCost: number;
  estimatedKeepCost: number;
  estimatedCompactCallCost: number;
  /** Cost of the first replay after a compaction: the compacted context is written. */
  estimatedFirstPostCompactReplayCost: number;
  estimatedCompactCost: number;
  estimatedNetSaving: number;
  adjustedNetSaving: number;
  breakEvenCalls: number | null;
  expectedFutureCalls: number;
  effectiveHorizonCalls: number;
  /** Where the model expects the context to land after a compaction. */
  estimatedPostCompactTokens: number;
  estimatedReclaimRatio: number;
  estimatedCacheCoverageRatio: number;
  /** Probability the prefix is alive for the call this decision is about. */
  estimatedCacheAliveProbability: number;
  /** Probability the prefix is alive for the calls after it. */
  estimatedCacheLaterAliveProbability: number;
  estimatedEffectiveCachedTokens: number;
  estimatedCacheLaterCandidateTokens: number;
}

/** The profile metadata a decision ran under. Mirrors {@link FoldPointProfile}. */
export interface TraceProfile {
  provider?: string;
  model: string;
  contextWindowTokens: number;
  compactorId: string;
  /** Irreversible fingerprint of the host's stable prompt prefix. Never the prompt itself. */
  prefixId?: string;
  pricing?: PricingSnapshot;
  cachePolicy?: CachePolicy;
}

/** The decision input, minus anything the reader does not need to reconstruct the call. */
export interface TraceInput {
  contextTokens: number;
  cachedTokens?: number;
  /** Leading tokens the host declared stable (system prompt and tool schemas). */
  fixedPrefixTokens?: number;
  idleMs?: number;
  expectedFutureCalls?: number;
  safeBoundary?: boolean;
  compactionAllowed?: boolean;
  cacheExpiresAt?: number;
}

export interface TraceHeaderEvent {
  v: 1 | typeof TRACE_FORMAT_VERSION;
  type: "header";
  seq: 0;
  timestamp: number;
  library: { name: "foldpoint"; version: string };
  /** The resolved defaults in force for this trace: the model's parameters, for reproduction. */
  defaults: FoldPointDefaults;
  /** Free-form host label, e.g. `"pi@0.3.1"`. Never a credential. */
  producer?: string;
}

export interface TraceDecisionEvent {
  v: 1 | typeof TRACE_FORMAT_VERSION;
  type: "decision";
  seq: number;
  timestamp: number;
  sessionId: string;
  /** Pairs this decision with the request event that reports what really happened. */
  callId: string;
  profile: TraceProfile;
  input: TraceInput;
  decision: { action: FoldPointAction; reasons: FoldPointReason[]; confidence: number };
  prediction: TracePrediction;
  /** Wall-clock time the decision itself took, when the host measured it. */
  decisionLatencyMs?: number;
  /**
   * The host's compaction-policy checks since the previous decision, when the host runs one.
   *
   * A host with a low compaction threshold asks before nearly every call. Those answers are not
   * model-call decisions, so they are not separate events; they are counted here, on the real
   * decision they preceded, which keeps a session with forty checks from looking like a session
   * with forty decisions.
   */
  compactionChecks?: {
    count: number;
    vetoed: number;
    totalLatencyMs: number;
    maxLatencyMs: number;
  };
}

export interface TraceRequestEvent {
  v: 1 | typeof TRACE_FORMAT_VERSION;
  type: "request";
  seq: number;
  timestamp: number;
  sessionId: string;
  callId: string;
  /** What the provider reported for the call, after it returned. */
  usage: RequestObservation;
  latencyMs?: number;
  outcome?: TraceOutcome;
}

/** A host-side cache refresh is a paid call, but not an agent turn or a decision/request pair. */
export interface TraceCacheWarmEvent {
  v: typeof TRACE_FORMAT_VERSION;
  type: "cache_warm";
  seq: number;
  timestamp: number;
  sessionId: string;
  usage: {
    promptTokens: number;
    cachedInputTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
    /** Pi's priced usage for the refresh; no request payload is recorded. */
    actualCost: number;
  };
}

export interface TraceCompactionEvent {
  v: 1 | typeof TRACE_FORMAT_VERSION;
  type: "compaction";
  seq: number;
  timestamp: number;
  sessionId: string;
  /** The decision that asked for this compaction, when the host knows it. */
  callId?: string;
  action: FoldPointAction;
  beforeTokens: number;
  afterTokens: number;
  success: boolean;
  usage?: {
    promptTokens?: number;
    cachedInputTokens?: number;
    cacheWriteTokens?: number;
    outputTokens?: number;
    actualCost?: number;
  };
  durationMs?: number;
  /** A short machine-readable code. Never a message that could contain content. */
  errorCode?: string;
  /**
   * Why the host proposed this compaction (`"threshold"`, `"manual"`, `"overflow"`), when it
   * said so. Overflow recovery is the one reason a policy may never overrule.
   */
  reason?: string;
  /**
   * Who started this compaction: the host on its own schedule (`"host"`), or the policy asking
   * the host for it (`"policy"`). Pi reports both as `reason: "manual"`, so without this field a
   * compaction an adapter asked for would be indistinguishable from the user running `/compact`.
   */
  initiatedBy?: "host" | "policy";
  /**
   * A *policy check* rather than a model call: the reasons a host's policy gave for vetoing the
   * compaction, and how long the answer took. These live here, not on a decision event, because
   * a host may ask before every call - and a session with forty checks must not look like a
   * session with forty decisions.
   */
  reasons?: string[];
  policyLatencyMs?: number;
}

export interface TraceSessionEndEvent {
  v: 1 | typeof TRACE_FORMAT_VERSION;
  type: "session_end";
  seq: number;
  timestamp: number;
  sessionId: string;
  /** Host-defined: `"completed"`, `"aborted"`, `"budget"`, ... */
  reason?: string;
}

export type TraceEvent =
  | TraceHeaderEvent
  | TraceDecisionEvent
  | TraceRequestEvent
  | TraceCacheWarmEvent
  | TraceCompactionEvent
  | TraceSessionEndEvent;

export type TraceEventType = TraceEvent["type"];

export interface TraceRecorderOptions {
  /** Host label recorded in the header. Never a credential. */
  producer?: string;
  /** Defaults the host passes to `FoldPoint`; recorded resolved, for reproduction. */
  defaults?: Partial<FoldPointDefaults>;
  /** Clock for the header timestamp only; every event timestamp comes from the host. */
  now?: () => number;
}

/**
 * Builds trace events. Deterministic given the same inputs and clock, and free of I/O, so a
 * host can call it on the hot path.
 *
 * ```ts
 * const trace = new TraceRecorder({ producer: "my-agent@1.2.3" });
 * append(trace.header());
 *
 * const event = trace.decision(input, decision);   // before the call: estimates only
 * append(event);
 *
 * // ... the provider answers ...
 * append(trace.request(input.sessionId, event.callId, usage));  // after: actual usage
 * ```
 */
export class TraceRecorder {
  readonly #defaults: FoldPointDefaults;
  readonly #producer: string | undefined;
  readonly #now: () => number;
  #seq = 0;

  constructor(options: TraceRecorderOptions = {}) {
    if (options.producer !== undefined) {
      assertTraceLabel("producer", options.producer, TRACE_SHORT_LABEL_MAX);
    }
    this.#defaults = resolveDefaults(options.defaults);
    this.#producer = options.producer;
    this.#now = options.now ?? (() => Date.now());
  }

  /** The first line of a trace file. */
  header(): TraceHeaderEvent {
    const event: TraceHeaderEvent = {
      v: TRACE_FORMAT_VERSION,
      type: "header",
      seq: 0,
      timestamp: this.#now(),
      library: { name: "foldpoint", version: FOLDPOINT_VERSION },
      defaults: this.#defaults,
    };
    if (this.#producer !== undefined) {
      event.producer = this.#producer;
    }
    return event;
  }

  /**
   * Records a decision and the estimates behind it. Call this *before* the request: the
   * returned `callId` is what {@link request} needs to pair the actual usage with it.
   */
  decision(
    input: FoldPointInput,
    decision: FoldPointDecision,
    options: {
      callId?: string;
      decisionLatencyMs?: number;
      compactionChecks?: {
        count: number;
        vetoed: number;
        totalLatencyMs: number;
        maxLatencyMs: number;
      };
    } = {},
  ): TraceDecisionEvent {
    assertTraceLabel("sessionId", input.sessionId);
    if (options.callId !== undefined) {
      assertTraceLabel("callId", options.callId);
    }
    const seq = this.#nextSeq();
    const event: TraceDecisionEvent = {
      v: TRACE_FORMAT_VERSION,
      type: "decision",
      seq,
      timestamp: input.timestamp,
      sessionId: input.sessionId,
      callId: options.callId ?? `${input.sessionId}#${seq}`,
      profile: traceProfile(input.profile),
      input: traceInput(input),
      decision: {
        action: decision.action,
        reasons: [...decision.reasons],
        confidence: decision.confidence,
      },
      prediction: tracePrediction(decision),
    };
    if (options.decisionLatencyMs !== undefined) {
      event.decisionLatencyMs = options.decisionLatencyMs;
    }
    if (options.compactionChecks !== undefined && options.compactionChecks.count > 0) {
      event.compactionChecks = { ...options.compactionChecks };
    }
    return event;
  }

  /** Records what the provider reported for a call, after it returned. */
  request(
    sessionId: string,
    callId: string,
    usage: RequestObservation,
    options: { latencyMs?: number; outcome?: TraceOutcome } = {},
  ): TraceRequestEvent {
    assertTraceLabel("sessionId", sessionId);
    assertTraceLabel("callId", callId);
    const event: TraceRequestEvent = {
      v: TRACE_FORMAT_VERSION,
      type: "request",
      seq: this.#nextSeq(),
      timestamp: usage.timestamp,
      sessionId,
      callId,
      usage: { ...usage },
    };
    if (options.latencyMs !== undefined) {
      event.latencyMs = options.latencyMs;
    }
    if (options.outcome !== undefined) {
      event.outcome = options.outcome;
    }
    return event;
  }

  /** Records a successful cache refresh without pretending it was a normal model call. */
  cacheWarm(
    sessionId: string,
    timestamp: number,
    usage: TraceCacheWarmEvent["usage"],
  ): TraceCacheWarmEvent {
    assertTraceLabel("sessionId", sessionId);
    const event: TraceCacheWarmEvent = {
      v: TRACE_FORMAT_VERSION,
      type: "cache_warm",
      seq: this.#nextSeq(),
      timestamp,
      sessionId,
      usage: { ...usage },
    };
    validateTraceEvent(event);
    return event;
  }

  /** Records a compaction attempt and what it actually cost. */
  compaction(
    sessionId: string,
    observation: CompactionObservation,
    options: {
      action?: FoldPointAction;
      callId?: string;
      durationMs?: number;
      errorCode?: string;
      initiatedBy?: "host" | "policy";
      reason?: string;
      reasons?: readonly string[];
      policyLatencyMs?: number;
    } = {},
  ): TraceCompactionEvent {
    assertTraceLabel("sessionId", sessionId);
    if (options.callId !== undefined) {
      assertTraceLabel("callId", options.callId);
    }
    if (options.errorCode !== undefined) {
      assertTraceLabel("errorCode", options.errorCode, TRACE_SHORT_LABEL_MAX);
    }
    if (options.reason !== undefined) {
      assertTraceLabel("reason", options.reason, TRACE_SHORT_LABEL_MAX);
    }
    if (
      options.initiatedBy !== undefined &&
      options.initiatedBy !== "host" &&
      options.initiatedBy !== "policy"
    ) {
      throw new RangeError('Trace event "initiatedBy" must be "host" or "policy"');
    }
    for (const reason of options.reasons ?? []) {
      assertTraceLabel("reasons", reason, TRACE_SHORT_LABEL_MAX);
    }
    const event: TraceCompactionEvent = {
      v: TRACE_FORMAT_VERSION,
      type: "compaction",
      seq: this.#nextSeq(),
      timestamp: observation.timestamp,
      sessionId,
      action: options.action ?? "COMPACT",
      beforeTokens: observation.beforeTokens,
      afterTokens: observation.afterTokens,
      success: observation.success,
    };
    if (options.callId !== undefined) {
      event.callId = options.callId;
    }
    if (options.durationMs !== undefined) {
      event.durationMs = options.durationMs;
    }
    if (options.errorCode !== undefined) {
      event.errorCode = options.errorCode;
    }
    if (options.reason !== undefined) {
      event.reason = options.reason;
    }
    if (options.initiatedBy !== undefined) {
      event.initiatedBy = options.initiatedBy;
    }
    if (options.reasons !== undefined && options.reasons.length > 0) {
      event.reasons = [...options.reasons];
    }
    if (options.policyLatencyMs !== undefined) {
      event.policyLatencyMs = options.policyLatencyMs;
    }

    const usage: NonNullable<TraceCompactionEvent["usage"]> = {};
    if (observation.promptTokens !== undefined) {
      usage.promptTokens = observation.promptTokens;
    }
    if (observation.cachedInputTokens !== undefined) {
      usage.cachedInputTokens = observation.cachedInputTokens;
    }
    if (observation.cacheWriteTokens !== undefined) {
      usage.cacheWriteTokens = observation.cacheWriteTokens;
    }
    if (observation.outputTokens !== undefined) {
      usage.outputTokens = observation.outputTokens;
    }
    if (observation.actualCost !== undefined) {
      usage.actualCost = observation.actualCost;
    }
    if (Object.keys(usage).length > 0) {
      event.usage = usage;
    }
    return event;
  }

  /** Records the end of a session, which is what makes the horizon measurable. */
  sessionEnd(
    sessionId: string,
    observation: SessionEndObservation,
    options: { reason?: string } = {},
  ): TraceSessionEndEvent {
    assertTraceLabel("sessionId", sessionId);
    if (options.reason !== undefined) {
      assertTraceLabel("reason", options.reason, TRACE_SHORT_LABEL_MAX);
    }
    const event: TraceSessionEndEvent = {
      v: TRACE_FORMAT_VERSION,
      type: "session_end",
      seq: this.#nextSeq(),
      timestamp: observation.timestamp,
      sessionId,
    };
    if (options.reason !== undefined) {
      event.reason = options.reason;
    }
    return event;
  }

  #nextSeq(): number {
    this.#seq += 1;
    return this.#seq;
  }
}

function traceProfile(profile: FoldPointProfile): TraceProfile {
  const traced: TraceProfile = {
    model: profile.model,
    contextWindowTokens: profile.contextWindowTokens,
    compactorId: profile.compactorId,
  };
  if (profile.provider !== undefined) {
    traced.provider = profile.provider;
  }
  if (profile.prefixId !== undefined) {
    traced.prefixId = profile.prefixId;
  }
  if (profile.pricing !== undefined) {
    traced.pricing = { ...profile.pricing };
  }
  if (profile.cachePolicy !== undefined) {
    traced.cachePolicy = { ...profile.cachePolicy };
  }
  return traced;
}

function traceInput(input: FoldPointInput): TraceInput {
  const traced: TraceInput = { contextTokens: input.contextTokens };
  if (input.cachedTokens !== undefined) {
    traced.cachedTokens = input.cachedTokens;
  }
  if (input.idleMs !== undefined) {
    traced.idleMs = input.idleMs;
  }
  if (input.expectedFutureCalls !== undefined) {
    traced.expectedFutureCalls = input.expectedFutureCalls;
  }
  if (input.safeBoundary !== undefined) {
    traced.safeBoundary = input.safeBoundary;
  }
  if (input.compactionAllowed !== undefined) {
    traced.compactionAllowed = input.compactionAllowed;
  }
  if (input.cacheExpiresAt !== undefined) {
    traced.cacheExpiresAt = input.cacheExpiresAt;
  }
  if (input.fixedPrefixTokens !== undefined) {
    traced.fixedPrefixTokens = input.fixedPrefixTokens;
  }
  return traced;
}

function tracePrediction(decision: FoldPointDecision): TracePrediction {
  const metrics = decision.metrics;
  return {
    utilization: metrics.utilization,
    remainingTokens: metrics.remainingTokens,
    estimatedCurrentCallReplayCost: metrics.estimatedCurrentCallReplayCost,
    estimatedLaterCallReplayCost: metrics.estimatedLaterCallReplayCost,
    estimatedKeepCost: metrics.estimatedKeepCost,
    estimatedCompactCallCost: metrics.estimatedCompactCallCost,
    estimatedFirstPostCompactReplayCost: metrics.estimatedFirstPostCompactReplayCost,
    estimatedCompactCost: metrics.estimatedCompactCost,
    estimatedNetSaving: metrics.estimatedNetSaving,
    adjustedNetSaving: metrics.adjustedNetSaving,
    breakEvenCalls: metrics.breakEvenCalls,
    expectedFutureCalls: metrics.expectedFutureCalls,
    effectiveHorizonCalls: metrics.effectiveHorizonCalls,
    estimatedPostCompactTokens: metrics.estimatedPostCompactTokens,
    estimatedReclaimRatio: metrics.estimatedReclaimRatio,
    estimatedCacheCoverageRatio: metrics.estimatedCacheCoverageRatio,
    estimatedCacheAliveProbability: metrics.estimatedCacheAliveProbability,
    estimatedCacheLaterAliveProbability: metrics.estimatedCacheLaterAliveProbability,
    estimatedEffectiveCachedTokens: metrics.estimatedEffectiveCachedTokens,
    estimatedCacheLaterCandidateTokens: metrics.estimatedCacheLaterCandidateTokens,
  };
}

const TRACE_EVENT_TYPES: readonly TraceEventType[] = [
  "header",
  "decision",
  "request",
  "cache_warm",
  "compaction",
  "session_end",
];

/**
 * Conservative charset for the free-form fields a trace carries (`sessionId`, `callId`,
 * `producer`, `reason`, `errorCode`).
 *
 * The format has no field for prompt text, but these fields are strings the host fills in, and
 * a string is a place content can end up by accident. Anything outside this charset is rejected
 * instead of written, so a label cannot become a sentence — or a credential.
 */
const TRACE_LABEL_PATTERN = /^[A-Za-z0-9._@:/+#-]+$/;
const TRACE_LABEL_MAX = 128;
const TRACE_SHORT_LABEL_MAX = 64;

function assertTraceLabel(name: string, value: unknown, max = TRACE_LABEL_MAX): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new RangeError(`Trace ${name} must be a non-empty string`);
  }
  if (value.length > max) {
    throw new RangeError(
      `Trace ${name} must be at most ${max} characters, received ${value.length}`,
    );
  }
  if (!TRACE_LABEL_PATTERN.test(value)) {
    throw new RangeError(
      `Trace ${name} must match ${TRACE_LABEL_PATTERN.source}: identifiers and labels only, never free text`,
    );
  }
}

/** True when the value looks like a trace event of this format version. */
export function isTraceEvent(value: unknown): value is TraceEvent {
  if (value === null || typeof value !== "object") {
    return false;
  }
  const event = value as { v?: unknown; type?: unknown };
  return (
    (event.v === 1 || event.v === TRACE_FORMAT_VERSION) &&
    typeof event.type === "string" &&
    (TRACE_EVENT_TYPES as readonly string[]).includes(event.type) &&
    (event.v !== 1 || event.type !== "cache_warm")
  );
}

/**
 * Validates one parsed event. Illegal data throws instead of being silently repaired, so a
 * malformed trace cannot quietly produce a wrong calibration number.
 *
 * Throws `RangeError`.
 */
export function validateTraceEvent(value: unknown): TraceEvent {
  if (!isTraceEvent(value)) {
    const version = (value as { v?: unknown } | null)?.v;
    if (version !== undefined && version !== 1 && version !== TRACE_FORMAT_VERSION) {
      throw new RangeError(
        `Trace event version ${String(version)} is not supported (expected 1 or ${TRACE_FORMAT_VERSION})`,
      );
    }
    throw new RangeError("Trace event must carry a supported `v` and a known `type`");
  }

  const event = value as TraceEvent;
  assertFinite("timestamp", (event as { timestamp?: unknown }).timestamp);
  assertFinite("seq", (event as { seq?: unknown }).seq);

  if (event.type !== "header") {
    assertTraceLabel("sessionId", (event as { sessionId?: unknown }).sessionId);
  }

  switch (event.type) {
    case "header":
      if (event.producer !== undefined) {
        assertTraceLabel("producer", event.producer, TRACE_SHORT_LABEL_MAX);
      }
      return event;
    case "decision": {
      assertTraceLabel("callId", event.callId);
      assertNonEmptyString("profile.model", event.profile?.model);
      if (event.profile?.prefixId !== undefined) {
        assertTraceLabel("profile.prefixId", event.profile.prefixId);
      }
      assertFinite("input.contextTokens", event.input?.contextTokens, 0);
      if (event.input?.fixedPrefixTokens !== undefined) {
        assertFinite("input.fixedPrefixTokens", event.input.fixedPrefixTokens, 0);
        if (event.input.fixedPrefixTokens > event.input.contextTokens) {
          throw new RangeError(
            `Trace input.fixedPrefixTokens (${event.input.fixedPrefixTokens}) must not exceed input.contextTokens (${event.input.contextTokens})`,
          );
        }
      }
      assertNonEmptyString("decision.action", event.decision?.action);
      assertFinite(
        "prediction.estimatedCurrentCallReplayCost",
        event.prediction?.estimatedCurrentCallReplayCost,
      );
      return event;
    }
    case "request": {
      assertTraceLabel("callId", event.callId);
      assertFinite("usage.promptTokens", event.usage?.promptTokens, 0);
      if (event.usage.cachedInputTokens !== undefined) {
        assertFinite("usage.cachedInputTokens", event.usage.cachedInputTokens, 0);
      }
      if (event.usage.cacheWriteTokens !== undefined) {
        assertFinite("usage.cacheWriteTokens", event.usage.cacheWriteTokens, 0);
      }
      if (event.usage.outputTokens !== undefined) {
        assertFinite("usage.outputTokens", event.usage.outputTokens, 0);
      }
      return event;
    }
    case "cache_warm": {
      assertFinite("usage.promptTokens", event.usage?.promptTokens, 0);
      assertFinite("usage.cachedInputTokens", event.usage?.cachedInputTokens, 0);
      assertFinite("usage.cacheWriteTokens", event.usage?.cacheWriteTokens, 0);
      assertFinite("usage.outputTokens", event.usage?.outputTokens, 0);
      assertFinite("usage.actualCost", event.usage?.actualCost, 0);
      if (event.usage.cachedInputTokens + event.usage.cacheWriteTokens > event.usage.promptTokens) {
        throw new RangeError("Trace cache_warm usage cannot exceed promptTokens");
      }
      return event;
    }
    case "compaction": {
      if (event.callId !== undefined) {
        assertTraceLabel("callId", event.callId);
      }
      if (event.errorCode !== undefined) {
        assertTraceLabel("errorCode", event.errorCode, TRACE_SHORT_LABEL_MAX);
      }
      if (
        event.initiatedBy !== undefined &&
        event.initiatedBy !== "host" &&
        event.initiatedBy !== "policy"
      ) {
        throw new RangeError('Trace event "initiatedBy" must be "host" or "policy"');
      }
      assertFinite("beforeTokens", event.beforeTokens, 0);
      assertFinite("afterTokens", event.afterTokens, 0);
      if (typeof event.success !== "boolean") {
        throw new RangeError('Trace event "success" must be a boolean');
      }
      return event;
    }
    case "session_end":
      if (event.reason !== undefined) {
        assertTraceLabel("reason", event.reason, TRACE_SHORT_LABEL_MAX);
      }
      return event;
  }
}

export interface TraceParseResult {
  events: TraceEvent[];
  /** Lines that could not be read, with the reason. A trace with errors is not usable. */
  errors: Array<{ line: number; message: string }>;
}

/**
 * Parses a JSONL trace. Blank lines are ignored; every other line must be a valid event, and
 * failures are collected instead of thrown so a reader can report exactly what is wrong.
 */
export function parseTraceJsonl(text: string): TraceParseResult {
  const events: TraceEvent[] = [];
  const errors: TraceParseResult["errors"] = [];

  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = (lines[index] ?? "").trim();
    if (line.length === 0) {
      continue;
    }
    try {
      events.push(validateTraceEvent(JSON.parse(line)));
    } catch (error) {
      errors.push({
        line: index + 1,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { events, errors };
}

function assertFinite(name: string, value: unknown, min = Number.NEGATIVE_INFINITY): void {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RangeError(
      `Trace event "${name}" must be a finite number, received ${String(value)}`,
    );
  }
  if (value < min) {
    throw new RangeError(`Trace event "${name}" must be >= ${min}, received ${value}`);
  }
}

function assertNonEmptyString(name: string, value: unknown): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new RangeError(`Trace event "${name}" must be a non-empty string`);
  }
}
