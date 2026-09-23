/**
 * Trace capture example: how a host records a real session for validation.
 *
 * ```bash
 * npm run trace:capture
 * npm run trace:analyze -- traces/example.jsonl
 * ```
 *
 * This file is a **wiring example**, not a benchmark. The `FakeProvider` at the bottom stands
 * in for a real model + provider so the example runs offline; replace it with your own client
 * and keep the four hook calls:
 *
 * 1. `recorder.decision(input, decision)` **before** the request — this is where the model's
 *    estimates are recorded, and where the actual cache usage is still unknown;
 * 2. `recorder.request(sessionId, callId, usage)` **after** the request returns — the actual
 *    prompt/cache-read/cache-write/output tokens the provider reported;
 * 3. `recorder.compaction(sessionId, observation)` after a compaction attempt;
 * 4. `recorder.sessionEnd(sessionId, { timestamp })` when the session ends.
 *
 * Every event is metadata only. Nothing here reads or writes prompt text, tool output or chat
 * content, and the trace file never contains a credential.
 */

import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FoldPoint,
  type FoldPointProfile,
  type RequestObservation,
  type TraceEvent,
  TraceRecorder,
} from "../src/index";

const TRACE_PATH = resolve(
  join(dirname(fileURLToPath(import.meta.url)), "..", "traces", "example.jsonl"),
);

const BASE_TIMESTAMP = 1_700_000_000_000;

const PROFILE: FoldPointProfile = {
  provider: "example",
  model: "example-model",
  contextWindowTokens: 200_000,
  compactorId: "example-compactor",
  pricing: {
    currency: "USD",
    inputPerMillion: 3,
    outputPerMillion: 15,
    cacheReadPerMillion: 0.3,
    cacheWritePerMillion: 3.75,
  },
  cachePolicy: { ttlMs: 120_000 },
};

/** One line of JSONL per event. This is the whole writer. */
function append(tracePath: string, event: TraceEvent): void {
  appendFileSync(tracePath, `${JSON.stringify(event)}\n`, "utf8");
}

interface ScriptedSession {
  sessionId: string;
  calls: number;
  growthPerCall: number;
  startTokens: number;
  idleMs: number;
  /** The provider cache holds the prefix only while the gap stays below the TTL. */
  cacheHolds: boolean;
}

const SESSIONS: ScriptedSession[] = [
  // A warm session: every call reuses the prefix.
  {
    sessionId: "warm",
    calls: 12,
    growthPerCall: 6_000,
    startTokens: 20_000,
    idleMs: 10_000,
    cacheHolds: true,
  },
  // A cold session: every gap exceeds the TTL, so every call rewrites its prompt.
  {
    sessionId: "cold",
    calls: 12,
    growthPerCall: 6_000,
    startTokens: 20_000,
    idleMs: 400_000,
    cacheHolds: false,
  },
  // One-off expiry: the cache lapses once in the middle and recovers.
  {
    sessionId: "one-off",
    calls: 12,
    growthPerCall: 6_000,
    startTokens: 20_000,
    idleMs: 10_000,
    cacheHolds: true,
  },
];

/**
 * A stand-in for a real client. It answers with plausible token accounting and a cache that
 * follows the profile's TTL. Replace it with your provider call.
 */
class FakeProvider {
  #lastPromptTokens = 0;
  #lastCallAt: number | undefined;
  readonly #ttlMs: number;

  constructor(ttlMs: number) {
    this.#ttlMs = ttlMs;
  }

  /** What the host can know *before* the call: the cache state of the previous prefix. */
  expectedCachedTokens(timestamp: number, promptTokens: number): number {
    const alive = this.#lastCallAt !== undefined && timestamp - this.#lastCallAt < this.#ttlMs;
    return alive ? Math.min(this.#lastPromptTokens, promptTokens) : 0;
  }

  call(timestamp: number, promptTokens: number, outputTokens: number): RequestObservation {
    const cachedInputTokens = this.expectedCachedTokens(timestamp, promptTokens);
    const observation: RequestObservation = {
      timestamp,
      promptTokens,
      cachedInputTokens,
      cacheWriteTokens: promptTokens - cachedInputTokens,
      outputTokens,
    };
    this.#lastPromptTokens = promptTokens;
    this.#lastCallAt = timestamp;
    return observation;
  }

  reset(): void {
    this.#lastPromptTokens = 0;
    this.#lastCallAt = undefined;
  }
}

function runSession(tracePath: string, script: ScriptedSession, recorder: TraceRecorder): void {
  const foldPoint = new FoldPoint();
  const provider = new FakeProvider(PROFILE.cachePolicy?.ttlMs ?? 0);
  let contextTokens = script.startTokens;
  let timestamp = BASE_TIMESTAMP;

  for (let step = 0; step < script.calls; step += 1) {
    // A one-off expiry in the middle of the session: the gap exceeds the TTL exactly once.
    const idleMs = script.sessionId === "one-off" && step === 5 ? 400_000 : script.idleMs;
    timestamp += idleMs;

    const input = {
      sessionId: script.sessionId,
      profile: PROFILE,
      timestamp,
      contextTokens,
      cachedTokens: provider.expectedCachedTokens(timestamp, contextTokens),
      idleMs,
      safeBoundary: true,
      compactionAllowed: true,
      expectedFutureCalls: script.calls - step,
    };

    // --- 1. decide, and record the estimates before anything is known ---
    const started = performance.now();
    const decision = foldPoint.decide(input);
    const event = recorder.decision(input, decision, {
      decisionLatencyMs: performance.now() - started,
    });
    append(tracePath, event);

    if (decision.action !== "KEEP") {
      const beforeTokens = contextTokens;
      const afterTokens = Math.round(beforeTokens * 0.3);
      const compactionOutputTokens = Math.round(beforeTokens * 0.1);
      const compactionUsage: RequestObservation = {
        timestamp,
        promptTokens: beforeTokens,
        cachedInputTokens: 0,
        cacheWriteTokens: beforeTokens,
        outputTokens: compactionOutputTokens,
      };
      foldPoint.recordCompaction(script.sessionId, PROFILE, {
        ...compactionUsage,
        beforeTokens,
        afterTokens,
        success: true,
      });
      append(
        tracePath,
        recorder.compaction(
          script.sessionId,
          { ...compactionUsage, beforeTokens, afterTokens, success: true },
          { action: decision.action, callId: event.callId },
        ),
      );
      contextTokens = afterTokens;
      provider.reset();
    }

    // --- 2. the real call, and the usage the provider reports afterwards ---
    const usage = provider.call(timestamp, contextTokens, 400);
    foldPoint.observeRequest(script.sessionId, PROFILE, usage);
    append(tracePath, recorder.request(script.sessionId, event.callId, usage, { outcome: "ok" }));

    contextTokens += script.growthPerCall;
  }

  // --- 4. the session ends, which is what makes the horizon measurable ---
  foldPoint.endSession(script.sessionId, PROFILE, { timestamp });
  append(tracePath, recorder.sessionEnd(script.sessionId, { timestamp }, { reason: "completed" }));
}

function main(): void {
  mkdirSync(dirname(TRACE_PATH), { recursive: true });
  // Start from an empty file so the example is reproducible.
  writeFileSync(TRACE_PATH, "", "utf8");

  const recorder = new TraceRecorder({ producer: "trace-capture-example" });
  append(TRACE_PATH, recorder.header());

  for (const script of SESSIONS) {
    runSession(TRACE_PATH, script, recorder);
  }

  console.log(`wrote ${TRACE_PATH}`);
  console.log("analyse it with: npm run trace:analyze -- traces/example.jsonl");
}

main();
