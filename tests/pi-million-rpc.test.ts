import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  MILLION_SUMMARY_MAX_TOKENS,
  type MillionArmId,
  millionSystemPromptMarker,
} from "../tools/pi-million-config";
import { classifyFailure, PiRpcLossError, RpcSession, scanFailures } from "../tools/pi-million-rpc";

const root = fileURLToPath(new URL("..", import.meta.url));
const piCli = process.env.PI_CLI;
const largeLoopback = process.env.PI_MILLION_LARGE_LOOPBACK === "1";
const sourceManifest = process.env.PI_MILLION_SOURCE_MANIFEST;
const preflightOnly = process.env.PI_MILLION_PREFLIGHT === "1";
const fakeOverflow = process.env.PI_MILLION_FAKE_OVERFLOW === "1";
const fakeInsufficientBalance = process.env.PI_MILLION_FAKE_402 === "1";
/** The local service's stand-in for DeepSeek's request ceiling (DEEPSEEK_REQUEST_CEILING_TOKENS). */
const requestCeilingTokens = 1_048_576;
/**
 * The fake provider answers instantly, so a full source-corpus run costs mostly Pi's own
 * bookkeeping per turn. The 135-stage corpus measured ~275s end to end on the development
 * machine; 20 minutes leaves room for a slower one without hiding a real hang.
 */
const sourceRunTimeoutMs = Number(process.env.PI_MILLION_SOURCE_TIMEOUT_MS ?? 1_200_000);

/** Length of the shared opening of two strings; where their prefixes diverge. */
function commonPrefixLength(left: string, right: string): number {
  let index = 0;
  while (index < left.length && index < right.length && left[index] === right[index]) index += 1;
  return index;
}

/**
 * Zero-cost failure injection for the diagnosis runs, read by the loopback service in this
 * process. `status` is what the service answers for the first `skip + 1` calls of that class;
 * `body` is the provider's JSON error body, and `finishReason: "length"` answers HTTP 200 with a
 * truncated stream instead of an HTTP error. Nothing here touches a real provider.
 */
let injectedFailure: {
  status: number;
  on: "material" | "summary";
  skip: number;
  seen: number;
  /** Provider body; the status is deliberately absent from it, so a status must be extracted. */
  body?: { message: string; type: string; code: string };
  /** Answer `200` with a truncated stream: the shape that has no HTTP status at all. */
  finishReason?: "length";
} | null = null;
/**
 * `prompt_tokens` the service reports for the first `calls` material calls after this is armed. A
 * short transcript cannot reach Pi's threshold on its own, and Pi picks the compaction cut point
 * from real message sizes, so the only way to exercise a *summary* call cheaply is to report a
 * large usage the way a real provider does at the end of a long conversation - and to arm it for
 * exactly the calls that need it, so a later stage settles instead of asking again.
 */
let injectedUsage: { tokens: number; calls: number; seen: number } | null = null;

/** The slice of a 1M-trial report the short-run checks need. */ interface ShortRunReport {
  arms: Array<{
    reason: string | null;
    budgetStop: { kind: string; limit: number; observed: number; currency: string | null } | null;
    stagesCompleted: number;
    promptTokensTotal: number;
    totalCost: number | null;
    failures: Array<{
      stage: number | null;
      call: string;
      status: number | null;
      category: string;
      compactionReason: string | null;
      rpcLoss: string | null;
    }>;
    failuresTruncated: boolean;
    lastFailure: {
      stage: number | null;
      call: string;
      status: number | null;
      category: string;
      compactionReason: string | null;
      rpcLoss: string | null;
    } | null;
    failuresByCall: Record<string, number>;
    assistantStopReasons: Record<string, number>;
    hostRetryAttempts: number;
  }>;
  failedArms: string[];
  comparable: boolean;
  pilotCostAndQualitySignal: boolean;
  budgetTruncatedArms: string[];
}

/**
 * The classification rules, pinned without a provider in the loop. Every case here is a shape the
 * two paid pilots' failure records could not distinguish, plus the one trap in the fixed
 * vocabulary: DeepSeek's 402 body carries the generic `invalid_request_error` code.
 */
describe("Pi failure classification", () => {
  it("prefers the cause the provider body names over the generic code and the status class", () => {
    // DeepSeek's real 402 shape: the message names the cause, the code says `invalid_request_error`.
    expect(
      classifyFailure(
        402,
        '402: {"error":{"message":"Insufficient Balance","type":"unknown_error","code":"invalid_request_error"}}',
      ),
    ).toEqual({ status: 402, category: "insufficient-balance" });
    // The same generic code on a 400 that really is about context length.
    expect(
      classifyFailure(
        400,
        'Context overflow recovery failed: Summarization failed: 400: {"error":{"message":"This model\'s maximum context length is 1048576 tokens.","type":"invalid_request_error","code":"context_length_exceeded"}}',
      ),
    ).toEqual({ status: 400, category: "context-length" });
    // A structured quota code on a 429 is not a burst rate limit.
    expect(
      classifyFailure(
        429,
        '429: {"error":{"type":"insufficient_quota","code":"insufficient_quota"}}',
      ),
    ).toEqual({ status: 429, category: "insufficient-balance" });
  });

  it("reads the status out of the display text only after the structured sources", () => {
    // A structured diagnostic code is taken as the status and is not second-guessed by the text.
    expect(classifyFailure(500, "Summarization failed: 400: {}")).toEqual({
      status: 500,
      category: "server-error",
    });
    expect(classifyFailure(null, '429: {"error":{"message":"Rate limit reached"}}')).toEqual({
      status: 429,
      category: "rate-limit",
    });
    expect(classifyFailure(null, "429 rate limit reached for requests")).toEqual({
      status: 429,
      category: "rate-limit",
    });
    // The label Pi's own wrapper puts in front of the provider text does not hide it.
    expect(
      classifyFailure(null, "Auto-compaction failed: Summarization failed: 503: upstream busy"),
    ).toEqual({ status: 503, category: "server-error" });
  });

  it("classifies a summary that stopped on its own output cap without any status", () => {
    // The exact string `getSummarizationFailure` composes for a `length` stop, wrapped by the host
    // (coding-agent/src/core/compaction/compaction.ts:612 + agent-session.ts:2880). No digits at
    // all, so the status path cannot help; the phrase is the only evidence there is.
    expect(
      classifyFailure(
        null,
        "Context overflow recovery failed: Summarization failed: generation hit the token cap and the summary is incomplete",
      ),
    ).toEqual({ status: null, category: "summary-output-cap" });
  });

  it("says so out loud when nothing structured and no fixed phrase matched", () => {
    expect(classifyFailure(null, "Summarization failed: Unknown error")).toEqual({
      status: null,
      category: "unknown-no-status",
    });
    expect(classifyFailure(null, "Summarization attempted to call a tool")).toEqual({
      status: null,
      category: "unknown-no-status",
    });
    // A generic 4xx with no body is still an invalid-request-class failure, not a mystery.
    expect(classifyFailure(null, "400 status code (no body)")).toEqual({
      status: 400,
      category: "invalid-request",
    });
  });
});

describe("Pi RPC transport losses", () => {
  /**
   * A bare RPC-shaped child: it answers `get_state` and nothing else. Enough to drive the waits the
   * third paid pilot could not tell apart, with no provider, no prompt and no cost.
   */
  const stubPi = (compacting: boolean): string => `let b="";
process.stdin.setEncoding("utf8");
process.stdin.on("data",(c)=>{b+=c;for(;;){const i=b.indexOf("\\n");if(i<0)break;const line=b.slice(0,i);b=b.slice(i+1);if(!line.trim())continue;const cmd=JSON.parse(line);if(cmd.type==="get_state")process.stdout.write(JSON.stringify({type:"response",id:cmd.id,success:true,data:{isCompacting:${compacting},isStreaming:false}})+"\\n");}});
process.stdin.resume();
process.stdin.on("end",()=>process.exit(0));`;

  const lossOf = async (session: RpcSession, timeoutMs: number): Promise<PiRpcLossError> => {
    try {
      await session.waitFor(() => false, 0, timeoutMs);
    } catch (error) {
      if (error instanceof PiRpcLossError) return error;
      throw error;
    }
    throw new Error("The wait returned although the stub never emitted the awaited event");
  };

  it("calls our own expired deadline a timeout, and says the child is still alive", async () => {
    const session = new RpcSession(process.execPath, ["-e", stubPi(false)], root, process.env);
    try {
      const loss = await lossOf(session, 250);
      expect(loss.kind).toBe("event-timeout");
      expect(loss.message).toContain("exit=running");
      // Exactly the state the third pilot's report conflated: the child is demonstrably alive.
      expect(session.child.exitCode).toBeNull();
    } finally {
      await session.close();
    }
  });

  it("calls a real exit an exit, whatever the deadline said", async () => {
    const session = new RpcSession(process.execPath, ["-e", "process.exit(3)"], root, process.env);
    try {
      const loss = await lossOf(session, 5_000);
      expect(loss.kind).toBe("process-exit");
      expect(loss.message).toContain("exit=3");
      expect(loss.message).not.toContain("timeout");
    } finally {
      await session.close();
    }
  });

  it("calls a child that never started a spawn error", async () => {
    const session = new RpcSession("foldpoint-no-such-binary-9f2c", [], root, process.env);
    try {
      expect((await lossOf(session, 5_000)).kind).toBe("spawn-error");
    } finally {
      await session.close();
    }
  });

  it("calls a compaction still running at the settle deadline a timeout, not a dead host", async () => {
    const session = new RpcSession(process.execPath, ["-e", stubPi(true)], root, process.env);
    try {
      const loss = await session.settleTurn(0, 900).then(
        () => null,
        (error: unknown) => error,
      );
      expect(loss).toBeInstanceOf(PiRpcLossError);
      expect((loss as PiRpcLossError).kind).toBe("settle-timeout");
      expect((loss as PiRpcLossError).message).toContain("exit=running");
      expect(session.child.exitCode).toBeNull();
    } finally {
      await session.close();
    }
  });

  it("settles as soon as the host is idle, so a deadline is not the usual path", async () => {
    const session = new RpcSession(process.execPath, ["-e", stubPi(false)], root, process.env);
    try {
      await session.settleTurn(0, 5_000);
    } finally {
      await session.close();
    }
  });
});

/**
 * The report side of the same distinction. `traces/pi-million-paid-pilot-03-report.json` recorded
 * `Pi RPC event timeout or exit (exit=running)`: one string naming both "our deadline expired while
 * Pi was still summarizing" and "Pi is gone", so the report could not say whether the run needed
 * patience or a fix. The record now carries which state it was in.
 */
describe("Pi lost-session failure records", () => {
  it("keeps the two states apart on the record, from the same events", () => {
    const events = [{ type: "compaction_start", reason: "threshold" }];
    const timedOut = scanFailures(events, [0], 1, "settle-timeout");
    expect(timedOut.failures.at(-1)).toEqual({
      stage: 1,
      call: "summary",
      status: null,
      category: "rpc-lost",
      compactionReason: "threshold",
      rpcLoss: "settle-timeout",
    });
    // Same events, the other state: the child really ended. Never the same record.
    const exited = scanFailures(events, [0], 1, "process-exit");
    expect(exited.failures.at(-1)?.category).toBe("rpc-lost");
    expect(exited.failures.at(-1)?.rpcLoss).toBe("process-exit");
  });

  it("leaves rpcLoss null on a failure that is not a lost session", () => {
    const scan = scanFailures(
      [
        {
          type: "message_end",
          message: {
            role: "assistant",
            stopReason: "error",
            errorMessage: "429: rate limit reached",
          },
        },
      ],
      [0],
      null,
      null,
    );
    expect(scan.failures).toHaveLength(1);
    expect(scan.failures[0]?.category).toBe("rate-limit");
    expect(scan.failures[0]?.rpcLoss).toBeNull();
  });
});

describe("persistent Pi 1M RPC runner", () => {
  it.skipIf(!piCli)(
    "completes all three arms against a local no-cost provider",
    async () => {
      const temp = mkdtempSync(join(tmpdir(), "foldpoint-1m-rpc-"));
      const base = join(temp, "base");
      mkdirSync(base);
      const sourceStages = sourceManifest
        ? (JSON.parse(readFileSync(sourceManifest, "utf8")).stages as Array<{ file: string }>)
        : null;
      // Both the synthetic large loopback and the frozen source corpus grow the context for
      // real. They need the provider to report true request sizes and to answer summarization
      // requests with a summary; otherwise Pi's threshold checks stay blind to the load and the
      // compaction path is never exercised.
      const growthRun = largeLoopback || sourceStages !== null;
      const stageCount = sourceStages?.length ?? (largeLoopback ? 8 : 4);
      let calls = 0;
      let sawDeterministicRequest = false;
      /** Largest request the local service actually saw, on the same chars/4 basis it enforces. */
      let maxRequestTokens = 0;
      /** The same number split by the arm whose cache namespace the request announced. */
      const maxRequestTokensByArm = new Map<string, number>();
      /** Requests refused for exceeding the provider ceiling. Must stay zero. */
      let rejectedOverCeiling = 0;
      let summaryRequests = 0;
      // Every arm must announce its own KV-cache namespace on the wire. Asserting the config
      // file alone would prove nothing: the point is that the value reaches DeepSeek's request
      // body, which is where cache isolation is decided.
      const observedUserIds = new Set<string>();
      /**
       * The opening words of the system prompt the local service actually parsed out of each
       * request, keyed by the arm that announced itself in `user_id`. The system message is the
       * first message of a chat-completions request, so this is token zero of the conversation -
       * the place where the three arms could otherwise share one cached prefix. Asserting the
       * arm preamble in `tools/pi-million-config.ts` alone would not show it reaches Pi.
       */
      const observedSystemPrefixes = new Map<string, Set<string>>();
      /**
       * The `max_tokens` every arm's summary calls asked for on the wire. Pi budgets a summary as
       * `min(floor(0.8 * reserveTokens), model.maxTokens)` and `reserveTokens` differs by arm, so
       * this is where the equalization has to hold: one value per arm, all three identical.
       */
      const summaryMaxTokensByArm = new Map<string, Set<number>>();
      let currentStageMarker = "STAGE_OK";
      const server = createServer(async (request, response) => {
        let requestChars = 0;
        let requestHead = "";
        let requestTail = "";
        // `user_id` sits outside `messages` in the request body, so on a multi-megabyte request
        // it lands far past the part kept as `requestHead`. Scan every chunk instead, carrying a
        // short tail so a key split across a chunk boundary still matches.
        let userIdCarry = "";
        let requestArm = "unknown";
        /** The request's own `max_tokens`, carried across chunks the way `user_id` is. */
        let requestedMaxTokens: number | null = null;
        let latestStageMarker: string | undefined;
        for await (const chunk of request) {
          const part = Buffer.from(chunk).toString("utf8");
          requestChars += part.length;
          if (requestHead.length < 40_000)
            requestHead += part.slice(0, 40_000 - requestHead.length);
          const userIdMatch = /"user_id":"([^"]+)"/.exec(userIdCarry + part);
          if (userIdMatch?.[1] !== undefined) {
            observedUserIds.add(userIdMatch[1]);
            requestArm = userIdMatch[1];
          }
          // `max_tokens` sits *after* `messages` in Pi's request body, i.e. far past the 40k head
          // kept below, so it has to be parsed off the stream directly.
          const maxTokensMatch = /"max_tokens":(\d+)/.exec(userIdCarry + part);
          if (maxTokensMatch?.[1] !== undefined) requestedMaxTokens = Number(maxTokensMatch[1]);
          userIdCarry = (userIdCarry + part).slice(-32);
          const matches = (requestTail + part).match(/Reply exactly STAGE_\d+/g);
          if (matches?.length) latestStageMarker = matches.at(-1)?.slice(14);
          requestTail = (requestTail + part).slice(-8_000);
        }
        if (
          requestHead.includes('"temperature":0') &&
          requestHead.includes('"thinking":{"type":"disabled"}')
        ) {
          sawDeterministicRequest = true;
        }
        // The diagnosis runs arm this service themselves, so summary detection must not depend on
        // the corpus being long: making Pi ask for a summary on a short transcript is their whole
        // point. Everything else keeps the original gate.
        const diagnosisArmed = injectedFailure !== null || injectedUsage !== null;
        const isSummary =
          (growthRun || diagnosisArmed) &&
          requestHead.includes("You are a context summarization assistant");
        if (isSummary) summaryRequests += 1;
        // The summary output budget Pi computes (min(floor(0.8 * reserveTokens), model.maxTokens))
        // has to reach the provider, so record what each arm's summary calls actually asked for.
        // This is the zero-cost half of the 4,096-truncation fix: it proves the three arms are
        // equally capped on the wire, not just in `tools/pi-million-config.ts`.
        if (isSummary && requestedMaxTokens !== null) {
          const seen = summaryMaxTokensByArm.get(requestArm) ?? new Set<number>();
          seen.add(requestedMaxTokens);
          summaryMaxTokensByArm.set(requestArm, seen);
        }
        if (!isSummary && latestStageMarker) currentStageMarker = latestStageMarker;
        if (!isSummary) {
          // `{"role":"system","content":"..."}` is the first element of `messages`
          // (`pi/packages/ai/src/api/openai-completions.ts:1249-1252`), and a JSON-escaped
          // newline ends the first line of the injected preamble, so this is the arm marker.
          const systemPrefix =
            /"messages":\[\{"role":"(?:system|developer)","content":"([^"\\]{0,64})/.exec(
              requestHead,
            );
          if (systemPrefix?.[1] !== undefined) {
            const seen = observedSystemPrefixes.get(requestArm) ?? new Set<string>();
            seen.add(systemPrefix[1]);
            observedSystemPrefixes.set(requestArm, seen);
          }
        }
        calls += 1;
        // Zero-cost failure injection: answer the selected class of call with a real HTTP status
        // and an error body that does NOT repeat the status, so the report can only know it if the
        // runner really extracted it. The `finishReason: "length"` variant answers 200 with a
        // truncated stream, which is the one failure shape with no HTTP status anywhere - the
        // summary call then has only the host's own label to be classified from. A summary call is
        // the only kind that is not staged material (`cacheWarming` is off in every arm).
        const materialCall = !isSummary;
        if (materialCall && injectedUsage !== null) injectedUsage.seen += 1;
        if (
          injectedFailure !== null &&
          (injectedFailure.on === "summary" ? isSummary : materialCall)
        ) {
          injectedFailure.seen += 1;
          if (injectedFailure.seen > injectedFailure.skip) {
            const failureBody = injectedFailure.body ?? {
              message: "Injected failure for the 1M diagnosis run",
              type: "injected_error",
              code: "injected_error",
            };
            if (injectedFailure.finishReason === "length") {
              response.writeHead(200, { "content-type": "text/event-stream" });
              response.write(
                `data: ${JSON.stringify({
                  id: `local-${calls}`,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: "deepseek-flash",
                  choices: [{ index: 0, delta: { role: "assistant", content: "## Goal\n- cut" } }],
                })}\n\n`,
              );
              response.write(
                `data: ${JSON.stringify({
                  id: `local-${calls}`,
                  object: "chat.completion.chunk",
                  created: Math.floor(Date.now() / 1000),
                  model: "deepseek-flash",
                  choices: [{ index: 0, delta: {}, finish_reason: "length" }],
                })}\n\n`,
              );
              response.end("data: [DONE]\n\n");
              return;
            }
            response.writeHead(injectedFailure.status, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: failureBody }));
            return;
          }
        }
        if (fakeInsufficientBalance && calls >= 2) {
          response.writeHead(402, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: {
                message: "Insufficient Balance",
                type: "unknown_error",
                code: "invalid_request_error",
              },
            }),
          );
          return;
        }
        const requestTokens = Math.ceil(requestChars / 4);
        maxRequestTokens = Math.max(maxRequestTokens, requestTokens);
        maxRequestTokensByArm.set(
          requestArm,
          Math.max(maxRequestTokensByArm.get(requestArm) ?? 0, requestTokens),
        );
        if (requestTokens > requestCeilingTokens) {
          // The local service enforces the provider's real ceiling unconditionally. Gating this
          // behind an env flag let a run pass locally and then die on HTTP 400 in production,
          // which is exactly how the first paid attempt was lost. 1_048_576 is
          // DEEPSEEK_REQUEST_CEILING_TOKENS in tools/pi-million-config.ts. A 400 here means the
          // stages are too large; shrink the corpus, never the ceiling.
          rejectedOverCeiling += 1;
          response.writeHead(400, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              error: {
                message: `This model's maximum context length is ${requestCeilingTokens} tokens. However, you requested ${requestTokens} tokens. Please reduce the length of the messages or completion.`,
                type: "invalid_request_error",
                code: "invalid_request_error",
              },
            }),
          );
          return;
        }
        const answer = isSummary
          ? `## Goal\n- Continue the staged task.\n## Progress\n- Prior stages were received.\n## Next Steps\n- Reply exactly ${currentStageMarker}.`
          : (latestStageMarker ?? currentStageMarker);
        // Report the size the request really is; reporting a small constant would leave Pi's
        // threshold checks blind and no compaction would ever be exercised.
        const promptTokens =
          materialCall && injectedUsage !== null && injectedUsage.seen <= injectedUsage.calls
            ? injectedUsage.tokens
            : growthRun
              ? requestTokens
              : 1200;
        const body = {
          id: `local-${calls}`,
          object: "chat.completion",
          created: Math.floor(Date.now() / 1000),
          model: "deepseek-flash",
          choices: [
            {
              index: 0,
              message: { role: "assistant", content: answer },
              finish_reason: "stop",
            },
          ],
          usage: {
            prompt_tokens: promptTokens,
            completion_tokens: 12,
            total_tokens: promptTokens + 12,
          },
        };
        const chunk = (choice: unknown, usage?: unknown): string =>
          `data: ${JSON.stringify({
            id: body.id,
            object: "chat.completion.chunk",
            created: body.created,
            model: body.model,
            choices: choice === null ? [] : [choice],
            ...(usage === undefined ? {} : { usage }),
          })}\n\n`;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(chunk({ index: 0, delta: { role: "assistant", content: answer } }));
        response.write(chunk({ index: 0, delta: {}, finish_reason: "stop" }));
        response.write(chunk(null, body.usage));
        response.end("data: [DONE]\n\n");
      });
      await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
      try {
        const address = server.address();
        if (address === null || typeof address === "string") throw new Error("No loopback port");
        writeFileSync(
          join(base, "models.json"),
          JSON.stringify({
            providers: {
              deepseek: {
                baseUrl: `http://127.0.0.1:${address.port}/v1`,
                apiKey: "local-test-only",
                modelOverrides: { "deepseek-flash": {} },
              },
            },
          }),
        );
        writeFileSync(
          join(base, "settings.json"),
          JSON.stringify({ defaultProjectTrust: "never" }),
        );
        const longMaterial = largeLoopback
          ? "项目记录：本周核对交付清单与责任人；请仅在问题出现时回答。\n".repeat(45_000)
          : "";
        const stages = Array.from({ length: stageCount }, (_, index) => {
          const file = `stage${index + 1}.txt`;
          const material = sourceStages?.[index]
            ? readFileSync(join(dirname(sourceManifest ?? ""), sourceStages[index].file), "utf8")
            : longMaterial;
          writeFileSync(
            join(temp, file),
            `${material}\nReply exactly ${fakeOverflow ? `STAGE_${index + 1}` : "STAGE_OK"}. This is stage ${index + 1}.`,
          );
          return { file, expectedContains: fakeOverflow ? `STAGE_${index + 1}` : "STAGE_OK" };
        });
        writeFileSync(
          join(temp, "manifest.json"),
          JSON.stringify({
            id: "local-loopback",
            stages,
          }),
        );
        const env = { ...process.env };
        for (const key of Object.keys(env)) {
          if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD)/i.test(key)) delete env[key];
        }
        Object.assign(env, {
          PI_CLI: piCli,
          PI_NODE: process.env.PI_NODE ?? process.execPath,
        });
        delete env.PI_OFFLINE;
        const runner = fileURLToPath(new URL("../tools/pi-million-rpc.ts", import.meta.url));
        const child = spawn(
          process.execPath,
          [
            "--import",
            "tsx",
            runner,
            "--manifest",
            join(temp, "manifest.json"),
            "--agent-base",
            base,
            "--out",
            join(temp, "result"),
            "--min-compactions",
            preflightOnly ? "0" : growthRun ? "2" : "0",
            // The frozen source corpus is far longer than the synthetic loopback: each arm
            // simply sends more material, so the cumulative prompt budget has to scale with it.
            ...(sourceManifest ? ["--max-prompt-tokens", "400000000"] : []),
            ...(preflightOnly ? ["--max-stages", "1"] : []),
          ],
          { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
        );
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString("utf8").slice(0, 500);
        });
        const exit = await Promise.race([
          new Promise<number | null>((done) => child.once("exit", (code) => done(code))),
          new Promise<null>((done) =>
            setTimeout(
              () => {
                child.kill();
                done(null);
              },
              sourceManifest ? sourceRunTimeoutMs : largeLoopback ? 240_000 : 90_000,
            ),
          ),
        ]);
        // Print the numbers before asserting, so a failing gate still shows how far it got.
        const report = JSON.parse(readFileSync(join(temp, "result-report.json"), "utf8"));
        process.stdout.write(
          `${JSON.stringify(
            {
              manifest: sourceManifest ?? null,
              // The report's own manifestHash covers the loopback manifest this test writes.
              // Its material comes from the frozen corpus, so name that file's bytes too.
              sourceManifestHash: sourceManifest
                ? createHash("sha256").update(readFileSync(sourceManifest)).digest("hex")
                : null,
              sourceStages: sourceStages?.length ?? null,
              manifestId: report.manifestId,
              manifestHash: report.manifestHash,
              stagesRun: report.stagesRun,
              requests: calls,
              summaryRequests,
              summaryMaxTokensByArm: Object.fromEntries(
                [...summaryMaxTokensByArm].map(([arm, seen]) => [arm, [...seen]]),
              ),
              maxRequestTokens,
              maxRequestTokensByArm: Object.fromEntries(maxRequestTokensByArm),
              rejectedOverCeiling,
              comparable: report.comparable,
              budgetTruncatedArms: report.budgetTruncatedArms,
              systemPromptPrefixesDistinct: report.systemPromptPrefixesDistinct,
              maxPromptTokens: report.maxPromptTokens,
              maxCostUsd: report.maxCostUsd,
              systemPromptPrefixes: Object.fromEntries(
                [...observedSystemPrefixes].map(([arm, seen]) => [arm, [...seen]]),
              ),
              arms: (report.arms as Array<Record<string, unknown>>).map((arm) => ({
                arm: arm.arm,
                completed: arm.completed,
                compactions: arm.compactions,
                unpricedCompactions: arm.unpricedCompactions,
                calls: arm.calls,
                stages: (arm.stages as unknown[]).length,
                stagesCompleted: arm.stagesCompleted,
                qualityFailed: arm.qualityFailed,
                // Cumulative prompt tokens over the whole arm: the figure the paid run's budget
                // cap has to be derived from, not guessed.
                promptTokensTotal:
                  (arm.stages as Array<{ promptTokensSoFar?: number }>).at(-1)?.promptTokensSoFar ??
                  0,
                maxObservedContextTokens: arm.maxObservedContextTokens,
                compactionSizes: arm.compactionSizes,
                compactionsByInitiator: arm.compactionsByInitiator,
                compactionsByReason: arm.compactionsByReason,
                reason: arm.reason,
                budgetStop: arm.budgetStop,
                failuresByCall: arm.failuresByCall,
                lastFailure: arm.lastFailure,
                hostRetryAttempts: arm.hostRetryAttempts,
                assistantStopReasons: arm.assistantStopReasons,
                totalCost: arm.totalCost,
                systemPromptPrefixHash: arm.systemPromptPrefixHash,
                systemPromptPrefixTokens: arm.systemPromptPrefixTokens,
              })),
            },
            null,
            2,
          )}\n`,
        );
        expect(exit, stderr).toBe(fakeInsufficientBalance ? 1 : 0);
        if (fakeInsufficientBalance) {
          expect(report.arms).toHaveLength(1);
          expect(report.arms[0].reason).toMatch(/^stage-2-no-successful-response$/);
          // DeepSeek's real 402 body names the cause in `message` and puts the *generic*
          // `invalid_request_error` in `code`. The named cause has to win, or a drained balance
          // would be filed as a malformed request.
          expect(report.arms[0].lastFailure.status).toBe(402);
          expect(report.arms[0].lastFailure.category).toBe("insufficient-balance");
          return;
        }
        expect(report.comparable).toBe(!preflightOnly);
        expect(report.preflightPassed).toBe(preflightOnly);
        expect(report.arms).toHaveLength(3);
        expect(report.arms.map((arm: { completed: boolean }) => arm.completed)).toEqual([
          true,
          true,
          true,
        ]);
        // A full, untruncated run: no stop line fired, and the three arms' preambles are distinct.
        expect(report.budgetTruncatedArms).toEqual([]);
        expect(report.budgetTruncated).toBe(false);
        expect(report.maxCostUsd).toBeNull();
        expect(report.systemPromptPrefixesDistinct).toBe(true);
        if (fakeOverflow)
          expect(
            report.arms.every((arm: { qualityFailed: number }) => arm.qualityFailed === 0),
          ).toBe(true);
        expect(calls).toBeGreaterThanOrEqual(preflightOnly ? 3 : 12);
        // Three arms, three cache namespaces, no sharing: without this the arms could read each
        // other's cached prefixes and the comparison would stop being three independent runs.
        expect([...observedUserIds].sort()).toEqual([
          "foldpoint-1m-default",
          "foldpoint-1m-dynamic",
          "foldpoint-1m-fixed60",
        ]);
        // Second line against cross-arm cache reuse: every arm's request must open with its own
        // marker, so the three prefixes differ from token zero, and each arm must stay identical
        // to itself. This reads the bytes the local service parsed, not the config file.
        expect([...observedSystemPrefixes.keys()].sort()).toEqual([
          "foldpoint-1m-default",
          "foldpoint-1m-dynamic",
          "foldpoint-1m-fixed60",
        ]);
        const armPrefixes = ["default", "fixed60", "dynamic"].map((arm) => {
          const seen = [...(observedSystemPrefixes.get(`foldpoint-1m-${arm}`) ?? [])];
          // One distinct opening per arm: a mid-run change would mean the prefix is not fixed.
          expect(seen).toHaveLength(1);
          expect(seen[0]).toBe(millionSystemPromptMarker(arm as MillionArmId));
          return seen[0];
        });
        expect(new Set(armPrefixes).size).toBe(3);
        // The arms diverge at the start of the conversation, not deep inside it: the longest
        // shared opening of any two arms stays within the first couple of characters.
        const longestSharedOpening = Math.max(
          0,
          ...armPrefixes.flatMap((left, index) =>
            armPrefixes
              .slice(index + 1)
              .map((right) => commonPrefixLength(left ?? "", right ?? "")),
          ),
        );
        expect(longestSharedOpening).toBeLessThanOrEqual(2);
        if (!largeLoopback && !sourceManifest) expect(sawDeterministicRequest).toBe(true);
        if (growthRun && !preflightOnly) {
          // The whole point of the small-stage corpus: every arm reaches the threshold twice
          // or more, and never by pushing a single request over the provider's ceiling.
          expect(report.arms.every((arm: { compactions: number }) => arm.compactions >= 2)).toBe(
            true,
          );
          // The new evidence fields must stay empty when nothing failed, or they would not be
          // evidence of anything: a full gate run has zero failed calls and no `length` stop.
          expect(
            (report.arms as Array<{ failures: unknown[]; assistantStopReasons: object }>).every(
              (arm) =>
                arm.failures.length === 0 &&
                Object.keys(arm.assistantStopReasons).every((reason) => reason === "stop"),
            ),
          ).toBe(true);
          // The summary cap that equalizes the arms must reach the provider, and every arm must
          // have asked for the same one. Pi computes `min(floor(0.8 * reserveTokens), maxTokens)`
          // and fixed60's reserve is 320,000, so an unshared cap would let it ask for 256,000
          // output tokens while `default` asked for 13,107 - a different summarizer per arm. The
          // old shared value of 4,096 truncated the ~800k-token summary instead and killed both
          // paid pilots on the overflow summary call (see `MILLION_SUMMARY_MAX_TOKENS`).
          expect(summaryRequests).toBeGreaterThan(0);
          for (const arm of ["default", "fixed60", "dynamic"]) {
            expect([...(summaryMaxTokensByArm.get(`foldpoint-1m-${arm}`) ?? [])]).toEqual([
              MILLION_SUMMARY_MAX_TOKENS,
            ]);
          }
          expect(rejectedOverCeiling).toBe(0);
          expect(maxRequestTokens).toBeLessThanOrEqual(requestCeilingTokens);
        }
        // Stop lines, against the same fake provider: an arm that reaches one is marked
        // `budget-truncated`, stops early, and is never reported as comparable or as a win.
        const runShortRun = async (
          name: string,
          args: string[],
          maxStages = 3,
          manifestPath = join(temp, "manifest.json"),
        ): Promise<{ code: number | null; outcome: ShortRunReport; stderr: string }> => {
          const child = spawn(
            process.execPath,
            [
              "--import",
              "tsx",
              runner,
              "--manifest",
              manifestPath,
              "--agent-base",
              base,
              "--out",
              join(temp, name),
              "--max-stages",
              String(maxStages),
              "--min-compactions",
              "0",
              ...args,
            ],
            { cwd: root, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true },
          );
          let errorText = "";
          child.stderr.on("data", (chunk: Buffer) => {
            errorText += chunk.toString("utf8").slice(0, 500);
          });
          const code = await Promise.race([
            new Promise<number | null>((done) => child.once("exit", (value) => done(value))),
            new Promise<null>((done) =>
              setTimeout(() => {
                child.kill();
                done(null);
              }, 120_000),
            ),
          ]);
          return {
            code,
            stderr: errorText,
            outcome: JSON.parse(
              readFileSync(join(temp, `${name}-report.json`), "utf8"),
            ) as ShortRunReport,
          };
        };
        const firstArm = (outcome: ShortRunReport) => {
          const arm = outcome.arms[0];
          if (arm === undefined) throw new Error("The short run reported no arm");
          return arm;
        };
        const stopOf = (arm: ReturnType<typeof firstArm>) => {
          if (arm.budgetStop === null)
            throw new Error("The stop-line run did not report a budget stop");
          return arm.budgetStop;
        };
        const costStop = await runShortRun("stop-cost", ["--max-cost-usd", "0.000001"]);
        const costArm = firstArm(costStop.outcome);
        const costStopInfo = stopOf(costArm);
        process.stdout.write(
          `stop-line cost: ${JSON.stringify(costStopInfo)} stages=${costArm.stagesCompleted} promptTokens=${costArm.promptTokensTotal} cost=${costArm.totalCost} comparable=${costStop.outcome.comparable}\n`,
        );
        expect(costStop.code, costStop.stderr).toBe(1);
        // Only the first arm runs: the runner stops the whole trial at the first truncated arm.
        expect(costStop.outcome.arms).toHaveLength(1);
        expect(costStop.outcome.budgetTruncatedArms).toEqual(["default"]);
        expect(costArm.reason).toBe("budget-truncated");
        expect(costStopInfo.kind).toBe("cost-usd");
        expect(costStopInfo.limit).toBe(0.000001);
        expect(costStopInfo.observed).toBeGreaterThanOrEqual(0.000001);
        expect(costStopInfo.currency).toBe("USD");
        expect(costArm.totalCost).toBeGreaterThanOrEqual(costStopInfo.observed);
        // Stopped after one completed stage, and the report says so next to the money it spent.
        expect(costArm.stagesCompleted).toBe(1);
        expect(costArm.promptTokensTotal).toBeGreaterThan(0);
        expect(costStop.outcome.comparable).toBe(false);
        expect(costStop.outcome.pilotCostAndQualitySignal).toBe(false);
        const tokenStop = await runShortRun("stop-tokens", ["--max-prompt-tokens", "1"]);
        const tokenArm = firstArm(tokenStop.outcome);
        const tokenStopInfo = stopOf(tokenArm);
        process.stdout.write(
          `stop-line tokens: ${JSON.stringify(tokenStopInfo)} stages=${tokenArm.stagesCompleted} comparable=${tokenStop.outcome.comparable}\n`,
        );
        expect(tokenStop.code, tokenStop.stderr).toBe(1);
        expect(tokenStop.outcome.arms).toHaveLength(1);
        expect(tokenArm.reason).toBe("budget-truncated");
        expect(tokenStopInfo.kind).toBe("prompt-tokens");
        expect(tokenStopInfo.observed).toBeGreaterThan(1);
        expect(tokenArm.stagesCompleted).toBe(1);
        expect(tokenStop.outcome.comparable).toBe(false);

        // Failure diagnosis, against the same zero-cost service. The paid pilots stopped at stages
        // 68 and 102 with no way to tell why: the first left only `errorCode: "failed"`, the second
        // three failures all filed as `error-without-status`. These four runs pin the evidence down
        // - which class of call failed, the HTTP status when one exists, and the cause when none
        // does - using the block above to answer one class of call with a real HTTP status or a
        // truncated stream. No request leaves this machine.
        //
        // Their own manifest, ~110k characters (~28k tokens) per stage: Pi cuts a summary out of
        // *real* message sizes, so the transcript has to be long enough to have something to
        // summarize. It is deliberately independent of the corpus under test, which is what keeps
        // this run short.
        const diagStages = [1, 2].map((index) => {
          const file = `diag-stage-${index}.txt`;
          writeFileSync(
            join(temp, file),
            `${"项目记录：本周核对交付清单与责任人；请仅在问题出现时回答。\n".repeat(
              3_700,
            )}\nReply exactly STAGE_OK. This is stage ${index}.`,
          );
          return { file, expectedContains: "STAGE_OK" };
        });
        writeFileSync(
          join(temp, "diag-manifest.json"),
          JSON.stringify({ id: "diag-loopback", stages: diagStages }),
        );
        const diagManifest = join(temp, "diag-manifest.json");
        const writeDiagnosis = (
          label: string,
          run: { code: number | null; outcome: ShortRunReport },
        ): void => {
          process.stdout.write(
            `diagnosis ${label}: exit=${run.code} arms=${JSON.stringify(
              run.outcome.arms.map((arm) => ({
                reason: arm.reason,
                failuresByCall: arm.failuresByCall,
                lastFailure: arm.lastFailure,
                hostRetryAttempts: arm.hostRetryAttempts,
              })),
            )}\n`,
          );
        };
        let summaryFailureRun: {
          code: number | null;
          outcome: ShortRunReport;
          stderr: string;
        };
        try {
          // Two material calls report a context that has run past the declared window, which is
          // how a real conversation ends up asking for a summary: Pi answers the first one with a
          // silent no-op (nothing to summarize yet) and asks for the summary on the second. Two
          // stages, so there is something to summarize; the summary request is what this run
          // refuses.
          injectedUsage = { tokens: 900_000, calls: 2, seen: 0 };
          injectedFailure = { status: 500, on: "summary", skip: 0, seen: 0 };
          summaryFailureRun = await runShortRun("diag-summary-500", [], 2, diagManifest);
        } finally {
          injectedUsage = null;
          injectedFailure = null;
        }
        writeDiagnosis("summary 500", summaryFailureRun);
        const summaryArm = firstArm(summaryFailureRun.outcome);
        // The failed call was the host's own summarization request, during overflow recovery -
        // exactly the pilot's shape - and the report now says so.
        expect(summaryArm.failuresByCall.summary).toBeGreaterThanOrEqual(1);
        expect(summaryArm.failuresByCall.material).toBe(0);
        expect(summaryArm.lastFailure?.call).toBe("summary");
        expect(summaryArm.lastFailure?.compactionReason).toBe("overflow");
        // The status is only knowable if it was read out of the provider layer's error text: the
        // injected body deliberately does not repeat `500`, and names no cause either, so the
        // category has to come from the status.
        expect(summaryArm.lastFailure?.status).toBe(500);
        expect(summaryArm.lastFailure?.category).toBe("server-error");
        // The host answered; nothing about the RPC session was lost. A real provider failure must
        // not acquire a transport-loss kind, or the new field would stop meaning anything.
        expect(summaryArm.lastFailure?.rpcLoss).toBeNull();
        // The failed call belongs to the stage whose post-response check asked for the summary.
        expect(summaryArm.lastFailure?.stage).toBe(2);
        expect(summaryArm.failures.map((failure) => failure.stage)).toContain(2);
        // Pi retried the summarization itself before giving up; the count is reported, not acted on.
        expect(summaryArm.hostRetryAttempts).toBeGreaterThanOrEqual(1);
        expect(summaryFailureRun.outcome.failedArms).toEqual(["default"]);
        // A diagnosed failure is still a failure: the trial stops and never claims a comparison.
        expect(summaryFailureRun.code, summaryFailureRun.stderr).toBe(1);
        expect(summaryArm.reason).not.toBeNull();
        expect(summaryFailureRun.outcome.comparable).toBe(false);

        // The structured half of the same question: a refusal whose *body* names its cause while
        // its `type` is the generic `invalid_request_error` that OpenAI-shaped APIs put on most
        // 4xx. Only the body's own words separate this from a malformed request, and only a real
        // parse of the provider body reaches them - which is what pins `error.type` /
        // `error.code` down.
        let contextFailureRun: {
          code: number | null;
          outcome: ShortRunReport;
          stderr: string;
        };
        try {
          injectedUsage = { tokens: 900_000, calls: 2, seen: 0 };
          injectedFailure = {
            status: 400,
            on: "summary",
            skip: 0,
            seen: 0,
            body: {
              message: `This model's maximum context length is ${requestCeilingTokens} tokens. However, you requested ${requestCeilingTokens + 1} tokens.`,
              type: "invalid_request_error",
              code: "context_length_exceeded",
            },
          };
          contextFailureRun = await runShortRun("diag-summary-400-context", [], 2, diagManifest);
        } finally {
          injectedUsage = null;
          injectedFailure = null;
        }
        writeDiagnosis("summary 400 context-length", contextFailureRun);
        const contextArm = firstArm(contextFailureRun.outcome);
        expect(contextArm.lastFailure?.call).toBe("summary");
        expect(contextArm.lastFailure?.status).toBe(400);
        // Not `invalid-request`, even though `type` says exactly that: the body's `code` names the
        // cause, and the generic token must not mask it.
        expect(contextArm.lastFailure?.category).toBe("context-length");
        expect(contextArm.lastFailure?.compactionReason).toBe("overflow");
        expect(contextFailureRun.code, contextFailureRun.stderr).toBe(1);
        expect(contextFailureRun.outcome.comparable).toBe(false);

        // The shape both paid pilots actually left behind: a summary that stopped on its own
        // output cap. HTTP 200, no status anywhere on the wire, the host's label the only
        // evidence - which used to land in `error-without-status` and now names the cause.
        let truncatedSummaryRun: {
          code: number | null;
          outcome: ShortRunReport;
          stderr: string;
        };
        try {
          injectedUsage = { tokens: 900_000, calls: 2, seen: 0 };
          injectedFailure = {
            status: 200,
            on: "summary",
            skip: 0,
            seen: 0,
            finishReason: "length",
          };
          truncatedSummaryRun = await runShortRun("diag-summary-length", [], 2, diagManifest);
        } finally {
          injectedUsage = null;
          injectedFailure = null;
        }
        writeDiagnosis("summary length stop", truncatedSummaryRun);
        const truncatedArm = firstArm(truncatedSummaryRun.outcome);
        expect(truncatedArm.lastFailure?.call).toBe("summary");
        // Nothing on the wire carried a status, so there is none to report - and the category does
        // not pretend otherwise.
        expect(truncatedArm.lastFailure?.status).toBeNull();
        expect(truncatedArm.lastFailure?.category).toBe("summary-output-cap");
        expect(truncatedArm.lastFailure?.compactionReason).toBe("overflow");
        // A truncated summary is not retried by the host, and the report says that too.
        expect(truncatedArm.hostRetryAttempts).toBe(0);
        expect(truncatedSummaryRun.code, truncatedSummaryRun.stderr).toBe(1);
        expect(truncatedSummaryRun.outcome.comparable).toBe(false);

        let materialFailureRun: {
          code: number | null;
          outcome: ShortRunReport;
          stderr: string;
        };
        try {
          injectedUsage = null;
          injectedFailure = { status: 429, on: "material", skip: 0, seen: 0 };
          materialFailureRun = await runShortRun("diag-material-429", [], 2, diagManifest);
        } finally {
          injectedFailure = null;
        }
        writeDiagnosis("material 429", materialFailureRun);
        const materialArm = firstArm(materialFailureRun.outcome);
        // The other half: a staged material call refused, before any compaction was considered.
        expect(materialArm.lastFailure?.call).toBe("material");
        expect(materialArm.lastFailure?.status).toBe(429);
        expect(materialArm.lastFailure?.category).toBe("rate-limit");
        expect(materialArm.lastFailure?.compactionReason).toBeNull();
        expect(materialArm.lastFailure?.stage).toBe(1);
        expect(materialArm.failuresByCall.material).toBeGreaterThanOrEqual(1);
        expect(materialArm.failuresByCall.summary).toBe(0);
        // The stage that never got a response is named, and the failure is attributed to it.
        expect(materialArm.reason).toBe("stage-1-no-successful-response");
        expect(materialFailureRun.code, materialFailureRun.stderr).toBe(1);
        expect(materialFailureRun.outcome.comparable).toBe(false);
        // A stop reason other than `stop` is now visible even when no call errored: the pilot's
        // stage-68 response was a `length` stop, which the old report could not tell apart from a
        // wrong answer. Here every recorded reason is the injected error, and none is `stop`.
        expect(
          Object.keys(materialArm.assistantStopReasons).every((reason) => reason === "error"),
        ).toBe(true);
      } finally {
        await new Promise<void>((done) => server.close(() => done()));
      }
    },
    sourceManifest ? sourceRunTimeoutMs + 30_000 : largeLoopback ? 300_000 : 150_000,
  );
});
