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
  ): void;
  /** A context whose reported usage changes between calls. */
  ctxWith(
    tokens: number | null,
    model?: PiModel | undefined,
    systemPrompt?: string,
  ): PiExtensionContext;
}

function fakePi(): FakePi {
  const handlers = new Map<string, Array<(event: never, ctx: PiExtensionContext) => void>>();
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
      for (const handler of handlers.get(event) ?? []) {
        (handler as unknown as (event: unknown, ctx: PiExtensionContext) => void)(payload, ctx);
      }
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

const SYSTEM_PROMPT = "You are a coding agent.\n\n## Tools\nread, bash, edit, write\n";

describe("Pi observer adapter", () => {
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
        usage: { input: 201, output: 10, cacheRead: 1_408, cacheWrite: 0 },
      },
    });
    // The next decision knows the prefix, so the model stops pricing it as uncached input.
    fake.emit("context", { type: "context" }, fake.ctxWith(51_000));
    fake.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });

    const decisions = readTrace(path).filter((event) => event.type === "decision");
    expect(decisions[0]?.input.fixedPrefixTokens).toBeUndefined();
    expect(decisions[1]?.input.fixedPrefixTokens).toBe(1_408);
    expect(decisions[1]?.profile.prefixId).toMatch(/^[0-9a-f]{16}$/);
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
