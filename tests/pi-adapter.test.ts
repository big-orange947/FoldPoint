import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createFoldPointObserver,
  type PiEventMap,
  type PiExtensionAPI,
  type PiExtensionContext,
  type PiModel,
} from "../adapters/pi/foldpoint-observe";
import { parseTraceJsonl, type TraceEvent } from "../src/index";
import { analyzeTraceEvents } from "../tools/trace-analyze";

const MODEL: PiModel = {
  id: "claude-sonnet-4-5",
  provider: "anthropic",
  contextWindow: 200_000,
  cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  promptCache: { short: 300 },
};

interface FakePi {
  pi: PiExtensionAPI;
  registered: string[];
  emit<K extends keyof PiEventMap>(
    event: K,
    payload: PiEventMap[K],
    ctx?: PiExtensionContext,
  ): unknown;
  /** A context whose reported usage changes between calls. */
  ctxWith(
    tokens: number | null,
    model?: PiModel | undefined,
    systemPrompt?: string,
  ): PiExtensionContext;
}

function fakePi(): FakePi {
  const handlers = new Map<string, Array<(event: never, ctx: PiExtensionContext) => unknown>>();
  const registered: string[] = [];
  const pi: PiExtensionAPI = {
    on(event, handler) {
      registered.push(event);
      const list = handlers.get(event) ?? [];
      list.push(handler as (event: never, ctx: PiExtensionContext) => void);
      handlers.set(event, list);
      return () => undefined;
    },
  };
  const defaultCtx: PiExtensionContext = {
    model: MODEL,
    cwd: "/tmp/project",
    getContextUsage: () => ({ tokens: 50_000, contextWindow: 200_000, percent: 25 }),
    getSystemPrompt: () => SYSTEM_PROMPT,
  };
  return {
    pi,
    registered,
    emit(event, payload, ctx = defaultCtx) {
      let result: unknown;
      for (const handler of handlers.get(event) ?? []) {
        result = (handler as unknown as (event: unknown, ctx: PiExtensionContext) => unknown)(
          payload,
          ctx,
        );
      }
      return result;
    },
    ctxWith(tokens, model = MODEL, systemPrompt = SYSTEM_PROMPT) {
      return {
        model,
        cwd: "/tmp/project",
        getContextUsage: () =>
          tokens === null
            ? { tokens: null, contextWindow: 200_000, percent: null }
            : { tokens, contextWindow: 200_000, percent: tokens / 2_000 },
        getSystemPrompt: () => systemPrompt,
      };
    },
  };
}

function readTrace(path: string): TraceEvent[] {
  const parsed = parseTraceJsonl(readFileSync(path, "utf8"));
  expect(parsed.errors).toEqual([]);
  return parsed.events;
}

function newTracePath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "foldpoint-pi-")), `${name}.jsonl`);
}

/** A prefix store of its own per test, so measurements cannot leak between them. */
function newPrefixStorePath(name: string): string {
  return join(mkdtempSync(join(tmpdir(), "foldpoint-prefix-")), `${name}.json`);
}

const SYSTEM_PROMPT = "You are a coding agent.\n\n## Tools\nread, bash, edit, write\n";

describe("Pi observer adapter", () => {
  it("prices successful Pi cache warming separately and uses its refresh time for TTL", () => {
    const path = newTracePath("cache-warming");
    const fake = fakePi();
    let clock = 1_000_000;
    const entries: ReturnType<NonNullable<PiExtensionContext["sessionManager"]>["getEntries"]> = [];
    const ctx = { ...fake.ctxWith(50_000), sessionManager: { getEntries: () => entries } };
    createFoldPointObserver({ tracePath: path, now: () => clock, log: () => undefined })(fake.pi);

    fake.emit("session_start", { type: "session_start", reason: "startup" }, ctx);
    fake.emit("context", { type: "context" }, ctx);
    fake.emit(
      "message_end",
      {
        type: "message_end",
        message: {
          role: "assistant",
          usage: { input: 50_000, output: 10, cacheRead: 0, cacheWrite: 0 },
        },
      },
      ctx,
    );
    clock += 290_000;
    entries.push({
      id: "warm-1",
      type: "usage",
      kind: "cache_warm",
      provider: MODEL.provider,
      model: MODEL.id,
      timestamp: new Date(clock).toISOString(),
      usage: { input: 0, output: 1, cacheRead: 50_000, cacheWrite: 0, cost: { total: 0.02 } },
    });
    clock += 20_000; // 310s after the real call, but only 20s after the refresh (TTL=300s).
    fake.emit("context", { type: "context" }, ctx);
    fake.emit("context", { type: "context" }, ctx); // same persisted entry is not billed twice
    fake.emit("session_shutdown", { type: "session_shutdown", reason: "quit" }, ctx);

    const events = readTrace(path);
    const warms = events.filter((event) => event.type === "cache_warm");
    const decisions = events.filter((event) => event.type === "decision");
    expect(warms).toHaveLength(1);
    expect(decisions[1]?.input.idleMs).toBe(20_000);
    expect(decisions[1]?.prediction.estimatedCacheAliveProbability).toBe(1);
    const analysis = analyzeTraceEvents(events);
    expect(analysis.sessionCosts[0]?.cacheWarms).toBe(1);
    expect(analysis.sessionCosts[0]?.cacheWarmCost).toBe(0.02);
    expect(analysis.sessionCosts[0]?.totalCost).toBeCloseTo(
      (analysis.sessionCosts[0]?.callCost ?? 0) + 0.02,
    );
    expect(analysis.sessionCosts[0]?.calls).toBe(1);
  });

  it("subscribes only to the events it needs, and never to the request payload", () => {
    const fake = fakePi();
    createFoldPointObserver({ tracePath: newTracePath("events"), now: () => 1_000_000 })(fake.pi);

    expect(fake.registered).toEqual([
      "session_start",
      "context",
      "message_end",
      "session_before_compact",
      "session_compact",
      "session_compact_failed",
      "session_shutdown",
    ]);
    // `before_provider_request` carries the payload; the observer must not see it at all.
    expect(fake.registered).not.toContain("before_provider_request");
    expect(fake.registered).not.toContain("context_with_system");
  });

  it("records the decision before the call and the usage after it", () => {
    const path = newTracePath("pairing");
    const fake = fakePi();
    createFoldPointObserver({ tracePath: path, now: () => 1_000_000, log: () => undefined })(
      fake.pi,
    );

    fake.emit("session_start", { type: "session_start", reason: "startup" });
    fake.emit("context", { type: "context" }, fake.ctxWith(50_000));
    fake.emit("message_end", {
      type: "message_end",
      message: {
        role: "assistant",
        usage: { input: 50_000, output: 400, cacheRead: 0, cacheWrite: 50_000 },
        stopReason: "stop",
      },
    });
    fake.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

    const events = readTrace(path);
    const decision = events.find((event) => event.type === "decision");
    const request = events.find((event) => event.type === "request");

    expect(decision?.type).toBe("decision");
    expect(request?.type).toBe("request");
    if (decision?.type !== "decision" || request?.type !== "request") {
      throw new Error("missing decision or request");
    }
    // The estimate and the actual usage are separate events, paired by callId.
    expect(request.callId).toBe(decision.callId);
    expect("usage" in decision).toBe(false);
    expect("prediction" in request).toBe(false);
    expect(request.usage.cachedInputTokens).toBe(0);
    expect(request.usage.cacheWriteTokens).toBe(50_000);
    // The decision ran with the model's prices and its prompt-cache lifetime.
    expect(decision.profile.pricing?.inputPerMillion).toBe(3);
    expect(decision.profile.cachePolicy?.ttlMs).toBe(300_000);
    expect(decision.input.contextTokens).toBe(50_000);
    // The host does not guess the cache state: it reports no cached tokens before the call.
    expect(decision.input.cachedTokens).toBeUndefined();
    // The session key is runtime-scoped, not Pi's session id.
    expect(decision.sessionId).toMatch(/^pi-\d+-\d+$/);
    expect(events.some((event) => event.type === "session_end")).toBe(true);
  });

  it("reports unpaired calls instead of pairing the wrong ones", () => {
    const path = newTracePath("unpaired");
    const messages: string[] = [];
    const fake = fakePi();
    createFoldPointObserver({
      tracePath: path,
      now: () => 1_000_000,
      log: (message) => messages.push(message),
    })(fake.pi);

    fake.emit("session_start", { type: "session_start", reason: "startup" });
    // A call that finished with no decision recorded before it.
    fake.emit("message_end", {
      type: "message_end",
      message: { role: "assistant", usage: { input: 10, output: 1, cacheRead: 0, cacheWrite: 10 } },
    });
    // A decision that never got a call.
    fake.emit("context", { type: "context" }, fake.ctxWith(50_000));
    fake.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

    expect(messages.some((message) => message.includes("no decision recorded"))).toBe(true);
    expect(messages.some((message) => message.includes("decision(s) without a request"))).toBe(
      true,
    );
    // The usage is still real data, so it is recorded - under a label that no decision can
    // claim, so nothing downstream can pair it with the wrong prediction.
    const requests = readTrace(path).filter((event) => event.type === "request");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.callId).toContain("#unpaired-");
    expect(requests[0]?.usage.promptTokens).toBe(20);
    expect(requests[0]?.usage.cachedInputTokens).toBe(0);
    expect(requests[0]?.usage.cacheWriteTokens).toBe(10);
  });

  it("records the whole prompt, not Pi's uncached part of it", () => {
    const path = newTracePath("prompt-total");
    const fake = fakePi();
    createFoldPointObserver({ tracePath: path, now: () => 1_000_000, log: () => undefined })(
      fake.pi,
    );

    fake.emit("session_start", { type: "session_start", reason: "startup" });
    fake.emit("context", { type: "context" }, fake.ctxWith(50_000));
    // Pi reports the uncached part in `input` and the cached part beside it.
    fake.emit("message_end", {
      type: "message_end",
      message: {
        role: "assistant",
        usage: { input: 233, output: 371, cacheRead: 1_408, cacheWrite: 0 },
      },
    });
    fake.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

    const request = readTrace(path).find((event) => event.type === "request");
    expect(request?.type).toBe("request");
    if (request?.type !== "request") {
      throw new Error("missing request");
    }
    expect(request.usage.promptTokens).toBe(1_641);
    expect(request.usage.cachedInputTokens).toBe(1_408);
  });

  it("records a compaction with the size Pi reports after it", () => {
    const path = newTracePath("compaction");
    const fake = fakePi();
    createFoldPointObserver({ tracePath: path, now: () => 1_000_000, log: () => undefined })(
      fake.pi,
    );

    fake.emit("session_start", { type: "session_start", reason: "startup" });
    fake.emit("context", { type: "context" }, fake.ctxWith(120_000));
    fake.emit("message_end", {
      type: "message_end",
      message: {
        role: "assistant",
        usage: { input: 120_000, output: 300, cacheRead: 0, cacheWrite: 120_000 },
      },
    });
    fake.emit("session_before_compact", {
      type: "session_before_compact",
      reason: "threshold",
      preparation: { tokensBefore: 120_000 },
    });
    fake.emit("session_compact", {
      type: "session_compact",
      reason: "threshold",
      compactionEntry: {
        tokensBefore: 120_000,
        usage: { input: 120_000, output: 2_000, cacheRead: 0, cacheWrite: 120_000 },
      },
    });
    // The next model call is where the new context size becomes known.
    fake.emit("context", { type: "context" }, fake.ctxWith(35_000));
    fake.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

    const compactions = readTrace(path).filter((event) => event.type === "compaction");
    expect(compactions).toHaveLength(1);
    expect(compactions[0]?.beforeTokens).toBe(120_000);
    expect(compactions[0]?.afterTokens).toBe(35_000);
    expect(compactions[0]?.success).toBe(true);
  });

  it("skips a decision when Pi does not know the context size", () => {
    const path = newTracePath("unknown-size");
    const messages: string[] = [];
    const fake = fakePi();
    createFoldPointObserver({
      tracePath: path,
      now: () => 1_000_000,
      log: (message) => messages.push(message),
    })(fake.pi);

    fake.emit("session_start", { type: "session_start", reason: "startup" });
    fake.emit("context", { type: "context" }, fake.ctxWith(null));
    fake.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

    expect(readTrace(path).filter((event) => event.type === "decision")).toHaveLength(0);
    expect(messages.some((message) => message.includes("skipped"))).toBe(true);
  });

  it("waits for a known context size before recording a compaction", () => {
    // Pi reports `tokens: null` until the first response after a compaction, so the record
    // cannot be written at the call right after it: the size is only known one call later,
    // and that prompt is the post-compaction context.
    const path = newTracePath("compaction-unknown");
    const fake = fakePi();
    createFoldPointObserver({ tracePath: path, now: () => 1_000_000, log: () => undefined })(
      fake.pi,
    );

    fake.emit("session_start", { type: "session_start", reason: "startup" });
    fake.emit("context", { type: "context" }, fake.ctxWith(120_000));
    fake.emit("message_end", {
      type: "message_end",
      message: {
        role: "assistant",
        usage: { input: 120_000, output: 300, cacheRead: 0, cacheWrite: 120_000 },
      },
    });
    fake.emit("session_before_compact", {
      type: "session_before_compact",
      reason: "threshold",
      preparation: { tokensBefore: 120_000 },
    });
    fake.emit("session_compact", {
      type: "session_compact",
      reason: "threshold",
      compactionEntry: { tokensBefore: 120_000, usage: undefined },
    });
    // The call right after the compaction: Pi does not know the size yet.
    fake.emit("context", { type: "context" }, fake.ctxWith(null));
    expect(readTrace(path).filter((event) => event.type === "compaction")).toHaveLength(0);
    // The next one knows it, and that is the size the compaction is recorded with.
    fake.emit("context", { type: "context" }, fake.ctxWith(35_000));
    fake.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

    const compactions = readTrace(path).filter((event) => event.type === "compaction");
    expect(compactions).toHaveLength(1);
    expect(compactions[0]?.beforeTokens).toBe(120_000);
    expect(compactions[0]?.afterTokens).toBe(35_000);
  });

  it("explains a call that arrives without a session, once", () => {
    const path = newTracePath("no-session");
    const messages: string[] = [];
    const fake = fakePi();
    createFoldPointObserver({
      tracePath: path,
      now: () => 1_000_000,
      log: (message) => messages.push(message),
    })(fake.pi);

    // No session_start: Pi was started with --no-session.
    fake.emit("context", { type: "context" }, fake.ctxWith(50_000));
    fake.emit("message_end", {
      type: "message_end",
      message: {
        role: "assistant",
        usage: { input: 50_000, output: 1, cacheRead: 0, cacheWrite: 50_000 },
      },
    });
    fake.emit("context", { type: "context" }, fake.ctxWith(50_000));

    expect(messages.filter((message) => message.includes("before session_start")).length).toBe(1);
    expect(readTrace(path).filter((event) => event.type === "decision")).toHaveLength(0);
  });

  it("explains an assistant message that carries no usage", () => {
    const path = newTracePath("no-usage");
    const messages: string[] = [];
    const fake = fakePi();
    createFoldPointObserver({
      tracePath: path,
      now: () => 1_000_000,
      log: (message) => messages.push(message),
    })(fake.pi);

    fake.emit("session_start", { type: "session_start", reason: "startup" });
    fake.emit("context", { type: "context" }, fake.ctxWith(50_000));
    fake.emit("message_end", { type: "message_end", message: { role: "assistant" } });

    expect(messages.some((message) => message.includes("no usage"))).toBe(true);
    expect(readTrace(path).filter((event) => event.type === "request")).toHaveLength(0);
  });

  it("vetoes a threshold compaction only when FoldPoint says keep", () => {
    const path = newTracePath("act-veto");
    const fake = fakePi();
    createFoldPointObserver({
      tracePath: path,
      prefixStorePath: newPrefixStorePath("act-veto"),
      mode: "act",
      now: () => 1_000_000,
      log: () => undefined,
    })(fake.pi);

    fake.emit("session_start", { type: "session_start", reason: "startup" });
    // 20k of a 200k window: nowhere near compacting, so FoldPoint keeps.
    const result = fake.emit("session_before_compact", {
      type: "session_before_compact",
      reason: "threshold",
      preparation: { tokensBefore: 20_000 },
    });

    expect(result).toEqual({ cancel: true });

    // Pi reports the cancellation, and that is where the check itself is recorded.
    fake.emit("session_compact_failed", {
      type: "session_compact_failed",
      reason: "threshold",
      aborted: true,
    });

    const events = readTrace(path);
    // A threshold check is not a model-call decision: a session where Pi asks forty times must
    // not look like a session with forty decisions.
    expect(events.filter((event) => event.type === "decision")).toHaveLength(0);

    const compaction = events.find((event) => event.type === "compaction");
    expect(compaction?.type).toBe("compaction");
    if (compaction?.type !== "compaction") {
      throw new Error("missing compaction");
    }
    expect(compaction.success).toBe(false);
    expect(compaction.errorCode).toBe("vetoed");
    expect(compaction.reason).toBe("threshold");
    expect(compaction.reasons?.length).toBeGreaterThan(0);
    expect(compaction.policyLatencyMs).toBeGreaterThanOrEqual(0);
  });

  it("never vetoes an overflow or a manual compaction, and never in observe mode", () => {
    // `overflow` is Pi's last defence against a request that no longer fits, and `manual` is
    // the user asking for it. FoldPoint does not argue with either.
    for (const [mode, reason] of [
      ["act", "overflow"],
      ["act", "manual"],
      ["observe", "threshold"],
    ] as const) {
      const fake = fakePi();
      createFoldPointObserver({
        tracePath: newTracePath(`act-${mode}-${reason}`),
        prefixStorePath: newPrefixStorePath(`act-${mode}-${reason}`),
        mode,
        now: () => 1_000_000,
        log: () => undefined,
      })(fake.pi);
      fake.emit("session_start", { type: "session_start", reason: "startup" });

      const result = fake.emit("session_before_compact", {
        type: "session_before_compact",
        reason,
        preparation: { tokensBefore: 20_000 },
      });

      expect(result).toBeUndefined();
    }
  });

  it("does not veto when FoldPoint wants the compaction to happen", () => {
    // A context near the top of the window: FoldPoint's own FORCE is the safety net on its
    // side, and it agrees with Pi here.
    const path = newTracePath("act-agree");
    const fake = fakePi();
    createFoldPointObserver({
      tracePath: path,
      prefixStorePath: newPrefixStorePath("act-agree"),
      mode: "act",
      now: () => 1_000_000,
      log: () => undefined,
    })(fake.pi);
    fake.emit("session_start", { type: "session_start", reason: "startup" });

    const result = fake.emit(
      "session_before_compact",
      {
        type: "session_before_compact",
        reason: "threshold",
        preparation: { tokensBefore: 195_000 },
      },
      fake.ctxWith(195_000),
    );

    expect(result).toBeUndefined();
    const decisions = readTrace(path).filter((event) => event.type === "decision");
    expect(decisions[0]?.decision.action).not.toBe("KEEP");
  });

  it("records a failed call but never learns from it", () => {
    const path = newTracePath("failed-call");
    const fake = fakePi();
    createFoldPointObserver({ tracePath: path, now: () => 1_000_000, log: () => undefined })(
      fake.pi,
    );

    fake.emit("session_start", { type: "session_start", reason: "startup" });
    fake.emit("context", { type: "context" }, fake.ctxWith(50_000));
    fake.emit("message_end", {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    });
    fake.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

    const events = readTrace(path);
    const request = events.find((event) => event.type === "request");
    expect(request?.type).toBe("request");
    if (request?.type !== "request") {
      throw new Error("missing request");
    }
    // The call is recorded honestly, with its outcome...
    expect(request.outcome).toBe("error");
    // ...but a zeroed usage from a failed call must not be treated as "no cache served".
    expect(request.usage.cachedInputTokens).toBe(0);
  });

  it("measures the stable prefix from the first call's cache read", () => {
    // Pi's first call carries the system prompt, the tool schemas and the first user message.
    // Nothing else has been sent yet, so whatever the provider served from cache is the stable
    // prefix - and it is a measurement, not a guess.
    const path = newTracePath("prefix");
    const store = newPrefixStorePath("prefix");
    const fake = fakePi();
    createFoldPointObserver({
      tracePath: path,
      prefixStorePath: store,
      now: () => 1_000_000,
      log: () => undefined,
    })(fake.pi);

    fake.emit("session_start", { type: "session_start", reason: "startup" });
    fake.emit("context", { type: "context" }, fake.ctxWith(1_435));
    fake.emit("message_end", {
      type: "message_end",
      message: {
        role: "assistant",
        usage: { input: 201, output: 10, cacheRead: 1_408, cacheWrite: 0 },
      },
    });
    // The next decision knows the prefix, so the model stops pricing it as uncached input.
    fake.emit("context", { type: "context" }, fake.ctxWith(51_000));
    fake.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

    const decisions = readTrace(path).filter((event) => event.type === "decision");
    expect(decisions[0]?.input.fixedPrefixTokens).toBeUndefined();
    // Scaled out of the provider's units (1408 of a 1609-token prompt) into Pi's estimate of
    // the same call (1435), so a prefix can never exceed the context it is part of.
    expect(decisions[1]?.input.fixedPrefixTokens).toBe(1_256);
    expect(decisions[1]?.profile.prefixId).toMatch(/^[0-9a-f]{16}$/);
  });

  it("uses a prefix measured in an earlier process from its first call", () => {
    // Each Pi run is a new process. The first call is the one the measurement is about, so a
    // measurement that does not survive the process boundary never helps where it matters.
    const store = newPrefixStorePath("carry");
    const first = fakePi();
    const firstPath = newTracePath("carry-a");
    createFoldPointObserver({
      tracePath: firstPath,
      prefixStorePath: store,
      now: () => 1_000_000,
      log: () => undefined,
    })(first.pi);
    first.emit("session_start", { type: "session_start", reason: "startup" });
    first.emit("context", { type: "context" }, first.ctxWith(1_435));
    first.emit("message_end", {
      type: "message_end",
      message: {
        role: "assistant",
        usage: { input: 201, output: 10, cacheRead: 1_408, cacheWrite: 0 },
      },
    });
    first.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

    // A new process: new observer, same store, same system prompt.
    const second = fakePi();
    const secondPath = newTracePath("carry-b");
    createFoldPointObserver({
      tracePath: secondPath,
      prefixStorePath: store,
      now: () => 2_000_000,
      log: () => undefined,
    })(second.pi);
    second.emit("session_start", { type: "session_start", reason: "startup" });
    second.emit("context", { type: "context" }, second.ctxWith(1_400));
    second.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

    const decisions = readTrace(secondPath).filter((event) => event.type === "decision");
    expect(decisions[0]?.input.fixedPrefixTokens).toBe(1_256);
    expect(decisions[0]?.profile.prefixId).toBe(
      readTrace(firstPath).find((event) => event.type === "decision")?.profile.prefixId,
    );
  });

  it("does not let a failed first call consume the prefix measurement", () => {
    // A call that errored sent nothing, so it cached nothing: the next call is still the first
    // one whose cache read means "this is the stable prefix".
    const path = newTracePath("prefix-after-failure");
    const store = newPrefixStorePath("prefix-after-failure");
    const fake = fakePi();
    createFoldPointObserver({
      tracePath: path,
      prefixStorePath: store,
      now: () => 1_000_000,
      log: () => undefined,
    })(fake.pi);

    fake.emit("session_start", { type: "session_start", reason: "startup" });
    fake.emit("context", { type: "context" }, fake.ctxWith(1_435));
    fake.emit("message_end", {
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "error",
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      },
    });
    fake.emit("context", { type: "context" }, fake.ctxWith(1_441));
    fake.emit("message_end", {
      type: "message_end",
      message: {
        role: "assistant",
        usage: { input: 201, output: 10, cacheRead: 1_408, cacheWrite: 0 },
      },
    });
    fake.emit("context", { type: "context" }, fake.ctxWith(1_500));
    fake.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

    const decisions = readTrace(path).filter((event) => event.type === "decision");
    // 1408 * 1441 / 1609: the measurement comes from the second call, in its own context units.
    expect(decisions[2]?.input.fixedPrefixTokens).toBe(1_261);
  });

  it("gives a changed system prompt a different profile identity", () => {
    const path = newTracePath("prefix-change");
    const fake = fakePi();
    createFoldPointObserver({ tracePath: path, now: () => 1_000_000, log: () => undefined })(
      fake.pi,
    );

    fake.emit("session_start", { type: "session_start", reason: "startup" });
    fake.emit("context", { type: "context" }, fake.ctxWith(50_000));
    fake.emit("context", { type: "context" }, fake.ctxWith(50_000, MODEL, "a different prompt"));
    fake.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

    const decisions = readTrace(path).filter((event) => event.type === "decision");
    expect(decisions[0]?.profile.prefixId).toMatch(/^[0-9a-f]{16}$/);
    expect(decisions[1]?.profile.prefixId).not.toBe(decisions[0]?.profile.prefixId);
    // The fingerprint is a hash: the prompt itself must never reach the trace.
    expect(JSON.stringify(decisions[1])).not.toContain("a different prompt");
  });

  it("keeps every session in the trace", () => {
    const path = newTracePath("two-sessions");
    const fake = fakePi();
    createFoldPointObserver({ tracePath: path, now: () => 1_000_000, log: () => undefined })(
      fake.pi,
    );

    for (let session = 0; session < 2; session += 1) {
      fake.emit("session_start", { type: "session_start", reason: "startup" });
      fake.emit("context", { type: "context" }, fake.ctxWith(50_000));
      fake.emit("message_end", {
        type: "message_end",
        message: {
          role: "assistant",
          usage: { input: 50_000, output: 10, cacheRead: 0, cacheWrite: 50_000 },
        },
      });
      fake.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
    }

    const sessionIds = new Set(
      readTrace(path)
        .filter((event) => event.type === "decision")
        .map((event) => (event as { sessionId: string }).sessionId),
    );
    expect(sessionIds.size).toBe(2);
  });
});
