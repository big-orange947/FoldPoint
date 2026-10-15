// Real local Pi AgentSession, metadata-only report. Network requires explicit --live.
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
import { ExperimentalCompactorLearner, parseTraceJsonl } from "../src/index.ts";
import { admitMeasuredFeedback } from "./compactor-feedback-probe.ts";
import { repeatedMessages } from "./repeated-summary-corpus.ts";
import { analyzeTraceEvents } from "./trace-analyze.ts";

const args = process.argv.slice(2);
for (let i = 0; i < args.length; i++) {
  if (["--live", "--fake-summary-cap", "--fake-summary-error"].includes(args[i])) continue;
  if (["--pi", "--out"].includes(args[i]) && args[i + 1] && !args[i + 1].startsWith("--")) {
    i++;
    continue;
  }
  throw new Error("Unknown or incomplete argument");
}
const value = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const live = args.includes("--live");
const fakeCap = args.includes("--fake-summary-cap");
const fakeError = args.includes("--fake-summary-error");
if ((live && (fakeCap || fakeError)) || (fakeCap && fakeError))
  throw new Error("Invalid failure injection");
const piRoot = resolve(value("--pi", "D:/pi"));
const outArg = value("--out", undefined);
if (!outArg) throw new Error("A fresh --out directory is required");
const out = resolve(outArg);
if (existsSync(out)) throw new Error("Refusing to overwrite an existing capture");
const key = live ? process.env.DEEPSEEK_API_KEY : undefined;
if (live && !key) throw new Error("DEEPSEEK_API_KEY is missing; nothing sent");
const maxCalls = 4;
const maxInputBytes = 200_000;
const summaryCap = 2048;
let networkAttempts = 0;
let inputBytes = 0;
let httpCalls = 0;
let stage = "pre-compaction";
const originalFetch = globalThis.fetch;
const deny = () => {
  networkAttempts++;
  throw new Error("Network forbidden");
};
if (!live) {
  globalThis.fetch = deny;
  http.request = deny;
  https.request = deny;
  syncBuiltinESMExports();
} else {
  // Cover SDK retries too. Whitelist an exact origin, not a string prefix.
  globalThis.fetch = async (...input) => {
    const target = new URL(input[0] instanceof Request ? input[0].url : String(input[0]));
    if (target.origin !== "https://api.deepseek.com") throw new Error("Unexpected endpoint");
    const body =
      input[1]?.body ?? (input[0] instanceof Request ? await input[0].clone().text() : undefined);
    if (typeof body !== "string") throw new Error("Unaccountable request body");
    if (httpCalls >= maxCalls || inputBytes + Buffer.byteLength(body) > maxInputBytes)
      throw new Error("Capture budget exhausted");
    httpCalls++;
    inputBytes += Buffer.byteLength(body);
    return originalFetch(...input);
  };
}
const load = (path) => import(pathToFileURL(join(piRoot, path)).href);
const [
  ai,
  compat,
  { createAgentSession },
  { AuthStorage },
  { SessionManager },
  { SettingsManager },
  helpers,
  utilities,
  { emitSessionShutdownEvent },
] = await Promise.all([
  load("packages/ai/dist/index.js"),
  load("packages/ai/dist/compat.js"),
  load("packages/coding-agent/src/core/sdk.ts"),
  load("packages/coding-agent/src/core/auth-storage.ts"),
  load("packages/coding-agent/src/core/session-manager.ts"),
  load("packages/coding-agent/src/core/settings-manager.ts"),
  load("packages/coding-agent/test/model-runtime-test-utils.ts"),
  load("packages/coding-agent/test/utilities.ts"),
  load("packages/coding-agent/src/core/extensions/runner.ts"),
]);
const base = compat.getModel("deepseek", "deepseek-flash");
if (!base) throw new Error("Local model config is missing");
const model = { ...base, maxTokens: summaryCap };
const ledger = [];
const streamFn = (requestedModel, context, options) => {
  if (ledger.length >= maxCalls) throw new Error("Logical budget exhausted");
  const currentStage = stage;
  const row = {
    stage: currentStage,
    outputCap: currentStage === "summary" ? summaryCap : 128,
    usage: null,
    stopReason: null,
  };
  ledger.push(row);
  const callOptions = {
    ...options,
    apiKey: key,
    maxTokens: row.outputCap,
    reasoning: undefined,
    temperature: 0,
    maxRetries: 0,
    signal: options?.signal
      ? AbortSignal.any([options.signal, AbortSignal.timeout(120_000)])
      : AbortSignal.timeout(120_000),
  };
  let events;
  if (live) {
    events = compat.streamSimple(requestedModel, context, callOptions);
  } else {
    events = ai.createAssistantMessageEventStream();
    queueMicrotask(() => {
      const summary = currentStage === "summary";
      const fixturePrompt =
        currentStage === "pre-compaction"
          ? 8000
          : summary
            ? 7500
            : currentStage === "first-post"
              ? 1500
              : 2000;
      const prompt = summary && fakeError ? 0 : fixturePrompt;
      const output = summary && fakeError ? 0 : summary ? 300 : 20;
      const stopReason = summary && fakeError ? "error" : summary && fakeCap ? "length" : "stop";
      events.push({
        type: "done",
        reason: stopReason,
        message: {
          ...ai.fauxAssistantMessage(
            summary
              ? "## Goal\nKeep owner constraints; approval pending.\n## Next Steps\nWait for verification."
              : "ACK",
          ),
          api: requestedModel.api,
          provider: requestedModel.provider,
          model: requestedModel.id,
          stopReason,
          usage: {
            input: prompt,
            output,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: prompt + output,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
        },
      });
    });
  }
  const originalResult = events.result.bind(events);
  events.result = async () => {
    const result = await originalResult();
    const u = result.usage;
    if (
      u &&
      [u.input, u.output, u.cacheRead, u.cacheWrite].every(
        (x) => Number.isSafeInteger(x) && x >= 0,
      ) &&
      (result.stopReason !== "error" || u.input + u.output + u.cacheRead + u.cacheWrite > 0)
    ) {
      // Whitelist numeric usage only. Never store content, raw responses, headers or errors.
      row.usage = {
        input: u.input,
        output: u.output,
        cacheRead: u.cacheRead,
        cacheWrite: u.cacheWrite,
      };
    }
    row.stopReason = ["stop", "length", "error", "aborted", "toolUse"].includes(result.stopReason)
      ? result.stopReason
      : "unknown";
    return result;
  };
  return events;
};
mkdirSync(out, { recursive: true });
const settingsDir = join(out, "isolated-settings");
mkdirSync(settingsDir);
const settings = SettingsManager.create(settingsDir, settingsDir);
settings.applyOverrides({
  compaction: { enabled: false, keepRecentTokens: 512, reserveTokens: 4096 },
  retry: { enabled: false, maxRetries: 0 },
  cacheWarming: "off",
});
const auth = AuthStorage.inMemory();
await auth.modify(model.provider, async () => ({
  type: "api_key",
  key: live ? key : "fake-in-memory-only",
}));
const registry = await helpers.createInMemoryModelRegistry(auth);
const manager = SessionManager.inMemory();
const runtime = helpers.getModelRuntime(registry);
// Keep SDK context/extension/request wiring intact; replace only the provider transport.
runtime.streamSimple = streamFn;
const observer = createFoldPointObserver({
  tracePath: join(out, "trace.jsonl"),
  prefixStorePath: join(out, "prefix.json"),
  mode: "observe",
  compaction: "off",
  log: () => {},
});
const boundaries = [];
const extensionResult = await utilities.createTestExtensionsResult(
  [
    (pi) => {
      pi.on("context", (_event, ctx) => {
        boundaries.push({
          event: "context",
          stage,
          contextTokens: ctx.getContextUsage()?.tokens ?? null,
        });
      });
      observer(pi);
    },
  ],
  out,
);
const { session } = await createAgentSession({
  model,
  thinkingLevel: "off",
  noTools: "all",
  agentDir: settingsDir,
  sessionManager: manager,
  settingsManager: settings,
  cwd: out,
  modelRuntime: runtime,
  resourceLoader: utilities.createTestResourceLoader({ extensionsResult: extensionResult }),
});
session.subscribe(() => {});
const report = {
  runner: "foldpoint.pi-feedback-capture.v1",
  mode: live ? "live" : "offline-fake-provider",
  piCommit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: piRoot, encoding: "utf8" }).trim(),
  sourceSha256: createHash("sha256")
    .update(readFileSync(new URL(import.meta.url)))
    .digest("hex"),
  model: { provider: model.provider, id: model.id, contextWindow: model.contextWindow },
  budget: { maxCalls, maxInputBytes, summaryOutputCap: summaryCap, ordinaryOutputCap: 128 },
  boundaries,
  ledger,
  compaction: null,
  analysis: null,
  shadow: null,
  checks: null,
  completed: false,
  failure: null,
  limitations: [
    "Manual small-context native Pi SDK capture, not adaptive timing, 1M quality or policy cost comparison.",
    "Provider input includes system/retained messages/new input; host estimates are not measured retention.",
    "One compaction is insufficient to fit the experimental affine model; no synthetic prior is injected.",
    "No task-quality score is awarded, including in live mode. SDK cache warming disabled through isolated settings.",
  ],
};
try {
  // Public history, not a private workspace or real agent account. No old usage is invented.
  for (let n = 0; n < 8; n++) {
    for (const message of repeatedMessages(n)) manager.appendMessage(message);
    manager.appendMessage({
      ...ai.fauxAssistantMessage("Acknowledged public diagnostic log."),
      api: model.api,
      provider: model.provider,
      model: model.id,
    });
  }
  session.agent.state.messages = manager.buildSessionContext().messages;
  await session.bindExtensions({});
  await session.prompt("Acknowledge the diagnostic log. Reply only ACK.");
  if (ledger.at(-1)?.stage !== stage || ledger.at(-1)?.stopReason !== "stop")
    throw new Error("pre-request-not-complete");
  stage = "summary";
  const result = await session.compact();
  report.compaction = {
    beforeTokens: result.tokensBefore,
    immediateAfterEstimate: result.estimatedTokensAfter,
    estimateSource: "pi-estimateMessagesTokens",
    postCompactionContextTokens: session.getContextUsage()?.tokens ?? null,
  };
  stage = "first-post";
  await session.prompt("Acknowledge continuation after compaction. Reply only ACK.");
  if (ledger.at(-1)?.stage !== stage || ledger.at(-1)?.stopReason !== "stop")
    throw new Error("first-post-not-complete");
  stage = "second-post";
  await session.prompt("Acknowledge the next small update. Reply only ACK.");
  if (ledger.at(-1)?.stage !== stage || ledger.at(-1)?.stopReason !== "stop")
    throw new Error("second-post-not-complete");
  await emitSessionShutdownEvent(session.extensionRunner, {
    type: "session_shutdown",
    reason: "exit",
  });
  const parsed = parseTraceJsonl(readFileSync(join(out, "trace.jsonl"), "utf8"));
  assert.equal(parsed.errors.length, 0);
  const compactions = parsed.events.filter((e) => e.type === "compaction" && e.success);
  const captured = compactions[0];
  report.analysis = analyzeTraceEvents(parsed.events);
  // No safe same-basis after-size is available: abstain, don't train on host estimates.
  const learner = new ExperimentalCompactorLearner();
  const admissions = compactions.map((event) => admitMeasuredFeedback(learner, event));
  report.shadow = {
    eligibleFeedback: admissions.filter((status) => status === "accepted").length,
    admissions,
    availability: learner.snapshotWithFallback(),
    economicForecastProduced: false,
    policyChanged: false,
  };
  report.checks = {
    fourCompletedCalls:
      ledger.length === 4 &&
      ledger.every((r) => r.usage !== null && r.stopReason === "stop") &&
      ledger.map((r) => r.stage).join(",") === "pre-compaction,summary,first-post,second-post",
    oneNativeCompaction: compactions.length === 1,
    immediatelyUnknownContext: report.compaction.postCompactionContextTokens === null,
    hostEstimateLabelled: captured?.afterTokensSource === "host-estimate",
    firstProviderPromptPreserved:
      captured?.firstPostCompactionRequest?.promptTokens ===
      (ledger[2]?.usage?.input ?? 0) +
        (ledger[2]?.usage?.cacheRead ?? 0) +
        (ledger[2]?.usage?.cacheWrite ?? 0),
    noEstimatedRetentionCalibration: report.analysis.overall.retention.count === 0,
    completeSession: report.analysis.completeSessions === 1,
    correctCallAccounting:
      report.analysis.sessionCosts[0]?.calls === 3 &&
      report.analysis.sessionCosts[0]?.compactions === 1 &&
      report.analysis.sessionCosts[0]?.unpricedCompactions === 0,
    noHiddenHttp: live ? httpCalls === ledger.length : httpCalls === 0 && networkAttempts === 0,
  };
  assert.ok(Object.values(report.checks).every(Boolean), "capture-invariant-failed");
  report.completed = true;
} catch {
  // Raw errors may contain request bodies or credentials. Persist only a bounded stage code.
  report.failure = `incomplete-${stage}`;
  process.exitCode = 1;
} finally {
  session.dispose();
  report.usage = {
    httpCalls,
    networkAttempts,
    httpRequestBytes: inputBytes,
    logicalCalls: ledger.length,
    reportedTokens: ledger.reduce(
      (sum, row) => sum + (row.usage ? Object.values(row.usage).reduce((a, b) => a + b, 0) : 0),
      0,
    ),
    unaccountedHttpAttempts: live ? httpCalls - ledger.filter((r) => r.usage !== null).length : 0,
  };
  writeFileSync(join(out, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(
    JSON.stringify({
      completed: report.completed,
      mode: report.mode,
      failure: report.failure,
      usage: report.usage,
      checks: report.checks,
    }),
  );
}
