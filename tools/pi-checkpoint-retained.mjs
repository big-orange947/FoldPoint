// Restore a synthetic archived checkpoint in memory. Original session is never modified.
import assert from "node:assert/strict";
import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { costOfUsage, resolveUnitPrices } from "../src/index.ts";
import { PiRetainedShadow } from "./pi-retained-shadow.ts";

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--live") continue;
  if (
    ["--session", "--out", "--pi"].includes(args[i]) &&
    args[i + 1] &&
    !args[i + 1].startsWith("--")
  ) {
    i++;
    continue;
  }
  throw new Error("Unknown checkpoint option");
}
const value = (n) => args[args.indexOf(n) + 1];
if (!args.includes("--session") || !args.includes("--out"))
  throw new Error("Explicit session and fresh output required");
const live = args.includes("--live"),
  out = resolve(value("--out")),
  pi = resolve(args.includes("--pi") ? value("--pi") : "D:/pi");
if (existsSync(out)) throw new Error("Refusing to overwrite checkpoint capture");
const key = live ? process.env.DEEPSEEK_API_KEY : undefined;
if (live && !key) throw new Error("DEEPSEEK_API_KEY missing; nothing sent");
const bytes = readFileSync(value("--session")),
  sha = (b) => createHash("sha256").update(b).digest("hex");
const source = bytes
  .toString("utf8")
  .trim()
  .split("\n")
  .map((line) => JSON.parse(line));
const cutoff = source.findIndex((e) => e.type === "compaction");
if (source[0]?.type !== "session" || cutoff < 2)
  throw new Error("No archived compaction checkpoint");
const historicalBefore = source[cutoff].tokensBefore;
if (
  !Number.isSafeInteger(historicalBefore) ||
  historicalBefore < 500000 ||
  historicalBefore > 650000
)
  throw new Error("Checkpoint outside target range");
const rawFetch = globalThis.fetch;
let httpCalls = 0,
  networkAttempts = 0,
  inputBytes = 0,
  spent = 0,
  reserved = 0,
  stage = "summary";
const requestScope = new AsyncLocalStorage();
const deny = () => {
  networkAttempts++;
  throw new Error("Offline checkpoint forbids network");
};
if (!live) {
  globalThis.fetch = deny;
  http.request = deny;
  https.request = deny;
  syncBuiltinESMExports();
} else
  globalThis.fetch = async (...input) => {
    const activeRow = requestScope.getStore();
    const url = new URL(input[0] instanceof Request ? input[0].url : String(input[0]));
    if (url.origin !== "https://api.deepseek.com") throw new Error("Unexpected provider");
    const body =
      input[1]?.body ?? (input[0] instanceof Request ? await input[0].clone().text() : undefined);
    if (
      typeof body !== "string" ||
      !activeRow ||
      activeRow.httpAttempts !== 0 ||
      httpCalls >= 4 ||
      inputBytes + Buffer.byteLength(body) > 12000000 ||
      spent + reserved + activeRow.quote > 0.5
    )
      throw new Error("Checkpoint budget exhausted");
    activeRow.httpAttempts++;
    httpCalls++;
    inputBytes += Buffer.byteLength(body);
    reserved += activeRow.quote;
    return rawFetch(...input);
  };
const load = (p) => import(pathToFileURL(join(pi, p)).href);
const [
  ai,
  compat,
  { createAgentSession },
  { AuthStorage },
  { SessionManager },
  { SettingsManager },
  helpers,
  utilities,
  { estimateTokens },
] = await Promise.all([
  load("packages/ai/dist/index.js"),
  load("packages/ai/dist/compat.js"),
  load("packages/coding-agent/src/core/sdk.ts"),
  load("packages/coding-agent/src/core/auth-storage.ts"),
  load("packages/coding-agent/src/core/session-manager.ts"),
  load("packages/coding-agent/src/core/settings-manager.ts"),
  load("packages/coding-agent/test/model-runtime-test-utils.ts"),
  load("packages/coding-agent/test/utilities.ts"),
  load("packages/coding-agent/src/core/compaction/index.ts"),
]);
const model = { ...compat.getModel("deepseek", "deepseek-flash"), maxTokens: 13107 };
const prices = resolveUnitPrices({
  inputPerMillion: model.cost.input,
  outputPerMillion: model.cost.output,
  cacheReadPerMillion: model.cost.cacheRead,
  cacheWritePerMillion: model.cost.cacheWrite,
});
const shadow = new PiRetainedShadow(prices),
  ledger = [];
const auth = AuthStorage.inMemory();
await auth.modify(model.provider, async () => ({
  type: "api_key",
  key: live ? key : "offline-only",
}));
const registry = await helpers.createInMemoryModelRegistry(auth),
  runtime = helpers.getModelRuntime(registry);
runtime.streamSimple = (requested, context, options) => {
  if (ledger.length >= 4) throw new Error("Logical budget exhausted");
  const label =
    stage === "summary" && ledger.some((r) => r.stage === "summary") ? "summary-part2" : stage;
  if (stage === "summary" && ledger.filter((r) => r.stage.startsWith("summary")).length >= 2)
    throw new Error("Summary request budget exhausted");
  const normalized = compat.normalizeContext(context),
    estimate = normalized.messages.reduce((n, m) => n + estimateTokens(m), 0),
    cap = stage === "summary" ? 13107 : 128;
  const row = {
    stage: label,
    promptHostEstimate: estimate,
    quote:
      estimate * Math.max(prices.inputPerToken, prices.cacheWritePerToken) +
      cap * prices.outputPerToken,
    httpAttempts: 0,
    usage: null,
    stopReason: null,
  };
  ledger.push(row);
  // Summary may require multiple provider calls; shadow pairs each by its distinct label.
  shadow.beforeRequest(label, estimate);
  let events;
  if (live)
    events = requestScope.run(row, () =>
      compat.streamSimple(requested, context, {
        ...options,
        apiKey: key,
        maxTokens: cap,
        reasoning: undefined,
        temperature: 0,
        maxRetries: 0,
        signal: AbortSignal.timeout(180000),
      }),
    );
  else {
    events = ai.createAssistantMessageEventStream();
    queueMicrotask(() =>
      events.push({
        type: "done",
        reason: "stop",
        message: {
          ...ai.fauxAssistantMessage(
            stage === "summary"
              ? "## Goal\nPreserve the public ledger checkpoint.\n## Next Steps\nContinue verification."
              : "ACK",
          ),
          api: requested.api,
          provider: requested.provider,
          model: requested.id,
          stopReason: "stop",
          usage: {
            input: stage === "summary" ? 590000 : 24000,
            output: stage === "summary" ? 400 : 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      }),
    );
  }
  const result = events.result.bind(events);
  events.result = async () => {
    const response = await result(),
      u = response.usage;
    row.stopReason = ["stop", "length", "error", "aborted"].includes(response.stopReason)
      ? response.stopReason
      : "other";
    if (
      u &&
      [u.input, u.output, u.cacheRead, u.cacheWrite].every(
        (x) => Number.isSafeInteger(x) && x >= 0,
      ) &&
      u.input + u.output + u.cacheRead + u.cacheWrite > 0
    ) {
      row.usage = {
        input: u.input,
        output: u.output,
        cacheRead: u.cacheRead,
        cacheWrite: u.cacheWrite,
      };
      const cost = costOfUsage(prices, {
        promptTokens: u.input + u.cacheRead + u.cacheWrite,
        outputTokens: u.output,
        cachedInputTokens: u.cacheRead,
        cacheWriteTokens: u.cacheWrite,
      });
      row.cost = cost;
      spent += cost;
      if (live && row.httpAttempts) reserved -= row.quote;
      shadow.afterRequest(label, row.usage);
    }
    return response;
  };
  return events;
};
mkdirSync(out, { recursive: true });
const settings = SettingsManager.create(out, out);
settings.applyOverrides({
  compaction: { enabled: false, keepRecentTokens: 20000, reserveTokens: 16384 },
  retry: { enabled: false, maxRetries: 0 },
  cacheWarming: "off",
});
const manager = SessionManager.inMemory(out, undefined, source.slice(0, cutoff));
let preparedBefore;
const extensions = await utilities.createTestExtensionsResult(
  [
    (pi) => {
      pi.on("session_before_compact", (event) => {
        preparedBefore = event.preparation.tokensBefore;
        assert.equal(preparedBefore, historicalBefore);
        shadow.beforeSummary(preparedBefore);
      });
    },
  ],
  out,
);
const { session } = await createAgentSession({
  model,
  thinkingLevel: "off",
  noTools: "all",
  agentDir: out,
  sessionManager: manager,
  settingsManager: settings,
  cwd: out,
  modelRuntime: runtime,
  resourceLoader: utilities.createTestResourceLoader({ extensionsResult: extensions }),
});
session.subscribe(() => {});
const report = {
  runner: "foldpoint.pi-checkpoint-retained.v1",
  mode: live ? "live" : "offline-fake",
  completed: false,
  failure: null,
  archiveSha256: sha(bytes),
  producerSha256: sha(readFileSync(new URL(import.meta.url))),
  helperSha256: sha(readFileSync(new URL("./pi-retained-shadow.ts", import.meta.url))),
  declaredWindowTokens: model.contextWindow,
  historicalBefore,
  preparedBefore: null,
  compaction: null,
  prices,
  budget: {
    maxHttpCalls: 4,
    maxRequestBytes: 12000000,
    estimatedUsdPrecheck: 0.5,
    summaryOutputCap: 13107,
    ordinaryOutputCap: 128,
  },
  ledger,
};
try {
  await session.bindExtensions({});
  const result = await session.compact();
  assert.equal(preparedBefore, historicalBefore);
  shadow.afterSummary(result.tokensBefore, result.estimatedTokensAfter);
  report.preparedBefore = preparedBefore;
  report.compaction = {
    beforeHostTokens: result.tokensBefore,
    immediateAfterHostEstimate: result.estimatedTokensAfter,
  };
  for (const next of ["first-post", "second-post"]) {
    stage = next;
    await session.prompt("Acknowledge continuation of the public checkpoint. Reply only ACK.");
    assert.equal(ledger.at(-1)?.stopReason, "stop");
  }
  assert(ledger.every((r) => r.usage && r.stopReason === "stop"));
  assert.equal(shadow.report().pendingRequests, 0);
  assert.equal(shadow.report().pendingSummary, false);
  assert.equal(live ? httpCalls : 0, live ? ledger.length : 0);
  report.completed = true;
} catch {
  report.failure = `incomplete-${stage}`;
  process.exitCode = 1;
} finally {
  session.dispose();
  report.shadow = shadow.report();
  report.httpCalls = httpCalls;
  report.networkAttempts = networkAttempts;
  report.httpRequestBytes = inputBytes;
  report.totalCost = spent;
  report.unknownHttpCalls = httpCalls - ledger.filter((r) => r.httpAttempts && r.usage).length;
  report.archiveUnchanged = sha(readFileSync(value("--session"))) === report.archiveSha256;
  writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      completed: report.completed,
      mode: report.mode,
      failure: report.failure,
      preparedBefore: report.preparedBefore,
      httpCalls,
      totalCost: spent,
      unknownHttpCalls: report.unknownHttpCalls,
      archiveUnchanged: report.archiveUnchanged,
    }),
  );
}
