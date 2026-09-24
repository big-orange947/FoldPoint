/**
 * Zero-paid Pi integration smoke. A loopback OpenAI-compatible provider simulates a 12-second
 * cache TTL and a 14-second tool call. Run with PI_CLI pointing at Pi's cli.js and, when the
 * shell's Node is too old for Pi, PI_NODE pointing at Node >=22.19.
 *
 *   PI_CLI=/path/to/pi/dist/bundle/cli.js npx tsx tools/pi-cache-warming-smoke.ts
 *
 * This verifies wiring and accounting, not a real provider's prices or cache behavior.
 */

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTraceJsonl } from "../src/index";
import { analyzeTraceEvents } from "./trace-analyze";

type WarmingMode = "off" | "streaming";

interface SmokeResult {
  mode: WarmingMode;
  work: string;
  normalHttpRequests: number;
  oneTokenHttpRequests: number;
  cacheWarms: number;
  secondCallCacheReadTokens: number;
  secondCallCacheWriteTokens: number;
  skippedNextCallAfterWarm: number;
  callCost: number;
  cacheWarmCost: number;
  totalCost: number;
}

async function runMode(mode: WarmingMode, piCli: string, piNode: string): Promise<SmokeResult> {
  const work = mkdtempSync(join(tmpdir(), `foldpoint-pi-warming-${mode}-`));
  const agentDir = join(work, "agent");
  const sessionDir = join(work, "sessions");
  const tracePath = join(work, "trace.jsonl");
  mkdirSync(agentDir);
  mkdirSync(sessionDir);

  let lastCacheAt = 0;
  let normalHttpRequests = 0;
  let oneTokenHttpRequests = 0;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
      max_tokens?: number;
      max_completion_tokens?: number;
    };
    const oneToken = body.max_tokens === 1 || body.max_completion_tokens === 1;
    if (oneToken) oneTokenHttpRequests += 1;
    else normalHttpRequests += 1;
    const now = Date.now();
    const cacheHit = now - lastCacheAt < 12_000;
    lastCacheAt = now;
    const id = `chatcmpl-local-${normalHttpRequests}-${oneTokenHttpRequests}`;
    const envelope = (choice: Record<string, unknown> | null, usage?: object): object => ({
      id,
      object: "chat.completion.chunk",
      created: Math.floor(now / 1_000),
      model: "fake-warm",
      choices: choice === null ? [] : [choice],
      ...(usage === undefined ? {} : { usage }),
    });
    response.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
    });
    const emit = (value: object): void => {
      response.write(`data: ${JSON.stringify(value)}\n\n`);
    };
    if (!oneToken && normalHttpRequests === 1) {
      emit(
        envelope({
          index: 0,
          delta: {
            role: "assistant",
            tool_calls: [
              {
                index: 0,
                id: "call_delay",
                type: "function",
                function: { name: "bash", arguments: JSON.stringify({ command: "sleep 14" }) },
              },
            ],
          },
          finish_reason: null,
        }),
      );
      emit(envelope({ index: 0, delta: {}, finish_reason: "tool_calls" }));
    } else {
      emit(
        envelope({
          index: 0,
          delta: { role: "assistant", content: oneToken ? "x" : "DONE" },
          finish_reason: null,
        }),
      );
      emit(envelope({ index: 0, delta: {}, finish_reason: "stop" }));
    }
    emit(
      envelope(null, {
        prompt_tokens: 20_000,
        completion_tokens: oneToken ? 1 : 20,
        prompt_tokens_details: {
          cached_tokens: cacheHit ? 20_000 : 0,
          cache_write_tokens: cacheHit ? 0 : 20_000,
        },
      }),
    );
    response.end("data: [DONE]\n\n");
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    const address = server.address();
    assert(address !== null && typeof address !== "string");
    writeFileSync(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          localtest: {
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            api: "openai-completions",
            apiKey: "local-test",
            compat: { maxTokensField: "max_tokens" },
            models: [
              {
                id: "fake-warm",
                contextWindow: 100_000,
                maxTokens: 2_048,
                promptCache: { short: 12 },
                cost: { input: 10, output: 10, cacheRead: 0.1, cacheWrite: 12 },
              },
            ],
          },
        },
      }),
    );
    writeFileSync(
      join(agentDir, "settings.json"),
      JSON.stringify({
        cacheWarming: mode,
        compaction: { enabled: false },
        defaultTools: ["bash"],
        sessionDir,
        defaultProjectTrust: "never",
      }),
    );
    const env = { ...process.env };
    for (const key of Object.keys(env)) {
      if (/(?:API_KEY|AUTH_TOKEN|ACCESS_TOKEN|SECRET|PASSWORD)/i.test(key)) delete env[key];
    }
    Object.assign(env, {
      PI_CODING_AGENT_DIR: agentDir,
      PI_CODING_AGENT_SESSION_DIR: sessionDir,
      PI_OFFLINE: "1",
      PI_SKIP_VERSION_CHECK: "1",
      FOLDPOINT_TRACE: tracePath,
      FOLDPOINT_PREFIX_STORE: join(work, "prefix.json"),
      FOLDPOINT_MODE: "observe",
    });
    delete env.PI_CACHE_RETENTION;
    delete env.FOLDPOINT_DEFAULTS;
    const extension = fileURLToPath(
      new URL("../adapters/pi/foldpoint-observe.ts", import.meta.url),
    );
    const child = spawn(
      piNode,
      [
        piCli,
        "--print",
        "--model",
        "localtest/fake-warm",
        "--tools",
        "bash",
        "--no-approve",
        "--extension",
        extension,
        "Use bash once, then answer DONE",
      ],
      { cwd: work, env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    const timer = setTimeout(() => child.kill(), 45_000);
    const exitCode = await new Promise<number | null>((resolve) => child.on("exit", resolve));
    clearTimeout(timer);
    assert.equal(exitCode, 0, `Pi ${mode} exited ${String(exitCode)}: ${stderr.slice(-1_000)}`);
    assert.match(stdout, /DONE/);

    const parsed = parseTraceJsonl(readFileSync(tracePath, "utf8"));
    assert.deepEqual(parsed.errors, []);
    const analysis = analyzeTraceEvents(parsed.events);
    const cost = analysis.sessionCosts[0];
    const requests = parsed.events.filter((event) => event.type === "request");
    assert(cost !== undefined);
    assert.equal(normalHttpRequests, 2);
    assert.equal(requests.length, 2);
    assert.equal(analysis.unpairedDecisions, 0);
    return {
      mode,
      work,
      normalHttpRequests,
      oneTokenHttpRequests,
      cacheWarms: analysis.cacheWarms,
      secondCallCacheReadTokens: requests[1]?.usage.cachedInputTokens ?? 0,
      secondCallCacheWriteTokens: requests[1]?.usage.cacheWriteTokens ?? 0,
      skippedNextCallAfterWarm: analysis.skippedNextCall.cacheWarm,
      callCost: cost.callCost,
      cacheWarmCost: cost.cacheWarmCost,
      totalCost: cost.totalCost,
    };
  } finally {
    server.close();
  }
}

const piCli = process.env.PI_CLI;
if (piCli === undefined) throw new Error("PI_CLI must point to Pi's dist/bundle/cli.js");
const piNode = process.env.PI_NODE ?? process.execPath;
const off = await runMode("off", piCli, piNode);
const streaming = await runMode("streaming", piCli, piNode);
assert.equal(off.oneTokenHttpRequests, 0);
assert.equal(off.cacheWarms, 0);
assert(off.secondCallCacheWriteTokens > 0, "The 14-second pause should expire the fake cache");
assert(streaming.oneTokenHttpRequests > 0);
assert.equal(streaming.cacheWarms, streaming.oneTokenHttpRequests);
assert(streaming.secondCallCacheReadTokens > 0);
assert.equal(streaming.skippedNextCallAfterWarm, 1);
assert(streaming.cacheWarmCost > 0);
assert.equal(streaming.totalCost, streaming.callCost + streaming.cacheWarmCost);
console.log(
  JSON.stringify(
    { runner: "foldpoint.pi-cache-warming-smoke.v1", paidApiCalls: 0, off, streaming },
    null,
    2,
  ),
);
