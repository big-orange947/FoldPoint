/**
 * FoldPoint observer for Pi — observe-only, payload-free.
 *
 * Copy this file into `~/.pi/agent/extensions/foldpoint-observe.ts` (Pi loads TypeScript
 * directly through jiti) and point it at a trace file:
 *
 * ```bash
 * FOLDPOINT_TRACE=~/.foldpoint/traces/pi.jsonl pi
 * ```
 *
 * What it does: it runs FoldPoint before every model call, records what FoldPoint *would* have
 * decided, records the usage Pi reports after the call, and records compactions Pi performed.
 * It never compacts, never cancels, never modifies context, and never reads a request payload —
 * it does not subscribe to `before_provider_request` at all. FoldPoint is not wired into Pi's
 * compaction here on purpose: the first job is to find out whether the model's predictions
 * match a real Pi session, and an integration that acts on them would change the very data
 * being measured.
 *
 * The event names and payload fields below are the subset this adapter uses from Pi's extension
 * types (`packages/coding-agent/src/core/extensions/types.ts`) and Pi's `Usage` shape
 * (`{ input, output, cacheRead, cacheWrite }`). Re-check them against the Pi version you run.
 *
 * Privacy: the trace has no field for prompts, tool output or chat content, and this adapter
 * never writes a raw session id. Sessions are keyed by a runtime counter, not by Pi's session
 * file or UUID, so a trace cannot be joined back to a conversation by its identifiers.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  FoldPoint,
  type FoldPointDefaults,
  type FoldPointProfile,
  type PricingSnapshot,
  type TraceEvent,
  type TraceOutcome,
  TraceRecorder,
} from "../../src/index";

/**
 * Bumped to 0.2.0 when the prompt accounting changed: 0.1.0 recorded Pi's uncached input as the
 * whole prompt, so a 0.1.0 trace under-counts every call by its cache hits.
 */
export const ADAPTER_VERSION = "0.2.0";

// ============================================================================
// The slice of Pi's extension API this adapter uses (structural, not imported)
// ============================================================================

export interface PiModelCost {
  /** USD per million tokens. */
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface PiModel {
  id: string;
  provider: string;
  contextWindow: number;
  cost?: PiModelCost;
  /** Prompt-cache lifetime in seconds per retention tier. */
  promptCache?: Partial<Record<"short" | "long", number>>;
}

/** Pi's token accounting for one model call. */
export interface PiUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

export interface PiAssistantMessage {
  role: string;
  usage?: PiUsage;
  stopReason?: string;
}

export interface PiContextUsage {
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export interface PiExtensionContext {
  model: PiModel | undefined;
  cwd: string;
  getContextUsage(): PiContextUsage | undefined;
}

export type PiCompactionReason = "manual" | "threshold" | "overflow";

export interface PiEventMap {
  session_start: { type: "session_start"; reason: string };
  context: { type: "context" };
  message_end: { type: "message_end"; message: PiAssistantMessage };
  session_before_compact: {
    type: "session_before_compact";
    reason: PiCompactionReason;
    preparation: { tokensBefore?: number };
  };
  session_compact: {
    type: "session_compact";
    reason: PiCompactionReason;
    compactionEntry: { tokensBefore: number; usage?: PiUsage };
  };
  session_compact_failed: {
    type: "session_compact_failed";
    reason: PiCompactionReason;
    aborted: boolean;
  };
  session_shutdown: { type: "session_shutdown"; reason: string };
}

export interface PiExtensionAPI {
  on<K extends keyof PiEventMap>(
    event: K,
    handler: (event: PiEventMap[K], ctx: PiExtensionContext) => void,
  ): () => void;
}

/** Exactly the events this adapter subscribes to. Nothing else is read. */
export const OBSERVED_EVENTS: readonly (keyof PiEventMap)[] = [
  "session_start",
  "context",
  "message_end",
  "session_before_compact",
  "session_compact",
  "session_compact_failed",
  "session_shutdown",
];

// ============================================================================
// Adapter
// ============================================================================

export interface FoldPointObserverOptions {
  /** Where the JSONL trace goes. Defaults to `$FOLDPOINT_TRACE` or `~/.foldpoint/traces`. */
  tracePath?: string;
  /** FoldPoint defaults to run with. Defaults to `$FOLDPOINT_DEFAULTS` (JSON) or the library's. */
  defaults?: Partial<FoldPointDefaults>;
  /** Clock, for tests. */
  now?: () => number;
  /** Sink for the pairing diagnostics this adapter prints. */
  log?: (message: string) => void;
}

interface PendingDecision {
  callId: string;
  at: number;
}

interface PendingCompaction {
  reason: PiCompactionReason;
  tokensBefore: number;
  usage: PiUsage | undefined;
  at: number;
}

interface ObserverState {
  sessionKey: string | null;
  decisions: PendingDecision[];
  unpairedRequests: number;
  unpairedDecisions: number;
  skippedDecisions: number;
  pendingCompaction: PendingCompaction | null;
  lastCallAt: number | undefined;
  lastProfile: FoldPointProfile | undefined;
  failedCalls: number;
  /** Diagnostics that must not repeat on every call. */
  warned: Set<string>;
}

/**
 * The whole prompt of a call, in the units the trace records.
 *
 * Pi reports `Usage.input` as the *uncached* part of the prompt, with `cacheRead` and
 * `cacheWrite` beside it. A FoldPoint prediction is expressed over the whole prompt, with the
 * cached part as a subset of it, so the two must be added back together here - otherwise every
 * cached token would look like a prompt token that does not exist, and the cost of a call would
 * be under-counted by exactly its cache hits.
 */
function totalPromptTokens(usage: PiUsage): number {
  return usage.input + usage.cacheRead + usage.cacheWrite;
}

function pricingFromModel(model: PiModel): PricingSnapshot | undefined {
  const cost = model.cost;
  if (cost === undefined) {
    return undefined;
  }
  const pricing: PricingSnapshot = {
    currency: "USD",
    inputPerMillion: cost.input,
    outputPerMillion: cost.output,
    source: `pi:${model.provider}/${model.id}`,
  };
  if (cost.cacheRead > 0) {
    pricing.cacheReadPerMillion = cost.cacheRead;
  }
  if (cost.cacheWrite > 0) {
    pricing.cacheWritePerMillion = cost.cacheWrite;
  }
  return pricing;
}

function profileFromModel(model: PiModel): FoldPointProfile {
  const profile: FoldPointProfile = {
    provider: model.provider,
    model: model.id,
    contextWindowTokens: model.contextWindow,
    compactorId: "pi-compaction",
  };
  const pricing = pricingFromModel(model);
  if (pricing !== undefined) {
    profile.pricing = pricing;
  }
  const shortTtlSeconds = model.promptCache?.short;
  if (shortTtlSeconds !== undefined && shortTtlSeconds > 0) {
    profile.cachePolicy = { ttlMs: shortTtlSeconds * 1_000 };
  }
  return profile;
}

function readDefaultsFromEnv(): Partial<FoldPointDefaults> | undefined {
  const raw = process.env.FOLDPOINT_DEFAULTS;
  if (raw === undefined || raw.trim().length === 0) {
    return undefined;
  }
  return JSON.parse(raw) as Partial<FoldPointDefaults>;
}

/**
 * What Pi says happened to the call. `error` and `aborted` calls never reached the cache and
 * report zeroed usage, so they are recorded but never used to teach FoldPoint anything.
 */
function outcomeFromStopReason(stopReason: string | undefined): TraceOutcome {
  if (stopReason === "error") {
    return "error";
  }
  if (stopReason === "aborted" || stopReason === "pending") {
    return "aborted";
  }
  return "ok";
}

function defaultTracePath(now: () => number): string {
  const fromEnv = process.env.FOLDPOINT_TRACE;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  return join(homedir(), ".foldpoint", "traces", `pi-${Math.floor(now() / 1_000)}.jsonl`);
}

/**
 * Builds the Pi extension factory. The default export below is what Pi calls; this named
 * factory exists so the adapter can be driven with explicit options (and tested).
 */
export function createFoldPointObserver(
  options: FoldPointObserverOptions = {},
): (pi: PiExtensionAPI) => void {
  const now = options.now ?? (() => Date.now());
  const log = options.log ?? ((message: string) => console.error(message));

  return function foldPointObserver(pi: PiExtensionAPI): void {
    const tracePath = options.tracePath ?? defaultTracePath(now);
    const defaults = options.defaults ?? readDefaultsFromEnv();
    const trace = new TraceRecorder({ producer: `pi-observer@${ADAPTER_VERSION}`, now });
    const foldPoint = new FoldPoint(defaults === undefined ? undefined : { defaults });
    const runtimeStartSeconds = Math.floor(now() / 1_000);
    let sessionCount = 0;

    const state: ObserverState = {
      sessionKey: null,
      decisions: [],
      unpairedRequests: 0,
      unpairedDecisions: 0,
      skippedDecisions: 0,
      pendingCompaction: null,
      lastCallAt: undefined,
      lastProfile: undefined,
      failedCalls: 0,
      warned: new Set<string>(),
    };

    // A silent early return is the hardest failure to diagnose from a trace that only has its
    // header, so every one of them says why, once per session.
    const warnOnce = (key: string, message: string): void => {
      if (state.warned.has(key)) {
        return;
      }
      state.warned.add(key);
      log(`[foldpoint] ${message}`);
    };

    const write = (event: TraceEvent): void => {
      mkdirSync(dirname(tracePath), { recursive: true });
      appendFileSync(tracePath, `${JSON.stringify(event)}\n`, "utf8");
    };

    write(trace.header());

    pi.on("session_start", () => {
      sessionCount += 1;
      // A runtime-scoped key: unique per session of this Pi process, and not Pi's own session
      // id or file path, so the trace cannot be joined back to a conversation.
      state.sessionKey = `pi-${runtimeStartSeconds}-${sessionCount}`;
      state.decisions = [];
      state.pendingCompaction = null;
      state.lastCallAt = undefined;
      state.lastProfile = undefined;
      log(`[foldpoint] observing session ${state.sessionKey} -> ${tracePath}`);
    });

    // Before every model call. Pi knows the context size here; it does not know the cache
    // usage of the call it is about to make, so neither the input nor the trace pretends it
    // does — `cachedTokens` is deliberately omitted and the model falls back to what it has
    // learned, which is what makes the later comparison meaningful.
    pi.on("context", (_event, ctx) => {
      const sessionKey = state.sessionKey;
      const model = ctx.model;
      if (sessionKey === null) {
        warnOnce(
          "no-session",
          "a model call arrived before session_start; nothing is being recorded (Pi started with --no-session?)",
        );
        return;
      }
      if (model === undefined) {
        warnOnce("no-model", "Pi reported no model, so no decision could be made");
        return;
      }

      // A compaction that Pi finished since the last call: only now is the new context size
      // known, so the compaction record is written here. Pi reports `tokens: null` until the
      // first response after a compaction, so the record waits for the first event that does
      // know the size - that prompt is the post-compaction context, which is what the
      // retention comparison needs.
      const pending = state.pendingCompaction;
      if (pending !== null) {
        const afterTokens = ctx.getContextUsage()?.tokens ?? null;
        if (afterTokens !== null) {
          state.pendingCompaction = null;
          const profile = profileFromModel(model);
          const observation = {
            timestamp: pending.at,
            beforeTokens: pending.tokensBefore,
            afterTokens,
            success: true,
            ...(pending.usage === undefined
              ? {}
              : {
                  promptTokens: totalPromptTokens(pending.usage),
                  cachedInputTokens: pending.usage.cacheRead,
                  cacheWriteTokens: pending.usage.cacheWrite,
                  outputTokens: pending.usage.output,
                }),
          };
          foldPoint.recordCompaction(sessionKey, profile, observation);
          write(trace.compaction(sessionKey, observation, { action: "COMPACT" }));
        }
      }

      const usage = ctx.getContextUsage();
      if (usage?.tokens === null || usage === undefined) {
        // Pi does not know the context size right after a compaction: skip, and count it.
        state.skippedDecisions += 1;
        return;
      }

      const profile = profileFromModel(model);
      const timestamp = now();
      const idleMs =
        state.lastCallAt === undefined ? undefined : Math.max(0, timestamp - state.lastCallAt);
      const input = {
        sessionId: sessionKey,
        profile,
        timestamp,
        contextTokens: usage.tokens,
        safeBoundary: true,
        compactionAllowed: true,
        ...(idleMs === undefined ? {} : { idleMs }),
      };

      const decision = foldPoint.decide(input);
      const event = trace.decision(input, decision);
      state.decisions.push({ callId: event.callId, at: timestamp });
      write(event);

      if (decision.action !== "KEEP") {
        // Observe-only: this is what FoldPoint would have done, not something Pi does.
        log(
          `[foldpoint] would ${decision.action} (${decision.reasons.join(",")}) at ${usage.tokens}/${usage.contextWindow} tokens`,
        );
      }
    });

    // After the call: the real usage, which is what the decision above is measured against.
    pi.on("message_end", (event, ctx) => {
      const sessionKey = state.sessionKey;
      const usage = event.message.usage;
      if (sessionKey === null) {
        warnOnce(
          "no-session",
          "a model call arrived before session_start; nothing is being recorded (Pi started with --no-session?)",
        );
        return;
      }
      if (event.message.role !== "assistant") {
        // User and tool-result messages fire this event too; they carry no model usage.
        return;
      }
      if (usage === undefined) {
        warnOnce(
          "no-usage",
          "an assistant message carried no usage, so its cost and cache read cannot be recorded",
        );
        return;
      }

      const pending = state.decisions.shift();
      state.lastCallAt = now();
      const observation = {
        timestamp: pending?.at ?? now(),
        promptTokens: totalPromptTokens(usage),
        cachedInputTokens: usage.cacheRead,
        cacheWriteTokens: usage.cacheWrite,
        outputTokens: usage.output,
      };
      const outcome = outcomeFromStopReason(event.message.stopReason);
      if (pending === undefined) {
        // The decision for this call was skipped (Pi does not know the context size right
        // after a compaction). The usage is still measured data, so it goes into the trace
        // under a label that cannot collide with a callId; nothing can be compared against it,
        // and the analyzer counts it instead of guessing.
        state.unpairedRequests += 1;
        log("[foldpoint] a model call finished with no decision recorded before it");
        write(
          trace.request(
            sessionKey,
            `${sessionKey}#unpaired-${state.unpairedRequests}`,
            observation,
            {
              outcome,
            },
          ),
        );
        return;
      }
      if (outcome === "ok") {
        // Learning state is per profile: without a model there is no profile to learn into, so
        // the trace still gets the usage but FoldPoint is left alone.
        const model = ctx.model;
        if (model === undefined) {
          warnOnce(
            "no-model-at-end",
            "a call finished while Pi reported no model; learning skipped",
          );
        } else {
          state.lastProfile = profileFromModel(model);
          foldPoint.observeRequest(sessionKey, state.lastProfile, observation);
        }
      } else {
        // A call that errored or was aborted never reached the cache and reports zeroed usage.
        // Recording it is honest; teaching FoldPoint from it would be a lie.
        state.failedCalls += 1;
      }
      write(trace.request(sessionKey, pending.callId, observation, { outcome }));
    });

    // Pi is about to compact. This handler returns nothing: it cannot cancel or change it.
    pi.on("session_before_compact", (event) => {
      if (state.sessionKey === null) {
        return;
      }
      state.pendingCompaction = {
        reason: event.reason,
        tokensBefore: event.preparation.tokensBefore ?? 0,
        usage: undefined,
        at: now(),
      };
    });

    pi.on("session_compact", (event) => {
      if (state.sessionKey === null) {
        return;
      }
      state.pendingCompaction = {
        reason: event.reason,
        tokensBefore: event.compactionEntry.tokensBefore,
        usage: event.compactionEntry.usage,
        at: now(),
      };
    });

    pi.on("session_compact_failed", (event) => {
      const sessionKey = state.sessionKey;
      if (sessionKey === null) {
        return;
      }
      // A failed compaction changes nothing, so `afterTokens` is `beforeTokens`. The token
      // count comes from the `session_before_compact` that preceded it; when Pi did not
      // report one, the attempt is logged instead of recorded with a made-up size.
      const pending = state.pendingCompaction;
      state.pendingCompaction = null;
      if (pending === null || pending.tokensBefore <= 0) {
        log(
          `[foldpoint] a compaction attempt ${event.aborted ? "was aborted" : "failed"} without a known size`,
        );
        return;
      }
      write(
        trace.compaction(
          sessionKey,
          {
            timestamp: pending.at,
            beforeTokens: pending.tokensBefore,
            afterTokens: pending.tokensBefore,
            success: false,
          },
          { action: "COMPACT", errorCode: event.aborted ? "aborted" : "failed" },
        ),
      );
    });

    pi.on("session_shutdown", () => {
      const sessionKey = state.sessionKey;
      if (sessionKey === null) {
        return;
      }
      state.unpairedDecisions += state.decisions.length;
      const profile = state.lastProfile;
      if (profile !== undefined) {
        foldPoint.endSession(sessionKey, profile, { timestamp: now() });
      }
      write(trace.sessionEnd(sessionKey, { timestamp: now() }, { reason: "shutdown" }));

      if (
        state.unpairedDecisions > 0 ||
        state.unpairedRequests > 0 ||
        state.skippedDecisions > 0 ||
        state.failedCalls > 0
      ) {
        log(
          `[foldpoint] session ${sessionKey}: ${state.unpairedDecisions} decision(s) without a request, ${state.unpairedRequests} request(s) without a decision, ${state.skippedDecisions} decision(s) skipped for an unknown context size, ${state.failedCalls} failed call(s) excluded from learning`,
        );
      }
      state.sessionKey = null;
      state.decisions = [];
      state.lastProfile = undefined;
      state.failedCalls = 0;
    });
  };
}

export default createFoldPointObserver();
