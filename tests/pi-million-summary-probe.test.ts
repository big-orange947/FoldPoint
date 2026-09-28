import { describe, expect, it } from "vitest";
import {
  DEEPSEEK_REQUEST_CEILING_TOKENS,
  MILLION_SUMMARY_MAX_TOKENS,
} from "../tools/pi-million-config";
import {
  buildProbeConversation,
  buildSummaryProbePayload,
  buildSummaryRequestBody,
  chatCompletionsUrl,
  DEFAULT_TARGET_INPUT_TOKENS,
  judgeSummaryProbe,
  parseProbeArgs,
  planSummaryProbe,
  runSummaryProbe,
  SUMMARY_PROBE_MAX_TOKENS,
  type SummaryProbeOptions,
  type SummaryProbeOutcome,
  type SummaryStreamScan,
  SummaryStreamScanner,
  summaryOutputBudget,
} from "../tools/pi-million-summary-probe";

/** Defaults from the real parser, so the tests never hand-write an option set by hand. */
const probeOptions = (over: Partial<SummaryProbeOptions> = {}): SummaryProbeOptions => ({
  ...parseProbeArgs([]),
  ...over,
});

/** Chunk bodies are built as text, not as objects, so a split line can be tested too. */
const chunkLine = (payload: unknown): string => `data: ${JSON.stringify(payload)}\n\n`;

const streamScannerOf = (chunks: readonly string[]): SummaryStreamScan => {
  const scanner = new SummaryStreamScanner();
  for (const chunk of chunks) scanner.push(chunk);
  return scanner.scan;
};

/**
 * The probe's questions are answered by parsing and judging, not by the network, so everything that
 * decides its verdict is pinned here with fake responses. No provider, no key, no cost: the paid
 * path itself is never reached in this file.
 */
describe("Pi summary probe budget", () => {
  it("reproduces Pi's summary budget formula, and the shared cap the trial needs", () => {
    // `min(floor(0.8 * reserveTokens), model.maxTokens)` (compaction.ts:734-737).
    expect(summaryOutputBudget(16_384, 13107)).toBe(13107);
    // The fixed60 arm's 320,000 reserve cannot buy it a wider summarizer: the shared model cap binds.
    expect(summaryOutputBudget(320_000, 13107)).toBe(13107);
    // Pi's own built-in cap of 384,000 does not bind either - the trial's override is what sets it.
    expect(summaryOutputBudget(16_384, 384_000)).toBe(13107);
    // And the probe therefore asks the provider for exactly what the paid arms ask for.
    expect(SUMMARY_PROBE_MAX_TOKENS).toBe(13_107);
    expect(SUMMARY_PROBE_MAX_TOKENS).toBe(MILLION_SUMMARY_MAX_TOKENS);
  });

  it("builds the request the way Pi's summarization call builds it", () => {
    const body = buildSummaryRequestBody({
      conversationText: "[User]: material\n\n[Assistant]: noted",
      model: "deepseek-flash",
      maxTokens: SUMMARY_PROBE_MAX_TOKENS,
      userId: "foldpoint-1m-summary-probe",
    }) as {
      model: string;
      max_tokens: number;
      temperature: number;
      stream: boolean;
      stream_options: { include_usage: boolean };
      thinking: { type: string };
      user_id: string;
      messages: Array<{ role: string; content: string }>;
    };
    expect(body.model).toBe("deepseek-flash");
    expect(body.max_tokens).toBe(13_107);
    expect(body.temperature).toBe(0);
    expect(body.thinking).toEqual({ type: "disabled" });
    expect(body.user_id).toBe("foldpoint-1m-summary-probe");
    // Usage in the stream and no `prompt_cache_key`: Pi asks for a summary with
    // `cacheRetention: "none"` (compaction.ts:651-655).
    expect(body.stream).toBe(true);
    expect(body.stream_options).toEqual({ include_usage: true });
    expect(body).not.toHaveProperty("prompt_cache_key");
    expect(body.messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(body.messages[0]?.content).toContain("You are a context summarization assistant");
    // The conversation is wrapped in `<conversation>` tags and followed by the exact format
    // instructions - the two things a model needs to answer this question at all.
    expect(body.messages[1]?.content).toContain("<conversation>\n[User]: material");
    expect(body.messages[1]?.content).toContain("</conversation>");
    expect(body.messages[1]?.content).toContain("Use this EXACT format:");
    expect(body.messages[1]?.content).toContain("## Critical Context");
  });

  it("synthesizes the same ~700k-token context on every run", () => {
    const first = buildProbeConversation(1_000);
    expect(buildProbeConversation(1_000)).toBe(first);
    // Deterministic and synthetic: nothing from this machine, and the tags Pi's own serializer uses.
    expect(first.startsWith("[User]: Stage 1 of the frozen synthetic transcript.")).toBe(true);
    expect(first).toContain("[Assistant]: Stage 2 recorded:");
    const payload = buildSummaryProbePayload(probeOptions());
    expect(payload.approxInputTokens).toBeGreaterThan(DEFAULT_TARGET_INPUT_TOKENS * 0.95);
    expect(payload.approxInputTokens).toBeLessThan(DEFAULT_TARGET_INPUT_TOKENS * 1.05);
    // The same options must produce the same bytes, or two probe runs would not be comparable.
    expect(buildSummaryProbePayload(probeOptions()).body).toBe(payload.body);
    expect(payload.endpoint).toBe(chatCompletionsUrl("https://api.deepseek.com"));
    expect(payload.endpoint).toBe("https://api.deepseek.com/chat/completions");
  });

  it("refuses a probe the provider would only reject with a 400", () => {
    const plan = planSummaryProbe(probeOptions());
    expect(plan.approxInputTokens + plan.maxTokens).toBeLessThan(DEEPSEEK_REQUEST_CEILING_TOKENS);
    expect(plan.willCall).toBe(false);
    expect(plan.estimatedCostUsd).toBeGreaterThan(0.2);
    expect(plan.estimatedCostUsd).toBeLessThan(0.25);
    expect(() => planSummaryProbe(probeOptions({ targetInputTokens: 1_050_000 }))).toThrow(
      /request ceiling/,
    );
  });
});

describe("Pi summary probe stream scan", () => {
  it("keeps the fields that decide the verdict and nothing else", () => {
    const scan = streamScannerOf([
      chunkLine({ choices: [{ index: 0, delta: { content: "## Goal\n" } }] }),
      chunkLine({
        choices: [{ index: 0, delta: { content: "- finish the trial" }, finish_reason: "stop" }],
      }),
      chunkLine(null),
      chunkLine({ choices: [], usage: { prompt_tokens: 709_266, completion_tokens: 4_312 } }),
      "data: [DONE]\n\n",
    ]);
    expect(scan.finishReason).toBe("stop");
    expect(scan.outputTokens).toBe(4_312);
    expect(scan.promptTokens).toBe(709_266);
    expect(scan.outputChars).toBe("## Goal\n- finish the trial".length);
    expect(scan.chunks).toBe(3);
    expect(scan.streamErrors).toBe(0);
    // The result carries no field that could hold provider text: content is counted as it arrives
    // and dropped, so nothing downstream can print a summary even by accident.
    expect(Object.keys(scan).sort()).toEqual([
      "chunks",
      "finishReason",
      "outputChars",
      "outputTokens",
      "oversizedLines",
      "promptTokens",
      "streamErrors",
      "unparsableLines",
    ]);
  });

  it("reads a line split across chunks, and takes the last finish reason", () => {
    const line = chunkLine({
      choices: [{ index: 0, delta: { content: "x" }, finish_reason: "length" }],
    });
    const scan = streamScannerOf([line.slice(0, 20), line.slice(20), "data: [DONE]\n\n"]);
    expect(scan.finishReason).toBe("length");
    expect(scan.chunks).toBe(1);
    expect(scan.unparsableLines).toBe(0);
  });

  it("counts a mid-stream provider error without reading its message", () => {
    const scan = streamScannerOf([
      chunkLine({ error: { message: "Rate limit reached", type: "rate_limit_error" } }),
    ]);
    expect(scan.streamErrors).toBe(1);
    expect(scan.finishReason).toBeNull();
  });

  it("drops a line too long to be one chunk instead of holding it", () => {
    const scan = streamScannerOf([`data: {"choices":[${"x".repeat(1_000_001)}`]);
    expect(scan.oversizedLines).toBe(1);
    expect(scan.chunks).toBe(0);
  });
});

describe("Pi summary probe verdict", () => {
  const outcome = (over: Partial<SummaryProbeOutcome> = {}): SummaryProbeOutcome => ({
    httpStatus: 200,
    elapsedMs: 1_000,
    timedOut: false,
    transportError: null,
    finishReason: null,
    outputTokens: null,
    promptTokens: null,
    outputChars: 0,
    chunks: 1,
    unparsableLines: 0,
    streamErrors: 0,
    oversizedLines: 0,
    ...over,
  });

  it("reads a `stop` stop as the budget being enough", () => {
    expect(judgeSummaryProbe(outcome({ finishReason: "stop" }))).toEqual({
      verdict: "budget-sufficient",
      hitOutputCap: false,
    });
  });

  it("reads a `length` stop as the budget being too small, and says the cap was hit", () => {
    expect(judgeSummaryProbe(outcome({ finishReason: "length" }))).toEqual({
      verdict: "budget-too-small",
      hitOutputCap: true,
    });
  });

  it("reads the probe's own expired deadline as a timeout, not as a provider answer", () => {
    expect(judgeSummaryProbe(outcome({ timedOut: true, finishReason: null }))).toEqual({
      verdict: "timed-out",
      hitOutputCap: false,
    });
  });

  it("prefers a structured refusal over any client-side reading", () => {
    // 402 with no stream at all is a refusal, and calling it a timeout would hide the cause.
    expect(judgeSummaryProbe(outcome({ httpStatus: 402 })).verdict).toBe("http-error");
    expect(
      judgeSummaryProbe(outcome({ httpStatus: 402, timedOut: true, transportError: "AbortError" }))
        .verdict,
    ).toBe("http-error");
  });

  it("separates a transport failure from a stream that simply says nothing", () => {
    expect(
      judgeSummaryProbe(outcome({ httpStatus: null, transportError: "TypeError" })).verdict,
    ).toBe("transport-error");
    expect(judgeSummaryProbe(outcome({ httpStatus: null })).verdict).toBe("transport-error");
    expect(judgeSummaryProbe(outcome({})).verdict).toBe("stream-incomplete");
    expect(judgeSummaryProbe(outcome({ streamErrors: 1 })).verdict).toBe("provider-error");
  });
});

describe("Pi summary probe command line", () => {
  it("plans the real request but sends nothing without the paid switch", () => {
    const options = probeOptions();
    expect(options.confirmPaidCall).toBe(false);
    const plan = planSummaryProbe(options);
    // What it prints is what it would do: endpoint, model, the shared cap, and the worst-case cost.
    expect(plan.willCall).toBe(false);
    expect(plan.note).toContain("pass --confirm-paid-call");
    expect(plan.endpoint).toContain("api.deepseek.com");
    expect(plan.maxTokens).toBe(13_107);
    expect(plan.estimatedCostUsd).toBeGreaterThan(0);
    expect(planSummaryProbe(probeOptions({ confirmPaidCall: true })).willCall).toBe(true);
  });

  it("rejects a typo, a missing value and a target that cannot fit", () => {
    expect(() => parseProbeArgs(["--confirm-piad-call"])).toThrow(/Unknown flag/);
    expect(() => parseProbeArgs(["--target-input-tokens"])).toThrow(/needs a value/);
    expect(() => parseProbeArgs(["--target-input-tokens", "0"])).toThrow(/positive whole number/);
    expect(() => parseProbeArgs(["--timeout-seconds", "soon"])).toThrow(/positive whole number/);
    expect(() => parseProbeArgs(["--target-input-tokens", "1000001"])).toThrow(/size ceiling/);
    expect(
      parseProbeArgs(["--confirm-paid-call", "--target-input-tokens", "700000"]),
    ).toMatchObject({
      confirmPaidCall: true,
      targetInputTokens: 700_000,
    });
  });

  it("counts response text without keeping it, and keeps the key in the header", async () => {
    const canary = "LEAK-CANARY-NEVER-PRINTED";
    let seenHeaders: RequestInit["headers"];
    let seenBody: string | undefined;
    const sseFetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      seenHeaders = init?.headers;
      seenBody = typeof init?.body === "string" ? init.body : undefined;
      const payloads = [
        chunkLine({ choices: [{ index: 0, delta: { content: canary } }] }),
        chunkLine({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }),
        chunkLine({ choices: [], usage: { prompt_tokens: 709_266, completion_tokens: 3 } }),
        "data: [DONE]\n\n",
      ];
      const encoder = new TextEncoder();
      return new Response(
        new ReadableStream({
          start(controller) {
            for (const payload of payloads) controller.enqueue(encoder.encode(payload));
            controller.close();
          },
        }),
        { status: 200, headers: { "content-type": "text/event-stream" } },
      );
    }) as typeof fetch;
    const result = await runSummaryProbe(
      probeOptions({ confirmPaidCall: true }),
      "test-key",
      sseFetch,
    );
    expect(judgeSummaryProbe(result)).toEqual({
      verdict: "budget-sufficient",
      hitOutputCap: false,
    });
    expect(result.outputChars).toBe(canary.length);
    expect(result.outputTokens).toBe(3);
    expect(result.promptTokens).toBe(709_266);
    // The text was counted and dropped: it is nowhere in what the run reports.
    expect(JSON.stringify(result)).not.toContain(canary);
    // The key travels as an authorization header and is never part of the request body.
    const headers = new Headers(seenHeaders);
    expect(headers.get("authorization")).toBe("Bearer test-key");
    expect(seenBody ?? "").not.toContain("test-key");
  });

  it("times out on its own deadline, with the request aborted and no answer read", async () => {
    const hangingFetch = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      })) as typeof fetch;
    const result = await runSummaryProbe(
      probeOptions({ confirmPaidCall: true, timeoutSeconds: 1 }),
      "test-key",
      hangingFetch,
    );
    expect(result.timedOut).toBe(true);
    expect(result.httpStatus).toBeNull();
    expect(result.transportError).toBeNull();
    expect(judgeSummaryProbe(result).verdict).toBe("timed-out");
  }, 15_000);

  it("reads an HTTP refusal as a refusal without reading its body", async () => {
    const refusingFetch = (async () =>
      new Response(JSON.stringify({ error: { message: "Insufficient Balance" } }), {
        status: 402,
      })) as typeof fetch;
    const result = await runSummaryProbe(
      probeOptions({ confirmPaidCall: true }),
      "test-key",
      refusingFetch,
    );
    expect(result.httpStatus).toBe(402);
    expect(result.chunks).toBe(0);
    expect(result.outputChars).toBe(0);
    expect(judgeSummaryProbe(result).verdict).toBe("http-error");
  });
});
