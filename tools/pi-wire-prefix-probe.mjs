// Actual Pi serializer + loopback HTTP boundary. Synthetic messages only; no paid endpoint.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createFoldPointObserver } from "../adapters/pi/foldpoint-observe.ts";
import { summaryUsageBill } from "../src/experimental-cycle.ts";
import { parseTraceJsonl, resolveUnitPrices } from "../src/index.ts";
import { SummaryInputCostLearner } from "./summary-input-cost.ts";
import { analyzeTraceEvents } from "./trace-analyze.ts";

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2)
  if (!["--pi", "--out"].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith("--"))
    throw new Error("usage: --pi <local Pi checkout> --out <fresh directory>");
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const piRoot = resolve(value("--pi", "D:/pi"));
const outArg = value("--out", undefined);
if (!outArg) throw new Error("A fresh --out directory is required");
const out = resolve(outArg);
if (existsSync(out)) throw new Error("Refusing to overwrite an existing wire probe");

const canonical = (v) =>
  Array.isArray(v)
    ? v.map(canonical)
    : v && typeof v === "object"
      ? Object.fromEntries(
          Object.keys(v)
            .sort()
            .map((k) => [k, canonical(v[k])]),
        )
      : v;
const hash = (v) =>
  createHash("sha256")
    .update(JSON.stringify(canonical(v)))
    .digest("hex");
const prefix = (before, after) =>
  before.length <= after.length && before.every((v, i) => v === after[i]);
const wireView = (body) => ({
  messages: body.messages.map(hash),
  // Strict request-field equality, not a claim about any real provider's cache key.
  fields: hash(Object.fromEntries(Object.entries(body).filter(([key]) => key !== "messages"))),
});
const cases = [
  "append-only",
  "payload-conversation",
  "payload-system",
  "payload-tools",
  "payload-model",
  "payload-truncation",
  "native-compaction",
];
const rows = [];
let active;
let phase = "ordinary";
let httpCalls = 0;
let externalAttempts = 0;
let requestBytes = 0;
const budget = { maxHttpCalls: 24, maxRequestBytes: 1_000_000 };
const server = http.createServer(async (request, response) => {
  try {
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/chat/completions");
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const wire = wireView(body);
    active.serverRequests++;
    if (phase === "summary") active.summaryRequests++;
    else {
      active.ordinaryRequests++;
      if (active.previousWire) {
        const messagePrefixSame = prefix(active.previousWire.messages, wire.messages);
        const otherFieldsSame = active.previousWire.fields === wire.fields;
        active.comparisons.push({
          earlyAppendOnly: active.earlyAppendOnly,
          messagePrefixSame,
          otherFieldsSame,
          wirePrefixUnchanged: messagePrefixSame && otherFieldsSame,
        });
      }
      active.previousWire = wire;
    }
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    const envelope = (choice, usage) => ({
      id: `local-${httpCalls}`,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "wire-probe",
      choices: choice ? [choice] : [],
      ...(usage ? { usage } : {}),
    });
    const emit = (event) => response.write(`data: ${JSON.stringify(event)}\n\n`);
    emit(
      envelope({
        index: 0,
        delta: {
          role: "assistant",
          content:
            phase === "summary"
              ? "## Goal\nContinue the synthetic task.\n## Next Steps\nAcknowledge the next update."
              : "ACK",
        },
        finish_reason: null,
      }),
    );
    emit(envelope({ index: 0, delta: {}, finish_reason: "stop" }));
    emit(
      envelope(null, {
        prompt_tokens: 10_000,
        completion_tokens: phase === "summary" ? 300 : 20,
        prompt_tokens_details: { cached_tokens: 0 },
      }),
    );
    response.end("data: [DONE]\n\n");
  } catch {
    active.serverErrors++;
    response.writeHead(400);
    response.end("invalid-synthetic-request");
  }
});
await new Promise((done) => server.listen(0, "127.0.0.1", done));
const origin = `http://127.0.0.1:${server.address().port}`;
const originalFetch = globalThis.fetch;
globalThis.fetch = async (...input) => {
  const target = new URL(input[0] instanceof Request ? input[0].url : String(input[0]));
  if (target.origin !== origin) {
    externalAttempts++;
    throw new Error("External network forbidden");
  }
  const body =
    input[1]?.body ?? (input[0] instanceof Request ? await input[0].clone().text() : undefined);
  assert.equal(typeof body, "string");
  assert(
    httpCalls < budget.maxHttpCalls &&
      requestBytes + Buffer.byteLength(body) <= budget.maxRequestBytes,
  );
  httpCalls++;
  requestBytes += Buffer.byteLength(body);
  return originalFetch(input[0], {
    ...input[1],
    redirect: "error",
    signal: AbortSignal.any([
      ...(input[1]?.signal ? [input[1].signal] : []),
      AbortSignal.timeout(15_000),
    ]),
  });
};
// The SDK uses fetch. Block alternative HTTP transports rather than allow an unobserved path.
const deny = () => {
  externalAttempts++;
  throw new Error("Unaccounted network forbidden");
};
http.request = deny;
https.request = deny;
syncBuiltinESMExports();

const report = {
  runner: "foldpoint.pi-wire-prefix.v1",
  completed: false,
  failure: null,
  providerSerializationExercised: false,
  boundary: "loopback-openai-chat-completions",
  paidCalls: 0,
  policyChanged: false,
  cacheHitsMeasured: false,
  taskQualityMeasured: false,
  budget,
  rows,
  limitations: [
    "Strict structural message-prefix/request-field checks, not byte/token-prefix equality or a provider cache-key specification.",
    "Controlled synthetic SDK sessions and one OpenAI-compatible serializer; not a universal stock-Pi continuity guarantee.",
    "No automatic prefix hint or economic approval is supplied to FoldPoint; no remote provider, savings or quality measurement.",
  ],
};
try {
  const load = (p) => import(pathToFileURL(join(piRoot, p)).href);
  const [
    { createAgentSession },
    { AuthStorage },
    { SessionManager },
    { SettingsManager },
    helpers,
    utilities,
    { emitSessionShutdownEvent },
  ] = await Promise.all([
    load("packages/coding-agent/src/core/sdk.ts"),
    load("packages/coding-agent/src/core/auth-storage.ts"),
    load("packages/coding-agent/src/core/session-manager.ts"),
    load("packages/coding-agent/src/core/settings-manager.ts"),
    load("packages/coding-agent/test/model-runtime-test-utils.ts"),
    load("packages/coding-agent/test/utilities.ts"),
    load("packages/coding-agent/src/core/extensions/runner.ts"),
  ]);
  mkdirSync(out, { recursive: true });
  report.piCommit = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: piRoot,
    encoding: "utf8",
  }).trim();
  report.sourceSha256 = createHash("sha256")
    .update(readFileSync(new URL(import.meta.url)))
    .digest("hex");
  report.piTrackedDirty =
    execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: piRoot,
      encoding: "utf8",
    }).trim() !== "";
  // SDK source imports a built provider. Record that exact build instead of assuming HEAD matches it.
  report.serializerBuildSha256 = createHash("sha256")
    .update(readFileSync(join(piRoot, "packages/ai/dist/api/openai-completions.js")))
    .digest("hex");
  const modelsPath = join(out, "models.json");
  writeFileSync(
    modelsPath,
    JSON.stringify({
      providers: {
        localtest: {
          baseUrl: `${origin}/v1`,
          api: "openai-completions",
          apiKey: "synthetic-local-only",
          compat: { maxTokensField: "max_tokens" },
          models: [
            {
              id: "wire-probe",
              contextWindow: 1_000_000,
              maxTokens: 2048,
              cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
            },
          ],
        },
      },
    }),
  );
  const auth = AuthStorage.inMemory();
  await auth.modify("localtest", async () => ({ type: "api_key", key: "synthetic-local-only" }));
  const registry = await helpers.createModelRegistry(auth, modelsPath);
  const model = registry.find("localtest", "wire-probe");
  assert(model);
  for (const id of cases) {
    phase = "ordinary";
    active = {
      id,
      ordinaryRequests: 0,
      summaryRequests: 0,
      serverRequests: 0,
      serverErrors: 0,
      earlyAppendOnly: null,
      previousWire: undefined,
      comparisons: [],
    };
    let previousEarly;
    const directory = join(out, id);
    mkdirSync(directory);
    const tracePath = join(directory, "trace.jsonl");
    const observer = createFoldPointObserver({
      tracePath,
      prefixStorePath: join(directory, "prefix.json"),
      mode: "observe",
      compaction: "off",
      log: () => {},
    });
    const extensionsResult = await utilities.createTestExtensionsResult(
      [
        (pi) => {
          pi.on("context", (event) => {
            const current = event.messages.map(hash);
            active.earlyAppendOnly = previousEarly ? prefix(previousEarly, current) : null;
            previousEarly = current;
          });
          observer(pi);
          pi.on("before_provider_request", (event) => {
            if (phase !== "ordinary" || active.ordinaryRequests !== 1 || id === "native-compaction")
              return;
            const payload = structuredClone(event.payload);
            if (id === "payload-conversation")
              payload.messages.find((m) => m.role === "user").content =
                "Synthetic payload rewrite.";
            if (id === "payload-system") payload.messages[0].content = "Synthetic system rewrite.";
            if (id === "payload-tools")
              payload.tools = [
                {
                  type: "function",
                  function: {
                    name: "synthetic",
                    description: "Changed",
                    parameters: { type: "object" },
                  },
                },
              ];
            if (id === "payload-model") payload.model = "wire-probe-other";
            if (id === "payload-truncation") payload.messages.splice(1, 1);
            return payload;
          });
        },
      ],
      directory,
    );
    const settings = SettingsManager.create(directory, directory);
    settings.applyOverrides({
      compaction: { enabled: false, keepRecentTokens: 1, reserveTokens: 4096 },
      retry: { enabled: false, maxRetries: 0 },
      cacheWarming: "off",
    });
    const { session } = await createAgentSession({
      model,
      thinkingLevel: "off",
      noTools: "all",
      cwd: directory,
      agentDir: directory,
      sessionManager: SessionManager.inMemory(),
      settingsManager: settings,
      modelRuntime: helpers.getModelRuntime(registry),
      resourceLoader: utilities.createTestResourceLoader({ extensionsResult }),
    });
    try {
      session.subscribe(() => {});
      await session.bindExtensions({});
      await session.prompt("Synthetic first task. Reply only ACK.");
      await session.prompt("Synthetic continuation. Reply only ACK.");
      if (id === "native-compaction") {
        phase = "summary";
        await session.compact();
        phase = "ordinary";
        await session.prompt("Synthetic continuation after summary. Reply only ACK.");
        await session.prompt("Synthetic additional continuation. Reply only ACK.");
      }
      await emitSessionShutdownEvent(session.extensionRunner, {
        type: "session_shutdown",
        reason: "exit",
      });
      const parsed = parseTraceJsonl(readFileSync(tracePath, "utf8"));
      assert.equal(parsed.errors.length, 0);
      const analysis = analyzeTraceEvents(parsed.events);
      const cost = analysis.sessionCosts[0];
      assert.equal(cost.calls, active.ordinaryRequests);
      assert.equal(cost.compactions, id === "native-compaction" ? 1 : 0);
      let aggregateInputLearning;
      if (active.summaryRequests > 0) {
        const summary = parsed.events.find((e) => e.type === "compaction" && e.success);
        assert.equal(summary.usage.promptTokens, active.summaryRequests * 10_000);
        assert.equal(summary.usage.outputTokens, active.summaryRequests * 300);
        const learner = new SummaryInputCostLearner("isolated-wire-fixture-v1");
        const prices = resolveUnitPrices({
          currency: "USD",
          inputPerMillion: 3,
          outputPerMillion: 15,
          cacheReadPerMillion: 0.3,
          cacheWritePerMillion: 3.75,
        });
        assert(
          learner.observe({
            binding: "isolated-wire-fixture-v1",
            sequence: 1,
            success: true,
            beforeTokens: summary.beforeTokens,
            usage: summary.usage,
            prices,
          }),
        );
        aggregateInputLearning = learner.snapshot("isolated-wire-fixture-v1");
        // Reconciliation, NOT a prediction: this observation is only available after completion.
        const reconstructed = summaryUsageBill(
          prices,
          summary.beforeTokens,
          summary.usage.outputTokens,
          0,
          1,
          {},
          aggregateInputLearning.effectiveInputCostPerBeforeToken,
        );
        assert(Math.abs(reconstructed - active.summaryRequests * 0.0345) < 1e-12);
      }
      const expectedCost =
        active.ordinaryRequests * (10_000 * 3e-6 + 20 * 15e-6) +
        active.summaryRequests * (10_000 * 3e-6 + 300 * 15e-6);
      assert(Math.abs(cost.totalCost - expectedCost) < 1e-12);
      assert.equal(cost.unpricedCompactions, 0);
      assert.equal(active.serverErrors, 0);
      const expected =
        id === "append-only" ? [true] : id === "native-compaction" ? [true, false, true] : [false];
      assert.deepEqual(
        active.comparisons.map((c) => c.wirePrefixUnchanged),
        expected,
      );
      if (id.startsWith("payload-")) assert.equal(active.comparisons[0].earlyAppendOnly, true);
      const { previousWire: _privateWire, ...row } = active;
      rows.push({
        ...row,
        expected,
        passed: true,
        traceOrdinaryRequests: cost.calls,
        pricedSummaries: cost.compactions,
        unpricedSummaries: cost.unpricedCompactions,
        simulatedCost: cost.totalCost,
        expectedSimulatedCost: expectedCost,
        aggregateInputLearning,
      });
    } finally {
      session.dispose();
    }
  }
  assert.equal(externalAttempts, 0);
  report.completed = true;
} catch {
  report.failure = `incomplete-${active?.id ?? "setup"}`;
  if (active && !rows.some((r) => r.id === active.id)) {
    const { previousWire: _privateWire, ...row } = active;
    rows.push({ ...row, passed: false });
  }
  process.exitCode = 1;
} finally {
  server.closeAllConnections();
  await new Promise((done) => server.close(done));
  report.usage = { httpCalls, externalAttempts, requestBytes };
  report.providerSerializationExercised = rows.some((row) => row.serverRequests > 0);
  if (existsSync(out))
    writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify(report));
}
