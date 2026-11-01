/** Real Pi RPC child processes against a guarded local synthetic provider, never a paid API. */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createPiLearnedShadow } from "../adapters/pi/learned-shadow";
import { resolveUnitPrices } from "../src/pricing";
import { RpcSession } from "./pi-million-rpc";
import { openPiShadowJournal } from "./pi-shadow-journal";

const pi = resolve(process.argv[2] ?? "D:/pi");
const cli = join(pi, "packages/coding-agent/dist/cli.js");
const dir = mkdtempSync(join(tmpdir(), "foldpoint-rpc-shadow-"));
const journalPath = join(dir, "feedback.jsonl");
const binding = {
  profileBinding: "a".repeat(64),
  compactorBinding: "b".repeat(64),
  estimatorId: "pi-host/v1",
};
const assumptions = { beforeErrorTokens: 0, afterErrorTokens: 0, driftToleranceRatio: 0.05 };
let calls = 0;
const server = http.createServer((request, response) => {
  if (request.method !== "POST" || request.url !== "/v1/chat/completions" || ++calls > 8) {
    response.writeHead(400).end();
    return;
  }
  request.resume();
  request.on("end", () => {
    response.writeHead(200, { "content-type": "text/event-stream" });
    const envelope = (choices: unknown[], usage?: unknown) => ({
      id: "local",
      object: "chat.completion.chunk",
      created: 1,
      model: "probe",
      choices,
      ...(usage ? { usage } : {}),
    });
    const events = [
      envelope([
        {
          index: 0,
          delta: {
            role: "assistant",
            content: "## Goal\nContinue the synthetic task.\n## Next Steps\nReply ACK.",
          },
          finish_reason: null,
        },
      ]),
      envelope([{ index: 0, delta: {}, finish_reason: "stop" }]),
      envelope([], {
        prompt_tokens: 10000,
        completion_tokens: 20,
        prompt_tokens_details: { cached_tokens: 0 },
      }),
    ];
    response.end(`${events.map((e) => `data: ${JSON.stringify(e)}\n\n`).join("")}data: [DONE]\n\n`);
  });
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
assert(address && typeof address !== "string");
const origin = `http://127.0.0.1:${address.port}`;
writeFileSync(
  join(dir, "models.json"),
  JSON.stringify({
    providers: {
      localtest: {
        baseUrl: `${origin}/v1`,
        api: "openai-completions",
        apiKey: "synthetic-local-only",
        compat: { maxTokensField: "max_tokens" },
        models: [
          {
            id: "probe",
            contextWindow: 100000,
            maxTokens: 2048,
            cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
          },
        ],
      },
    },
  }),
);
writeFileSync(
  join(dir, "settings.json"),
  JSON.stringify({
    compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 4096 },
    retry: { enabled: false },
    cacheWarming: "off",
  }),
);
const guard = new URL("./pi-rpc-loopback-guard.mjs", import.meta.url).href;
const env: NodeJS.ProcessEnv = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  TEMP: process.env.TEMP,
  TMP: process.env.TMP,
  PI_CODING_AGENT_DIR: dir,
  PI_CODING_AGENT_SESSION_DIR: join(dir, "sessions"),
  PI_SKIP_VERSION_CHECK: "1",
  PI_OFFLINE: "1",
  FOLDPOINT_TEST_LOOPBACK_ORIGIN: origin,
};
const openRpc = () =>
  new RpcSession(
    process.execPath,
    [
      "--import",
      guard,
      cli,
      "--mode",
      "rpc",
      "--provider",
      "localtest",
      "--model",
      "probe",
      "--thinking",
      "off",
      "--no-tools",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-session",
      "--no-approve",
    ],
    dir,
    env,
  );
const makeShadow = (journal: ReturnType<typeof openPiShadowJournal>) =>
  createPiLearnedShadow({
    binding,
    assumptions,
    loadHistory: journal.loadHistory,
    appendFeedback: journal.appendFeedback,
    writeEvaluation: () => {},
  });
const evaluationInput = {
  contextTokens: 55000,
  growthTokens: 2000,
  prices: resolveUnitPrices({ inputPerMillion: 3, outputPerMillion: 15, cacheReadPerMillion: 0.3 }),
  billingModel: {
    after: { slope: 0.1, intercept: 2000, residual: 0 },
    output: { slope: 0.002, intercept: 10, residual: 0 },
    samples: 0,
    minBefore: 0,
    maxBefore: 70000,
    summaryInputCostPerToken: 3e-6,
  },
  softBoundary: 50000,
  fallbackBoundary: 60000,
  forceBoundary: 70000,
};
let rpc: RpcSession | undefined;
try {
  let journal = openPiShadowJournal(journalPath, binding, assumptions);
  let shadow = makeShadow(journal);
  const cold = shadow.evaluate(evaluationInput);
  assert.equal(cold.status, "evaluated");
  assert("recommendation" in cold);
  assert.equal(cold.recommendation.reason, "unidentified-retention");
  rpc = openRpc();
  await rpc.command("get_state");
  for (let i = 0; i < 2; i++) {
    const from = rpc.events.length;
    await rpc.command("prompt", { message: `Synthetic task ${i}: reply ACK.` });
    await rpc.waitFor((event) => event.type === "agent_settled", from, 15000);
    await rpc.settleTurn(from, 15000);
  }
  assert.equal(calls, 2);
  const result = await rpc.command("compact", {}, 15000);
  const summaryCalls = calls - 2;
  assert(summaryCalls >= 1);
  assert.equal(shadow.observeImmediate(result.data, { sequence: 1, stage: 2 }).accepted, true);
  const expected = shadow.snapshot();
  const expectedEvaluation = shadow.evaluate(evaluationInput);
  await rpc.close();
  rpc = undefined;
  journal.close();
  journal = openPiShadowJournal(journalPath, binding, assumptions);
  shadow = makeShadow(journal);
  assert.deepEqual(shadow.snapshot(), expected);
  assert.deepEqual(shadow.evaluate(evaluationInput), expectedEvaluation);
  rpc = openRpc();
  await rpc.command("get_state");
  for (let i = 0; i < 2; i++) {
    const start = rpc.events.length;
    await rpc.command("prompt", { message: `Synthetic task after restart ${i}: reply ACK.` });
    await rpc.waitFor((event) => event.type === "agent_settled", start, 15000);
    await rpc.settleTurn(start, 15000);
  }
  assert.equal(shadow.snapshot().retainedSamples, 1);
  const beforeSecondSummary = calls;
  const secondResult = await rpc.command("compact", {}, 15000);
  const secondSummaryCalls = calls - beforeSecondSummary;
  assert(secondSummaryCalls >= 1);
  assert.equal(
    shadow.observeImmediate(secondResult.data, { sequence: 2, stage: 4 }).accepted,
    true,
  );
  assert.equal(
    shadow.observeImmediate(secondResult.data, { sequence: 2, stage: 4 }).accepted,
    false,
  );
  assert.equal(shadow.snapshot().retainedSamples, 2);
  assert(!readFileSync(journalPath, "utf8").includes("Synthetic"));
  assert.equal(calls, 4 + summaryCalls + secondSummaryCalls);
  journal.close();
  process.stdout.write(
    `${JSON.stringify({ completed: true, piRpcProcesses: 2, ordinaryCalls: 4, summaryCalls: summaryCalls + secondSummaryCalls, restoredSamples: 1, finalSamples: 2, evaluationRestored: true, paidCalls: 0, applied: false })}\n`,
  );
} finally {
  if (rpc) await rpc.close();
  server.closeAllConnections();
  await new Promise<void>((done) => server.close(() => done()));
}
