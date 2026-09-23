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
  ctxWith(tokens: number | null, model?: PiModel | undefined): PiExtensionContext;
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
  };
  return {
    pi,
    registered,
    emit(event, payload, ctx = defaultCtx) {
      for (const handler of handlers.get(event) ?? []) {
        (handler as unknown as (event: unknown, ctx: PiExtensionContext) => void)(payload, ctx);
      }
    },
    ctxWith(tokens, model = MODEL) {
      return {
        model,
        cwd: "/tmp/project",
        getContextUsage: () =>
          tokens === null
            ? { tokens: null, contextWindow: 200_000, percent: null }
            : { tokens, contextWindow: 200_000, percent: tokens / 2_000 },
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
    expect(readTrace(path).filter((event) => event.type === "request")).toHaveLength(0);
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
